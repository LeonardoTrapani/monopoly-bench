/**
 * One wake of an LLM seat (SPEC.md §6): a pi-agent-core `Agent` run with the benchmark tools,
 * limits, usage accounting and live activity. Transport-agnostic: the host supplies the model
 * stream function and the `ToolExecutor` (GameDO RPC in PlayerDO, the engine in-process in a
 * local simulation).
 *
 * Each seat keeps one conversation for the whole game (SPEC §6.2): the host passes the
 * previous `WakeResult.conversation` back and the wake message is appended as a new user turn.
 * Before the first request, a conversation over the fixed memory budget is compacted (the same
 * model summarizes the older part); the summary's usage and cost count in the wake's usage.
 */
import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
  type AgentToolResult,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import type {
  Api,
  AssistantMessage,
  Model,
  TextContent,
  ImageContent,
} from "@earendil-works/pi-ai";
import {
  type Reasoning,
  type Seat,
  SeatActivity,
  type ToolCallRecord,
  type WakeUsage,
} from "@mb/api";

import type { ToolExecutor, WakeLimits } from "./executor.ts";
import {
  type Compaction,
  compactConversation,
  type Conversation,
  type MemoryLimits,
  needsCompaction,
} from "./memory.ts";
import { thinkingLevel } from "./models.ts";
import {
  TOOL_NAMES,
  toolDescriptions,
  toolParameters,
  type ToolName,
  type ToolParameters,
} from "./tools.ts";
import { addResponseUsage, EMPTY_USAGE, sumUsage, withReportedCost } from "./usage.ts";
import { NUDGE_MESSAGE } from "./wake-message.ts";

export interface WakeIdentity {
  readonly seat: Seat;
  readonly decisionId: string;
  readonly frame: string;
  readonly round: number;
  readonly turn: number;
  readonly reasons: ReadonlyArray<string>;
}

/**
 * Output tokens one request may ask for when the seat sets none. A wake writes a few thousand
 * at most; without a cap pi-ai asks for the model's maximum (943 718 for Kimi K3.1 Pro), and
 * OpenRouter refuses a request whose maximum output the account's credit cannot cover (402).
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 32_000;

export interface WakeInput {
  readonly identity: WakeIdentity;
  readonly model: Model<Api>;
  /** Usually `models.streamSimple.bind(models)`; a faux provider in tests. */
  readonly streamFn: StreamFn;
  readonly apiKey: string | undefined;
  readonly reasoning: Reasoning | undefined;
  /** Output cap per request; `DEFAULT_MAX_OUTPUT_TOKENS` (or the model's own, if lower) when unset. */
  readonly maxOutputTokens: number | undefined;
  readonly systemPrompt: string;
  /** The seat's conversation so far (an earlier `WakeResult.conversation`; empty at first). */
  readonly conversation: Conversation;
  readonly message: string;
  readonly executor: ToolExecutor;
  readonly limits: WakeLimits;
  /** When the conversation is compacted (`DEFAULT_MEMORY_LIMITS` outside tests). */
  readonly memory: MemoryLimits;
  readonly onActivity: (activity: SeatActivity) => void | Promise<void>;
  /** Provider session id for prompt caching, e.g. `${gameId}:${seat}`. */
  readonly sessionId: string | undefined;
  /** Aborts the wake from outside (budget exhausted, game aborted). */
  readonly signal: AbortSignal | undefined;
  readonly now: () => number;
}

export type WakeEndReason =
  | "answered"
  /** The host refused a call as terminal (decision closed, game over): nothing left to do. */
  | "closed"
  | "toolLimit"
  | "invalidLimit"
  | "timeout"
  | "aborted"
  | "modelError"
  | "unanswered";

export interface WakeResult {
  readonly endReason: WakeEndReason;
  readonly answered: boolean;
  readonly timedOut: boolean;
  readonly reasoning: string;
  readonly text: string;
  readonly toolCalls: ReadonlyArray<ToolCallRecord>;
  readonly invalidActions: number;
  readonly usage: WakeUsage;
  readonly latencyMs: number;
  readonly errorMessage: string | null;
  /** The seat's conversation after this wake, to pass back at its next wake. */
  readonly conversation: Conversation;
  /** The compaction attempted before this wake's first request, if any (its usage is in `usage`). */
  readonly compaction: Omit<Compaction, "conversation"> | null;
}

const REASONING_FLUSH_CHARS = 400;

const REASONING_FLUSH_MS = 500;

const contentText = (content: ReadonlyArray<TextContent | ImageContent>): string =>
  content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");

const isAssistant = (message: AgentMessage): message is AssistantMessage =>
  "role" in message && message.role === "assistant";

/** Mutable bookkeeping of one wake, shared by the hooks and event listener. */
class WakeLedger {
  answered = false;
  timedOut = false;
  toolCallsStarted = 0;
  invalidActions = 0;
  usage: WakeUsage = EMPTY_USAGE;
  reasoning: Array<string> = [];
  text: Array<string> = [];
  toolCalls: Array<ToolCallRecord> = [];
  /** The host refused a call as terminal: the wake is over. */
  closed = false;
  /**
   * Calls that started once the wake was over (answered, closed, invalid limit reached) or
   * over the call limit, with the reason they are refused: errors, not invalid actions.
   */
  ignoredCalls = new Map<string, string>();
  /** Terminal refusals: errors the model sees, not invalid actions. */
  terminalRefusals = new Set<string>();
  /** Calls whose host transport failed: errors, not invalid actions. */
  hostFailures = new Set<string>();
  lastAssistant: AssistantMessage | undefined = undefined;

  constructor(readonly limits: WakeLimits) {}

  /** Why a call starting now must not run, if it must not. */
  blockReason(): string | undefined {
    if (this.answered)
      return "The decision was already answered in this wake; this call was ignored.";

    if (this.closed) return "The decision is closed; this call was ignored.";

    if (this.invalidActions >= this.limits.maxInvalidPerWake) {
      return `The limit of ${this.limits.maxInvalidPerWake} invalid calls per wake was reached; this call was ignored.`;
    }

    if (this.toolCallsStarted > this.limits.maxToolCallsPerWake) {
      return `The limit of ${this.limits.maxToolCallsPerWake} tool calls per wake was reached; this call was ignored.`;
    }

    return undefined;
  }

  limitReached(): WakeEndReason | undefined {
    if (this.invalidActions >= this.limits.maxInvalidPerWake) return "invalidLimit";

    if (this.toolCallsStarted >= this.limits.maxToolCallsPerWake) return "toolLimit";

    return undefined;
  }
}

/** Buffers reasoning deltas so spectators get a few messages per second, not one per token. */
class ReasoningStream {
  private buffer = "";
  private lastFlush: number;

  constructor(
    private readonly input: WakeInput,
    now: number,
  ) {
    this.lastFlush = now;
  }

  async push(delta: string): Promise<void> {
    this.buffer += delta;
    const now = this.input.now();

    if (this.buffer.length >= REASONING_FLUSH_CHARS || now - this.lastFlush >= REASONING_FLUSH_MS) {
      await this.flush();
    }
  }

  async flush(): Promise<void> {
    this.lastFlush = this.input.now();

    if (this.buffer.length === 0) return;

    const text = this.buffer;
    this.buffer = "";
    await this.input.onActivity(
      SeatActivity.cases.ReasoningDelta.make({
        seat: this.input.identity.seat,
        decisionId: this.input.identity.decisionId,
        text,
      }),
    );
  }
}

const makeTool = <N extends ToolName>(
  name: N,
  input: WakeInput,
  ledger: WakeLedger,
): AgentTool<ToolParameters[N]> => ({
  name,
  label: name,
  description: toolDescriptions[name],
  parameters: toolParameters[name],
  executionMode: "sequential",
  execute: async (toolCallId, params): Promise<AgentToolResult<undefined>> => {
    const outcome = await input.executor(name, params, toolCallId).catch((cause: unknown) => {
      ledger.hostFailures.add(toolCallId);
      throw new Error(
        `The game host could not be reached (${cause instanceof Error ? cause.message : String(cause)}). Try again.`,
        { cause },
      );
    });

    if (!outcome.ok) {
      if (outcome.terminal) {
        ledger.closed = true;
        ledger.terminalRefusals.add(toolCallId);
      }

      throw new Error(outcome.message);
    }

    if (outcome.terminal) ledger.answered = true;

    return {
      content: [{ type: "text", text: outcome.message }],
      details: undefined,
      terminate: outcome.terminal,
    };
  },
});

const recordToolEnd = async (
  event: Extract<AgentEvent, { type: "tool_execution_end" }>,
  input: WakeInput,
  ledger: WakeLedger,
  args: Map<string, string>,
): Promise<void> => {
  const record: ToolCallRecord = {
    name: event.toolName,
    argsJson: args.get(event.toolCallId) ?? "{}",
    ok: !event.isError,
    result: contentText(event.result?.content ?? []),
  };

  ledger.toolCalls.push(record);

  const excused =
    ledger.ignoredCalls.has(event.toolCallId) ||
    ledger.hostFailures.has(event.toolCallId) ||
    ledger.terminalRefusals.has(event.toolCallId);

  if (event.isError && !excused) ledger.invalidActions += 1;

  await input.onActivity(
    SeatActivity.cases.ToolCalled.make({
      seat: input.identity.seat,
      decisionId: input.identity.decisionId,
      call: record,
    }),
  );
};

const recordAssistant = (message: AssistantMessage, ledger: WakeLedger): void => {
  ledger.usage = addResponseUsage(ledger.usage, message);
  ledger.lastAssistant = message;

  for (const block of message.content) {
    if (block.type === "thinking" && block.thinking.length > 0)
      ledger.reasoning.push(block.thinking);

    if (block.type === "text" && block.text.length > 0) ledger.text.push(block.text);
  }
};

const maxOutputTokensOf = (input: WakeInput): number => {
  const cap = input.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;

  return input.model.maxTokens > 0 ? Math.min(cap, input.model.maxTokens) : cap;
};

const endReasonOf = (ledger: WakeLedger, externallyAborted: boolean): WakeEndReason => {
  if (ledger.answered) return "answered";

  if (ledger.closed) return "closed";

  if (ledger.timedOut) return "timeout";

  if (externallyAborted) return "aborted";

  const limit = ledger.limitReached();

  if (limit !== undefined) return limit;

  return ledger.lastAssistant?.stopReason === "error" ? "modelError" : "unanswered";
};

/** Runs the wake's own agent over the (compacted) conversation; returns the conversation after it. */
const play = async (
  input: WakeInput,
  conversation: Conversation,
  ledger: WakeLedger,
  reasoningStream: ReasoningStream,
  signal: AbortSignal,
): Promise<Conversation> => {
  const argsByCall = new Map<string, string>();
  const tools = TOOL_NAMES.map((name) => makeTool(name, input, ledger));
  const maxTokens = maxOutputTokensOf(input);

  // The system message (prompt and tool declarations) is added only to a new conversation; a
  // continuing one already starts with it, so every request extends the previous one.
  const agent = new Agent({
    initialState: {
      systemPrompt: input.systemPrompt,
      model: input.model,
      thinkingLevel: thinkingLevel(input.reasoning),
      tools,
      messages: [...conversation.messages],
    },
    streamFn: withReportedCost((model, context, options) =>
      input.streamFn(model, context, { ...options, maxTokens }),
    ),
    getApiKey: () => input.apiKey,
    toolExecution: "sequential",
    identity: { attribution: null },
    beforeToolCall: async ({ toolCall }) => {
      const reason = ledger.ignoredCalls.get(toolCall.id);

      return reason === undefined ? undefined : { block: true, reason, terminate: true };
    },
    finishTurn: () =>
      ledger.answered || ledger.closed || ledger.limitReached() !== undefined
        ? { action: "end" }
        : undefined,
  });

  if (input.sessionId !== undefined) agent.sessionId = input.sessionId;

  agent.subscribe(async (event) => {
    if (event.type === "tool_execution_start") {
      ledger.toolCallsStarted += 1;

      // Decided at start, so calls that never reach `beforeToolCall` (unknown tool, bad
      // arguments) are not counted as invalid once the wake is over.
      const blocked = ledger.blockReason();

      if (blocked !== undefined) ledger.ignoredCalls.set(event.toolCallId, blocked);
      argsByCall.set(event.toolCallId, JSON.stringify(event.args ?? {}));
      await reasoningStream.flush();

      return;
    }

    if (event.type === "tool_execution_end") {
      await recordToolEnd(event, input, ledger, argsByCall);

      return;
    }

    if (event.type === "message_update" && event.assistantMessageEvent.type === "thinking_delta") {
      await reasoningStream.push(event.assistantMessageEvent.delta);

      return;
    }

    if (event.type === "message_end" && isAssistant(event.message)) {
      recordAssistant(event.message, ledger);
      await reasoningStream.flush();
    }
  });

  const abort = () => agent.abort();

  signal.addEventListener("abort", abort, { once: true });

  // The wake message becomes the next user turn.
  const wakeStart = agent.state.messages.length;

  try {
    await agent.prompt(input.message);

    // The model stopped without answering: count it as an invalid action and ask again,
    // within the limits, in the same conversation.
    while (
      !ledger.answered &&
      !ledger.closed &&
      !ledger.timedOut &&
      !signal.aborted &&
      ledger.lastAssistant?.stopReason !== "error" &&
      ledger.lastAssistant?.stopReason !== "aborted" &&
      ledger.limitReached() === undefined
    ) {
      ledger.invalidActions += 1;

      if (ledger.limitReached() !== undefined) break;

      await agent.prompt(NUDGE_MESSAGE);
    }
  } finally {
    signal.removeEventListener("abort", abort);
  }

  return { messages: agent.state.messages, wakeStarts: [...conversation.wakeStarts, wakeStart] };
};

export const runWake = async (input: WakeInput): Promise<WakeResult> => {
  const startedAt = input.now();
  const ledger = new WakeLedger(input.limits);
  const reasoningStream = new ReasoningStream(input, startedAt);

  await input.onActivity(
    SeatActivity.cases.WakeStarted.make({
      seat: input.identity.seat,
      decisionId: input.identity.decisionId,
      frame: input.identity.frame,
      round: input.identity.round,
      turn: input.identity.turn,
      reasons: input.identity.reasons,
    }),
  );

  // Fires at the wake timeout or on the host's signal; stops the compaction and the agent.
  const stop = new AbortController();

  const timer = setTimeout(() => {
    ledger.timedOut = true;
    stop.abort();
  }, input.limits.wakeTimeoutMs);

  const abortFromOutside = () => stop.abort();

  input.signal?.addEventListener("abort", abortFromOutside, { once: true });

  let conversation = input.conversation;
  let compaction: Compaction | null = null;

  try {
    if (needsCompaction(input, conversation, input.message)) {
      compaction = await compactConversation(input, conversation, stop.signal);
      conversation = compaction.conversation;
      ledger.usage = sumUsage(ledger.usage, compaction.usage);
    }

    if (!stop.signal.aborted) {
      conversation = await play(input, conversation, ledger, reasoningStream, stop.signal);
    }
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", abortFromOutside);
  }

  await reasoningStream.flush();

  const endReason = endReasonOf(ledger, input.signal?.aborted === true);
  const lastError = ledger.lastAssistant?.errorMessage;

  await input.onActivity(
    SeatActivity.cases.WakeFinished.make({
      seat: input.identity.seat,
      decisionId: input.identity.decisionId,
      usage: ledger.usage,
      timedOut: ledger.timedOut,
    }),
  );

  return {
    endReason,
    answered: ledger.answered,
    timedOut: ledger.timedOut,
    reasoning: ledger.reasoning.join("\n\n"),
    text: ledger.text.join("\n\n"),
    toolCalls: ledger.toolCalls,
    invalidActions: ledger.invalidActions,
    usage: ledger.usage,
    latencyMs: input.now() - startedAt,
    errorMessage: endReason === "modelError" ? (lastError ?? "Model error") : null,
    conversation,
    compaction:
      compaction === null
        ? null
        : {
            compacted: compaction.compacted,
            summarizedWakes: compaction.summarizedWakes,
            summary: compaction.summary,
            usage: compaction.usage,
          },
  };
};

const usd = (value: number): string => `$${value.toFixed(4)}`;

const compactionNote = (compaction: WakeResult["compaction"]): string => {
  if (compaction === null) return "";

  const { usage } = compaction;
  const cost = `${usage.inputTokens} input and ${usage.outputTokens} output tokens, ${usd(usage.costUsd)}`;

  if (!compaction.compacted) {
    return `[memory] Compacting the conversation failed (${cost}); it was kept as it was and is compacted at a later wake.`;
  }

  if (compaction.summary === null) {
    return `[memory] ${compaction.summarizedWakes} earlier wakes were dropped: their summary came back empty (${cost}).`;
  }

  return `[memory] ${compaction.summarizedWakes} earlier wakes were summarized (${cost}):\n${compaction.summary}`;
};

/**
 * The transcript `text` of a wake: the memory compaction (with its summary) if one ran, the
 * model's visible text, and the model error if the wake ended on one.
 */
export const transcriptText = (result: WakeResult): string =>
  [
    compactionNote(result.compaction),
    result.text,
    result.errorMessage === null ? "" : `[model error] ${result.errorMessage}`,
  ]
    .filter((part) => part.length > 0)
    .join("\n");
