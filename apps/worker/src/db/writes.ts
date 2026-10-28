/**
 * Write side of D1. RunDO inserts runs, games and seats; GameDO writes progress at turn end,
 * one row per wake, and the final summary with offers and auctions. Every write is idempotent
 * (`INSERT OR IGNORE`, upserts, guarded updates), so retries are safe.
 */
import { type GameStatus, RunConfig, type RunStatus, type Seat, SeatSpec } from "@mb/api";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";

import type { EndReason, Json } from "../game/engine.ts";
import type { PlannedGame } from "../runs/expand.ts";
import { batchAll, chunk, D1_MAX_PARAMS } from "./sql.ts";

const encodeConfig = Schema.encodeSync(Schema.fromJsonString(RunConfig));

const encodeSeats = Schema.encodeSync(Schema.fromJsonString(Schema.Array(SeatSpec)));

const encodeSpec = Schema.encodeSync(Schema.fromJsonString(SeatSpec));

const encodeStrings = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json));

export interface NewRun {
  readonly id: string;
  readonly createdAt: string;
  readonly config: RunConfig;
  readonly games: ReadonlyArray<PlannedGame>;
}

export const insertRun = Effect.fn("insertRun")(function* (run: NewRun) {
  const sql = yield* SqlClient.SqlClient;

  const runRow = {
    id: run.id,
    name: run.config.name ?? null,
    created_at: run.createdAt,
    finished_at: null,
    status: "running",
    players_count: run.config.players.length,
    config_json: encodeConfig(run.config),
    seats_json: encodeSeats(run.config.players),
    games_total: run.games.length,
    spent_usd: 0,
    budget_usd: run.config.budgetUsd,
  };

  const gameRows = run.games.map((game) => ({
    id: game.gameId,
    run_id: run.id,
    game_index: game.gameIndex,
    seed_index: game.seedIndex,
    rotation: game.rotation,
    seed: game.seed,
    status: "queued",
    players_count: game.seats.length,
    updated_at: run.createdAt,
  }));

  const seatRows = run.games.flatMap((game) =>
    game.seats.map((seat) => ({
      game_id: game.gameId,
      seat: seat.seat,
      competitor_id: seat.competitorId,
      label: seat.label,
      kind: seat.kind,
      spec_json: encodeSpec(seat.spec),
    })),
  );

  yield* sql`INSERT OR IGNORE INTO runs ${sql.insert(runRow)}`;
  yield* batchAll(
    chunk(gameRows, Math.floor(D1_MAX_PARAMS / 9)).map(
      (rows) => sql`INSERT OR IGNORE INTO games ${sql.insert(rows)}`,
    ),
  );
  yield* batchAll(
    chunk(seatRows, Math.floor(D1_MAX_PARAMS / 6)).map(
      (rows) => sql`INSERT OR IGNORE INTO seats ${sql.insert(rows)}`,
    ),
  );
});

export const updateRun = Effect.fn("updateRun")(function* (
  runId: string,
  status: RunStatus,
  spentUsd: number,
  finishedAt: string | null,
) {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`UPDATE runs SET status = ${status}, spent_usd = ${spentUsd},
    finished_at = COALESCE(finished_at, ${finishedAt}) WHERE id = ${runId}`;
});

export const markGameRunning = Effect.fn("markGameRunning")(function* (gameId: string, at: string) {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`UPDATE games SET status = 'running', started_at = COALESCE(started_at, ${at}), updated_at = ${at}
    WHERE id = ${gameId} AND status = 'queued'`;
});

/** Queued games that will never start (run cancelled, budget exhausted). */
export const abortQueuedGames = Effect.fn("abortQueuedGames")(function* (
  gameIds: ReadonlyArray<string>,
  at: string,
) {
  const sql = yield* SqlClient.SqlClient;

  for (const ids of chunk(gameIds, D1_MAX_PARAMS - 5)) {
    yield* sql`UPDATE games SET status = 'aborted', end_reason = 'aborted', finished_at = ${at}, updated_at = ${at}
      WHERE ${sql.in("id", ids)} AND status = 'queued'`;
  }
});

export const gameProgress = Effect.fn("gameProgress")(function* (
  gameId: string,
  turn: number,
  round: number,
  at: string,
) {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`UPDATE games SET turn = ${turn}, round = ${round}, updated_at = ${at}
    WHERE id = ${gameId} AND status = 'running'`;
});

export interface WakeRow {
  readonly gameId: string;
  readonly seat: Seat;
  readonly decisionId: string;
  readonly competitorId: string;
  readonly turn: number;
  readonly kind: string;
  readonly round: number;
  readonly reasons: ReadonlyArray<string>;
  readonly startedAt: string;
  readonly latencyMs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly costUsd: number;
  readonly toolCalls: number;
  readonly invalidActions: number;
  readonly timedOut: boolean;
  readonly endReason: string;
}

export const recordWake = Effect.fn("recordWake")(function* (wake: WakeRow) {
  const sql = yield* SqlClient.SqlClient;

  const row = {
    game_id: wake.gameId,
    seat: wake.seat,
    decision_id: wake.decisionId,
    competitor_id: wake.competitorId,
    turn: wake.turn,
    kind: wake.kind,
    round: wake.round,
    reasons_json: encodeStrings(wake.reasons),
    started_at: wake.startedAt,
    latency_ms: Math.round(wake.latencyMs),
    input_tokens: wake.inputTokens,
    output_tokens: wake.outputTokens,
    reasoning_tokens: wake.reasoningTokens,
    cost_usd: wake.costUsd,
    tool_calls: wake.toolCalls,
    invalid_actions: wake.invalidActions,
    timed_out: wake.timedOut ? 1 : 0,
    end_reason: wake.endReason,
  };

  yield* sql`INSERT OR REPLACE INTO wakes ${sql.insert(row)}`;
});

export interface FinishedSeat {
  readonly seat: Seat;
  readonly rank: number | null;
  readonly netWorth: number;
  readonly cash: number;
  readonly bankruptAtTurn: number | null;
  readonly propertiesBought: number;
  readonly housesBuilt: number;
  readonly hotelsBuilt: number;
  readonly mortgages: number;
  readonly jailTurns: number;
}

export interface OfferRow {
  readonly offerId: string;
  readonly turn: number;
  readonly round: number;
  readonly fromSeat: Seat;
  readonly fromCompetitor: string;
  readonly toSeat: Seat | null;
  readonly toCompetitor: string | null;
  readonly give: Json;
  readonly get: Json;
  readonly replyTo: string | null;
  readonly comment: string | null;
  readonly status: string;
  readonly acceptedBySeat: Seat | null;
  readonly acceptedByCompetitor: string | null;
}

export interface AuctionRow {
  readonly auctionId: string;
  readonly turn: number;
  readonly kind: "property" | "building";
  readonly property: string;
  readonly listPrice: number;
  readonly winnerSeat: Seat | null;
  readonly winnerCompetitor: string | null;
  readonly price: number | null;
  readonly bids: number;
}

export interface FinishedGame {
  readonly gameId: string;
  readonly status: Extract<GameStatus, "finished" | "aborted" | "failed">;
  readonly endReason: EndReason | null;
  readonly winnerSeat: Seat | null;
  readonly finishedAt: string;
  readonly turn: number;
  readonly round: number;
  readonly seats: ReadonlyArray<FinishedSeat>;
  readonly offers: ReadonlyArray<OfferRow>;
  readonly auctions: ReadonlyArray<AuctionRow>;
}

export const finishGame = Effect.fn("finishGame")(function* (game: FinishedGame) {
  const sql = yield* SqlClient.SqlClient;

  const offerRows = game.offers.map((offer) => ({
    game_id: game.gameId,
    offer_id: offer.offerId,
    turn: offer.turn,
    round: offer.round,
    from_seat: offer.fromSeat,
    from_competitor: offer.fromCompetitor,
    to_seat: offer.toSeat,
    to_competitor: offer.toCompetitor,
    give_json: encodeJson(offer.give),
    get_json: encodeJson(offer.get),
    reply_to: offer.replyTo,
    comment: offer.comment,
    status: offer.status,
    accepted_by_seat: offer.acceptedBySeat,
    accepted_by_competitor: offer.acceptedByCompetitor,
  }));

  const auctionRows = game.auctions.map((auction) => ({
    game_id: game.gameId,
    auction_id: auction.auctionId,
    turn: auction.turn,
    kind: auction.kind,
    property: auction.property,
    list_price: auction.listPrice,
    winner_seat: auction.winnerSeat,
    winner_competitor: auction.winnerCompetitor,
    price: auction.price,
    bids: auction.bids,
  }));

  yield* batchAll([
    sql`UPDATE games SET status = ${game.status}, end_reason = ${game.endReason}, winner_seat = ${game.winnerSeat},
      finished_at = COALESCE(finished_at, ${game.finishedAt}), turn = ${game.turn}, round = ${game.round},
      updated_at = ${game.finishedAt}
      WHERE id = ${game.gameId}`,
    ...game.seats.map(
      (
        seat,
      ) => sql`UPDATE seats SET final_rank = ${seat.rank}, net_worth = ${seat.netWorth}, cash = ${seat.cash},
        bankrupt_at_turn = ${seat.bankruptAtTurn}, properties_bought = ${seat.propertiesBought},
        houses_built = ${seat.housesBuilt}, hotels_built = ${seat.hotelsBuilt}, mortgages = ${seat.mortgages},
        jail_turns = ${seat.jailTurns}
        WHERE game_id = ${game.gameId} AND seat = ${seat.seat}`,
    ),
    ...chunk(offerRows, Math.floor(D1_MAX_PARAMS / 15)).map(
      (rows) => sql`INSERT OR REPLACE INTO offers ${sql.insert(rows)}`,
    ),
    ...chunk(auctionRows, Math.floor(D1_MAX_PARAMS / 10)).map(
      (rows) => sql`INSERT OR REPLACE INTO auctions ${sql.insert(rows)}`,
    ),
  ]);
});
