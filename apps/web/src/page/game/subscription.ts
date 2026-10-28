import { Duration, Effect, Option, Schema, Stream } from "effect";
import { Subscription } from "foldkit";

import { Api, describeApiError } from "../../api/api.ts";
import { Message } from "./message.ts";
import { Connection, Speed, Timeline, type Model } from "./model.ts";

/** Milliseconds between playback steps at 1×. */
const STEP_MILLIS = 900;

/** How often a streamed game refetches its summary (per-seat wakes, cost, model errors). */
const SUMMARY_REFRESH_MILLIS = 15_000;

const FeedTarget = Schema.Struct({ gameId: Schema.String, attempt: Schema.Int });

const feedTarget = (model: Model): Option.Option<typeof FeedTarget.Type> => {
  const isReady = Timeline.guards.Ready(model.timeline);

  return Connection.matchOrElse(
    model.connection,
    {
      Connecting: ({ attempt }) =>
        isReady ? Option.some({ gameId: model.gameId, attempt }) : Option.none(),
      Open: ({ attempt }) =>
        isReady ? Option.some({ gameId: model.gameId, attempt }) : Option.none(),
    },
    () => Option.none(),
  );
};

const isTicking = (model: Model): boolean =>
  Timeline.matchOrElse(
    model.timeline,
    {
      Ready: (timeline) =>
        model.playback === "Playing" ||
        (model.isFollowingLive && timeline.cursor < timeline.replay.events.length),
    },
    () => false,
  );

export const subscriptions = Subscription.make<Model, Message, Api>()((entry) => ({
  /** The spectator WebSocket of a live game; restarts on each reconnect attempt. */
  feed: entry(
    { target: Schema.Option(FeedTarget) },
    {
      modelToDependencies: (model) => ({ target: feedTarget(model) }),
      dependenciesToStream: ({ target }) =>
        Option.match(target, {
          onNone: () => Stream.empty,
          onSome: ({ gameId }) =>
            Stream.unwrap(Api.use((api) => Effect.succeed(api.spectate(gameId)))).pipe(
              Stream.map((message) => Message.ReceivedFeedMessage({ message })),
              Stream.concat(Stream.succeed(Message.ClosedFeed())),
              Stream.catch((error) =>
                Stream.succeed(Message.FailedFeed({ error: describeApiError(error) })),
              ),
            ),
        }),
    },
  ),
  /**
   * Seat usage comes from D1, not from the feed: while the game streams, refetch it so the
   * players' wakes, cost and model errors keep up.
   */
  summaryRefresh: entry(
    { isStreaming: Schema.Boolean },
    {
      modelToDependencies: (model) => ({
        isStreaming: Connection.guards.Open(model.connection),
      }),
      dependenciesToStream: ({ isStreaming }) =>
        isStreaming
          ? Stream.tick(Duration.millis(SUMMARY_REFRESH_MILLIS)).pipe(
              Stream.drop(1),
              Stream.map(() => Message.TickedSummaryRefresh()),
            )
          : Stream.empty,
    },
  ),
  /** The playback clock: one step per tick while playing or catching up with a live game. */
  playback: entry(
    { isTicking: Schema.Boolean, speed: Speed },
    {
      modelToDependencies: (model) => ({ isTicking: isTicking(model), speed: model.speed }),
      dependenciesToStream: ({ isTicking: ticking, speed }) =>
        ticking
          ? Stream.tick(Duration.millis(STEP_MILLIS / speed)).pipe(
              Stream.drop(1),
              Stream.map(() => Message.TickedPlayback()),
            )
          : Stream.empty,
    },
  ),
}));
