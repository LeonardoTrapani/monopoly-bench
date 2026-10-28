/**
 * Stable identifiers shared by the board data and the schemas. Property ids are
 * kebab-case slugs of the deed names so that tool calls stay readable
 * (`build({ property: "boardwalk" })`).
 */

/** The 28 ownable deeds in board order. */
export const PROPERTY_IDS = [
  "mediterranean-avenue",
  "baltic-avenue",
  "reading-railroad",
  "oriental-avenue",
  "vermont-avenue",
  "connecticut-avenue",
  "st-charles-place",
  "electric-company",
  "states-avenue",
  "virginia-avenue",
  "pennsylvania-railroad",
  "st-james-place",
  "tennessee-avenue",
  "new-york-avenue",
  "kentucky-avenue",
  "indiana-avenue",
  "illinois-avenue",
  "b-and-o-railroad",
  "atlantic-avenue",
  "ventnor-avenue",
  "water-works",
  "marvin-gardens",
  "pacific-avenue",
  "north-carolina-avenue",
  "pennsylvania-avenue",
  "short-line",
  "park-place",
  "boardwalk",
] as const;

export type PropertyId = (typeof PROPERTY_IDS)[number];

/** Color groups, plus railroads and utilities which are groups too (SPEC §5.3). */
export const GROUP_IDS = [
  "brown",
  "light-blue",
  "pink",
  "orange",
  "red",
  "yellow",
  "green",
  "dark-blue",
  "railroads",
  "utilities",
] as const;

export type GroupId = (typeof GROUP_IDS)[number];

export const SEATS = ["A", "B", "C", "D", "E", "F"] as const;

export type Seat = (typeof SEATS)[number];

export const DECKS = ["chance", "communityChest"] as const;

export type DeckId = (typeof DECKS)[number];
