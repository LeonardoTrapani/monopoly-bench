/**
 * monopoly-bench infrastructure (SPEC.md §7): one Worker serving the API and the web app's
 * static assets, three SQLite-backed Durable Object namespaces, a D1 database with migrations,
 * an R2 bucket for game archives, and two secrets read from the environment.
 *
 *   bun run dev      local emulation (workerd, local D1/R2/DOs, local state; no credentials)
 *   bun run deploy   deploy to Cloudflare (needs an Alchemy Cloudflare profile, see README)
 *   bun run destroy  tear the stage down
 *
 * GitHub Actions (`.github/workflows/deploy.yml`) deploys stage `prod` from `main` and a
 * `pr-<number>` preview per pull request; `stacks/github.ts` provisions its credentials.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import * as Cloudflare from "@alchemy.run/cloudflare";
import * as GitHub from "@alchemy.run/github";
import * as Alchemy from "alchemy";
import * as Output from "alchemy/Output";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import type { GameDO, PlayerDO, RunDO } from "./src/worker.ts";

const isDev = process.env.ALCHEMY_DEV === "true" || process.env.ALCHEMY_DEV === "1";

/** `ALCHEMY_STATE=local` keeps deploy state in `.alchemy/` instead of the Cloudflare state store. */
const localStateOnly = isDev || process.env.ALCHEMY_STATE === "local";

const webDist = join(import.meta.dirname, "../web/dist");

const placeholderAssets = join(import.meta.dirname, "placeholder");

const webBuilt = existsSync(join(webDist, "index.html"));

if (!webBuilt) {
  console.warn(
    `[monopoly-bench] ${webDist} has no index.html: serving the placeholder page. Build apps/web before deploying.`,
  );
}

/** In local dev the secrets fall back to fixed values; deploys must provide them. */
const secret = (name: string, devDefault: string) =>
  isDev
    ? Config.Redacted(name).pipe(Config.withDefault(Redacted.make(devDefault)))
    : Config.Redacted(name);

export const Database = Cloudflare.D1.Database("Database", { migrations: "./migrations" });

/** The stage GitHub Actions deploys from `main`; every other stage is a preview or personal one. */
export const PROD_STAGE = "prod";

/** The public hostname of stage `prod`; other stages keep their workers.dev URL. */
export const PROD_DOMAIN = "monopolybench.leotrapani.com";

/** Archives of `prod` survive a destroy; a preview's are disposable, so its bucket is emptied. */
const archiveOf = (stage: string) =>
  Cloudflare.R2.Bucket("Archive", { forceDestroy: stage !== PROD_STAGE });

/** `alchemy dev` listens on HOST/PORT when set (e.g. by a preview tunnel), else localhost:1337. */
const devServer = {
  host: process.env.HOST ?? "localhost",
  port: Number.parseInt(process.env.PORT ?? "1337", 10),
};

const apiOf = (stage: string) =>
  Cloudflare.Worker("Api", {
    main: "./src/worker.ts",
    compatibility: { date: "2026-10-01" },
    dev: devServer,
    // null detaches custom domains: only prod has one.
    domain: stage === PROD_STAGE ? PROD_DOMAIN : null,
    observability: { enabled: true },
    assets: {
      directory: webBuilt ? webDist : placeholderAssets,
      notFoundHandling: "single-page-application",
      runWorkerFirst: ["/api/*"],
    },
    env: {
      DB: Database,
      ARCHIVE: archiveOf(stage),
      GAMES: Cloudflare.DurableObject<GameDO>("GameDO"),
      PLAYERS: Cloudflare.DurableObject<PlayerDO>("PlayerDO"),
      RUNS: Cloudflare.DurableObject<RunDO>("RunDO"),
      BENCH_API_KEY: secret("BENCH_API_KEY", "dev-bench-key"),
      OPENROUTER_API_KEY: secret("OPENROUTER_API_KEY", ""),
    },
  });

export interface WorkerEnv extends Cloudflare.InferEnv<ReturnType<typeof apiOf>> {}

export default Alchemy.Stack(
  "MonopolyBench",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), GitHub.providers()),
    state: localStateOnly ? Alchemy.localState() : Cloudflare.state(),
  },
  Effect.gen(function* () {
    const api = yield* apiOf(yield* Alchemy.Stage);
    const github = yield* GitHub.GitHubEnv;

    // A pull request's preview stage posts its URL on the PR and updates the comment per push.
    if (github?.pr !== undefined) {
      yield* GitHub.Comment("preview-comment", {
        owner: github.owner,
        repository: github.repository,
        issueNumber: github.pr,
        body: Output.interpolate`
          ## Preview deployed

          **URL:** ${api.url}

          Built from commit ${github.sha.slice(0, 7)}

          ---
          _This comment updates automatically with each push._
        `,
      });
    }

    return { url: api.url };
  }),
);
