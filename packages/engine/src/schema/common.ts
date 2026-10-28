/** Schemas shared by config, commands, events, state and views. */
import { Schema } from "effect";

import { DECKS, GROUP_IDS, PROPERTY_IDS, SEATS } from "../data/ids.ts";

/** Seat letter; seat order is the turn order. Same literals as `@mb/api` `Seat`. */
export const Seat = Schema.Literals(SEATS);

export type Seat = typeof Seat.Type;

/** An ownable deed (street, railroad or utility), as a kebab-case slug. */
export const PropertyId = Schema.Literals(PROPERTY_IDS);

export type PropertyId = typeof PropertyId.Type;

/** A color group, or `railroads` / `utilities`. */
export const GroupId = Schema.Literals(GROUP_IDS);

export type GroupId = typeof GroupId.Type;

export const DeckId = Schema.Literals(DECKS);

export type DeckId = typeof DeckId.Type;

/** Whole dollars, never negative. */
export const Money = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export type Money = typeof Money.Type;

/** A non-negative counter (turns, rounds, sequence numbers, ids). */
export const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export type Count = typeof Count.Type;

/** Board position, 0 (GO) to 39 (Boardwalk). */
export const Position = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 39 }));

export type Position = typeof Position.Type;

export const Die = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 6 }));

export const Dice = Schema.Tuple([Die, Die]);

export type Dice = typeof Dice.Type;

/** A player or the bank, as the two ends of a payment. */
export const Party = Schema.Union([Seat, Schema.Literal("bank")]);

export type Party = typeof Party.Type;

/** Kind of scarce building unit. */
export const BuildingKind = Schema.Literals(["house", "hotel"]);

export type BuildingKind = typeof BuildingKind.Type;

/** One side of a trade: `{ cash, properties[], jailCards }` (SPEC §4.4). */
export const Assets = Schema.Struct({
  cash: Money,
  properties: Schema.Array(PropertyId),
  jailCards: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2 })),
});

export type Assets = typeof Assets.Type;

/** Who can see an event: everyone, or only the listed seats (spectators see everything). */
export const Visibility = Schema.Union([
  Schema.Literal("public"),
  Schema.Struct({ seats: Schema.Array(Seat) }),
]);

export type Visibility = typeof Visibility.Type;

/** Kinds of control frames (SPEC §4.2); also the `frame` of a decision request. */
export const FrameKind = Schema.Literals([
  "Table",
  "RaiseFunds",
  "JailChoice",
  "BuyChoice",
  "Auction",
  "BuildingAuction",
  "MortgagedTransfer",
]);

export type FrameKind = typeof FrameKind.Type;

/**
 * Why a seat was woken for a round (SPEC §5.3). `opening` is round 1 of a session,
 * `bidder` an auction round, `active` a single-actor decision.
 */
export const WakeReason = Schema.Literals([
  "opening",
  "addressed",
  "inThread",
  "follows",
  "openCall",
  "debtor",
  "bidder",
  "active",
]);

export type WakeReason = typeof WakeReason.Type;

export const SeatReasons = Schema.Struct({ seat: Seat, reasons: Schema.Array(WakeReason) });

export type SeatReasons = typeof SeatReasons.Type;
