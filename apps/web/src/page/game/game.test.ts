import { SeatActivity } from "@mb/api";
import { replay } from "@mb/engine";
import { AsyncData } from "foldkit";
import * as Scene from "foldkit/scene";
import { Command, given, message, model, story } from "foldkit/story";
import { describe, expect, it } from "vite-plus/test";

import { FeedMessage } from "../../api/api.ts";
import {
  appendEvents,
  fromEvents,
  nextStepCursor,
  previousStepCursor,
  snapshotAt,
  turnEndCursor,
  turnIndexAt,
} from "../../domain/replay.ts";
import { sample2p, summary } from "../../testing/fixtures.ts";
import {
  FetchEventsSince,
  FetchReplay,
  FetchSummary,
  FetchTranscripts,
  WaitBeforeReconnect,
} from "./command.ts";
import { Message } from "./message.ts";
import {
  Connection,
  SummaryAsyncData,
  Timeline,
  TranscriptsAsyncData,
  type Model,
  type ReadyTimeline,
} from "./model.ts";
import { init, update } from "./update.ts";
import { view } from "./view/index.ts";

const { config, events } = sample2p;

const full = fromEvents(config, events);

const readyModel = (cursor: number, status: "finished" | "running" = "finished"): Model => {
  const base = init(config.gameId).model;

  return {
    ...base,
    summary: SummaryAsyncData.Success({ data: summary(status) }),
    transcripts: TranscriptsAsyncData.Success({ data: [] }),
    timeline: Timeline.Ready({ replay: full, cursor, current: snapshotAt(full, cursor) }),
  };
};

const timelineOf = (current: Model): ReadyTimeline =>
  Timeline.matchOrElse(current.timeline, { Ready: (ready) => ready }, () => {
    throw new Error("Timeline is not ready");
  });

describe("replay timeline", () => {
  it("matches the engine's replay at every checkpoint and at the end", () => {
    expect(full.head.state).toEqual(replay(config, events));

    for (const cursor of [0, 1, 57, 200, 333, events.length]) {
      expect(snapshotAt(full, cursor).state).toEqual(replay(config, events.slice(0, cursor)));
    }
  });

  it("appends live batches incrementally and drops duplicates", () => {
    const half = Math.floor(events.length / 2);

    const incremental = appendEvents(
      appendEvents(fromEvents(config, events.slice(0, half)), events.slice(half - 5)),
      events.slice(half),
    );

    expect(incremental.events).toHaveLength(events.length);
    expect(incremental.head.state).toEqual(full.head.state);
    expect(incremental.turns).toEqual(full.turns);
  });

  it("indexes turns for the scrubber", () => {
    const lastTurn = full.turns.length - 1;

    expect(full.turns[0]?.turn).toBe(1);
    expect(turnEndCursor(full, lastTurn)).toBe(events.length);
    expect(turnIndexAt(full, turnEndCursor(full, 3))).toBe(3);
  });

  it("steps over pure control events", () => {
    const next = nextStepCursor(full, 0);
    const event = events[next - 1];

    expect(event?._tag).not.toBe("SeatDone");
    expect(previousStepCursor(full, nextStepCursor(full, next))).toBe(next);
  });
});

describe("viewer update", () => {
  it("loads the summary, the replay and the transcripts; retry while loading sends nothing", () => {
    story(
      update,
      given(init(config.gameId).model),
      message(Message.ClickedRetry()),
      Command.expectNone(),
    );

    const init_ = init(config.gameId);

    expect(init_.commands?.map((command) => command.name)).toEqual([
      "FetchSummary",
      "FetchReplay",
      "FetchTranscripts",
    ]);
  });

  it("a finished game opens at its final position", () => {
    story(
      update,
      given(init(config.gameId).model),
      message(Message.SucceededFetchReplay({ config, events })),
      model((next) => {
        expect(timelineOf(next).cursor).toBe(events.length);
        expect(timelineOf(next).current.state.status).toBe("finished");
        expect(next.motion).toBe("Instant");
      }),
    );
  });

  it("scrubbing jumps to the end of a turn without animating", () => {
    story(
      update,
      given(readyModel(events.length)),
      message(Message.ChangedScrubber({ value: "4" })),
      model((next) => {
        expect(timelineOf(next).cursor).toBe(turnEndCursor(full, 4));
        expect(timelineOf(next).current.state).toEqual(
          replay(config, events.slice(0, turnEndCursor(full, 4))),
        );
        expect(next.motion).toBe("Instant");
        expect(next.playback).toBe("Paused");
      }),
    );
  });

  it("play from the end restarts, and ticks advance one visible step", () => {
    story(
      update,
      given(readyModel(events.length)),
      message(Message.ClickedPlay()),
      model((next) => {
        expect(next.playback).toBe("Playing");
        expect(timelineOf(next).cursor).toBe(0);
      }),
      message(Message.TickedPlayback()),
      model((next) => {
        expect(timelineOf(next).cursor).toBe(nextStepCursor(full, 0));
        expect(next.motion).toBe("Smooth");
      }),
      message(Message.ClickedPause()),
      model((next) => expect(next.playback).toBe("Paused")),
    );
  });

  it("stepping back and forward moves one visible event", () => {
    const start = turnEndCursor(full, 10);

    story(
      update,
      given(readyModel(start)),
      message(Message.ClickedStepForward()),
      model((next) => expect(timelineOf(next).cursor).toBe(nextStepCursor(full, start))),
      message(Message.ClickedStepBack()),
      model((next) =>
        expect(timelineOf(next).cursor).toBe(previousStepCursor(full, nextStepCursor(full, start))),
      ),
    );
  });

  it("a live summary connects the spectator feed and follows the head", () => {
    story(
      update,
      given(init(config.gameId).model),
      message(Message.SucceededFetchSummary({ summary: summary("running") })),
      model((next) => {
        expect(next.isFollowingLive).toBe(true);
        expect(next.connection).toEqual(Connection.Connecting({ attempt: 0 }));
      }),
    );
  });

  it("live events extend the timeline; a gap asks for the missing events", () => {
    const partial = fromEvents(config, events.slice(0, 100));

    const live: Model = {
      ...readyModel(0, "running"),
      isFollowingLive: true,
      connection: Connection.Open({ attempt: 0 }),
      timeline: Timeline.Ready({ replay: partial, cursor: 100, current: partial.head }),
    };

    story(
      update,
      given(live),
      message(
        Message.ReceivedFeedMessage({
          message: FeedMessage.cases.Events.make({ events: events.slice(100, 120) }),
        }),
      ),
      model((next) => {
        expect(timelineOf(next).replay.events).toHaveLength(120);
        expect(timelineOf(next).cursor).toBe(100);
      }),
      message(Message.TickedPlayback()),
      model((next) =>
        expect(timelineOf(next).cursor).toBe(nextStepCursor(timelineOf(next).replay, 100)),
      ),
      message(
        Message.ReceivedFeedMessage({
          message: FeedMessage.cases.Events.make({ events: events.slice(150, 160) }),
        }),
      ),
      Command.expectExact(
        FetchEventsSince({ gameId: config.gameId, since: events[119]?.seq ?? 0 }),
      ),
      Command.resolve(
        FetchEventsSince,
        Message.SucceededFetchEventsSince({ events: events.slice(120, 160) }),
      ),
      model((next) => expect(timelineOf(next).replay.events).toHaveLength(160)),
    );
  });

  it("seat activity streams into live wakes", () => {
    const decision = { seat: "A" as const, decisionId: "7.1.A" };

    story(
      update,
      given(readyModel(events.length, "running")),
      message(
        Message.ReceivedFeedMessage({
          message: FeedMessage.cases.Activity.make({
            activity: SeatActivity.cases.WakeStarted.make({
              ...decision,
              frame: "Table",
              round: 1,
            }),
          }),
        }),
      ),
      message(
        Message.ReceivedFeedMessage({
          message: FeedMessage.cases.Activity.make({
            activity: SeatActivity.cases.ReasoningDelta.make({
              ...decision,
              text: "Thinking about ",
            }),
          }),
        }),
      ),
      message(
        Message.ReceivedFeedMessage({
          message: FeedMessage.cases.Activity.make({
            activity: SeatActivity.cases.ReasoningDelta.make({ ...decision, text: "Boardwalk." }),
          }),
        }),
      ),
      model((next) => {
        expect(next.liveWakes).toHaveLength(1);
        expect(next.liveWakes[0]?.reasoning).toBe("Thinking about Boardwalk.");
        expect(next.liveWakes[0]?.isFinished).toBe(false);
      }),
      message(
        Message.ReceivedFeedMessage({
          message: FeedMessage.cases.Activity.make({
            activity: SeatActivity.cases.WakeFinished.make({
              ...decision,
              usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 0, costUsd: 0.01 },
              timedOut: false,
            }),
          }),
        }),
      ),
      model((next) => expect(next.liveWakes[0]?.isFinished).toBe(true)),
    );
  });

  it("a game that ends while watching stops the feed and reloads its data", () => {
    story(
      update,
      given({
        ...readyModel(events.length, "running"),
        connection: Connection.Open({ attempt: 0 }),
      }),
      message(
        Message.ReceivedFeedMessage({
          message: FeedMessage.cases.Status.make({ status: "finished" }),
        }),
      ),
      model((next) => {
        expect(next.connection).toEqual(Connection.Offline());
        expect(AsyncData.getData(next.summary)._tag).toBe("Some");
      }),
      Command.resolveAll(
        [FetchSummary, Message.SucceededFetchSummary({ summary: summary("finished") })],
        [FetchTranscripts, Message.SucceededFetchTranscripts({ transcripts: [] })],
      ),
    );
  });

  it("a dropped connection retries", () => {
    story(
      update,
      given({
        ...readyModel(events.length, "running"),
        connection: Connection.Open({ attempt: 2 }),
      }),
      message(Message.ClosedFeed()),
      model((next) => expect(next.connection._tag).toBe("Lost")),
      Command.resolveAll(
        [WaitBeforeReconnect, Message.CompletedWaitBeforeReconnect()],
        [FetchSummary, Message.SucceededFetchSummary({ summary: summary("running") })],
      ),
      model((next) => expect(next.connection).toEqual(Connection.Connecting({ attempt: 3 }))),
    );
  });
});

describe("viewer view", () => {
  it("renders the board, the players and the timeline", () => {
    Scene.scene(
      { update, view },
      Scene.given(readyModel(turnEndCursor(full, 6))),
      Scene.expect(Scene.role("img", { name: "Monopoly board" })).toExist(),
      Scene.expect(Scene.role("slider", { name: "Turn" })).toExist(),
      Scene.expect(Scene.role("button", { name: "Play" })).toExist(),
      Scene.expect(Scene.role("tab", { name: "Table & offers" })).toHaveAttr(
        "aria-selected",
        "true",
      ),
    );
  });

  it("the log tab shows the engine digest", () => {
    Scene.scene(
      { update, view },
      Scene.given(readyModel(turnEndCursor(full, 2))),
      Scene.click(Scene.role("tab", { name: "Event log" })),
      Scene.expect(Scene.text(/rolled \d\+\d/)).toExist(),
    );
  });

  it("bot-only games explain why there is no reasoning", () => {
    Scene.scene(
      { update, view },
      Scene.given(readyModel(events.length)),
      Scene.click(Scene.role("tab", { name: "Reasoning" })),
      Scene.expect(Scene.text("Bots think silently")).toExist(),
    );
  });

  it("a failed load offers a retry", () => {
    Scene.scene(
      { update, view },
      Scene.given({
        ...init(config.gameId).model,
        timeline: Timeline.Failed({ error: "Game not found (HTTP 404)" }),
      }),
      Scene.expect(Scene.text("Game not found (HTTP 404)")).toExist(),
      Scene.click(Scene.role("button", { name: "Retry" })),
      Scene.Command.resolveAll(
        [FetchSummary, Message.FailedFetchSummary({ error: "Game not found (HTTP 404)" })],
        [FetchReplay, Message.FailedFetchReplay({ error: "Game not found (HTTP 404)" })],
        [FetchTranscripts, Message.FailedFetchTranscripts({ error: "Game not found (HTTP 404)" })],
      ),
      Scene.expect(Scene.text("Game not found (HTTP 404)")).toExist(),
    );
  });
});
