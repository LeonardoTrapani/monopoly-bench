import { listingsOfModelList } from "@mb/agent";
import { openRouterModelListSample } from "@mb/agent/testing";
import { describe, expect, it } from "vite-plus/test";

import { deleteRunArchives } from "./archive.ts";
import {
  BUNDLED_TTL_MS,
  bundledSnapshot,
  CATALOG_TTL_MS,
  liveSnapshot,
  ModelCatalog,
  runModelProblem,
} from "./catalog.ts";
import { checkOpenRouterKey, OPENROUTER_KEY_URL } from "./openrouter-key.ts";
import { memoryBucket } from "./testing/archive.ts";

interface FakeOpenRouter {
  readonly fetcher: typeof fetch;
  readonly requests: Array<{ readonly url: string; readonly authorization: string | null }>;
}

/** Answers every request with `respond()`; records URLs and authorization headers. */
const openRouter = (respond: () => Response): FakeOpenRouter => {
  const requests: Array<{ readonly url: string; readonly authorization: string | null }> = [];

  const fetcher: typeof fetch = async (input, init) => {
    requests.push({
      url: new Request(input).url,
      authorization: new Headers(init?.headers).get("authorization"),
    });

    return respond();
  };

  return { fetcher, requests };
};

describe("model catalog", () => {
  it("serves OpenRouter's tool models for an hour, from one request", async () => {
    const clock = { now: 0 };
    const fake = openRouter(() => new Response(openRouterModelListSample()));

    const catalog = new ModelCatalog(
      fake.fetcher,
      () => clock.now,
      () => {},
    );

    const [first, second] = await Promise.all([catalog.snapshot(), catalog.snapshot()]);

    expect(first?.catalog.source).toBe("openrouter");
    expect(second).toBe(first);
    expect(fake.requests).toEqual([
      { url: "https://openrouter.ai/api/v1/models", authorization: null },
    ]);
    expect(first?.listings.get("anthropic/claude-haiku-5.5")).toEqual({
      id: "anthropic/claude-haiku-5.5",
      context_length: 1_000_000,
      top_provider: { context_length: 1_000_000, max_completion_tokens: 128_000 },
      pricing: {
        prompt: "0.0000001",
        completion: "0.0000005",
        input_cache_read: "0.00000001",
        input_cache_write: "0.000000125",
      },
    });

    clock.now = CATALOG_TTL_MS - 1;
    await catalog.snapshot();

    expect(fake.requests).toHaveLength(1);

    clock.now = CATALOG_TTL_MS;
    await catalog.snapshot();

    expect(fake.requests).toHaveLength(2);
  });

  it("falls back to pi-ai's bundled list when OpenRouter fails, and asks again soon", async () => {
    const clock = { now: 0 };
    const logs: Array<string> = [];
    let down = true;

    const fake = openRouter(() =>
      down ? new Response("busy", { status: 503 }) : new Response(openRouterModelListSample()),
    );

    const catalog = new ModelCatalog(
      fake.fetcher,
      () => clock.now,
      (message) => logs.push(message),
    );

    const fallback = await catalog.snapshot();

    expect(fallback.catalog.source).toBe("bundled");
    expect(fallback.catalog.models.length).toBeGreaterThan(300);
    expect(fallback.listings.size).toBe(0);
    expect(logs).toHaveLength(1);

    down = false;
    clock.now = BUNDLED_TTL_MS - 1;

    expect((await catalog.snapshot()).catalog.source).toBe("bundled");

    clock.now = BUNDLED_TTL_MS;

    expect((await catalog.snapshot()).catalog.source).toBe("openrouter");
  });

  it("explains why a run may not seat a model", () => {
    const live = liveSnapshot(listingsOfModelList(openRouterModelListSample()), "now");

    expect(runModelProblem(live, "anthropic/claude-haiku-5.5")).toBeNull();
    expect(runModelProblem(live, "moondream/moondream3-preview")).toContain(
      "does not support tool calling",
    );
    expect(runModelProblem(live, "openrouter/auto")).toBeNull();
    expect(runModelProblem(live, "nobody/nothing")).toContain("is not in the catalog");

    const bundled = bundledSnapshot("now");

    expect(runModelProblem(bundled, "anthropic/claude-haiku-5.5")).toBeNull();
    expect(runModelProblem(bundled, "nobody/nothing")).toContain("is not in the catalog");
    expect(runModelProblem(bundled, "openrouter/auto")).toBeNull();
  });

  it("refuses models whose context window cannot hold a seat (F5)", () => {
    const listings = listingsOfModelList(openRouterModelListSample()).map((listing) =>
      listing.id === "anthropic/claude-haiku-5.5" ? { ...listing, context_length: 8_000 } : listing,
    );

    expect(runModelProblem(liveSnapshot(listings, "now"), "anthropic/claude-haiku-5.5")).toContain(
      "8000-token context window",
    );
  });
});

describe("own OpenRouter keys", () => {
  it("asks OpenRouter's key endpoint with the key and reads its remaining credit", async () => {
    const fake = openRouter(
      () =>
        new Response(JSON.stringify({ data: { label: "mine", limit: 20, limit_remaining: 7.5 } })),
    );

    expect(await checkOpenRouterKey("sk-or-v1-abc", fake.fetcher)).toEqual({
      status: "valid",
      limitRemainingUsd: 7.5,
    });
    expect(fake.requests).toEqual([
      { url: OPENROUTER_KEY_URL, authorization: "Bearer sk-or-v1-abc" },
    ]);
    expect(OPENROUTER_KEY_URL).toBe("https://openrouter.ai/api/v1/key");
  });

  it("treats a key without a limit, or an unreadable body, as valid without a limit", async () => {
    const unlimited = openRouter(
      () => new Response(JSON.stringify({ data: { limit: null, limit_remaining: null } })),
    );

    const odd = openRouter(() => new Response("not json"));

    expect(await checkOpenRouterKey("k", unlimited.fetcher)).toEqual({
      status: "valid",
      limitRemainingUsd: null,
    });
    expect(await checkOpenRouterKey("k", odd.fetcher)).toEqual({
      status: "valid",
      limitRemainingUsd: null,
    });
  });

  it("tells a refused key from an OpenRouter that cannot answer", async () => {
    const refused = openRouter(() => new Response("{}", { status: 401 }));
    const busy = openRouter(() => new Response("{}", { status: 503 }));

    const unreachable: typeof fetch = async () => {
      throw new Error("network down for sk-or-v1-secret");
    };

    expect(await checkOpenRouterKey("k", refused.fetcher)).toEqual({ status: "rejected" });
    expect(await checkOpenRouterKey("k", busy.fetcher)).toEqual({
      status: "unavailable",
      reason: "OpenRouter answered 503",
    });
    // The network error (which could carry anything) is not passed on.
    expect(await checkOpenRouterKey("sk-or-v1-secret", unreachable)).toEqual({
      status: "unavailable",
      reason: "OpenRouter could not be reached",
    });
  });
});

describe("run archives", () => {
  it("deletes every object of the run's games, page by page, and nothing else", async () => {
    const archive = memoryBucket(2);
    const gameIds = ["r-1-0-0", "r-1-0-1", "r-1-1-0"];

    for (const gameId of gameIds) {
      for (const file of ["config.json", "events.jsonl", "summary.json", "seats/A.jsonl"]) {
        archive.objects.set(`games/${gameId}/${file}`, "x");
      }
    }

    archive.objects.set("games/r-10-0-0/events.jsonl", "another run");
    archive.objects.set("games/r-1-9-9/events.jsonl", "not a game of this run");

    expect(await deleteRunArchives(archive.bucket, "r-1", gameIds)).toBe(12);
    expect([...archive.objects.keys()].sort()).toEqual([
      "games/r-1-9-9/events.jsonl",
      "games/r-10-0-0/events.jsonl",
    ]);
    expect(archive.requests.filter((request) => request.startsWith("list"))).toHaveLength(7);
    expect(archive.requests.filter((request) => request.startsWith("delete"))).toEqual([
      "delete 12",
    ]);
  });
});
