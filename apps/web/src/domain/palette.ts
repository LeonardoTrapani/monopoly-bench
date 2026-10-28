/** Colors of the board groups, the seats and the providers (hex, usable in SVG and CSS). */
import { providerSlugOf } from "@mb/api";
import { GROUP_NAMES, type GroupId, type Seat } from "@mb/engine";

/** The eight classic property colors, plus railroads and utilities. */
export const GROUP_COLORS: Readonly<Record<GroupId, string>> = {
  brown: "#8a4b2a",
  "light-blue": "#9fd8f4",
  pink: "#d63a8f",
  orange: "#f5911e",
  red: "#e2242b",
  yellow: "#fbe232",
  green: "#1b9e52",
  "dark-blue": "#1060ad",
  railroads: "#1f2421",
  utilities: "#9aa39b",
};

/** Text color readable on each group color. */
export const GROUP_INK: Readonly<Record<GroupId, string>> = {
  brown: "#ffffff",
  "light-blue": "#10232c",
  pink: "#ffffff",
  orange: "#231505",
  red: "#ffffff",
  yellow: "#2a2505",
  green: "#ffffff",
  "dark-blue": "#ffffff",
  railroads: "#ffffff",
  utilities: "#141814",
};

export const groupName = (group: GroupId): string => GROUP_NAMES[group];

/** Seat token colors, A to F. */
export const SEAT_COLORS: Readonly<Record<Seat, string>> = {
  A: "#e0464c",
  B: "#2f6fde",
  C: "#19a35b",
  D: "#e9a21b",
  E: "#8b4fd6",
  F: "#12a3b5",
};

export const SEAT_INK: Readonly<Record<Seat, string>> = {
  A: "#ffffff",
  B: "#ffffff",
  C: "#ffffff",
  D: "#1d1503",
  E: "#ffffff",
  F: "#ffffff",
};

/**
 * Display name and brand color of OpenRouter providers, by provider slug (the model id prefix,
 * see `providerSlugOf`). Unknown providers show their slug and a neutral color.
 */
const PROVIDERS: ReadonlyArray<readonly [slug: string, name: string, color: string]> = [
  ["anthropic", "Anthropic", "#d4693b"],
  ["openai", "OpenAI", "#10a37f"],
  ["google", "Google", "#4285f4"],
  ["x-ai", "xAI", "#3d3d3d"],
  ["deepseek", "DeepSeek", "#4d6bfe"],
  ["qwen", "Qwen", "#7b3fe4"],
  ["moonshotai", "Moonshot AI", "#16a3a3"],
  ["z-ai", "Z.ai", "#c2185b"],
  ["thudm", "Zhipu AI", "#3859ff"],
  ["mistralai", "Mistral", "#ff7000"],
  ["minimax", "MiniMax", "#e8384f"],
  ["meta-llama", "Meta", "#0866ff"],
  ["meta", "Meta", "#0866ff"],
  ["nvidia", "NVIDIA", "#76b900"],
  ["cohere", "Cohere", "#39594d"],
  ["amazon", "Amazon", "#ff9900"],
  ["bytedance-seed", "ByteDance Seed", "#325ab4"],
  ["bytedance", "ByteDance", "#325ab4"],
  ["xiaomi", "Xiaomi", "#ff6900"],
  ["microsoft", "Microsoft", "#00a4ef"],
  ["ai21", "AI21 Labs", "#e5398b"],
  ["inflection", "Inflection", "#2f2f2f"],
  ["perplexity", "Perplexity", "#20808d"],
  ["openrouter", "OpenRouter", "#6467f2"],
  ["arcee-ai", "Arcee AI", "#1e5bd8"],
  ["baidu", "Baidu", "#2932e1"],
  ["tencent", "Tencent", "#0052d9"],
  ["stepfun-ai", "StepFun", "#005aff"],
  ["nousresearch", "Nous Research", "#2b2b2b"],
  ["liquid", "Liquid AI", "#4f46e5"],
  ["inception", "Inception", "#3b3b3b"],
  ["ibm-granite", "IBM", "#0f62fe"],
  ["alibaba", "Alibaba", "#ff6a00"],
  ["01-ai", "01.AI", "#14a37f"],
  ["upstage", "Upstage", "#805cfb"],
  ["allenai", "Ai2", "#f0529c"],
  ["deepcogito", "Deep Cogito", "#4b5563"],
  ["meituan", "Meituan", "#d9a300"],
  ["inclusionai", "inclusionAI", "#1677ff"],
  ["baichuan", "Baichuan", "#ff6b00"],
  ["kwaipilot", "Kwaipilot", "#ff5000"],
  ["cognitivecomputations", "Cognitive Computations", "#1a73e8"],
  ["rekaai", "Reka", "#6c2bd9"],
  ["bot", "Bot", "#7c8a7e"],
];

const FALLBACK_PROVIDER_COLOR = "#5b6b5e";

/**
 * Provider slug of a competitor id: `anthropic/claude-x:high` → `anthropic`,
 * `~google/gemini-latest` → `google`; legacy bot ids (`bot:random`) → `bot`.
 */
export const providerOf = (competitorId: string): string =>
  competitorId.startsWith("bot:") ? "bot" : providerSlugOf(competitorId);

const providerRow = (slug: string) => PROVIDERS.find(([candidate]) => candidate === slug);

/** Display name of a provider slug; unknown providers keep their slug. */
export const providerNameOfSlug = (slug: string): string => providerRow(slug)?.[1] ?? slug;

export const providerColorOfSlug = (slug: string): string =>
  providerRow(slug)?.[2] ?? FALLBACK_PROVIDER_COLOR;

export const providerColor = (competitorId: string): string =>
  providerColorOfSlug(providerOf(competitorId));

export const providerName = (competitorId: string): string =>
  providerNameOfSlug(providerOf(competitorId));

const REASONING_LEVELS: ReadonlyArray<string> = ["low", "medium", "high"];

/** Reasoning suffix of a competitor id (`…:high`), if any (`…:free` is part of the model id). */
export const reasoningOf = (competitorId: string): string | null => {
  const colon = competitorId.lastIndexOf(":");
  const suffix = colon < 0 ? null : competitorId.slice(colon + 1);

  return suffix !== null && REASONING_LEVELS.includes(suffix) ? suffix : null;
};
