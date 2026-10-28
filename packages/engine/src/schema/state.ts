/** Game state (SPEC §4.2). Plain JSON data: `replay(config, events)` rebuilds it exactly. */
import { Schema } from "effect";

import { DraftCommand, OfferId } from "./commands.ts";
import {
  Assets,
  BuildingKind,
  Count,
  DeckId,
  Dice,
  GroupId,
  Money,
  Party,
  Position,
  PropertyId,
  Seat,
  SeatReasons,
} from "./common.ts";
import { GameConfig } from "./config.ts";

/** Why money moves; shown in digests and statistics. */
export const PaymentReason = Schema.Literals([
  "salary",
  "rent",
  "tax",
  "card",
  "jailFine",
  "auction",
  "buildingAuction",
  "mortgageInterest",
]);

export type PaymentReason = typeof PaymentReason.Type;

/**
 * Engine work waiting behind an interactive frame (continuations). When a frame
 * closes, its `after` tasks run in order.
 */
export const Task = Schema.TaggedUnion({
  Pay: {
    from: Seat,
    to: Party,
    amount: Money,
    reason: PaymentReason,
    property: Schema.NullOr(PropertyId),
  },
  /** Move forward by `steps` with GO salary and landing resolution (leaving jail first). */
  MoveBy: { seat: Seat, steps: Schema.Int, fromJail: Schema.Boolean },
  AuctionDeed: { property: PropertyId },
  /** Ask `seat` to keep (10%) or pay off each received mortgaged deed. */
  ResolveMortgaged: { seat: Seat, properties: Schema.Array(PropertyId) },
});

export type Task = typeof Task.Type;

export const HighBid = Schema.Struct({ seat: Seat, amount: Money });

export type HighBid = typeof HighBid.Type;

export const SeatUnits = Schema.Struct({ seat: Seat, units: Count });

export type SeatUnits = typeof SeatUnits.Type;

export const BuildingCredit = Schema.Struct({ seat: Seat, kind: BuildingKind, units: Count });

export type BuildingCredit = typeof BuildingCredit.Type;

/** A round close that is waiting for building-shortage auctions (SPEC §4.3 step 4). */
export const TableClosing = Schema.Struct({
  contested: Schema.Array(BuildingKind),
  pending: Schema.Array(BuildingKind),
  credits: Schema.Array(BuildingCredit),
});

export type TableClosing = typeof TableClosing.Type;

/** `collecting`: awaited seats are acting; `closed`: drafts applied, next round not opened yet. */
export const RoundPhase = Schema.Literals(["collecting", "closed"]);

export type RoundPhase = typeof RoundPhase.Type;

const frameBase = { id: Count, after: Schema.Array(Task) };

const rounds = {
  round: Count,
  awaiting: Schema.Array(Seat),
  done: Schema.Array(Seat),
  reasons: Schema.Array(SeatReasons),
};

export const Frame = Schema.TaggedUnion({
  Table: {
    ...frameBase,
    ...rounds,
    phase: RoundPhase,
    nextWake: Schema.Array(SeatReasons),
    closing: Schema.NullOr(TableClosing),
  },
  RaiseFunds: {
    ...frameBase,
    ...rounds,
    phase: RoundPhase,
    nextWake: Schema.Array(SeatReasons),
    debtor: Seat,
    creditor: Party,
    amount: Money,
    reason: PaymentReason,
    property: Schema.NullOr(PropertyId),
    /** The debtor used a trade command in the round that just closed. */
    debtorActive: Schema.Boolean,
    /** The debtor timed out: liquidate automatically at round close. */
    liquidate: Schema.Boolean,
    /** The debtor declared bankruptcy. */
    declared: Schema.Boolean,
  },
  JailChoice: { ...frameBase, seat: Seat },
  BuyChoice: { ...frameBase, seat: Seat, property: PropertyId },
  Auction: {
    ...frameBase,
    ...rounds,
    property: PropertyId,
    /** Bidders still in the auction. */
    active: Schema.Array(Seat),
    high: Schema.NullOr(HighBid),
  },
  BuildingAuction: {
    ...frameBase,
    ...rounds,
    table: Count,
    kind: BuildingKind,
    unitsLeft: Count,
    demand: Schema.Array(SeatUnits),
    credits: Schema.Array(SeatUnits),
    active: Schema.Array(Seat),
    high: Schema.NullOr(HighBid),
  },
  MortgagedTransfer: { ...frameBase, seat: Seat, properties: Schema.Array(PropertyId) },
});

export type Frame = typeof Frame.Type;

export type FrameOf<K extends Frame["_tag"]> = Extract<Frame, { readonly _tag: K }>;

export const OfferStatus = Schema.Literals([
  "open",
  "accepted",
  "rejected",
  "withdrawn",
  "invalidated",
]);

export type OfferStatus = typeof OfferStatus.Type;

export const ThreadMessage = Schema.Struct({ seat: Seat, text: Schema.String, round: Count });

export type ThreadMessage = typeof ThreadMessage.Type;

/** A posted offer. Offers live for the session they were posted in. */
export const Offer = Schema.Struct({
  id: OfferId,
  /** Frame id of the session (Table or RaiseFunds). */
  session: Count,
  from: Seat,
  to: Schema.NullOr(Seat),
  give: Assets,
  get: Assets,
  comment: Schema.NullOr(Schema.String),
  replyTo: Schema.NullOr(OfferId),
  /** Id of the first offer of the thread. */
  thread: OfferId,
  /** Session round in which it was posted. */
  round: Count,
  status: OfferStatus,
  rejectedBy: Schema.Array(Seat),
  messages: Schema.Array(ThreadMessage),
});

export type Offer = typeof Offer.Type;

/** A command stored privately until its round closes. */
export const Draft = Schema.Struct({
  frame: Count,
  round: Count,
  seat: Seat,
  command: DraftCommand,
});

export type Draft = typeof Draft.Type;

export const Bankruptcy = Schema.Struct({ turn: Count, order: Count, creditor: Party });

export type Bankruptcy = typeof Bankruptcy.Type;

export const PlayerState = Schema.Struct({
  seat: Seat,
  label: Schema.String,
  competitorId: Schema.String,
  cash: Money,
  position: Position,
  inJail: Schema.Boolean,
  /** Failed attempts to roll doubles during the current jail stay (0–2). */
  jailAttempts: Count,
  /** Get Out of Jail Free cards held, by deck of origin. */
  jailCards: Schema.Array(DeckId),
  bankrupt: Schema.Boolean,
  bankruptcy: Schema.NullOr(Bankruptcy),
  /** Explicit follows (private). */
  followed: Schema.Array(GroupId),
  /** Explicit unfollows of default follows (private). */
  unfollowed: Schema.Array(GroupId),
});

export type PlayerState = typeof PlayerState.Type;

/** Ownership and development of one deed. `level`: 0–4 houses, 5 = hotel. */
export const PropertyState = Schema.Struct({
  id: PropertyId,
  owner: Schema.NullOr(Seat),
  mortgaged: Schema.Boolean,
  level: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 5 })),
});

export type PropertyState = typeof PropertyState.Type;

export const Bank = Schema.Struct({ houses: Count, hotels: Count });

export type Bank = typeof Bank.Type;

/** Card order of each deck, top first, as indexes in the printed deck. */
export const Decks = Schema.Struct({
  chance: Schema.Array(Count),
  communityChest: Schema.Array(Count),
});

export type Decks = typeof Decks.Type;

export const Control = Schema.Struct({
  /** Turn number, 1-based; a doubles re-roll stays in the same turn. */
  turn: Count,
  /** Full round number (SPEC §3.3 turn cap). */
  gameRound: Count,
  activeSeat: Seat,
  /** Consecutive doubles in this turn. */
  doubles: Count,
  /** The table of the current roll step has been opened (or skipped). */
  tableOpened: Schema.Boolean,
  /** The active player has rolled in the current roll step. */
  rolled: Schema.Boolean,
  /** The active player rolls again after the current roll resolves. */
  extraRoll: Schema.Boolean,
  /** This turn is the first one of its full round. */
  newRound: Schema.Boolean,
  /** Frames, bottom first; the last one decides who must act. */
  stack: Schema.Array(Frame),
});

export type Control = typeof Control.Type;

export const GameStatus = Schema.Literals(["setup", "playing", "finished"]);

export type GameStatus = typeof GameStatus.Type;

export const EndReason = Schema.Literals(["lastPlayerStanding", "turnCap", "aborted"]);

export type EndReason = typeof EndReason.Type;

export const Rng = Schema.Struct({ key: Schema.Int, counter: Count });

export type Rng = typeof Rng.Type;

export const GameState = Schema.Struct({
  config: GameConfig,
  /** Sequence number of the last event applied. */
  seq: Count,
  rng: Rng,
  status: GameStatus,
  endReason: Schema.NullOr(EndReason),
  winner: Schema.NullOr(Seat),
  players: Schema.Array(PlayerState),
  properties: Schema.Array(PropertyState),
  bank: Bank,
  decks: Decks,
  control: Control,
  offers: Schema.Array(Offer),
  drafts: Schema.Array(Draft),
  lastDice: Schema.NullOr(Dice),
  nextFrameId: Count,
  nextOfferId: Count,
  bankruptcies: Count,
});

export type GameState = typeof GameState.Type;
