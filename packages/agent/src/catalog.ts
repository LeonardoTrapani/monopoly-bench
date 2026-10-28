/**
 * The model catalog of the run form (SPEC.md §7.2, `GET /api/catalog`): OpenRouter models that
 * support tool calling, as `ModelCatalogEntry`s. The Worker maps OpenRouter's public model list
 * (`GET https://openrouter.ai/api/v1/models`, no key) with `catalogFromListings`; pi-ai's bundled
 * OpenRouter list (`bundledCatalog`) stands in when OpenRouter is unreachable and names models
 * in the CLI.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  estimateSeatCostUsd,
  featuredModels,
  type ModelCatalogEntry,
  type ModelPricing,
  providerSlugOf,
} from "@mb/api";
import { Option, Schema } from "effect";

import { openRouterModels } from "./models.ts";

/** OpenRouter's per-token prices, as decimal strings (`"-1"` marks a variable-price router). */
export const OpenRouterPricing = Schema.Struct({
  prompt: Schema.optionalKey(Schema.String),
  completion: Schema.optionalKey(Schema.String),
  input_cache_read: Schema.optionalKey(Schema.String),
  input_cache_write: Schema.optionalKey(Schema.String),
});

/** One entry of OpenRouter's `GET /models`: the fields the catalog and run prices read. */
export const OpenRouterListing = Schema.Struct({
  id: Schema.String,
  /** "Provider: Model", e.g. "Anthropic: Claude Haiku 5.5". */
  name: Schema.optionalKey(Schema.String),
  context_length: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  top_provider: Schema.optionalKey(
    Schema.Struct({
      context_length: Schema.optionalKey(Schema.NullOr(Schema.Number)),
      max_completion_tokens: Schema.optionalKey(Schema.NullOr(Schema.Number)),
    }),
  ),
  pricing: Schema.optionalKey(OpenRouterPricing),
  supported_parameters: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
});

export type OpenRouterListing = typeof OpenRouterListing.Type;

const ListingPage = Schema.fromJsonString(Schema.Struct({ data: Schema.Array(Schema.Unknown) }));

const decodeListingPage = Schema.decodeUnknownSync(ListingPage);

const decodeListing = Schema.decodeUnknownOption(OpenRouterListing);

/**
 * The listings of a `GET /models` response body. Entries that do not decode are skipped, so one
 * odd model never hides the others; a body that is not `{ data: [...] }` throws.
 */
export const listingsOfModelList = (body: string): ReadonlyArray<OpenRouterListing> =>
  decodeListingPage(body).data.flatMap((entry) => Option.toArray(decodeListing(entry)));

/** Display names of provider slugs whose models are not named "Provider: Model". */
const PROVIDER_NAMES = new Map([
  ["anthropic", "Anthropic"],
  ["deepseek", "DeepSeek"],
  ["google", "Google"],
  ["meta-llama", "Meta"],
  ["minimax", "MiniMax"],
  ["mistralai", "Mistral"],
  ["moonshotai", "MoonshotAI"],
  ["openai", "OpenAI"],
  ["openrouter", "OpenRouter"],
  ["qwen", "Qwen"],
  ["rekaai", "Reka"],
  ["unbiased", "Unbiased"],
  ["x-ai", "xAI"],
  ["z-ai", "Z.ai"],
]);

interface ModelNaming {
  readonly provider: string;
  readonly label: string;
}

/** "Anthropic: Claude Haiku 5.5" → provider "Anthropic", label "Claude Haiku 5.5". */
export const modelNaming = (model: string, name: string | undefined): ModelNaming => {
  const separator = name?.indexOf(": ") ?? -1;

  if (name !== undefined && separator > 0) {
    return { provider: name.slice(0, separator), label: name.slice(separator + 2) };
  }

  const slug = providerSlugOf(model);

  return { provider: PROVIDER_NAMES.get(slug) ?? slug, label: name ?? model };
};

/** USD per token (OpenRouter) → USD per million tokens; null when missing or variable. */
const perMTok = (perToken: string | undefined): number | null => {
  if (perToken === undefined || perToken.trim() === "") return null;

  const value = Number(perToken);

  // toFixed: "0.0000001" × 1e6 is 0.09999999999999999 in floating point.
  return Number.isFinite(value) && value >= 0 ? Number((value * 1_000_000).toFixed(6)) : null;
};

/** Null unless both the input and the output price are known: routers price per request. */
export const listingPricing = (listing: OpenRouterListing): ModelPricing | null => {
  const inputPerMTok = perMTok(listing.pricing?.prompt);
  const outputPerMTok = perMTok(listing.pricing?.completion);

  if (inputPerMTok === null || outputPerMTok === null) return null;

  return {
    inputPerMTok,
    outputPerMTok,
    cacheReadPerMTok: perMTok(listing.pricing?.input_cache_read),
    cacheWritePerMTok: perMTok(listing.pricing?.input_cache_write),
  };
};

const integerOrNull = (value: number | null | undefined): number | null =>
  value !== undefined && value !== null && Number.isInteger(value) && value > 0 ? value : null;

type CatalogBase = Omit<ModelCatalogEntry, "providerSlug" | "featured" | "estimatedSeatCostUsd">;

const completeEntry = (base: CatalogBase): ModelCatalogEntry => ({
  ...base,
  providerSlug: providerSlugOf(base.model),
  featured: featuredModels.includes(base.model),
  estimatedSeatCostUsd: base.pricing === null ? null : estimateSeatCostUsd(base.pricing),
});

export const supportsTools = (listing: OpenRouterListing): boolean =>
  listing.supported_parameters?.includes("tools") === true;

export const catalogEntryOfListing = (listing: OpenRouterListing): ModelCatalogEntry =>
  completeEntry({
    model: listing.id,
    ...modelNaming(listing.id, listing.name),
    reasoning: listing.supported_parameters?.includes("reasoning") === true,
    contextLength: integerOrNull(listing.context_length ?? listing.top_provider?.context_length),
    pricing: listingPricing(listing),
  });

/** Featured models first, in `featuredModels` order; then by provider and label. */
export const sortCatalog = (
  entries: ReadonlyArray<ModelCatalogEntry>,
): ReadonlyArray<ModelCatalogEntry> => {
  const rank = (entry: ModelCatalogEntry): number => {
    const index = featuredModels.indexOf(entry.model);

    return index === -1 ? featuredModels.length : index;
  };

  return [...entries].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      a.provider.localeCompare(b.provider, "en") ||
      a.label.localeCompare(b.label, "en") ||
      a.model.localeCompare(b.model, "en"),
  );
};

/** The catalog of OpenRouter's live list: models that support tools, sorted. */
export const catalogFromListings = (
  listings: ReadonlyArray<OpenRouterListing>,
): ReadonlyArray<ModelCatalogEntry> =>
  sortCatalog(
    listings.flatMap((listing) => (supportsTools(listing) ? [catalogEntryOfListing(listing)] : [])),
  );

/** pi-ai stores "no cache price" as 0; a free cache read on a paid model would be wrong. */
const bundledCachePrice = (price: number, input: number): number | null =>
  price === 0 && input > 0 ? null : price;

/**
 * OpenRouter's own routers (`openrouter/auto`, …) bill whatever model they pick: pi-ai lists
 * them without a usable price, like the live list's "-1".
 */
const isVariablePriceRouter = (model: string): boolean => providerSlugOf(model) === "openrouter";

const bundledEntry = (model: Model<Api>): ModelCatalogEntry =>
  completeEntry({
    model: model.id,
    ...modelNaming(model.id, model.name),
    reasoning: model.reasoning,
    contextLength: integerOrNull(model.contextWindow),
    pricing: isVariablePriceRouter(model.id)
      ? null
      : {
          inputPerMTok: model.cost.input,
          outputPerMTok: model.cost.output,
          cacheReadPerMTok: bundledCachePrice(model.cost.cacheRead, model.cost.input),
          cacheWritePerMTok: bundledCachePrice(model.cost.cacheWrite, model.cost.input),
        },
  });

/**
 * pi-ai's bundled OpenRouter chat models (prices per million tokens, as of the pi-ai release).
 * pi-ai only bundles OpenRouter models that support tool calling, so all of them qualify.
 */
export const bundledCatalog = (): ReadonlyArray<ModelCatalogEntry> =>
  sortCatalog(openRouterModels().getModels("openrouter").map(bundledEntry));

/** Display label of an OpenRouter model id from pi-ai's bundled list, else the id itself. */
export const catalogLabel = (model: string): string => {
  const known = openRouterModels().getModel("openrouter", model);

  return known === undefined ? model : modelNaming(model, known.name).label;
};
