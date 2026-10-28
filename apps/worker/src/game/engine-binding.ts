/**
 * The real game behind GameDO: `@mb/engine` for the rules, `@mb/bots` for bot seats, and
 * `@mb/agent` for everything LLM seats see (tools → commands, system prompt, wake message,
 * inspect, outcomes).
 */
import {
  buildSystemPrompt,
  commandFromTool,
  inspectText,
  outcomeText,
  renderWakeMessage,
  wakeLimitsOf,
} from "@mb/agent";
import type { BotPolicy } from "@mb/api";
import { type Bot, createBot } from "@mb/bots";
import {
  apply,
  Assets,
  type Command,
  command,
  decisionIdOf,
  digest,
  ENGINE_VERSION,
  evolve,
  GameConfig,
  GameEvent,
  GameState,
  newGame,
  Pending,
  pending,
  playerView,
  propertyInfo,
  requestOf,
  type Seat,
  SpectatorView,
  spectatorView,
  standings,
  visibleTo,
} from "@mb/engine";
import { Result, Schema } from "effect";

import type {
  AuctionRecord,
  EngineBinding,
  GameRecords,
  OfferRecord,
  PendingDecision,
  SeatCounters,
} from "./engine.ts";

const encodeAssets = Schema.encodeSync(Assets);

const encodeSpectatorView = Schema.encodeSync(SpectatorView);

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const bots = new Map<string, Bot>();

/** Bots are deterministic per game seed and seat (`<seed>:<seat>`, as in `@mb/sim`). */
const botFor = (seed: string, seat: Seat, policy: BotPolicy): Bot => {
  const key = `${policy}:${seed}:${seat}`;
  const existing = bots.get(key);

  if (existing !== undefined) return existing;

  const created = createBot(policy, `${seed}:${seat}`);
  bots.set(key, created);

  return created;
};

const counters = (seats: Map<Seat, Mutable<SeatCounters>>, seat: Seat): Mutable<SeatCounters> => {
  const existing = seats.get(seat);

  if (existing !== undefined) return existing;

  const created = {
    seat,
    propertiesBought: 0,
    housesBuilt: 0,
    hotelsBuilt: 0,
    mortgages: 0,
    jailTurns: 0,
  };

  seats.set(seat, created);

  return created;
};

/** Offers, auctions and per-seat counters from a game's event log. */
export const recordsFrom = (events: ReadonlyArray<GameEvent>): GameRecords => {
  const offers = new Map<number, Mutable<OfferRecord> & { readonly maker: Seat }>();
  const auctions: Array<AuctionRecord> = [];
  const bids = new Map<number, number>();
  const seats = new Map<Seat, Mutable<SeatCounters>>();

  const take = (frameId: number): number => {
    const count = bids.get(frameId) ?? 0;
    bids.set(frameId, 0);

    return count;
  };

  for (const event of events) {
    if (GameEvent.guards.OfferPosted(event)) {
      const offer = event.offer;
      offers.set(offer.id, {
        maker: offer.from,
        offerId: String(offer.id),
        turn: event.turn,
        round: offer.round,
        from: offer.from,
        to: offer.to,
        give: encodeAssets(offer.give),
        get: encodeAssets(offer.get),
        replyTo: offer.replyTo === null ? null : String(offer.replyTo),
        comment: offer.comment,
        status: "open",
        acceptedBy: null,
      });
    } else if (GameEvent.guards.TradeExecuted(event)) {
      const offer = offers.get(event.offerId);

      if (offer !== undefined) {
        offer.status = "accepted";
        offer.acceptedBy = event.from === offer.maker ? event.to : event.from;
      }
    } else if (GameEvent.guards.OfferRejected(event)) {
      const offer = offers.get(event.offerId);

      if (offer !== undefined && offer.to !== null) offer.status = "rejected";
    } else if (GameEvent.guards.OfferWithdrawn(event)) {
      const offer = offers.get(event.offerId);

      if (offer !== undefined) offer.status = "withdrawn";
    } else if (GameEvent.guards.OfferInvalidated(event)) {
      const offer = offers.get(event.offerId);

      if (offer !== undefined && event.closed && offer.status === "open")
        offer.status = "invalidated";
    } else if (GameEvent.guards.OffersExpired(event)) {
      for (const id of event.offerIds) {
        const offer = offers.get(id);

        if (offer !== undefined && offer.status === "open") offer.status = "expired";
      }
    } else if (GameEvent.guards.AuctionRoundClosed(event)) {
      const placed = event.bids.filter((bid) => bid.amount !== null).length;
      bids.set(event.frameId, (bids.get(event.frameId) ?? 0) + placed);
    } else if (GameEvent.guards.AuctionEnded(event)) {
      auctions.push({
        auctionId: `deed-${event.frameId}`,
        turn: event.turn,
        kind: "property",
        property: event.property,
        listPrice: propertyInfo(event.property).price,
        winner: event.winner,
        price: event.winner === null ? null : event.amount,
        bids: take(event.frameId),
      });
    } else if (GameEvent.guards.BuildingUnitAuctioned(event)) {
      auctions.push({
        auctionId: `building-${event.frameId}-${event.seq}`,
        turn: event.turn,
        kind: "building",
        property: event.kind,
        listPrice: 0,
        winner: event.winner,
        price: event.winner === null ? null : event.premium,
        bids: take(event.frameId),
      });
    } else if (GameEvent.guards.PropertyBought(event)) {
      counters(seats, event.seat).propertiesBought += 1;
    } else if (GameEvent.guards.BuildingBuilt(event)) {
      const seat = counters(seats, event.seat);

      if (event.level >= 5) seat.hotelsBuilt += 1;
      else seat.housesBuilt += 1;
    } else if (GameEvent.guards.PropertyMortgaged(event)) {
      counters(seats, event.seat).mortgages += 1;
    } else if (GameEvent.guards.JailRollFailed(event) || GameEvent.guards.LeftJail(event)) {
      counters(seats, event.seat).jailTurns += 1;
    }
  }

  return {
    offers: [...offers.values()].map(({ maker: _maker, ...offer }) => offer),
    auctions,
    counters: [...seats.values()],
  };
};

const toDecision = (request: {
  readonly seat: Seat;
  readonly decisionId: string;
  readonly frame: string;
  readonly frameId: number;
  readonly round: number;
  readonly reasons: ReadonlyArray<string>;
}): PendingDecision => ({
  seat: request.seat,
  decisionId: request.decisionId,
  frame: request.frame,
  round: request.round,
  reasons: request.reasons,
  // Rounds of one frame (a table, an auction, a debt) form one session.
  sessionKey: `frame-${request.frameId}`,
});

const requestFor = (state: GameState, decision: PendingDecision) => {
  const request = requestOf(state, decision.seat);

  if (request === null || request.decisionId !== decision.decisionId) {
    throw new Error(`Seat ${decision.seat} is not asked ${decision.decisionId}`);
  }

  return request;
};

export const engineBinding: EngineBinding<GameState, GameEvent, Command> = {
  engine: {
    version: ENGINE_VERSION,
    newGame: (config) => newGame(config),
    apply: (state, next) => Result.mapError(apply(state, next), (problem) => problem.reason),
    fold: (state, events) => {
      let current = state;

      for (const event of events) current = evolve(current, event);

      return current;
    },
    pending: (state) =>
      Pending.match(pending(state), {
        Waiting: (waiting) => ({
          turn: state.control.turn,
          round: waiting.requests[0]?.round ?? 0,
          decisions: waiting.requests.map(toDecision),
        }),
        Finished: () => ({ turn: state.control.turn, round: 0, decisions: [] }),
      }),
    isAwaiting: (state, seat, decisionId) => decisionIdOf(state, seat) === decisionId,
    spectatorView: (state) => encodeSpectatorView(spectatorView(state)),
    digest: (events, sinceSeq, seat) => digest(events, sinceSeq, seat),
    visibleTo: (event, seat) => visibleTo(event, seat),
    standings: (state) => ({
      finished: state.status === "finished",
      endReason: state.endReason,
      winner: state.winner,
      seats: standings(state).map((standing) => ({
        seat: standing.seat,
        rank: standing.rank,
        netWorth: standing.netWorth,
        cash: standing.cash,
        bankruptAtTurn: standing.bankruptAtTurn,
      })),
    }),
    timeoutCommand: (seat, decisionId) => command("TimeoutSeat", { seat, decisionId }),
    abortCommand: (reason) => command("AbortGame", { reason }),
  },
  codec: {
    encodeState: Schema.encodeSync(GameState),
    decodeState: Schema.decodeUnknownSync(GameState),
    encodeEvent: Schema.encodeSync(GameEvent),
    decodeEvent: Schema.decodeUnknownSync(GameEvent),
    encodeConfig: Schema.encodeSync(GameConfig),
  },
  seats: {
    commandFromTool: (decision, tool, args) =>
      commandFromTool({ seat: decision.seat, decisionId: decision.decisionId }, tool, args),
    botCommands: (state, decision, policy) => {
      const request = requestOf(state, decision.seat);

      if (request === null || request.decisionId !== decision.decisionId) return [];

      return botFor(
        state.config.seed,
        decision.seat,
        policy,
      )(playerView(state, decision.seat), request);
    },
    limits: (state) => ({
      ...wakeLimitsOf(state.config.rules),
      notesMaxChars: state.config.rules.notesMaxChars,
    }),
    systemPrompt: (state) => buildSystemPrompt(state.config.rules, state.config.seats.length),
    wakeMessage: (state, decision, lines, notes) =>
      renderWakeMessage({
        view: playerView(state, decision.seat),
        request: requestFor(state, decision),
        digest: lines,
        notes,
      }),
    inspect: (state, seat, args) => inspectText(playerView(state, seat), args),
    outcome: (events, seat) => outcomeText(events, seat),
    records: recordsFrom,
  },
};
