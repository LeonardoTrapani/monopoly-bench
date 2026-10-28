/** Small read helpers over `GameState` shared by the engine modules. */
import { GROUP_IDS } from "./data/ids.ts";
import { propertyIndex, propertyInfo } from "./data/board.ts";

import type { GroupId, PropertyId, Seat } from "./schema/common.ts";
import type { Frame, FrameOf, GameState, PlayerState, PropertyState } from "./schema/state.ts";

export const player = (state: GameState, seat: Seat): PlayerState => {
  const found = state.players.find((candidate) => candidate.seat === seat);

  if (found === undefined) throw new Error(`Seat ${seat} is not in this game`);

  return found;
};

export const hasSeat = (state: GameState, seat: Seat): boolean =>
  state.players.some((candidate) => candidate.seat === seat);

export const deed = (
  holdings: { readonly properties: ReadonlyArray<PropertyState> },
  id: PropertyId,
): PropertyState => {
  const found = holdings.properties[propertyIndex(id)];

  if (found === undefined) throw new Error(`Unknown property ${id}`);

  return found;
};

/** Seats still in the game, in seat (turn) order. */
export const activeSeats = (state: GameState): ReadonlyArray<Seat> =>
  state.players.flatMap((candidate) => (candidate.bankrupt ? [] : [candidate.seat]));

/** Active seats in turn order starting from `first` (included when active). */
export const turnOrderFrom = (state: GameState, first: Seat): ReadonlyArray<Seat> => {
  const seats = state.players.map((candidate) => candidate.seat);
  const start = Math.max(0, seats.indexOf(first));
  const ordered: Array<Seat> = [];

  for (let offset = 0; offset < seats.length; offset += 1) {
    const candidate = state.players[(start + offset) % seats.length];

    if (candidate !== undefined && !candidate.bankrupt) ordered.push(candidate.seat);
  }

  return ordered;
};

/** Fixed order of SPEC §4.3: from the active player, in turn order. */
export const fixedOrder = (state: GameState): ReadonlyArray<Seat> =>
  turnOrderFrom(state, state.control.activeSeat);

export const sortByFixedOrder = (
  state: GameState,
  seats: ReadonlyArray<Seat>,
): ReadonlyArray<Seat> => fixedOrder(state).filter((seat) => seats.includes(seat));

export const topFrame = (state: GameState): Frame | undefined =>
  state.control.stack[state.control.stack.length - 1];

export const isFrameKind = <K extends Frame["_tag"]>(frame: Frame, kind: K): frame is FrameOf<K> =>
  frame._tag === kind;

export const findFrame = (state: GameState, frameId: number): Frame | undefined =>
  state.control.stack.find((frame) => frame.id === frameId);

/** Groups where `seat` owns at least one deed (the default follows of SPEC §5.3). */
export const ownedGroups = (state: GameState, seat: Seat): ReadonlyArray<GroupId> => {
  const groups = new Set<GroupId>();

  for (const property of state.properties) {
    if (property.owner === seat) groups.add(propertyInfo(property.id).group);
  }

  return GROUP_IDS.filter((group) => groups.has(group));
};

/** Default follows minus explicit unfollows plus explicit follows, in group order. */
export const effectiveFollows = (state: GameState, seat: Seat): ReadonlyArray<GroupId> => {
  const current = player(state, seat);
  const owned = ownedGroups(state, seat);

  return GROUP_IDS.filter(
    (group) =>
      current.followed.includes(group) ||
      (owned.includes(group) && !current.unfollowed.includes(group)),
  );
};

export const without = <T>(items: ReadonlyArray<T>, item: T): ReadonlyArray<T> =>
  items.filter((candidate) => candidate !== item);

export const withItem = <T>(items: ReadonlyArray<T>, item: T): ReadonlyArray<T> =>
  items.includes(item) ? items : [...items, item];
