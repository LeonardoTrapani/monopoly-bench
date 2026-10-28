/** Pi harness for LLM seats. See SPEC.md §6. */
export type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";

export type { Api, Model } from "@earendil-works/pi-ai";

export {
  DEFAULT_WAKE_LIMITS,
  type ToolExecutor,
  type ToolOutcome,
  type WakeLimits,
} from "./executor.ts";

export {
  OPENROUTER_BASE_URL,
  OPENROUTER_MODELS_URL,
  type OpenRouterModel,
  openRouterFallbackModel,
  openRouterModels,
  resolveOpenRouterModel,
  thinkingLevel,
} from "./models.ts";

export { buildSystemPrompt, DEFAULT_PROMPT_SETTINGS, type PromptSettings } from "./prompt.ts";

export { decodeSession, encodeSession } from "./session.ts";

export {
  runWake,
  type WakeEndReason,
  type WakeIdentity,
  type WakeInput,
  type WakeResult,
} from "./run-wake.ts";

export {
  ANSWERING_TOOLS,
  INSPECT_TOPICS,
  isToolArgs,
  PROPERTY_GROUPS,
  SEATS,
  TOOL_NAMES,
  type ToolArgs,
  toolDescriptions,
  type ToolName,
  toolParameters,
  type ToolParameters,
} from "./tools.ts";

export {
  NUDGE_MESSAGE,
  renderWakeMessage,
  type RosterEntry,
  type WakeMessageParts,
  type WakeQuestion,
} from "./wake-message.ts";
