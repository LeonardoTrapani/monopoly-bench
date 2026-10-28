/**
 * The HTTP API (SPEC.md §7.2). Public routes are read-only with open CORS. Creating a run needs
 * `Authorization: Bearer <BENCH_API_KEY>` (server-funded) or the creator's own OpenRouter key in
 * `x-openrouter-key` (paid with it); cancelling needs the bearer or the run's `x-run-token`;
 * deleting needs the bearer. Bodies are the `@mb/api` schemas.
 *
 * Effects need D1 (`SqlClient`, `D1Client` for batches); Durable Objects, R2, the catalog and
 * OpenRouter are reached through `ApiDeps`, so the router runs unchanged against fakes in tests.
 */
import {
  BotSeat,
  CatalogResponse,
  competitorId,
  competitorName,
  CreateRunResponse,
  GameSummary,
  GamesResponse,
  Leaderboard,
  ModelProfile,
  ModelsResponse,
  PlayersCount,
  RunConfig,
  RunDetail,
  RunsResponse,
  type RunSummary,
  Seat,
} from "@mb/api";
import type { D1Client } from "@effect/sql-d1";
import { Cause, Effect, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";

import { type CatalogSnapshot, runModelProblem } from "../catalog.ts";
import type { ModelListing, OwnKeyFunding } from "../contracts.ts";
import {
  getGame,
  getRun,
  leaderboard,
  listGames,
  listRuns,
  modelProfile,
  models,
} from "../db/queries.ts";
import { recomputeRatings } from "../db/ratings-store.ts";
import {
  type CompetitorName,
  deleteRunGames,
  deleteRunRow,
  runGameIds,
  runPlayersCount,
  saveCompetitorNames,
} from "../db/writes.ts";
import type { KeyCheck } from "../openrouter-key.ts";
import { isAuthorized, sha256Hex } from "./auth.ts";
import { errorJson, json, jsonText, ndjson, noContent, preflight } from "./http.ts";

export interface RunsGateway {
  /** `ownKey` is null for a server-funded run. */
  readonly create: (
    runId: string,
    config: RunConfig,
    listings: ReadonlyArray<ModelListing>,
    ownKey: OwnKeyFunding | null,
  ) => Promise<RunSummary>;
  readonly cancel: (runId: string) => Promise<RunSummary | null>;
  /** Whether `tokenSha256` is the SHA-256 of the run's cancel token (own-key runs only). */
  readonly cancelTokenMatches: (runId: string, tokenSha256: string) => Promise<boolean>;
  /** Stop the run's games for good and wipe its Durable Objects (run, games, seats). */
  readonly purge: (runId: string) => Promise<void>;
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
  /** Delete every R2 object of these games of the run (`games/<gameId>/…`). */
  readonly deleteArchives: (runId: string, gameIds: ReadonlyArray<string>) => Promise<void>;
}

export interface ApiDeps {
  readonly benchApiKey: string;
  readonly runs: RunsGateway;
  readonly games: GamesGateway;
  /** OpenRouter's tool models and their prices (`GET /api/catalog`, run validation). */
  readonly catalog: () => Promise<CatalogSnapshot>;
  /** Asks OpenRouter about a creator's own key (`GET /api/v1/key`). */
  readonly checkOpenRouterKey: (key: string) => Promise<KeyCheck>;
  readonly newRunId: () => string;
  readonly newCancelToken: () => string;
}

/** Header carrying the creator's own OpenRouter key on `POST /api/runs`. */
export const OWN_KEY_HEADER = "x-openrouter-key";

/** Header carrying an own-key run's cancel token on `POST /api/runs/:id/cancel`. */
export const RUN_TOKEN_HEADER = "x-run-token";

const LIST_LIMIT = 100;

const RECENT_GAMES = 20;

const decodePlayers = Schema.decodeUnknownOption(
  Schema.NumberFromString.pipe(Schema.decodeTo(PlayersCount)),
);

const decodeRunConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(RunConfig));

/** Just enough of a run body to tell that it seats a bot. */
const decodeSeats = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ players: Schema.Array(Schema.Unknown) })),
);

const isBotSeat = Schema.is(BotSeat);

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

const isBenchOwner = (request: Request, deps: ApiDeps) =>
  promise(() => isAuthorized(request.headers.get("authorization"), deps.benchApiKey));

const requireAuth = (request: Request, deps: ApiDeps, message: string) =>
  isBenchOwner(request, deps).pipe(Effect.flatMap((ok) => (ok ? Effect.void : fail(401, message))));

const header = (request: Request, name: string): string | null => {
  const value = request.headers.get(name)?.trim() ?? "";

  return value.length === 0 ? null : value;
};

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

const usd = (value: number): string => `$${value.toFixed(2)}`;

/** Checks an own key with OpenRouter; it must cover the run's budget if it has a limit. */
const checkOwnKey = Effect.fn("checkOwnKey")(function* (
  deps: ApiDeps,
  key: string,
  budgetUsd: number,
) {
  const check = yield* promise(() => deps.checkOpenRouterKey(key));

  if (check.status === "rejected") {
    return yield* fail(
      401,
      `OpenRouter rejected the key in ${OWN_KEY_HEADER} (invalid, disabled or expired).`,
    );
  }

  if (check.status === "unavailable") {
    return yield* fail(
      502,
      `Could not check the key in ${OWN_KEY_HEADER} with OpenRouter (${check.reason}); try again.`,
    );
  }

  if (check.limitRemainingUsd !== null && check.limitRemainingUsd < budgetUsd) {
    return yield* fail(
      400,
      `The key in ${OWN_KEY_HEADER} has ${usd(check.limitRemainingUsd)} of credit left, less than the run budget of ${usd(budgetUsd)}: lower budgetUsd or raise the key's limit on OpenRouter.`,
    );
  }
});

/** Leaderboard names of a run's competitors, from its catalog snapshot (not its seat labels). */
const competitorNames = (
  config: RunConfig,
  snapshot: CatalogSnapshot,
): ReadonlyArray<CompetitorName> =>
  config.players.flatMap((seat) => {
    const entry = snapshot.catalog.models.find((model) => model.model === seat.model);

    return entry === undefined
      ? []
      : [{ competitorId: competitorId(seat), name: competitorName(entry.label, seat) }];
  });

const createRun = Effect.fn("createRun")(function* (request: Request, deps: ApiDeps) {
  const ownKey = header(request, OWN_KEY_HEADER);

  if (ownKey === null) {
    yield* requireAuth(
      request,
      deps,
      `Missing or invalid API key: send Authorization: Bearer <BENCH_API_KEY>, or your own OpenRouter key in ${OWN_KEY_HEADER}.`,
    );
  }

  const body = yield* promise(() => request.text());

  const seatsBot = Option.match(decodeSeats(body), {
    onSome: (seats) => seats.players.some(isBotSeat),
    onNone: () => false,
  });

  if (seatsBot) {
    return yield* fail(400, "Public runs seat LLMs only; bots play in local simulations (mb sim).");
  }

  const config = yield* decodeRunConfig(body).pipe(
    Effect.catchTag("SchemaError", (error) => fail(400, `Invalid RunConfig: ${error.message}`)),
  );

  const snapshot = yield* promise(() => deps.catalog());
  const modelIds = [...new Set(config.players.map((seat) => seat.model))];

  const problems = modelIds.flatMap((model) => {
    const problem = runModelProblem(snapshot, model);

    return problem === null ? [] : [problem];
  });

  if (problems.length > 0) return yield* fail(400, problems.join(" "));

  const listings = modelIds.flatMap((model) => {
    const listing = snapshot.listings.get(model);

    return listing === undefined ? [] : [listing];
  });

  if (ownKey !== null) yield* checkOwnKey(deps, ownKey, config.budgetUsd);

  yield* saveCompetitorNames(competitorNames(config, snapshot));

  if (ownKey === null) {
    const run = yield* promise(() => deps.runs.create(deps.newRunId(), config, listings, null));

    return json(CreateRunResponse, { run, cancelToken: null }, 201);
  }

  const cancelToken = deps.newCancelToken();
  const cancelTokenSha256 = yield* promise(() => sha256Hex(cancelToken));

  const run = yield* promise(() =>
    deps.runs.create(deps.newRunId(), config, listings, {
      openRouterKey: ownKey,
      cancelTokenSha256,
    }),
  );

  return json(CreateRunResponse, { run, cancelToken }, 201);
});

/** The bench bearer cancels any run; an own-key run's creator cancels it with its token. */
const cancelRun = Effect.fn("cancelRun")(function* (
  request: Request,
  deps: ApiDeps,
  runId: string,
) {
  if (!(yield* isBenchOwner(request, deps))) {
    const token = header(request, RUN_TOKEN_HEADER);

    const matches =
      token !== null &&
      (yield* promise(async () => deps.runs.cancelTokenMatches(runId, await sha256Hex(token))));

    if (!matches) {
      return yield* fail(
        401,
        `Missing or invalid API key or run token: send Authorization: Bearer <BENCH_API_KEY> or the run's cancel token in ${RUN_TOKEN_HEADER}.`,
      );
    }
  }

  const run = yield* promise(() => deps.runs.cancel(runId));

  return run === null
    ? errorJson(404, "Run not found")
    : json(CreateRunResponse, { run, cancelToken: null });
});

/**
 * Removes a run: its Durable Objects (games stop for good), R2 archives and D1 rows, then
 * replays the ratings of its player count without its games. The `runs` row goes last, so an
 * interrupted deletion can be retried.
 */
const deleteRun = Effect.fn("deleteRun")(function* (
  request: Request,
  deps: ApiDeps,
  runId: string,
) {
  yield* requireAuth(request, deps, "Missing or invalid API key");

  const playersCount = yield* runPlayersCount(runId);

  if (playersCount === null) return errorJson(404, "Run not found");

  yield* promise(() => deps.runs.purge(runId));

  const gameIds = yield* runGameIds(runId);

  yield* promise(() => deps.games.deleteArchives(runId, gameIds));
  yield* deleteRunGames(runId);
  yield* recomputeRatings(playersCount);
  yield* deleteRunRow(runId);

  return noContent();
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
  SqlClient.SqlClient | D1Client.D1Client
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

  if (resource === "catalog" && parts.length === 1 && method === "GET") {
    return promise(() => deps.catalog()).pipe(
      Effect.map((snapshot) => json(CatalogResponse, snapshot.catalog)),
    );
  }

  if (resource === "models" && method === "GET") {
    if (parts.length === 1) return models().pipe(Effect.map((body) => json(ModelsResponse, body)));

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

    if (parts.length === 2 && id !== undefined && method === "DELETE") {
      return deleteRun(request, deps, id);
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
): Effect.Effect<Response, never, SqlClient.SqlClient | D1Client.D1Client> =>
  route(request, deps).pipe(
    Effect.catchTag("HttpFailure", (failure) =>
      Effect.succeed(errorJson(failure.status, failure.message)),
    ),
    Effect.catchCause((cause) => {
      console.error("API error", Cause.pretty(cause));

      return Effect.succeed(errorJson(500, "Internal error"));
    }),
  );
