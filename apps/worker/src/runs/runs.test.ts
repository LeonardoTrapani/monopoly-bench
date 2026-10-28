import { BotSeat, LlmSeat, type RunConfig, type SeatSpec } from "@mb/api";
import { describe, expect, it } from "vite-plus/test";

import { charge, isExhausted, mayRun } from "./budget.ts";
import { deriveGameSeed, expandRun, newRunId, rotateSeats } from "./expand.ts";

const opus = LlmSeat.make({ model: "anthropic/claude-opus-5.5", label: "Opus" });
const sol = LlmSeat.make({ model: "openai/gpt-6.1-sol", label: "Sol", reasoning: "high" });
const heuristic = BotSeat.make({ policy: "heuristic" });
const random = BotSeat.make({ policy: "random" });

const config = (players: ReadonlyArray<SeatSpec>, seeds: number): RunConfig => ({
  players,
  seeds,
  budgetUsd: 5,
});

describe("run expansion", () => {
  it("rotates seats cyclically", () => {
    expect(rotateSeats(["w", "x", "y", "z"], 0)).toEqual(["w", "x", "y", "z"]);
    expect(rotateSeats(["w", "x", "y", "z"], 1)).toEqual(["x", "y", "z", "w"]);
    expect(rotateSeats(["w", "x", "y", "z"], 3)).toEqual(["z", "w", "x", "y"]);
  });

  it("plays seeds × players games, every competitor in every seat once per seed", () => {
    const players = [opus, sol, heuristic, random];
    const games = expandRun("r-1", config(players, 3));

    expect(games).toHaveLength(12);
    expect(games.map((game) => game.gameIndex)).toEqual([...Array(12).keys()]);

    for (let seedIndex = 0; seedIndex < 3; seedIndex += 1) {
      const ofSeed = games.filter((game) => game.seedIndex === seedIndex);

      expect(ofSeed.map((game) => game.rotation)).toEqual([0, 1, 2, 3]);
      expect(new Set(ofSeed.map((game) => game.seed)).size).toBe(1);

      for (const seat of ["A", "B", "C", "D"] as const) {
        const occupants = ofSeed.flatMap((game) =>
          game.seats.flatMap((planned) => (planned.seat === seat ? [planned.competitorId] : [])),
        );

        expect(new Set(occupants).size).toBe(4);
      }
    }

    expect(games[1]?.seats.map((seat) => seat.competitorId)).toEqual([
      "openai/gpt-6.1-sol:high",
      "bot:heuristic",
      "bot:random",
      "anthropic/claude-opus-5.5",
    ]);
  });

  it("derives game seeds deterministically, shared across runs", () => {
    const first = expandRun("r-a", config([opus, heuristic], 2));
    const second = expandRun("r-b", config([opus, heuristic], 2));

    expect(first.map((game) => game.seed)).toEqual(second.map((game) => game.seed));
    expect(deriveGameSeed(0)).not.toBe(deriveGameSeed(1));
    expect(deriveGameSeed(7)).toBe(deriveGameSeed(7));
    expect(first.map((game) => game.gameId)).toEqual(["r-a-0-0", "r-a-0-1", "r-a-1-0", "r-a-1-1"]);
  });

  it("marks games that need LLM wakes", () => {
    expect(expandRun("r", config([heuristic, random], 1)).every((game) => !game.hasLlm)).toBe(true);
    expect(expandRun("r", config([opus, random], 1)).every((game) => game.hasLlm)).toBe(true);
  });

  it("creates sortable, URL-safe run ids", () => {
    const id = newRunId(new Date("2026-10-28T00:00:00Z"), () => 0.5);

    expect(id).toMatch(/^r-[0-9a-z]+-8{8}$/);
  });
});

describe("budget", () => {
  it("charges each key once and reports the crossing", () => {
    const start = { budgetUsd: 1, spentUsd: 0.6 };
    const first = charge(start, false, 0.5);

    expect(first.applied).toBe(true);
    expect(first.crossed).toBe(true);
    expect(first.budget.spentUsd).toBeCloseTo(1.1);
    expect(isExhausted(first.budget)).toBe(true);

    const duplicate = charge(first.budget, true, 0.5);

    expect(duplicate.applied).toBe(false);
    expect(duplicate.budget.spentUsd).toBeCloseTo(1.1);

    const after = charge(first.budget, false, 0.2);

    expect(after.crossed).toBe(false);
  });

  it("gates only games that need LLM wakes", () => {
    const spent = { budgetUsd: 0, spentUsd: 0 };

    expect(mayRun(spent, false)).toBe(true);
    expect(mayRun(spent, true)).toBe(false);
    expect(mayRun({ budgetUsd: 2, spentUsd: 1 }, true)).toBe(true);
  });
});
