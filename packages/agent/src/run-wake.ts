/**
 * One wake of an LLM seat (SPEC.md §6): a pi-agent-core `Agent` run with the benchmark tools,
 * limits, usage accounting and live activity. Transport-agnostic: the host supplies the model
 * stream function and the `ToolExecutor` (GameDO RPC in PlayerDO, the engine in-process in a
 * local simulation).
 *
 * Within one session the host passes the previous `messages` back as `history` and the
 * conversation continues; for a new decision it passes no history and the context resets.
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
import { thinkingLevel } from "./models.ts";
import {
  TOOL_NAMES,
  toolDescriptions,
  toolParameters,
  type ToolName,
  type ToolParameters,
} from "./tools.ts";
import { NUDGE_MESSAGE } from "./wake-message.ts";

export interface WakeIdentity {
  readonly seat: Seat;
  readonly decisionId: string;
  readonly frame: string;
  readonly round: number;
  readonly turn: number;
  readonly reasons: ReadonlyArray<string>;
}

export interface WakeInput {
  readonly identity: WakeIdentity;
  readonly model: Model<Api>;
  /** Usually `models.streamSimple.bind(models)`; a faux provider in tests. */
  readonly streamFn: StreamFn;
  readonly apiKey: string | undefined;
  readonly reasoning: Reasoning | undefined;
  readonly maxOutputTokens: number | undefined;
  readonly systemPrompt: string;
  /** Messages of the current session (from an earlier `WakeResult.messages`). */
  readonly history: ReadonlyArray<AgentMessage>;
  readonly message: string;
  readonly executor: ToolExecutor;
  readonly limits: WakeLimits;
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
  /** The whole session transcript, to pass back as `history` for the next round. */
  readonly messages: ReadonlyArray<AgentMessage>;
}

const REASONING_FLUSH_CHARS = 400;

const REASONING_FLUSH_MS = 500;

const emptyUsage: WakeUsage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, costUsd: 0 };

const addUsage = (total: WakeUsage, message: AssistantMessage): WakeUsage => ({
  inputTokens:
    total.inputTokens + message.usage.input + message.usage.cacheRead + message.usage.cacheWrite,
  outputTokens: total.outputTokens + message.usage.output,
  reasoningTokens: total.reasoningTokens + (message.usage.reasoning ?? 0),
  costUsd: total.costUsd + message.usage.cost.total,
});

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
  usage = emptyUsage;
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
  ledger.usage = addUsage(ledger.usage, message);
  ledger.lastAssistant = message;

  for (const block of message.content) {
    if (block.type === "thinking" && block.thinking.length > 0)
      ledger.reasoning.push(block.thinking);

    if (block.type === "text" && block.text.length > 0) ledger.text.push(block.text);
  }
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

export const runWake = async (input: WakeInput): Promise<WakeResult> => {
  const startedAt = input.now();
  const ledger = new WakeLedger(input.limits);
  const reasoningStream = new ReasoningStream(input, startedAt);
  const argsByCall = new Map<string, string>();
  const tools = TOOL_NAMES.map((name) => makeTool(name, input, ledger));
  const maxTokens = input.maxOutputTokens;

  const agent = new Agent({
    initialState:
      input.history.length === 0
        ? {
            systemPrompt: input.systemPrompt,
            model: input.model,
            thinkingLevel: thinkingLevel(input.reasoning),
            tools,
          }
        : {
            model: input.model,
            thinkingLevel: thinkingLevel(input.reasoning),
            tools,
            messages: [...input.history],
          },
    streamFn:
      maxTokens === undefined
        ? input.streamFn
        : (model, context, options) => input.streamFn(model, context, { ...options, maxTokens }),
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

  const timer = setTimeout(() => {
    ledger.timedOut = true;
    agent.abort();
  }, input.limits.wakeTimeoutMs);

  const abortFromOutside = () => agent.abort();
  input.signal?.addEventListener("abort", abortFromOutside, { once: true });

  try {
    await agent.prompt(input.message);

    // The model stopped without answering: count it as an invalid action and ask again,
    // within the limits, in the same conversation.
    while (
      !ledger.answered &&
      !ledger.closed &&
      !ledger.timedOut &&
      input.signal?.aborted !== true &&
      ledger.lastAssistant?.stopReason !== "error" &&
      ledger.lastAssistant?.stopReason !== "aborted" &&
      ledger.limitReached() === undefined
    ) {
      ledger.invalidActions += 1;

      if (ledger.limitReached() !== undefined) break;

      await agent.prompt(NUDGE_MESSAGE);
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
    messages: agent.state.messages,
  };
};
