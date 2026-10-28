import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import { calculateCost, createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
  type FauxProviderHandle,
  type FauxResponseStep,
  type RegisterFauxProviderOptions,
} from "@earendil-works/pi-ai/providers/faux";
import { SeatActivity } from "@mb/api";
import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_WAKE_LIMITS,
  type ToolExecutor,
  type ToolOutcome,
  type WakeLimits,
} from "./executor.ts";
import { runWake, type WakeInput } from "./run-wake.ts";
import type { ToolName } from "./tools.ts";

interface ExecutorCall {
  readonly name: ToolName;
  readonly argsJson: string;
  readonly callId: string;
}

interface Harness {
  readonly faux: FauxProviderHandle;
  readonly calls: Array<ExecutorCall>;
  readonly activity: Array<SeatActivity>;
  readonly input: (overrides: Partial<WakeInput>) => WakeInput;
}

const answering: ReadonlySet<string> = new Set(["done", "bid", "pass_bid", "buy", "decline"]);

/** Host fake: answering tools are terminal, `mortgage` is always illegal, the rest succeed. */
const scriptedHost =
  (calls: Array<ExecutorCall>): ToolExecutor =>
  async (name, args, callId): Promise<ToolOutcome> => {
    calls.push({ name, argsJson: JSON.stringify(args), callId });

    if (name === "mortgage")
      return { ok: false, message: "You do not own that deed.", terminal: false };

    return { ok: true, message: `${name} accepted`, terminal: answering.has(name) };
  };

const harness = (responses: ReadonlyArray<FauxResponseStep>, tokensPerSecond = 0): Harness => {
  const options: RegisterFauxProviderOptions = {
    models: [
      {
        id: "faux-player",
        reasoning: true,
        // $1 per input token and $2 per output token, so costs are easy to check.
        cost: { input: 1_000_000, output: 2_000_000, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  };

  if (tokensPerSecond > 0) options.tokensPerSecond = tokensPerSecond;

  const faux = fauxProvider(options);
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([...responses]);

  // The faux provider estimates tokens but reports no cost; price them like real providers do.
  const priced: StreamFn = (model, context, streamOptions) => {
    const stream = models.streamSimple(model, context, streamOptions);
    const result = stream.result.bind(stream);
    stream.result = async () => {
      const message = await result();
      calculateCost(model, message.usage);

      return message;
    };

    return stream;
  };

  const calls: Array<ExecutorCall> = [];
  const activity: Array<SeatActivity> = [];

  return {
    faux,
    calls,
    activity,
    input: (overrides) => ({
      identity: {
        seat: "B",
        decisionId: "d-1",
        frame: "Table",
        round: 1,
        turn: 1,
        reasons: ["opening"],
      },
      model: faux.getModel(),
      streamFn: priced,
      apiKey: "test-key",
      reasoning: "medium",
      maxOutputTokens: undefined,
      systemPrompt: "You play Monopoly.",
      history: [],
      message: "Your turn.",
      executor: scriptedHost(calls),
      limits: DEFAULT_WAKE_LIMITS,
      onActivity: (event) => {
        activity.push(event);
      },
      sessionId: undefined,
      signal: undefined,
      now: Date.now,
      ...overrides,
    }),
  };
};

const toolUse = (...calls: Array<ReturnType<typeof fauxToolCall>>) =>
  fauxAssistantMessage(calls, { stopReason: "toolUse" });

const limits = (patch: Partial<WakeLimits>): WakeLimits => ({ ...DEFAULT_WAKE_LIMITS, ...patch });

describe("runWake", () => {
  it("ends the wake after an answering tool, without another model request", async () => {
    const h = harness([
      toolUse(fauxToolCall("note", { text: "Buy oranges." }), fauxToolCall("done", {})),
      fauxAssistantMessage("should never be requested"),
    ]);

    const result = await runWake(h.input({}));

    expect(result.endReason).toBe("answered");
    expect(result.answered).toBe(true);
    expect(h.faux.state.callCount).toBe(1);
    expect(h.calls.map((call) => call.name)).toEqual(["note", "done"]);
    expect(result.toolCalls.map((call) => [call.name, call.ok])).toEqual([
      ["note", true],
      ["done", true],
    ]);
    expect(result.invalidActions).toBe(0);
  });

  it("ignores calls made after the answer in the same response, without counting them invalid", async () => {
    const h = harness([
      toolUse(fauxToolCall("bid", { amount: 120 }), fauxToolCall("note", { text: "x" })),
    ]);

    const result = await runWake(h.input({}));

    expect(result.answered).toBe(true);
    expect(h.calls.map((call) => call.name)).toEqual(["bid"]);
    expect(result.toolCalls[1]?.ok).toBe(false);
    expect(result.toolCalls[1]?.result).toContain("already answered");
    expect(result.invalidActions).toBe(0);
  });

  it("returns illegal, unknown and malformed calls to the model as errors and counts them", async () => {
    const h = harness([
      toolUse(
        fauxToolCall("mortgage", { property: "Boardwalk" }),
        fauxToolCall("teleport", { to: "GO" }),
        fauxToolCall("bid", { amount: "lots" }),
      ),
      toolUse(fauxToolCall("pass_bid", {})),
    ]);

    const result = await runWake(h.input({}));

    expect(result.endReason).toBe("answered");
    expect(result.invalidActions).toBe(3);
    expect(result.toolCalls.map((call) => call.ok)).toEqual([false, false, false, true]);
    expect(result.toolCalls[0]?.result).toBe("You do not own that deed.");
    expect(result.toolCalls[1]?.result).toContain("not found");
    expect(h.calls.map((call) => call.name)).toEqual(["mortgage", "pass_bid"]);
  });

  it("stops at maxInvalidPerWake", async () => {
    const illegal = toolUse(fauxToolCall("mortgage", { property: "Boardwalk" }));
    const h = harness([illegal, illegal, illegal, illegal]);

    const result = await runWake(h.input({ limits: limits({ maxInvalidPerWake: 2 }) }));

    expect(result.endReason).toBe("invalidLimit");
    expect(result.answered).toBe(false);
    expect(result.invalidActions).toBe(2);
    expect(h.faux.state.callCount).toBe(2);
  });

  it("stops at maxToolCallsPerWake and blocks calls over the limit", async () => {
    const inspect = () => fauxToolCall("inspect", { topic: "table" });

    const h = harness([
      toolUse(inspect(), inspect()),
      toolUse(inspect(), inspect()),
      toolUse(inspect()),
    ]);

    const result = await runWake(h.input({ limits: limits({ maxToolCallsPerWake: 3 }) }));

    expect(result.endReason).toBe("toolLimit");
    expect(h.calls).toHaveLength(3);
    expect(result.toolCalls).toHaveLength(4);
    expect(result.toolCalls[3]?.result).toContain("limit");
    expect(result.invalidActions).toBe(0);
    expect(h.faux.state.callCount).toBe(2);
  });

  it("nudges a model that stops without answering and counts it as invalid", async () => {
    const h = harness([
      fauxAssistantMessage("I will think about it."),
      toolUse(fauxToolCall("done", {})),
    ]);

    const result = await runWake(h.input({}));

    expect(result.endReason).toBe("answered");
    expect(result.invalidActions).toBe(1);
    expect(result.text).toBe("I will think about it.");
    expect(h.faux.state.callCount).toBe(2);
  });

  it("gives up when the nudges exhaust the invalid limit", async () => {
    const h = harness([
      fauxAssistantMessage("hmm"),
      fauxAssistantMessage("hmm"),
      fauxAssistantMessage("hmm"),
    ]);

    const result = await runWake(h.input({ limits: limits({ maxInvalidPerWake: 2 }) }));

    expect(result.endReason).toBe("invalidLimit");
    expect(result.invalidActions).toBe(2);
    expect(h.faux.state.callCount).toBe(2);
  });

  it("times out a slow model", async () => {
    const h = harness([fauxAssistantMessage(fauxText("x".repeat(4000)))], 20);

    const result = await runWake(h.input({ limits: limits({ wakeTimeoutMs: 50 }) }));

    expect(result.timedOut).toBe(true);
    expect(result.endReason).toBe("timeout");
    expect(result.answered).toBe(false);
  });

  it("aborts when the host signal fires", async () => {
    const h = harness([fauxAssistantMessage(fauxText("x".repeat(4000)))], 20);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);

    const result = await runWake(h.input({ signal: controller.signal }));

    expect(result.endReason).toBe("aborted");
    expect(result.timedOut).toBe(false);
  });

  it("does not count host transport failures as invalid actions", async () => {
    let attempts = 0;

    const flaky: ToolExecutor = async (name) => {
      attempts += 1;

      if (attempts === 1) throw new Error("connection reset");

      return { ok: true, message: `${name} ok`, terminal: true };
    };

    const h = harness([toolUse(fauxToolCall("done", {})), toolUse(fauxToolCall("done", {}))]);

    const result = await runWake(h.input({ executor: flaky }));

    expect(result.answered).toBe(true);
    expect(result.invalidActions).toBe(0);
    expect(result.toolCalls[0]?.result).toContain("could not be reached");
  });

  it("accounts usage and cost, keeps reasoning, and streams activity", async () => {
    const h = harness([
      fauxAssistantMessage(
        [fauxThinking("Orange set is hot."), fauxToolCall("note", { text: "orange" })],
        {
          stopReason: "toolUse",
        },
      ),
      fauxAssistantMessage([fauxThinking("Now finish."), fauxToolCall("done", {})], {
        stopReason: "toolUse",
      }),
    ]);

    const result = await runWake(h.input({}));

    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.usage.outputTokens).toBeGreaterThan(0);
    expect(result.usage.costUsd).toBeCloseTo(
      result.usage.inputTokens + 2 * result.usage.outputTokens,
      6,
    );
    expect(result.reasoning).toBe("Orange set is hot.\n\nNow finish.");

    const first = h.activity[0];
    const last = h.activity.at(-1);
    expect(first !== undefined && SeatActivity.guards.WakeStarted(first)).toBe(true);
    expect(last !== undefined && SeatActivity.guards.WakeFinished(last)).toBe(true);
    expect(h.activity.filter(SeatActivity.guards.ToolCalled)).toHaveLength(2);

    const streamed = h.activity
      .filter(SeatActivity.guards.ReasoningDelta)
      .map((event) => event.text);

    expect(streamed.join("")).toBe("Orange set is hot.Now finish.");
  });

  it("continues the session conversation when given history", async () => {
    const seen: Array<number> = [];

    const respond =
      (step: string): FauxResponseStep =>
      (context) => {
        seen.push(context.messages.length);

        return fauxAssistantMessage([fauxToolCall("done", {}, { id: step })], {
          stopReason: "toolUse",
        });
      };

    const h = harness([respond("first"), respond("second")]);

    const first = await runWake(h.input({}));
    const history: ReadonlyArray<AgentMessage> = first.messages;
    const second = await runWake(h.input({ history, message: "Round 2." }));

    expect(second.answered).toBe(true);
    expect(seen[1]).toBeGreaterThan(seen[0] ?? 0);
    expect(second.messages.length).toBeGreaterThan(first.messages.length);
    expect(second.messages[0]).toEqual(first.messages[0]);
  });

  it("passes maxOutputTokens and the api key to the stream", async () => {
    const seen: Array<string> = [];

    const h = harness([
      (_context, options) => {
        seen.push(`${options?.maxTokens}:${options?.apiKey}`);

        return fauxAssistantMessage([fauxToolCall("done", {})], { stopReason: "toolUse" });
      },
    ]);

    await runWake(h.input({ maxOutputTokens: 777 }));

    expect(seen).toEqual(["777:test-key"]);
  });
});
