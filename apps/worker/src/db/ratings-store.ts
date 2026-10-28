/**
 * The rating tables in D1 (SPEC.md §8): one finished game applied when it ends
 * (`applyGameRatings`), or a whole player count replayed after a run is deleted
 * (`recomputeRatings`). Both use the same OpenSkill code (`ratings/ratings.ts`) and count only
 * games where every seat is an LLM.
 *
 * Several RunDOs may finish games at the same time, so every read-modify-write is guarded: the
 * batch bumps `rating_tables.version` only if it still has the value read, and the guard insert
 * (`CHECK (ok = 1)` on `changes()`) aborts the whole batch otherwise. The update is then retried
 * from fresh data. `rating_history`'s primary key makes a game count once.
 */
import { Effect, Result, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { CompetitorKind, type SeatResult } from "../contracts.ts";
import {
  applyGame,
  type CompetitorRating,
  isRatedGame,
  type RatedGame,
  type RatedSeat,
  replayRatings,
} from "../ratings/ratings.ts";
import { batchAll, chunk, D1_MAX_PARAMS, decodeRows } from "./sql.ts";

const MAX_ATTEMPTS = 6;

const VersionRow = Schema.Struct({ version: Schema.Int });

const RatingRow = Schema.Struct({
  competitor_id: Schema.String,
  label: Schema.String,
  kind: CompetitorKind,
  mu: Schema.Number,
  sigma: Schema.Number,
  score: Schema.Number,
  games: Schema.Int,
  wins: Schema.Int,
  updated_at: Schema.String,
});

const RatedRow = Schema.Struct({ n: Schema.Int });

const ReplaySeatRow = Schema.Struct({
  game_id: Schema.String,
  finished_at: Schema.String,
  competitor_id: Schema.String,
  label: Schema.String,
  kind: CompetitorKind,
  final_rank: Schema.NullOr(Schema.Int),
});

export interface GameRatingInput {
  readonly gameId: string;
  readonly playersCount: number;
  readonly at: string;
  readonly results: ReadonlyArray<SeatResult>;
}

export type RatingUpdate = "rated" | "alreadyRated" | "unrated";

/** A game being assembled from its seat rows. */
interface ReplayGame extends RatedGame {
  readonly seats: Array<RatedSeat>;
}

const ratedGameOf = (input: GameRatingInput): RatedGame => ({
  gameId: input.gameId,
  at: input.at,
  seats: input.results.map((result) => ({
    competitorId: result.competitorId,
    label: result.label,
    kind: result.kind,
    rank: result.rank,
  })),
});

const ratingOfRow = (row: typeof RatingRow.Type): CompetitorRating => ({
  competitorId: row.competitor_id,
  label: row.label,
  kind: row.kind,
  mu: row.mu,
  sigma: row.sigma,
  score: row.score,
  games: row.games,
  wins: row.wins,
  updatedAt: row.updated_at,
});

const ratingRow = (playersCount: number, rating: CompetitorRating) => ({
  competitor_id: rating.competitorId,
  players_count: playersCount,
  label: rating.label,
  kind: rating.kind,
  mu: rating.mu,
  sigma: rating.sigma,
  score: rating.score,
  games: rating.games,
  wins: rating.wins,
  updated_at: rating.updatedAt,
});

const alreadyRated = Effect.fn("alreadyRated")(function* (gameId: string) {
  const sql = yield* SqlClient.SqlClient;

  const [row] = yield* decodeRows(RatedRow)(
    sql`SELECT COUNT(*) AS n FROM rating_history WHERE game_id = ${gameId}`,
  );

  return (row?.n ?? 0) > 0;
});

/** The table's current version (creating the table row first). */
const tableVersion = Effect.fn("tableVersion")(function* (playersCount: number) {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`INSERT OR IGNORE INTO rating_tables (players_count, version) VALUES (${playersCount}, 0)`;

  const [table] = yield* decodeRows(VersionRow)(
    sql`SELECT version FROM rating_tables WHERE players_count = ${playersCount}`,
  );

  return table?.version ?? 0;
});

/** The first statements of every rating batch: bump the version, fail if it moved. */
const guardStatements = (
  sql: SqlClient.SqlClient,
  playersCount: number,
  version: number,
  at: string | null,
) => [
  sql`UPDATE rating_tables SET version = version + 1, updated_at = ${at}
    WHERE players_count = ${playersCount} AND version = ${version}`,
  sql`INSERT INTO rating_guard (ok) VALUES (changes())`,
  sql`DELETE FROM rating_guard`,
];

/** False once the game's run was deleted (or the game never finished). */
const isFinishedGame = Effect.fn("isFinishedGame")(function* (gameId: string) {
  const sql = yield* SqlClient.SqlClient;

  const rows = yield* sql`SELECT 1 AS one FROM games WHERE id = ${gameId} AND status = 'finished'`;

  return rows.length > 0;
});

const attempt = Effect.fn("rateAttempt")(function* (playersCount: number, game: RatedGame) {
  const sql = yield* SqlClient.SqlClient;
  const competitors = [...new Set(game.seats.map((seat) => seat.competitorId))];
  const version = yield* tableVersion(playersCount);

  const priorRows = yield* decodeRows(RatingRow)(sql`
    SELECT competitor_id, label, kind, mu, sigma, score, games, wins, updated_at FROM ratings
    WHERE players_count = ${playersCount} AND ${sql.in("competitor_id", competitors)}`);

  const priors = new Map(priorRows.map((row) => [row.competitor_id, ratingOfRow(row)]));

  yield* batchAll(
    [
      ...guardStatements(sql, playersCount, version, game.at),
      // A run deleted meanwhile took the game with it: rate nothing (the batch aborts).
      sql`INSERT INTO rating_guard (ok)
        SELECT COUNT(*) FROM games WHERE id = ${game.gameId} AND status = 'finished'`,
      sql`DELETE FROM rating_guard`,
      ...applyGame(priors, game).flatMap((rating) => [
        sql`INSERT OR REPLACE INTO ratings ${sql.insert(ratingRow(playersCount, rating))}`,
        sql`INSERT INTO rating_history ${sql.insert({
          competitor_id: rating.competitorId,
          players_count: playersCount,
          game_id: game.gameId,
          at: game.at,
          mu: rating.mu,
          sigma: rating.sigma,
          score: rating.score,
        })}`,
      ]),
    ],
    1000,
  );
});

export const applyGameRatings = Effect.fn("applyGameRatings")(function* (input: GameRatingInput) {
  const game = ratedGameOf(input);

  if (!isRatedGame(game.seats)) return "unrated" satisfies RatingUpdate;

  for (let index = 0; index < MAX_ATTEMPTS; index += 1) {
    if (yield* alreadyRated(input.gameId)) return "alreadyRated" satisfies RatingUpdate;

    if (!(yield* isFinishedGame(input.gameId))) return "unrated" satisfies RatingUpdate;

    const outcome = yield* Effect.result(attempt(input.playersCount, game));

    if (Result.isSuccess(outcome)) return "rated" satisfies RatingUpdate;

    if (index === MAX_ATTEMPTS - 1) return yield* Effect.fail(outcome.failure);
  }

  return "unrated" satisfies RatingUpdate;
});

/** The finished games of one player count, in `finished_at` order, with their seats. */
const finishedGames = Effect.fn("finishedGames")(function* (playersCount: number) {
  const sql = yield* SqlClient.SqlClient;

  const rows = yield* decodeRows(ReplaySeatRow)(sql`
    SELECT g.id AS game_id, g.finished_at, s.competitor_id, s.label, s.kind, s.final_rank
    FROM games g JOIN seats s ON s.game_id = g.id
    WHERE g.status = 'finished' AND g.players_count = ${playersCount} AND g.finished_at IS NOT NULL
    ORDER BY g.finished_at, g.id, s.seat`);

  const games: Array<ReplayGame> = [];

  for (const row of rows) {
    const seat: RatedSeat = {
      competitorId: row.competitor_id,
      label: row.label,
      kind: row.kind,
      rank: row.final_rank,
    };

    const last = games.at(-1);

    if (last?.gameId === row.game_id) last.seats.push(seat);
    else games.push({ gameId: row.game_id, at: row.finished_at, seats: [seat] });
  }

  return games;
});

const recomputeAttempt = Effect.fn("recomputeAttempt")(function* (playersCount: number) {
  const sql = yield* SqlClient.SqlClient;
  const version = yield* tableVersion(playersCount);
  const games = yield* finishedGames(playersCount);
  const table = replayRatings(games);

  const historyRows = table.history.map((entry) => ({
    competitor_id: entry.competitorId,
    players_count: playersCount,
    game_id: entry.gameId,
    at: entry.at,
    mu: entry.mu,
    sigma: entry.sigma,
    score: entry.score,
  }));

  const statements = [
    ...guardStatements(sql, playersCount, version, games.at(-1)?.at ?? null),
    sql`DELETE FROM ratings WHERE players_count = ${playersCount}`,
    sql`DELETE FROM rating_history WHERE players_count = ${playersCount}`,
    ...chunk(
      table.ratings.map((rating) => ratingRow(playersCount, rating)),
      Math.floor(D1_MAX_PARAMS / 10),
    ).map((rows) => sql`INSERT INTO ratings ${sql.insert(rows)}`),
    ...chunk(historyRows, Math.floor(D1_MAX_PARAMS / 7)).map(
      (rows) => sql`INSERT INTO rating_history ${sql.insert(rows)}`,
    ),
  ];

  // One batch: the version guard must cover every write.
  yield* batchAll(statements, statements.length);

  return table.ratings.length;
});

/**
 * Rebuilds the rating table and rating history of one player count by replaying its remaining
 * finished games in `finished_at` order from the default prior (SPEC §8), e.g. after a run was
 * deleted. Returns the number of rated competitors.
 */
export const recomputeRatings = Effect.fn("recomputeRatings")(function* (playersCount: number) {
  for (let index = 0; index < MAX_ATTEMPTS - 1; index += 1) {
    const outcome = yield* Effect.result(recomputeAttempt(playersCount));

    if (Result.isSuccess(outcome)) return outcome.success;
  }

  return yield* recomputeAttempt(playersCount);
});
