/** Colors of the board groups, the seats and the providers (hex, usable in SVG and CSS). */
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

const PROVIDER_COLORS: ReadonlyArray<readonly [string, string]> = [
  ["anthropic", "#d4693b"],
  ["openai", "#10a37f"],
  ["google", "#4285f4"],
  ["x-ai", "#3d3d3d"],
  ["deepseek", "#4d6bfe"],
  ["qwen", "#7b3fe4"],
  ["moonshotai", "#16a3a3"],
  ["z-ai", "#c2185b"],
  ["mistralai", "#ff7000"],
  ["minimax", "#e8384f"],
  ["meta-llama", "#0866ff"],
  ["bot", "#7c8a7e"],
];

const FALLBACK_PROVIDER_COLOR = "#5b6b5e";

/** Provider slug of a competitor id: `anthropic/claude-x:high` → `anthropic`, `bot:random` → `bot`. */
export const providerOf = (competitorId: string): string => {
  if (competitorId.startsWith("bot:")) return "bot";

  const slash = competitorId.indexOf("/");

  return slash < 0 ? competitorId : competitorId.slice(0, slash);
};

export const providerColor = (competitorId: string): string => {
  const provider = providerOf(competitorId);
  const entry = PROVIDER_COLORS.find(([name]) => name === provider);

  return entry === undefined ? FALLBACK_PROVIDER_COLOR : entry[1];
};

const PROVIDER_NAMES: ReadonlyArray<readonly [string, string]> = [
  ["anthropic", "Anthropic"],
  ["openai", "OpenAI"],
  ["google", "Google"],
  ["x-ai", "xAI"],
  ["deepseek", "DeepSeek"],
  ["qwen", "Qwen"],
  ["moonshotai", "Moonshot AI"],
  ["z-ai", "Z.ai"],
  ["mistralai", "Mistral"],
  ["minimax", "MiniMax"],
  ["meta-llama", "Meta"],
  ["bot", "Baseline bot"],
];

export const providerName = (competitorId: string): string => {
  const provider = providerOf(competitorId);

  return PROVIDER_NAMES.find(([name]) => name === provider)?.[1] ?? provider;
};

/** Reasoning suffix of a competitor id (`…:high`), if any. */
export const reasoningOf = (competitorId: string): string | null => {
  if (competitorId.startsWith("bot:")) return null;

  const colon = competitorId.lastIndexOf(":");

  return colon < 0 ? null : competitorId.slice(colon + 1);
};
