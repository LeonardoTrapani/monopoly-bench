import { LlmSeat, type RunConfig } from "@mb/api";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";

import type { GameOutcome, GameStart, OwnKeyFunding } from "../contracts.ts";
import type { GameRatingInput } from "../db/ratings-store.ts";
import { noop, port, run } from "../testing/effect.ts";
import { memorySqlPort } from "../testing/sqlite.ts";
import { RunCoordinator } from "./run-coordinator.ts";

const opus = LlmSeat.make({ model: "anthropic/claude-opus-5.5", label: "Opus" });

const sol = LlmSeat.make({ model: "openai/gpt-6.1-sol", label: "Sol" });

const ownKey: OwnKeyFunding = { openRouterKey: "sk-or-own-key", cancelTokenSha256: "ab12" };

const setup = () => {
  const started: Array<GameStart> = [];
  const aborted: Array<string> = [];
  const purged: Array<string> = [];
  const abortedQueued: Array<string> = [];
  const rated: Array<GameRatingInput> = [];
  const runUpdates: Array<string> = [];
  const alarms: Array<number | null> = [];
  let failStarts = 0;
  let failRatings = 0;

  const sql = memorySqlPort();

  const coordinator = new RunCoordinator({
    sql,
    db: {
      insertRun: noop,
      updateRun: port((_id, status, spent) => {
        runUpdates.push(`${status}:${spent}`);
      }),
      abortQueued: port((ids) => {
        abortedQueued.push(...ids);
      }),
      applyRatings: port((input) => {
        if (failRatings > 0) {
          failRatings -= 1;
          throw new Error("D1 unavailable");
        }

        rated.push(input);
      }),
    },
    games: {
      start: port((start) => {
        if (failStarts > 0) {
          failStarts -= 1;
          throw new Error("GameDO unavailable");
        }

        started.push(start);
      }),
      abort: port((gameId) => {
        aborted.push(gameId);
      }),
      purge: port((gameId, llmSeats) => {
        purged.push(`${gameId}:${llmSeats.join("")}`);
      }),
    },
    setAlarm: (at) =>
      Effect.sync(() => {
        alarms.push(at);
      }),
    now: () => Date.parse("2026-10-28T10:00:00.000Z"),
  });

  const finish = (start: GameStart, status: GameOutcome["status"] = "finished"): GameOutcome => ({
    gameId: start.gameId,
    status,
    playersCount: start.seats.length,
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
    sql,
    started,
    aborted,
    purged,
    abortedQueued,
    rated,
    runUpdates,
    finish,
    alarms,
    failNextStarts: (count: number) => {
      failStarts = count;
    },
    failNextRatings: (count: number) => {
      failRatings = count;
    },
  };
};

const config = (patch: Partial<RunConfig> = {}): RunConfig => ({
  players: [opus, sol],
  seeds: 3,
  budgetUsd: 1,
  concurrency: 2,
  ...patch,
});

describe("RunCoordinator", () => {
  it("starts up to `concurrency` games and the next one when a game finishes", async () => {
    const h = setup();

    const summary = await run(
      h.coordinator.create(
        "r1",
        config({ maxRounds: 7, tableFrequency: "everyRound" }),
        [
          {
            id: "anthropic/claude-opus-5.5",
            pricing: { prompt: "0.000004", completion: "0.00002" },
          },
          { id: "unused/model" },
        ],
        null,
      ),
    );

    expect(summary).toMatchObject({
      id: "r1",
      funding: "server",
      status: "running",
      gamesTotal: 6,
      gamesRunning: 2,
    });
    expect(h.started.map((start) => start.gameId)).toEqual(["r1-0-0", "r1-0-1"]);
    expect(h.started[0]).toMatchObject({
      config: { gameId: "r1-0-0", rules: { maxRounds: 7, tableFrequency: "everyRound" } },
      budgetExhausted: false,
    });
    expect(h.started[1]?.config.seats.map((seat) => seat.competitorId)).toEqual([
      "openai/gpt-6.1-sol",
      "anthropic/claude-opus-5.5",
    ]);
    expect(h.started[0]?.listings.map((listing) => listing.id)).toEqual([
      "anthropic/claude-opus-5.5",
    ]);

    const first = h.started[0];

    if (first === undefined) throw new Error("not started");

    await run(h.coordinator.gameFinished(h.finish(first)));
    await run(h.coordinator.gameFinished(h.finish(first)));

    expect(h.started.map((start) => start.gameId)).toEqual(["r1-0-0", "r1-0-1", "r1-1-0"]);
    expect(h.rated.map((input) => input.gameId)).toEqual(["r1-0-0"]);
    expect(h.rated[0]?.results.map((result) => result.rank)).toEqual([1, 2]);
  });

  it("is idempotent on create", async () => {
    const h = setup();

    await run(h.coordinator.create("r1", config(), [], null));
    const again = await run(h.coordinator.create("r1", config({ seeds: 9 }), [], null));

    expect(again?.gamesTotal).toBe(6);
    expect(h.started).toHaveLength(2);
  });

  it("finishes the run after the last game and does not rate aborted games", async () => {
    const h = setup();

    await run(h.coordinator.create("r1", config({ seeds: 1, concurrency: 4 }), [], null));

    for (const start of h.started.slice())
      await run(h.coordinator.gameFinished(h.finish(start, "aborted")));

    expect(h.coordinator.summary()?.status).toBe("finished");
    expect(h.rated).toHaveLength(0);
    expect(h.runUpdates.at(-1)).toBe("finished:0");
  });

  it("charges each wake once and stops LLM games when the budget is reached", async () => {
    const h = setup();

    await run(h.coordinator.create("r1", config({ budgetUsd: 1 }), [], null));

    expect(await run(h.coordinator.charge("r1-0-0", "k1", 0.6))).toEqual({ exhausted: false });
    expect(await run(h.coordinator.charge("r1-0-0", "k1", 0.6))).toEqual({ exhausted: false });
    expect(h.coordinator.summary()?.spentUsd).toBeCloseTo(0.6);

    expect(await run(h.coordinator.charge("r1-0-0", "k2", 0.5))).toEqual({ exhausted: true });
    expect(h.coordinator.summary()?.spentUsd).toBeCloseTo(1.1);
    // The charging game learns it from the answer; the other running LLM game is aborted.
    expect(h.aborted).toEqual(["r1-0-1"]);

    const first = h.started[0];

    if (first === undefined) throw new Error("not started");

    await run(h.coordinator.gameFinished(h.finish(first, "aborted")));

    // Queued LLM games never start once the budget is spent.
    expect(h.started).toHaveLength(2);
    expect(h.abortedQueued).toEqual(["r1-1-0", "r1-1-1", "r1-2-0", "r1-2-1"]);
  });

  it("cancels: queued games never start and running games are aborted", async () => {
    const h = setup();

    await run(h.coordinator.create("r1", config(), [], null));

    const summary = await run(h.coordinator.cancel());

    expect(summary?.status).toBe("cancelled");
    expect(h.aborted).toEqual(["r1-0-0", "r1-0-1"]);
    expect(h.abortedQueued).toHaveLength(4);

    const first = h.started[0];

    if (first === undefined) throw new Error("not started");

    await run(h.coordinator.gameFinished(h.finish(first, "aborted")));

    expect(h.started).toHaveLength(2);
    expect(h.coordinator.summary()?.status).toBe("cancelled");
  });

  it("re-queues a game whose start failed and retries it from the alarm", async () => {
    const h = setup();
    h.failNextStarts(1);

    await run(h.coordinator.create("r1", config(), [], null));

    expect(h.started.map((start) => start.gameId)).toEqual(["r1-0-1"]);

    await run(h.coordinator.alarm());

    expect(h.started.map((start) => start.gameId)).toEqual(["r1-0-1", "r1-0-0"]);
  });

  it("keeps retrying a failed rating after the run finished (F3)", async () => {
    const h = setup();

    await run(h.coordinator.create("r1", config({ seeds: 1 }), [], null));
    h.failNextRatings(1);

    for (const start of h.started.slice()) await run(h.coordinator.gameFinished(h.finish(start)));

    expect(h.coordinator.summary()?.status).toBe("finished");
    expect(h.rated.map((input) => input.gameId)).toEqual(["r1-0-1"]);
    expect(h.alarms.at(-1)).not.toBeNull();

    await run(h.coordinator.alarm());

    expect(h.rated.map((input) => input.gameId).sort()).toEqual(["r1-0-0", "r1-0-1"]);
    expect(h.alarms.at(-1)).toBeNull();
  });

  it("keeps retrying a failed rating after the run was cancelled (F3)", async () => {
    const h = setup();

    await run(h.coordinator.create("r1", config({ seeds: 1 }), [], null));
    h.failNextRatings(1);

    const first = h.started[0];

    if (first === undefined) throw new Error("not started");

    // A game that was already ending when the run was cancelled.
    await run(h.coordinator.cancel());
    await run(h.coordinator.gameFinished(h.finish(first)));

    expect(h.alarms.at(-1)).not.toBeNull();

    await run(h.coordinator.alarm());

    expect(h.rated.map((input) => input.gameId)).toEqual(["r1-0-0"]);
  });

  it("keeps an own key only while the run is active and never in D1", async () => {
    const h = setup();
    const inserted: Array<string> = [];

    const coordinator = new RunCoordinator({
      sql: memorySqlPort(),
      db: {
        insertRun: port((run) => {
          inserted.push(JSON.stringify(run));
        }),
        updateRun: noop,
        abortQueued: noop,
        applyRatings: noop,
      },
      games: { start: noop, abort: noop, purge: noop },
      setAlarm: noop,
      now: () => 0,
    });

    const summary = await run(coordinator.create("r1", config({ seeds: 1 }), [], ownKey));

    expect(summary.funding).toBe("ownKey");
    expect(inserted.join("")).toContain('"funding":"ownKey"');
    expect(inserted.join("")).not.toContain(ownKey.openRouterKey);
    expect(coordinator.credentials()).toEqual({
      funding: "ownKey",
      openRouterKey: "sk-or-own-key",
    });
    expect(coordinator.cancelTokenMatches("ab12")).toBe(true);
    expect(coordinator.cancelTokenMatches("ab13")).toBe(false);

    await run(coordinator.cancel());

    // Cancelled: no key for any later wake (it fails fast instead of using the server's key).
    expect(coordinator.credentials()).toBeNull();
    expect(coordinator.cancelTokenMatches("ab12")).toBe(true);

    // A server-funded run: the server's key while active, nothing for an unknown run.
    expect(h.coordinator.credentials()).toBeNull();

    await run(h.coordinator.create("r2", config({ seeds: 1 }), [], null));

    expect(h.coordinator.credentials()).toEqual({ funding: "server", openRouterKey: null });
    expect(h.coordinator.cancelTokenMatches("ab12")).toBe(false);
  });

  it("deletes the own key when the run finishes", async () => {
    const h = setup();

    await run(h.coordinator.create("r1", config({ seeds: 1 }), [], ownKey));

    for (const start of h.started.slice()) await run(h.coordinator.gameFinished(h.finish(start)));

    expect(h.coordinator.summary()?.status).toBe("finished");
    expect(h.coordinator.credentials()).toBeNull();
    expect(JSON.stringify(h.sql.exec("SELECT * FROM funding"))).not.toContain("sk-or-own-key");
  });

  it("purges a deleted run: started games and their LLM seats, then its own storage", async () => {
    const h = setup();

    await run(h.coordinator.create("r1", config(), [], ownKey));
    await run(h.coordinator.purge());

    expect(h.purged).toEqual(["r1-0-0:AB", "r1-0-1:AB"]);
    expect(h.coordinator.summary()).toBeNull();
    expect(h.coordinator.credentials()).toBeNull();

    for (const table of ["run", "games", "charges", "funding"]) {
      expect(h.sql.exec(`SELECT * FROM ${table}`)).toEqual([]);
    }

    expect(h.alarms.at(-1)).toBeNull();

    // Idempotent: nothing left to purge.
    await run(h.coordinator.purge());

    expect(h.purged).toHaveLength(2);
  });
});
