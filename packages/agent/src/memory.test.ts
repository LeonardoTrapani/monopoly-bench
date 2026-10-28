import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  type FauxResponseStep,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { defaultRules } from "@mb/engine";
import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_WAKE_LIMITS, type ToolExecutor } from "./executor.ts";
import {
  COMPACTION_PROMPT,
  compactionBudget,
  type Conversation,
  decodeAgentMessage,
  DEFAULT_MEMORY_LIMITS,
  EMPTY_CONVERSATION,
  encodeAgentMessage,
  estimateConversationTokens,
  type MemoryLimits,
} from "./memory.ts";
import { buildSystemPrompt } from "./prompt.ts";
import { runWake, transcriptText, type WakeResult } from "./run-wake.ts";
import { scriptedModel, toolTurn } from "./testing.ts";

interface Request {
  readonly messages: ReadonlyArray<Message>;
  readonly maxTokens: number | undefined;
  readonly sessionId: string | undefined;
}

const lastUserText = (messages: ReadonlyArray<Message>): string => {
  const last = messages.at(-1);

  if (last?.role !== "user") return "";

  return Array.isArray(last.content)
    ? last.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("")
    : last.content;
};

const SUMMARY = "Standings: A leads with the oranges. B promised me Baltic for $60.";

/** Answers wakes with `done` and the compaction instruction with `summary()`. */
const player = (summary: () => AssistantMessage = () => fauxAssistantMessage(SUMMARY)) => {
  const requests: Array<Request> = [];

  const respond: FauxResponseStep = (context, options) => {
    requests.push({
      messages: [...context.messages],
      maxTokens: options?.maxTokens,
      sessionId: options?.sessionId,
    });

    if (lastUserText(context.messages) !== COMPACTION_PROMPT) {
      return toolTurn(fauxToolCall("done", {}));
    }

    return summary();
  };

  const scripted = scriptedModel(Array.from({ length: 50 }, () => respond));
  const answer: ToolExecutor = async () => ({ ok: true, message: "Done.", terminal: true });

  const wake = (conversation: Conversation, index: number, memory: MemoryLimits) =>
    runWake({
      identity: {
        seat: "B",
        decisionId: `d-${index}`,
        frame: "Table",
        round: 1,
        turn: index,
        reasons: ["opening"],
      },
      model: scripted.model,
      streamFn: scripted.streamFn,
      apiKey: "test-key",
      reasoning: undefined,
      maxOutputTokens: undefined,
      systemPrompt: "You play Monopoly.",
      conversation,
      message: `Wake ${index}: the table and the question.`,
      executor: answer,
      limits: DEFAULT_WAKE_LIMITS,
      memory,
      onActivity: () => {},
      sessionId: "g1:B",
      signal: undefined,
      now: Date.now,
    });

  /** Plays `count` wakes in a row, each continuing the previous conversation. */
  const play = async (count: number, memory: MemoryLimits): Promise<ReadonlyArray<WakeResult>> => {
    const results: Array<WakeResult> = [];
    let conversation = EMPTY_CONVERSATION;

    for (let index = 1; index <= count; index += 1) {
      const result = await wake(conversation, index, memory);
      results.push(result);
      conversation = result.conversation;
    }

    return results;
  };

  return { requests, play };
};

/** Compacts as soon as more than two wakes are kept. */
const tight: MemoryLimits = { compactAtTokens: 1, keepRecentWakes: 2, summaryMaxTokens: 1_500 };

const texts = (messages: ReadonlyArray<Message>): ReadonlyArray<string> =>
  messages.flatMap((message) =>
    message.role === "user" ? [lastUserText([message]).slice(0, 18)] : [],
  );

describe("whole-game memory", () => {
  it("keeps one append-only conversation for the whole game, so prompts stay cacheable", async () => {
    const h = player();
    const results = await h.play(4, DEFAULT_MEMORY_LIMITS);

    expect(h.requests).toHaveLength(4);

    for (let index = 1; index < h.requests.length; index += 1) {
      const previous = h.requests[index - 1]?.messages ?? [];
      const current = h.requests[index]?.messages ?? [];

      // Every request extends the previous one: the provider can serve it from its cache.
      expect(current.slice(0, previous.length)).toEqual(previous);
    }

    expect(texts(h.requests[3]?.messages ?? [])).toEqual([
      "Wake 1: the table ",
      "Wake 2: the table ",
      "Wake 3: the table ",
      "Wake 4: the table ",
    ]);

    const last = results.at(-1);

    expect(last?.conversation.messages[0]?.role).toBe("system");
    // Each wake: its message, the answering tool call and its result.
    expect(last?.conversation.wakeStarts).toEqual([1, 4, 7, 10]);
    expect(results.every((result) => result.compaction === null)).toBe(true);
  });

  it("compacts the older part with the same model and keeps the last wakes verbatim", async () => {
    const h = player();
    const results = await h.play(4, tight);
    const compacted = results[3];

    expect(results.slice(0, 3).every((result) => result.compaction === null)).toBe(true);
    expect(compacted?.compaction).toMatchObject({
      compacted: true,
      summarizedWakes: 1,
      summary: SUMMARY,
    });

    // Request 4 asks for the summary of wake 1, with the same session (cache) and a fixed cap.
    const summaryRequest = h.requests[3];

    expect(lastUserText(summaryRequest?.messages ?? [])).toBe(COMPACTION_PROMPT);
    expect(texts(summaryRequest?.messages ?? [])).toEqual([
      "Wake 1: the table ",
      COMPACTION_PROMPT.slice(0, 18),
    ]);
    expect(summaryRequest?.messages.slice(0, 4)).toEqual(h.requests[2]?.messages.slice(0, 4));
    expect(summaryRequest?.maxTokens).toBe(1_500);
    expect(summaryRequest?.sessionId).toBe("g1:B");

    // The wake then continues from: system, summary, wakes 2 and 3 verbatim, wake 4.
    const next = h.requests[4]?.messages ?? [];

    const summaryMessage = next[1];

    expect(next[0]?.role).toBe("system");
    expect(summaryMessage === undefined ? "" : lastUserText([summaryMessage])).toContain(SUMMARY);
    expect(texts(next).slice(1)).toEqual([
      "Wake 2: the table ",
      "Wake 3: the table ",
      "Wake 4: the table ",
    ]);
    expect(compacted?.conversation.wakeStarts).toEqual([2, 5, 8]);

    // The summary is paid by the wake that needed it and reported in its transcript.
    const summaryCost = compacted?.compaction?.usage.costUsd ?? 0;

    expect(summaryCost).toBeGreaterThan(0);
    expect(compacted?.usage.costUsd).toBeGreaterThan(summaryCost);
    expect(compacted === undefined ? "" : transcriptText(compacted)).toContain(
      `[memory] 1 earlier wakes were summarized`,
    );
    expect(compacted === undefined ? "" : transcriptText(compacted)).toContain(SUMMARY);
  });

  it("summarizes its previous summary too, so the conversation stays bounded", async () => {
    const h = player();
    const results = await h.play(6, tight);
    const last = results.at(-1);

    const summaryRequests = h.requests.filter(
      (request) => lastUserText(request.messages) === COMPACTION_PROMPT,
    );

    expect(results.filter((result) => result.compaction?.compacted === true)).toHaveLength(3);
    // The second summary request starts from the first summary.
    expect(texts(summaryRequests[1]?.messages ?? [])[0]).toBe("[Memory] Summary o");
    expect(last?.conversation.wakeStarts).toHaveLength(3);
    expect(texts(last?.conversation.messages ?? [])).toEqual([
      "[Memory] Summary o",
      "Wake 4: the table ",
      "Wake 5: the table ",
      "Wake 6: the table ",
    ]);
  });

  it("keeps the conversation when the summary request fails, and retries at a later wake", async () => {
    const h = player(() =>
      fauxAssistantMessage([], { stopReason: "error", errorMessage: "overloaded" }),
    );

    const results = await h.play(4, tight);
    const failed = results[3];

    expect(failed?.compaction).toMatchObject({ compacted: false, summary: null });
    expect(failed?.answered).toBe(true);
    expect(failed?.conversation.wakeStarts).toEqual([1, 4, 7, 10]);
    expect(failed === undefined ? "" : transcriptText(failed)).toContain(
      "[memory] Compacting the conversation failed",
    );
  });

  it("drops the older part when the summary comes back empty", async () => {
    const h = player(() => toolTurn(fauxToolCall("done", {})));
    const results = await h.play(4, tight);
    const dropped = results[3];

    expect(dropped?.compaction).toMatchObject({
      compacted: true,
      summary: null,
      summarizedWakes: 1,
    });
    expect(texts(h.requests.at(-1)?.messages ?? [])).toEqual([
      "[Memory] The earli",
      "Wake 2: the table ",
      "Wake 3: the table ",
      "Wake 4: the table ",
    ]);
  });

  it("uses the same budget for every model, capped at 60% of a small context window", () => {
    expect(compactionBudget(DEFAULT_MEMORY_LIMITS, 1_000_000)).toBe(80_000);
    expect(compactionBudget(DEFAULT_MEMORY_LIMITS, 128_000)).toBe(76_800);
    expect(compactionBudget(DEFAULT_MEMORY_LIMITS, 32_000)).toBe(19_200);
    expect(compactionBudget(DEFAULT_MEMORY_LIMITS, 0)).toBe(80_000);
  });

  it("estimates from the last reported usage, then about four characters per token", () => {
    const user = (text: string): AgentMessage => ({ role: "user", content: text, timestamp: 0 });

    expect(estimateConversationTokens([user("x".repeat(400))], "y".repeat(40))).toBe(110);

    const answered = fauxAssistantMessage("ok");

    const reported: AgentMessage = {
      ...answered,
      usage: { ...answered.usage, input: 50, cacheRead: 900, cacheWrite: 30, output: 20 },
    };

    expect(
      estimateConversationTokens([user("x".repeat(4000)), reported, user("z".repeat(80))], ""),
    ).toBe(1_000 + 20);
  });

  it("stores messages as text and rejects anything else", () => {
    const message: AgentMessage = { role: "user", content: "hello", timestamp: 7 };

    expect(decodeAgentMessage(encodeAgentMessage(message))).toEqual(message);
    expect(() => decodeAgentMessage("[1, 2]")).toThrow("not an agent message");
  });

  it("tells every model that its conversation lasts the game and notes are never summarized", () => {
    const prompt = buildSystemPrompt(defaultRules(), 4);

    expect(prompt).toContain("Your conversation lasts the whole game");
    expect(prompt).toContain("never summarized");
    expect(prompt).not.toContain("reset");
  });
});
