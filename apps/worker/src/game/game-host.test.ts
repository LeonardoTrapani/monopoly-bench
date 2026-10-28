import { BotSeat, LlmSeat, type SeatSpec, WakeTranscript } from "@mb/api";
import { createConfig, GameConfig, GameEvent, replay, standings } from "@mb/engine";
import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  type GameOutcome,
  type GameStart,
  type SeatCall,
  SpectatorMessage,
  type WakeRequest,
} from "../contracts.ts";
import type { FinishedGame, WakeRow } from "../db/writes.ts";
import { planSeats } from "../runs/expand.ts";
import { memorySqlPort } from "../testing/sqlite.ts";
import { engineBinding } from "./engine-binding.ts";
import { archiveKeys, GameHost, MAX_CONSECUTIVE_MODEL_ERRORS, WAKE_GRACE_MS } from "./game-host.ts";

const decodeMessage = Schema.decodeUnknownSync(Schema.fromJsonString(SpectatorMessage));

const decodeEvent = Schema.decodeUnknownSync(Schema.fromJsonString(GameEvent));

const decodeConfig = Schema.decodeUnknownSync(Schema.fromJsonString(GameConfig));

const llm = (label: string) => LlmSeat.make({ model: "example/model", label });

const random = () => BotSeat.make({ policy: "random" });

const heuristic = () => BotSeat.make({ policy: "heuristic" });

interface Options {
  readonly maxRounds?: number;
  readonly exhaustAfterCharge?: boolean;
  readonly stepsPerAlarm?: number;
  /** Failures before D1 `recordWake` / RunDO `charge` start succeeding. */
  readonly failRecordWake?: number;
  readonly failCharge?: number;
  /** R2 writes wait for `archiveGate.release()`. */
  readonly holdArchive?: boolean;
}

interface ArchiveGate {
  calls: number;
  release: () => void;
  opened: Promise<void>;
}

/** Runs inside D1 `finish`, to deliver a report while the game is being archived. */
interface FinishHooks {
  duringFinish: (() => Promise<void>) | null;
}

const setup = (specs: ReadonlyArray<SeatSpec>, options: Options = {}) => {
  const sql = memorySqlPort();
  const wakes: Array<WakeRequest> = [];
  const charges: Array<string> = [];
  const outcomes: Array<GameOutcome> = [];
  const finishes: Array<FinishedGame> = [];
  const wakeRows: Array<WakeRow> = [];
  const archive = new Map<string, string>();
  const broadcasts: Array<string> = [];
  let alarm: number | null = null;
  let alarmsRun = 0;
  const clock = { now: 1_000_000 };
  const failures = { recordWake: options.failRecordWake ?? 0, charge: options.failCharge ?? 0 };
  const hooks: FinishHooks = { duringFinish: null };
  const archiveGate: ArchiveGate = { calls: 0, release: () => {}, opened: Promise.resolve() };

  if (options.holdArchive === true) {
    archiveGate.opened = new Promise((resolve) => {
      archiveGate.release = resolve;
    });
  }

  const host = new GameHost(
    {
      sql,
      db: {
        markRunning: async () => {},
        progress: async () => {},
        recordWake: async (row) => {
          if (failures.recordWake > 0) {
            failures.recordWake -= 1;
            throw new Error("D1 unavailable");
          }

          wakeRows.push(row);
        },
        finish: async (game) => {
          finishes.push(game);
          await hooks.duringFinish?.();
        },
      },
      archive: {
        put: async (key, body) => {
          archiveGate.calls += 1;
          await archiveGate.opened;
          archive.set(key, body);
        },
      },
      players: {
        wake: async (request) => {
          wakes.push(request);
        },
      },
      run: {
        charge: async (_runId, _gameId, key) => {
          if (failures.charge > 0) {
            failures.charge -= 1;
            throw new Error("RunDO unavailable");
          }

          charges.push(key);

          return { exhausted: options.exhaustAfterCharge === true };
        },
        gameFinished: async (_runId, outcome) => {
          outcomes.push(outcome);
        },
      },
      broadcast: (message) => {
        broadcasts.push(message);
      },
      setAlarm: async (at) => {
        alarm = at;
      },
      now: () => clock.now,
      log: () => {},
      stepsPerAlarm: options.stepsPerAlarm ?? 400,
    },
    engineBinding,
  );

  const seats = planSeats(specs);

  const start: GameStart = {
    gameId: "g1",
    runId: "r1",
    gameIndex: 0,
    config: createConfig({
      gameId: "g1",
      seed: "42",
      seats: seats.map((seat) => ({
        seat: seat.seat,
        label: seat.label,
        competitorId: seat.competitorId,
      })),
      rules: { maxRounds: options.maxRounds ?? 3 },
    }),
    seats,
    listings: [],
    budgetExhausted: false,
  };

  /** Run due alarms, as the runtime would. */
  const drain = async (limit = 200): Promise<void> => {
    for (let index = 0; index < limit; index += 1) {
      const due = alarm;

      if (due === null || due > clock.now) return;

      alarm = null;
      alarmsRun += 1;
      await host.alarm();
    }
  };

  const call = (
    request: WakeRequest,
    callId: string,
    tool: SeatCall["tool"],
    args: SeatCall["args"] = {},
  ): SeatCall => ({
    gameId: request.gameId,
    seat: request.seat,
    decisionId: request.decisionId,
    callId,
    tool,
    args,
  });

  /** The latest wake that is still open (the game may have moved past older ones). */
  const lastWake = (): WakeRequest => {
    const wake = wakes.at(-1);

    if (wake === undefined) throw new Error("no wake dispatched");

    return wake;
  };

  return {
    host,
    sql,
    start,
    wakes,
    charges,
    outcomes,
    finishes,
    wakeRows,
    archive,
    broadcasts,
    clock,
    drain,
    call,
    lastWake,
    hooks,
    archiveGate,
    alarmsRun: () => alarmsRun,
    pendingAlarm: () => alarm,
  };
};

const transcriptFor = (request: WakeRequest): WakeTranscript =>
  WakeTranscript.make({
    gameId: request.gameId,
    seat: request.seat,
    decisionId: request.decisionId,
    turn: request.turn,
    frame: request.frame,
    round: request.round,
    reasons: request.reasons,
    startedAt: "2026-10-28T00:00:00.000Z",
    finishedAt: "2026-10-28T00:00:05.000Z",
    prompt: request.message,
    reasoning: "",
    text: "",
    toolCalls: [],
    usage: { inputTokens: 100, outputTokens: 20, reasoningTokens: 0, costUsd: 0.25 },
    invalidActions: 0,
    timedOut: false,
  });

const report = (request: WakeRequest, endReason = "unanswered") => ({
  gameId: request.gameId,
  seat: request.seat,
  decisionId: request.decisionId,
  transcript: transcriptFor(request),
  latencyMs: 5000,
  endReason,
  compactions: 0,
});

describe("GameHost with the real engine", () => {
  it("plays a bot-only Monopoly game to the end, archives it and notifies the run", async () => {
    const h = setup([heuristic(), random(), heuristic()], { maxRounds: 12 });

    await h.host.start(h.start);
    await h.drain();

    expect(h.host.status()).toBe("finished");
    expect(h.wakes).toHaveLength(0);
    expect(h.outcomes).toHaveLength(1);
    expect(h.outcomes[0]?.status).toBe("finished");
    expect(h.outcomes[0]?.results.map((result) => result.rank).sort()).toEqual([1, 2, 3]);
    expect(h.finishes[0]?.endReason).toMatch(/turnCap|lastPlayerStanding/);
    expect(h.finishes[0]?.seats.some((seat) => seat.propertiesBought > 0)).toBe(true);

    const eventsFile = h.archive.get(archiveKeys.events("g1")) ?? "";
    expect(eventsFile).toBe(h.host.eventsSince(0));

    // The archive is enough to rebuild the game: config.json + events.jsonl → replay.
    const config = decodeConfig(h.archive.get(archiveKeys.config("g1")) ?? "");

    const events = eventsFile
      .trim()
      .split("\n")
      .map((line) => decodeEvent(line));

    const replayed = replay(config, events);

    expect(replayed.status).toBe("finished");
    expect(standings(replayed).map((row) => row.seat)).toEqual(
      [...(h.finishes[0]?.seats ?? [])]
        .sort((a, b) => (a.rank ?? 9) - (b.rank ?? 9))
        .map((seat) => seat.seat),
    );
    expect(h.archive.has(archiveKeys.summary("g1"))).toBe(true);
    expect(h.archive.has(archiveKeys.seat("g1", "A"))).toBe(true);

    const last = decodeMessage(h.broadcasts.at(-1) ?? "");
    expect(SpectatorMessage.guards.Status(last)).toBe(true);
    expect(JSON.parse(h.host.config() ?? "{}")).toMatchObject({ gameId: "g1", seed: "42" });
  });

  it("yields to fresh alarms on long bot games and resumes from snapshot + events", async () => {
    const h = setup([random(), random()], { maxRounds: 120, stepsPerAlarm: 25 });

    await h.host.start(h.start);

    const early = h.sql.exec("SELECT seq, json FROM snapshot WHERE id = 1")[0];

    await h.drain(1);

    expect(h.host.status()).toBe("running");
    expect(h.alarmsRun()).toBe(1);

    // Simulate a reset before the snapshot was flushed: an old snapshot plus newer events.
    h.sql.exec(
      "UPDATE snapshot SET seq = ?, json = ? WHERE id = 1",
      early?.["seq"] ?? 0,
      early?.["json"] ?? "",
    );

    // A new object over the same storage (as after an eviction) continues the same game.
    const resumed = new GameHost(
      {
        sql: h.sql,
        db: {
          markRunning: async () => {},
          progress: async () => {},
          recordWake: async () => {},
          finish: async () => {},
        },
        archive: { put: async () => {} },
        players: { wake: async () => {} },
        run: { charge: async () => ({ exhausted: false }), gameFinished: async () => {} },
        broadcast: () => {},
        setAlarm: async () => {},
        now: () => h.clock.now,
        log: () => {},
      },
      engineBinding,
    );

    expect(decodeMessage(resumed.helloMessage("g1"))).toEqual(
      decodeMessage(h.host.helloMessage("g1")),
    );

    for (let index = 0; index < 500 && resumed.status() === "running"; index += 1) {
      await resumed.alarm();
    }

    expect(resumed.status()).toBe("finished");
  });

  it("is idempotent on start", async () => {
    const h = setup([random(), random()]);

    await h.host.start(h.start);
    await h.host.start(h.start);

    expect(
      h.host
        .eventsSince(0)
        .split("\n")
        .filter((line) => line.includes('"GameStarted"')),
    ).toHaveLength(1);
  });

  it("wakes LLM seats with the system prompt and wake message, and applies their answers once", async () => {
    const h = setup([llm("Opus"), random()]);

    await h.host.start(h.start);
    await h.drain();

    const wake = h.lastWake();

    expect(wake.seat).toBe("A");
    expect(wake.frame).toBe("Table");
    expect(wake.message).toContain("You are seat A (Opus)");
    expect(wake.message).toContain("## Decision");
    expect(wake.systemPrompt).toContain("Declared variants");
    expect(wake.systemPrompt).toContain("after 3 full rounds");
    expect(wake.deadline).toBe(h.clock.now + 180_000 + WAKE_GRACE_MS);

    const seen = await h.host.inspect(
      h.call(wake, "c1", "inspect", { topic: "deed", subject: 39 }),
    );

    expect(seen).toMatchObject({ ok: true, terminal: false });
    expect(seen.message).toContain("Boardwalk (39, boardwalk)");

    const noted = await h.host.submit(h.call(wake, "c2", "note", { text: "Roll high." }));
    expect(noted).toEqual({ ok: true, message: "Notes saved (10 characters).", terminal: false });

    const illegal = await h.host.submit(h.call(wake, "c3", "build", { property: "boardwalk" }));
    expect(illegal.ok).toBe(false);
    expect(illegal.terminal).toBe(false);
    expect(illegal.message).not.toContain("Invalid arguments");

    const unknownDeed = await h.host.submit(
      h.call(wake, "c4", "mortgage", { property: "Park Lane" }),
    );

    expect(unknownDeed.message).toContain("Unknown deed");

    const malformed = await h.host.submit(h.call(wake, "c5", "bid", { amount: "lots" }));
    expect(malformed).toEqual({
      ok: false,
      message: "Invalid arguments for bid.",
      terminal: false,
    });

    const eventsBefore = h.host.eventsSince(0);
    const answered = await h.host.done(h.call(wake, "c6", "done"));
    expect(answered).toMatchObject({ ok: true, terminal: true });

    const eventsAfter = h.host.eventsSince(0);
    expect(eventsAfter.length).toBeGreaterThan(eventsBefore.length);

    // Same idempotency key: the stored answer, nothing applied twice.
    expect(await h.host.done(h.call(wake, "c6", "done"))).toEqual(answered);
    expect(h.host.eventsSince(0)).toBe(eventsAfter);

    // Another call on the answered decision: refused and terminal.
    const late = await h.host.done(h.call(wake, "c7", "done"));
    expect(late).toMatchObject({ ok: false, terminal: true });

    await h.drain();

    const next = h.lastWake();
    expect(next.decisionId).not.toBe(wake.decisionId);
    expect(next.message).toContain("Roll high.");
  });

  it("applies the default at the deadline and records a timed-out wake with no report", async () => {
    const h = setup([llm("Opus"), random()]);

    await h.host.start(h.start);
    await h.drain();

    const wake = h.lastWake();
    const before = h.wakes.length;

    h.clock.now = wake.deadline + 1;
    await h.drain();

    expect(h.host.eventsSince(0)).toContain('"SeatTimedOut"');
    expect(h.wakeRows).toHaveLength(1);
    expect(h.wakeRows[0]).toMatchObject({
      decisionId: wake.decisionId,
      timedOut: true,
      endReason: "noReport",
      costUsd: 0,
      competitorId: "example/model",
    });
    expect(h.wakes.length).toBeGreaterThan(before);

    // The late report replaces the row with its real usage and stays a timeout.
    await h.host.wakeFinished(report(wake));
    expect(h.wakeRows.at(-1)).toMatchObject({
      decisionId: wake.decisionId,
      timedOut: true,
      costUsd: 0.25,
    });

    const stale = await h.host.done(h.call(wake, "late", "done"));
    expect(stale).toMatchObject({ ok: false, terminal: true });
  });

  it("records a finished wake once, charges the run and defaults an unanswered decision", async () => {
    const h = setup([llm("Opus"), random()]);

    await h.host.start(h.start);
    await h.drain();

    const wake = h.lastWake();

    await h.host.wakeFinished(report(wake));
    await h.host.wakeFinished(report(wake));
    await h.drain();

    expect(h.wakeRows).toHaveLength(1);
    expect(h.wakeRows[0]).toMatchObject({ seat: "A", costUsd: 0.25, timedOut: false });
    expect(h.charges).toEqual([`g1:A:${wake.decisionId}`]);
    expect(h.host.eventsSince(0)).toContain('"SeatTimedOut"');
    expect(h.host.transcripts("A").trim().split("\n")).toHaveLength(1);
    expect(h.host.transcripts("B")).toBe("");
    expect(h.lastWake().decisionId).not.toBe(wake.decisionId);
  });

  it("finishes a wake report that a crash cut off half-way", async () => {
    const h = setup([llm("Opus"), random()]);

    await h.host.start(h.start);
    await h.drain();

    const wake = h.lastWake();

    // A previous attempt stored the transcript, then the object was reset.
    h.sql.exec(
      "INSERT INTO transcripts (seat, decision_id, at, json) VALUES (?, ?, ?, ?)",
      wake.seat,
      wake.decisionId,
      1,
      "{}",
    );
    await h.host.wakeFinished(report(wake));
    await h.drain();

    expect(h.wakeRows).toHaveLength(1);
    expect(h.charges).toEqual([`g1:A:${wake.decisionId}`]);
    expect(h.lastWake().decisionId).not.toBe(wake.decisionId);
  });

  it("keeps a report unprocessed until its accounting is written, so retries record it (F2)", async () => {
    const h = setup([llm("Opus"), random()], { failRecordWake: 1, failCharge: 1 });

    await h.host.start(h.start);
    await h.drain();

    const wake = h.lastWake();

    await expect(h.host.wakeFinished(report(wake))).rejects.toThrow("D1 unavailable");
    await expect(h.host.wakeFinished(report(wake))).rejects.toThrow("RunDO unavailable");
    await h.host.wakeFinished(report(wake));
    await h.host.wakeFinished(report(wake));

    expect(new Set(h.wakeRows.map((row) => row.decisionId))).toEqual(new Set([wake.decisionId]));
    expect(h.charges).toEqual([`g1:A:${wake.decisionId}`]);
  });

  /** Every LLM decision runs out its deadline until the turn cap ends the game. */
  const playToTurnCap = async (h: ReturnType<typeof setup>): Promise<void> => {
    await h.host.start(h.start);
    await h.drain();

    for (let guard = 0; guard < 100 && h.outcomes.length === 0; guard += 1) {
      h.clock.now = h.lastWake().deadline + 1;
      await h.drain();
    }

    expect(h.outcomes).toHaveLength(1);
  };

  it("refreshes a seat's archived transcripts when its report arrives after the game ended (F4)", async () => {
    const h = setup([llm("Opus"), random()], { maxRounds: 1 });

    await playToTurnCap(h);
    expect(h.archive.get(archiveKeys.seat("g1", "A"))).toBe("");

    const late = h.lastWake();

    await h.host.wakeFinished(report(late));
    await h.drain();

    expect(h.archive.get(archiveKeys.seat("g1", "A"))).toContain(
      `"decisionId":"${late.decisionId}"`,
    );
  });

  it("refreshes transcripts reported while the game was being archived (F4)", async () => {
    const h = setup([llm("Opus"), random()], { maxRounds: 1 });
    const reported: Array<string> = [];

    h.hooks.duringFinish = async () => {
      const late = h.lastWake();

      reported.push(late.decisionId);
      h.hooks.duringFinish = null;
      await h.host.wakeFinished(report(late));
    };

    await playToTurnCap(h);
    await h.drain();

    expect(reported).toHaveLength(1);
    expect(h.archive.get(archiveKeys.seat("g1", "A"))).toContain(`"decisionId":"${reported[0]}"`);
  });

  it("aborts the game instead of waking once the budget is exhausted", async () => {
    const h = setup([llm("Opus"), random()], { exhaustAfterCharge: true });

    await h.host.start(h.start);
    await h.drain();

    const wake = h.lastWake();
    const before = h.wakes.length;

    await h.host.wakeFinished(report(wake, "answered"));
    await h.drain();

    expect(h.wakes).toHaveLength(before);
    expect(h.host.status()).toBe("aborted");
    expect(h.outcomes[0]?.status).toBe("aborted");
    expect(h.outcomes[0]?.results.every((result) => result.rank === null)).toBe(true);
  });

  it("aborts the game once a seat's model fails wakes in a row, and says why", async () => {
    const h = setup([llm("Kimi"), llm("Sol")]);
    const reported = new Set<string>();

    await h.host.start(h.start);
    await h.drain();

    const send = async (request: WakeRequest, endReason: string, text = ""): Promise<void> => {
      reported.add(`${request.seat}:${request.decisionId}`);
      await h.host.wakeFinished({
        ...report(request, endReason),
        transcript: { ...transcriptFor(request), text },
      });
      await h.drain();
    };

    const openWake = (seat: string): WakeRequest | undefined =>
      h.wakes.findLast(
        (wake) => wake.seat === seat && !reported.has(`${wake.seat}:${wake.decisionId}`),
      );

    /** Seat A's next open wake; seat B answers until there is one. */
    const kimiWake = async (): Promise<WakeRequest> => {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const wake = openWake("A");

        if (wake !== undefined) return wake;

        const other = openWake("B");

        if (other === undefined) break;

        await send(other, "answered");
      }

      throw new Error("seat A was never woken");
    };

    const modelError =
      "[model error] 402: requires more credits, visit https://openrouter.ai/keys/abc";

    // Two failures, an answered wake, then failures again: only a run of them in a row counts.
    for (const endReason of ["modelError", "modelError", "answered"]) {
      await send(await kimiWake(), endReason, endReason === "modelError" ? modelError : "");
    }

    for (let failures = 0; failures < MAX_CONSECUTIVE_MODEL_ERRORS; failures += 1) {
      expect(h.host.status()).toBe("running");

      await send(await kimiWake(), "modelError", modelError);
    }

    expect(h.host.status()).toBe("aborted");
    expect(h.outcomes[0]?.status).toBe("aborted");
    expect(h.finishes[0]?.abortReason).toBe(
      "Kimi's model failed 3 wakes in a row: 402: requires more credits, visit <url>",
    );
  });

  it("aborts on request and greets spectators with the current sequence", async () => {
    const h = setup([llm("Opus"), llm("Sol")]);

    await h.host.start(h.start);
    await h.drain();

    const hello = decodeMessage(h.host.helloMessage("g1"));

    expect(
      SpectatorMessage.guards.Hello(hello) && hello.lastSeq > 0 && hello.status === "running",
    ).toBe(true);

    await h.host.abort("run cancelled");
    await h.drain();

    expect(h.host.status()).toBe("aborted");
    expect(h.finishes[0]?.endReason).toBe("aborted");
  });

  it("waits for archive writes in flight before a purge returns (F3)", async () => {
    const h = setup([random(), random()], { maxRounds: 1, holdArchive: true });
    const order: Array<string> = [];

    await h.host.start(h.start);

    const draining = h.drain();

    for (let tick = 0; tick < 500 && h.archiveGate.calls === 0; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    expect(h.archiveGate.calls).toBeGreaterThan(0);

    const purged = h.host.purge().then(() => order.push("purged"));

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(order).toEqual([]);

    order.push("released");
    h.archiveGate.release();
    await purged;
    await draining;

    expect(order).toEqual(["released", "purged"]);
  });

  it("forgets a purged game: nothing stored, no alarm, late reports and calls write nothing", async () => {
    const h = setup([llm("Opus"), llm("Sol")]);

    await h.host.start(h.start);
    await h.drain();

    const wake = h.lastWake();

    await h.host.submit(h.call(wake, "c1", "note", { text: "Keep oranges." }));
    await h.host.purge();

    const tables = h.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'");

    for (const table of tables) {
      expect(h.sql.exec(`SELECT * FROM ${String(table["name"])}`)).toEqual([]);
    }

    expect(h.pendingAlarm()).toBeNull();

    // A wake still in flight reports and calls after the deletion: nothing is written.
    await h.host.wakeFinished(report(wake, "answered"));

    expect(await h.host.done(h.call(wake, "c2", "done"))).toMatchObject({
      ok: false,
      terminal: true,
    });

    await h.host.alarm();
    await h.drain();

    expect(h.wakeRows).toHaveLength(0);
    expect(h.charges).toHaveLength(0);
    expect(h.outcomes).toHaveLength(0);
    expect(h.finishes).toHaveLength(0);
    expect(h.archive.size).toBe(0);
    expect(h.sql.exec("SELECT * FROM calls")).toEqual([]);
    expect(h.host.status()).toBe("queued");
  });
});
