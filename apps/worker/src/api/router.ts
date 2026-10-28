/**
 * The HTTP API (SPEC.md §7.2). Public routes are read-only with open CORS; `POST` routes need
 * `Authorization: Bearer <BENCH_API_KEY>`. Bodies are the `@mb/api` schemas.
 *
 * Effects need the D1 `SqlClient`; Durable Objects and R2 are reached through `ApiDeps`, so
 * the router runs unchanged against fakes in tests.
 */
import {
  CreateRunResponse,
  GameSummary,
  GamesResponse,
  Leaderboard,
  type ModelCatalogEntry,
  ModelProfile,
  ModelsResponse,
  PlayersCount,
  RunConfig,
  RunDetail,
  RunsResponse,
  type RunSummary,
  Seat,
} from "@mb/api";
import { Cause, Effect, Match, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";

import type { ModelListing } from "../contracts.ts";
import {
  getGame,
  getRun,
  leaderboard,
  listGames,
  listRuns,
  modelProfile,
  models,
} from "../db/queries.ts";
import { isAuthorized } from "./auth.ts";
import { errorJson, json, jsonText, ndjson, preflight } from "./http.ts";

export interface RunsGateway {
  readonly create: (
    runId: string,
    config: RunConfig,
    listings: ReadonlyArray<ModelListing>,
  ) => Promise<RunSummary>;
  readonly cancel: (runId: string) => Promise<RunSummary | null>;
}

export interface GamesGateway {
  /** NDJSON events with `seq > since`, from the game's Durable Object. */
  readonly liveEvents: (gameId: string, since: number) => Promise<string>;
  /** `games/<id>/events.jsonl` from R2, or null when not archived. */
  readonly archivedEvents: (gameId: string) => Promise<string | null>;
  /** NDJSON `WakeTranscript`s recorded so far by the game's Durable Object. */
  readonly liveTranscripts: (gameId: string, seat: Seat | null) => Promise<string>;
  /** `games/<id>/seats/<seat>.jsonl` from R2, or null when not archived. */
  readonly archivedTranscripts: (gameId: string, seat: Seat) => Promise<string | null>;
  /** The engine `GameConfig` JSON from the game's Durable Object, or null before it starts. */
  readonly liveConfig: (gameId: string) => Promise<string | null>;
  /** `games/<id>/config.json` from R2, or null when not archived. */
  readonly archivedConfig: (gameId: string) => Promise<string | null>;
  /** Forward a WebSocket upgrade to the game's Durable Object. */
  readonly spectate: (gameId: string, request: Request) => Promise<Response>;
}

export interface ApiDeps {
  readonly benchApiKey: string;
  readonly catalog: ReadonlyArray<ModelCatalogEntry>;
  readonly runs: RunsGateway;
  readonly games: GamesGateway;
  /** Public OpenRouter prices of these model ids (no key needed); [] when unavailable. */
  readonly listings: (modelIds: ReadonlyArray<string>) => Promise<ReadonlyArray<ModelListing>>;
  readonly newRunId: () => string;
}

const LIST_LIMIT = 100;

const RECENT_GAMES = 20;

const decodePlayers = Schema.decodeUnknownOption(
  Schema.NumberFromString.pipe(Schema.decodeTo(PlayersCount)),
);

const decodeRunConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(RunConfig));

const decodeSince = Schema.decodeUnknownOption(
  Schema.NumberFromString.pipe(Schema.decodeTo(Schema.Int)),
);

const promise = <A>(evaluate: () => Promise<A>) =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) => new Error("Upstream call failed", { cause }),
  });

class HttpFailure extends Schema.TaggedError<HttpFailure>()("HttpFailure", {
  status: Schema.Int,
  message: Schema.String,
}) {}

const fail = (status: number, message: string) => Effect.fail(new HttpFailure({ status, message }));

const requireAuth = (request: Request, deps: ApiDeps) =>
  promise(() => isAuthorized(request.headers.get("authorization"), deps.benchApiKey)).pipe(
    Effect.flatMap((ok) => (ok ? Effect.void : fail(401, "Missing or invalid API key"))),
  );

const playersParam = (
  url: URL,
  fallback: PlayersCount | null,
): Effect.Effect<PlayersCount | null, HttpFailure> => {
  const raw = url.searchParams.get("players");

  if (raw === null || raw === "") return Effect.succeed(fallback);

  const players = decodePlayers(raw);

  return Option.match(players, {
    onSome: (value) => Effect.succeed<PlayersCount | null>(value),
    onNone: () => fail(400, "players must be an integer from 2 to 6"),
  });
};

const createRun = Effect.fn("createRun")(function* (request: Request, deps: ApiDeps) {
  yield* requireAuth(request, deps);

  const body = yield* promise(() => request.text());

  const config = yield* decodeRunConfig(body).pipe(
    Effect.catchTag("SchemaError", (error) => fail(400, `Invalid RunConfig: ${error.message}`)),
  );

  const modelIds = config.players.flatMap((seat) =>
    Match.valueTags(seat, { llm: (llm) => [llm.model], bot: () => [] }),
  );

  const listings = yield* promise(() => deps.listings([...new Set(modelIds)]));
  const run = yield* promise(() => deps.runs.create(deps.newRunId(), config, listings));

  return json(CreateRunResponse, { run }, 201);
});

const cancelRun = Effect.fn("cancelRun")(function* (
  request: Request,
  deps: ApiDeps,
  runId: string,
) {
  yield* requireAuth(request, deps);

  const run = yield* promise(() => deps.runs.cancel(runId));

  return run === null ? errorJson(404, "Run not found") : json(CreateRunResponse, { run });
});

const gameEvents = Effect.fn("gameEvents")(function* (deps: ApiDeps, gameId: string, url: URL) {
  const game = yield* getGame(gameId);

  if (game === null) return errorJson(404, "Game not found");

  const sinceParam = url.searchParams.get("since");
  const since = sinceParam === null || sinceParam === "" ? Option.some(0) : decodeSince(sinceParam);

  if (Option.isNone(since)) return errorJson(400, "since must be an integer");

  const after = since.value;

  if (game.status === "running" || game.status === "queued") {
    return ndjson(yield* promise(() => deps.games.liveEvents(gameId, after)));
  }

  const archived = yield* promise(() => deps.games.archivedEvents(gameId));

  if (archived === null) return ndjson(yield* promise(() => deps.games.liveEvents(gameId, after)));

  return ndjson(
    archived
      .split("\n")
      .filter((line) => line.length > 0)
      .filter((line) => eventSeq(line) > after)
      .map((line) => `${line}\n`)
      .join(""),
  );
});

const decodeSeat = Schema.decodeUnknownOption(Seat);

/** Wake transcripts (reasoning, tool calls, usage), live from GameDO or archived in R2. */
const gameTranscripts = Effect.fn("gameTranscripts")(function* (
  deps: ApiDeps,
  gameId: string,
  url: URL,
) {
  const game = yield* getGame(gameId);

  if (game === null) return errorJson(404, "Game not found");

  const seatParam = url.searchParams.get("seat");
  const seat = seatParam === null || seatParam === "" ? Option.some(null) : decodeSeat(seatParam);

  if (Option.isNone(seat)) return errorJson(400, "seat must be a seat letter A-F");

  if (game.status === "running" || game.status === "queued") {
    return ndjson(yield* promise(() => deps.games.liveTranscripts(gameId, seat.value)));
  }

  const seats = seat.value === null ? game.seats.map((entry) => entry.seat) : [seat.value];

  const files = yield* promise(() =>
    Promise.all(seats.map((letter) => deps.games.archivedTranscripts(gameId, letter))),
  );

  if (files.some((file) => file === null)) {
    return ndjson(yield* promise(() => deps.games.liveTranscripts(gameId, seat.value)));
  }

  return ndjson(files.join(""));
});

/** The engine `GameConfig` (for `replay(config, events)`): live from GameDO, finished from R2. */
const gameConfig = Effect.fn("gameConfig")(function* (deps: ApiDeps, gameId: string) {
  const game = yield* getGame(gameId);

  if (game === null) return errorJson(404, "Game not found");

  const finished = game.status !== "running" && game.status !== "queued";
  const archived = finished ? yield* promise(() => deps.games.archivedConfig(gameId)) : null;
  const config = archived ?? (yield* promise(() => deps.games.liveConfig(gameId)));

  return config === null ? errorJson(404, "Game has not started") : jsonText(config);
});

const SeqOnly = Schema.fromJsonString(Schema.Struct({ seq: Schema.Number }));

const decodeSeq = Schema.decodeUnknownOption(SeqOnly);

const eventSeq = (line: string): number => {
  return Option.match(decodeSeq(line), { onSome: (event) => event.seq, onNone: () => 0 });
};

const route = (
  request: Request,
  deps: ApiDeps,
): Effect.Effect<
  Response,
  HttpFailure | Error | Schema.SchemaError | SqlError,
  SqlClient.SqlClient
> => {
  const url = new URL(request.url);

  const parts = url.pathname
    .split("/")
    .filter((part) => part.length > 0)
    .slice(1);

  const [resource, id, action] = parts;
  const method = request.method;

  if (method === "OPTIONS") return Effect.succeed(preflight());

  if (resource === "leaderboard" && parts.length === 1 && method === "GET") {
    return playersParam(url, 4).pipe(
      Effect.flatMap((players) => leaderboard(players ?? 4)),
      Effect.map((board) => json(Leaderboard, board)),
    );
  }

  if (resource === "models" && method === "GET") {
    if (parts.length === 1)
      return models(deps.catalog).pipe(Effect.map((body) => json(ModelsResponse, body)));

    // Competitor ids contain "/" and ":", so the id is the rest of the path (encoded or not).
    const competitor = decodeURIComponent(url.pathname.replace(/^\/api\/models\//, ""));

    return modelProfile(competitor, RECENT_GAMES).pipe(
      Effect.map((profile) =>
        profile === null ? errorJson(404, "Model not found") : json(ModelProfile, profile),
      ),
    );
  }

  if (resource === "runs") {
    if (parts.length === 1 && method === "GET") {
      return listRuns(LIST_LIMIT).pipe(Effect.map((runs) => json(RunsResponse, { runs })));
    }

    if (parts.length === 1 && method === "POST") return createRun(request, deps);

    if (parts.length === 2 && id !== undefined && method === "GET") {
      return getRun(id).pipe(
        Effect.map((detail) =>
          detail === null ? errorJson(404, "Run not found") : json(RunDetail, detail),
        ),
      );
    }

    if (parts.length === 3 && id !== undefined && action === "cancel" && method === "POST") {
      return cancelRun(request, deps, id);
    }
  }

  if (resource === "games" && method === "GET") {
    if (parts.length === 1) {
      const status = url.searchParams.get("status");

      if (status !== null && status !== "" && status !== "live" && status !== "finished") {
        return fail(400, "status must be live or finished");
      }

      const model = url.searchParams.get("model");

      return playersParam(url, null).pipe(
        Effect.flatMap((players) =>
          listGames({
            status: status === "live" || status === "finished" ? status : null,
            players,
            model: model === null || model === "" ? null : model,
            limit: LIST_LIMIT,
          }),
        ),
        Effect.map((games) => json(GamesResponse, { games })),
      );
    }

    if (parts.length === 2 && id !== undefined) {
      return getGame(id).pipe(
        Effect.map((game) =>
          game === null ? errorJson(404, "Game not found") : json(GameSummary, game),
        ),
      );
    }

    if (parts.length === 3 && id !== undefined && action === "events")
      return gameEvents(deps, id, url);

    if (parts.length === 3 && id !== undefined && action === "transcripts") {
      return gameTranscripts(deps, id, url);
    }

    if (parts.length === 3 && id !== undefined && action === "config") return gameConfig(deps, id);

    if (parts.length === 3 && id !== undefined && action === "ws") {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return fail(426, "Expected a WebSocket upgrade");
      }

      return promise(() => deps.games.spectate(id, request));
    }
  }

  return fail(404, "Not found");
};

/** Handle a request under `/api/`. Never fails: errors become `ErrorResponse` bodies. */
export const handleApi = (
  request: Request,
  deps: ApiDeps,
): Effect.Effect<Response, never, SqlClient.SqlClient> =>
  route(request, deps).pipe(
    Effect.catchTag("HttpFailure", (failure) =>
      Effect.succeed(errorJson(failure.status, failure.message)),
    ),
    Effect.catchCause((cause) => {
      console.error("API error", Cause.pretty(cause));

      return Effect.succeed(errorJson(500, "Internal error"));
    }),
  );
