/**
 * Worker entry: the HTTP API under `/api/` and the Durable Object classes. Everything else is
 * served by the static assets of `apps/web/dist` (single-page-application fallback, so client
 * routes like `/games/123` get `index.html`).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import * as Cloudflare from "@alchemy.run/cloudflare";
import { WorkerEnvironment } from "@alchemy.run/cloudflare/Workers/WorkerRuntime";
import * as Alchemy from "alchemy";
import { RuntimeContext } from "alchemy/RuntimeContext";
import { Effect, Layer } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import { type ApiDeps, handleApi } from "./api/router.ts";
import { newCancelToken } from "./api/auth.ts";
import { deleteRunArchives } from "./archive.ts";
import { ModelCatalog } from "./catalog.ts";
import { GameDO } from "./do/game-do.ts";
import { PlayerDO } from "./do/player-do.ts";
import { RunDO } from "./do/run-do.ts";
import { boundSecret, deploySecret, runD1 } from "./do/runtime.ts";
import { upstream } from "./errors.ts";
import { archiveKeys } from "./game/game-host.ts";
import { checkOpenRouterKey } from "./openrouter-key.ts";
import { Archive, Database, PROD_DOMAIN, PROD_STAGE } from "./resources.ts";
import { newRunId } from "./runs/expand.ts";

const webDist = join(import.meta.dirname, "../../web/dist");

const placeholderAssets = join(import.meta.dirname, "../placeholder");

/**
 * The Worker's props, resolved at deploy time (and again, unused, when the bundle starts): it
 * serves the built web app, or a placeholder page without it (`alchemy.run.ts` warns).
 */
const props = Effect.gen(function* () {
  const stage = yield* Alchemy.Stage;
  const webBuilt = existsSync(join(webDist, "index.html"));

  return {
    main: import.meta.url,
    compatibility: { date: "2026-10-01" },
    // `alchemy dev` listens on HOST/PORT when set (e.g. by a preview tunnel), else localhost:1337.
    dev: {
      host: process.env.HOST ?? "localhost",
      port: Number.parseInt(process.env.PORT ?? "1337", 10),
    },
    // null detaches custom domains: only prod has one.
    domain: stage === PROD_STAGE ? PROD_DOMAIN : null,
    observability: { enabled: true },
    env: {
      BENCH_API_KEY: deploySecret("BENCH_API_KEY", "dev-bench-key"),
      OPENROUTER_API_KEY: deploySecret("OPENROUTER_API_KEY", ""),
    },
    assets: {
      directory: webBuilt ? webDist : placeholderAssets,
      notFoundHandling: "single-page-application" as const,
      runWorkerFirst: ["/api/*"],
    },
  };
});

export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  props,
  Effect.gen(function* () {
    const games = yield* GameDO;
    // Bound so the Worker hosts the class; only GameDO and RunDO call it.
    yield* PlayerDO;
    const runs = yield* RunDO;
    const database = yield* Cloudflare.D1.QueryDatabase(Database);
    const archive = yield* Cloudflare.R2.ReadWriteBucket(Archive);
    // Per isolate: the catalog is fetched from OpenRouter at most about once an hour.
    const catalog = yield* ModelCatalog;

    const archivedText = (key: string) =>
      archive.get(key).pipe(
        Effect.flatMap((object) => (object === null ? Effect.succeed(null) : object.text())),
        upstream(`R2 get ${key}`),
      );

    const deps = (runtime: RuntimeContext["Service"], benchApiKey: string): ApiDeps => {
      const inRuntime = Effect.provideService(RuntimeContext, runtime);

      return {
        benchApiKey,
        runs: {
          create: (runId, config, listings, ownKey) =>
            runs
              .getByName(runId)
              .create(runId, config, listings, ownKey)
              .pipe(upstream("RunDO create")),
          cancel: (runId) => runs.getByName(runId).cancel().pipe(upstream("RunDO cancel")),
          cancelTokenMatches: (runId, tokenSha256) =>
            runs
              .getByName(runId)
              .cancelTokenMatches(tokenSha256)
              .pipe(upstream("RunDO cancelTokenMatches")),
          purge: (runId) => runs.getByName(runId).purge().pipe(upstream("RunDO purge")),
        },
        games: {
          liveEvents: (gameId, since) =>
            games.getByName(gameId).events(since).pipe(upstream("GameDO events")),
          archivedEvents: (gameId) => archivedText(archiveKeys.events(gameId)).pipe(inRuntime),
          liveTranscripts: (gameId, seat) =>
            games.getByName(gameId).transcripts(seat).pipe(upstream("GameDO transcripts")),
          archivedTranscripts: (gameId, seat) =>
            archivedText(archiveKeys.seat(gameId, seat)).pipe(inRuntime),
          liveConfig: (gameId) => games.getByName(gameId).config().pipe(upstream("GameDO config")),
          archivedConfig: (gameId) => archivedText(archiveKeys.config(gameId)).pipe(inRuntime),
          spectate: (gameId, request) =>
            games.getByName(gameId).fetch(request).pipe(upstream("GameDO spectate")),
          deleteArchives: (runId, gameIds) =>
            deleteRunArchives(
              {
                list: (options) => archive.list(options).pipe(inRuntime),
                delete: (keys) => archive.delete(keys).pipe(inRuntime),
              },
              runId,
              gameIds,
            ).pipe(Effect.asVoid, upstream("R2 delete archives")),
        },
        catalog: catalog.snapshot,
        checkOpenRouterKey: (key) =>
          checkOpenRouterKey(key).pipe(Effect.provide(FetchHttpClient.layer)),
        newRunId: () => newRunId(new Date(), Math.random),
        newCancelToken,
      };
    };

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const pathname = request.url.split("?")[0] ?? "";

        if (pathname === "/api" || pathname.startsWith("/api/")) {
          const runtime = yield* RuntimeContext;
          const benchApiKey = yield* boundSecret("BENCH_API_KEY");
          const d1 = runD1(yield* database.raw);

          return yield* d1(handleApi(request, deps(runtime, benchApiKey)));
        }

        // A path the asset layer did not match: its single-page fallback serves `index.html`.
        const env = yield* WorkerEnvironment;
        const raw = yield* Cloudflare.Request;
        const assets: Fetcher = env.ASSETS;

        return HttpServerResponse.fromWeb(yield* Effect.promise(() => assets.fetch(raw)));
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        ModelCatalog.layer.pipe(Layer.provide(FetchHttpClient.layer)),
        Cloudflare.D1.QueryDatabaseBinding,
        Cloudflare.R2.ReadWriteBucketBinding,
      ),
    ),
  ),
) {}
