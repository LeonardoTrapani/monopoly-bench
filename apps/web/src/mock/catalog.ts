/**
 * The mock `GET /api/catalog`: the featured models plus a few dozen others across providers,
 * with plausible OpenRouter prices. Estimates come from the shared `estimateSeatCostUsd`, as on
 * the server.
 */
import {
  estimateSeatCostUsd,
  featuredModels,
  providerSlugOf,
  type CatalogResponse,
  type ModelCatalogEntry,
} from "@mb/api";

/** `[input, output, cache read, cache write]` USD per million tokens, or null when unpriced. */
type Prices = readonly [number, number, number | null, number | null] | null;

const entry = (
  model: string,
  label: string,
  provider: string,
  reasoning: boolean,
  contextLength: number | null,
  prices: Prices,
): ModelCatalogEntry => {
  const pricing =
    prices === null
      ? null
      : {
          inputPerMTok: prices[0],
          outputPerMTok: prices[1],
          cacheReadPerMTok: prices[2],
          cacheWritePerMTok: prices[3],
        };

  return {
    model,
    label,
    provider,
    providerSlug: providerSlugOf(model),
    featured: featuredModels.includes(model),
    reasoning,
    contextLength,
    pricing,
    estimatedSeatCostUsd: pricing === null ? null : estimateSeatCostUsd(pricing),
  };
};

export const MOCK_CATALOG_MODELS: ReadonlyArray<ModelCatalogEntry> = [
  entry(
    "anthropic/claude-opus-5.5",
    "Claude Opus 5.5",
    "Anthropic",
    true,
    1_000_000,
    [5, 25, 0.5, 6.25],
  ),
  entry(
    "anthropic/claude-sonnet-5.5",
    "Claude Sonnet 5.5",
    "Anthropic",
    true,
    1_000_000,
    [3, 15, 0.3, 3.75],
  ),
  entry(
    "anthropic/claude-haiku-5.5",
    "Claude Haiku 5.5",
    "Anthropic",
    true,
    200_000,
    [1, 5, 0.1, 1.25],
  ),
  entry("anthropic/claude-opus-5", "Claude Opus 5", "Anthropic", true, 200_000, [5, 25, 0.5, 6.25]),
  entry(
    "anthropic/claude-sonnet-5",
    "Claude Sonnet 5",
    "Anthropic",
    true,
    1_000_000,
    [3, 15, 0.3, 3.75],
  ),
  entry("openai/gpt-6-astra", "GPT-6 Astra", "OpenAI", true, 400_000, [1.25, 10, 0.125, null]),
  entry("openai/gpt-6.1-sol", "GPT-6.1 Sol", "OpenAI", true, 1_000_000, [2.5, 20, 0.25, null]),
  entry("openai/gpt-6-mini", "GPT-6 mini", "OpenAI", true, 400_000, [0.25, 2, 0.025, null]),
  entry("openai/gpt-6-nano", "GPT-6 nano", "OpenAI", true, 400_000, [0.05, 0.4, 0.005, null]),
  entry("openai/o5", "o5", "OpenAI", true, 200_000, [2, 8, 0.5, null]),
  entry("openai/gpt-oss-240b", "gpt-oss-240b", "OpenAI", true, 131_072, [0.1, 0.5, null, null]),
  entry("google/gemini-4-argon", "Gemini 4 Argon", "Google", true, 1_048_576, [2, 12, 0.2, 2.5]),
  entry(
    "google/gemini-4-flash",
    "Gemini 4 Flash",
    "Google",
    true,
    1_048_576,
    [0.3, 2.5, 0.03, 0.08],
  ),
  entry("google/gemini-4-flash-lite", "Gemini 4 Flash Lite", "Google", false, 1_048_576, [
    0.1,
    0.4,
    0.01,
    null,
  ]),
  entry("google/gemma-4-27b-it", "Gemma 4 27B", "Google", false, 131_072, [0.09, 0.16, null, null]),
  entry("x-ai/grok-4.7", "Grok 4.7", "xAI", true, 2_000_000, [3, 15, 0.75, null]),
  entry("x-ai/grok-4.7-fast", "Grok 4.7 Fast", "xAI", true, 2_000_000, [0.2, 0.5, 0.05, null]),
  entry("x-ai/grok-code-fast-2", "Grok Code Fast 2", "xAI", true, 256_000, [0.2, 1.5, 0.02, null]),
  entry("deepseek/deepseek-v4-pro-0813", "DeepSeek V4 Pro", "DeepSeek", true, 163_840, [
    0.6,
    2.2,
    0.06,
    null,
  ]),
  entry("deepseek/deepseek-v4-flash", "DeepSeek V4 Flash", "DeepSeek", false, 163_840, [
    0.27,
    1.1,
    0.07,
    null,
  ]),
  entry("deepseek/deepseek-r3", "DeepSeek R3", "DeepSeek", true, 163_840, [0.55, 2.19, 0.14, null]),
  entry("qwen/qwen3.8-max-0902", "Qwen3.8 Max", "Qwen", true, 262_144, [1.2, 6, 0.24, null]),
  entry("qwen/qwen3.8-plus", "Qwen3.8 Plus", "Qwen", true, 1_000_000, [0.4, 1.2, 0.08, null]),
  entry("qwen/qwen3.8-coder", "Qwen3.8 Coder", "Qwen", false, 262_144, [0.3, 1.2, null, null]),
  entry("qwen/qwen3.8-235b-a22b", "Qwen3.8 235B A22B", "Qwen", true, 262_144, [
    0.13,
    0.6,
    null,
    null,
  ]),
  entry("moonshotai/kimi-k3.1-pro", "Kimi K3.1 Pro", "Moonshot AI", true, 262_144, [
    0.6,
    2.5,
    0.15,
    null,
  ]),
  entry("moonshotai/kimi-k3.1", "Kimi K3.1", "Moonshot AI", false, 262_144, [0.4, 1.8, 0.1, null]),
  entry("z-ai/glm-5.3", "GLM 5.3", "Z.ai", true, 202_752, [0.6, 2.2, 0.11, null]),
  entry("z-ai/glm-5.3-air", "GLM 5.3 Air", "Z.ai", true, 131_072, [0.2, 1.1, 0.03, null]),
  entry("mistralai/mistral-large-4-0", "Mistral Large 4", "Mistral", false, 262_144, [
    0.5,
    1.5,
    null,
    null,
  ]),
  entry("mistralai/mistral-medium-4", "Mistral Medium 4", "Mistral", false, 131_072, [
    0.4,
    2,
    null,
    null,
  ]),
  entry("mistralai/magistral-medium-2", "Magistral Medium 2", "Mistral", true, 131_072, [
    2,
    5,
    null,
    null,
  ]),
  entry("mistralai/devstral-2", "Devstral 2", "Mistral", false, 262_144, [0.1, 0.3, null, null]),
  entry("minimax/minimax-m3", "MiniMax M3", "MiniMax", true, 1_000_000, [0.3, 1.2, 0.03, 0.375]),
  entry("meta-llama/llama-5-maverick", "Llama 5 Maverick", "Meta", false, 1_048_576, [
    0.18,
    0.6,
    null,
    null,
  ]),
  entry("meta-llama/llama-5-scout", "Llama 5 Scout", "Meta", false, 327_680, [
    0.08,
    0.3,
    null,
    null,
  ]),
  entry("nvidia/nemotron-ultra-3", "Nemotron Ultra 3", "NVIDIA", true, 131_072, [
    0.6,
    1.8,
    null,
    null,
  ]),
  entry("cohere/command-a-2", "Command A 2", "Cohere", false, 256_000, [2.5, 10, null, null]),
  entry("amazon/nova-2-pro", "Nova 2 Pro", "Amazon", true, 300_000, [0.8, 3.2, 0.2, null]),
  entry("bytedance-seed/seed-2.5-pro", "Seed 2.5 Pro", "ByteDance Seed", true, 262_144, [
    0.5,
    2,
    0.1,
    null,
  ]),
  entry("xiaomi/mimo-v3", "MiMo V3", "Xiaomi", true, 262_144, [0.2, 0.8, null, null]),
  entry("microsoft/phi-5", "Phi-5", "Microsoft", false, 131_072, [0.07, 0.14, null, null]),
  entry("ai21/jamba-2-large", "Jamba 2 Large", "AI21", false, 256_000, [2, 8, null, null]),
  entry("arcee-ai/trinity-large", "Trinity Large", "Arcee AI", true, 131_072, [0.3, 1, null, null]),
  entry("baidu/ernie-5-turbo", "ERNIE 5 Turbo", "Baidu", true, 131_072, [0.3, 1.2, null, null]),
  entry("tencent/hunyuan-t2", "Hunyuan T2", "Tencent", true, 262_144, [0.15, 0.6, null, null]),
  entry("stepfun-ai/step-4", "Step 4", "StepFun", true, 262_144, [0.6, 2.4, null, null]),
  entry("nousresearch/hermes-5-405b", "Hermes 5 405B", "Nous Research", false, 131_072, [
    0.8,
    0.8,
    null,
    null,
  ]),
  entry("inception/mercury-2", "Mercury 2", "Inception", false, 131_072, [0.25, 1, null, null]),
  entry("meituan/longcat-flash-2", "LongCat Flash 2", "Meituan", true, 131_072, [
    0.15,
    0.75,
    null,
    null,
  ]),
  entry("tngtech/deepseek-r3t-chimera", "DeepSeek R3T Chimera", "TNG", true, 163_840, [
    0.3,
    1.2,
    null,
    null,
  ]),
  entry("sao10k/l4-euryale-90b", "Euryale 90B", "Sao10K", false, 131_072, [0.65, 0.75, null, null]),
  entry("openrouter/sonoma-sky", "Sonoma Sky (stealth)", "OpenRouter", true, 2_000_000, [
    0,
    0,
    null,
    null,
  ]),
  entry("inflection/inflection-4", "Inflection 4", "Inflection", false, 32_000, null),
];

export const MOCK_CATALOG: CatalogResponse = {
  updatedAt: "2026-10-28T09:00:00.000Z",
  source: "openrouter",
  models: MOCK_CATALOG_MODELS,
};

/** Catalog label of a model id (the id itself when unknown). */
export const catalogLabel = (model: string): string =>
  MOCK_CATALOG_MODELS.find((candidate) => candidate.model === model)?.label ?? model;
