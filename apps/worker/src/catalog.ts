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
import { Schema } from "effect";

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

export class ModelCatalog {
  private cached: CachedSnapshot | undefined = undefined;
  private loading: Promise<CatalogSnapshot> | undefined = undefined;

  constructor(
    private readonly fetcher: typeof fetch,
    private readonly now: () => number,
    private readonly log: (message: string, cause?: unknown) => void,
  ) {}

  /** The current snapshot; concurrent callers share one OpenRouter request. */
  snapshot(): Promise<CatalogSnapshot> {
    const cached = this.cached;

    if (cached !== undefined && this.now() < cached.expiresAt) {
      return Promise.resolve(cached.snapshot);
    }

    this.loading ??= this.load().finally(() => {
      this.loading = undefined;
    });

    return this.loading;
  }

  private async load(): Promise<CatalogSnapshot> {
    const at = this.now();
    const updatedAt = new Date(at).toISOString();

    try {
      const response = await this.fetcher(OPENROUTER_MODELS_URL, {
        headers: { accept: "application/json" },
      });

      if (!response.ok) throw new Error(`OpenRouter answered ${response.status}`);

      const snapshot = liveSnapshot(listingsOfModelList(await response.text()), updatedAt);

      if (snapshot.catalog.models.length === 0) throw new Error("OpenRouter listed no tool models");

      this.cached = { expiresAt: at + CATALOG_TTL_MS, snapshot };

      return snapshot;
    } catch (cause) {
      this.log("OpenRouter model list unavailable; serving pi-ai's bundled list", cause);

      const snapshot = bundledSnapshot(updatedAt);

      this.cached = { expiresAt: at + BUNDLED_TTL_MS, snapshot };

      return snapshot;
    }
  }
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
