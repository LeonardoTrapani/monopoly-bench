/**
 * Tool handling against the engine, shared by every host: `inspect` answers, command
 * outcomes, and a ready `ToolExecutor` for in-process hosts (the CLI, tests). GameDO uses the
 * same pieces with its own persistence.
 */
import {
  type Command,
  decisionIdOf,
  digest,
  type GameEvent,
  type GameState,
  type IllegalCommand,
  type PlayerView,
  playerView,
  type Seat,
} from "@mb/engine";
import { Result } from "effect";

import { commandFromTool, isCommandTool } from "./commands.ts";
import type { ToolExecutor, ToolOutcome } from "./executor.ts";
import {
  renderDeed,
  renderHoldings,
  renderOffers,
  renderPlayerView,
  renderRules,
} from "./render.ts";
import { resolveProperty } from "./commands.ts";
import { isToolArgs, type ToolArgs } from "./tools.ts";

export const CLOSED_DECISION =
  "This decision is closed (answered, timed out or superseded). Wait for your next wake.";

/** The answer to an `inspect` call. */
export const inspectText = (view: PlayerView, args: ToolArgs<"inspect">): string => {
  const subject = args.subject;

  if (args.topic === "table") return renderPlayerView(view);

  if (args.topic === "offers")
    return view.offers.length === 0 ? "No offers this session." : renderOffers(view.offers);

  if (args.topic === "rules") return renderRules(view.rules);

  if (args.topic === "player")
    return renderHoldings(view, String(subject ?? view.seat).toUpperCase());

  const property = subject === undefined ? null : resolveProperty(subject);

  return property === null
    ? `Unknown deed "${subject ?? ""}": give a printed name, a slug or a board position.`
    : renderDeed(view, property);
};

/** What the model reads after a command was accepted: the events it caused, as English. */
export const outcomeText = (events: ReadonlyArray<GameEvent>, seat: Seat): string => {
  const lines = digest(events, 0, seat);

  return lines.length === 0 ? "Accepted." : lines.join("\n");
};

/** A refusal carrying the engine's reason (SPEC §6.3). */
export const illegalText = (problem: IllegalCommand): string => problem.reason;

export interface EngineSeatHost {
  readonly state: () => GameState;
  /** Applies a command for real, or returns the engine's refusal. */
  readonly submit: (command: Command) => Result.Result<ReadonlyArray<GameEvent>, IllegalCommand>;
  readonly notes: () => string;
  readonly saveNotes: (text: string) => void;
}

const refusal = (message: string, terminal: boolean): ToolOutcome => ({
  ok: false,
  message,
  terminal,
});

/**
 * A `ToolExecutor` for one wake of `seat` answering `decisionId`, applying commands to an
 * in-process game as they come (so the model sees each engine refusal).
 */
export const engineExecutor =
  (host: EngineSeatHost, seat: Seat, decisionId: string): ToolExecutor =>
  async (name, args) => {
    const state = host.state();

    if (decisionIdOf(state, seat) !== decisionId) return refusal(CLOSED_DECISION, true);

    if (!isToolArgs(name, args)) return refusal(`Invalid arguments for ${name}.`, false);

    if (name === "inspect") {
      return isToolArgs("inspect", args)
        ? { ok: true, message: inspectText(playerView(state, seat), args), terminal: false }
        : refusal("Invalid arguments for inspect.", false);
    }

    if (name === "note") {
      if (!isToolArgs("note", args)) return refusal("Invalid arguments for note.", false);

      const text = args.text.slice(0, state.config.rules.notesMaxChars);
      host.saveNotes(text);

      return { ok: true, message: `Notes saved (${text.length} characters).`, terminal: false };
    }

    if (!isCommandTool(name) || !isToolArgs(name, args)) {
      return refusal(`Invalid arguments for ${name}.`, false);
    }

    const built = commandFromTool({ seat, decisionId }, name, args);

    if (Result.isFailure(built)) return refusal(built.failure, false);

    const applied = host.submit(built.success);

    if (Result.isFailure(applied)) return refusal(illegalText(applied.failure), false);

    return {
      ok: true,
      message: outcomeText(applied.success, seat),
      terminal: decisionIdOf(host.state(), seat) !== decisionId,
    };
  };
