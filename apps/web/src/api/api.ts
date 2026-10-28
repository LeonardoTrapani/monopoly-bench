/**
 * The web app's view of the monopoly-bench API (SPEC §7.2): one service, two implementations.
 * `http.ts` talks to the Worker (same origin, or `VITE_API_BASE`); `mock/` serves generated data
 * in the browser (`VITE_API_MODE=mock`). Commands and Subscriptions only see `Api`.
 */
import {
  GameStatus,
  PlayersCount,
  SeatActivity,
  type GameSummary,
  type GamesResponse,
  type Leaderboard,
  type ModelProfile,
  type CatalogResponse,
  type CreateRunResponse,
  type ModelsResponse,
  type RunConfig,
  type RunDetail,
  type RunsResponse,
  type RunSummary,
  type WakeTranscript,
} from "@mb/api";
import { GameEvent, type GameConfig } from "@mb/engine";
import { Context, Effect, Option, Schema, type Stream } from "effect";
import { defineTaggedUnion } from "foldkit/schema";

/** A failed API call: HTTP status (0 for network or decoding failures) and a readable message. */
export class ApiError extends Schema.TaggedError<ApiError>()("ApiError", {
  status: Schema.Int,
  message: Schema.String,
}) {}

export const GameListStatus = Schema.Literals(["live", "finished"]);

export type GameListStatus = typeof GameListStatus.Type;

/** Query of `GET /api/games`. */
export const GamesQuery = Schema.Struct({
  status: Schema.Option(GameListStatus),
  players: Schema.Option(PlayersCount),
  model: Schema.Option(Schema.String),
});

export type GamesQuery = typeof GamesQuery.Type;

export const allGames: GamesQuery = {
  status: Option.none(),
  players: Option.none(),
  model: Option.none(),
};

export const liveGames: GamesQuery = {
  status: Option.some("live"),
  players: Option.none(),
  model: Option.none(),
};

/**
 * Spectator WebSocket messages after decoding (`SpectatorMessage` of `@mb/api`, with the engine
 * events decoded by `@mb/engine`). `Opened` is emitted when the socket connects.
 */
export const FeedMessage = Schema.TaggedUnion({
  Opened: {},
  Hello: { status: GameStatus, lastSeq: Schema.Int },
  Events: { events: Schema.Array(GameEvent) },
  Activity: { activity: SeatActivity },
  Status: { status: GameStatus },
});

export type FeedMessage = typeof FeedMessage.Type;

/**
 * Who pays for a new run (`POST /api/runs`): the creator's own OpenRouter key, sent once in the
 * `x-openrouter-key` header and never stored by this app, or the server, authorized by the bench
 * API key (`Authorization: Bearer`).
 */
export const RunPayment = defineTaggedUnion({
  OwnKey: { openRouterKey: Schema.String },
  BenchKey: { apiKey: Schema.String },
});

export type RunPayment = typeof RunPayment.Type;

/**
 * What authorizes `POST /api/runs/:id/cancel`: the run's cancel token (`x-run-token`, returned
 * when an own-key run is created) or the bench API key.
 */
export const CancelAuth = defineTaggedUnion({
  RunToken: { token: Schema.String },
  BenchKey: { apiKey: Schema.String },
});

export type CancelAuth = typeof CancelAuth.Type;

export interface ApiClient {
  readonly leaderboard: (players: PlayersCount) => Effect.Effect<Leaderboard, ApiError>;
  readonly models: Effect.Effect<ModelsResponse, ApiError>;
  readonly model: (competitorId: string) => Effect.Effect<ModelProfile, ApiError>;
  readonly runs: Effect.Effect<RunsResponse, ApiError>;
  readonly run: (runId: string) => Effect.Effect<RunDetail, ApiError>;
  readonly games: (query: GamesQuery) => Effect.Effect<GamesResponse, ApiError>;
  readonly game: (gameId: string) => Effect.Effect<GameSummary, ApiError>;
  readonly gameConfig: (gameId: string) => Effect.Effect<GameConfig, ApiError>;
  /** Engine events with `seq > since` (NDJSON). */
  readonly gameEvents: (
    gameId: string,
    since: number,
  ) => Effect.Effect<ReadonlyArray<GameEvent>, ApiError>;
  /** Wake transcripts of every seat (NDJSON). */
  readonly transcripts: (gameId: string) => Effect.Effect<ReadonlyArray<WakeTranscript>, ApiError>;
  /** OpenRouter models that support tools, with prices and per-seat cost estimates. */
  readonly catalog: Effect.Effect<CatalogResponse, ApiError>;
  readonly createRun: (
    config: RunConfig,
    payment: RunPayment,
  ) => Effect.Effect<CreateRunResponse, ApiError>;
  readonly cancelRun: (runId: string, auth: CancelAuth) => Effect.Effect<RunSummary, ApiError>;
  /** The spectator feed of a game; ends when the socket closes. */
  readonly spectate: (gameId: string) => Stream.Stream<FeedMessage, ApiError>;
}

export class Api extends Context.Service<Api, ApiClient>()("Api") {}

/** Human-readable text of any API failure, for `Failed*` Messages. */
export const describeApiError = (error: ApiError): string =>
  error.status === 0 ? error.message : `${error.message} (HTTP ${error.status})`;

/** Runs `use` against the API service and turns failures into a readable string. */
export const withApi = <A>(
  use: (api: ApiClient) => Effect.Effect<A, ApiError>,
): Effect.Effect<A, string, Api> => Api.use(use).pipe(Effect.mapError(describeApiError));
