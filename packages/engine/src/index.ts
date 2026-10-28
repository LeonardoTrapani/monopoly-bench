/**
 * `@mb/engine`: the pure Monopoly rules engine of monopoly-bench (SPEC §3–§5).
 *
 * Decider pattern: `newGame(config)` starts a game, `decide(state, command)` turns a
 * command into events (including every automatic step up to the next decision),
 * `evolve(state, event)` folds one event, `apply` does both, `replay(config, events)`
 * rebuilds a state from a log. `pending(state)` says who must act; `playerView` /
 * `spectatorView` are the read models; `digest` renders events as English lines.
 *
 * No I/O, no clocks, no `Math.random`: randomness is counter-based from the seed and
 * every random outcome is carried by events. All payloads are Effect Schemas
 * (JSON-serializable, decode/encode-able).
 */

export const ENGINE_VERSION = "1.0.0";

// Data -----------------------------------------------------------------------

export {
  BOARD_SIZE,
  GO_POSITION,
  GROUP_NAMES,
  groupMembers,
  INCOME_TAX,
  JAIL_POSITION,
  LUXURY_TAX,
  PROPERTIES,
  propertyInfo,
  Space,
  SPACES,
  spaceAt,
  spaceName,
} from "./data/board.ts";

export type { PropertyInfo, PropertyKind } from "./data/board.ts";

export {
  CardEffect,
  cardAt,
  CHANCE_CARDS,
  COMMUNITY_CHEST_CARDS,
  DECK_NAMES,
  DECK_SIZE,
} from "./data/cards.ts";

export type { Card } from "./data/cards.ts";

export { DECKS, GROUP_IDS, PROPERTY_IDS, SEATS } from "./data/ids.ts";

// Schemas ----------------------------------------------------------------------

export {
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
  WakeReason,
} from "./schema/common.ts";

export {
  createConfig,
  DEFAULT_RULES,
  defaultRules,
  GameConfig,
  RulesConfig,
  SeatConfig,
  TableFrequency,
} from "./schema/config.ts";

export {
  Command,
  command,
  CommandKind,
  DraftCommand,
  IllegalCommand,
  OfferId,
} from "./schema/commands.ts";

export type { CommandOf, SeatCommand } from "./schema/commands.ts";

export { GameEvent, GameEventJson, privateTo, PUBLIC, SeatBid } from "./schema/events.ts";

export type { EventKind, EventOf } from "./schema/events.ts";

export {
  Bank,
  Control,
  Decks,
  Draft,
  EndReason,
  Frame,
  GameState,
  GameStatus,
  HighBid,
  Offer,
  OfferStatus,
  PaymentReason,
  PlayerState,
  PropertyState,
  Task,
} from "./schema/state.ts";

export type { FrameOf } from "./schema/state.ts";

export {
  DecisionRequest,
  LiquidationStep,
  Pending,
  PlayerView,
  PublicPlayer,
  SpectatorView,
  Standing,
} from "./schema/views.ts";

// Decider ----------------------------------------------------------------------

/**
 * `newGame(config)`: initial events and state, up to the first decision.
 * `decide(state, command)`: `Result` of the events caused by `command`, or `IllegalCommand`.
 * `apply(state, command)`: `decide` plus the folded state.
 * `replay(config, events)`: the state after folding `events` from the initial state.
 * `initialState(config)`: the state before the first event (what `replay` folds from).
 */
export { apply, decide, initialState, newGame, replay } from "./game.ts";

export type { Applied, Started } from "./game.ts";

/** `evolve(state, event)`: folds one event; pure, total, deterministic. */
export { evolve } from "./evolve.ts";

// Read models ------------------------------------------------------------------

/** `pending(state)`: who must act now (with legal kinds and a question), or the final standings. */
export { decisionIdOf, pending, pendingSeats, requestOf } from "./pending.ts";

/** `playerView(state, seat)` / `spectatorView(state)`: what a seat / a spectator may see. */
export { playerView, spectatorView } from "./views.ts";

/** `digest(events, sinceSeq, viewer)`: English lines for a wake message; `visibleTo(event, viewer)`. */
export { assetsText, describeEvent, digest, visibleTo } from "./digest.ts";

export type { Viewer } from "./digest.ts";

/** `standings(state)`: ranking with the time-limit valuation of SPEC §3.3. */
export { standings } from "./standings.ts";

/** `defaultCommand` / `timeoutCommand`: SPEC §6.5 defaults; `autoLiquidate`: the liquidation plan. */
export { autoLiquidate, defaultCommand, timeoutCommand } from "./defaults.ts";

/** `checkInvariants(state)`: broken invariants of SPEC §4.1 (empty when sound). */
export { checkInvariants } from "./invariants.ts";

// Rules ------------------------------------------------------------------------

/**
 * Pure rule helpers usable on `GameState` and on `PlayerView` (bots use them):
 * rent, legality of building / selling / mortgaging / trading, valuations.
 */
export {
  buildProblem,
  buildingsOf,
  cashOf,
  countOwnedInGroup,
  deedsOf,
  groupHasBuildings,
  groupHasMortgage,
  liquidationValue,
  mortgageInterest,
  mortgageProblem,
  netWorth,
  ownsGroup,
  rentFor,
  sellProblem,
  tradeProblem,
  unmortgageCost,
  unmortgageProblem,
} from "./rules.ts";

export type { Holdings, HolderInfo, RentModifier } from "./rules.ts";

/** Counter-based RNG used by the engine (exposed for deterministic bots). */
export { hashString, rngAt, rngInt } from "./rng.ts";

/** Effective follows of a seat (default follows plus explicit ones). */
export { effectiveFollows } from "./access.ts";
