import {
  buildSystemPrompt,
  COMPACTION_PROMPT,
  DEFAULT_MEMORY_LIMITS,
  DEFAULT_WAKE_LIMITS,
  type MemoryLimits,
} from "@mb/agent";
import {
  fauxAssistantMessage,
  type FauxResponseStep,
  fauxThinking,
  fauxToolCall,
  scriptedModel,
  toolTurn,
} from "@mb/agent/testing";
import { LlmSeat, type SeatActivity } from "@mb/api";
import { defaultRules } from "@mb/engine";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";

import type { SeatCall, WakeReport, WakeRequest } from "../contracts.ts";
import { port, run } from "../testing/effect.ts";
import { memorySqlPort } from "../testing/sqlite.ts";
import { openRouterKeyFor, PlayerHost } from "./player-host.ts";

const request = (decisionId: string, deadline: number): WakeRequest => ({
  gameId: "g1",
  runId: "r1",
  seat: "B",
  decisionId,
  turn: 3,
  frame: "Table",
  round: 1,
  reasons: ["round1"],
  spec: LlmSeat.make({ model: "example/model", label: "Example", reasoning: "low" }),
  listing: null,
  systemPrompt: buildSystemPrompt(defaultRules(), 2),
  message: `Wake ${decisionId}`,
  limits: DEFAULT_WAKE_LIMITS,
  deadline,
});

interface Options {
  readonly apiKey?: string;
  readonly memory?: MemoryLimits;
}

const setup = (responses: ReadonlyArray<FauxResponseStep>, options: Options = {}) => {
  const scripted = scriptedModel(responses);
  const sql = memorySqlPort();
  const calls: Array<{ readonly kind: string; readonly call: SeatCall }> = [];
  const reports: Array<WakeReport> = [];
  const activity: Array<SeatActivity> = [];
  const alarms: Array<number | null> = [];
  const clock = { now: 1_000 };

  const answer = (kind: string, call: SeatCall) =>
    Effect.sync(() => {
      calls.push({ kind, call });

      return { ok: true, message: `${call.tool} ok`, terminal: call.tool === "done" };
    });

  let failReports = 0;

  const host = () =>
    new PlayerHost({
      sql,
      game: {
        submit: (call) => answer("submit", call),
        done: (call) => answer("done", call),
        inspect: (call) => answer("inspect", call),
        activity: (_gameId, event) =>
          Effect.sync(() => {
            activity.push(event);
          }),
        wakeFinished: port((report: WakeReport) => {
          if (failReports > 0) {
            failReports -= 1;
            throw new Error("GameDO unreachable");
          }

          reports.push(report);
        }),
      },
      models: () =>
        Effect.succeed({
          model: scripted.model,
          streamFn: scripted.streamFn,
          apiKey: options.apiKey ?? "test",
        }),
      setAlarm: (at) =>
        Effect.sync(() => {
          alarms.push(at);
        }),
      now: () => clock.now,
      memory: options.memory ?? DEFAULT_MEMORY_LIMITS,
    });

  return {
    host: host(),
    /** A new object over the same storage, as after an eviction. */
    reopen: host,
    sql,
    scripted,
    calls,
    reports,
    activity,
    alarms,
    clock,
    failNextReports: (count: number) => {
      failReports = count;
    },
  };
};

/** Answers every wake with `done`, the compaction instruction with a summary. */
const done: FauxResponseStep = (context) => {
  const last = context.messages.at(-1);

  const asksSummary =
    last?.role === "user" && JSON.stringify(last.content).includes("Memory compaction.");

  return asksSummary
    ? fauxAssistantMessage("Summary: B owns the oranges.")
    : toolTurn(fauxToolCall("done", {}));
};

describe("PlayerHost", () => {
  it("acknowledges a wake at once and runs it from the alarm", async () => {
    const h = setup([
      fauxAssistantMessage(
        [
          fauxThinking("Just finish."),
          fauxToolCall("note", { text: "n" }),
          fauxToolCall("done", {}),
        ],
        {
          stopReason: "toolUse",
        },
      ),
    ]);

    await run(h.host.wake(request("d1", 999_999)));

    expect(h.alarms).toEqual([1_000]);
    expect(h.calls).toHaveLength(0);

    await run(h.host.alarm());

    expect(h.calls.map((entry) => [entry.kind, entry.call.tool])).toEqual([
      ["submit", "note"],
      ["done", "done"],
    ]);
    expect(h.calls[0]?.call).toMatchObject({ gameId: "g1", seat: "B", decisionId: "d1" });
    expect(h.reports).toHaveLength(1);

    const report = h.reports[0];
    expect(report?.endReason).toBe("answered");
    expect(report?.compactions).toBe(0);
    expect(report?.transcript.prompt).toBe("Wake d1");
    expect(report?.transcript.reasoning).toBe("Just finish.");
    expect(report?.transcript.toolCalls).toHaveLength(2);
    expect(report?.transcript.usage.costUsd).toBeGreaterThan(0);
    expect(h.activity.length).toBeGreaterThan(0);

    // Running the alarm again does nothing: the wake is done.
    await run(h.host.alarm());
    expect(h.reports).toHaveLength(1);
  });

  it("ignores a duplicate wake request", async () => {
    const h = setup([toolTurn(fauxToolCall("done", {}))]);

    await run(h.host.wake(request("d1", 999_999)));
    await run(h.host.wake(request("d1", 999_999)));
    await run(h.host.alarm());

    expect(h.reports).toHaveLength(1);
    expect(h.scripted.faux.state.callCount).toBe(1);
  });

  it("keeps one conversation for the whole game, across decisions and evictions", async () => {
    const lengths: Array<number> = [];

    const respond: FauxResponseStep = (context) => {
      lengths.push(context.messages.length);

      return toolTurn(fauxToolCall("done", {}));
    };

    const h = setup([respond, respond, respond]);

    await run(h.host.wake(request("d1", 999_999)));
    await run(h.host.alarm());
    await run(h.host.wake(request("d2", 999_999)));
    await run(h.host.alarm());

    // A new object over the same storage continues the same conversation.
    const reopened = h.reopen();

    await run(reopened.wake(request("d3", 999_999)));
    await run(reopened.alarm());

    // system + wake: 2, then each wake adds its answer, the tool result and its own message.
    expect(lengths).toEqual([2, 5, 8]);
    expect(reopened.conversation().wakeStarts).toEqual([1, 4, 7]);
    expect(h.sql.exec("SELECT COUNT(*) AS n FROM conversation")).toEqual([{ n: 10 }]);
  });

  it("stores a compacted conversation and reports the compaction", async () => {
    const memory: MemoryLimits = { compactAtTokens: 1, keepRecentWakes: 2, summaryMaxTokens: 500 };

    const h = setup(
      Array.from({ length: 10 }, () => done),
      { memory },
    );

    for (const decisionId of ["d1", "d2", "d3", "d4"]) {
      await run(h.host.wake(request(decisionId, 999_999)));
      await run(h.host.alarm());
    }

    const last = h.reports.at(-1);

    expect(h.reports.map((report) => report.compactions)).toEqual([0, 0, 0, 1]);
    expect(last?.transcript.text).toContain("[memory] 1 earlier wakes were summarized");
    expect(last?.transcript.text).toContain("Summary: B owns the oranges.");

    const stored = h.host.conversation();

    expect(stored.wakeStarts).toEqual([2, 5, 8]);
    expect(JSON.stringify(stored.messages[1])).toContain("Summary: B owns the oranges.");
    expect(JSON.stringify(stored.messages)).not.toContain("Wake d1");
    expect(JSON.stringify(stored.messages)).not.toContain(COMPACTION_PROMPT);
  });

  it("does not call the model after the deadline", async () => {
    const h = setup([toolTurn(fauxToolCall("done", {}))]);

    await run(h.host.wake(request("d1", 500)));
    await run(h.host.alarm());

    expect(h.scripted.faux.state.callCount).toBe(0);
    expect(h.reports[0]?.endReason).toBe("expired");
  });

  it("re-sends a stored report until GameDO takes it", async () => {
    const h = setup([toolTurn(fauxToolCall("done", {}))]);
    h.failNextReports(1);

    await run(h.host.wake(request("d1", 999_999)));
    await run(h.host.alarm());

    expect(h.reports).toHaveLength(0);
    expect(h.alarms.at(-1)).toBe(11_000);

    await run(h.host.alarm());

    expect(h.reports).toHaveLength(1);
    expect(h.reports[0]?.endReason).toBe("answered");
    expect(h.scripted.faux.state.callCount).toBe(1);
  });

  it("scrubs the wake's OpenRouter key from its report", async () => {
    const key = "sk-or-v1-secret-own-key";

    const h = setup(
      [fauxAssistantMessage([], { stopReason: "error", errorMessage: `401 for key ${key}` })],
      { apiKey: key },
    );

    await run(h.host.wake(request("d1", 999_999)));
    await run(h.host.alarm());

    const text = h.reports[0]?.transcript.text ?? "";

    expect(h.reports[0]?.endReason).toBe("modelError");
    expect(text).toContain("[redacted key]");
    expect(JSON.stringify(h.reports)).not.toContain(key);
    expect(JSON.stringify(h.sql.exec("SELECT * FROM wakes"))).not.toContain(key);
    expect(JSON.stringify(h.sql.exec("SELECT * FROM conversation"))).not.toContain(key);
  });

  it("forgets everything when purged; a wake still running writes nothing", async () => {
    const h = setup([toolTurn(fauxToolCall("done", {}))]);

    await run(h.host.wake(request("d1", 999_999)));
    await run(h.host.alarm());
    await run(h.host.wake(request("d2", 999_999)));
    await run(h.host.purge());

    expect(h.sql.exec("SELECT * FROM wakes")).toEqual([]);
    expect(h.sql.exec("SELECT * FROM conversation")).toEqual([]);
    expect(h.alarms.at(-1)).toBeNull();

    await run(h.host.alarm());

    expect(h.reports).toHaveLength(1);
  });
});

describe("own-key runs", () => {
  it("call OpenRouter with the run's key, never the server's", () => {
    expect(openRouterKeyFor({ funding: "server", openRouterKey: null }, "server-key")).toBe(
      "server-key",
    );
    expect(openRouterKeyFor({ funding: "server", openRouterKey: null }, "")).toBeUndefined();
    expect(openRouterKeyFor({ funding: "ownKey", openRouterKey: "own" }, "server-key")).toBe("own");
    // No key left, or the run is no longer active: the wake fails fast instead of billing the
    // server.
    expect(
      openRouterKeyFor({ funding: "ownKey", openRouterKey: null }, "server-key"),
    ).toBeUndefined();
    expect(openRouterKeyFor(null, "server-key")).toBeUndefined();
  });
});
