/**
 * RunDO logic (SPEC.md §7.1, §8): expands a run into games, starts up to `concurrency` GameDOs,
 * starts the next one when a game finishes, keeps the budget (charges are idempotent per
 * wake), updates ratings when a game finishes, cancels, and purges a deleted run.
 *
 * An own-key run keeps the creator's OpenRouter key in this object's SQLite only (the `funding`
 * table; never in D1, archives or other objects): PlayerDOs read it per wake through
 * `credentials()`, and it is deleted as soon as the run finishes, is cancelled or is purged.
 */
import { RunConfig, RunFunding, type RunStatus, type RunSummary, type Seat } from "@mb/api";
import { Effect, Match, Schema } from "effect";

import {
  type ChargeResult,
  GameOutcome,
  type GameStart,
  type ModelCredentials,
  ModelListing,
  type OwnKeyFunding,
  PlannedSeat,
} from "../contracts.ts";
import type { GameRatingInput } from "../db/ratings-store.ts";
import type { NewRun } from "../db/writes.ts";
import type { UpstreamError } from "../errors.ts";
import { jsonColumn, queryFirst, queryRows, type SqlPort } from "../sql.ts";
import { charge, isExhausted, mayRun } from "./budget.ts";
import { DEFAULT_CONCURRENCY, expandRun, gameConfigOf, type PlannedGame } from "./expand.ts";

/** Retry interval for a rating update that failed. */
const RATING_RETRY_MS = 30_000;

/** Re-pump interval while a run is active, in case a notification was lost. */
export const WATCHDOG_MS = 10 * 60_000;

export interface RunDbPort {
  readonly insertRun: (run: NewRun) => Effect.Effect<void, UpstreamError>;
  readonly updateRun: (
    runId: string,
    status: RunStatus,
    spentUsd: number,
    finishedAt: string | null,
  ) => Effect.Effect<void, UpstreamError>;
  readonly abortQueued: (
    gameIds: ReadonlyArray<string>,
    at: string,
  ) => Effect.Effect<void, UpstreamError>;
  readonly applyRatings: (input: GameRatingInput) => Effect.Effect<void, UpstreamError>;
}

export interface GamesLinkPort {
  readonly start: (start: GameStart) => Effect.Effect<void, UpstreamError>;
  readonly abort: (gameId: string, reason: string) => Effect.Effect<void, UpstreamError>;
  /** Wipe a started game's GameDO and the PlayerDOs of its LLM seats; they stop for good. */
  readonly purge: (
    gameId: string,
    llmSeats: ReadonlyArray<Seat>,
  ) => Effect.Effect<void, UpstreamError>;
}

export interface RunPorts {
  readonly sql: SqlPort;
  readonly db: RunDbPort;
  readonly games: GamesLinkPort;
  readonly setAlarm: (at: number | null) => Effect.Effect<void>;
  readonly now: () => number;
}

/** The run was created but its row is missing: the object's storage is broken. */
export class RunNotStored extends Schema.TaggedError<RunNotStored>()("RunNotStored", {
  runId: Schema.String,
}) {}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS run (
  id INTEGER PRIMARY KEY CHECK (id = 1), run_id TEXT NOT NULL, created_at TEXT NOT NULL,
  status TEXT NOT NULL, config_json TEXT NOT NULL, listings_json TEXT NOT NULL,
  spent_usd REAL NOT NULL, finished_at TEXT
);
CREATE TABLE IF NOT EXISTS games (
  game_id TEXT PRIMARY KEY, game_index INTEGER NOT NULL, status TEXT NOT NULL,
  has_llm INTEGER NOT NULL, plan_json TEXT NOT NULL, outcome_json TEXT, rated INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS charges (key TEXT PRIMARY KEY, game_id TEXT NOT NULL, cost_usd REAL NOT NULL);
CREATE TABLE IF NOT EXISTS funding (
  id INTEGER PRIMARY KEY CHECK (id = 1), funding TEXT NOT NULL,
  cancel_token_sha256 TEXT, openrouter_key TEXT
);
`;

const PlannedGameSchema = Schema.Struct({
  gameId: Schema.String,
  gameIndex: Schema.Int,
  seedIndex: Schema.Int,
  rotation: Schema.Int,
  seed: Schema.String,
  seats: Schema.Array(PlannedSeat),
  hasLlm: Schema.Boolean,
});

const RunRow = Schema.Struct({
  run_id: Schema.String,
  created_at: Schema.String,
  status: Schema.Literals(["queued", "running", "finished", "cancelled", "failed"]),
  config_json: Schema.String,
  listings_json: Schema.String,
  spent_usd: Schema.Number,
  finished_at: Schema.NullOr(Schema.String),
});

type RunRow = typeof RunRow.Type;

const GameRow = Schema.Struct({
  game_id: Schema.String,
  status: Schema.Literals(["queued", "running", "done", "skipped"]),
  has_llm: Schema.Int,
  plan_json: Schema.String,
});

const OutcomeRow = Schema.Struct({ outcome_json: Schema.String });

const FundingRow = Schema.Struct({
  funding: RunFunding,
  cancel_token_sha256: Schema.NullOr(Schema.String),
  openrouter_key: Schema.NullOr(Schema.String),
});

const PlanRow = Schema.Struct({ plan_json: Schema.String });

const CountRow = Schema.Struct({ n: Schema.Int });

const decodeConfig = jsonColumn(RunConfig);

const encodeConfig = Schema.encodeSync(Schema.fromJsonString(RunConfig));

const decodeListings = jsonColumn(Schema.Array(ModelListing));

const encodeListings = Schema.encodeSync(Schema.fromJsonString(Schema.Array(ModelListing)));

const decodePlan = jsonColumn(PlannedGameSchema);

const encodePlan = Schema.encodeSync(Schema.fromJsonString(PlannedGameSchema));

const decodeOutcome = jsonColumn(GameOutcome);

const encodeOutcome = Schema.encodeSync(Schema.fromJsonString(GameOutcome));

export class RunCoordinator {
  constructor(private readonly ports: RunPorts) {
    ports.sql.exec(SCHEMA);
  }

  /**
   * API → RunDO. `ownKey` is null for a server-funded run. Idempotent: creating an existing run
   * returns its summary.
   */
  create(
    runId: string,
    config: RunConfig,
    listings: ReadonlyArray<ModelListing>,
    ownKey: OwnKeyFunding | null,
  ): Effect.Effect<RunSummary, UpstreamError | RunNotStored> {
    return Effect.gen({ self: this }, function* () {
      if (this.run() === undefined) {
        const createdAt = this.iso();
        const games = expandRun(runId, config);
        const funding: RunFunding = ownKey === null ? "server" : "ownKey";

        yield* this.ports.db.insertRun({ id: runId, createdAt, funding, config, games });
        this.ports.sql.transaction(() => {
          this.ports.sql.exec(
            "INSERT INTO funding (id, funding, cancel_token_sha256, openrouter_key) VALUES (1, ?, ?, ?)",
            funding,
            ownKey?.cancelTokenSha256 ?? null,
            ownKey?.openRouterKey ?? null,
          );
          this.ports.sql.exec(
            "INSERT INTO run (id, run_id, created_at, status, config_json, listings_json, spent_usd) VALUES (1, ?, ?, 'running', ?, ?, 0)",
            runId,
            createdAt,
            encodeConfig(config),
            encodeListings(listings),
          );

          for (const game of games) {
            this.ports.sql.exec(
              "INSERT INTO games (game_id, game_index, status, has_llm, plan_json) VALUES (?, ?, 'queued', ?, ?)",
              game.gameId,
              game.gameIndex,
              game.hasLlm ? 1 : 0,
              encodePlan(game),
            );
          }
        });
        yield* this.pump();
      }

      const summary = this.summary();

      if (summary === null) return yield* new RunNotStored({ runId });

      return summary;
    });
  }

  /** GameDO → RunDO when a game ends. Idempotent per game. */
  gameFinished(outcome: GameOutcome): Effect.Effect<void, UpstreamError> {
    return Effect.gen({ self: this }, function* () {
      const changed = this.ports.sql.exec(
        "UPDATE games SET status = 'done', outcome_json = ? WHERE game_id = ? AND status <> 'done' RETURNING game_id",
        encodeOutcome(outcome),
        outcome.gameId,
      );

      if (changed.length === 0) return;

      yield* this.rate(outcome);
      yield* this.pump();
    });
  }

  /** GameDO → RunDO after every LLM wake. Idempotent per `key`. */
  charge(gameId: string, key: string, costUsd: number): Effect.Effect<ChargeResult, UpstreamError> {
    return Effect.gen({ self: this }, function* () {
      const run = this.run();

      if (run === undefined) return { exhausted: true };

      const config = decodeConfig(run.config_json);

      const seen = queryFirst(
        this.ports.sql,
        CountRow,
        "SELECT COUNT(*) AS n FROM charges WHERE key = ?",
        key,
      );

      const outcome = charge(
        { budgetUsd: config.budgetUsd, spentUsd: run.spent_usd },
        (seen?.n ?? 0) > 0,
        costUsd,
      );

      if (outcome.applied) {
        this.ports.sql.transaction(() => {
          this.ports.sql.exec(
            "INSERT INTO charges (key, game_id, cost_usd) VALUES (?, ?, ?)",
            key,
            gameId,
            costUsd,
          );
          this.ports.sql.exec("UPDATE run SET spent_usd = ? WHERE id = 1", outcome.budget.spentUsd);
        });
        yield* this.syncD1();
      }

      if (outcome.crossed) {
        // SPEC §8: no new wakes once the budget is reached, and games that need them abort.
        const running = this.games("running").filter(
          (game) => game.has_llm === 1 && game.game_id !== gameId,
        );

        for (const game of running) {
          yield* this.ports.games
            .abort(game.game_id, "budget exhausted")
            .pipe(Effect.catch((cause) => Effect.logError(`abort ${game.game_id} failed`, cause)));
        }

        yield* this.pump();
      }

      return { exhausted: isExhausted(outcome.budget) };
    });
  }

  /**
   * PlayerDO → RunDO before every wake: who pays for it (SPEC §7.2). Null unless the run is
   * active: a wake of an ended, cancelled, deleted or unknown run gets no key at all, so it can
   * never fall back to the server's key.
   */
  credentials(): ModelCredentials | null {
    const status = this.run()?.status;

    if (status !== "running" && status !== "queued") return null;

    const funding = this.funding();

    return {
      funding: funding?.funding ?? "server",
      openRouterKey: funding?.funding === "ownKey" ? funding.openrouter_key : null,
    };
  }

  /** API → RunDO: whether `tokenSha256` is this own-key run's cancel token. */
  cancelTokenMatches(tokenSha256: string): boolean {
    const stored = this.funding()?.cancel_token_sha256 ?? null;

    return stored !== null && stored === tokenSha256;
  }

  /** API → RunDO. Stops queued games and aborts running ones. */
  cancel(): Effect.Effect<RunSummary | null, UpstreamError> {
    return Effect.gen({ self: this }, function* () {
      const run = this.run();

      if (run === undefined) return null;

      if (run.status === "running" || run.status === "queued") {
        const queued = this.games("queued").map((game) => game.game_id);
        const running = this.games("running").map((game) => game.game_id);

        this.ports.sql.transaction(() => {
          this.close("cancelled");
          this.ports.sql.exec("UPDATE games SET status = 'skipped' WHERE status = 'queued'");
        });
        yield* this.ports.db.abortQueued(queued, this.iso());

        for (const gameId of running) {
          yield* this.ports.games
            .abort(gameId, "run cancelled")
            .pipe(Effect.catch((cause) => Effect.logError(`abort ${gameId} failed`, cause)));
        }

        yield* this.syncD1();
      }

      return this.summary();
    });
  }

  /**
   * API → RunDO when the run is deleted: closes the run, wipes the GameDO and PlayerDOs of every
   * started game, then this object's own storage. Idempotent; a failure leaves this object's
   * storage in place, so retrying the deletion purges what is left.
   */
  purge(): Effect.Effect<void, UpstreamError> {
    return Effect.gen({ self: this }, function* () {
      if (this.run() === undefined) return;

      this.ports.sql.transaction(() => {
        this.close("cancelled");
        this.ports.sql.exec("UPDATE games SET status = 'skipped' WHERE status = 'queued'");
      });

      const started = queryRows(
        this.ports.sql,
        PlanRow,
        "SELECT plan_json FROM games WHERE status IN ('running', 'done') ORDER BY game_index",
      ).map((row) => decodePlan(row.plan_json));

      for (const game of started) {
        const llmSeats = game.seats.flatMap((seat) => (seat.kind === "llm" ? [seat.seat] : []));

        yield* this.ports.games.purge(game.gameId, llmSeats);
      }

      this.ports.sql.transaction(() => {
        for (const table of ["run", "games", "charges", "funding"]) {
          this.ports.sql.exec(`DELETE FROM ${table}`);
        }
      });
      yield* this.ports.setAlarm(null);
    });
  }

  alarm(): Effect.Effect<void, UpstreamError> {
    return Effect.gen({ self: this }, function* () {
      for (const row of this.unratedOutcomes()) yield* this.rate(decodeOutcome(row.outcome_json));

      yield* this.pump();
    });
  }

  summary(): RunSummary | null {
    const run = this.run();

    if (run === undefined) return null;

    const config = decodeConfig(run.config_json);

    const count = (where: string): number =>
      queryFirst(this.ports.sql, CountRow, `SELECT COUNT(*) AS n FROM games WHERE ${where}`)?.n ??
      0;

    return {
      id: run.run_id,
      funding: this.funding()?.funding ?? "server",
      name: config.name ?? null,
      createdAt: run.created_at,
      status: run.status,
      playersCount: config.players.length,
      seats: config.players,
      gamesTotal: count("1 = 1"),
      gamesFinished: count("status IN ('done', 'skipped')"),
      gamesRunning: count("status = 'running'"),
      spentUsd: run.spent_usd,
      budgetUsd: config.budgetUsd,
    };
  }

  // ── internals ──────────────────────────────────────────────────────────────────────────

  /** Start queued games up to the concurrency limit; finish the run when nothing is left. */
  private pump(): Effect.Effect<void, UpstreamError> {
    return Effect.gen({ self: this }, function* () {
      const run = this.run();

      if (run === undefined || run.status !== "running") {
        yield* this.settleAlarm();

        return;
      }

      const config = decodeConfig(run.config_json);
      const budget = { budgetUsd: config.budgetUsd, spentUsd: run.spent_usd };
      const concurrency = config.concurrency ?? DEFAULT_CONCURRENCY;
      const starts: Array<PlannedGame> = [];
      const skipped: Array<string> = [];
      let running = this.games("running").length;

      for (const game of this.games("queued")) {
        if (running >= concurrency) break;

        if (!mayRun(budget, game.has_llm === 1)) {
          skipped.push(game.game_id);
          this.ports.sql.exec(
            "UPDATE games SET status = 'skipped' WHERE game_id = ?",
            game.game_id,
          );
          continue;
        }

        this.ports.sql.exec("UPDATE games SET status = 'running' WHERE game_id = ?", game.game_id);
        starts.push(decodePlan(game.plan_json));
        running += 1;
      }

      if (skipped.length > 0) yield* this.ports.db.abortQueued(skipped, this.iso());

      const listings = decodeListings(run.listings_json);

      for (const game of starts) {
        yield* this.ports.games.start(this.gameStart(run, config, listings, game)).pipe(
          Effect.catch((cause) =>
            // Put it back in the queue; the watchdog alarm retries.
            Effect.logError(`starting ${game.gameId} failed`, cause).pipe(
              Effect.andThen(
                Effect.sync(() =>
                  this.ports.sql.exec(
                    "UPDATE games SET status = 'queued' WHERE game_id = ?",
                    game.gameId,
                  ),
                ),
              ),
            ),
          ),
        );
      }

      const open = this.games("queued").length + this.games("running").length;

      if (open === 0) {
        this.ports.sql.transaction(() => this.close("finished"));
        yield* this.syncD1();
        yield* this.settleAlarm();

        return;
      }

      yield* this.ports.setAlarm(this.ports.now() + WATCHDOG_MS);
    });
  }

  private gameStart(
    run: RunRow,
    config: RunConfig,
    listings: ReadonlyArray<ModelListing>,
    game: PlannedGame,
  ): GameStart {
    const models = new Set(
      game.seats.flatMap((seat) =>
        Match.valueTags(seat.spec, { llm: (llm) => [llm.model], bot: () => [] }),
      ),
    );

    return {
      gameId: game.gameId,
      runId: run.run_id,
      gameIndex: game.gameIndex,
      config: gameConfigOf(game, config),
      seats: game.seats,
      listings: listings.filter((listing) => models.has(listing.id)),
      budgetExhausted: false,
    };
  }

  /** A closed run keeps an alarm only while finished games still wait for their rating. */
  private settleAlarm(): Effect.Effect<void> {
    return Effect.suspend(() => {
      const unrated = this.unratedOutcomes().length > 0;

      return this.ports.setAlarm(unrated ? this.ports.now() + RATING_RETRY_MS : null);
    });
  }

  private rate(outcome: GameOutcome): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      if (outcome.status === "finished") {
        const rated = yield* this.ports.db
          .applyRatings({
            gameId: outcome.gameId,
            playersCount: outcome.playersCount,
            at: outcome.finishedAt,
            results: outcome.results,
          })
          .pipe(
            Effect.as(true),
            Effect.catch((cause) =>
              Effect.logError(`rating ${outcome.gameId} failed; the alarm retries`, cause).pipe(
                Effect.andThen(this.ports.setAlarm(this.ports.now() + RATING_RETRY_MS)),
                Effect.as(false),
              ),
            ),
          );

        if (!rated) return;
      }

      this.ports.sql.exec("UPDATE games SET rated = 1 WHERE game_id = ?", outcome.gameId);
    });
  }

  private syncD1(): Effect.Effect<void> {
    return Effect.suspend(() => {
      const run = this.run();

      if (run === undefined) return Effect.void;

      return this.ports.db
        .updateRun(run.run_id, run.status, run.spent_usd, run.finished_at)
        .pipe(
          Effect.catch((cause) => Effect.logError(`D1 updateRun failed for ${run.run_id}`, cause)),
        );
    });
  }

  /**
   * Ends the run (call inside a transaction): its status, and the deletion of an own key, which
   * must not outlive the run (SPEC §7.2).
   */
  private close(status: "finished" | "cancelled"): void {
    this.ports.sql.exec(
      "UPDATE run SET status = ?, finished_at = ? WHERE id = 1",
      status,
      this.iso(),
    );
    this.ports.sql.exec("UPDATE funding SET openrouter_key = NULL");
  }

  private funding() {
    return queryFirst(
      this.ports.sql,
      FundingRow,
      "SELECT funding, cancel_token_sha256, openrouter_key FROM funding WHERE id = 1",
    );
  }

  private run(): RunRow | undefined {
    return queryFirst(
      this.ports.sql,
      RunRow,
      "SELECT run_id, created_at, status, config_json, listings_json, spent_usd, finished_at FROM run WHERE id = 1",
    );
  }

  private unratedOutcomes() {
    return queryRows(
      this.ports.sql,
      OutcomeRow,
      "SELECT outcome_json FROM games WHERE status = 'done' AND rated = 0 AND outcome_json IS NOT NULL",
    );
  }

  private games(status: "queued" | "running") {
    return queryRows(
      this.ports.sql,
      GameRow,
      "SELECT game_id, status, has_llm, plan_json FROM games WHERE status = ? ORDER BY game_index",
      status,
    );
  }

  private iso(): string {
    return new Date(this.ports.now()).toISOString();
  }
}
