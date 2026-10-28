/** Token and cost accounting of model responses (SPEC.md §6.4). */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { WakeUsage } from "@mb/api";

export const EMPTY_USAGE: WakeUsage = {
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  costUsd: 0,
};

/** Input counts every prompt token: fresh, read from the cache and written to it. */
export const addResponseUsage = (total: WakeUsage, message: AssistantMessage): WakeUsage => ({
  inputTokens:
    total.inputTokens + message.usage.input + message.usage.cacheRead + message.usage.cacheWrite,
  outputTokens: total.outputTokens + message.usage.output,
  reasoningTokens: total.reasoningTokens + (message.usage.reasoning ?? 0),
  costUsd: total.costUsd + message.usage.cost.total,
});

export const sumUsage = (a: WakeUsage, b: WakeUsage): WakeUsage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  reasoningTokens: a.reasoningTokens + b.reasoningTokens,
  costUsd: a.costUsd + b.costUsd,
});
