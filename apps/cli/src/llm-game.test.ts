import {
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseStep,
  scriptedModel,
} from "@mb/agent/testing";
import { LlmSeat } from "@mb/api";
import { createConfig } from "@mb/engine";
import { describe, expect, it } from "vite-plus/test";

import { runMixedGame, type SeatPlan } from "./llm-game.ts";
import { parseSeatList, seatConfigs } from "./players.ts";

/** Answers with the first cheap answering tool the wake message offers. */
const PREFERRED = [
  "done",
  "decline",
  "pass_bid",
  "roll_for_doubles",
  "pay_jail_fine",
  "declare_bankruptcy",
];

const answerFromMessage: FauxResponseStep = (context) => {
  const prompts = context.messages.flatMap((message) => {
    if (message.role !== "user") return [];

    const content = message.content;

    return [
      Array.isArray(content)
        ? content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("")
        : content,
    ];
  });

  const wake =
    [...prompts].reverse().find((text) => text.includes("End this wake with one of:")) ?? "";

  const offered = /End this wake with one of: ([^.]*)\./.exec(wake)?.[1]?.split(", ") ?? [];
  const tool = PREFERRED.find((name) => offered.includes(name));

  return tool === undefined
    ? fauxAssistantMessage("I keep my mortgages.")
    : fauxAssistantMessage([fauxToolCall("note", { text: "ok" }), fauxToolCall(tool, {})], {
        stopReason: "toolUse",
      });
};

const plans: ReadonlyArray<SeatPlan> = [
  { kind: "bot", policy: "heuristic" },
  { kind: "llm", spec: LlmSeat.make({ model: "example/scripted", label: "Scripted" }) },
];

const config = (maxRounds: number) =>
  createConfig({ gameId: "cli-test", seed: "7", seats: seatConfigs(plans), rules: { maxRounds } });

describe("mixed bot and LLM game", () => {
  it("plays to the end with the Pi harness applying tool calls to the game", async () => {
    const scripted = scriptedModel(Array.from({ length: 2000 }, () => answerFromMessage));

    const result = await runMixedGame({
      config: config(4),
      seats: plans,
      budgetUsd: 1e12,
      models: () => ({ model: scripted.model, streamFn: scripted.streamFn, apiKey: "test" }),
    });

    const llm = result.llm[0];

    expect(result.game.state.status).toBe("finished");
    expect(result.budgetExhausted).toBe(false);
    expect(llm?.seat).toBe("B");
    expect(llm?.wakes).toBeGreaterThan(3);
    expect(result.transcripts).toHaveLength(llm?.wakes ?? -1);
    expect(result.transcripts[0]?.prompt).toContain("You are seat B (Scripted)");
    expect(result.transcripts[0]?.toolCalls.map((call) => call.name)).toEqual(["note", "done"]);
    expect(result.spentUsd).toBeCloseTo(llm?.costUsd ?? -1);
    expect(result.spentUsd).toBeGreaterThan(0);
  });

  it("stops at the budget and aborts the game", async () => {
    const scripted = scriptedModel(Array.from({ length: 50 }, () => answerFromMessage));

    const result = await runMixedGame({
      config: config(20),
      seats: plans,
      budgetUsd: 1,
      models: () => ({ model: scripted.model, streamFn: scripted.streamFn, apiKey: "test" }),
    });

    expect(result.budgetExhausted).toBe(true);
    expect(result.game.state.endReason).toBe("aborted");
    expect(result.llm[0]?.wakes).toBe(1);
  });

  it("parses mixed seat lists", () => {
    expect(
      parseSeatList("heuristic,llm:anthropic/claude-haiku-5.5", {
        reasoning: "low",
        maxOutputTokens: undefined,
      }),
    ).toEqual([
      { kind: "bot", policy: "heuristic" },
      {
        kind: "llm",
        spec: LlmSeat.make({
          model: "anthropic/claude-haiku-5.5",
          label: "Claude Haiku 5.5",
          reasoning: "low",
        }),
      },
    ]);
    expect(() =>
      parseSeatList("greedy", { reasoning: undefined, maxOutputTokens: undefined }),
    ).toThrow("unknown seat");
    expect(seatConfigs(plans).map((seat) => seat.competitorId)).toEqual([
      "bot:heuristic",
      "example/scripted",
    ]);
  });
});
