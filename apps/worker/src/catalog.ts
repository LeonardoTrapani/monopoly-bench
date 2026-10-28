/**
 * The model catalog (`GET /api/catalog`, SPEC.md §7.2) and the price snapshot of new runs, both
 * from OpenRouter's public model list (`GET https://openrouter.ai/api/v1/models`, no key), kept
 * for an hour per Worker isolate. When OpenRouter fails, pi-ai's bundled OpenRouter list stands
 * in (`source: "bundled"`) and OpenRouter is asked again after a few minutes.
 *
 * A run snapshots the listings of its models, so models newer than pi-ai's bundled list are
 * priced; what a response costs is what OpenRouter reports it charged (`withReportedCost` in
 * `@mb/agent`), and the snapshot prices only stand in when a response reports nothing.
 */
import {
  bundledCatalog,
  catalogFromListings,
  listingsOfModelList,
  OPENROUTER_MODELS_URL,
  type OpenRouterListing,
  supportsTools,
} from "@mb/agent";
import type { CatalogResponse } from "@mb/api";
import { Clock, Context, Effect, Layer, Schema, Semaphore } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { ModelListing } from "./contracts.ts";

export const CATALOG_TTL_MS = 60 * 60_000;

/** How long the bundled stand-in is served before OpenRouter is asked again. */
export const BUNDLED_TTL_MS = 5 * 60_000;

export interface CatalogSnapshot {
  readonly catalog: CatalogResponse;
  /** Every model id OpenRouter listed, with or without tools (empty for the bundled list). */
  readonly listed: ReadonlySet<string>;
  /** OpenRouter's entries of the catalog's models: the prices a new run snapshots. */
  readonly listings: ReadonlyMap<string, ModelListing>;
}

/** The stored fields of a listing (`ModelListing` drops names and parameters). */
const toModelListing = Schema.decodeUnknownSync(ModelListing);

export const liveSnapshot = (
  listings: ReadonlyArray<OpenRouterListing>,
  updatedAt: string,
): CatalogSnapshot => ({
  catalog: { updatedAt, source: "openrouter", models: catalogFromListings(listings) },
  listed: new Set(listings.map((listing) => listing.id)),
  listings: new Map(
    listings.flatMap((listing) =>
      supportsTools(listing) ? [[listing.id, toModelListing(listing)] as const] : [],
    ),
  ),
});

export const bundledSnapshot = (updatedAt: string): CatalogSnapshot => ({
  catalog: { updatedAt, source: "bundled", models: bundledCatalog() },
  listed: new Set(),
  listings: new Map(),
});

interface CachedSnapshot {
  readonly expiresAt: number;
  readonly snapshot: CatalogSnapshot;
}

/** OpenRouter answered, but with no model a run could seat. */
class EmptyModelList extends Schema.TaggedError<EmptyModelList>()("EmptyModelList", {}) {}

/** A catalog cached for as long as it lives (one per Worker isolate). */
const make = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const loading = yield* Semaphore.make(1);
  let cached: CachedSnapshot | undefined;

  const load = Effect.gen(function* () {
    const at = yield* Clock.currentTimeMillis;
    const updatedAt = new Date(at).toISOString();

    const fresh = yield* client
      .get(OPENROUTER_MODELS_URL, { headers: { accept: "application/json" } })
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => response.text),
        Effect.flatMap((text) =>
          Effect.try({
            try: () => liveSnapshot(listingsOfModelList(text), updatedAt),
            catch: (cause) => cause,
          }),
        ),
        Effect.flatMap((snapshot) =>
          snapshot.catalog.models.length === 0
            ? Effect.fail(new EmptyModelList())
            : Effect.succeed({ expiresAt: at + CATALOG_TTL_MS, snapshot }),
        ),
        Effect.catch((cause) =>
          Effect.logError(
            "OpenRouter model list unavailable; serving pi-ai's bundled list",
            cause,
          ).pipe(
            Effect.as({ expiresAt: at + BUNDLED_TTL_MS, snapshot: bundledSnapshot(updatedAt) }),
          ),
        ),
      );

    cached = fresh;

    return fresh.snapshot;
  });

  return {
    snapshot: loading.withPermits(1)(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;

        return cached !== undefined && now < cached.expiresAt ? cached.snapshot : yield* load;
      }),
    ),
  };
});

export class ModelCatalog extends Context.Service<
  ModelCatalog,
  {
    /** The current snapshot; concurrent callers share one OpenRouter request. */
    readonly snapshot: Effect.Effect<CatalogSnapshot>;
  }
>()("monopoly-bench/ModelCatalog") {
  static readonly layer = Layer.effect(ModelCatalog, make);
}

/** Smallest context window a seat can play with: ~10k fixed tokens plus room for memory. */
export const MIN_CONTEXT_TOKENS = 32_000;

/**
 * Why a run may not seat `model`, or null when it may: it must be a catalog model (tool
 * calling) with room for a seat in its context window. Routers without a fixed price may play:
 * the budget counts what OpenRouter reports it charged.
 */
export const runModelProblem = (snapshot: CatalogSnapshot, model: string): string | null => {
  const entry = snapshot.catalog.models.find((candidate) => candidate.model === model);

  if (entry === undefined) {
    return snapshot.listed.has(model)
      ? `Model "${model}" does not support tool calling on OpenRouter; LLM seats play through tools.`
      : `Model "${model}" is not in the catalog of OpenRouter models that support tool calling (GET /api/catalog).`;
  }

  if (entry.contextLength !== null && entry.contextLength < MIN_CONTEXT_TOKENS) {
    return `Model "${model}" has a ${entry.contextLength}-token context window; seats need at least ${MIN_CONTEXT_TOKENS} (system prompt, tools and a wake take about 10k).`;
  }

  return null;
};
