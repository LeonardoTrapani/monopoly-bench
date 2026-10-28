/**
 * Worker entry: the HTTP API under `/api/` and the Durable Object classes. Everything else is
 * served by the static assets of `apps/web/dist` (single-page-application fallback, so client
 * routes like `/games/123` get `index.html`).
 */
import { defaultModelCatalog } from "@mb/api";
import { D1Client } from "@effect/sql-d1";
import { Effect } from "effect";

import type { WorkerEnv } from "../alchemy.run.ts";
import { type ApiDeps, handleApi } from "./api/router.ts";
import { errorJson } from "./api/http.ts";
import { archiveKeys } from "./game/game-host.ts";
import { fetchListings } from "./listings.ts";
import { newRunId } from "./runs/expand.ts";

export { GameDO } from "./do/game-do.ts";

export { PlayerDO } from "./do/player-do.ts";

export { RunDO } from "./do/run-do.ts";

const apiDeps = (env: WorkerEnv): ApiDeps => ({
  benchApiKey: env.BENCH_API_KEY,
  catalog: defaultModelCatalog,
  runs: {
    create: (runId, config, listings) => env.RUNS.getByName(runId).create(runId, config, listings),
    cancel: (runId) => env.RUNS.getByName(runId).cancel(),
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
  },
  listings: (modelIds) => fetchListings(modelIds, fetch, Date.now()),
  newRunId: () => newRunId(new Date(), Math.random),
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
