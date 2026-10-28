/**
 * US Standard Edition board and title deeds (Hasbro C1009). This file is the
 * authority for every number on the board (SPEC §3.1, §3.2).
 */
import { Schema } from "effect";

import { Money, Position, PropertyId } from "../schema/common.ts";
import { GROUP_IDS, PROPERTY_IDS } from "./ids.ts";

import type { GroupId as Group, PropertyId as Deed } from "./ids.ts";

export type PropertyKind = "street" | "railroad" | "utility";

/** Printed data of one title deed. */
export interface PropertyInfo {
  readonly id: Deed;
  /** Index in board order among the 28 deeds (also the index in `GameState.properties`). */
  readonly index: number;
  readonly position: number;
  readonly name: string;
  readonly kind: PropertyKind;
  readonly group: Group;
  readonly price: number;
  readonly mortgage: number;
  /**
   * Streets: `[base, 1 house, 2, 3, 4, hotel]`. Railroads: rent by number owned
   * `[1, 2, 3, 4]`. Utilities: dice multiplier by number owned `[1, 2]`.
   */
  readonly rents: ReadonlyArray<number>;
  /** Cost of one house (and of the hotel) on a street; 0 otherwise. */
  readonly houseCost: number;
}

/** A board space. Built with the tagged constructors so that it can be matched. */
export const Space = Schema.TaggedUnion({
  Go: { position: Position, name: Schema.String },
  Property: { position: Position, name: Schema.String, property: PropertyId },
  Tax: { position: Position, name: Schema.String, amount: Money },
  Chance: { position: Position, name: Schema.String },
  CommunityChest: { position: Position, name: Schema.String },
  Jail: { position: Position, name: Schema.String },
  FreeParking: { position: Position, name: Schema.String },
  GoToJail: { position: Position, name: Schema.String },
});

export type Space = typeof Space.Type;

export const BOARD_SIZE = 40;

export const GO_POSITION = 0;

export const JAIL_POSITION = 10;

export const INCOME_TAX = 200;

export const LUXURY_TAX = 100;

const street = (
  position: number,
  name: string,
  group: Group,
  price: number,
  rents: ReadonlyArray<number>,
  houseCost: number,
): Omit<PropertyInfo, "id" | "index"> => ({
  position,
  name,
  kind: "street",
  group,
  price,
  mortgage: price / 2,
  rents,
  houseCost,
});

const railroad = (position: number, name: string): Omit<PropertyInfo, "id" | "index"> => ({
  position,
  name,
  kind: "railroad",
  group: "railroads",
  price: 200,
  mortgage: 100,
  rents: [25, 50, 100, 200],
  houseCost: 0,
});

const utility = (position: number, name: string): Omit<PropertyInfo, "id" | "index"> => ({
  position,
  name,
  kind: "utility",
  group: "utilities",
  price: 150,
  mortgage: 75,
  rents: [4, 10],
  houseCost: 0,
});

/** Deed data in board order; entry `i` is `PROPERTY_IDS[i]`. */
const DEED_DATA: ReadonlyArray<Omit<PropertyInfo, "id" | "index">> = [
  street(1, "Mediterranean Avenue", "brown", 60, [2, 10, 30, 90, 160, 250], 50),
  street(3, "Baltic Avenue", "brown", 60, [4, 20, 60, 180, 320, 450], 50),
  railroad(5, "Reading Railroad"),
  street(6, "Oriental Avenue", "light-blue", 100, [6, 30, 90, 270, 400, 550], 50),
  street(8, "Vermont Avenue", "light-blue", 100, [6, 30, 90, 270, 400, 550], 50),
  street(9, "Connecticut Avenue", "light-blue", 120, [8, 40, 100, 300, 450, 600], 50),
  street(11, "St. Charles Place", "pink", 140, [10, 50, 150, 450, 625, 750], 100),
  utility(12, "Electric Company"),
  street(13, "States Avenue", "pink", 140, [10, 50, 150, 450, 625, 750], 100),
  street(14, "Virginia Avenue", "pink", 160, [12, 60, 180, 500, 700, 900], 100),
  railroad(15, "Pennsylvania Railroad"),
  street(16, "St. James Place", "orange", 180, [14, 70, 200, 550, 750, 950], 100),
  street(18, "Tennessee Avenue", "orange", 180, [14, 70, 200, 550, 750, 950], 100),
  street(19, "New York Avenue", "orange", 200, [16, 80, 220, 600, 800, 1000], 100),
  street(21, "Kentucky Avenue", "red", 220, [18, 90, 250, 700, 875, 1050], 150),
  street(23, "Indiana Avenue", "red", 220, [18, 90, 250, 700, 875, 1050], 150),
  street(24, "Illinois Avenue", "red", 240, [20, 100, 300, 750, 925, 1100], 150),
  railroad(25, "B. & O. Railroad"),
  street(26, "Atlantic Avenue", "yellow", 260, [22, 110, 330, 800, 975, 1150], 150),
  street(27, "Ventnor Avenue", "yellow", 260, [22, 110, 330, 800, 975, 1150], 150),
  utility(28, "Water Works"),
  street(29, "Marvin Gardens", "yellow", 280, [24, 120, 360, 850, 1025, 1200], 150),
  street(31, "Pacific Avenue", "green", 300, [26, 130, 390, 900, 1100, 1275], 200),
  street(32, "North Carolina Avenue", "green", 300, [26, 130, 390, 900, 1100, 1275], 200),
  street(34, "Pennsylvania Avenue", "green", 320, [28, 150, 450, 1000, 1200, 1400], 200),
  railroad(35, "Short Line"),
  street(37, "Park Place", "dark-blue", 350, [35, 175, 500, 1100, 1300, 1500], 200),
  street(39, "Boardwalk", "dark-blue", 400, [50, 200, 600, 1400, 1700, 2000], 200),
];

/** All 28 deeds in board order. */
export const PROPERTIES: ReadonlyArray<PropertyInfo> = PROPERTY_IDS.map((id, index) => {
  const data = DEED_DATA[index];

  if (data === undefined) throw new Error(`Missing deed data for ${id}`);

  return { ...data, id, index };
});

const PROPERTY_BY_ID = new Map<Deed, PropertyInfo>(PROPERTIES.map((info) => [info.id, info]));

/** Printed data of a deed. */
export const propertyInfo = (id: Deed): PropertyInfo => {
  const info = PROPERTY_BY_ID.get(id);

  if (info === undefined) throw new Error(`Unknown property ${id}`);

  return info;
};

/** Index of a deed in board order (and in `GameState.properties`). */
export const propertyIndex = (id: Deed): number => propertyInfo(id).index;

/** Deeds of each group in board order. */
export const GROUP_MEMBERS: ReadonlyMap<Group, ReadonlyArray<Deed>> = new Map(
  GROUP_IDS.map((group) => [
    group,
    PROPERTIES.flatMap((info) => (info.group === group ? [info.id] : [])),
  ]),
);

export const groupMembers = (group: Group): ReadonlyArray<Deed> => GROUP_MEMBERS.get(group) ?? [];

/** Human-readable group names for digests and prompts. */
export const GROUP_NAMES: Readonly<Record<Group, string>> = {
  brown: "Brown",
  "light-blue": "Light Blue",
  pink: "Pink",
  orange: "Orange",
  red: "Red",
  yellow: "Yellow",
  green: "Green",
  "dark-blue": "Dark Blue",
  railroads: "Railroads",
  utilities: "Utilities",
};

const propertySpace = (id: Deed): Space => {
  const info = propertyInfo(id);

  return Space.cases.Property.make({ position: info.position, name: info.name, property: id });
};

/** The 40 spaces, indexed by position. */
export const SPACES: ReadonlyArray<Space> = [
  Space.cases.Go.make({ position: 0, name: "GO" }),
  propertySpace("mediterranean-avenue"),
  Space.cases.CommunityChest.make({ position: 2, name: "Community Chest" }),
  propertySpace("baltic-avenue"),
  Space.cases.Tax.make({ position: 4, name: "Income Tax", amount: INCOME_TAX }),
  propertySpace("reading-railroad"),
  propertySpace("oriental-avenue"),
  Space.cases.Chance.make({ position: 7, name: "Chance" }),
  propertySpace("vermont-avenue"),
  propertySpace("connecticut-avenue"),
  Space.cases.Jail.make({ position: 10, name: "Jail" }),
  propertySpace("st-charles-place"),
  propertySpace("electric-company"),
  propertySpace("states-avenue"),
  propertySpace("virginia-avenue"),
  propertySpace("pennsylvania-railroad"),
  propertySpace("st-james-place"),
  Space.cases.CommunityChest.make({ position: 17, name: "Community Chest" }),
  propertySpace("tennessee-avenue"),
  propertySpace("new-york-avenue"),
  Space.cases.FreeParking.make({ position: 20, name: "Free Parking" }),
  propertySpace("kentucky-avenue"),
  Space.cases.Chance.make({ position: 22, name: "Chance" }),
  propertySpace("indiana-avenue"),
  propertySpace("illinois-avenue"),
  propertySpace("b-and-o-railroad"),
  propertySpace("atlantic-avenue"),
  propertySpace("ventnor-avenue"),
  propertySpace("water-works"),
  propertySpace("marvin-gardens"),
  Space.cases.GoToJail.make({ position: 30, name: "Go To Jail" }),
  propertySpace("pacific-avenue"),
  propertySpace("north-carolina-avenue"),
  Space.cases.CommunityChest.make({ position: 33, name: "Community Chest" }),
  propertySpace("pennsylvania-avenue"),
  propertySpace("short-line"),
  Space.cases.Chance.make({ position: 36, name: "Chance" }),
  propertySpace("park-place"),
  Space.cases.Tax.make({ position: 38, name: "Luxury Tax", amount: LUXURY_TAX }),
  propertySpace("boardwalk"),
];

export const spaceAt = (position: number): Space => {
  const space = SPACES[position];

  if (space === undefined) throw new Error(`No space at position ${position}`);

  return space;
};

export const spaceName = (position: number): string => spaceAt(position).name;

/** Positions of the four railroads and two utilities, for "nearest" cards. */
export const RAILROAD_POSITIONS: ReadonlyArray<number> = [5, 15, 25, 35];

export const UTILITY_POSITIONS: ReadonlyArray<number> = [12, 28];

/** First position of `targets` reached moving forward from `from` (wrapping past GO). */
export const nearestForward = (from: number, targets: ReadonlyArray<number>): number => {
  const ahead = targets.find((position) => position > from);

  return ahead ?? targets[0] ?? 0;
};
