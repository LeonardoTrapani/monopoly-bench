/**
 * An in-process game mixing bot and LLM seats (`mb sim --llm …`). Bots answer through
 * `@mb/bots`; LLM seats run the same Pi harness as PlayerDO (`@mb/agent` `runWake`) with an
 * executor that applies each tool call to the game at once, so the model sees every engine
 * refusal. Built on `@mb/sim`'s `Host` (digest cursors, defaults, invariants).
 */
import {
  type Api,
  buildSystemPrompt,
  type Conversation,
  DEFAULT_MEMORY_LIMITS,
  EMPTY_CONVERSATION,
  engineExecutor,
  type MemoryLimits,
  type Model,
  renderWakeMessage,
  runWake,
  type StreamFn,
  transcriptText,
  type WakeResult,
  wakeLimitsOf,
} from "@mb/agent";
import type { LlmSeat, WakeTranscript } from "@mb/api";
import { type BotPolicy, createBot } from "@mb/bots";
import {
  apply,
  type Command,
  command,
  decisionIdOf,
  type GameConfig,
  type GameEvent,
  type Seat,
} from "@mb/engine";
import { Host, type GameResult, type Wake } from "@mb/sim";
import { Result } from "effect";

export type SeatPlan =
  | { readonly kind: "bot"; readonly policy: BotPolicy }
  | { readonly kind: "llm"; readonly spec: LlmSeat };

export interface ModelAccess {
  readonly model: Model<Api>;
  readonly streamFn: StreamFn;
  readonly apiKey: string | undefined;
}

export interface LlmSeatStats {
  readonly seat: Seat;
  wakes: number;
  toolCalls: number;
  invalid: number;
  timeouts: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  costUsd: number;
  latencyMs: number;
}

export interface MixedGameInput {
  readonly config: GameConfig;
  /** One plan per seat of `config`, in seat order. */
  readonly seats: ReadonlyArray<SeatPlan>;
  readonly models: (spec: LlmSeat) => ModelAccess;
  /** Hard stop: no wake starts once this is spent, and the game is aborted. */
  readonly budgetUsd: number;
  readonly verify?: boolean;
  readonly onWake?: (transcript: WakeTranscript, result: WakeResult) => void;
  readonly now?: () => number;
  /** Conversation budget of every LLM seat (default `DEFAULT_MEMORY_LIMITS`, as in PlayerDO). */
  readonly memory?: MemoryLimits;
}

export interface MixedGameResult {
  readonly game: GameResult;
  readonly llm: ReadonlyArray<LlmSeatStats>;
  readonly transcripts: ReadonlyArray<WakeTranscript>;
  readonly spentUsd: number;
  readonly budgetExhausted: boolean;
}

const emptyStats = (seat: Seat): LlmSeatStats => ({
  seat,
  wakes: 0,
  toolCalls: 0,
  invalid: 0,
  timeouts: 0,
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  costUsd: 0,
  latencyMs: 0,
});

export const runMixedGame = async (input: MixedGameInput): Promise<MixedGameResult> => {
  const now = input.now ?? Date.now;
  const host = new Host(input.config, { verify: input.verify ?? false });

  const rules = input.config.rules;
  const systemPrompt = buildSystemPrompt(rules, input.config.seats.length);
  const plans = new Map<Seat, SeatPlan>();
  const bots = new Map<Seat, ReturnType<typeof createBot>>();
  const stats = new Map<Seat, LlmSeatStats>();
  const notes = new Map<Seat, string>();
  /** Each LLM seat's conversation for the whole game, in memory (SPEC §6.2). */
  const conversations = new Map<Seat, Conversation>();
  const transcripts: Array<WakeTranscript> = [];
  const abort = new AbortController();
  let spentUsd = 0;
  let budgetExhausted = false;

  for (const [index, seat] of input.config.seats.entries()) {
    const plan = input.seats[index];

    if (plan === undefined) throw new Error(`No player for seat ${seat.seat}`);

    plans.set(seat.seat, plan);

    if (plan.kind === "bot")
      bots.set(seat.seat, createBot(plan.policy, `${input.config.seed}:${seat.seat}`));
    else stats.set(seat.seat, emptyStats(seat.seat));
  }

  /** Applies a tool's command to the game (checked first, so the engine's reason comes back). */
  const submit = (next: Command) => {
    const checked = apply(host.state, next);

    if (Result.isFailure(checked)) return Result.fail(checked.failure);

    const before = host.events.length;

    host.applyCommand(next);

    return Result.succeed<ReadonlyArray<GameEvent>>(host.events.slice(before));
  };

  const stopForBudget = () => {
    if (budgetExhausted) return;

    budgetExhausted = true;
    abort.abort();

    if (host.playing) host.applyCommand(command("AbortGame", { reason: "budget exhausted" }));
  };

  const playLlm = async (wake: Wake, spec: LlmSeat): Promise<void> => {
    const seat = wake.request.seat;
    const seatStats = stats.get(seat) ?? emptyStats(seat);

    const message = renderWakeMessage({
      view: wake.view,
      request: wake.request,
      digest: wake.digest,
      notes: notes.get(seat) ?? "",
    });

    const access = input.models(spec);
    const startedAt = new Date(now()).toISOString();

    const result = await runWake({
      identity: {
        seat,
        decisionId: wake.request.decisionId,
        frame: wake.request.frame,
        round: wake.request.round,
        turn: wake.request.turn,
        reasons: wake.request.reasons,
      },
      model: access.model,
      streamFn: access.streamFn,
      apiKey: access.apiKey,
      reasoning: spec.reasoning,
      maxOutputTokens: spec.maxOutputTokens,
      systemPrompt,
      conversation: conversations.get(seat) ?? EMPTY_CONVERSATION,
      message,
      executor: engineExecutor(
        {
          state: () => host.state,
          submit,
          notes: () => notes.get(seat) ?? "",
          saveNotes: (text) => {
            notes.set(seat, text);
          },
        },
        seat,
        wake.request.decisionId,
      ),
      limits: wakeLimitsOf(rules),
      memory: input.memory ?? DEFAULT_MEMORY_LIMITS,
      onActivity: () => {},
      sessionId: `${input.config.gameId}:${seat}`,
      signal: abort.signal,
      now,
    });

    conversations.set(seat, result.conversation);
    seatStats.wakes += 1;
    seatStats.toolCalls += result.toolCalls.length;
    seatStats.invalid += result.invalidActions;
    seatStats.inputTokens += result.usage.inputTokens;
    seatStats.outputTokens += result.usage.outputTokens;
    seatStats.reasoningTokens += result.usage.reasoningTokens;
    seatStats.costUsd += result.usage.costUsd;
    seatStats.latencyMs += result.latencyMs;
    spentUsd += result.usage.costUsd;

    const transcript: WakeTranscript = {
      gameId: input.config.gameId,
      seat,
      decisionId: wake.request.decisionId,
      turn: wake.request.turn,
      frame: wake.request.frame,
      round: wake.request.round,
      reasons: wake.request.reasons,
      startedAt,
      finishedAt: new Date(now()).toISOString(),
      prompt: message,
      reasoning: result.reasoning,
      text: transcriptText(result),
      toolCalls: result.toolCalls,
      usage: result.usage,
      invalidActions: result.invalidActions,
      timedOut: result.timedOut,
    };

    transcripts.push(transcript);
    input.onWake?.(transcript, result);

    // The wake ended without answering: the game applies the default (SPEC §6.5).
    if (host.playing && decisionIdOf(host.state, seat) === wake.request.decisionId) {
      seatStats.timeouts += 1;
      host.timeout(seat);
    }

    if (spentUsd >= input.budgetUsd) stopForBudget();
  };

  while (host.playing) {
    const wakes = host.pendingSeats().flatMap((seat) => {
      const wake = host.wake(seat);

      return wake === null ? [] : [wake];
    });

    const llmWakes: Array<readonly [Wake, LlmSeat]> = [];

    for (const wake of wakes) {
      const plan = plans.get(wake.request.seat);
      const bot = bots.get(wake.request.seat);

      if (plan?.kind === "llm") llmWakes.push([wake, plan.spec]);
      else if (bot !== undefined) host.submit(wake.request, bot(wake.view, wake.request));
      else host.timeout(wake.request.seat);
    }

    if (llmWakes.length === 0) continue;

    if (spentUsd >= input.budgetUsd) {
      stopForBudget();
      break;
    }

    await Promise.all(llmWakes.map(([wake, spec]) => playLlm(wake, spec)));
  }

  return {
    game: host.result(),
    llm: [...stats.values()],
    transcripts,
    spentUsd,
    budgetExhausted,
  };
};
