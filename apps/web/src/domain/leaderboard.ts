/** Leaderboard sorting, ranking and head-to-head lookups (pure). */
import type { HeadToHeadCell, LeaderboardEntry } from "@mb/api";
import { Schema } from "effect";

export const SortColumn = Schema.Literals([
  "Rank",
  "Model",
  "Score",
  "Games",
  "WinRate",
  "AvgPlace",
  "AvgNetWorth",
  "InvalidRate",
  "CostPerGame",
  "Latency",
]);

export type SortColumn = typeof SortColumn.Type;

export const SortDirection = Schema.Literals(["Ascending", "Descending"]);

export type SortDirection = typeof SortDirection.Type;

export const Sort = Schema.Struct({ column: SortColumn, direction: SortDirection });

export type Sort = typeof Sort.Type;

export const DEFAULT_SORT: Sort = { column: "Rank", direction: "Ascending" };

/** Columns where a lower value is better start ascending; the others start descending. */
const LOWER_IS_BETTER: ReadonlyArray<SortColumn> = [
  "Rank",
  "Model",
  "AvgPlace",
  "InvalidRate",
  "CostPerGame",
  "Latency",
];

export const winRate = (entry: LeaderboardEntry): number =>
  entry.games === 0 ? 0 : entry.wins / entry.games;

/** Next sort after clicking `column`: flip the direction on the same column, else its natural one. */
export const nextSort = (current: Sort, column: SortColumn): Sort => {
  if (current.column === column) {
    return {
      column,
      direction: current.direction === "Ascending" ? "Descending" : "Ascending",
    };
  }

  return { column, direction: LOWER_IS_BETTER.includes(column) ? "Ascending" : "Descending" };
};

/** A leaderboard row with its rank by score (1 = best; equal scores share a rank). */
export interface RankedEntry {
  readonly rank: number;
  readonly entry: LeaderboardEntry;
}

/** Ranks entries by score (`mu − 3σ`), highest first. */
export const rankEntries = (
  entries: ReadonlyArray<LeaderboardEntry>,
): ReadonlyArray<RankedEntry> => {
  const sorted = [...entries].sort(
    (left, right) => right.score - left.score || right.games - left.games,
  );

  const ranked: Array<RankedEntry> = [];

  for (const [index, entry] of sorted.entries()) {
    const previous = ranked[index - 1];

    const rank =
      previous !== undefined && previous.entry.score === entry.score ? previous.rank : index + 1;

    ranked.push({ rank, entry });
  }

  return ranked;
};

const sortValue = (row: RankedEntry, column: SortColumn): number | string => {
  if (column === "Rank") return row.rank;

  if (column === "Model") return row.entry.label.toLowerCase();

  if (column === "Score") return row.entry.score;

  if (column === "Games") return row.entry.games;

  if (column === "WinRate") return winRate(row.entry);

  if (column === "AvgPlace") return row.entry.avgPlace;

  if (column === "AvgNetWorth") return row.entry.avgNetWorth;

  if (column === "InvalidRate") return row.entry.invalidRate;

  if (column === "CostPerGame") return row.entry.costPerGameUsd;

  return row.entry.avgWakeMs;
};

const compareValues = (left: number | string, right: number | string): number => {
  if (left < right) return -1;

  if (left > right) return 1;

  return 0;
};

/** Ranked rows ordered by `sort` (ties keep the rank order). */
export const sortEntries = (
  entries: ReadonlyArray<LeaderboardEntry>,
  sort: Sort,
): ReadonlyArray<RankedEntry> => {
  const sign = sort.direction === "Ascending" ? 1 : -1;

  return [...rankEntries(entries)].sort(
    (left, right) =>
      sign * compareValues(sortValue(left, sort.column), sortValue(right, sort.column)) ||
      left.rank - right.rank,
  );
};

/**
 * Share of shared games in which `row` finished ahead of `column`, with the number of shared
 * games. Cells may be stored in either orientation.
 */
export const headToHead = (
  cells: ReadonlyArray<HeadToHeadCell>,
  row: string,
  column: string,
): Readonly<{ games: number; ahead: number }> | null => {
  const direct = cells.find((cell) => cell.a === row && cell.b === column);

  if (direct !== undefined) return { games: direct.games, ahead: direct.aAhead };

  const reverse = cells.find((cell) => cell.a === column && cell.b === row);

  if (reverse !== undefined) return { games: reverse.games, ahead: reverse.games - reverse.aAhead };

  return null;
};
