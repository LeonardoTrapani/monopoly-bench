import { Value } from "typebox/value";
import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_WAKE_LIMITS } from "./executor.ts";
import { openRouterModels, resolveOpenRouterModel, thinkingLevel } from "./models.ts";
import { buildSystemPrompt, DEFAULT_PROMPT_SETTINGS } from "./prompt.ts";
import { ANSWERING_TOOLS, TOOL_NAMES, toolDescriptions, toolParameters } from "./tools.ts";
import { renderWakeMessage } from "./wake-message.ts";

const settings = { ...DEFAULT_PROMPT_SETTINGS, playersCount: 4, limits: DEFAULT_WAKE_LIMITS };

describe("tools", () => {
  it("exposes exactly the SPEC §6.3 tool set", () => {
    expect([...TOOL_NAMES].sort()).toEqual(
      [
        "inspect",
        "note",
        "follow",
        "unfollow",
        "build",
        "sell_building",
        "mortgage",
        "unmortgage",
        "offer",
        "accept",
        "reject",
        "withdraw",
        "message",
        "buy",
        "decline",
        "pay_jail_fine",
        "use_jail_card",
        "roll_for_doubles",
        "bid",
        "pass_bid",
        "keep_mortgage",
        "pay_off_mortgage",
        "declare_bankruptcy",
        "done",
      ].sort(),
    );
    expect(Object.keys(toolParameters).sort()).toEqual([...TOOL_NAMES].sort());
    expect(Object.keys(toolDescriptions).sort()).toEqual([...TOOL_NAMES].sort());
  });

  it("marks the answering tools", () => {
    expect(ANSWERING_TOOLS.has("done")).toBe(true);
    expect(ANSWERING_TOOLS.has("bid")).toBe(true);
    expect(ANSWERING_TOOLS.has("offer")).toBe(false);
    expect(ANSWERING_TOOLS.has("inspect")).toBe(false);
  });

  it("validates offer and bid arguments", () => {
    expect(
      Value.Check(toolParameters.offer, {
        to: "C",
        give: { cash: 100, properties: ["Boardwalk"] },
        get: { jailCards: 1 },
        comment: "Fair deal",
      }),
    ).toBe(true);
    expect(Value.Check(toolParameters.offer, { to: "G", give: {}, get: {} })).toBe(false);
    expect(Value.Check(toolParameters.offer, { give: { cash: -5 }, get: {} })).toBe(false);
    expect(Value.Check(toolParameters.bid, { amount: 10 })).toBe(true);
    expect(Value.Check(toolParameters.bid, { amount: 0 })).toBe(false);
    expect(Value.Check(toolParameters.message, { offerId: "o1", text: "x".repeat(281) })).toBe(
      false,
    );
  });
});

describe("system prompt", () => {
  it("is a pure function of the game settings", () => {
    expect(buildSystemPrompt(settings)).toBe(buildSystemPrompt({ ...settings }));
  });

  it("states the objective, the variants, the round protocol and the trading rule", () => {
    const prompt = buildSystemPrompt(settings);

    expect(prompt).toContain("Finish first");
    expect(prompt).toContain("Declared variants");
    expect(prompt).toContain("Rent is collected automatically");
    expect(prompt).toContain(`${settings.maxRounds} full rounds`);
    expect(prompt).toContain("fixed order");
    expect(prompt).toContain("no loans");
    expect(prompt).toContain("no rent immunity");
    expect(prompt).toContain("24 tool calls, 6 invalid calls, 180 seconds");
  });
});

describe("wake message", () => {
  it("renders the sections in SPEC §6.2 order", () => {
    const message = renderWakeMessage({
      seat: "B",
      roster: [
        { seat: "A", label: "Claude Opus 5.5" },
        { seat: "B", label: "GPT-6.1 Sol" },
      ],
      turn: 12,
      digest: ["A rolled 3+4 and landed on Chance"],
      view: "Cash: $1,320",
      question: {
        frame: "Table",
        round: 2,
        reasons: ["addressed"],
        legal: ["accept", "reject", "done"],
        prompt: "A offered you a trade.",
      },
      offers: "o7: A gives Boardwalk, gets $400",
      notes: "",
    });

    const order = [
      "You are seat B",
      "Since your last wake",
      "## Table",
      "## Decision",
      "Offers and threads",
      "Your notes",
    ];

    const positions = order.map((needle) => message.indexOf(needle));

    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(message).toContain("A: Claude Opus 5.5");
    expect(message).toContain("B (you)");
    expect(message).toContain("Woken because: addressed.");
    expect(message).toContain("(empty)");
  });
});

describe("OpenRouter models", () => {
  const models = openRouterModels();

  it("uses the curated catalog entry when pi-ai knows the id", () => {
    const model = resolveOpenRouterModel(models, "anthropic/claude-opus-5.5", undefined);

    expect(model.api).toBe("anthropic-messages");
    expect(model.cost.input).toBeGreaterThan(0);
  });

  it("builds a priced OpenAI-compatible entry for ids missing from the catalog", () => {
    const model = resolveOpenRouterModel(models, "example/brand-new-model", {
      id: "example/brand-new-model",
      context_length: 200_000,
      pricing: { prompt: "0.000002", completion: "0.00001" },
    });

    expect(model.api).toBe("openai-completions");
    expect(model.provider).toBe("openrouter");
    expect(model.contextWindow).toBe(200_000);
    expect(model.cost.input).toBeCloseTo(2);
    expect(model.cost.output).toBeCloseTo(10);
  });

  it("lets a listing override catalog prices", () => {
    const model = resolveOpenRouterModel(models, "anthropic/claude-opus-5.5", {
      id: "anthropic/claude-opus-5.5",
      pricing: { prompt: "0.000001", completion: "0.000003" },
    });

    expect(model.api).toBe("anthropic-messages");
    expect(model.cost.input).toBeCloseTo(1);
  });

  it("maps the SPEC reasoning setting to pi thinking levels", () => {
    expect(thinkingLevel(undefined)).toBe("off");
    expect(thinkingLevel("high")).toBe("high");
  });
});
