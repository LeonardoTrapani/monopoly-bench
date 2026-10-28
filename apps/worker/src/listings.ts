/**
 * Prices of OpenRouter models from the public model list (`GET /api/v1/models`, no key).
 * Snapshotted into a run when it is created, so a run is charged at stable prices and models
 * newer than pi-ai's bundled catalog are still priced.
 */
import { OPENROUTER_MODELS_URL } from "@mb/agent";
import { Schema } from "effect";

import { ModelListing } from "./contracts.ts";

const CACHE_MS = 10 * 60_000;

const ModelList = Schema.Struct({ data: Schema.Array(ModelListing) });

const decodeModelList = Schema.decodeUnknownPromise(ModelList);

let cache: { readonly at: number; readonly listings: ReadonlyArray<ModelListing> } | undefined;

export const fetchListings = async (
  modelIds: ReadonlyArray<string>,
  fetcher: typeof fetch,
  now: number,
): Promise<ReadonlyArray<ModelListing>> => {
  if (modelIds.length === 0) return [];

  try {
    if (cache === undefined || now - cache.at > CACHE_MS) {
      const response = await fetcher(OPENROUTER_MODELS_URL, {
        headers: { accept: "application/json" },
      });

      if (!response.ok) return [];

      cache = { at: now, listings: (await decodeModelList(await response.json())).data };
    }

    const wanted = new Set(modelIds);

    return cache.listings.filter((listing) => wanted.has(listing.id));
  } catch (cause) {
    console.error("OpenRouter model list unavailable; using pi-ai catalog prices", cause);

    return [];
  }
};
