/**
 * The stack's stateful resources, declared once and bound wherever they are used (the Worker and
 * the Durable Objects bind them through Alchemy's D1 and R2 bindings).
 */
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import { Effect } from "effect";

/** The stage GitHub Actions deploys from `main`; every other stage is a preview or personal one. */
export const PROD_STAGE = "prod";

/** The public hostname of stage `prod`; other stages keep their workers.dev URL. */
export const PROD_DOMAIN = "monopolybench.leotrapani.com";

export const Database = Cloudflare.D1.Database("Database", { migrations: "./migrations" });

/** Archives of `prod` survive a destroy; a preview's are disposable, so its bucket is emptied. */
export const Archive = Effect.gen(function* () {
  const stage = yield* Alchemy.Stage;

  return yield* Cloudflare.R2.Bucket("Archive", { forceDestroy: stage !== PROD_STAGE });
});
