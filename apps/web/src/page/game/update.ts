import { SeatActivity, type GameStatus } from "@mb/api";
import type { GameEvent } from "@mb/engine";
import { Option, Schema } from "effect";
import { AsyncData, type Update } from "foldkit";
import { modifyFields } from "foldkit/struct";

import { FeedMessage, type Api } from "../../api/api.ts";
import { failWith, reload, succeedWith } from "../../domain/remote.ts";
import {
  appendEvents,
  fromEvents,
  lastSeq,
  nextStepCursor,
  previousStepCursor,
  snapshotAt,
  step,
  turnEndCursor,
  type Replay,
  type Snapshot,
} from "../../domain/replay.ts";
import {
  FetchEventsSince,
  FetchReplay,
  FetchSummary,
  FetchTranscripts,
  WaitBeforeReconnect,
} from "./command.ts";
import { Message, SeatFilterValue } from "./message.ts";
import {
  Connection,
  MAX_LIVE_WAKES,
  SummaryAsyncData,
  Timeline,
  TranscriptsAsyncData,
  type LiveWake,
  type Model,
  type ReadyTimeline,
} from "./model.ts";

type UpdateReturn = Update.Return<Model, Message, Api>;

/** When following live and this many events behind, jump instead of animating every step. */
const CATCH_UP_JUMP = 400;

/** Folding forward from the cached state is cheaper than restarting from a checkpoint up to here. */
const FORWARD_FOLD_LIMIT = 1500;

export const isLiveStatus = (status: GameStatus): boolean =>
  status === "running" || status === "queued";

export const isLive = (model: Model): boolean =>
  Option.exists(AsyncData.getData(model.summary), (summary) => isLiveStatus(summary.status));

const foldForward = (replay: Replay, from: Snapshot, target: number): Snapshot => {
  let snapshot = from;

  for (let index = from.index; index < target; index += 1) {
    const event = replay.events[index];

    if (event !== undefined) snapshot = step(replay.config, snapshot, event);
  }

  return snapshot;
};

/** Moves the replay cursor (clamped) and recomputes the cached state. */
export const moveCursor = (timeline: ReadyTimeline, cursor: number): ReadyTimeline => {
  const target = Math.max(0, Math.min(cursor, timeline.replay.events.length));

  if (target === timeline.cursor) return timeline;

  const isNearAhead =
    target >= timeline.current.index && target - timeline.current.index <= FORWARD_FOLD_LIMIT;

  const current = isNearAhead
    ? foldForward(timeline.replay, timeline.current, target)
    : snapshotAt(timeline.replay, target);

  return Timeline.Ready({ replay: timeline.replay, cursor: target, current });
};

const withTimeline = (model: Model, transform: (timeline: ReadyTimeline) => ReadyTimeline): Model =>
  Timeline.matchOrElse(
    model.timeline,
    { Ready: (timeline) => modifyFields(model, { timeline: () => transform(timeline) }) },
    () => model,
  );

const readyTimeline = (model: Model): Option.Option<ReadyTimeline> =>
  Timeline.matchOrElse(model.timeline, { Ready: (timeline) => Option.some(timeline) }, () =>
    Option.none(),
  );

/** Appends live events, or asks for the missing ones when the feed skipped some. */
const receiveEvents = (model: Model, events: ReadonlyArray<GameEvent>): UpdateReturn =>
  Option.match(readyTimeline(model), {
    onNone: () => ({ model }),
    onSome: (timeline) => {
      const have = lastSeq(timeline.replay);
      const fresh = events.filter((event) => event.seq > have);
      const first = fresh[0];

      if (first === undefined) return { model };

      if (first.seq > have + 1) {
        return { model, commands: [FetchEventsSince({ gameId: model.gameId, since: have })] };
      }

      const replay = appendEvents(timeline.replay, fresh);
      const wasAtEnd = timeline.cursor === timeline.replay.events.length;

      const extended = Timeline.Ready({
        replay,
        cursor: timeline.cursor,
        current: timeline.current,
      });

      const isFarBehind =
        model.isFollowingLive && replay.events.length - timeline.cursor > CATCH_UP_JUMP;

      return {
        model: modifyFields(model, {
          timeline: () => (isFarBehind ? moveCursor(extended, replay.events.length) : extended),
          motion: () => (isFarBehind ? "Instant" : model.motion),
          isFollowingLive: () =>
            model.isFollowingLive || (wasAtEnd && model.playback === "Playing"),
        }),
      };
    },
  });

const headTurn = (model: Model): number =>
  Option.match(readyTimeline(model), {
    onNone: () => 0,
    onSome: (timeline) => timeline.replay.head.state.control.turn,
  });

const trimWakes = (wakes: ReadonlyArray<LiveWake>): ReadonlyArray<LiveWake> =>
  wakes.length > MAX_LIVE_WAKES ? wakes.slice(wakes.length - MAX_LIVE_WAKES) : wakes;

const updateWake = (
  wakes: ReadonlyArray<LiveWake>,
  seat: LiveWake["seat"],
  decisionId: string,
  create: () => LiveWake,
  change: (wake: LiveWake) => LiveWake,
): ReadonlyArray<LiveWake> => {
  const index = wakes.findIndex((wake) => wake.decisionId === decisionId && wake.seat === seat);

  if (index < 0) return trimWakes([...wakes, change(create())]);

  return wakes.map((wake, position) => (position === index ? change(wake) : wake));
};

/** Folds one `SeatActivity` into the live wakes. */
export const applyActivity = (
  wakes: ReadonlyArray<LiveWake>,
  activity: SeatActivity,
  turn: number,
): ReadonlyArray<LiveWake> => {
  const blank = (
    seat: LiveWake["seat"],
    decisionId: string,
    frame: string,
    round: number,
  ): LiveWake => ({
    seat,
    decisionId,
    frame,
    round,
    turn,
    reasoning: "",
    toolCalls: [],
    usage: Option.none(),
    timedOut: false,
    isFinished: false,
  });

  const frameOf = (decisionId: string): string => decisionId.split(".")[0] ?? "";

  return SeatActivity.match(activity, {
    WakeStarted: (started) =>
      updateWake(
        wakes,
        started.seat,
        started.decisionId,
        () => blank(started.seat, started.decisionId, started.frame, started.round),
        (wake) => ({ ...wake, frame: started.frame, round: started.round }),
      ),
    ReasoningDelta: (delta) =>
      updateWake(
        wakes,
        delta.seat,
        delta.decisionId,
        () => blank(delta.seat, delta.decisionId, frameOf(delta.decisionId), 1),
        (wake) => ({ ...wake, reasoning: wake.reasoning + delta.text }),
      ),
    ToolCalled: (called) =>
      updateWake(
        wakes,
        called.seat,
        called.decisionId,
        () => blank(called.seat, called.decisionId, frameOf(called.decisionId), 1),
        (wake) => ({ ...wake, toolCalls: [...wake.toolCalls, called.call] }),
      ),
    WakeFinished: (finished) =>
      updateWake(
        wakes,
        finished.seat,
        finished.decisionId,
        () => blank(finished.seat, finished.decisionId, frameOf(finished.decisionId), 1),
        (wake) => ({
          ...wake,
          usage: Option.some(finished.usage),
          timedOut: finished.timedOut,
          isFinished: true,
        }),
      ),
  });
};

const setStatus = (model: Model, status: GameStatus): Model =>
  modifyFields(model, {
    summary: AsyncData.map((summary) => ({ ...summary, status })),
  });

const receiveFeed = (model: Model, message: FeedMessage): UpdateReturn =>
  FeedMessage.match<UpdateReturn>(message, {
    Opened: () => ({
      model: modifyFields(model, {
        connection: (connection) =>
          Connection.matchOrElse(
            connection,
            { Connecting: ({ attempt }) => Connection.Open({ attempt }) },
            () => connection,
          ),
      }),
    }),
    Hello: ({ status, lastSeq: serverSeq }) => {
      const have = Option.match(readyTimeline(model), {
        onNone: () => 0,
        onSome: (timeline) => lastSeq(timeline.replay),
      });

      const next = setStatus(model, status);

      return serverSeq > have
        ? { model: next, commands: [FetchEventsSince({ gameId: model.gameId, since: have })] }
        : { model: next };
    },
    Events: ({ events }) => receiveEvents(model, events),
    Activity: ({ activity }) => ({
      model: modifyFields(model, {
        liveWakes: (wakes) => applyActivity(wakes, activity, headTurn(model)),
      }),
    }),
    Status: ({ status }) => {
      const next = setStatus(model, status);

      if (isLiveStatus(status)) return { model: next };

      return {
        model: modifyFields(next, { connection: () => Connection.Offline(), transcripts: reload }),
        commands: [
          FetchSummary({ gameId: model.gameId }),
          FetchTranscripts({ gameId: model.gameId }),
        ],
      };
    },
  });

const connectionLost = (model: Model, error: string): UpdateReturn => {
  if (!isLive(model))
    return { model: modifyFields(model, { connection: () => Connection.Offline() }) };

  const attempt = Connection.matchOrElse(
    model.connection,
    {
      Connecting: ({ attempt }) => attempt,
      Open: ({ attempt }) => attempt,
      Lost: ({ attempt }) => attempt,
    },
    () => 0,
  );

  return {
    model: modifyFields(model, { connection: () => Connection.Lost({ attempt, error }) }),
    commands: [WaitBeforeReconnect(), FetchSummary({ gameId: model.gameId })],
  };
};

const reloadIfEmpty = <A, E>(data: AsyncData.AsyncData<A, E>): AsyncData.AsyncData<A, E> =>
  AsyncData.hasData(data) ? data : reload(data);

const decodeSeatFilter = Schema.decodeUnknownOption(SeatFilterValue);

const pause = (model: Model): Model =>
  modifyFields(model, { playback: () => "Paused", isFollowingLive: () => false });

const jumpTo = (model: Model, cursorOf: (timeline: ReadyTimeline) => number): Model =>
  withTimeline(modifyFields(pause(model), { motion: () => "Instant" }), (timeline) =>
    moveCursor(timeline, cursorOf(timeline)),
  );

const stepTo = (model: Model, cursorOf: (timeline: ReadyTimeline) => number): Model =>
  withTimeline(modifyFields(pause(model), { motion: () => "Smooth" }), (timeline) =>
    moveCursor(timeline, cursorOf(timeline)),
  );

export const init = (gameId: string): UpdateReturn => ({
  model: {
    gameId,
    summary: SummaryAsyncData.Loading(),
    timeline: Timeline.Loading(),
    playback: "Paused",
    speed: 2,
    isFollowingLive: false,
    motion: "Instant",
    connection: Connection.Offline(),
    transcripts: TranscriptsAsyncData.Loading(),
    liveWakes: [],
    tab: "Table",
    seatFilter: Option.none(),
  },
  commands: [FetchSummary({ gameId }), FetchReplay({ gameId }), FetchTranscripts({ gameId })],
});

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    SucceededFetchSummary: ({ summary }) => {
      const isNowLive = isLiveStatus(summary.status);
      const wasKnown = AsyncData.hasData(model.summary);

      return {
        model: modifyFields(model, {
          summary: succeedWith(summary),
          isFollowingLive: () => (wasKnown ? model.isFollowingLive && isNowLive : isNowLive),
          connection: (connection) =>
            isNowLive
              ? Connection.matchOrElse(
                  connection,
                  { Offline: () => Connection.Connecting({ attempt: 0 }) },
                  () => connection,
                )
              : Connection.Offline(),
        }),
      };
    },
    FailedFetchSummary: ({ error }) => ({
      model: modifyFields(model, { summary: failWith(error) }),
    }),

    SucceededFetchReplay: ({ config, events }) => {
      const replay = fromEvents(config, events);

      return {
        model: modifyFields(model, {
          timeline: () =>
            Timeline.Ready({ replay, cursor: replay.events.length, current: replay.head }),
          motion: () => "Instant",
        }),
      };
    },
    FailedFetchReplay: ({ error }) => ({
      model: modifyFields(model, { timeline: () => Timeline.Failed({ error }) }),
    }),

    SucceededFetchTranscripts: ({ transcripts }) => ({
      model: modifyFields(model, { transcripts: succeedWith(transcripts) }),
    }),
    FailedFetchTranscripts: ({ error }) => ({
      model: modifyFields(model, { transcripts: failWith(error) }),
    }),

    SucceededFetchEventsSince: ({ events }) => receiveEvents(model, events),
    FailedFetchEventsSince: ({ error }) => connectionLost(model, error),

    ReceivedFeedMessage: ({ message: feedMessage }) => receiveFeed(model, feedMessage),
    ClosedFeed: () => connectionLost(model, "The live connection closed"),
    FailedFeed: ({ error }) => connectionLost(model, error),
    CompletedWaitBeforeReconnect: () => ({
      model: modifyFields(model, {
        connection: (connection) =>
          Connection.matchOrElse(
            connection,
            {
              Lost: ({ attempt }) =>
                isLive(model)
                  ? Connection.Connecting({ attempt: attempt + 1 })
                  : Connection.Offline(),
            },
            () => connection,
          ),
      }),
    }),

    TickedPlayback: () =>
      Option.match(readyTimeline(model), {
        onNone: () => ({ model }),
        onSome: (timeline) => {
          const end = timeline.replay.events.length;

          if (timeline.cursor >= end) {
            return model.isFollowingLive
              ? { model }
              : { model: modifyFields(model, { playback: () => "Paused" }) };
          }

          return {
            model: modifyFields(model, {
              motion: () => "Smooth",
              timeline: () =>
                moveCursor(timeline, nextStepCursor(timeline.replay, timeline.cursor)),
            }),
          };
        },
      }),

    ClickedPlay: () =>
      Option.match(readyTimeline(model), {
        onNone: () => ({ model }),
        onSome: (timeline) => {
          const isAtEnd = timeline.cursor >= timeline.replay.events.length;

          return {
            model: modifyFields(model, {
              playback: () => "Playing",
              isFollowingLive: () => false,
              motion: () => (isAtEnd ? "Instant" : "Smooth"),
              timeline: () => (isAtEnd && !isLive(model) ? moveCursor(timeline, 0) : timeline),
            }),
          };
        },
      }),
    ClickedPause: () => ({ model: pause(model) }),
    ClickedStepForward: () => ({
      model: stepTo(model, (timeline) => nextStepCursor(timeline.replay, timeline.cursor)),
    }),
    ClickedStepBack: () => ({
      model: stepTo(model, (timeline) => previousStepCursor(timeline.replay, timeline.cursor)),
    }),
    ClickedJumpToStart: () => ({ model: jumpTo(model, () => 0) }),
    ClickedJumpToEnd: () => ({
      model: modifyFields(
        jumpTo(model, (timeline) => timeline.replay.events.length),
        {
          isFollowingLive: () => isLive(model),
        },
      ),
    }),
    ChangedScrubber: ({ value }) => {
      const position = Number.parseInt(value, 10);

      if (Number.isNaN(position)) return { model };

      return { model: jumpTo(model, (timeline) => turnEndCursor(timeline.replay, position)) };
    },
    ClickedTurn: ({ position }) => ({
      model: jumpTo(model, (timeline) => turnEndCursor(timeline.replay, position)),
    }),
    SelectedSpeed: ({ speed }) => ({ model: modifyFields(model, { speed: () => speed }) }),
    ClickedFollowLive: () => ({
      model: withTimeline(
        modifyFields(model, {
          isFollowingLive: () => true,
          playback: () => "Paused",
          motion: () => "Instant",
        }),
        (timeline) => moveCursor(timeline, timeline.replay.events.length),
      ),
    }),

    SelectedTab: ({ tab }) => ({ model: modifyFields(model, { tab: () => tab }) }),
    SelectedSeatFilter: ({ value }) => ({
      model: modifyFields(model, {
        seatFilter: () =>
          Option.flatMap(decodeSeatFilter(value), (seat) =>
            seat === "all" ? Option.none() : Option.some(seat),
          ),
      }),
    }),

    ClickedRetry: () => {
      const commands = [
        ...(AsyncData.hasData(model.summary) ? [] : [FetchSummary({ gameId: model.gameId })]),
        ...Timeline.matchOrElse(
          model.timeline,
          { Failed: () => [FetchReplay({ gameId: model.gameId })] },
          () => [],
        ),
        ...(AsyncData.hasData(model.transcripts)
          ? []
          : [FetchTranscripts({ gameId: model.gameId })]),
      ];

      return {
        model: modifyFields(model, {
          summary: reloadIfEmpty,
          transcripts: reloadIfEmpty,
          timeline: (timeline) =>
            Timeline.matchOrElse(timeline, { Failed: () => Timeline.Loading() }, () => timeline),
        }),
        commands,
      };
    },
  });
