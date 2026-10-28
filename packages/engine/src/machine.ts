/**
 * The decider's working memory: the current state, the events emitted so far and the
 * queue of engine tasks still to run. Every emitted event is folded with `evolve`
 * immediately, so the machine's state is always `fold(evolve, events)`.
 */
import { evolve } from "./evolve.ts";
import { gameEvent, PUBLIC } from "./schema/events.ts";

import type { Visibility } from "./schema/common.ts";
import type { EventInput, EventKind, GameEvent } from "./schema/events.ts";
import type { Frame, FrameOf, GameState, Task } from "./schema/state.ts";

export class Machine {
  state: GameState;
  readonly events: Array<GameEvent> = [];
  /** Engine tasks to run before anything else; moved into a frame's `after` when one is pushed. */
  queue: Array<Task> = [];

  constructor(state: GameState) {
    this.state = state;
  }

  /** Emits an event at the current turn (or at `turn` for `TurnStarted`) and folds it. */
  emit<K extends EventKind>(
    tag: K,
    input: EventInput<K>,
    visibility: Visibility = PUBLIC,
    turn: number = this.state.control.turn,
  ): void {
    const event = gameEvent(tag, { seq: this.state.seq + 1, turn, visibility }, input);

    this.state = evolve(this.state, event);
    this.events.push(event);
  }

  /** Runs `tasks` next, before anything already queued. */
  next(...tasks: ReadonlyArray<Task>): void {
    this.queue.unshift(...tasks);
  }
}

type FrameInput<K extends Frame["_tag"]> = Omit<FrameOf<K>, "_tag" | "id" | "after">;

type TaskInput<K extends Task["_tag"]> = Omit<Extract<Task, { readonly _tag: K }>, "_tag">;

/** Fast unchecked task constructor (hot path; checked by the type system). */
export const task = <K extends Task["_tag"]>(
  tag: K,
  input: TaskInput<K>,
): Extract<Task, { readonly _tag: K }> => {
  const value = { _tag: tag, ...input };

  // SAFETY: `input` is task variant `K` without its tag, which is added back here.
  return value as Extract<Task, { readonly _tag: K }>;
};

function frameValue<K extends Frame["_tag"]>(
  tag: K,
  id: number,
  after: ReadonlyArray<Task>,
  input: FrameInput<K>,
): FrameOf<K>;

function frameValue(
  tag: Frame["_tag"],
  id: number,
  after: ReadonlyArray<Task>,
  input: FrameInput<Frame["_tag"]>,
): Frame {
  // SAFETY: the overload ties `input` to the variant named by `tag`; tag, id and continuation
  // are the only fields it lacks.
  return { _tag: tag, id, after, ...input } as Frame;
}

/**
 * Pushes a new frame. Every queued task moves into the frame's `after` list: it will
 * run once the frame closes.
 */
export const pushFrame = <K extends Frame["_tag"]>(
  machine: Machine,
  tag: K,
  input: FrameInput<K>,
): void => {
  const frame = frameValue(tag, machine.state.nextFrameId, machine.queue, input);

  machine.queue = [];
  machine.emit("FramePushed", { frame });
};

/** Pops a frame; its continuation tasks run after anything already queued. */
export const popFrame = (machine: Machine, frame: Frame): void => {
  machine.emit("FramePopped", { frameId: frame.id });
  machine.queue.push(...frame.after);
};
