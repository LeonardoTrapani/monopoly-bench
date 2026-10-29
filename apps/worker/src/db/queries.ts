/**
 * Read side of D1 behind the public API (SPEC.md §7.2): runs, games, leaderboard (per player
 * count, with head-to-head), models list and model profiles. Every result has exactly the
 * `@mb/api` shape.
 *
 * The leaderboard, head-to-head, models list and model profiles count LLM competitors in games
 * where every seat is an LLM (SPEC §8): bots and games with a bot seat (local or legacy) never
 * appear there. Runs and game lists show everything. There a competitor goes by its catalog
 * name (`competitors`, written when a run is created), else by its id: never by a seat label.
 */
import {
  type BehaviorStats,
  GameStatus,
  type GameSummary,
  type Leaderboard,
  type LeaderboardEntry,
  type ModelProfile,
  type ModelsResponse,
  PlayersCount,
  RunFunding,
  RunStatus,
  type RunSummary,
  Seat,
  SeatSpec,
} from "@mb/api";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { CompetitorKind } from "../contracts.ts";
import { chunk, D1_MAX_PARAMS, decodeRows } from "./sql.ts";

const EndReasonColumn = Schema.NullOr(
  Schema.Literals(["lastPlayerStanding", "turnCap", "aborted"]),
);

const RunRow = Schema.Struct({
  id: Schema.String,
  funding: RunFunding,
  name: Schema.NullOr(Schema.String),
  created_at: Schema.String,
  status: RunStatus,
  players_count: PlayersCount,
  seats_json: Schema.fromJsonString(Schema.Array(SeatSpec)),
  games_total: Schema.Int,
  games_finished: Schema.Int,
  games_running: Schema.Int,
  spent_usd: Schema.Number,
  budget_usd: Schema.Number,
});

const GameRow = Schema.Struct({
  id: Schema.String,
  run_id: Schema.String,
  seed: Schema.String,
  status: GameStatus,
  players_count: PlayersCount,
  started_at: Schema.NullOr(Schema.String),
  finished_at: Schema.NullOr(Schema.String),
  turn: Schema.Int,
  round: Schema.Int,
  end_reason: EndReasonColumn,
  abort_reason: Schema.NullOr(Schema.String),
  winner_seat: Schema.NullOr(Seat),
});

type GameRow = typeof GameRow.Type;

const SeatRow = Schema.Struct({
  game_id: Schema.String,
  seat: Seat,
  competitor_id: Schema.String,
  label: Schema.String,
  kind: CompetitorKind,
  final_rank: Schema.NullOr(Schema.Int),
  net_worth: Schema.NullOr(Schema.Number),
  cash: Schema.NullOr(Schema.Number),
  bankrupt_at_turn: Schema.NullOr(Schema.Int),
  cost_usd: Schema.Number,
  wakes: Schema.Int,
  invalid_actions: Schema.Int,
  timeouts: Schema.Int,
  model_errors: Schema.Int,
});

const RUN_COLUMNS = `r.id, r.funding, r.name, r.created_at, r.status, r.players_count, r.seats_json, r.games_total, r.spent_usd, r.budget_usd,
  (SELECT COUNT(*) FROM games g WHERE g.run_id = r.id AND g.status IN ('finished', 'aborted', 'failed')) AS games_finished,
  (SELECT COUNT(*) FROM games g WHERE g.run_id = r.id AND g.status = 'running') AS games_running`;

const GAME_COLUMNS =
  "g.id, g.run_id, g.seed, g.status, g.players_count, g.started_at, g.finished_at, g.turn, g.round, g.end_reason, g.abort_reason, g.winner_seat";

/** SQL: no seat of the game whose id is in `gameIdColumn` (a constant column name) is a bot. */
const llmOnly = (gameIdColumn: string): string =>
  `NOT EXISTS (SELECT 1 FROM seats bot_seat WHERE bot_seat.game_id = ${gameIdColumn} AND bot_seat.kind = 'bot')`;

/** SQL: game `g` counts for ratings and statistics: finished, LLM seats only. */
const RATED_GAME = `g.status = 'finished' AND ${llmOnly("g.id")}`;

const toRunSummary = (row: typeof RunRow.Type): RunSummary => ({
  id: row.id,
  funding: row.funding,
  name: row.name,
  createdAt: row.created_at,
  status: row.status,
  playersCount: row.players_count,
  seats: row.seats_json,
  gamesTotal: row.games_total,
  gamesFinished: row.games_finished,
  gamesRunning: row.games_running,
  spentUsd: row.spent_usd,
  budgetUsd: row.budget_usd,
});

/** Attach seats (with usage aggregated from `wakes`) to game rows, keeping their order. */
const withSeats = Effect.fn("withSeats")(function* (games: ReadonlyArray<GameRow>) {
  const sql = yield* SqlClient.SqlClient;
  const seatRows: Array<typeof SeatRow.Type> = [];

  for (const ids of chunk(
    games.map((game) => game.id),
    D1_MAX_PARAMS - 10,
  )) {
    const rows = yield* decodeRows(SeatRow)(sql`
      SELECT s.game_id, s.seat, s.competitor_id, s.label, s.kind, s.final_rank, s.net_worth, s.cash,
        s.bankrupt_at_turn,
        COALESCE(SUM(w.cost_usd), 0) AS cost_usd,
        COUNT(w.decision_id) AS wakes,
        COALESCE(SUM(w.invalid_actions), 0) AS invalid_actions,
        COALESCE(SUM(w.timed_out), 0) AS timeouts,
        COALESCE(SUM(CASE WHEN w.end_reason = 'modelError' THEN 1 ELSE 0 END), 0) AS model_errors
      FROM seats s
      LEFT JOIN wakes w ON w.game_id = s.game_id AND w.seat = s.seat
      WHERE ${sql.in("s.game_id", ids)}
      GROUP BY s.game_id, s.seat
      ORDER BY s.game_id, s.seat`);

    seatRows.push(...rows);
  }

  return games.map((game): GameSummary => ({
    id: game.id,
    runId: game.run_id,
    seed: game.seed,
    status: game.status,
    playersCount: game.players_count,
    startedAt: game.started_at,
    finishedAt: game.finished_at,
    turn: game.turn,
    round: game.round,
    endReason: game.end_reason,
    abortReason: game.abort_reason,
    winnerSeat: game.winner_seat,
    seats: seatRows.flatMap((seat) =>
      seat.game_id === game.id
        ? [
            {
              seat: seat.seat,
              competitorId: seat.competitor_id,
              label: seat.label,
              kind: seat.kind,
              finalRank: seat.final_rank,
              netWorth: seat.net_worth,
              cash: seat.cash,
              bankruptAtTurn: seat.bankrupt_at_turn,
              costUsd: seat.cost_usd,
              wakes: seat.wakes,
              invalidActions: seat.invalid_actions,
              timeouts: seat.timeouts,
              modelErrors: seat.model_errors,
            },
          ]
        : [],
    ),
  }));
});

export const listRuns = Effect.fn("listRuns")(function* (limit: number) {
  const sql = yield* SqlClient.SqlClient;

  const rows = yield* decodeRows(RunRow)(
    sql`SELECT ${sql.literal(RUN_COLUMNS)} FROM runs r ORDER BY r.created_at DESC LIMIT ${limit}`,
  );

  return rows.map(toRunSummary);
});

export const getRun = Effect.fn("getRun")(function* (runId: string) {
  const sql = yield* SqlClient.SqlClient;

  const [row] = yield* decodeRows(RunRow)(
    sql`SELECT ${sql.literal(RUN_COLUMNS)} FROM runs r WHERE r.id = ${runId}`,
  );

  if (row === undefined) return null;

  const games = yield* decodeRows(GameRow)(
    sql`SELECT ${sql.literal(GAME_COLUMNS)} FROM games g WHERE g.run_id = ${runId} ORDER BY g.game_index`,
  );

  return { run: toRunSummary(row), games: yield* withSeats(games) };
});

export interface GameFilter {
  readonly status: "live" | "finished" | null;
  readonly players: PlayersCount | null;
  /** Competitor id; also matches its reasoning variants (`<id>:<level>`). */
  readonly model: string | null;
  readonly limit: number;
}

export const listGames = Effect.fn("listGames")(function* (filter: GameFilter) {
  const sql = yield* SqlClient.SqlClient;

  const clauses = [
    filter.status === "live" ? sql`g.status = 'running'` : null,
    filter.status === "finished" ? sql`g.status IN ('finished', 'aborted', 'failed')` : null,
    filter.players === null ? null : sql`g.players_count = ${filter.players}`,
    filter.model === null
      ? null
      : sql`EXISTS (SELECT 1 FROM seats s WHERE s.game_id = g.id AND (s.competitor_id = ${filter.model} OR s.competitor_id LIKE ${`${filter.model}:%`}))`,
  ].flatMap((clause) => (clause === null ? [] : [clause]));

  const where = clauses.length === 0 ? sql`` : sql`WHERE ${sql.and(clauses)}`;

  const games = yield* decodeRows(GameRow)(sql`
    SELECT ${sql.literal(GAME_COLUMNS)} FROM games g ${where}
    ORDER BY COALESCE(g.finished_at, g.started_at, g.updated_at) DESC, g.id
    LIMIT ${filter.limit}`);

  return yield* withSeats(games);
});

export const getGame = Effect.fn("getGame")(function* (gameId: string) {
  const sql = yield* SqlClient.SqlClient;

  const games = yield* decodeRows(GameRow)(
    sql`SELECT ${sql.literal(GAME_COLUMNS)} FROM games g WHERE g.id = ${gameId}`,
  );

  const [game] = yield* withSeats(games);

  return game ?? null;
});

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

const PlacementAggregate = Schema.Struct({
  competitor_id: Schema.String,
  games: Schema.Int,
  avg_place: Schema.Number,
  avg_net_worth: Schema.Number,
});

const WakeAggregate = Schema.Struct({
  competitor_id: Schema.String,
  cost_usd: Schema.Number,
  invalid_actions: Schema.Int,
  tool_calls: Schema.Int,
  timeouts: Schema.Int,
  wakes: Schema.Int,
  avg_wake_ms: Schema.Number,
});

type WakeAggregate = typeof WakeAggregate.Type;

const ModelAbortRow = Schema.Struct({
  competitor_id: Schema.String,
  aborts: Schema.Int,
});

const HeadToHeadRow = Schema.Struct({
  a: Schema.String,
  b: Schema.String,
  games: Schema.Int,
  a_ahead: Schema.Int,
});

/** Share of tool calls that were invalid; nudges without a call count in the denominator too. */
const invalidRate = (wakes: WakeAggregate | undefined): number =>
  wakes === undefined || wakes.invalid_actions === 0
    ? 0
    : wakes.invalid_actions / Math.max(wakes.tool_calls, wakes.invalid_actions);

const timeoutRate = (wakes: WakeAggregate | undefined): number =>
  wakes === undefined || wakes.wakes === 0 ? 0 : wakes.timeouts / wakes.wakes;

const wakeAggregates = Effect.fn("wakeAggregates")(function* (playersCount: PlayersCount | null) {
  const sql = yield* SqlClient.SqlClient;
  const scope = playersCount === null ? sql`` : sql`AND g.players_count = ${playersCount}`;

  return yield* decodeRows(WakeAggregate)(sql`
    SELECT w.competitor_id,
      COALESCE(SUM(w.cost_usd), 0) AS cost_usd,
      COALESCE(SUM(w.invalid_actions), 0) AS invalid_actions,
      COALESCE(SUM(w.tool_calls), 0) AS tool_calls,
      COALESCE(SUM(w.timed_out), 0) AS timeouts,
      COUNT(*) AS wakes,
      COALESCE(AVG(w.latency_ms), 0) AS avg_wake_ms
    FROM wakes w JOIN games g ON g.id = w.game_id
    WHERE ${sql.literal(RATED_GAME)} ${scope}
    GROUP BY w.competitor_id`);
});

export const leaderboard = Effect.fn("leaderboard")(function* (playersCount: PlayersCount) {
  const sql = yield* SqlClient.SqlClient;

  const ratings = yield* decodeRows(RatingRow)(sql`
    SELECT r.competitor_id, COALESCE(c.name, r.competitor_id) AS label, r.kind, r.mu, r.sigma, r.score,
      r.games, r.wins, r.updated_at
    FROM ratings r LEFT JOIN competitors c ON c.competitor_id = r.competitor_id
    WHERE r.players_count = ${playersCount} AND r.kind = 'llm'
    ORDER BY r.score DESC, r.competitor_id`);

  const placements = yield* decodeRows(PlacementAggregate)(sql`
    SELECT s.competitor_id, COUNT(DISTINCT s.game_id) AS games,
      AVG(s.final_rank) AS avg_place, COALESCE(AVG(s.net_worth), 0) AS avg_net_worth
    FROM seats s JOIN games g ON g.id = s.game_id
    WHERE ${sql.literal(RATED_GAME)} AND g.players_count = ${playersCount} AND s.final_rank IS NOT NULL
    GROUP BY s.competitor_id`);

  const wakes = yield* wakeAggregates(playersCount);

  const modelAborts = yield* decodeRows(ModelAbortRow)(sql`
    SELECT s.competitor_id, COUNT(*) AS aborts
    FROM games g JOIN seats s ON s.game_id = g.id AND s.seat = g.abort_seat
    WHERE g.status = 'aborted' AND g.players_count = ${playersCount}
    GROUP BY s.competitor_id`);

  const headToHead = yield* decodeRows(HeadToHeadRow)(sql`
    WITH placed AS (
      SELECT s.game_id, s.competitor_id, MIN(s.final_rank) AS rank
      FROM seats s JOIN games g ON g.id = s.game_id
      WHERE ${sql.literal(RATED_GAME)} AND g.players_count = ${playersCount} AND s.final_rank IS NOT NULL
      GROUP BY s.game_id, s.competitor_id
    )
    SELECT a.competitor_id AS a, b.competitor_id AS b, COUNT(*) AS games,
      SUM(CASE WHEN a.rank < b.rank THEN 1 ELSE 0 END) AS a_ahead
    FROM placed a JOIN placed b ON a.game_id = b.game_id AND a.competitor_id <> b.competitor_id
    GROUP BY a.competitor_id, b.competitor_id
    ORDER BY a.competitor_id, b.competitor_id`);

  const placementOf = new Map(placements.map((row) => [row.competitor_id, row]));
  const wakesOf = new Map(wakes.map((row) => [row.competitor_id, row]));
  const abortsOf = new Map(modelAborts.map((row) => [row.competitor_id, row.aborts]));

  const entries = ratings.map((rating): LeaderboardEntry => {
    const placement = placementOf.get(rating.competitor_id);
    const usage = wakesOf.get(rating.competitor_id);
    const games = placement?.games ?? rating.games;
    const aborts = abortsOf.get(rating.competitor_id) ?? 0;

    return {
      competitorId: rating.competitor_id,
      label: rating.label,
      kind: rating.kind,
      mu: rating.mu,
      sigma: rating.sigma,
      score: rating.score,
      games: rating.games,
      wins: rating.wins,
      avgPlace: placement?.avg_place ?? 0,
      avgNetWorth: placement?.avg_net_worth ?? 0,
      invalidRate: invalidRate(usage),
      timeoutRate: timeoutRate(usage),
      modelAborts: aborts,
      abortRate: aborts === 0 ? 0 : aborts / (rating.games + aborts),
      costPerGameUsd: games === 0 ? 0 : (usage?.cost_usd ?? 0) / games,
      avgWakeMs: usage?.avg_wake_ms ?? 0,
    };
  });

  const updatedAt = ratings.reduce<string | null>(
    (latest, row) => (latest === null || row.updated_at > latest ? row.updated_at : latest),
    null,
  );

  const result: Leaderboard = {
    playersCount,
    updatedAt,
    entries,
    headToHead: headToHead.map((row) => ({
      a: row.a,
      b: row.b,
      games: row.games,
      aAhead: row.a_ahead,
    })),
  };

  return result;
});

const CompetitorRow = Schema.Struct({
  competitor_id: Schema.String,
  label: Schema.String,
  kind: CompetitorKind,
  games: Schema.Int,
});

export const models = Effect.fn("models")(function* () {
  const sql = yield* SqlClient.SqlClient;

  const rows = yield* decodeRows(CompetitorRow)(sql`
    SELECT s.competitor_id,
      COALESCE(
        (SELECT c.name FROM competitors c WHERE c.competitor_id = s.competitor_id),
        s.competitor_id
      ) AS label,
      MAX(s.kind) AS kind, COUNT(DISTINCT s.game_id) AS games
    FROM seats s JOIN games g ON g.id = s.game_id
    WHERE ${sql.literal(RATED_GAME)}
    GROUP BY s.competitor_id
    ORDER BY games DESC, s.competitor_id`);

  const result: ModelsResponse = {
    competitors: rows.map((row) => ({
      competitorId: row.competitor_id,
      label: row.label,
      kind: row.kind,
      games: row.games,
    })),
  };

  return result;
});

const ProfileRatingRow = Schema.Struct({
  players_count: PlayersCount,
  mu: Schema.Number,
  sigma: Schema.Number,
  score: Schema.Number,
  games: Schema.Int,
  wins: Schema.Int,
});

const HistoryRow = Schema.Struct({
  players_count: PlayersCount,
  at: Schema.String,
  score: Schema.Number,
});

const IdentityRow = Schema.Struct({ label: Schema.String, kind: CompetitorKind });

const CountRow = Schema.Struct({ n: Schema.Int });

const OfferStatsRow = Schema.Struct({
  offers_made: Schema.Int,
  offers_accepted: Schema.Int,
  offers_received: Schema.Int,
  offers_accepted_from_others: Schema.Int,
});

const AuctionStatsRow = Schema.Struct({
  auctions_won: Schema.Int,
  auction_premium: Schema.NullOr(Schema.Number),
});

const SeatStatsRow = Schema.Struct({
  properties_bought: Schema.Int,
  houses_built: Schema.Int,
  hotels_built: Schema.Int,
  mortgages: Schema.Int,
  jail_turns: Schema.Int,
  bankruptcies: Schema.Int,
});

const GameIdRow = Schema.Struct({ game_id: Schema.String });

const behaviorStats = Effect.fn("behaviorStats")(function* (id: string) {
  const sql = yield* SqlClient.SqlClient;
  const offersOfLlmGames = sql.literal(llmOnly("offers.game_id"));

  const [offers] = yield* decodeRows(OfferStatsRow)(sql`
    SELECT
      (SELECT COUNT(*) FROM offers WHERE from_competitor = ${id} AND ${offersOfLlmGames}) AS offers_made,
      (SELECT COUNT(*) FROM offers WHERE from_competitor = ${id} AND status = 'accepted' AND ${offersOfLlmGames}) AS offers_accepted,
      (SELECT COUNT(*) FROM offers WHERE to_competitor = ${id} AND ${offersOfLlmGames}) AS offers_received,
      (SELECT COUNT(*) FROM offers WHERE accepted_by_competitor = ${id} AND from_competitor <> ${id} AND ${offersOfLlmGames}) AS offers_accepted_from_others`);

  const [auctions] = yield* decodeRows(AuctionStatsRow)(sql`
    SELECT COUNT(*) AS auctions_won,
      AVG(CASE WHEN list_price > 0 AND price IS NOT NULL THEN price / list_price END) AS auction_premium
    FROM auctions WHERE winner_competitor = ${id} AND kind = 'property'
      AND ${sql.literal(llmOnly("auctions.game_id"))}`);

  const [seats] = yield* decodeRows(SeatStatsRow)(sql`
    SELECT COALESCE(SUM(properties_bought), 0) AS properties_bought,
      COALESCE(SUM(houses_built), 0) AS houses_built,
      COALESCE(SUM(hotels_built), 0) AS hotels_built,
      COALESCE(SUM(mortgages), 0) AS mortgages,
      COALESCE(SUM(jail_turns), 0) AS jail_turns,
      COUNT(bankrupt_at_turn) AS bankruptcies
    FROM seats WHERE competitor_id = ${id} AND ${sql.literal(llmOnly("seats.game_id"))}`);

  const stats: BehaviorStats = {
    offersMade: offers?.offers_made ?? 0,
    offersAccepted: offers?.offers_accepted ?? 0,
    offersReceived: offers?.offers_received ?? 0,
    offersAcceptedFromOthers: offers?.offers_accepted_from_others ?? 0,
    auctionsWon: auctions?.auctions_won ?? 0,
    auctionPremium: auctions?.auction_premium ?? null,
    propertiesBought: seats?.properties_bought ?? 0,
    housesBuilt: seats?.houses_built ?? 0,
    hotelsBuilt: seats?.hotels_built ?? 0,
    mortgages: seats?.mortgages ?? 0,
    bankruptcies: seats?.bankruptcies ?? 0,
    jailTurns: seats?.jail_turns ?? 0,
  };

  return stats;
});

export const modelProfile = Effect.fn("modelProfile")(function* (id: string, recentLimit: number) {
  const sql = yield* SqlClient.SqlClient;

  const [identity] = yield* decodeRows(IdentityRow)(sql`
    SELECT COALESCE((SELECT name FROM competitors WHERE competitor_id = ${id}), ${id}) AS label, kind
    FROM (
      SELECT kind, 0 AS priority FROM ratings WHERE competitor_id = ${id}
      UNION ALL
      SELECT kind, 1 AS priority FROM seats WHERE competitor_id = ${id}
    ) ORDER BY priority LIMIT 1`);

  if (identity === undefined || identity.kind === "bot") return null;

  const ratings = yield* decodeRows(ProfileRatingRow)(sql`
    SELECT players_count, mu, sigma, score, games, wins FROM ratings
    WHERE competitor_id = ${id} ORDER BY players_count`);

  const history = yield* decodeRows(HistoryRow)(sql`
    SELECT players_count, at, score FROM rating_history
    WHERE competitor_id = ${id} ORDER BY at, players_count`);

  const [finished] = yield* decodeRows(CountRow)(sql`
    SELECT COUNT(DISTINCT s.game_id) AS n FROM seats s JOIN games g ON g.id = s.game_id
    WHERE s.competitor_id = ${id} AND ${sql.literal(RATED_GAME)}`);

  const usage = (yield* wakeAggregates(null)).find((row) => row.competitor_id === id);

  const recentIds = yield* decodeRows(GameIdRow)(sql`
    SELECT s.game_id FROM seats s JOIN games g ON g.id = s.game_id
    WHERE s.competitor_id = ${id} AND ${sql.literal(llmOnly("g.id"))}
    GROUP BY s.game_id
    ORDER BY MAX(COALESCE(g.finished_at, g.started_at, g.updated_at)) DESC
    LIMIT ${recentLimit}`);

  const recent = yield* decodeRows(GameRow)(
    recentIds.length === 0
      ? sql`SELECT ${sql.literal(GAME_COLUMNS)} FROM games g WHERE 0`
      : sql`SELECT ${sql.literal(GAME_COLUMNS)} FROM games g WHERE ${sql.in(
          "g.id",
          recentIds.map((row) => row.game_id),
        )} ORDER BY COALESCE(g.finished_at, g.started_at, g.updated_at) DESC`,
  );

  const finishedGames = finished?.n ?? 0;

  const profile: ModelProfile = {
    competitorId: id,
    label: identity.label,
    kind: identity.kind,
    ratings: ratings.map((row) => ({
      playersCount: row.players_count,
      mu: row.mu,
      sigma: row.sigma,
      score: row.score,
      games: row.games,
      wins: row.wins,
    })),
    ratingHistory: history.map((row) => ({
      playersCount: row.players_count,
      at: row.at,
      score: row.score,
    })),
    behavior: yield* behaviorStats(id),
    costPerGameUsd: finishedGames === 0 ? 0 : (usage?.cost_usd ?? 0) / finishedGames,
    avgWakeMs: usage?.avg_wake_ms ?? 0,
    recentGames: yield* withSeats(recent),
  };

  return profile;
});
