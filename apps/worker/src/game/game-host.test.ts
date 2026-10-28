import { DEFAULT_WAKE_LIMITS } from "@mb/agent";
import { BotSeat, LlmSeat, type SeatSpec, WakeTranscript } from "@mb/api";
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
import { archiveKeys, GameHost, MAX_STEPS_PER_SETTLE, WAKE_GRACE_MS } from "./game-host.ts";
import { stubEngineBinding } from "./stub-engine.ts";

const decodeMessage = Schema.decodeUnknownSync(Schema.fromJsonString(SpectatorMessage));

const llm = (label: string) => LlmSeat.make({ model: "example/model", label });

const bot = () => BotSeat.make({ policy: "random" });

interface Options {
  readonly maxRounds?: number;
  readonly exhaustAfterCharge?: boolean;
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

  const host = new GameHost(
    {
      sql,
      db: {
        markRunning: async () => {},
        progress: async () => {},
        recordWake: async (row) => {
          wakeRows.push(row);
        },
        finish: async (game) => {
          finishes.push(game);
        },
      },
      archive: {
        put: async (key, body) => {
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
    },
    stubEngineBinding,
  );

  const start: GameStart = {
    gameId: "g1",
    runId: "r1",
    gameIndex: 0,
    seed: "42",
    playersCount: specs.length,
    seats: planSeats(specs),
    maxRounds: options.maxRounds ?? 1,
    tableFrequency: "everyTurn",
    limits: DEFAULT_WAKE_LIMITS,
    listings: [],
    budgetExhausted: false,
  };

  /** Run due alarms, as the runtime would. */
  const drain = async (limit = 100): Promise<void> => {
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
    alarmsRun: () => alarmsRun,
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

describe("GameHost", () => {
  it("plays a bot-only game to the end, archives it and notifies the run", async () => {
    const h = setup([bot(), bot(), bot()], { maxRounds: 3 });

    await h.host.start(h.start);
    await h.drain();

    expect(h.host.status()).toBe("finished");
    expect(h.wakes).toHaveLength(0);
    expect(h.outcomes).toHaveLength(1);

    const outcome = h.outcomes[0];
    expect(outcome?.status).toBe("finished");
    expect(outcome?.results.map((result) => result.rank).sort()).toEqual([1, 2, 3]);
    expect(h.finishes[0]?.endReason).toBe("turnCap");
    expect(h.finishes[0]?.winnerSeat).not.toBeNull();

    const events = h.archive.get(archiveKeys.events("g1")) ?? "";
    expect(events).toBe(h.host.eventsSince(0));
    expect(events.trim().split("\n").length).toBeGreaterThan(9);
    expect(h.archive.has(archiveKeys.summary("g1"))).toBe(true);
    expect(h.archive.has(archiveKeys.seat("g1", "A"))).toBe(true);

    const last = decodeMessage(h.broadcasts.at(-1) ?? "");
    expect(SpectatorMessage.guards.Status(last)).toBe(true);
  });

  it("yields to a fresh alarm every MAX_STEPS_PER_SETTLE bot moves", async () => {
    const h = setup([bot(), bot()], { maxRounds: 200 });

    await h.host.start(h.start);
    await h.drain(1000);

    expect(h.host.status()).toBe("finished");
    // 400 turns × 2 bot moves, at most MAX_STEPS_PER_SETTLE per alarm.
    expect(h.alarmsRun()).toBeGreaterThanOrEqual(Math.ceil((400 * 2) / MAX_STEPS_PER_SETTLE));
  });

  it("is idempotent on start", async () => {
    const h = setup([bot(), bot()]);

    await h.host.start(h.start);
    await h.host.start({ ...h.start, seed: "other" });

    expect(
      h.host
        .eventsSince(0)
        .split("\n")
        .filter((line) => line.includes("GameStarted")),
    ).toHaveLength(1);
  });

  it("wakes LLM seats with the system prompt and wake message, and applies their answers once", async () => {
    const h = setup([llm("Opus"), bot()]);

    await h.host.start(h.start);
    await h.drain();

    expect(h.wakes).toHaveLength(1);

    const wake = h.wakes[0];

    if (wake === undefined) throw new Error("no wake");

    expect(wake.seat).toBe("A");
    expect(wake.decisionId).toBe("1.1.A");
    expect(wake.message).toContain("You are seat A");
    expect(wake.message).toContain("B: Bot (random)");
    expect(wake.systemPrompt).toContain("Declared variants");
    expect(wake.deadline).toBe(h.clock.now + DEFAULT_WAKE_LIMITS.wakeTimeoutMs + WAKE_GRACE_MS);

    const seen = await h.host.inspect(h.call(wake, "c1", "inspect", { topic: "table" }));
    expect(seen.ok).toBe(true);
    expect(seen.terminal).toBe(false);

    const noted = await h.host.submit(h.call(wake, "c2", "note", { text: "Roll high." }));
    expect(noted).toEqual({ ok: true, message: "Notes saved (10 characters).", terminal: false });

    const illegal = await h.host.submit(h.call(wake, "c3", "buy"));
    expect(illegal.ok).toBe(false);
    expect(illegal.terminal).toBe(false);

    const malformed = await h.host.submit(h.call(wake, "c4", "bid", { amount: "lots" }));
    expect(malformed).toEqual({
      ok: false,
      message: "Invalid arguments for bid.",
      terminal: false,
    });

    const eventsBefore = h.host.eventsSince(0);
    const answered = await h.host.done(h.call(wake, "c5", "done"));
    expect(answered.ok).toBe(true);
    expect(answered.terminal).toBe(true);

    const eventsAfter = h.host.eventsSince(0);
    expect(eventsAfter.length).toBeGreaterThan(eventsBefore.length);

    // Same idempotency key: the stored answer, nothing applied twice.
    expect(await h.host.done(h.call(wake, "c5", "done"))).toEqual(answered);
    expect(h.host.eventsSince(0)).toBe(eventsAfter);

    // Another call on the answered decision: refused and terminal.
    const late = await h.host.done(h.call(wake, "c6", "done"));
    expect(late.ok).toBe(false);
    expect(late.terminal).toBe(true);

    await h.drain();

    expect(h.wakes).toHaveLength(2);
    expect(h.wakes[1]?.decisionId).toBe("2.1.A");
    expect(h.wakes[1]?.message).toContain("Roll high.");
    expect(h.wakes[1]?.message).toContain("rolled");

    const second = h.wakes[1];

    if (second === undefined) throw new Error("no second wake");

    await h.host.done(h.call(second, "c7", "done"));
    await h.drain();

    expect(h.host.status()).toBe("finished");
    expect(h.outcomes[0]?.results.every((result) => result.rank !== null)).toBe(true);
  });

  it("applies the default action at the deadline", async () => {
    const h = setup([llm("Opus"), bot()]);

    await h.host.start(h.start);
    await h.drain();

    const wake = h.wakes[0];

    if (wake === undefined) throw new Error("no wake");

    h.clock.now = wake.deadline + 1;
    await h.drain();

    expect(h.host.eventsSince(0)).toContain('"timedOut":true');
    expect(h.wakes[1]?.decisionId).toBe("2.1.A");

    const stale = await h.host.done(h.call(wake, "late", "done"));
    expect(stale).toMatchObject({ ok: false, terminal: true });
  });

  it("records a finished wake once, charges the run and defaults an unanswered decision", async () => {
    const h = setup([llm("Opus"), bot()]);

    await h.host.start(h.start);
    await h.drain();

    const wake = h.wakes[0];

    if (wake === undefined) throw new Error("no wake");

    const report = {
      gameId: wake.gameId,
      seat: wake.seat,
      decisionId: wake.decisionId,
      transcript: transcriptFor(wake),
      latencyMs: 5000,
      endReason: "unanswered",
    };

    await h.host.wakeFinished(report);
    await h.host.wakeFinished(report);
    await h.drain();

    expect(h.wakeRows).toHaveLength(1);
    expect(h.wakeRows[0]).toMatchObject({
      seat: "A",
      costUsd: 0.25,
      competitorId: "example/model",
    });
    expect(h.charges).toEqual(["g1:A:1.1.A"]);
    expect(h.host.eventsSince(0)).toContain('"timedOut":true');
    expect(h.wakes[1]?.decisionId).toBe("2.1.A");

    const second = h.wakes[1];

    if (second === undefined) throw new Error("no second wake");

    await h.host.done(h.call(second, "x", "done"));
    await h.drain();

    const seats = h.archive.get(archiveKeys.seat("g1", "A")) ?? "";
    expect(seats.trim().split("\n")).toHaveLength(1);
    expect(seats).toContain('"decisionId":"1.1.A"');
  });

  it("aborts the game instead of waking once the budget is exhausted", async () => {
    const h = setup([llm("Opus"), bot()], { exhaustAfterCharge: true });

    await h.host.start(h.start);
    await h.drain();

    const wake = h.wakes[0];

    if (wake === undefined) throw new Error("no wake");

    await h.host.wakeFinished({
      gameId: wake.gameId,
      seat: wake.seat,
      decisionId: wake.decisionId,
      transcript: transcriptFor(wake),
      latencyMs: 10,
      endReason: "answered",
    });
    await h.drain();

    expect(h.wakes).toHaveLength(1);
    expect(h.host.status()).toBe("aborted");
    expect(h.outcomes[0]?.status).toBe("aborted");
    expect(h.outcomes[0]?.results.every((result) => result.rank === null)).toBe(true);
  });

  it("aborts on request and greets spectators with the current sequence", async () => {
    const h = setup([llm("Opus"), llm("Sol")]);

    await h.host.start(h.start);
    await h.drain();

    const hello = decodeMessage(h.host.helloMessage());
    expect(
      SpectatorMessage.guards.Hello(hello) && hello.lastSeq > 0 && hello.status === "running",
    ).toBe(true);

    await h.host.abort("run cancelled");
    await h.drain();

    expect(h.host.status()).toBe("aborted");
    expect(h.finishes[0]?.endReason).toBe("aborted");
  });
});
