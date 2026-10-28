/**
 * The real API client: `fetch` through Effect's `HttpClient`, every body decoded with the
 * `@mb/api` and `@mb/engine` schemas, the spectator feed over a WebSocket.
 */
import {
  CatalogResponse,
  CreateRunResponse,
  ErrorResponse,
  GameSummary,
  GamesResponse,
  Leaderboard,
  ModelProfile,
  ModelsResponse,
  RunConfig,
  RunDetail,
  RunsResponse,
  RunSummary,
  SpectatorMessage,
  WakeTranscript,
} from "@mb/api";
import { GameConfig, GameEvent } from "@mb/engine";
import { Effect, Layer, Option, Queue, Schema, Stream } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { Http } from "foldkit";

import {
  Api,
  ApiError,
  CancelAuth,
  FeedMessage,
  RunPayment,
  type ApiClient,
  type GamesQuery,
} from "./api.ts";

const HTTP_OK_MIN = 200;

const HTTP_OK_MAX = 299;

const decodeErrorBody = Schema.decodeUnknownOption(Schema.fromJsonString(ErrorResponse));

const decodeSpectatorMessage = Schema.decodeUnknownOption(Schema.fromJsonString(SpectatorMessage));

const decodeEvents = Schema.decodeUnknownOption(Schema.Array(GameEvent));

const networkError = (cause: { readonly message: string }) =>
  new ApiError({ status: 0, message: `Network error: ${cause.message}` });

const decodingError = (what: string) =>
  new ApiError({ status: 0, message: `Unexpected ${what} from the server` });

/** Splits an NDJSON body into a JSON array text, so it decodes in one pass. */
const ndjsonAsArray = (body: string): string =>
  `[${body
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .join(",")}]`;

/** Joins the API base (empty: same origin) and a path. */
const apiUrl = (base: string, path: string): string => `${base.replace(/\/$/, "")}${path}`;

/** `ws(s)://…/api/games/:id/ws`, from the API base or the page origin. */
const socketUrl = (base: string, gameId: string): string => {
  const origin = base === "" ? globalThis.location.origin : base;
  const url = new URL(`/api/games/${encodeURIComponent(gameId)}/ws`, origin);

  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

  return url.toString();
};

const sendText = (request: HttpClientRequest.HttpClientRequest) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(request).pipe(Effect.mapError(networkError));
    const text = yield* response.text.pipe(Effect.mapError(networkError));

    if (response.status < HTTP_OK_MIN || response.status > HTTP_OK_MAX) {
      const message = Option.match(decodeErrorBody(text), {
        onSome: (body) => body.error,
        onNone: () => `Request failed`,
      });

      return yield* Effect.fail(new ApiError({ status: response.status, message }));
    }

    return text;
  }).pipe(Effect.provide(Http.layer));

const decodeJson =
  <S extends Schema.ConstraintDecoder<unknown>>(schema: S, what: string) =>
  (text: string): Effect.Effect<S["Type"], ApiError> =>
    Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(text).pipe(
      Effect.mapError(() => decodingError(what)),
    );

const decodeNdjson =
  <S extends Schema.ConstraintDecoder<unknown>>(schema: S, what: string) =>
  (text: string): Effect.Effect<ReadonlyArray<S["Type"]>, ApiError> =>
    Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(schema)))(
      ndjsonAsArray(text),
    ).pipe(Effect.mapError(() => decodingError(what)));

const gamesPath = (query: GamesQuery): string => {
  const params = new URLSearchParams();

  if (Option.isSome(query.status)) params.set("status", query.status.value);

  if (Option.isSome(query.players)) params.set("players", String(query.players.value));

  if (Option.isSome(query.model)) params.set("model", query.model.value);

  const search = params.toString();

  return search === "" ? "/api/games" : `/api/games?${search}`;
};

const encodeRunConfig = Schema.encodeSync(Schema.fromJsonString(RunConfig));

/** Converts one raw socket frame into a feed message (unknown or malformed frames are skipped). */
const feedMessageOf = (data: string): Option.Option<FeedMessage> =>
  Option.flatMap(decodeSpectatorMessage(data), (message) =>
    SpectatorMessage.match<Option.Option<FeedMessage>>(message, {
      Hello: (hello) =>
        Option.some(FeedMessage.cases.Hello.make({ status: hello.status, lastSeq: hello.lastSeq })),
      Events: (batch) =>
        Option.map(decodeEvents(batch.events), (events) =>
          FeedMessage.cases.Events.make({ events }),
        ),
      Activity: (activity) =>
        Option.some(FeedMessage.cases.Activity.make({ activity: activity.activity })),
      Status: (status) => Option.some(FeedMessage.cases.Status.make({ status: status.status })),
    }),
  );

const spectate = (base: string, gameId: string): Stream.Stream<FeedMessage, ApiError> =>
  Stream.callback<FeedMessage, ApiError>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const socket = new WebSocket(socketUrl(base, gameId));

        socket.addEventListener("open", () => {
          Queue.offerUnsafe(queue, FeedMessage.cases.Opened.make({}));
        });

        socket.addEventListener("message", (event: MessageEvent<string>) => {
          const message = feedMessageOf(String(event.data));

          if (Option.isSome(message)) Queue.offerUnsafe(queue, message.value);
        });

        socket.addEventListener("close", () => {
          Queue.endUnsafe(queue);
        });

        return socket;
      }),
      (socket) =>
        Effect.sync(() => {
          socket.close();
        }),
    ).pipe(Effect.andThen(Effect.never)),
  );

/**
 * Path of a competitor profile. The id is raw (the route decodes `/models/bot%3Arandom`), so it is
 * encoded exactly once here: `/` and `:` become `%2F` and `%3A`, which the Worker decodes.
 */
export const modelPath = (competitorId: string): string =>
  `/api/models/${encodeURIComponent(competitorId)}`;

/** Adds who pays for a new run: the creator's OpenRouter key, or the bench API key. */
const withPayment = (payment: RunPayment) =>
  RunPayment.match(payment, {
    OwnKey: ({ openRouterKey }) => HttpClientRequest.setHeader("x-openrouter-key", openRouterKey),
    BenchKey: ({ apiKey }) => HttpClientRequest.bearerToken(apiKey),
  });

/** Adds what authorizes a cancel: the run's cancel token, or the bench API key. */
const withCancelAuth = (auth: CancelAuth) =>
  CancelAuth.match(auth, {
    RunToken: ({ token }) => HttpClientRequest.setHeader("x-run-token", token),
    BenchKey: ({ apiKey }) => HttpClientRequest.bearerToken(apiKey),
  });

/** `POST /api/runs/:id/cancel` answers `{ run }` (extra fields are ignored). */
const CancelRunResponse = Schema.Struct({ run: RunSummary });

/** The HTTP implementation of `ApiClient` against `base` (empty string: same origin). */
const httpClient = (base: string): ApiClient => {
  const get = (path: string) => sendText(HttpClientRequest.get(apiUrl(base, path)));

  return {
    leaderboard: (players) =>
      get(`/api/leaderboard?players=${players}`).pipe(
        Effect.flatMap(decodeJson(Leaderboard, "leaderboard")),
      ),
    models: get("/api/models").pipe(Effect.flatMap(decodeJson(ModelsResponse, "model list"))),
    model: (competitorId) =>
      get(modelPath(competitorId)).pipe(Effect.flatMap(decodeJson(ModelProfile, "model profile"))),
    catalog: get("/api/catalog").pipe(Effect.flatMap(decodeJson(CatalogResponse, "model catalog"))),
    runs: get("/api/runs").pipe(Effect.flatMap(decodeJson(RunsResponse, "run list"))),
    run: (runId) =>
      get(`/api/runs/${encodeURIComponent(runId)}`).pipe(
        Effect.flatMap(decodeJson(RunDetail, "run")),
      ),
    games: (query) =>
      get(gamesPath(query)).pipe(Effect.flatMap(decodeJson(GamesResponse, "game list"))),
    game: (gameId) =>
      get(`/api/games/${encodeURIComponent(gameId)}`).pipe(
        Effect.flatMap(decodeJson(GameSummary, "game")),
      ),
    gameConfig: (gameId) =>
      get(`/api/games/${encodeURIComponent(gameId)}/config`).pipe(
        Effect.flatMap(decodeJson(GameConfig, "game config")),
      ),
    gameEvents: (gameId, since) =>
      get(`/api/games/${encodeURIComponent(gameId)}/events?since=${since}`).pipe(
        Effect.flatMap(decodeNdjson(GameEvent, "event log")),
      ),
    transcripts: (gameId) =>
      get(`/api/games/${encodeURIComponent(gameId)}/transcripts`).pipe(
        Effect.flatMap(decodeNdjson(WakeTranscript, "transcripts")),
      ),
    createRun: (config, payment) =>
      sendText(
        HttpClientRequest.post(apiUrl(base, "/api/runs")).pipe(
          HttpClientRequest.bodyText(encodeRunConfig(config), "application/json"),
          withPayment(payment),
        ),
      ).pipe(Effect.flatMap(decodeJson(CreateRunResponse, "run"))),
    cancelRun: (runId, auth) =>
      sendText(
        HttpClientRequest.post(apiUrl(base, `/api/runs/${encodeURIComponent(runId)}/cancel`)).pipe(
          withCancelAuth(auth),
        ),
      ).pipe(
        Effect.flatMap(decodeJson(CancelRunResponse, "run")),
        Effect.map((response) => response.run),
      ),
    spectate: (gameId) => spectate(base, gameId),
  };
};

/** `Api` over HTTP against `base` (empty string: same origin). */
export const HttpApiLive = (base: string): Layer.Layer<Api> => Layer.succeed(Api, httpClient(base));
