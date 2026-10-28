/** Read models: standings, pending decisions, player and spectator views (SPEC §4.6). */
import { Schema } from "effect";

import { CommandKind, DraftCommand } from "./commands.ts";
import {
  Count,
  DeckId,
  Dice,
  FrameKind,
  GroupId,
  Money,
  Position,
  PropertyId,
  Seat,
  WakeReason,
} from "./common.ts";
import { RulesConfig } from "./config.ts";
import { Bank, Decks, Draft, EndReason, Frame, GameStatus, Offer, PropertyState } from "./state.ts";

/** Final or current ranking of one seat (SPEC §3.3). */
export const Standing = Schema.Struct({
  seat: Seat,
  rank: Schema.Int,
  /** Time-limit valuation: cash + deeds + buildings at purchase price. */
  netWorth: Money,
  cash: Money,
  bankrupt: Schema.Boolean,
  bankruptAtTurn: Schema.NullOr(Count),
});

export type Standing = typeof Standing.Type;

/** One seat that must act now. */
export const DecisionRequest = Schema.Struct({
  /** Id to echo in every command answering this request; stale ids are rejected. */
  decisionId: Schema.String,
  seat: Seat,
  frame: FrameKind,
  frameId: Count,
  /** Round of the frame (1 for single-actor frames). */
  round: Count,
  turn: Count,
  reasons: Schema.Array(WakeReason),
  /** Command kinds that are legal for this seat right now. */
  allowed: Schema.Array(CommandKind),
  /** Commands that end this wake (`Done`, `Buy`, `Bid`, ...). */
  terminal: Schema.Array(CommandKind),
  /** One-line English question. */
  question: Schema.String,
});

export type DecisionRequest = typeof DecisionRequest.Type;

export const Pending = Schema.TaggedUnion({
  /** Seats that must act; in a round all of them act simultaneously. */
  Waiting: { requests: Schema.Array(DecisionRequest) },
  Finished: {
    reason: Schema.NullOr(EndReason),
    winner: Schema.NullOr(Seat),
    standings: Schema.Array(Standing),
  },
});

export type Pending = typeof Pending.Type;

/** What everyone can see about a player. */
export const PublicPlayer = Schema.Struct({
  seat: Seat,
  label: Schema.String,
  competitorId: Schema.String,
  cash: Money,
  position: Position,
  inJail: Schema.Boolean,
  jailAttempts: Count,
  jailCards: Schema.Array(DeckId),
  bankrupt: Schema.Boolean,
  bankruptAtTurn: Schema.NullOr(Count),
  netWorth: Money,
});

export type PublicPlayer = typeof PublicPlayer.Type;

const tableFields = {
  gameId: Schema.String,
  status: GameStatus,
  endReason: Schema.NullOr(EndReason),
  winner: Schema.NullOr(Seat),
  rules: RulesConfig,
  turn: Count,
  gameRound: Count,
  activeSeat: Seat,
  players: Schema.Array(PublicPlayer),
  properties: Schema.Array(PropertyState),
  bank: Bank,
  lastDice: Schema.NullOr(Dice),
  /** Current (top) frame, or null when the game is over. */
  frame: Schema.NullOr(Frame),
  /** Kinds of all frames on the stack, bottom first. */
  stack: Schema.Array(FrameKind),
  /** Offers of the current session (open and closed). */
  offers: Schema.Array(Offer),
};

/** What one seat may see (never deck order or other seats' drafts). */
export const PlayerView = Schema.Struct({
  ...tableFields,
  seat: Seat,
  /** Effective follows of this seat (defaults plus explicit follows). */
  follows: Schema.Array(GroupId),
  /** This seat's drafts in the current round. */
  drafts: Schema.Array(DraftCommand),
  /** The pending request for this seat, if it must act. */
  request: Schema.NullOr(DecisionRequest),
});

export type PlayerView = typeof PlayerView.Type;

export const SeatFollows = Schema.Struct({ seat: Seat, follows: Schema.Array(GroupId) });

/** Everything, including private data, for spectators and the replay viewer. */
export const SpectatorView = Schema.Struct({
  ...tableFields,
  drafts: Schema.Array(Draft),
  follows: Schema.Array(SeatFollows),
  decks: Decks,
  pending: Pending,
  standings: Schema.Array(Standing),
});

export type SpectatorView = typeof SpectatorView.Type;

/** One step of an automatic liquidation (SPEC §6.5). */
export const LiquidationStep = Schema.Struct({
  action: Schema.Literals(["sellBuilding", "mortgage"]),
  property: PropertyId,
  proceeds: Money,
});

export type LiquidationStep = typeof LiquidationStep.Type;
