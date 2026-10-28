/**
 * Property-test harness (SPEC §11): plays a bot game with invariants checked after
 * every event, then checks that `replay(config, events)` equals the live state, that
 * the game terminated, and (on a sample) that events survive a JSON round trip.
 */
import { Schema } from "effect";
import { describe, it } from "vite-plus/test";

import { GameEventJson, replay, TableFrequency } from "@mb/engine";

import { runBotGame } from "./index.ts";

import type { BotPolicy } from "@mb/bots";
import type { GameResult } from "./host.ts";

const FREQUENCIES = TableFrequency.literals;

const POLICY_MIXES: ReadonlyArray<(seat: number) => BotPolicy> = [
  () => "heuristic",
  (seat) => (seat % 2 === 0 ? "heuristic" : "random"),
  () => "random",
  (seat) => (seat % 3 === 0 ? "random" : "heuristic"),
];

export interface PropertyCase {
  readonly index: number;
  readonly seed: string;
  readonly players: number;
  readonly policies: ReadonlyArray<BotPolicy>;
  readonly tableFrequency: TableFrequency;
  readonly roundTrip: boolean;
}

/** The `index`-th case of a suite: player counts, bot mixes and table frequencies vary. */
export const propertyCase = (suite: string, index: number): PropertyCase => {
  const players = 2 + (index % 5);
  const mix = POLICY_MIXES[Math.floor(index / 5) % POLICY_MIXES.length] ?? (() => "heuristic");

  return {
    index,
    seed: `${suite}-${index}`,
    players,
    policies: Array.from({ length: players }, (_, seat) => mix(seat)),
    tableFrequency: FREQUENCIES[Math.floor(index / 20) % FREQUENCIES.length] ?? "everyTurn",
    roundTrip: index % 25 === 0,
  };
};

const encode = Schema.encodeSync(GameEventJson);

const decode = Schema.decodeUnknownSync(GameEventJson);

/** Plays and checks one case; throws with the seed on any violation. */
export const checkCase = (test: PropertyCase): GameResult => {
  const result = runBotGame({
    gameId: test.seed,
    seed: test.seed,
    policies: test.policies,
    rules: { tableFrequency: test.tableFrequency },
    verify: true,
  });

  const fail = (message: string) => new Error(`${test.seed}: ${message}`);

  if (result.state.status !== "finished") throw fail("the game did not finish");

  const rebuilt = replay(result.config, result.events);

  if (JSON.stringify(rebuilt) !== JSON.stringify(result.state)) {
    throw fail("replay differs from the live state");
  }

  if (test.roundTrip) {
    const decoded = result.events.map((event) => decode(encode(event)));

    if (JSON.stringify(replay(result.config, decoded)) !== JSON.stringify(result.state)) {
      throw fail("JSON round trip changed the replay");
    }
  }

  const ranks = result.standings.map((row) => row.rank);

  if (ranks.join() !== result.standings.map((_, index) => index + 1).join()) {
    throw fail("standings are not ranked 1..n");
  }

  return result;
};

/**
 * Registers one test per game of a suite. Suites are split across files so that the
 * test runner plays them in parallel workers.
 */
export const propertySuite = (suite: string, games: number): void => {
  describe(`property suite ${suite}`, () => {
    for (let index = 0; index < games; index += 1) {
      const test = propertyCase(suite, index);
      const name = `${test.seed}: ${test.players}p ${test.policies.join("/")} table=${test.tableFrequency}`;

      it(
        name,
        () => {
          checkCase(test);
        },
        60_000,
      );
    }
  });
};
