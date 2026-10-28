/**
 * The seam between GameDO and the rules engine (SPEC.md §4.1, §4.4–4.6).
 *
 * GameDO only talks to these interfaces. Phase 1 binds them to a placeholder dice game
 * (`stub-engine.ts`); phase 2 binds them to `@mb/engine` (rules), `@mb/bots` (bot seats) and
 * the view renderers of `@mb/agent`, without touching GameDO. See apps/worker/README.md.
 */
import type { ToolArgs, ToolName } from "@mb/agent";
import type { BotPolicy, Seat, TableFrequency } from "@mb/api";
import type { Result, Schema } from "effect";

export type Json = Schema.Json;

export interface EngineGameConfig {
  readonly seed: string;
  /** Seat letters in turn order. */
  readonly seats: ReadonlyArray<Seat>;
  readonly maxRounds: number;
  readonly tableFrequency: TableFrequency;
}

/** SPEC §4.5: every event carries its sequence number and turn. */
export interface EngineEvent {
  readonly seq: number;
  readonly turn: number;
}

/** One seat that must act now (SPEC §4.2–4.3), with the id of the request it answers. */
export interface PendingDecision {
  readonly seat: Seat;
  readonly decisionId: string;
  /** Frame name: "Table", "JailChoice", "BuyChoice", "Auction", "BuildingAuction", "RaiseFunds", "MortgagedTransfer". */
  readonly frame: string;
  readonly round: number;
  /** Wake reasons (SPEC §5.3): "round1", "addressed", "inThread", "follows", "openCall", "debtor", … */
  readonly reasons: ReadonlyArray<string>;
  /** Shared by the rounds of one session; the agent conversation continues while it is equal. */
  readonly sessionKey: string;
  /** Legal command kinds for this seat, as tool names. */
  readonly legal: ReadonlyArray<ToolName>;
}

export interface Pending {
  readonly turn: number;
  readonly round: number;
  readonly decisions: ReadonlyArray<PendingDecision>;
}

export type EndReason = "lastPlayerStanding" | "turnCap" | "aborted";

export interface SeatStanding {
  readonly seat: Seat;
  /** 1 = winner; null while the game runs or when it was aborted. */
  readonly rank: number | null;
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

/** The pure rules engine: `@mb/engine` in phase 2. */
export interface GameEngine<S, E extends EngineEvent, C> {
  readonly version: string;
  readonly newGame: (config: EngineGameConfig) => Applied<S, E>;
  /** `decide` + fold `evolve`; the error is the engine's reason, shown to the model. */
  readonly apply: (state: S, command: C) => Result.Result<Applied<S, E>, string>;
  readonly pending: (state: S) => Pending;
  readonly playerView: (state: S, seat: Seat) => Json;
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

/** JSON codec of the engine's Effect schemas, for SQLite, R2 and the wire. */
export interface EngineCodec<S, E> {
  readonly encodeState: (state: S) => Json;
  readonly decodeState: (json: Json) => S;
  readonly encodeEvent: (event: E) => Json;
  readonly decodeEvent: (json: Json) => E;
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

/** Text for the wake message of one decision (SPEC §6.2); the agent package assembles it. */
export interface WakeContext {
  readonly view: string;
  readonly question: string;
  readonly offers: string;
}

/**
 * Glue between the engine, bots and the agent tools. Phase 2: commands from tool arguments
 * (with the engine's command schemas), `@mb/bots` policies, and the agent's view renderers.
 */
export interface SeatAdapter<S, E, C> {
  readonly commandFromTool: <N extends ToolName>(
    state: S,
    decision: PendingDecision,
    tool: N,
    args: ToolArgs<N>,
  ) => Result.Result<C, string>;
  readonly botCommand: (state: S, decision: PendingDecision, policy: BotPolicy) => C;
  readonly wakeContext: (state: S, decision: PendingDecision) => WakeContext;
  readonly inspect: (state: S, seat: Seat, args: ToolArgs<"inspect">) => string;
  readonly records: (state: S, events: ReadonlyArray<E>) => GameRecords;
}

export interface EngineBinding<S, E extends EngineEvent, C> {
  readonly engine: GameEngine<S, E, C>;
  readonly codec: EngineCodec<S, E>;
  readonly seats: SeatAdapter<S, E, C>;
}
