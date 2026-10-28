import { GameSummary, Seat, WakeTranscript } from "@mb/api";
import { GameConfig, GameEvent } from "@mb/engine";
import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";

import { FeedMessage } from "../../api/api.ts";
import { Speed, Tab } from "./model.ts";

export const Message = defineMessageUnion({
  SucceededFetchSummary: { summary: GameSummary },
  FailedFetchSummary: { error: Schema.String },
  SucceededFetchReplay: { config: GameConfig, events: Schema.Array(GameEvent) },
  FailedFetchReplay: { error: Schema.String },
  SucceededFetchTranscripts: { transcripts: Schema.Array(WakeTranscript) },
  FailedFetchTranscripts: { error: Schema.String },
  SucceededFetchEventsSince: { events: Schema.Array(GameEvent) },
  FailedFetchEventsSince: { error: Schema.String },
  ReceivedFeedMessage: { message: FeedMessage },
  ClosedFeed: {},
  FailedFeed: { error: Schema.String },
  CompletedWaitBeforeReconnect: {},
  TickedPlayback: {},
  TickedSummaryRefresh: {},
  ClickedPlay: {},
  ClickedPause: {},
  ClickedStepForward: {},
  ClickedStepBack: {},
  ClickedJumpToStart: {},
  ClickedJumpToEnd: {},
  ChangedScrubber: { value: Schema.String },
  ClickedTurn: { position: Schema.Int },
  SelectedSpeed: { speed: Speed },
  ClickedFollowLive: {},
  SelectedTab: { tab: Tab },
  SelectedSeatFilter: { value: Schema.String },
  ClickedRetry: {},
});

export type Message = typeof Message.Type;

export const SeatFilterValue = Schema.Union([Seat, Schema.Literal("all")]);
