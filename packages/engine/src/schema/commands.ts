/** Commands (SPEC §4.4). Every seat command carries `seat` and `decisionId`. */
import { Schema } from "effect";

import { Assets, Count, GroupId, Money, PropertyId, Seat } from "./common.ts";

export const OfferId = Count;

export type OfferId = typeof OfferId.Type;

const answer = { seat: Seat, decisionId: Schema.String };

export const Command = Schema.TaggedUnion({
  /** Build one house, or the hotel on a street with 4 houses. */
  Build: { ...answer, property: PropertyId },
  /** Sell one building level back to the bank at half price. */
  SellBuilding: { ...answer, property: PropertyId },
  Mortgage: { ...answer, property: PropertyId },
  Unmortgage: { ...answer, property: PropertyId },
  /** Two-party offer; `to` omitted is an open offer any other seat may accept. */
  Offer: {
    ...answer,
    to: Schema.optionalKey(Seat),
    give: Assets,
    get: Assets,
    comment: Schema.optionalKey(Schema.String),
    replyTo: Schema.optionalKey(OfferId),
  },
  Accept: { ...answer, offerId: OfferId },
  Reject: { ...answer, offerId: OfferId, comment: Schema.optionalKey(Schema.String) },
  Withdraw: { ...answer, offerId: OfferId },
  /** A comment in an offer's thread; carries no terms. */
  Message: { ...answer, offerId: OfferId, text: Schema.String },
  Follow: { ...answer, group: GroupId },
  Unfollow: { ...answer, group: GroupId },
  /** Ends the seat's round in a session. */
  Done: answer,
  PayJailFine: answer,
  UseJailCard: answer,
  RollForDoubles: answer,
  Buy: answer,
  Decline: answer,
  Bid: { ...answer, amount: Money },
  PassBid: answer,
  KeepMortgage: { ...answer, property: PropertyId },
  PayOffMortgage: { ...answer, property: PropertyId },
  DeclareBankruptcy: answer,
  /** Host only: applies the default action for `seat` (SPEC §6.5). */
  TimeoutSeat: answer,
  /** Host only: ends the game immediately. */
  AbortGame: { reason: Schema.String },
});

export type Command = typeof Command.Type;

export type CommandKind = Command["_tag"];

export const CommandKind = Schema.Literals([
  "Build",
  "SellBuilding",
  "Mortgage",
  "Unmortgage",
  "Offer",
  "Accept",
  "Reject",
  "Withdraw",
  "Message",
  "Follow",
  "Unfollow",
  "Done",
  "PayJailFine",
  "UseJailCard",
  "RollForDoubles",
  "Buy",
  "Decline",
  "Bid",
  "PassBid",
  "KeepMortgage",
  "PayOffMortgage",
  "DeclareBankruptcy",
  "TimeoutSeat",
  "AbortGame",
]);

/** Commands stored as private drafts until their round closes (SPEC §4.3). */
export const DraftCommand = Schema.Union([
  Command.cases.Build,
  Command.cases.SellBuilding,
  Command.cases.Mortgage,
  Command.cases.Unmortgage,
  Command.cases.Offer,
  Command.cases.Accept,
  Command.cases.Reject,
  Command.cases.Withdraw,
  Command.cases.Message,
  Command.cases.Bid,
  Command.cases.PassBid,
]).pipe(Schema.toTaggedUnion("_tag"));

export type DraftCommand = typeof DraftCommand.Type;

export type SeatCommand = Exclude<Command, { readonly _tag: "AbortGame" }>;

export type CommandOf<K extends CommandKind> = Extract<Command, { readonly _tag: K }>;

type CommandInput<K extends CommandKind> = Omit<Extract<Command, { readonly _tag: K }>, "_tag">;

/**
 * Fast unchecked constructor for commands. Values are checked by the type system;
 * decode with the `Command` schema at I/O boundaries.
 */
export const command = <K extends CommandKind>(
  tag: K,
  input: CommandInput<K>,
): Extract<Command, { readonly _tag: K }> => {
  const value = { _tag: tag, ...input };

  // SAFETY: `input` is exactly the variant `K` without its tag, so adding `_tag: K` rebuilds it.
  return value as Extract<Command, { readonly _tag: K }>;
};

export const IllegalCommand = Schema.TaggedStruct("IllegalCommand", {
  command: Schema.String,
  reason: Schema.String,
});

export type IllegalCommand = typeof IllegalCommand.Type;

/** Builds an `IllegalCommand` failure value. */
export const illegal = (kind: string, reason: string): IllegalCommand =>
  IllegalCommand.make({ command: kind, reason }, { disableChecks: true });
