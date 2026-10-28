/**
 * The seam between GameDO and the game (SPEC.md §4.1, §4.4–4.6, §6). GameDO only talks to
 * these interfaces; `engine-binding.ts` binds them to `@mb/engine` (rules), `@mb/bots` (bot
 * seats) and `@mb/agent` (tools, prompts, wake messages). Tests may bind them to anything.
 */
import type { CommandTool, ToolArgs, WakeLimits } from "@mb/agent";
import type { BotPolicy, Seat } from "@mb/api";
import type { GameConfig } from "@mb/engine";
import type { Result, Schema } from "effect";

export type Json = Schema.Json;

/** SPEC §4.5: every event carries its sequence number and turn. */
export interface EngineEvent {
  readonly seq: number;
  readonly turn: number;
}

/** One seat that must act now (SPEC §4.2–4.3), with the id of the request it answers. */
export interface PendingDecision {
  readonly seat: Seat;
  readonly decisionId: string;
  /** Frame kind: "Table", "RaiseFunds", "JailChoice", "BuyChoice", "Auction", … */
  readonly frame: string;
  readonly round: number;
  /** Wake reasons (SPEC §5.3): "opening", "addressed", "inThread", "follows", … */
  readonly reasons: ReadonlyArray<string>;
}

export interface Pending {
  readonly turn: number;
  /** Game round: full rounds of turns started so far (SPEC §3.3 turn cap). */
  readonly round: number;
  readonly decisions: ReadonlyArray<PendingDecision>;
}

export type EndReason = "lastPlayerStanding" | "turnCap" | "aborted";

export interface SeatStanding {
  readonly seat: Seat;
  readonly rank: number;
  readonly netWorth: number;
  readonly cash: number;
  readonly bankruptAtTurn: number | null;
}

export interface Standings {
  readonly finished: boolean;
  readonly endReason: EndReason | null;
  readonly winner: Seat | null;
  readonly seats: ReadonlyArray<SeatStanding>;
}

export interface Applied<S, E> {
  readonly state: S;
  readonly events: ReadonlyArray<E>;
}

/** The pure rules engine. */
export interface GameEngine<S, E extends EngineEvent, C> {
  readonly version: string;
  readonly newGame: (config: GameConfig) => Applied<S, E>;
  /** `decide` + fold `evolve`; the error is the engine's `IllegalCommand` reason. */
  readonly apply: (state: S, command: C) => Result.Result<Applied<S, E>, string>;
  /** Folds stored events onto a snapshot (`evolve`). */
  readonly fold: (state: S, events: ReadonlyArray<E>) => S;
  readonly pending: (state: S) => Pending;
  /** Cheap staleness check: is `seat` still asked `decisionId`? */
  readonly isAwaiting: (state: S, seat: Seat, decisionId: string) => boolean;
  readonly spectatorView: (state: S) => Json;
  readonly digest: (
    events: ReadonlyArray<E>,
    sinceSeq: number,
    seat: Seat,
  ) => ReadonlyArray<string>;
  readonly visibleTo: (event: E, seat: Seat) => boolean;
  readonly standings: (state: S) => Standings;
  /** `TimeoutSeat{ seat, decisionId }`: the default action of SPEC §6.5. */
  readonly timeoutCommand: (seat: Seat, decisionId: string) => C;
  /** `AbortGame{ reason }`. */
  readonly abortCommand: (reason: string) => C;
}

/** JSON codec of the engine's schemas, for SQLite, R2 and the wire. */
export interface EngineCodec<S, E> {
  readonly encodeState: (state: S) => Json;
  readonly decodeState: (json: Json) => S;
  readonly encodeEvent: (event: E) => Json;
  readonly decodeEvent: (json: Json) => E;
  readonly encodeConfig: (config: GameConfig) => Json;
}

export interface OfferRecord {
  readonly offerId: string;
  readonly turn: number;
  readonly round: number;
  readonly from: Seat;
  readonly to: Seat | null;
  readonly give: Json;
  readonly get: Json;
  readonly replyTo: string | null;
  readonly comment: string | null;
  readonly status: "open" | "accepted" | "rejected" | "withdrawn" | "expired" | "invalidated";
  readonly acceptedBy: Seat | null;
}

export interface AuctionRecord {
  readonly auctionId: string;
  readonly turn: number;
  readonly kind: "property" | "building";
  /** Deed slug, or "house" / "hotel" for building auctions. */
  readonly property: string;
  readonly listPrice: number;
  readonly winner: Seat | null;
  readonly price: number | null;
  readonly bids: number;
}

export interface SeatCounters {
  readonly seat: Seat;
  readonly propertiesBought: number;
  readonly housesBuilt: number;
  readonly hotelsBuilt: number;
  readonly mortgages: number;
  readonly jailTurns: number;
}

/** Statistics rows derived from the event log (SPEC §7.3 `offers`, `auctions`, seat counters). */
export interface GameRecords {
  readonly offers: ReadonlyArray<OfferRecord>;
  readonly auctions: ReadonlyArray<AuctionRecord>;
  readonly counters: ReadonlyArray<SeatCounters>;
}

export interface SeatLimits extends WakeLimits {
  readonly notesMaxChars: number;
}

/** Everything seat-facing: tools → commands, bots, prompts, wake messages, statistics. */
export interface SeatAdapter<S, E, C> {
  readonly commandFromTool: <N extends CommandTool>(
    decision: PendingDecision,
    tool: N,
    args: ToolArgs<N>,
  ) => Result.Result<C, string>;
  /** The commands a bot submits for one wake, ending with an answering one. */
  readonly botCommands: (
    state: S,
    decision: PendingDecision,
    policy: BotPolicy,
  ) => ReadonlyArray<C>;
  readonly limits: (state: S) => SeatLimits;
  readonly systemPrompt: (state: S) => string;
  readonly wakeMessage: (
    state: S,
    decision: PendingDecision,
    digest: ReadonlyArray<string>,
    notes: string,
  ) => string;
  readonly inspect: (state: S, seat: Seat, args: ToolArgs<"inspect">) => string;
  /** What the model reads after one of its commands was accepted. */
  readonly outcome: (events: ReadonlyArray<E>, seat: Seat) => string;
  readonly records: (events: ReadonlyArray<E>) => GameRecords;
}

export interface EngineBinding<S, E extends EngineEvent, C> {
  readonly engine: GameEngine<S, E, C>;
  readonly codec: EngineCodec<S, E>;
  readonly seats: SeatAdapter<S, E, C>;
}
