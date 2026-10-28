/** Which command kinds each frame accepts from each role (SPEC §4.4, §5.2). */
import type { CommandKind, DraftCommand, SeatCommand } from "./schema/commands.ts";

export const TABLE_KINDS: ReadonlyArray<CommandKind> = [
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
];

export const DEBTOR_KINDS: ReadonlyArray<CommandKind> = [
  "SellBuilding",
  "Mortgage",
  "Offer",
  "Accept",
  "Reject",
  "Withdraw",
  "Message",
  "Follow",
  "Unfollow",
  "DeclareBankruptcy",
  "Done",
];

export const CREDITOR_SIDE_KINDS: ReadonlyArray<CommandKind> = [
  "Offer",
  "Accept",
  "Reject",
  "Withdraw",
  "Message",
  "Follow",
  "Unfollow",
  "Done",
];

export const JAIL_KINDS: ReadonlyArray<CommandKind> = [
  "PayJailFine",
  "UseJailCard",
  "RollForDoubles",
];

export const BUY_KINDS: ReadonlyArray<CommandKind> = [
  "Buy",
  "Decline",
  "Build",
  "SellBuilding",
  "Mortgage",
];

export const BID_KINDS: ReadonlyArray<CommandKind> = ["Bid", "PassBid"];

export const MORTGAGED_KINDS: ReadonlyArray<CommandKind> = ["KeepMortgage", "PayOffMortgage"];

const DRAFT_KINDS: ReadonlyArray<CommandKind> = [
  "Build",
  "SellBuilding",
  "Mortgage",
  "Unmortgage",
  "Offer",
  "Accept",
  "Reject",
  "Withdraw",
  "Message",
  "Bid",
  "PassBid",
];

export const isDraftCommand = (value: SeatCommand): value is DraftCommand =>
  DRAFT_KINDS.includes(value._tag);
