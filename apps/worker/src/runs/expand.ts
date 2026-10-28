/**
 * Run expansion (SPEC.md §8): games = seeds × players. For seed s and rotation k = 0..n-1 the
 * seat specs are rotated by k positions (seat i gets players[(i + k) mod n]), so every
 * competitor plays every seat of every seed once. All rotations of one seed share the game
 * seed: the same dice and decks, with the competitors moved one seat along.
 */
import { competitorId, competitorLabel, type RunConfig, type Seat, type SeatSpec } from "@mb/api";
import { createConfig, type GameConfig, type RulesConfig } from "@mb/engine";
import { Match } from "effect";

import type { PlannedSeat } from "../contracts.ts";

export const SEAT_LETTERS: ReadonlyArray<Seat> = ["A", "B", "C", "D", "E", "F"];

export const DEFAULT_CONCURRENCY = 2;

export interface PlannedGame {
  readonly gameId: string;
  readonly gameIndex: number;
  readonly seedIndex: number;
  readonly rotation: number;
  readonly seed: string;
  readonly seats: ReadonlyArray<PlannedSeat>;
  readonly hasLlm: boolean;
}

const FNV_OFFSET = 0xcbf29ce484222325n;

const FNV_PRIME = 0x100000001b3n;

const MASK_64 = 0xffffffffffffffffn;

/** FNV-1a 64-bit of a UTF-8 string, as a decimal string. */
export const fnv1a64 = (text: string): string => {
  let hash = FNV_OFFSET;

  for (const byte of new TextEncoder().encode(text)) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & MASK_64;
  }

  return hash.toString();
};

/** Deterministic seed of the s-th seed index, identical across runs so seeds are comparable. */
export const deriveGameSeed = (seedIndex: number): string =>
  fnv1a64(`monopoly-bench/seed/${seedIndex}`);

/** Seat i gets `specs[(i + rotation) mod n]`. */
export const rotateSeats = <A>(specs: ReadonlyArray<A>, rotation: number): ReadonlyArray<A> => {
  const k = specs.length === 0 ? 0 : rotation % specs.length;

  return [...specs.slice(k), ...specs.slice(0, k)];
};

export const seatKind = (spec: SeatSpec): "llm" | "bot" =>
  Match.valueTags(spec, { llm: () => "llm" as const, bot: () => "bot" as const });

export const planSeats = (specs: ReadonlyArray<SeatSpec>): ReadonlyArray<PlannedSeat> =>
  specs.flatMap((spec, index) => {
    const seat = SEAT_LETTERS[index];

    return seat === undefined
      ? []
      : [
          {
            seat,
            spec,
            competitorId: competitorId(spec),
            label: competitorLabel(spec),
            kind: seatKind(spec),
          },
        ];
  });

/** The start of every game id of a run. */
export const gameIdPrefixOf = (runId: string): string => `${runId}-`;

export const gameIdOf = (runId: string, seedIndex: number, rotation: number): string =>
  `${gameIdPrefixOf(runId)}${seedIndex}-${rotation}`;

export const expandRun = (runId: string, config: RunConfig): ReadonlyArray<PlannedGame> => {
  const n = config.players.length;
  const games: Array<PlannedGame> = [];

  for (let seedIndex = 0; seedIndex < config.seeds; seedIndex += 1) {
    const seed = deriveGameSeed(seedIndex);

    for (let rotation = 0; rotation < n; rotation += 1) {
      const seats = planSeats(rotateSeats(config.players, rotation));
      games.push({
        gameId: gameIdOf(runId, seedIndex, rotation),
        gameIndex: seedIndex * n + rotation,
        seedIndex,
        rotation,
        seed,
        seats,
        hasLlm: seats.some((seat) => seat.kind === "llm"),
      });
    }
  }

  return games;
};

/** `r-<time base36>-<8 hex>`: sortable by creation and URL-safe. */
export const newRunId = (now: Date, random: () => number): string => {
  const suffix = Array.from({ length: 8 }, () => Math.floor(random() * 16).toString(16)).join("");

  return `r-${now.getTime().toString(36)}-${suffix}`;
};

/** The engine config of a planned game: engine defaults overridden by the run's settings. */
export const gameConfigOf = (game: PlannedGame, config: RunConfig): GameConfig => {
  const rules: Partial<{ -readonly [K in keyof RulesConfig]: RulesConfig[K] }> = {};

  if (config.maxRounds !== undefined) rules.maxRounds = config.maxRounds;

  if (config.tableFrequency !== undefined) rules.tableFrequency = config.tableFrequency;

  return createConfig({
    gameId: game.gameId,
    seed: game.seed,
    seats: game.seats.map((seat) => ({
      seat: seat.seat,
      label: seat.label,
      competitorId: seat.competitorId,
    })),
    rules,
  });
};
