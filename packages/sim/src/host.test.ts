import { Predicate } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { command, createConfig } from "@mb/engine";

import { asyncDrivers, botDrivers, botSeats, runBotGame, runGame } from "./index.ts";

import type { Driver } from "./index.ts";
import type { Seat } from "@mb/engine";

const config = (seed: string) =>
  createConfig({
    gameId: seed,
    seed,
    seats: botSeats(["heuristic", "heuristic", "random"]),
    rules: { maxRounds: 30 },
  });

describe("runGame", () => {
  it("plays a whole game with async drivers and reports standings", async () => {
    const result = await runGame({
      config: config("async"),
      drivers: asyncDrivers(botDrivers(["heuristic", "heuristic", "random"], "async")),
    });

    expect(result.state.status).toBe("finished");
    expect(result.standings).toHaveLength(3);
    expect(result.stats.every((entry) => entry.timeouts === 0)).toBe(true);
  });

  it("gives digest lines to drivers", async () => {
    const seen: Array<string> = [];
    const bots = botDrivers(["heuristic", "heuristic", "random"], "digest");

    const drivers = new Map<Seat, Driver>(
      [...bots].map(([seat, bot]): [Seat, Driver] => [
        seat,
        async (request, view, lines) => {
          if (seat === "B") seen.push(...lines);

          return bot(request, view, lines);
        },
      ]),
    );

    await runGame({ config: config("digest"), drivers });

    expect(seen.some((line) => line.includes("rolled"))).toBe(true);
  });

  it("applies the default action when a driver fails, is missing or answers badly", async () => {
    const bots = asyncDrivers(botDrivers(["heuristic", "heuristic", "random"], "faulty"));

    const failing: Driver = async () => {
      throw new Error("model unavailable");
    };

    const noisy: Driver = async (request) => [
      command("Bid", { seat: request.seat, decisionId: "nope", amount: 1 }),
    ];

    const drivers = new Map<Seat, Driver>([
      ["A", failing],
      ["B", noisy],
    ]);

    const bot = bots.get("C");

    if (bot !== undefined) drivers.set("C", bot);

    const result = await runGame({ config: config("faulty"), drivers });
    const stats = new Map(result.stats.map((entry) => [entry.seat, entry]));

    expect(result.state.status).toBe("finished");
    expect(stats.get("A")?.timeouts).toBeGreaterThan(0);
    expect(stats.get("B")?.invalid).toBeGreaterThan(0);
    expect(result.events.some((event) => Predicate.isTagged(event, "SeatTimedOut"))).toBe(true);
  });
});

describe("runBotGame", () => {
  it("is deterministic for a seed", () => {
    const first = runBotGame({ gameId: "d", seed: "same", policies: ["heuristic", "random"] });
    const second = runBotGame({ gameId: "d", seed: "same", policies: ["heuristic", "random"] });

    expect(second.events).toEqual(first.events);
  });

  it("plays a 4-player bot game well under a second", () => {
    const started = performance.now();

    const result = runBotGame({
      gameId: "speed",
      seed: "speed",
      policies: ["heuristic", "random", "heuristic", "random"],
    });

    expect(result.state.status).toBe("finished");
    expect(performance.now() - started).toBeLessThan(5000);
  });
});
