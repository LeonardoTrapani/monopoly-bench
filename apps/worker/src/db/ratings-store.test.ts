import { D1Client } from "@effect/sql-d1";
import { Effect, Result, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { describe, expect, it } from "vite-plus/test";

import { memoryD1 } from "../testing/sqlite.ts";
import { applyGameRatings, type GameRatingInput } from "./ratings-store.ts";
import { decodeRows } from "./sql.ts";

const RatingRow = Schema.Struct({
  competitor_id: Schema.String,
  games: Schema.Int,
  wins: Schema.Int,
  score: Schema.Number,
});

const game = (gameId: string, winner: string, loser: string): GameRatingInput => ({
  gameId,
  playersCount: 2,
  at: `2026-10-28T10:00:0${gameId.length % 10}.000Z`,
  results: [
    { seat: "A", competitorId: winner, label: winner, kind: "llm", rank: 1 },
    { seat: "B", competitorId: loser, label: loser, kind: "bot", rank: 2 },
  ],
});

describe("rating store", () => {
  it("rates a game once and accumulates games and wins", async () => {
    const d1 = memoryD1();

    const run = <A, E>(effect: Effect.Effect<A, E, D1Client.D1Client | SqlClient.SqlClient>) =>
      Effect.runPromise(effect.pipe(Effect.provide(d1.layer)));

    expect(await run(applyGameRatings(game("g1", "llm-x", "bot:random")))).toBe("rated");
    expect(await run(applyGameRatings(game("g1", "llm-x", "bot:random")))).toBe("alreadyRated");
    expect(await run(applyGameRatings(game("g2", "llm-x", "bot:random")))).toBe("rated");

    const rows = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        return yield* decodeRows(RatingRow)(
          sql`SELECT competitor_id, games, wins, score FROM ratings WHERE players_count = 2 ORDER BY score DESC`,
        );
      }),
    );

    expect(rows.map((row) => [row.competitor_id, row.games, row.wins])).toEqual([
      ["llm-x", 2, 2],
      ["bot:random", 2, 0],
    ]);
  });

  it("skips games without at least two ranked seats", async () => {
    const d1 = memoryD1();

    const input: GameRatingInput = {
      ...game("g1", "a", "b"),
      results: game("g1", "a", "b").results.map((result) => ({ ...result, rank: null })),
    };

    expect(await Effect.runPromise(applyGameRatings(input).pipe(Effect.provide(d1.layer)))).toBe(
      "unrated",
    );
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
