/**
 * HTTP contract between the Worker API (`apps/worker`) and its clients (`apps/web`,
 * `apps/cli`). Game-level payloads (events, views) come from `@mb/engine`; this module
 * only covers runs, games, models and the leaderboard. See SPEC.md §7.2 and §8.
 */
import { Match, Schema } from "effect";

export const PlayersCount = Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: 6 }));

export type PlayersCount = typeof PlayersCount.Type;

export const Reasoning = Schema.Literals(["off", "low", "medium", "high"]);

export type Reasoning = typeof Reasoning.Type;

export const BotPolicy = Schema.Literals(["random", "heuristic"]);

export type BotPolicy = typeof BotPolicy.Type;

export const LlmSeat = Schema.TaggedStruct("llm", {
  /** OpenRouter model id, e.g. "anthropic/claude-sonnet-5.5". */
  model: Schema.NonEmptyString,
  label: Schema.NonEmptyString,
  reasoning: Schema.optionalKey(Reasoning),
  maxOutputTokens: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
});

export type LlmSeat = typeof LlmSeat.Type;

export const BotSeat = Schema.TaggedStruct("bot", {
  policy: BotPolicy,
  label: Schema.optionalKey(Schema.NonEmptyString),
});

export type BotSeat = typeof BotSeat.Type;

export const SeatSpec = Schema.Union([LlmSeat, BotSeat]);

export type SeatSpec = typeof SeatSpec.Type;

export const TableFrequency = Schema.Literals(["everyRoll", "everyTurn", "everyRound", "off"]);

export type TableFrequency = typeof TableFrequency.Type;

export const RunConfig = Schema.Struct({
  name: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(120))),
  players: Schema.Array(SeatSpec).check(Schema.isMinLength(2), Schema.isMaxLength(6)),
  /** Number of seeds; games = seeds × players (cyclic seat rotation). */
  seeds: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 })),
  maxRounds: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 }))),
  tableFrequency: Schema.optionalKey(TableFrequency),
  concurrency: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 16 }))),
  budgetUsd: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 10_000 })),
});

export type RunConfig = typeof RunConfig.Type;

/**
 * Stable identity of a competitor on the leaderboard: `bot:<policy>` for bots,
 * `<openrouter id>` or `<openrouter id>:<reasoning>` for LLM seats with reasoning on.
 */
export const competitorId = (seat: SeatSpec): string =>
  Match.valueTags(seat, {
    bot: (bot) => `bot:${bot.policy}`,
    llm: (llm) =>
      llm.reasoning === undefined || llm.reasoning === "off"
        ? llm.model
        : `${llm.model}:${llm.reasoning}`,
  });

export const competitorLabel = (seat: SeatSpec): string =>
  Match.valueTags(seat, {
    bot: (bot) => bot.label ?? `Bot (${bot.policy})`,
    llm: (llm) => llm.label,
  });

export const RunStatus = Schema.Literals(["queued", "running", "finished", "cancelled", "failed"]);

export type RunStatus = typeof RunStatus.Type;

export const RunSummary = Schema.Struct({
  id: Schema.String,
  name: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  status: RunStatus,
  playersCount: PlayersCount,
  seats: Schema.Array(SeatSpec),
  gamesTotal: Schema.Int,
  gamesFinished: Schema.Int,
  gamesRunning: Schema.Int,
  spentUsd: Schema.Number,
  budgetUsd: Schema.Number,
});

export type RunSummary = typeof RunSummary.Type;

export const GameStatus = Schema.Literals(["queued", "running", "finished", "aborted", "failed"]);

export type GameStatus = typeof GameStatus.Type;

export const Seat = Schema.Literals(["A", "B", "C", "D", "E", "F"]);

export type Seat = typeof Seat.Type;

export const GameSeatSummary = Schema.Struct({
  seat: Seat,
  competitorId: Schema.String,
  label: Schema.String,
  kind: Schema.Literals(["llm", "bot"]),
  finalRank: Schema.NullOr(Schema.Int),
  netWorth: Schema.NullOr(Schema.Number),
  cash: Schema.NullOr(Schema.Number),
  bankruptAtTurn: Schema.NullOr(Schema.Int),
  costUsd: Schema.Number,
  wakes: Schema.Int,
  invalidActions: Schema.Int,
  timeouts: Schema.Int,
});

export type GameSeatSummary = typeof GameSeatSummary.Type;

export const GameSummary = Schema.Struct({
  id: Schema.String,
  runId: Schema.String,
  seed: Schema.String,
  status: GameStatus,
  playersCount: PlayersCount,
  startedAt: Schema.NullOr(Schema.String),
  finishedAt: Schema.NullOr(Schema.String),
  turn: Schema.Int,
  round: Schema.Int,
  endReason: Schema.NullOr(Schema.Literals(["lastPlayerStanding", "turnCap", "aborted"])),
  winnerSeat: Schema.NullOr(Seat),
  seats: Schema.Array(GameSeatSummary),
});

export type GameSummary = typeof GameSummary.Type;

export const LeaderboardEntry = Schema.Struct({
  competitorId: Schema.String,
  label: Schema.String,
  kind: Schema.Literals(["llm", "bot"]),
  mu: Schema.Number,
  sigma: Schema.Number,
  /** mu − 3σ */
  score: Schema.Number,
  games: Schema.Int,
  wins: Schema.Int,
  avgPlace: Schema.Number,
  avgNetWorth: Schema.Number,
  invalidRate: Schema.Number,
  timeoutRate: Schema.Number,
  costPerGameUsd: Schema.Number,
  avgWakeMs: Schema.Number,
});

export type LeaderboardEntry = typeof LeaderboardEntry.Type;

export const HeadToHeadCell = Schema.Struct({
  a: Schema.String,
  b: Schema.String,
  /** Games where both competitors played. */
  games: Schema.Int,
  /** Games where `a` finished above `b`. */
  aAhead: Schema.Int,
});

export type HeadToHeadCell = typeof HeadToHeadCell.Type;

export const Leaderboard = Schema.Struct({
  playersCount: PlayersCount,
  updatedAt: Schema.NullOr(Schema.String),
  entries: Schema.Array(LeaderboardEntry),
  headToHead: Schema.Array(HeadToHeadCell),
});

export type Leaderboard = typeof Leaderboard.Type;

export const BehaviorStats = Schema.Struct({
  offersMade: Schema.Int,
  offersAccepted: Schema.Int,
  offersReceived: Schema.Int,
  offersAcceptedFromOthers: Schema.Int,
  auctionsWon: Schema.Int,
  /** Average auction price / list price for auctions won (1 = list price). */
  auctionPremium: Schema.NullOr(Schema.Number),
  propertiesBought: Schema.Int,
  housesBuilt: Schema.Int,
  hotelsBuilt: Schema.Int,
  mortgages: Schema.Int,
  bankruptcies: Schema.Int,
  jailTurns: Schema.Int,
});

export type BehaviorStats = typeof BehaviorStats.Type;

export const ModelProfile = Schema.Struct({
  competitorId: Schema.String,
  label: Schema.String,
  kind: Schema.Literals(["llm", "bot"]),
  ratings: Schema.Array(
    Schema.Struct({
      playersCount: PlayersCount,
      mu: Schema.Number,
      sigma: Schema.Number,
      score: Schema.Number,
      games: Schema.Int,
      wins: Schema.Int,
    }),
  ),
  ratingHistory: Schema.Array(
    Schema.Struct({ playersCount: PlayersCount, at: Schema.String, score: Schema.Number }),
  ),
  behavior: BehaviorStats,
  costPerGameUsd: Schema.Number,
  avgWakeMs: Schema.Number,
  recentGames: Schema.Array(GameSummary),
});

export type ModelProfile = typeof ModelProfile.Type;

export const ModelCatalogEntry = Schema.Struct({
  model: Schema.String,
  label: Schema.String,
  provider: Schema.String,
});

export type ModelCatalogEntry = typeof ModelCatalogEntry.Type;

export const ModelsResponse = Schema.Struct({
  /** Competitors that have played at least one game. */
  competitors: Schema.Array(
    Schema.Struct({
      competitorId: Schema.String,
      label: Schema.String,
      kind: Schema.Literals(["llm", "bot"]),
      games: Schema.Int,
    }),
  ),
  /** Suggested OpenRouter models for the run form. */
  catalog: Schema.Array(ModelCatalogEntry),
});

export type ModelsResponse = typeof ModelsResponse.Type;

export const RunsResponse = Schema.Struct({ runs: Schema.Array(RunSummary) });

export type RunsResponse = typeof RunsResponse.Type;

export const RunDetail = Schema.Struct({ run: RunSummary, games: Schema.Array(GameSummary) });

export type RunDetail = typeof RunDetail.Type;

export const GamesResponse = Schema.Struct({ games: Schema.Array(GameSummary) });

export type GamesResponse = typeof GamesResponse.Type;

export const CreateRunResponse = Schema.Struct({ run: RunSummary });

export type CreateRunResponse = typeof CreateRunResponse.Type;

export const ErrorResponse = Schema.Struct({ error: Schema.String });

export type ErrorResponse = typeof ErrorResponse.Type;

/**
 * Per-wake transcript of an LLM seat, stored in R2 at
 * `games/<gameId>/seats/<seat>.jsonl` (one record per line) and streamed live to
 * spectators as `activity` messages.
 */
export const ToolCallRecord = Schema.Struct({
  name: Schema.String,
  /** JSON-encoded arguments as sent by the model. */
  argsJson: Schema.String,
  ok: Schema.Boolean,
  /** Engine or harness message returned to the model. */
  result: Schema.String,
});

export type ToolCallRecord = typeof ToolCallRecord.Type;

export const WakeUsage = Schema.Struct({
  inputTokens: Schema.Int,
  outputTokens: Schema.Int,
  reasoningTokens: Schema.Int,
  costUsd: Schema.Number,
});

export type WakeUsage = typeof WakeUsage.Type;

export const WakeTranscript = Schema.Struct({
  gameId: Schema.String,
  seat: Seat,
  decisionId: Schema.String,
  turn: Schema.Int,
  frame: Schema.String,
  round: Schema.Int,
  reasons: Schema.Array(Schema.String),
  startedAt: Schema.String,
  finishedAt: Schema.NullOr(Schema.String),
  prompt: Schema.String,
  reasoning: Schema.String,
  text: Schema.String,
  toolCalls: Schema.Array(ToolCallRecord),
  usage: WakeUsage,
  invalidActions: Schema.Int,
  timedOut: Schema.Boolean,
});

export type WakeTranscript = typeof WakeTranscript.Type;

/** Live per-seat activity pushed to spectators next to engine events. */
export const SeatActivity = Schema.TaggedUnion({
  WakeStarted: {
    seat: Seat,
    decisionId: Schema.String,
    frame: Schema.String,
    round: Schema.Int,
    turn: Schema.Int,
    /** Why the seat was woken (engine `WakeReason` literals, SPEC §5.3). */
    reasons: Schema.Array(Schema.String),
  },
  ReasoningDelta: { seat: Seat, decisionId: Schema.String, text: Schema.String },
  ToolCalled: { seat: Seat, decisionId: Schema.String, call: ToolCallRecord },
  WakeFinished: {
    seat: Seat,
    decisionId: Schema.String,
    usage: WakeUsage,
    timedOut: Schema.Boolean,
  },
});

export type SeatActivity = typeof SeatActivity.Type;

/** Suggested models for the run form. Edit freely; ids are OpenRouter ids. */
export const defaultModelCatalog: ReadonlyArray<ModelCatalogEntry> = [
  // Checked against GET https://openrouter.ai/api/v1/models on 2026-10-28 (all support tools).
  { model: "anthropic/claude-opus-5.5", label: "Claude Opus 5.5", provider: "Anthropic" },
  { model: "anthropic/claude-sonnet-5.5", label: "Claude Sonnet 5.5", provider: "Anthropic" },
  { model: "anthropic/claude-haiku-5.5", label: "Claude Haiku 5.5", provider: "Anthropic" },
  { model: "openai/gpt-6-astra", label: "GPT-6 Astra", provider: "OpenAI" },
  { model: "openai/gpt-6.1-sol", label: "GPT-6.1 Sol", provider: "OpenAI" },
  { model: "google/gemini-4-argon", label: "Gemini 4 Argon", provider: "Google" },
  { model: "x-ai/grok-4.7", label: "Grok 4.7", provider: "xAI" },
  { model: "deepseek/deepseek-v4-pro-0813", label: "DeepSeek V4 Pro", provider: "DeepSeek" },
  { model: "qwen/qwen3.8-max-0902", label: "Qwen3.8 Max", provider: "Qwen" },
  { model: "moonshotai/kimi-k3.1-pro", label: "Kimi K3.1 Pro", provider: "Moonshot AI" },
  { model: "z-ai/glm-5.3", label: "GLM 5.3", provider: "Z.ai" },
  { model: "mistralai/mistral-large-4-0", label: "Mistral Large 4", provider: "Mistral" },
  { model: "minimax/minimax-m3", label: "MiniMax M3", provider: "MiniMax" },
];

/**
 * Messages on the spectator WebSocket (`GET /api/games/:id/ws`), server → client only.
 * `Hello` is sent on connect; `Events` carries engine `GameEvent`s (JSON, decode them with
 * `@mb/engine`); `Activity` carries live seat activity; `Status` reports game status changes.
 * The REST endpoints `/api/games/:id/events` and `/api/games/:id/transcripts` return NDJSON
 * (one engine event / one `WakeTranscript` per line).
 */
export const SpectatorMessage = Schema.TaggedUnion({
  Hello: {
    gameId: Schema.String,
    status: GameStatus,
    lastSeq: Schema.Int,
    view: Schema.NullOr(Schema.Json),
  },
  Events: { events: Schema.Array(Schema.Json) },
  Activity: { activity: SeatActivity },
  Status: { status: GameStatus },
});

export type SpectatorMessage = typeof SpectatorMessage.Type;
