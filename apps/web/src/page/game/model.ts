/** Model of the game viewer (`/games/:id`). */
import { GameSummary, Seat, ToolCallRecord, WakeTranscript, WakeUsage } from "@mb/api";
import { Schema } from "effect";
import { AsyncData } from "foldkit";
import { defineTaggedUnion } from "foldkit/schema";

import { Replay, Snapshot } from "../../domain/replay.ts";

export const SummaryAsyncData = AsyncData.Schema(GameSummary, Schema.String);

export const TranscriptsAsyncData = AsyncData.Schema(Schema.Array(WakeTranscript), Schema.String);

/**
 * The replay timeline. `current` is the state after `cursor` events; it is derived from
 * `replay` and `cursor` but cached here because folding thousands of events on every render
 * (activity deltas arrive several times a second) would be too slow. Only `update` writes it,
 * always through `moveCursor` or `appendEvents`, so it cannot drift.
 */
export const Timeline = defineTaggedUnion({
  Loading: {},
  Failed: { error: Schema.String },
  Ready: { replay: Replay, cursor: Schema.Int, current: Snapshot },
});

export type Timeline = typeof Timeline.Type;

export type ReadyTimeline = typeof Timeline.Ready.Type;

export const Playback = Schema.Literals(["Paused", "Playing"]);

export type Playback = typeof Playback.Type;

export const Speed = Schema.Literals([1, 2, 4, 8]);

export type Speed = typeof Speed.Type;

export const SPEEDS: ReadonlyArray<Speed> = [1, 2, 4, 8];

/** Smooth: tokens glide (playback, live); Instant: jumps (scrubbing far). */
export const Motion = Schema.Literals(["Smooth", "Instant"]);

export type Motion = typeof Motion.Type;

/** The spectator WebSocket of a live game. */
export const Connection = defineTaggedUnion({
  Offline: {},
  Connecting: { attempt: Schema.Int },
  Open: { attempt: Schema.Int },
  Lost: { attempt: Schema.Int, error: Schema.String },
});

export type Connection = typeof Connection.Type;

/** A wake streamed live over the spectator feed (`SeatActivity`). */
export const LiveWake = Schema.Struct({
  seat: Seat,
  decisionId: Schema.String,
  frame: Schema.String,
  round: Schema.Int,
  /** Game turn when the wake started. */
  turn: Schema.Int,
  reasoning: Schema.String,
  toolCalls: Schema.Array(ToolCallRecord),
  usage: Schema.Option(WakeUsage),
  timedOut: Schema.Boolean,
  isFinished: Schema.Boolean,
});

export type LiveWake = typeof LiveWake.Type;

export const Tab = Schema.Literals(["Table", "Reasoning", "Log"]);

export type Tab = typeof Tab.Type;

export const Model = Schema.Struct({
  gameId: Schema.String,
  summary: SummaryAsyncData.schema,
  timeline: Timeline,
  playback: Playback,
  speed: Speed,
  isFollowingLive: Schema.Boolean,
  motion: Motion,
  connection: Connection,
  transcripts: TranscriptsAsyncData.schema,
  liveWakes: Schema.Array(LiveWake),
  tab: Tab,
  seatFilter: Schema.Option(Seat),
});

export type Model = typeof Model.Type;

/** Live wakes kept in memory (the most recent ones). */
export const MAX_LIVE_WAKES = 60;
