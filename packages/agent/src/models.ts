/**
 * OpenRouter access through pi-ai. Every LLM seat names an OpenRouter model id
 * (SPEC.md §6.6). Ids in pi-ai's bundled catalog resolve to their curated entry; newer ids
 * resolve to a generic OpenAI-compatible entry priced from OpenRouter's public listing
 * (`GET https://openrouter.ai/api/v1/models`, no key needed), so cost accounting stays right.
 */
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { createModels, type MutableModels } from "@earendil-works/pi-ai/models";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import {
  openRouterCost,
  type OpenRouterModel,
} from "@earendil-works/pi-ai/providers/openrouter-api";
import type { Reasoning } from "@mb/api";

export type { OpenRouterModel } from "@earendil-works/pi-ai/providers/openrouter-api";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export const OPENROUTER_MODELS_URL = `${OPENROUTER_BASE_URL}/models`;

/** A `Models` collection with only the OpenRouter provider registered. */
export const openRouterModels = (): MutableModels => {
  const models = createModels();
  models.setProvider(openrouterProvider());

  return models;
};

/** Generic entry for an OpenRouter id missing from pi-ai's catalog. */
export const openRouterFallbackModel = (
  modelId: string,
  listing: OpenRouterModel | undefined,
): Model<"openai-completions"> => ({
  id: modelId,
  name: modelId,
  api: "openai-completions",
  provider: "openrouter",
  baseUrl: OPENROUTER_BASE_URL,
  reasoning: true,
  thinkingLevelMap: {
    off: "none",
    minimal: null,
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: null,
    max: null,
  },
  input: ["text"],
  cost: openRouterCost(listing?.pricing),
  contextWindow: listing?.top_provider?.context_length || listing?.context_length || 128_000,
  maxTokens: listing?.top_provider?.max_completion_tokens || 32_000,
  compat: { thinkingFormat: "openrouter", sendSessionAffinityHeaders: true },
});

/**
 * Resolve an OpenRouter model id. A `listing` (from the public model list) overrides the
 * catalog's price, so a run prices its responses at the prices it was created with whenever
 * OpenRouter reports no charge (`withReportedCost`).
 */
export const resolveOpenRouterModel = (
  models: MutableModels,
  modelId: string,
  listing: OpenRouterModel | undefined,
): Model<Api> => {
  const known = models.getModel("openrouter", modelId);

  if (known === undefined) return openRouterFallbackModel(modelId, listing);

  return listing?.pricing === undefined
    ? known
    : { ...known, cost: openRouterCost(listing.pricing) };
};

/** SPEC §6.6 reasoning setting to pi's thinking level. */
export const thinkingLevel = (reasoning: Reasoning | undefined): ThinkingLevel =>
  reasoning ?? "off";
