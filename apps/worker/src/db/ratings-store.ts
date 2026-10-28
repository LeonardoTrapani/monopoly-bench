/**
 * Applies one finished game to the rating table of its player count (SPEC.md §8).
 *
 * Several RunDOs may finish games at the same time, so the read-modify-write is guarded: the
 * batch bumps `rating_tables.version` only if it still has the value read, and the guard
 * insert (`CHECK (ok = 1)` on `changes()`) aborts the whole batch otherwise. The update is
 * then retried from fresh priors. `rating_history`'s primary key makes a game count once.
 */
import { Effect, Result, Schema } from "effect";
import { SqlClient } from "effect/sql";

import type { SeatResult } from "../contracts.ts";
import { rateGame, type Skill } from "../ratings/ratings.ts";
import { batchAll, decodeRows } from "./sql.ts";

const MAX_ATTEMPTS = 6;

const VersionRow = Schema.Struct({ version: Schema.Int });

const PriorRow = Schema.Struct({
  competitor_id: Schema.String,
  mu: Schema.Number,
  sigma: Schema.Number,
  games: Schema.Int,
  wins: Schema.Int,
});

const RatedRow = Schema.Struct({ n: Schema.Int });

export interface GameRatingInput {
  readonly gameId: string;
  readonly playersCount: number;
  readonly at: string;
  readonly results: ReadonlyArray<SeatResult>;
}

export type RatingUpdate = "rated" | "alreadyRated" | "unrated";

const alreadyRated = Effect.fn("alreadyRated")(function* (gameId: string) {
  const sql = yield* SqlClient.SqlClient;

  const [row] = yield* decodeRows(RatedRow)(
    sql`SELECT COUNT(*) AS n FROM rating_history WHERE game_id = ${gameId}`,
  );

  return (row?.n ?? 0) > 0;
});

const attempt = Effect.fn("rateAttempt")(function* (input: GameRatingInput) {
  const sql = yield* SqlClient.SqlClient;

  const placements = input.results.flatMap((result) =>
    result.rank === null ? [] : [{ competitorId: result.competitorId, rank: result.rank }],
  );

  const competitors = [...new Set(placements.map((placement) => placement.competitorId))];

  yield* sql`INSERT OR IGNORE INTO rating_tables (players_count, version) VALUES (${input.playersCount}, 0)`;

  const [table] = yield* decodeRows(VersionRow)(
    sql`SELECT version FROM rating_tables WHERE players_count = ${input.playersCount}`,
  );

  const priorRows = yield* decodeRows(PriorRow)(sql`
    SELECT competitor_id, mu, sigma, games, wins FROM ratings
    WHERE players_count = ${input.playersCount} AND ${sql.in("competitor_id", competitors)}`);

  const priors = new Map<string, Skill>(
    priorRows.map((row) => [row.competitor_id, { mu: row.mu, sigma: row.sigma }]),
  );

  const counts = new Map(priorRows.map((row) => [row.competitor_id, row]));
  const identity = new Map(input.results.map((result) => [result.competitorId, result]));
  const rated = rateGame(placements, priors);
  const version = table?.version ?? 0;

  yield* batchAll(
    [
      sql`UPDATE rating_tables SET version = version + 1, updated_at = ${input.at}
        WHERE players_count = ${input.playersCount} AND version = ${version}`,
      sql`INSERT INTO rating_guard (ok) VALUES (changes())`,
      sql`DELETE FROM rating_guard`,
      ...rated.flatMap((competitor) => {
        const prior = counts.get(competitor.competitorId);
        const seat = identity.get(competitor.competitorId);

        return [
          sql`INSERT OR REPLACE INTO ratings ${sql.insert({
            competitor_id: competitor.competitorId,
            players_count: input.playersCount,
            label: seat?.label ?? competitor.competitorId,
            kind: seat?.kind ?? "llm",
            mu: competitor.mu,
            sigma: competitor.sigma,
            score: competitor.score,
            games: (prior?.games ?? 0) + 1,
            wins: (prior?.wins ?? 0) + (competitor.won ? 1 : 0),
            updated_at: input.at,
          })}`,
          sql`INSERT INTO rating_history ${sql.insert({
            competitor_id: competitor.competitorId,
            players_count: input.playersCount,
            game_id: input.gameId,
            at: input.at,
            mu: competitor.mu,
            sigma: competitor.sigma,
            score: competitor.score,
          })}`,
        ];
      }),
    ],
    1000,
  );
});

export const applyGameRatings = Effect.fn("applyGameRatings")(function* (input: GameRatingInput) {
  const ranked = input.results.filter((result) => result.rank !== null);

  if (ranked.length < 2) return "unrated" satisfies RatingUpdate;

  for (let index = 0; index < MAX_ATTEMPTS; index += 1) {
    if (yield* alreadyRated(input.gameId)) return "alreadyRated" satisfies RatingUpdate;

    const outcome = yield* Effect.result(attempt(input));

    if (Result.isSuccess(outcome)) return "rated" satisfies RatingUpdate;

    if (index === MAX_ATTEMPTS - 1) return yield* Effect.fail(outcome.failure);
  }

  return "unrated" satisfies RatingUpdate;
});
