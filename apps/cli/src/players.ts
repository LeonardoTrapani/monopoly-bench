/**
 * Seats for `mb sim`: bot policies and LLM seats, from `--seats heuristic,llm:<openrouter id>`
 * or `--bots …` plus `--llm <id>[,<id>]`. LLM seats are labelled with pi-ai's model names.
 */
import { catalogLabel } from "@mb/agent";
import { competitorId, competitorLabel, featuredModels, LlmSeat, type Reasoning } from "@mb/api";
import { BOT_POLICIES, isBotPolicy } from "@mb/bots";
import { SEATS, type SeatConfig } from "@mb/engine";

import type { SeatPlan } from "./llm-game.ts";

const REASONING: ReadonlyArray<Reasoning> = ["off", "low", "medium", "high"];

export const parseReasoning = (raw: string | undefined): Reasoning | undefined => {
  if (raw === undefined) return undefined;

  const found = REASONING.find((level) => level === raw);

  if (found === undefined) throw new Error(`--reasoning must be one of ${REASONING.join(", ")}`);

  return found;
};

const llmSeat = (
  model: string,
  reasoning: Reasoning | undefined,
  maxOutputTokens: number | undefined,
) => {
  const base = LlmSeat.make({ model, label: catalogLabel(model) });

  const reasoned =
    reasoning === undefined || reasoning === "off" ? base : LlmSeat.make({ ...base, reasoning });

  return maxOutputTokens === undefined ? reasoned : LlmSeat.make({ ...reasoned, maxOutputTokens });
};

export interface LlmOptions {
  readonly reasoning: Reasoning | undefined;
  readonly maxOutputTokens: number | undefined;
}

/** `heuristic,random,llm:anthropic/claude-haiku-5.5` → one plan per seat. */
export const parseSeatList = (raw: string, options: LlmOptions): ReadonlyArray<SeatPlan> =>
  raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry): SeatPlan => {
      if (entry.startsWith("llm:")) {
        const model = entry.slice("llm:".length);

        if (model.length === 0) {
          throw new Error(
            `"${entry}" needs an OpenRouter model id after llm:, e.g. one of the featured models: ${featuredModels.join(", ")}`,
          );
        }

        return { kind: "llm", spec: llmSeat(model, options.reasoning, options.maxOutputTokens) };
      }

      if (!isBotPolicy(entry)) {
        throw new Error(
          `unknown seat "${entry}" (use ${BOT_POLICIES.join(", ")} or llm:<openrouter id>)`,
        );
      }

      return { kind: "bot", policy: entry };
    });

/** `--llm a,b` seats appended after the bots. */
export const llmPlans = (raw: string, options: LlmOptions): ReadonlyArray<SeatPlan> =>
  parseSeatList(
    raw
      .split(",")
      .map((model) => `llm:${model.trim()}`)
      .join(","),
    options,
  );

/** Engine seat configs (letter, label, leaderboard identity) for `plans`. */
export const seatConfigs = (plans: ReadonlyArray<SeatPlan>): ReadonlyArray<SeatConfig> =>
  plans.flatMap((plan, index) => {
    const seat = SEATS[index];

    if (seat === undefined) return [];

    if (plan.kind === "llm") {
      return [{ seat, label: competitorLabel(plan.spec), competitorId: competitorId(plan.spec) }];
    }

    return [{ seat, label: `Bot (${plan.policy})`, competitorId: `bot:${plan.policy}` }];
  });
