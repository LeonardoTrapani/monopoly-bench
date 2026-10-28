/**
 * Pure rule helpers (SPEC §3.1): rent, building and selling evenly, mortgages and
 * valuations. They work on any value exposing deeds, players and the bank, so the
 * same helpers serve `GameState` and `PlayerView` (bots use them on views).
 */
import { groupMembers, propertyInfo } from "./data/board.ts";

import type { DeckId, GroupId, PropertyId, Seat } from "./schema/common.ts";
import type { Bank, PropertyState } from "./schema/state.ts";

/** The public part of a player that the rules need. */
export interface HolderInfo {
  readonly seat: Seat;
  readonly cash: number;
  readonly bankrupt: boolean;
  readonly jailCards: ReadonlyArray<DeckId>;
}

/** Deeds, players and bank: satisfied by `GameState`, `PlayerView` and `SpectatorView`. */
export interface Holdings {
  readonly properties: ReadonlyArray<PropertyState>;
  readonly players: ReadonlyArray<HolderInfo>;
  readonly bank: Bank;
}

export const HOTEL_LEVEL = 5;

/** Houses standing on a deed at `level` (a hotel stands alone). */
export const housesAt = (level: number): number => (level >= HOTEL_LEVEL ? 0 : level);

export const hotelsAt = (level: number): number => (level >= HOTEL_LEVEL ? 1 : 0);

const stateOf = (holdings: Holdings, id: PropertyId): PropertyState => {
  const found = holdings.properties[propertyInfo(id).index];

  if (found === undefined) throw new Error(`Unknown property ${id}`);

  return found;
};

export const holderOf = (holdings: Holdings, seat: Seat): HolderInfo | undefined =>
  holdings.players.find((candidate) => candidate.seat === seat);

export const cashOf = (holdings: Holdings, seat: Seat): number =>
  holderOf(holdings, seat)?.cash ?? 0;

export const deedsOf = (holdings: Holdings, seat: Seat): ReadonlyArray<PropertyState> =>
  holdings.properties.filter((property) => property.owner === seat);

/** Whether `seat` owns every deed of `group` (mortgaged ones count). */
export const ownsGroup = (holdings: Holdings, seat: Seat, group: GroupId): boolean =>
  groupMembers(group).every((id) => stateOf(holdings, id).owner === seat);

export const countOwnedInGroup = (holdings: Holdings, seat: Seat, group: GroupId): number =>
  groupMembers(group).filter((id) => stateOf(holdings, id).owner === seat).length;

export const groupLevels = (holdings: Holdings, group: GroupId): ReadonlyArray<number> =>
  groupMembers(group).map((id) => stateOf(holdings, id).level);

export const groupHasBuildings = (holdings: Holdings, group: GroupId): boolean =>
  groupMembers(group).some((id) => stateOf(holdings, id).level > 0);

export const groupHasMortgage = (holdings: Holdings, group: GroupId): boolean =>
  groupMembers(group).some((id) => stateOf(holdings, id).mortgaged);

/** Card multipliers that change the rent owed on arrival. */
export type RentModifier = "none" | "railroadTwice" | "utilityTenTimes";

/**
 * Rent owed for landing on `id` with `diceTotal`: streets per title deed (doubled
 * when unimproved in a complete set, even with a mortgaged sibling), railroads
 * 25/50/100/200, utilities 4×/10× dice. Mortgaged deeds earn nothing.
 */
export const rentFor = (
  holdings: Holdings,
  id: PropertyId,
  diceTotal: number,
  modifier: RentModifier,
): number => {
  const property = stateOf(holdings, id);
  const info = propertyInfo(id);
  const owner = property.owner;

  if (owner === null || property.mortgaged) return 0;

  if (info.kind === "street") {
    const base = info.rents[property.level] ?? 0;

    return property.level === 0 && ownsGroup(holdings, owner, info.group) ? base * 2 : base;
  }

  const owned = countOwnedInGroup(holdings, owner, info.group);

  if (info.kind === "railroad") {
    const rent = info.rents[owned - 1] ?? 0;

    return modifier === "railroadTwice" ? rent * 2 : rent;
  }

  const multiplier = modifier === "utilityTenTimes" ? 10 : (info.rents[owned - 1] ?? 0);

  return multiplier * diceTotal;
};

/** Unmortgage price: mortgage value + 10%, rounded up to the dollar. */
export const unmortgageCost = (id: PropertyId): number =>
  Math.ceil((propertyInfo(id).mortgage * 11) / 10);

/** Interest due when receiving a mortgaged deed and keeping the mortgage (10%, rounded up). */
export const mortgageInterest = (id: PropertyId): number =>
  Math.ceil(propertyInfo(id).mortgage / 10);

/** Reason `seat` may not build one level on `id`, or null when it may. */
export const buildProblem = (holdings: Holdings, seat: Seat, id: PropertyId): string | null => {
  const info = propertyInfo(id);
  const property = stateOf(holdings, id);

  if (info.kind !== "street") return `${info.name} is not a street`;

  if (property.owner !== seat) return `you do not own ${info.name}`;

  if (!ownsGroup(holdings, seat, info.group)) return `you do not own the whole color set`;

  if (groupHasMortgage(holdings, info.group)) return `a street of the set is mortgaged`;

  if (property.level >= HOTEL_LEVEL) return `${info.name} already has a hotel`;

  if (property.level > Math.min(...groupLevels(holdings, info.group))) {
    return `build evenly: other streets of the set need a building first`;
  }

  if (property.level === 4 && holdings.bank.hotels < 1) return `the bank has no hotels left`;

  if (property.level < 4 && holdings.bank.houses < 1) return `the bank has no houses left`;

  if (cashOf(holdings, seat) < info.houseCost) return `not enough cash ($${info.houseCost})`;

  return null;
};

/** Reason `seat` may not sell one building level on `id`, or null when it may. */
export const sellProblem = (holdings: Holdings, seat: Seat, id: PropertyId): string | null => {
  const info = propertyInfo(id);
  const property = stateOf(holdings, id);

  if (property.owner !== seat) return `you do not own ${info.name}`;

  if (property.level === 0) return `${info.name} has no buildings`;

  if (property.level < Math.max(...groupLevels(holdings, info.group))) {
    return `sell evenly: sell from the most built street of the set first`;
  }

  return null;
};

export const mortgageProblem = (holdings: Holdings, seat: Seat, id: PropertyId): string | null => {
  const info = propertyInfo(id);
  const property = stateOf(holdings, id);

  if (property.owner !== seat) return `you do not own ${info.name}`;

  if (property.mortgaged) return `${info.name} is already mortgaged`;

  if (groupHasBuildings(holdings, info.group)) return `sell the buildings of the set first`;

  return null;
};

export const unmortgageProblem = (
  holdings: Holdings,
  seat: Seat,
  id: PropertyId,
): string | null => {
  const info = propertyInfo(id);
  const property = stateOf(holdings, id);

  if (property.owner !== seat) return `you do not own ${info.name}`;

  if (!property.mortgaged) return `${info.name} is not mortgaged`;

  if (cashOf(holdings, seat) < unmortgageCost(id)) {
    return `not enough cash ($${unmortgageCost(id)})`;
  }

  return null;
};

/** Reason `seat` may not trade `id` (must own it, no buildings in its set). */
export const tradeProblem = (holdings: Holdings, seat: Seat, id: PropertyId): string | null => {
  const info = propertyInfo(id);

  if (stateOf(holdings, id).owner !== seat) return `${seat} does not own ${info.name}`;

  if (groupHasBuildings(holdings, info.group)) {
    return `${info.name} has buildings in its color set`;
  }

  return null;
};

/** One building level change produced by a sale. */
export interface LevelChange {
  readonly property: PropertyId;
  readonly from: number;
  readonly to: number;
  readonly proceeds: number;
}

/**
 * Level changes for selling one level on `id`. Selling a hotel takes 4 houses from
 * the bank; when the bank has fewer, the street drops to what the bank can supply and
 * siblings are reduced to keep building even. Every level removed pays half the
 * house cost.
 */
export const sellChanges = (holdings: Holdings, id: PropertyId): ReadonlyArray<LevelChange> => {
  const info = propertyInfo(id);
  const half = info.houseCost / 2;
  const members = groupMembers(info.group);
  const levels = new Map(members.map((member) => [member, stateOf(holdings, member).level]));
  const changes: Array<LevelChange> = [];
  let bankHouses = holdings.bank.houses;

  const lower = (member: PropertyId) => {
    const from = levels.get(member) ?? 0;
    const to = from >= HOTEL_LEVEL ? Math.min(4, bankHouses) : from - 1;

    bankHouses += housesAt(from) - housesAt(to);
    levels.set(member, to);
    changes.push({ property: member, from, to, proceeds: half * (from - to) });
  };

  lower(id);

  for (;;) {
    const values = members.map((member) => levels.get(member) ?? 0);
    const highest = Math.max(...values);

    if (highest - Math.min(...values) <= 1) break;

    const tallest = members.find((member) => levels.get(member) === highest);

    if (tallest === undefined) break;

    lower(tallest);
  }

  return changes;
};

/** Building value at purchase price (a hotel counts as 5 houses). */
export const buildingCost = (id: PropertyId, level: number): number =>
  propertyInfo(id).houseCost * level;

/**
 * Net worth of the classic time-limit game (SPEC §3.3): cash + printed price of
 * unmortgaged deeds + mortgage value of mortgaged deeds + buildings at purchase price.
 */
export const netWorth = (holdings: Holdings, seat: Seat): number => {
  let total = cashOf(holdings, seat);

  for (const property of holdings.properties) {
    if (property.owner !== seat) continue;

    const info = propertyInfo(property.id);

    total += property.mortgaged ? info.mortgage : info.price;
    total += buildingCost(property.id, property.level);
  }

  return total;
};

/**
 * Cash a seat could raise from the bank alone: cash + mortgage value of unmortgaged
 * deeds + half the value of its buildings (SPEC §5.5 bid limit).
 */
export const liquidationValue = (holdings: Holdings, seat: Seat): number => {
  let total = cashOf(holdings, seat);

  for (const property of holdings.properties) {
    if (property.owner !== seat) continue;

    const info = propertyInfo(property.id);

    if (!property.mortgaged) total += info.mortgage;

    total += (info.houseCost / 2) * property.level;
  }

  return total;
};

export interface BuildingCount {
  readonly houses: number;
  readonly hotels: number;
}

/** Houses and hotels owned by `seat` (for repair cards). */
export const buildingsOf = (holdings: Holdings, seat: Seat): BuildingCount => {
  let houses = 0;
  let hotels = 0;

  for (const property of holdings.properties) {
    if (property.owner !== seat) continue;

    houses += housesAt(property.level);
    hotels += hotelsAt(property.level);
  }

  return { houses, hotels };
};
