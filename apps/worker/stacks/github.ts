/**
 * CI credentials as code (Alchemy's CI guide): mints the scoped Cloudflare API token that
 * `.github/workflows/deploy.yml` deploys with and writes it, the account id and the Worker's two
 * app secrets into the repository's GitHub Actions secrets. Deploy it once, and again to rotate:
 *
 *   BENCH_API_KEY=… OPENROUTER_API_KEY=… bunx alchemy deploy --config stacks/github.ts --profile admin --stage prod
 *
 * The `admin` profile needs a Cloudflare credential that can create API tokens (an API token
 * with Account API Tokens Write, or the Global API Key; OAuth cannot) and a GitHub token that
 * can write repository secrets (`gh auth token`). See apps/worker/README.md#deploy.
 */
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as GitHub from "@alchemy.run/github";
import * as Alchemy from "alchemy";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

const OWNER = "LeonardoTrapani";

const REPOSITORY = "monopoly-bench";

/** The zone of stage prod's hostname (`PROD_DOMAIN` in alchemy.run.ts). */
const ZONE_NAME = "leotrapani.com";

export default Alchemy.Stack(
  "MonopolyBenchGitHub",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), GitHub.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;

    const zone = yield* Cloudflare.Zone.findZoneByName({ accountId, name: ZONE_NAME }).pipe(
      Effect.orDie,
    );

    if (zone === undefined) {
      return yield* Effect.die(
        new Error(`Zone ${ZONE_NAME} is not in Cloudflare account ${accountId}`),
      );
    }

    const apiToken = yield* Cloudflare.ApiToken.AccountApiToken("CIToken", {
      accountId,
      policies: [
        {
          effect: "allow",
          // The stack's Worker, Durable Objects, D1 and R2; the workers.dev subdomain; the
          // state store's token in Secrets Store (bound on every run, so Write); `alchemy logs`.
          permissionGroups: [
            "Workers Scripts Write",
            "Workers R2 Storage Write",
            "D1 Write",
            "Account Settings Write",
            "Secrets Store Write",
            "Workers Tail Read",
          ],
          resources: { [`com.cloudflare.api.account.${accountId}`]: "*" },
        },
        {
          effect: "allow",
          // Finding the zone of stage prod's hostname; attaching the domain itself only needs
          // Workers Scripts Write.
          permissionGroups: ["Zone Read"],
          resources: {
            [`com.cloudflare.api.account.${accountId}`]: {
              [`com.cloudflare.api.account.zone.${zone.id}`]: "*",
            },
          },
        },
      ],
    });

    const secrets = {
      CLOUDFLARE_API_TOKEN: apiToken.value,
      CLOUDFLARE_ACCOUNT_ID: Redacted.make(accountId),
      BENCH_API_KEY: yield* Config.Redacted("BENCH_API_KEY"),
      OPENROUTER_API_KEY: yield* Config.Redacted("OPENROUTER_API_KEY"),
    };

    yield* Effect.all(
      Object.entries(secrets).map(([name, value]) =>
        GitHub.Secret(name, { owner: OWNER, repository: REPOSITORY, name, value }),
      ),
    );
  }),
);
