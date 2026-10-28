/** Game configuration (SPEC §12 defaults). */
import { Effect, Schema } from "effect";

import { Count, Money, Seat } from "./common.ts";

const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

/** When the open table runs (SPEC §5.1). Same literals as `@mb/api` `TableFrequency`. */
export const TableFrequency = Schema.Literals(["everyRoll", "everyTurn", "everyRound", "off"]);

export type TableFrequency = typeof TableFrequency.Type;

/** Default rules; every `RulesConfig` key may be omitted when decoding. */
export const DEFAULT_RULES = {
  startingCash: 1500,
  goSalary: 200,
  jailFine: 50,
  houses: 32,
  hotels: 12,
  auctionMinOpening: 10,
  auctionMinRaise: 1,
  tableFrequency: "everyTurn",
  maxTableRounds: 6,
  maxOffersPerRound: 2,
  maxMessagesPerRound: 2,
  commentMaxChars: 280,
  notesMaxChars: 2000,
  maxRounds: 120,
  maxToolCallsPerWake: 24,
  maxInvalidPerWake: 6,
  wakeTimeoutMs: 180_000,
} as const;

const defaulted = <S extends Schema.Top & { readonly Encoded: S["Type"] }>(
  schema: S,
  value: S["Type"],
) => schema.pipe(Schema.withDecodingDefaultKey(Effect.succeed(value)));

/**
 * Rules and limits of one game. Engine rules come first; the last four keys are
 * host/agent limits kept here so that a game config is self-contained.
 */
export const RulesConfig = Schema.Struct({
  startingCash: defaulted(Money, DEFAULT_RULES.startingCash),
  goSalary: defaulted(Money, DEFAULT_RULES.goSalary),
  jailFine: defaulted(Money, DEFAULT_RULES.jailFine),
  houses: defaulted(Count, DEFAULT_RULES.houses),
  hotels: defaulted(Count, DEFAULT_RULES.hotels),
  auctionMinOpening: defaulted(PositiveInt, DEFAULT_RULES.auctionMinOpening),
  auctionMinRaise: defaulted(PositiveInt, DEFAULT_RULES.auctionMinRaise),
  tableFrequency: defaulted(TableFrequency, DEFAULT_RULES.tableFrequency),
  /** Rounds per session (Table and RaiseFunds). */
  maxTableRounds: defaulted(PositiveInt, DEFAULT_RULES.maxTableRounds),
  maxOffersPerRound: defaulted(Count, DEFAULT_RULES.maxOffersPerRound),
  maxMessagesPerRound: defaulted(Count, DEFAULT_RULES.maxMessagesPerRound),
  commentMaxChars: defaulted(PositiveInt, DEFAULT_RULES.commentMaxChars),
  notesMaxChars: defaulted(PositiveInt, DEFAULT_RULES.notesMaxChars),
  /** Turn cap in full rounds (SPEC §3.3). */
  maxRounds: defaulted(PositiveInt, DEFAULT_RULES.maxRounds),
  maxToolCallsPerWake: defaulted(PositiveInt, DEFAULT_RULES.maxToolCallsPerWake),
  maxInvalidPerWake: defaulted(PositiveInt, DEFAULT_RULES.maxInvalidPerWake),
  wakeTimeoutMs: defaulted(PositiveInt, DEFAULT_RULES.wakeTimeoutMs),
});

export type RulesConfig = typeof RulesConfig.Type;

/** One seat of a game: its letter, display label and leaderboard identity. */
export const SeatConfig = Schema.Struct({
  seat: Seat,
  label: Schema.String,
  /** `bot:<policy>` or the OpenRouter model id (see `@mb/api` `competitorId`). */
  competitorId: Schema.String,
});

export type SeatConfig = typeof SeatConfig.Type;

/**
 * Everything needed to start (and replay) a game. Seats must be distinct, in turn
 * order, 2 to 6 of them. The seed is secret from players: it fixes dice and decks.
 */
export const GameConfig = Schema.Struct({
  gameId: Schema.String,
  seed: Schema.String,
  seats: Schema.Array(SeatConfig).check(Schema.isMinLength(2), Schema.isMaxLength(6)),
  rules: RulesConfig,
});

export type GameConfig = typeof GameConfig.Type;

/** The default rules as a `RulesConfig` value. */
export const defaultRules = (): RulesConfig => ({ ...DEFAULT_RULES });

/** Builds a config with default rules overridden by `rules`. */
export const createConfig = (input: {
  readonly gameId: string;
  readonly seed: string;
  readonly seats: ReadonlyArray<SeatConfig>;
  readonly rules?: Partial<RulesConfig>;
}): GameConfig => ({
  gameId: input.gameId,
  seed: input.seed,
  seats: input.seats,
  rules: { ...defaultRules(), ...input.rules },
});
