import { BotSeat, LlmSeat, type RunConfig } from "@mb/api";
import { describe, expect, it } from "vite-plus/test";

import type { GameOutcome, GameStart } from "../contracts.ts";
import type { GameRatingInput } from "../db/ratings-store.ts";
import { memorySqlPort } from "../testing/sqlite.ts";
import { RunCoordinator } from "./run-coordinator.ts";

const opus = LlmSeat.make({ model: "anthropic/claude-opus-5.5", label: "Opus" });

const random = BotSeat.make({ policy: "random" });

const heuristic = BotSeat.make({ policy: "heuristic" });

const setup = () => {
  const started: Array<GameStart> = [];
  const aborted: Array<string> = [];
  const abortedQueued: Array<string> = [];
  const rated: Array<GameRatingInput> = [];
  const runUpdates: Array<string> = [];
  let failStarts = 0;

  const coordinator = new RunCoordinator({
    sql: memorySqlPort(),
    db: {
      insertRun: async () => {},
      updateRun: async (_id, status, spent) => {
        runUpdates.push(`${status}:${spent}`);
      },
      abortQueued: async (ids) => {
        abortedQueued.push(...ids);
      },
      applyRatings: async (input) => {
        rated.push(input);
      },
    },
    games: {
      start: async (start) => {
        if (failStarts > 0) {
          failStarts -= 1;
          throw new Error("GameDO unavailable");
        }

        started.push(start);
      },
      abort: async (gameId) => {
        aborted.push(gameId);
      },
    },
    setAlarm: async () => {},
    now: () => Date.parse("2026-10-28T10:00:00.000Z"),
    log: () => {},
  });

  const finish = (start: GameStart, status: GameOutcome["status"] = "finished"): GameOutcome => ({
    gameId: start.gameId,
    status,
    playersCount: start.playersCount,
    finishedAt: "2026-10-28T11:00:00.000Z",
    results: start.seats.map((seat, index) => ({
      seat: seat.seat,
      competitorId: seat.competitorId,
      label: seat.label,
      kind: seat.kind,
      rank: status === "finished" ? index + 1 : null,
    })),
  });

  return {
    coordinator,
    started,
    aborted,
    abortedQueued,
    rated,
    runUpdates,
    finish,
    failNextStarts: (count: number) => {
      failStarts = count;
    },
  };
};

const config = (patch: Partial<RunConfig> = {}): RunConfig => ({
  players: [opus, random],
  seeds: 3,
  budgetUsd: 1,
  concurrency: 2,
  ...patch,
});

describe("RunCoordinator", () => {
  it("starts up to `concurrency` games and the next one when a game finishes", async () => {
    const h = setup();

    const summary = await h.coordinator.create(
      "r1",
      config({ maxRounds: 7, tableFrequency: "everyRound" }),
      [
        { id: "anthropic/claude-opus-5.5", pricing: { prompt: "0.000004", completion: "0.00002" } },
        { id: "unused/model" },
      ],
    );

    expect(summary).toMatchObject({ id: "r1", status: "running", gamesTotal: 6, gamesRunning: 2 });
    expect(h.started.map((start) => start.gameId)).toEqual(["r1-0-0", "r1-0-1"]);
    expect(h.started[0]).toMatchObject({
      maxRounds: 7,
      tableFrequency: "everyRound",
      budgetExhausted: false,
    });
    expect(h.started[0]?.listings.map((listing) => listing.id)).toEqual([
      "anthropic/claude-opus-5.5",
    ]);

    const first = h.started[0];

    if (first === undefined) throw new Error("not started");

    await h.coordinator.gameFinished(h.finish(first));
    await h.coordinator.gameFinished(h.finish(first));

    expect(h.started.map((start) => start.gameId)).toEqual(["r1-0-0", "r1-0-1", "r1-1-0"]);
    expect(h.rated.map((input) => input.gameId)).toEqual(["r1-0-0"]);
    expect(h.rated[0]?.results.map((result) => result.rank)).toEqual([1, 2]);
  });

  it("is idempotent on create", async () => {
    const h = setup();

    await h.coordinator.create("r1", config(), []);
    const again = await h.coordinator.create("r1", config({ seeds: 9 }), []);

    expect(again?.gamesTotal).toBe(6);
    expect(h.started).toHaveLength(2);
  });

  it("finishes the run after the last game and does not rate aborted games", async () => {
    const h = setup();

    await h.coordinator.create("r1", config({ seeds: 1, concurrency: 4 }), []);

    for (const start of h.started.slice())
      await h.coordinator.gameFinished(h.finish(start, "aborted"));

    expect(h.coordinator.summary()?.status).toBe("finished");
    expect(h.rated).toHaveLength(0);
    expect(h.runUpdates.at(-1)).toBe("finished:0");
  });

  it("charges each wake once and stops LLM games when the budget is reached", async () => {
    const h = setup();

    await h.coordinator.create("r1", config({ budgetUsd: 1 }), []);

    expect(await h.coordinator.charge("r1-0-0", "k1", 0.6)).toEqual({ exhausted: false });
    expect(await h.coordinator.charge("r1-0-0", "k1", 0.6)).toEqual({ exhausted: false });
    expect(h.coordinator.summary()?.spentUsd).toBeCloseTo(0.6);

    expect(await h.coordinator.charge("r1-0-0", "k2", 0.5)).toEqual({ exhausted: true });
    expect(h.coordinator.summary()?.spentUsd).toBeCloseTo(1.1);
    // The charging game learns it from the answer; the other running LLM game is aborted.
    expect(h.aborted).toEqual(["r1-0-1"]);

    const first = h.started[0];

    if (first === undefined) throw new Error("not started");

    await h.coordinator.gameFinished(h.finish(first, "aborted"));

    // Queued LLM games never start once the budget is spent.
    expect(h.started).toHaveLength(2);
    expect(h.abortedQueued).toEqual(["r1-1-0", "r1-1-1", "r1-2-0", "r1-2-1"]);
  });

  it("keeps running bot-only games when the budget is spent", async () => {
    const h = setup();

    await h.coordinator.create(
      "r1",
      config({ players: [random, heuristic], budgetUsd: 0, seeds: 2 }),
      [],
    );

    expect(h.started).toHaveLength(2);

    for (let index = 0; index < h.started.length; index += 1) {
      const start = h.started[index];

      if (start !== undefined) await h.coordinator.gameFinished(h.finish(start));
    }

    expect(h.started).toHaveLength(4);
    expect(h.coordinator.summary()?.status).toBe("finished");
  });

  it("cancels: queued games never start and running games are aborted", async () => {
    const h = setup();

    await h.coordinator.create("r1", config(), []);

    const summary = await h.coordinator.cancel();

    expect(summary?.status).toBe("cancelled");
    expect(h.aborted).toEqual(["r1-0-0", "r1-0-1"]);
    expect(h.abortedQueued).toHaveLength(4);

    const first = h.started[0];

    if (first === undefined) throw new Error("not started");

    await h.coordinator.gameFinished(h.finish(first, "aborted"));

    expect(h.started).toHaveLength(2);
    expect(h.coordinator.summary()?.status).toBe("cancelled");
  });

  it("re-queues a game whose start failed and retries it from the alarm", async () => {
    const h = setup();
    h.failNextStarts(1);

    await h.coordinator.create("r1", config(), []);

    expect(h.started.map((start) => start.gameId)).toEqual(["r1-0-1"]);

    await h.coordinator.alarm();

    expect(h.started.map((start) => start.gameId)).toEqual(["r1-0-1", "r1-0-0"]);
  });
});
