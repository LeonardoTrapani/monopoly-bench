/**
 * RunDO logic (SPEC.md §7.1, §8): expands a run into games, starts up to `concurrency` GameDOs,
 * starts the next one when a game finishes, keeps the budget (charges are idempotent per
 * wake), updates ratings when a game finishes, and cancels.
 */
import { RunConfig, type RunStatus, type RunSummary } from "@mb/api";
import { Match, Schema } from "effect";

import {
  type ChargeResult,
  GameOutcome,
  type GameStart,
  ModelListing,
  PlannedSeat,
} from "../contracts.ts";
import type { GameRatingInput } from "../db/ratings-store.ts";
import type { NewRun } from "../db/writes.ts";
import { jsonColumn, queryFirst, queryRows, type SqlPort } from "../sql.ts";
import { charge, isExhausted, mayRun } from "./budget.ts";
import { DEFAULT_CONCURRENCY, expandRun, gameConfigOf, type PlannedGame } from "./expand.ts";

/** Retry interval for a rating update that failed. */
const RATING_RETRY_MS = 30_000;

/** Re-pump interval while a run is active, in case a notification was lost. */
export const WATCHDOG_MS = 10 * 60_000;

export interface RunDbPort {
  readonly insertRun: (run: NewRun) => Promise<void>;
  readonly updateRun: (
    runId: string,
    status: RunStatus,
    spentUsd: number,
    finishedAt: string | null,
  ) => Promise<void>;
  readonly abortQueued: (gameIds: ReadonlyArray<string>, at: string) => Promise<void>;
  readonly applyRatings: (input: GameRatingInput) => Promise<void>;
}

export interface GamesLinkPort {
  readonly start: (start: GameStart) => Promise<void>;
  readonly abort: (gameId: string, reason: string) => Promise<void>;
}

export interface RunPorts {
  readonly sql: SqlPort;
  readonly db: RunDbPort;
  readonly games: GamesLinkPort;
  readonly setAlarm: (at: number | null) => Promise<void>;
  readonly now: () => number;
  readonly log: (message: string, cause?: unknown) => void;
}

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

  /** API → RunDO. Idempotent: creating an existing run returns its summary. */
  async create(
    runId: string,
    config: RunConfig,
    listings: ReadonlyArray<ModelListing>,
  ): Promise<RunSummary> {
    if (this.run() === undefined) {
      const createdAt = this.iso();
      const games = expandRun(runId, config);

      await this.ports.db.insertRun({ id: runId, createdAt, config, games });
      this.ports.sql.transaction(() => {
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
      await this.pump();
    }

    const summary = this.summary();

    if (summary === null) throw new Error(`Run ${runId} was not stored`);

    return summary;
  }

  /** GameDO → RunDO when a game ends. Idempotent per game. */
  async gameFinished(outcome: GameOutcome): Promise<void> {
    const changed = this.ports.sql.exec(
      "UPDATE games SET status = 'done', outcome_json = ? WHERE game_id = ? AND status <> 'done' RETURNING game_id",
      encodeOutcome(outcome),
      outcome.gameId,
    );

    if (changed.length === 0) return;

    await this.rate(outcome);
    await this.pump();
  }

  /** GameDO → RunDO after every LLM wake. Idempotent per `key`. */
  async charge(gameId: string, key: string, costUsd: number): Promise<ChargeResult> {
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
      await this.syncD1();
    }

    if (outcome.crossed) {
      // SPEC §8: no new wakes once the budget is reached, and games that need them abort.
      const running = this.games("running").filter(
        (game) => game.has_llm === 1 && game.game_id !== gameId,
      );

      for (const game of running) {
        await this.ports.games
          .abort(game.game_id, "budget exhausted")
          .catch((cause: unknown) => this.ports.log(`abort ${game.game_id} failed`, cause));
      }

      await this.pump();
    }

    return { exhausted: isExhausted(outcome.budget) };
  }

  /** API → RunDO. Stops queued games and aborts running ones. */
  async cancel(): Promise<RunSummary | null> {
    const run = this.run();

    if (run === undefined) return null;

    if (run.status === "running" || run.status === "queued") {
      const queued = this.games("queued").map((game) => game.game_id);
      const running = this.games("running").map((game) => game.game_id);

      this.ports.sql.transaction(() => {
        this.ports.sql.exec(
          "UPDATE run SET status = 'cancelled', finished_at = ? WHERE id = 1",
          this.iso(),
        );
        this.ports.sql.exec("UPDATE games SET status = 'skipped' WHERE status = 'queued'");
      });
      await this.ports.db.abortQueued(queued, this.iso());

      for (const gameId of running) {
        await this.ports.games
          .abort(gameId, "run cancelled")
          .catch((cause: unknown) => this.ports.log(`abort ${gameId} failed`, cause));
      }

      await this.syncD1();
    }

    return this.summary();
  }

  async alarm(): Promise<void> {
    for (const row of this.unratedOutcomes()) await this.rate(decodeOutcome(row.outcome_json));

    await this.pump();
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
  private async pump(): Promise<void> {
    const run = this.run();

    if (run === undefined || run.status !== "running") {
      await this.settleAlarm();

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
        this.ports.sql.exec("UPDATE games SET status = 'skipped' WHERE game_id = ?", game.game_id);
        continue;
      }

      this.ports.sql.exec("UPDATE games SET status = 'running' WHERE game_id = ?", game.game_id);
      starts.push(decodePlan(game.plan_json));
      running += 1;
    }

    if (skipped.length > 0) await this.ports.db.abortQueued(skipped, this.iso());

    const listings = decodeListings(run.listings_json);

    for (const game of starts) {
      try {
        await this.ports.games.start(this.gameStart(run, config, listings, game));
      } catch (cause) {
        // Put it back in the queue; the watchdog alarm retries.
        this.ports.log(`starting ${game.gameId} failed`, cause);
        this.ports.sql.exec("UPDATE games SET status = 'queued' WHERE game_id = ?", game.gameId);
      }
    }

    const open = this.games("queued").length + this.games("running").length;

    if (open === 0) {
      this.ports.sql.exec(
        "UPDATE run SET status = 'finished', finished_at = ? WHERE id = 1",
        this.iso(),
      );
      await this.syncD1();
      await this.settleAlarm();

      return;
    }

    await this.ports.setAlarm(this.ports.now() + WATCHDOG_MS);
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
  private async settleAlarm(): Promise<void> {
    const unrated = this.unratedOutcomes().length > 0;

    await this.ports.setAlarm(unrated ? this.ports.now() + RATING_RETRY_MS : null);
  }

  private async rate(outcome: GameOutcome): Promise<void> {
    if (outcome.status === "finished") {
      try {
        await this.ports.db.applyRatings({
          gameId: outcome.gameId,
          playersCount: outcome.playersCount,
          at: outcome.finishedAt,
          results: outcome.results,
        });
      } catch (cause) {
        this.ports.log(`rating ${outcome.gameId} failed; the alarm retries`, cause);
        await this.ports.setAlarm(this.ports.now() + RATING_RETRY_MS);

        return;
      }
    }

    this.ports.sql.exec("UPDATE games SET rated = 1 WHERE game_id = ?", outcome.gameId);
  }

  private async syncD1(): Promise<void> {
    const run = this.run();

    if (run === undefined) return;

    try {
      await this.ports.db.updateRun(run.run_id, run.status, run.spent_usd, run.finished_at);
    } catch (cause) {
      this.ports.log(`D1 updateRun failed for ${run.run_id}`, cause);
    }
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
