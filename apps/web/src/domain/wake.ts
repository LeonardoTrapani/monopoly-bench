/** Human text for wake reasons (SPEC §5.3) and decision frames (§4.2). */
import { FrameKind, type WakeReason } from "@mb/engine";
import { Option, Schema } from "effect";

/** `[reason, short label, explanation]` for every wake reason. */
export const WAKE_REASON_TEXT: ReadonlyArray<readonly [WakeReason, string, string]> = [
  ["opening", "Opening", "Round 1 of a session wakes every active seat."],
  [
    "addressed",
    "Addressed",
    "An offer, counter-offer, rejection or message was addressed to the seat.",
  ],
  [
    "inThread",
    "In thread",
    "A new offer was posted in a negotiation thread the seat takes part in.",
  ],
  [
    "follows",
    "Follows",
    "A new offer involves a color group the seat follows (by default, groups where it owns a deed).",
  ],
  ["openCall", "Open call", "Someone posted an open offer that any seat may accept."],
  [
    "debtor",
    "Debtor",
    "The seat owes money and must raise funds; woken every round while the debt is open.",
  ],
  ["bidder", "Bidder", "An auction round: everyone still in who is not leading bids again."],
  ["active", "Active", "A decision only this seat can take (buy, jail, mortgaged deeds)."],
];

export const wakeReasonLabel = (reason: WakeReason): string =>
  WAKE_REASON_TEXT.find(([candidate]) => candidate === reason)?.[1] ?? reason;

export const wakeReasonDescription = (reason: WakeReason): string =>
  WAKE_REASON_TEXT.find(([candidate]) => candidate === reason)?.[2] ?? "";

const FRAME_TEXT: Readonly<Record<FrameKind, string>> = {
  Table: "Open table",
  RaiseFunds: "Raising funds",
  JailChoice: "Jail choice",
  BuyChoice: "Buy or auction",
  Auction: "Auction",
  BuildingAuction: "Building auction",
  MortgagedTransfer: "Mortgaged deeds",
};

export const frameLabel = (frame: FrameKind): string => FRAME_TEXT[frame];

/** Frame name of a decision id or transcript frame string; unknown strings pass through. */
export const frameLabelOf = (frame: string): string =>
  Option.match(decodeFrameKind(frame), { onSome: frameLabel, onNone: () => frame });

const decodeFrameKind = Schema.decodeUnknownOption(FrameKind);
