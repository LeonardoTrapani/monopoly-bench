import { D1Client } from "@effect/sql-d1";
import { Effect, Result, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { describe, expect, it } from "vite-plus/test";

import type { SeatResult } from "../contracts.ts";
import { memoryD1 } from "../testing/sqlite.ts";
import { applyGameRatings, type GameRatingInput, recomputeRatings } from "./ratings-store.ts";
import { decodeRows } from "./sql.ts";

const RatingRow = Schema.Struct({
  competitor_id: Schema.String,
  games: Schema.Int,
  wins: Schema.Int,
  mu: Schema.Number,
  sigma: Schema.Number,
  score: Schema.Number,
  updated_at: Schema.String,
});

const HistoryRow = Schema.Struct({
  competitor_id: Schema.String,
  game_id: Schema.String,
  at: Schema.String,
  mu: Schema.Number,
  sigma: Schema.Number,
});

const seat = (
  letter: SeatResult["seat"],
  competitorId: string,
  rank: number | null,
  kind: SeatResult["kind"] = "llm",
): SeatResult => ({ seat: letter, competitorId, label: competitorId, kind, rank });

const game = (gameId: string, at: string, results: ReadonlyArray<SeatResult>): GameRatingInput => ({
  gameId,
  playersCount: 3,
  at,
  results,
});

const duel = (gameId: string, winner: string, loser: string): GameRatingInput => ({
  gameId,
  playersCount: 2,
  at: `2026-10-28T10:00:0${gameId.length % 10}.000Z`,
  results: [seat("A", winner, 1), seat("B", loser, 2)],
});

const g1 = game("g1", "2026-10-28T10:00:01.000Z", [
  seat("A", "x", 1),
  seat("B", "y", 2),
  seat("C", "z", 3),
]);

const g2 = game("g2", "2026-10-28T10:00:02.000Z", [
  seat("A", "y", 1),
  seat("B", "z", 2),
  seat("C", "x", 3),
]);

/** A tie for first place. */
const g3 = game("g3", "2026-10-28T10:00:03.000Z", [
  seat("A", "z", 1),
  seat("B", "x", 1),
  seat("C", "y", 3),
]);

/** One competitor holding two seats. */
const g4 = game("g4", "2026-10-28T10:00:04.000Z", [
  seat("A", "x", 1),
  seat("B", "x", 2),
  seat("C", "y", 3),
]);

/** Three-player games, in `at` order. */
const games: ReadonlyArray<GameRatingInput> = [g1, g2, g3, g4];

const setup = () => {
  const d1 = memoryD1();

  const run = <A, E>(effect: Effect.Effect<A, E, D1Client.D1Client | SqlClient.SqlClient>) =>
    Effect.runPromise(effect.pipe(Effect.provide(d1.layer)));

  d1.db
    .exec(`INSERT INTO runs (id, created_at, status, players_count, config_json, seats_json, games_total, budget_usd)
    VALUES ('r', '2026-10-28T09:00:00.000Z', 'finished', 3, '{}', '[]', 4, 0)`);

  /** D1 rows of finished games, as `finishGame` leaves them, for the replay to read. */
  const storeGames = (inputs: ReadonlyArray<GameRatingInput>) => {
    for (const input of inputs) {
      d1.db
        .prepare(
          "INSERT INTO games (id, run_id, game_index, seed_index, rotation, seed, status, players_count, finished_at, updated_at) VALUES (?, 'r', 0, 0, 0, '1', 'finished', ?, ?, ?)",
        )
        .run(input.gameId, input.playersCount, input.at, input.at);

      for (const result of input.results) {
        d1.db
          .prepare(
            "INSERT INTO seats (game_id, seat, competitor_id, label, kind, spec_json, final_rank) VALUES (?, ?, ?, ?, ?, '{}', ?)",
          )
          .run(
            input.gameId,
            result.seat,
            result.competitorId,
            result.label,
            result.kind,
            result.rank,
          );
      }
    }
  };

  const table = (playersCount: number) =>
    run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        const ratings = yield* decodeRows(RatingRow)(
          sql`SELECT competitor_id, games, wins, mu, sigma, score, updated_at FROM ratings
            WHERE players_count = ${playersCount} ORDER BY competitor_id`,
        );

        const history = yield* decodeRows(HistoryRow)(
          sql`SELECT competitor_id, game_id, at, mu, sigma FROM rating_history
            WHERE players_count = ${playersCount} ORDER BY at, competitor_id`,
        );

        return { ratings, history };
      }),
    );

  return { d1, run, storeGames, table };
};

describe("rating store", () => {
  it("rates a game once and accumulates games and wins", async () => {
    const h = setup();

    h.storeGames([duel("g1", "llm-x", "llm-y"), duel("g2", "llm-x", "llm-y")]);

    expect(await h.run(applyGameRatings(duel("g1", "llm-x", "llm-y")))).toBe("rated");
    expect(await h.run(applyGameRatings(duel("g1", "llm-x", "llm-y")))).toBe("alreadyRated");
    expect(await h.run(applyGameRatings(duel("g2", "llm-x", "llm-y")))).toBe("rated");

    const { ratings } = await h.table(2);

    expect(ratings.map((row) => [row.competitor_id, row.games, row.wins])).toEqual([
      ["llm-x", 2, 2],
      ["llm-y", 2, 0],
    ]);
  });

  it("skips games without at least two ranked seats", async () => {
    const h = setup();
    const input = duel("g1", "a", "b");

    expect(
      await h.run(
        applyGameRatings({
          ...input,
          results: input.results.map((result) => ({ ...result, rank: null })),
        }),
      ),
    ).toBe("unrated");
  });

  it("never rates a game with a bot seat (public ratings are LLM-only)", async () => {
    const h = setup();
    const input = duel("g1", "llm-x", "bot:random");

    expect(
      await h.run(
        applyGameRatings({
          ...input,
          results: [seat("A", "llm-x", 1), seat("B", "bot:random", 2, "bot")],
        }),
      ),
    ).toBe("unrated");
    expect((await h.table(2)).ratings).toEqual([]);
  });

  it("rolls back the whole batch when the table version moved (optimistic guard)", async () => {
    const d1 = memoryD1();

    const attempt = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const client = yield* D1Client.D1Client;

      yield* sql`INSERT INTO rating_tables (players_count, version) VALUES (2, 5)`;

      return yield* client
        .batch([
          sql`UPDATE rating_tables SET version = version + 1 WHERE players_count = 2 AND version = ${4}`,
          sql`INSERT INTO rating_guard (ok) VALUES (changes())`,
          sql`INSERT INTO ratings (competitor_id, players_count, label, kind, mu, sigma, score, games, wins, updated_at)
            VALUES ('x', 2, 'x', 'llm', 30, 5, 15, 1, 1, 'now')`,
        ])
        .pipe(Effect.result);
    });

    const outcome = await Effect.runPromise(attempt.pipe(Effect.provide(d1.layer)));
    const ratings = d1.db.prepare("SELECT COUNT(*) AS n FROM ratings").get();

    const version = d1.db
      .prepare("SELECT version FROM rating_tables WHERE players_count = 2")
      .get();

    expect(Result.isFailure(outcome)).toBe(true);
    expect(ratings).toEqual({ n: 0 });
    expect(version).toEqual({ version: 5 });
  });
});

describe("rating of a deleted game", () => {
  it("rates nothing when the game's run was deleted before the update ran (F2)", async () => {
    const h = setup();
    const input = duel("g1", "llm-x", "llm-y");

    h.storeGames([input]);
    h.d1.db.exec("DELETE FROM seats WHERE game_id = 'g1'; DELETE FROM games WHERE id = 'g1';");

    expect(await h.run(applyGameRatings(input))).toBe("unrated");
    expect(await h.table(2)).toEqual({ ratings: [], history: [] });
  });
});

describe("rating replay", () => {
  it("rebuilds exactly what the games produced one by one", async () => {
    const incremental = setup();

    incremental.storeGames(games);

    for (const input of games) await incremental.run(applyGameRatings(input));

    const replayed = setup();

    replayed.storeGames(games);

    expect(await replayed.run(recomputeRatings(3))).toBe(3);
    expect(await replayed.table(3)).toEqual(await incremental.table(3));
  });

  it("rates the remaining games as if a deleted game never happened", async () => {
    const kept = games.filter((input) => input.gameId !== "g2");
    const reference = setup();

    reference.storeGames(kept);

    for (const input of kept) await reference.run(applyGameRatings(input));

    const h = setup();

    h.storeGames(games);

    for (const input of games) await h.run(applyGameRatings(input));

    h.d1.db.exec("DELETE FROM seats WHERE game_id = 'g2'; DELETE FROM games WHERE id = 'g2';");
    await h.run(recomputeRatings(3));

    const after = await h.table(3);

    expect(after).toEqual(await reference.table(3));
    expect(after.history.map((row) => row.game_id)).not.toContain("g2");
    // Other player counts are untouched.
    expect((await h.table(2)).ratings).toEqual([]);
  });

  it("replays in finish order, skips unfinished and bot games, and empties a table with no games left", async () => {
    const h = setup();

    h.storeGames([
      g2,
      g1,
      game("bots", "2026-10-28T10:00:05.000Z", [
        seat("A", "x", 1),
        seat("B", "bot:heuristic", 2, "bot"),
        seat("C", "y", 3),
      ]),
    ]);
    h.d1.db.exec(
      "UPDATE games SET status = 'aborted' WHERE id = 'g2'; INSERT INTO ratings (competitor_id, players_count, label, kind, mu, sigma, score, games, wins, updated_at) VALUES ('stale', 3, 'stale', 'llm', 1, 1, 1, 1, 1, 'x');",
    );

    await h.run(recomputeRatings(3));

    const { ratings, history } = await h.table(3);

    expect(ratings.map((row) => [row.competitor_id, row.games, row.wins])).toEqual([
      ["x", 1, 1],
      ["y", 1, 0],
      ["z", 1, 0],
    ]);
    expect(new Set(history.map((row) => row.game_id))).toEqual(new Set(["g1"]));

    h.d1.db.exec("DELETE FROM seats; DELETE FROM games;");
    await h.run(recomputeRatings(3));

    expect(await h.table(3)).toEqual({ ratings: [], history: [] });
  });
});
