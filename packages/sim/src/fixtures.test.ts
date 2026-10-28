import { readFileSync } from "node:fs";

import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  checkInvariants,
  evolve,
  GameConfig,
  GameEventJson,
  initialState,
  replay,
} from "@mb/engine";

import { runBotGame } from "./index.ts";

import type { BotPolicy } from "@mb/bots";

const read = (name: string) =>
  readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");

const load = (name: string) => {
  const config = Schema.decodeUnknownSync(Schema.fromJsonString(GameConfig))(
    read(`${name}.config.json`),
  );

  const events = read(`${name}.events.jsonl`)
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => Schema.decodeUnknownSync(GameEventJson)(line));

  return { config, events };
};

const FIXTURES: ReadonlyArray<{
  readonly name: string;
  readonly policies: ReadonlyArray<BotPolicy>;
  readonly maxRounds?: number;
}> = [
  { name: "sample-4p", policies: ["heuristic", "random", "heuristic", "random"] },
  { name: "sample-2p", policies: ["heuristic", "random"], maxRounds: 12 },
];

describe("fixtures", () => {
  for (const fixture of FIXTURES) {
    it(`${fixture.name} decodes and replays to a finished game`, () => {
      const { config, events } = load(fixture.name);
      let state = initialState(config);

      for (const event of events) {
        state = evolve(state, event);
        expect(checkInvariants(state)).toEqual([]);
      }

      expect(state.status).toBe("finished");
      expect(replay(config, events)).toEqual(state);
    });

    it(`${fixture.name} matches the current engine and bots (see fixtures/README.md to regenerate)`, () => {
      const { config, events } = load(fixture.name);

      const result = runBotGame({
        gameId: config.gameId,
        seed: config.seed,
        policies: fixture.policies,
        rules: fixture.maxRounds === undefined ? {} : { maxRounds: fixture.maxRounds },
      });

      expect(result.events).toEqual(events);
    });
  }
});
