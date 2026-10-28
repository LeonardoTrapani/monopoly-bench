/**
 * Game events (SPEC §4.5). Every event has `seq`, `turn` and `visibility`, and carries
 * every random outcome, so `evolve` is a pure fold and the viewer can rebuild every
 * screen from events alone.
 */
import { Schema } from "effect";

import { DraftCommand, OfferId } from "./commands.ts";
import {
  Assets,
  BuildingKind,
  Count,
  DeckId,
  Dice,
  FrameKind,
  GroupId,
  Money,
  Party,
  Position,
  PropertyId,
  Seat,
  SeatReasons,
  Visibility,
} from "./common.ts";
import { SeatConfig } from "./config.ts";
import { EndReason, Frame, HighBid, Offer, PaymentReason, SeatUnits } from "./state.ts";
import { Standing } from "./views.ts";

const meta = { seq: Count, turn: Count, visibility: Visibility };

export const SeatBid = Schema.Struct({ seat: Seat, amount: Schema.NullOr(Money) });

export type SeatBid = typeof SeatBid.Type;

/** A building level change on one street (0–4 houses, 5 = hotel). */
export const LevelChange = Schema.Struct({ property: PropertyId, from: Count, to: Count });

export type LevelChange = typeof LevelChange.Type;

export const GameEvent = Schema.TaggedUnion({
  GameStarted: { ...meta, gameId: Schema.String, seats: Schema.Array(SeatConfig) },
  /** Initial deck order; visible to spectators only. */
  DecksShuffled: {
    ...meta,
    chance: Schema.Array(Count),
    communityChest: Schema.Array(Count),
    rng: Count,
  },
  TurnStarted: { ...meta, seat: Seat, gameRound: Count, newRound: Schema.Boolean },
  /** Doubles: the same player starts another roll step. */
  RolledAgain: { ...meta, seat: Seat, doubles: Count },
  FramePushed: { ...meta, frame: Frame },
  FramePopped: { ...meta, frameId: Count },
  RoundOpened: {
    ...meta,
    frameId: Count,
    round: Count,
    awaiting: Schema.Array(Seat),
    reasons: Schema.Array(SeatReasons),
  },
  /** A private draft; revealed by its effects when the round closes. */
  DraftAdded: { ...meta, frameId: Count, round: Count, seat: Seat, command: DraftCommand },
  SeatDone: {
    ...meta,
    frameId: Count,
    round: Count,
    seat: Seat,
    via: Schema.Literals(["done", "timeout", "bid", "declareBankruptcy"]),
  },
  /** The host applied the default action for a seat (SPEC §6.5). */
  SeatTimedOut: { ...meta, seat: Seat, decisionId: Schema.String, frame: FrameKind },
  RoundClosed: {
    ...meta,
    frameId: Count,
    round: Count,
    nextWake: Schema.Array(SeatReasons),
    debtorActive: Schema.Boolean,
  },
  /** Building shortage at round close: scarce kinds go to building auctions first. */
  TableClosing: { ...meta, frameId: Count, contested: Schema.Array(BuildingKind) },
  ActionDropped: {
    ...meta,
    frameId: Count,
    seat: Seat,
    command: DraftCommand,
    reason: Schema.String,
  },
  /** Private to the seat. */
  FollowChanged: { ...meta, seat: Seat, group: GroupId, following: Schema.Boolean },
  DiceRolled: {
    ...meta,
    seat: Seat,
    dice: Dice,
    purpose: Schema.Literals(["move", "jail", "utility"]),
    rng: Count,
  },
  Moved: {
    ...meta,
    seat: Seat,
    from: Position,
    to: Position,
    passedGo: Schema.Boolean,
    via: Schema.Literals(["roll", "card"]),
  },
  Paid: {
    ...meta,
    from: Party,
    to: Party,
    amount: Money,
    reason: PaymentReason,
    property: Schema.NullOr(PropertyId),
  },
  SentToJail: {
    ...meta,
    seat: Seat,
    reason: Schema.Literals(["goToJail", "card", "threeDoubles"]),
  },
  LeftJail: {
    ...meta,
    seat: Seat,
    via: Schema.Literals(["fine", "card", "doubles", "forcedFine"]),
  },
  JailRollFailed: { ...meta, seat: Seat, attempts: Count },
  CardDrawn: { ...meta, seat: Seat, deck: DeckId, card: Count, kept: Schema.Boolean },
  JailCardUsed: { ...meta, seat: Seat, deck: DeckId },
  PropertyBought: { ...meta, seat: Seat, property: PropertyId, price: Money },
  PurchaseDeclined: { ...meta, seat: Seat, property: PropertyId },
  AuctionRoundClosed: {
    ...meta,
    frameId: Count,
    round: Count,
    bids: Schema.Array(SeatBid),
    high: Schema.NullOr(HighBid),
    active: Schema.Array(Seat),
  },
  AuctionEnded: {
    ...meta,
    frameId: Count,
    property: PropertyId,
    winner: Schema.NullOr(Seat),
    amount: Money,
  },
  /** A building auction starts bidding on its next scarce unit. */
  BuildingUnitOpened: { ...meta, frameId: Count, active: Schema.Array(Seat) },
  BuildingUnitAuctioned: {
    ...meta,
    frameId: Count,
    kind: BuildingKind,
    winner: Schema.NullOr(Seat),
    premium: Money,
  },
  /** Scarce units handed out without bidding (demand no longer exceeds supply). */
  BuildingUnitsGranted: { ...meta, frameId: Count, grants: Schema.Array(SeatUnits) },
  BuildingCreditsSettled: {
    ...meta,
    table: Count,
    kind: BuildingKind,
    credits: Schema.Array(SeatUnits),
  },
  BuildingBuilt: { ...meta, seat: Seat, property: PropertyId, level: Count, cost: Money },
  /**
   * One sale of a building level on `property`. Selling a hotel when the bank lacks
   * houses also lowers siblings; `changes` lists every level change, applied at once.
   */
  BuildingSold: {
    ...meta,
    seat: Seat,
    property: PropertyId,
    changes: Schema.Array(LevelChange),
    proceeds: Money,
  },
  PropertyMortgaged: { ...meta, seat: Seat, property: PropertyId, amount: Money },
  PropertyUnmortgaged: { ...meta, seat: Seat, property: PropertyId, amount: Money },
  MortgagedDeedDecided: {
    ...meta,
    frameId: Count,
    seat: Seat,
    property: PropertyId,
    choice: Schema.Literals(["keep", "payOff"]),
  },
  OfferPosted: { ...meta, offer: Offer },
  OfferRejected: {
    ...meta,
    offerId: OfferId,
    seat: Seat,
    comment: Schema.NullOr(Schema.String),
  },
  OfferWithdrawn: { ...meta, offerId: OfferId, seat: Seat },
  OfferMessage: { ...meta, offerId: OfferId, seat: Seat, text: Schema.String, round: Count },
  TradeExecuted: { ...meta, offerId: OfferId, from: Seat, to: Seat, give: Assets, get: Assets },
  /** An acceptance failed re-validation at round close. */
  OfferInvalidated: {
    ...meta,
    offerId: OfferId,
    seat: Seat,
    reason: Schema.String,
    /** The offer itself can no longer be accepted by anyone. */
    closed: Schema.Boolean,
  },
  OffersExpired: { ...meta, session: Count, offerIds: Schema.Array(OfferId) },
  PlayerBankrupt: { ...meta, seat: Seat, creditor: Party },
  AssetsTransferred: {
    ...meta,
    from: Seat,
    to: Seat,
    cash: Money,
    properties: Schema.Array(PropertyId),
    jailCards: Schema.Array(DeckId),
  },
  AssetsSurrendered: {
    ...meta,
    seat: Seat,
    cash: Money,
    properties: Schema.Array(PropertyId),
    jailCards: Schema.Array(DeckId),
  },
  GameEnded: {
    ...meta,
    reason: EndReason,
    winner: Schema.NullOr(Seat),
    standings: Schema.Array(Standing),
  },
});

export type GameEvent = typeof GameEvent.Type;

export type EventKind = GameEvent["_tag"];

export type EventOf<K extends EventKind> = Extract<GameEvent, { readonly _tag: K }>;

/** Event payload without the tag and the common `seq` / `turn` / `visibility` fields. */
export type EventInput<K extends EventKind> = Omit<
  EventOf<K>,
  "_tag" | "seq" | "turn" | "visibility"
>;

export const PUBLIC: Visibility = "public";

/** Visible to `seats` only (and to spectators). */
export const privateTo = (...seats: ReadonlyArray<Seat>): Visibility => ({ seats });

/**
 * Fast unchecked constructor used by the engine on its hot path. Values are checked
 * by the type system; decode with the `GameEvent` schema at I/O boundaries.
 */
export interface EventMeta {
  readonly seq: number;
  readonly turn: number;
  readonly visibility: Visibility;
}

export const gameEvent = <K extends EventKind>(
  tag: K,
  meta: EventMeta,
  input: EventInput<K>,
): EventOf<K> => {
  const value = {
    _tag: tag,
    seq: meta.seq,
    turn: meta.turn,
    visibility: meta.visibility,
    ...input,
  };

  // SAFETY: `input` is variant `K` minus its tag and common fields, which are added back here.
  return value as EventOf<K>;
};

/** JSON codec for one event (encode for `.jsonl` lines, decode when reading them). */
export const GameEventJson = Schema.fromJsonString(GameEvent);
