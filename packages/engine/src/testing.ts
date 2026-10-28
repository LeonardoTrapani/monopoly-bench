/**
 * Test helpers: scenario builders over plain `GameState` values and dice control
 * through the counter-based RNG. Exported for the engine's own tests and for other
 * packages' tests (`@mb/engine/testing` is not part of the runtime API).
 */
import { Predicate, Result } from "effect";

import { SEATS } from "./data/ids.ts";
import { propertyInfo } from "./data/board.ts";
import { apply, newGame } from "./game.ts";
import { decisionIdOf } from "./pending.ts";
import { rollDie } from "./rng.ts";
import { command } from "./schema/commands.ts";
import { createConfig } from "./schema/config.ts";

import type { Command, CommandKind, CommandOf } from "./schema/commands.ts";
import type { PropertyId, Seat } from "./schema/common.ts";
import type { GameConfig, RulesConfig } from "./schema/config.ts";
import type { EventKind, EventOf, GameEvent } from "./schema/events.ts";
import type { Frame, GameState, PlayerState, PropertyState } from "./schema/state.ts";

export const testConfig = (players = 2, rules: Partial<RulesConfig> = {}): GameConfig =>
  createConfig({
    gameId: "test",
    seed: "unit",
    seats: SEATS.slice(0, players).map((seat) => ({
      seat,
      label: `Player ${seat}`,
      competitorId: `test:${seat}`,
    })),
    rules: { tableFrequency: "everyTurn", ...rules },
  });

/** A new game: turn 1, A to play, the table of round 1 open for everyone. */
export const startGame = (players = 2, rules: Partial<RulesConfig> = {}): GameState =>
  newGame(testConfig(players, rules)).state;

export const withPlayer = (
  state: GameState,
  seat: Seat,
  changes: Partial<PlayerState>,
): GameState => ({
  ...state,
  players: state.players.map((current) =>
    current.seat === seat ? { ...current, ...changes } : current,
  ),
});

export const withDeeds = (
  state: GameState,
  ids: ReadonlyArray<PropertyId>,
  changes: Partial<PropertyState>,
): GameState => ({
  ...state,
  properties: state.properties.map((property) =>
    ids.includes(property.id) ? { ...property, ...changes } : property,
  ),
});

/** Gives deeds to `seat` (unmortgaged, unbuilt unless `changes` say otherwise). */
export const own = (
  state: GameState,
  seat: Seat,
  ids: ReadonlyArray<PropertyId>,
  changes: Partial<PropertyState> = {},
): GameState => withDeeds(state, ids, { owner: seat, mortgaged: false, level: 0, ...changes });

/** Sets building levels and keeps the bank supply consistent. */
export const build = (state: GameState, levels: ReadonlyArray<readonly [PropertyId, number]>) => {
  let next = state;

  for (const [id, level] of levels) {
    const before = next.properties[propertyInfo(id).index]?.level ?? 0;
    const houses = (value: number) => (value >= 5 ? 0 : value);
    const hotels = (value: number) => (value >= 5 ? 1 : 0);

    next = {
      ...withDeeds(next, [id], { level }),
      bank: {
        houses: next.bank.houses + houses(before) - houses(level),
        hotels: next.bank.hotels + hotels(before) - hotels(level),
      },
    };
  }

  return next;
};

/** Replaces the frame stack (frames get the ids they carry). */
export const withStack = (state: GameState, stack: ReadonlyArray<Frame>): GameState => ({
  ...state,
  control: { ...state.control, stack },
  drafts: [],
  nextFrameId: Math.max(state.nextFrameId, ...stack.map((frame) => frame.id + 1)),
});

/** First RNG counter whose next dice are `rolls` (pairs, consecutive). */
export const counterFor = (
  key: number,
  rolls: ReadonlyArray<readonly [number, number]>,
): number => {
  for (let counter = 0; counter < 2_000_000; counter += 1) {
    const matches = rolls.every(
      ([first, second], index) =>
        rollDie(key, counter + index * 2) === first &&
        rollDie(key, counter + index * 2 + 1) === second,
    );

    if (matches) return counter;
  }

  throw new Error("No counter found for the requested dice");
};

/** Makes the next dice rolls of the game equal to `rolls`. */
export const withDice = (
  state: GameState,
  ...rolls: ReadonlyArray<readonly [number, number]>
): GameState => ({
  ...state,
  rng: { key: state.rng.key, counter: counterFor(state.rng.key, rolls) },
});

/** Puts `card` (index in the printed deck) on top of `deck`. */
export const topCard = (
  state: GameState,
  deck: "chance" | "communityChest",
  card: number,
): GameState => {
  const order = state.decks[deck];
  const rest = order.filter((value) => value !== card);

  return { ...state, decks: { ...state.decks, [deck]: [card, ...rest] } };
};

/** A command from `seat` answering its pending decision. */
export const answerFor = <K extends Exclude<CommandKind, "AbortGame">>(
  state: GameState,
  seat: Seat,
  kind: K,
  extra: Omit<CommandOf<K>, "_tag" | "seat" | "decisionId">,
): CommandOf<K> => {
  const decisionId = decisionIdOf(state, seat);

  if (decisionId === null) throw new Error(`Seat ${seat} has no pending decision`);

  // SAFETY: `extra` holds exactly the fields of variant `K` other than seat and decisionId.
  return command(kind, { seat, decisionId, ...extra } as Omit<CommandOf<K>, "_tag">);
};

export interface Step {
  readonly state: GameState;
  readonly events: ReadonlyArray<GameEvent>;
}

/** Applies commands in order; throws on the first illegal one. */
export const play = (state: GameState, ...commands: ReadonlyArray<Command>): Step => {
  let current = state;
  const events: Array<GameEvent> = [];

  for (const next of commands) {
    const result = apply(current, next);

    if (Result.isFailure(result)) {
      throw new Error(`${next._tag} rejected: ${result.failure.reason}`);
    }

    current = result.success.state;
    events.push(...result.success.events);
  }

  return { state: current, events };
};

/** The reason an illegal command is rejected (throws when it is accepted). */
export const rejection = (state: GameState, next: Command): string => {
  const result = apply(state, next);

  if (Result.isSuccess(result)) throw new Error(`${next._tag} was accepted`);

  return result.failure.reason;
};

/** Every seat still awaited answers `Done`, in turn. */
export const allDone = (state: GameState): Step => {
  let current = state;
  const events: Array<GameEvent> = [];

  for (const seat of SEATS) {
    if (decisionIdOf(current, seat) === null) continue;

    const step = play(current, answerFor(current, seat, "Done", {}));

    current = step.state;
    events.push(...step.events);
  }

  return { state: current, events };
};

/** A table frame at round 1 awaiting only `seat` (to reach the roll of the active player). */
export const onlyAtTable = (state: GameState, seat: Seat): GameState => {
  const table = state.control.stack.find((frame) => Predicate.isTagged(frame, "Table"));

  if (table === undefined || !Predicate.isTagged(table, "Table")) {
    throw new Error("No table frame to restrict");
  }

  return withStack(state, [
    { ...table, awaiting: [seat], done: [], reasons: [{ seat, reasons: ["opening"] }] },
  ]);
};

/** Ends A's opening table with the next dice set to `rolls`: the roll happens at once. */
export const rollFromTable = (
  state: GameState,
  ...rolls: ReadonlyArray<readonly [number, number]>
): Step => {
  const seat = state.control.activeSeat;
  const ready = withDice(onlyAtTable(state, seat), ...rolls);

  return play(ready, answerFor(ready, seat, "Done", {}));
};

export const eventsOf = <K extends EventKind>(
  events: ReadonlyArray<GameEvent>,
  kind: K,
): ReadonlyArray<EventOf<K>> =>
  events.flatMap((event) => {
    if (event._tag !== kind) return [];

    // SAFETY: the tag was just compared with `kind`, which selects variant `EventOf<K>`.
    return [event as EventOf<K>];
  });

export const tags = (events: ReadonlyArray<GameEvent>): ReadonlyArray<string> =>
  events.map((event) => event._tag);

export const cash = (state: GameState, seat: Seat): number =>
  state.players.find((current) => current.seat === seat)?.cash ?? 0;

export const ownerOf = (state: GameState, id: PropertyId): Seat | null =>
  state.properties[propertyInfo(id).index]?.owner ?? null;

export const levelOf = (state: GameState, id: PropertyId): number =>
  state.properties[propertyInfo(id).index]?.level ?? 0;

export const topKind = (state: GameState): string | undefined =>
  state.control.stack[state.control.stack.length - 1]?._tag;
