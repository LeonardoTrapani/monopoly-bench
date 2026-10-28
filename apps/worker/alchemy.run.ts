/**
 * monopoly-bench infrastructure (SPEC.md §7): one Effect Worker (`src/worker.ts`) serving the API
 * and the web app's static assets, its three SQLite-backed Durable Objects, a D1 database with
 * migrations and an R2 bucket for game archives (`src/resources.ts`), and two secrets read from
 * the environment.
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
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import Api from "./src/worker.ts";

const isDev = process.env.ALCHEMY_DEV === "true" || process.env.ALCHEMY_DEV === "1";

/** `ALCHEMY_STATE=local` keeps deploy state in `.alchemy/` instead of the Cloudflare state store. */
const localStateOnly = isDev || process.env.ALCHEMY_STATE === "local";

const webDist = join(import.meta.dirname, "../web/dist");

if (!existsSync(join(webDist, "index.html"))) {
  console.warn(
    `[monopoly-bench] ${webDist} has no index.html: serving the placeholder page. Build apps/web before deploying.`,
  );
}

export default Alchemy.Stack(
  "MonopolyBench",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), GitHub.providers()),
    state: localStateOnly ? Alchemy.localState() : Cloudflare.state(),
  },
  Effect.gen(function* () {
    const api = yield* Api;
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
