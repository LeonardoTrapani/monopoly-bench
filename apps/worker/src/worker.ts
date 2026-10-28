/**
 * Worker entry: the HTTP API under `/api/` and the Durable Object classes. Everything else is
 * served by the static assets of `apps/web/dist` (single-page-application fallback, so client
 * routes like `/games/123` get `index.html`).
 */
import { D1Client } from "@effect/sql-d1";
import { Effect } from "effect";

import type { WorkerEnv } from "../alchemy.run.ts";
import { type ApiDeps, handleApi } from "./api/router.ts";
import { newCancelToken } from "./api/auth.ts";
import { errorJson } from "./api/http.ts";
import { deleteRunArchives } from "./archive.ts";
import { ModelCatalog } from "./catalog.ts";
import { logError } from "./do/runtime.ts";
import { archiveKeys } from "./game/game-host.ts";
import { checkOpenRouterKey } from "./openrouter-key.ts";
import { newRunId } from "./runs/expand.ts";

export { GameDO } from "./do/game-do.ts";

export { PlayerDO } from "./do/player-do.ts";

export { RunDO } from "./do/run-do.ts";

/**
 * Per isolate: the catalog is fetched from OpenRouter at most about once an hour. (`fetch` is
 * wrapped: called as a method of another object, workerd rejects it as an illegal invocation.)
 */
const modelCatalog = new ModelCatalog((input, init) => fetch(input, init), Date.now, logError);

const apiDeps = (env: WorkerEnv): ApiDeps => ({
  benchApiKey: env.BENCH_API_KEY,
  runs: {
    create: (runId, config, listings, ownKey) =>
      env.RUNS.getByName(runId).create(runId, config, listings, ownKey),
    cancel: (runId) => env.RUNS.getByName(runId).cancel(),
    cancelTokenMatches: (runId, tokenSha256) =>
      env.RUNS.getByName(runId).cancelTokenMatches(tokenSha256),
    purge: (runId) => env.RUNS.getByName(runId).purge(),
  },
  games: {
    liveEvents: (gameId, since) => env.GAMES.getByName(gameId).events(since),
    archivedEvents: async (gameId) => {
      const object = await env.ARCHIVE.get(archiveKeys.events(gameId));

      return object === null ? null : object.text();
    },
    liveTranscripts: (gameId, seat) => env.GAMES.getByName(gameId).transcripts(seat),
    archivedTranscripts: async (gameId, seat) => {
      const object = await env.ARCHIVE.get(archiveKeys.seat(gameId, seat));

      return object === null ? null : object.text();
    },
    liveConfig: (gameId) => env.GAMES.getByName(gameId).config(),
    archivedConfig: async (gameId) => {
      const object = await env.ARCHIVE.get(archiveKeys.config(gameId));

      return object === null ? null : object.text();
    },
    spectate: (gameId, request) => env.GAMES.getByName(gameId).fetch(request),
    deleteArchives: async (runId, gameIds) => {
      await deleteRunArchives(env.ARCHIVE, runId, gameIds);
    },
  },
  catalog: () => modelCatalog.snapshot(),
  checkOpenRouterKey: (key) => checkOpenRouterKey(key, fetch),
  newRunId: () => newRunId(new Date(), Math.random),
  newCancelToken,
});

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === "/api" || pathname.startsWith("/api/")) {
      return Effect.runPromise(
        handleApi(request, apiDeps(env)).pipe(Effect.provide(D1Client.layer({ db: env.DB }))),
      ).catch((cause: unknown) => {
        console.error("API layer failed", cause);

        return errorJson(500, "Internal error");
      });
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<WorkerEnv>;
