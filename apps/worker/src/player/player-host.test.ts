import { buildSystemPrompt, DEFAULT_WAKE_LIMITS } from "@mb/agent";
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
import { describe, expect, it } from "vite-plus/test";

import type { SeatCall, WakeReport, WakeRequest } from "../contracts.ts";
import { memorySqlPort } from "../testing/sqlite.ts";
import { PlayerHost } from "./player-host.ts";

const request = (decisionId: string, sessionKey: string, deadline: number): WakeRequest => ({
  gameId: "g1",
  runId: "r1",
  seat: "B",
  decisionId,
  sessionKey,
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

const setup = (responses: ReadonlyArray<FauxResponseStep>) => {
  const scripted = scriptedModel(responses);
  const calls: Array<{ readonly kind: string; readonly call: SeatCall }> = [];
  const reports: Array<WakeReport> = [];
  const activity: Array<SeatActivity> = [];
  const alarms: Array<number | null> = [];
  const clock = { now: 1_000 };

  const answer = async (kind: string, call: SeatCall) => {
    calls.push({ kind, call });

    return { ok: true, message: `${call.tool} ok`, terminal: call.tool === "done" };
  };

  let failReports = 0;

  const host = new PlayerHost({
    sql: memorySqlPort(),
    game: {
      submit: (call) => answer("submit", call),
      done: (call) => answer("done", call),
      inspect: (call) => answer("inspect", call),
      activity: async (_gameId, event) => {
        activity.push(event);
      },
      wakeFinished: async (report) => {
        if (failReports > 0) {
          failReports -= 1;
          throw new Error("GameDO unreachable");
        }

        reports.push(report);
      },
    },
    models: () => ({ model: scripted.model, streamFn: scripted.streamFn, apiKey: "test" }),
    setAlarm: async (at) => {
      alarms.push(at);
    },
    now: () => clock.now,
    log: () => {},
  });

  return {
    host,
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

    await h.host.wake(request("d1", "s1", 999_999));

    expect(h.alarms).toEqual([1_000]);
    expect(h.calls).toHaveLength(0);

    await h.host.alarm();

    expect(h.calls.map((entry) => [entry.kind, entry.call.tool])).toEqual([
      ["submit", "note"],
      ["done", "done"],
    ]);
    expect(h.calls[0]?.call).toMatchObject({ gameId: "g1", seat: "B", decisionId: "d1" });
    expect(h.reports).toHaveLength(1);

    const report = h.reports[0];
    expect(report?.endReason).toBe("answered");
    expect(report?.transcript.prompt).toBe("Wake d1");
    expect(report?.transcript.reasoning).toBe("Just finish.");
    expect(report?.transcript.toolCalls).toHaveLength(2);
    expect(report?.transcript.usage.costUsd).toBeGreaterThan(0);
    expect(h.activity.length).toBeGreaterThan(0);

    // Running the alarm again does nothing: the wake is done.
    await h.host.alarm();
    expect(h.reports).toHaveLength(1);
  });

  it("ignores a duplicate wake request", async () => {
    const h = setup([toolTurn(fauxToolCall("done", {}))]);

    await h.host.wake(request("d1", "s1", 999_999));
    await h.host.wake(request("d1", "s1", 999_999));
    await h.host.alarm();

    expect(h.reports).toHaveLength(1);
    expect(h.scripted.faux.state.callCount).toBe(1);
  });

  it("continues the conversation within a session and resets it for a new one", async () => {
    const lengths: Array<number> = [];

    const respond: FauxResponseStep = (context) => {
      lengths.push(context.messages.length);

      return toolTurn(fauxToolCall("done", {}));
    };

    const h = setup([respond, respond, respond]);

    await h.host.wake(request("d1", "session-1", 999_999));
    await h.host.alarm();
    await h.host.wake(request("d2", "session-1", 999_999));
    await h.host.alarm();
    await h.host.wake(request("d3", "session-2", 999_999));
    await h.host.alarm();

    expect(lengths[1]).toBeGreaterThan(lengths[0] ?? 0);
    expect(lengths[2]).toBe(lengths[0]);
  });

  it("does not call the model after the deadline", async () => {
    const h = setup([toolTurn(fauxToolCall("done", {}))]);

    await h.host.wake(request("d1", "s1", 500));
    await h.host.alarm();

    expect(h.scripted.faux.state.callCount).toBe(0);
    expect(h.reports[0]?.endReason).toBe("expired");
  });

  it("re-sends a stored report until GameDO takes it", async () => {
    const h = setup([toolTurn(fauxToolCall("done", {}))]);
    h.failNextReports(1);

    await h.host.wake(request("d1", "s1", 999_999));
    await h.host.alarm();

    expect(h.reports).toHaveLength(0);
    expect(h.alarms.at(-1)).toBe(11_000);

    await h.host.alarm();

    expect(h.reports).toHaveLength(1);
    expect(h.reports[0]?.endReason).toBe("answered");
    expect(h.scripted.faux.state.callCount).toBe(1);
  });
});
