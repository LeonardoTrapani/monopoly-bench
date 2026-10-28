/**
 * Payloads exchanged between the Worker and its Durable Objects (RunDO, GameDO, PlayerDO).
 * They are Effect schemas so the same definitions decode JSON stored in Durable Object SQLite.
 * Public HTTP shapes live in `@mb/api`.
 */
import { TOOL_NAMES } from "@mb/agent";
import { LlmSeat, PlayersCount, Seat, SeatSpec, SpectatorMessage, WakeTranscript } from "@mb/api";
import { GameConfig } from "@mb/engine";
import { Schema } from "effect";

export const CompetitorKind = Schema.Literals(["llm", "bot"]);

export type CompetitorKind = typeof CompetitorKind.Type;

export const PlannedSeat = Schema.Struct({
  seat: Seat,
  spec: SeatSpec,
  competitorId: Schema.String,
  label: Schema.String,
  kind: CompetitorKind,
});

export type PlannedSeat = typeof PlannedSeat.Type;

export const WakeLimitsSchema = Schema.Struct({
  maxToolCallsPerWake: Schema.Int,
  maxInvalidPerWake: Schema.Int,
  wakeTimeoutMs: Schema.Int,
});

/** The fields of OpenRouter's public `GET /models` entry that pricing needs. */
export const ModelListing = Schema.Struct({
  id: Schema.String,
  context_length: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  top_provider: Schema.optionalKey(
    Schema.Struct({
      context_length: Schema.optionalKey(Schema.NullOr(Schema.Number)),
      max_completion_tokens: Schema.optionalKey(Schema.NullOr(Schema.Number)),
    }),
  ),
  pricing: Schema.optionalKey(
    Schema.Struct({
      prompt: Schema.optionalKey(Schema.String),
      completion: Schema.optionalKey(Schema.String),
      input_cache_read: Schema.optionalKey(Schema.String),
      input_cache_write: Schema.optionalKey(Schema.String),
    }),
  ),
});

export type ModelListing = typeof ModelListing.Type;

/** RunDO → GameDO: everything a game needs to start. */
export const GameStart = Schema.Struct({
  gameId: Schema.String,
  runId: Schema.String,
  gameIndex: Schema.Int,
  /** The engine's game config (seed, seats, rules incl. wake limits): enough to replay. */
  config: GameConfig,
  /** Seat specs in seat order (how each seat is played: bot policy or LLM model). */
  seats: Schema.Array(PlannedSeat),
  /** Price snapshot of the run's LLM models, taken when the run was created. */
  listings: Schema.Array(ModelListing),
  budgetExhausted: Schema.Boolean,
});

export type GameStart = typeof GameStart.Type;

/** GameDO → PlayerDO: run one wake. */
export const WakeRequest = Schema.Struct({
  gameId: Schema.String,
  runId: Schema.String,
  seat: Seat,
  decisionId: Schema.String,
  /** Rounds of one session share it: the conversation continues. A new key resets it. */
  sessionKey: Schema.String,
  turn: Schema.Int,
  frame: Schema.String,
  round: Schema.Int,
  reasons: Schema.Array(Schema.String),
  spec: LlmSeat,
  listing: Schema.NullOr(ModelListing),
  systemPrompt: Schema.String,
  message: Schema.String,
  limits: WakeLimitsSchema,
  /** Epoch ms after which GameDO applies the default action. */
  deadline: Schema.Number,
});

export type WakeRequest = typeof WakeRequest.Type;

export const ToolNameSchema = Schema.Literals(TOOL_NAMES);

/** PlayerDO → GameDO: one tool call (SPEC §7.1 idempotency key: gameId, seat, decisionId, callId). */
export const SeatCall = Schema.Struct({
  gameId: Schema.String,
  seat: Seat,
  decisionId: Schema.String,
  callId: Schema.String,
  tool: ToolNameSchema,
  args: Schema.Json,
});

export type SeatCall = typeof SeatCall.Type;

export const SeatCallResult = Schema.Struct({
  ok: Schema.Boolean,
  message: Schema.String,
  terminal: Schema.Boolean,
});

export type SeatCallResult = typeof SeatCallResult.Type;

/** PlayerDO → GameDO when a wake ends, answered or not. */
export const WakeReport = Schema.Struct({
  gameId: Schema.String,
  seat: Seat,
  decisionId: Schema.String,
  transcript: WakeTranscript,
  latencyMs: Schema.Number,
  endReason: Schema.String,
});

export type WakeReport = typeof WakeReport.Type;

export const SeatResult = Schema.Struct({
  seat: Seat,
  competitorId: Schema.String,
  label: Schema.String,
  kind: CompetitorKind,
  rank: Schema.NullOr(Schema.Int),
});

export type SeatResult = typeof SeatResult.Type;

/** GameDO → RunDO when a game ends. */
export const GameOutcome = Schema.Struct({
  gameId: Schema.String,
  status: Schema.Literals(["finished", "aborted", "failed"]),
  playersCount: PlayersCount,
  finishedAt: Schema.String,
  results: Schema.Array(SeatResult),
});

export type GameOutcome = typeof GameOutcome.Type;

export const ChargeResult = Schema.Struct({ exhausted: Schema.Boolean });

export type ChargeResult = typeof ChargeResult.Type;

/**
 * Server → client messages of the spectator WebSocket (`GET /api/games/:id/ws`). `Hello` is
 * sent on connect; clients then load `GET /api/games/:id/events?since=` and apply `Events`
 * whose `seq` is larger than what they have. Event and view payloads are the engine's JSON.
 */
export { SpectatorMessage };

export const encodeSpectatorMessage = Schema.encodeSync(Schema.fromJsonString(SpectatorMessage));
