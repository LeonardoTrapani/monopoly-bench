import type { ToolArgs, ToolName } from "./tools.ts";

/**
 * What the host answers for one tool call. `ok: false` is a game-level refusal (illegal move,
 * stale decision): the model sees `message` as a tool error and it counts as an invalid action.
 * `terminal: true` means the call answered the seat's pending question, which ends the wake.
 */
export interface ToolOutcome {
  readonly ok: boolean;
  readonly message: string;
  readonly terminal: boolean;
}

/**
 * Host side of the tools: GameDO RPC in production, the in-process engine in local
 * simulations. `callId` is unique per tool call and lets the host ignore duplicates.
 *
 * Throw only for infrastructure failures (the host is unreachable): the model then gets a tool
 * error, but the call does not count as an invalid action.
 */
export type ToolExecutor = <N extends ToolName>(
  name: N,
  args: ToolArgs<N>,
  callId: string,
) => Promise<ToolOutcome>;

/** Limits per wake (SPEC §6.4). */
export interface WakeLimits {
  readonly maxToolCallsPerWake: number;
  readonly maxInvalidPerWake: number;
  readonly wakeTimeoutMs: number;
}

export const DEFAULT_WAKE_LIMITS: WakeLimits = {
  maxToolCallsPerWake: 24,
  maxInvalidPerWake: 6,
  wakeTimeoutMs: 180_000,
};
