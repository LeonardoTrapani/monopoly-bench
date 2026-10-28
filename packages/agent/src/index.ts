/** Pi harness for LLM seats. See SPEC.md §6. */
export type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";

export type { Api, Model } from "@earendil-works/pi-ai";

export {
  commandFromTool,
  type CommandTool,
  isCommandTool,
  resolveProperty,
  TOOL_COMMANDS,
  toolsForKinds,
} from "./commands.ts";

export {
  CLOSED_DECISION,
  engineExecutor,
  type EngineSeatHost,
  illegalText,
  inspectText,
  outcomeText,
} from "./engine-tools.ts";

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

export { buildSystemPrompt, wakeLimitsOf } from "./prompt.ts";

export {
  deedIndex,
  money,
  renderDeed,
  renderDeeds,
  renderFrame,
  renderHoldings,
  renderOffers,
  renderPlayerView,
  renderRules,
} from "./render.ts";

export {
  runWake,
  type WakeEndReason,
  type WakeIdentity,
  type WakeInput,
  type WakeResult,
} from "./run-wake.ts";

export { decodeSession, encodeSession } from "./session.ts";

export {
  ANSWERING_TOOLS,
  DEED_LIST,
  GROUP_IDS,
  INSPECT_TOPICS,
  isToolArgs,
  SEATS,
  TOOL_NAMES,
  type ToolArgs,
  toolDescriptions,
  type ToolName,
  toolParameters,
  type ToolParameters,
} from "./tools.ts";

export {
  MAX_DIGEST_LINES,
  NUDGE_MESSAGE,
  renderWakeMessage,
  type WakeMessageInput,
} from "./wake-message.ts";
