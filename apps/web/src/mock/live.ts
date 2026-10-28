/**
 * The mock live game: a fixture replayed on a wall-clock schedule, as if a server were playing it.
 * LLM decisions take a few seconds and stream their reasoning and tool calls as `SeatActivity`
 * before the resulting events are sent, exercising the whole live path of the viewer.
 */
import { SeatActivity, type WakeTranscript } from "@mb/api";
import type { GameEvent } from "@mb/engine";
import { Effect, Queue, Stream } from "effect";

import { FeedMessage, type ApiError } from "../api/api.ts";
import { isVisibleStep } from "../domain/replay.ts";
import type { LoadedGame } from "./games.ts";
import type { MockWake } from "./transcripts.ts";

interface Step {
  /** Events up to this index are public once the step ends. */
  readonly endIndex: number;
  readonly duration: number;
  readonly wake: WakeTranscript | null;
}

export interface LiveSchedule {
  readonly game: LoadedGame;
  readonly wakes: ReadonlyArray<MockWake>;
  readonly steps: ReadonlyArray<Step>;
  /** Start time of each step, in ms from the schedule start. */
  readonly starts: ReadonlyArray<number>;
  /** The game was already this far along (ms) when the mock started. */
  readonly offset: number;
}

const MOCK_EPOCH = Date.now();

/** Share of the game already played when the mock starts. */
const HEAD_START = 0.38;

const BUSY_WAKE_MS = 3400;

const QUICK_WAKE_MS = 1100;

const EVENT_STEP_MS = 420;

const CONNECT_DELAY_MS = 150;

const isBusy = (wake: WakeTranscript): boolean =>
  wake.toolCalls.some(
    (record) => record.name !== "done" && record.name !== "pass_bid" && record.name !== "inspect",
  );

export const buildSchedule = (game: LoadedGame, wakes: ReadonlyArray<MockWake>): LiveSchedule => {
  const steps: Array<Step> = [];
  const wakesByIndex = new Map<number, Array<WakeTranscript>>();

  for (const wake of wakes) {
    const list = wakesByIndex.get(wake.eventIndex) ?? [];

    list.push(wake.transcript);
    wakesByIndex.set(wake.eventIndex, list);
  }

  for (const [index, event] of game.events.entries()) {
    const atIndex = wakesByIndex.get(index) ?? [];

    for (const [position, wake] of atIndex.entries()) {
      const isLast = position === atIndex.length - 1;

      steps.push({
        endIndex: isLast ? index + 1 : index,
        duration: isBusy(wake) ? BUSY_WAKE_MS : QUICK_WAKE_MS,
        wake,
      });
    }

    if (atIndex.length === 0 && isVisibleStep(event))
      steps.push({ endIndex: index + 1, duration: EVENT_STEP_MS, wake: null });
  }

  const starts: Array<number> = [];
  let total = 0;

  for (const step of steps) {
    starts.push(total);
    total += step.duration;
  }

  const headStep = Math.floor(steps.length * HEAD_START);

  return { game, wakes, steps, starts, offset: starts[headStep] ?? 0 };
};

const elapsed = (schedule: LiveSchedule): number => Date.now() - MOCK_EPOCH + schedule.offset;

/** Number of steps fully played by now. */
const stepsDone = (schedule: LiveSchedule): number => {
  const now = elapsed(schedule);
  let done = 0;

  for (const [index, start] of schedule.starts.entries()) {
    const step = schedule.steps[index];

    if (step !== undefined && start + step.duration <= now) done = index + 1;
    else break;
  }

  return done;
};

/** Events public by now. */
export const liveEventCount = (schedule: LiveSchedule): number => {
  const done = stepsDone(schedule);

  return done === 0 ? 0 : (schedule.steps[done - 1]?.endIndex ?? 0);
};

export const isLiveFinished = (schedule: LiveSchedule): boolean =>
  stepsDone(schedule) >= schedule.steps.length;

export const liveEvents = (schedule: LiveSchedule): ReadonlyArray<GameEvent> =>
  schedule.game.events.slice(0, liveEventCount(schedule));

export const liveTranscripts = (schedule: LiveSchedule): ReadonlyArray<WakeTranscript> => {
  const count = liveEventCount(schedule);

  return schedule.wakes.filter((wake) => wake.eventIndex < count).map((wake) => wake.transcript);
};

const sleepUntil = (schedule: LiveSchedule, at: number) =>
  Effect.sleep(Math.max(0, at - elapsed(schedule)));

const chunks = (text: string, count: number): ReadonlyArray<string> => {
  const words = text.split(" ");
  const size = Math.max(1, Math.ceil(words.length / count));

  return Array.from({ length: Math.ceil(words.length / size) }, (_, index) => {
    const part = words.slice(index * size, (index + 1) * size).join(" ");

    return index === 0 ? part : ` ${part}`;
  });
};

const activity = (value: SeatActivity): FeedMessage =>
  FeedMessage.cases.Activity.make({ activity: value });

/** The spectator feed of the live game, timed against the shared schedule. */
export const liveFeed = (
  schedule: LiveSchedule,
  gameId: string,
): Stream.Stream<FeedMessage, ApiError> =>
  Stream.callback<FeedMessage, ApiError>((queue) =>
    Effect.gen(function* () {
      yield* Effect.sleep(CONNECT_DELAY_MS);
      Queue.offerUnsafe(queue, FeedMessage.cases.Opened.make({}));

      const start = stepsDone(schedule);
      let emitted = start === 0 ? 0 : (schedule.steps[start - 1]?.endIndex ?? 0);

      Queue.offerUnsafe(
        queue,
        FeedMessage.cases.Hello.make({
          status: "running",
          lastSeq: schedule.game.events[emitted - 1]?.seq ?? 0,
        }),
      );

      for (let index = start; index < schedule.steps.length; index += 1) {
        const step = schedule.steps[index];
        const stepStart = schedule.starts[index] ?? 0;

        if (step === undefined) continue;

        const wake = step.wake;

        if (wake !== null) {
          const ids = { seat: wake.seat, decisionId: wake.decisionId };

          Queue.offerUnsafe(
            queue,
            activity(
              SeatActivity.cases.WakeStarted.make({
                ...ids,
                frame: wake.frame,
                round: wake.round,
                turn: wake.turn,
                reasons: wake.reasons,
              }),
            ),
          );

          const parts = chunks(wake.reasoning, 5);

          for (const [position, text] of parts.entries()) {
            yield* sleepUntil(
              schedule,
              stepStart + ((position + 1) / (parts.length + 2)) * step.duration,
            );
            Queue.offerUnsafe(
              queue,
              activity(SeatActivity.cases.ReasoningDelta.make({ ...ids, text })),
            );
          }

          for (const record of wake.toolCalls) {
            yield* sleepUntil(schedule, stepStart + step.duration * 0.85);
            Queue.offerUnsafe(
              queue,
              activity(SeatActivity.cases.ToolCalled.make({ ...ids, call: record })),
            );
          }

          yield* sleepUntil(schedule, stepStart + step.duration);
          Queue.offerUnsafe(
            queue,
            activity(
              SeatActivity.cases.WakeFinished.make({ ...ids, usage: wake.usage, timedOut: false }),
            ),
          );
        } else {
          yield* sleepUntil(schedule, stepStart + step.duration);
        }

        if (step.endIndex > emitted) {
          Queue.offerUnsafe(
            queue,
            FeedMessage.cases.Events.make({
              events: schedule.game.events.slice(emitted, step.endIndex),
            }),
          );
          emitted = step.endIndex;
        }
      }

      Queue.offerUnsafe(queue, FeedMessage.cases.Status.make({ status: "finished" }));
      Queue.endUnsafe(queue);

      return gameId;
    }),
  );
