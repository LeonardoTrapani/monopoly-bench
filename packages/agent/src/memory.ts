/**
 * Whole-game memory of an LLM seat (SPEC.md §6.2). Each seat keeps one conversation for the
 * whole game and every wake appends its wake message as a new user turn, so the transcript only
 * grows and provider prompt caching keeps working. Before a wake whose conversation would
 * exceed a fixed token budget (the same for every model), the same model summarizes the older
 * part with a fixed instruction; the conversation becomes the system message, that summary and
 * the last few wakes verbatim. Compaction is the only rewrite. Notes live outside the
 * conversation (they are part of every wake message), so they survive it.
 */
import { Agent, type AgentMessage, type StreamFn } from "@earendil-works/pi-agent-core";
import type {
  Api,
  AssistantMessage,
  ImageContent,
  Model,
  TextContent,
  ThinkingContent,
  ToolCall,
} from "@earendil-works/pi-ai";
import type { Reasoning, WakeUsage } from "@mb/api";
import { Schema } from "effect";

import { thinkingLevel } from "./models.ts";
import { addResponseUsage, EMPTY_USAGE } from "./usage.ts";

/** A seat's conversation: pi agent messages and where each wake still kept verbatim begins. */
export interface Conversation {
  /** Starts with the system message once a wake has run. */
  readonly messages: ReadonlyArray<AgentMessage>;
  /** Index in `messages` of the user message that opened each wake, oldest first. */
  readonly wakeStarts: ReadonlyArray<number>;
}

export const EMPTY_CONVERSATION: Conversation = { messages: [], wakeStarts: [] };

/** The fixed memory budget of SPEC §6.2, identical for every model. */
export interface MemoryLimits {
  /** Compact before a wake that would exceed this many tokens (at most 60% of the context window). */
  readonly compactAtTokens: number;
  /** Wakes kept verbatim after a compaction. */
  readonly keepRecentWakes: number;
  /** Output budget of the summary. */
  readonly summaryMaxTokens: number;
}

export const DEFAULT_MEMORY_LIMITS: MemoryLimits = {
  compactAtTokens: 80_000,
  keepRecentWakes: 6,
  summaryMaxTokens: 1_500,
};

/** Share of a model's context window the conversation may fill before it is compacted. */
export const MAX_CONTEXT_SHARE = 0.6;

/** The effective budget: `compactAtTokens`, lowered to 60% of a small context window. */
export const compactionBudget = (limits: MemoryLimits, contextWindow: number): number =>
  contextWindow > 0
    ? Math.min(limits.compactAtTokens, Math.floor(contextWindow * MAX_CONTEXT_SHARE))
    : limits.compactAtTokens;

const blockChars = (block: TextContent | ThinkingContent | ToolCall | ImageContent): number => {
  switch (block.type) {
    case "text":
      return block.text.length;
    case "thinking":
      return block.thinking.length;
    case "toolCall":
      return block.name.length + JSON.stringify(block.arguments).length;
    case "image":
      return 0;
  }
};

const contentChars = (
  content: string | ReadonlyArray<TextContent | ThinkingContent | ToolCall | ImageContent>,
): number =>
  Array.isArray(content)
    ? content.reduce((sum: number, block) => sum + blockChars(block), 0)
    : content.length;

/** Characters a message adds to a request (text, reasoning, tool calls and declarations). */
export const messageChars = (message: AgentMessage): number => {
  switch (message.role) {
    case "system":
      return (
        contentChars(message.content) +
        JSON.stringify(message.toolsAdded ?? []).length +
        JSON.stringify(message.sections ?? {}).length
      );
    case "user":
    case "assistant":
    case "toolResult":
      return contentChars(message.content);
  }
};

const isAssistant = (message: AgentMessage): message is AssistantMessage =>
  message.role === "assistant";

const charsToTokens = (chars: number): number => Math.ceil(chars / 4);

/**
 * Tokens the next request would send: the last response's reported context (prompt + output),
 * plus about chars/4 for everything after it and for `next`; chars/4 throughout when no response
 * reported usage yet.
 */
export const estimateConversationTokens = (
  messages: ReadonlyArray<AgentMessage>,
  next: string,
): number => {
  let reportedAt = -1;
  let reported = 0;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];

    if (message !== undefined && isAssistant(message)) {
      const usage = message.usage;
      const total = usage.input + usage.cacheRead + usage.cacheWrite + usage.output;

      if (total > 0) {
        reportedAt = index;
        reported = total;
        break;
      }
    }
  }

  const trailing = messages
    .slice(reportedAt + 1)
    .reduce((sum: number, message) => sum + messageChars(message), 0);

  return reported + charsToTokens(trailing + next.length);
};

/** The fixed compaction instruction, the same for every model. */
export const COMPACTION_PROMPT = [
  "Memory compaction. Everything above in this conversation is about to be replaced by a summary that you write now; the wakes after this point stay verbatim and your notes stay as they are.",
  "Write the summary for yourself, to keep playing this game well. Cover:",
  "1. Standings: each player's cash, deeds, complete sets, buildings and mortgages, as far as you know.",
  "2. Your own plans and strategy.",
  "3. Promises you made and promises made to you, and by whom.",
  "4. Your reads on each opponent: how they trade, bid and negotiate.",
  "5. Trade history: offers made, accepted, rejected or withdrawn, with their terms.",
  "6. Anything still pending.",
  "Be specific and factual, at most about 1,000 words. Do not call tools: reply with the summary text only.",
].join("\n");

const summaryText = (summary: string): string =>
  `[Memory] Summary of the earlier part of this game, written by you when the conversation grew long. The wakes after it are verbatim.\n\n${summary}`;

const DROPPED_TEXT =
  "[Memory] The earlier part of this game was dropped because its summary came back empty. Rely on the table, the digest and your notes.";

/** What a compaction needs from the wake: the seat's model access and settings. */
export interface CompactionContext {
  readonly model: Model<Api>;
  readonly streamFn: StreamFn;
  readonly apiKey: string | undefined;
  readonly reasoning: Reasoning | undefined;
  readonly systemPrompt: string;
  readonly sessionId: string | undefined;
  readonly memory: MemoryLimits;
  readonly now: () => number;
}

export interface Compaction {
  readonly conversation: Conversation;
  /** False when the conversation was left as it was (model error, aborted). */
  readonly compacted: boolean;
  /** Wakes folded into the summary (or dropped). */
  readonly summarizedWakes: number;
  /** The summary, or null when it failed. */
  readonly summary: string | null;
  /** Usage and cost of the summary request, charged to the wake that triggered it. */
  readonly usage: WakeUsage;
}

/** Whether the conversation must be compacted before a wake sending `message`. */
/** 60% of the model's context window: the hard limit, whatever `compactAtTokens` says. */
const contextLimit = (contextWindow: number): number =>
  contextWindow > 0 ? Math.floor(contextWindow * MAX_CONTEXT_SHARE) : Number.POSITIVE_INFINITY;

/**
 * Whether the conversation must be compacted before a wake sending `message`: over the budget
 * once more than `keepRecentWakes` wakes exist, or over the model's context limit at any time
 * (small windows then keep fewer wakes verbatim, see `wakesToKeep`).
 */
export const needsCompaction = (
  context: CompactionContext,
  conversation: Conversation,
  message: string,
): boolean => {
  const tokens = estimateConversationTokens(conversation.messages, message);
  const wakes = conversation.wakeStarts.length;

  return (
    (wakes > context.memory.keepRecentWakes &&
      tokens > compactionBudget(context.memory, context.model.contextWindow)) ||
    (wakes > 0 && tokens > contextLimit(context.model.contextWindow))
  );
};

/**
 * How many recent wakes stay verbatim: `keepRecentWakes`, fewer when they would fill more than
 * half of the model's context limit, and never all of them, so something is folded.
 */
export const wakesToKeep = (context: CompactionContext, conversation: Conversation): number => {
  const { messages, wakeStarts } = conversation;
  const half = contextLimit(context.model.contextWindow) / 2;
  const most = Math.min(context.memory.keepRecentWakes, wakeStarts.length - 1);

  for (let keep = most; keep > 0; keep -= 1) {
    const start = wakeStarts[wakeStarts.length - keep] ?? messages.length;
    const chars = messages.slice(start).reduce((sum, message) => sum + messageChars(message), 0);

    if (charsToTokens(chars) <= half) return keep;
  }

  return 0;
};

interface SummaryResponse {
  readonly text: string;
  readonly usage: WakeUsage;
  readonly failed: boolean;
}

/** What the summary request's listener saw. */
class SummaryLedger {
  usage = EMPTY_USAGE;
  last: AssistantMessage | undefined = undefined;
}

/**
 * One request with the older part of the conversation and the fixed instruction. It reuses the
 * conversation's system message, model, reasoning level and session id, so the provider can
 * serve the older part from its prompt cache; tool calls are not run.
 */
const requestSummary = async (
  context: CompactionContext,
  older: ReadonlyArray<AgentMessage>,
  signal: AbortSignal,
): Promise<SummaryResponse> => {
  const maxTokens = context.memory.summaryMaxTokens;
  const ledger = new SummaryLedger();

  const agent = new Agent({
    initialState: {
      systemPrompt: context.systemPrompt,
      model: context.model,
      thinkingLevel: thinkingLevel(context.reasoning),
      messages: [...older],
    },
    streamFn: (model, request, options) =>
      context.streamFn(model, request, { ...options, maxTokens }),
    getApiKey: () => context.apiKey,
    toolExecution: "sequential",
    identity: { attribution: null },
    finishTurn: () => ({ action: "end" }),
  });

  if (context.sessionId !== undefined) agent.sessionId = context.sessionId;

  agent.subscribe((event) => {
    if (event.type === "message_end" && isAssistant(event.message)) {
      ledger.usage = addResponseUsage(ledger.usage, event.message);
      ledger.last = event.message;
    }
  });

  const abort = () => agent.abort();

  signal.addEventListener("abort", abort, { once: true });

  try {
    if (!signal.aborted) await agent.prompt(COMPACTION_PROMPT);
  } finally {
    signal.removeEventListener("abort", abort);
  }

  const last = ledger.last;

  const text = (last?.content ?? [])
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n")
    .trim();

  const failed = last === undefined || last.stopReason === "error" || last.stopReason === "aborted";

  return { text, usage: ledger.usage, failed };
};

const userMessage = (text: string, timestamp: number): AgentMessage => ({
  role: "user",
  content: [{ type: "text", text }],
  timestamp,
});

/**
 * Replace everything before the last `keepRecentWakes` wakes with a summary written by the
 * seat's own model. On a model error or abort the conversation is left as it was (the next wake
 * tries again); an empty summary drops the older part, so the conversation stays bounded.
 */
export const compactConversation = async (
  context: CompactionContext,
  conversation: Conversation,
  signal: AbortSignal,
): Promise<Compaction> => {
  const { messages, wakeStarts } = conversation;
  const keep = wakesToKeep(context, conversation);
  const kept = keep === 0 ? [] : wakeStarts.slice(-keep);
  const cut = kept[0] ?? messages.length;
  const summarizedWakes = wakeStarts.length - kept.length;
  const head = messages[0]?.role === "system" ? 1 : 0;
  const response = await requestSummary(context, messages.slice(0, cut), signal);

  if (response.failed) {
    return {
      conversation,
      compacted: false,
      summarizedWakes: 0,
      summary: null,
      usage: response.usage,
    };
  }

  const summary = response.text.length > 0 ? response.text : null;

  const replacement = userMessage(
    summary === null ? DROPPED_TEXT : summaryText(summary),
    context.now(),
  );

  return {
    conversation: {
      messages: [...messages.slice(0, head), replacement, ...messages.slice(cut)],
      wakeStarts: kept.map((start) => start - cut + head + 1),
    },
    compacted: true,
    summarizedWakes,
    summary,
    usage: response.usage,
  };
};

/** Every agent message is a JSON object with a `role`. */
const isRoleMessage = Schema.is(Schema.Struct({ role: Schema.String }));

/** One conversation message as stored text (PlayerDO keeps one row per message). */
export const encodeAgentMessage = (message: AgentMessage): string => JSON.stringify(message);

export const decodeAgentMessage = (text: string): AgentMessage => {
  // SAFETY: the text was written by `encodeAgentMessage` from an Agent's own (plain JSON)
  // message; the check below rejects anything that is not a message object.
  const message: AgentMessage = JSON.parse(text);

  if (!isRoleMessage(message)) throw new Error("Stored conversation row is not an agent message");

  return message;
};
