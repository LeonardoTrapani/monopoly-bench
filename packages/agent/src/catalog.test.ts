import { estimateSeatCostUsd, featuredModels } from "@mb/api";
import { describe, expect, it } from "vite-plus/test";

import {
  bundledCatalog,
  catalogFromListings,
  catalogLabel,
  listingsOfModelList,
} from "./catalog.ts";
import { openRouterModelListSample } from "./testing.ts";

const catalog = () => catalogFromListings(listingsOfModelList(openRouterModelListSample()));

const entry = (model: string) => catalog().find((candidate) => candidate.model === model);

describe("model catalog", () => {
  it("keeps the models that support tools: featured first, then by provider and label", () => {
    expect(catalog().map((candidate) => candidate.model)).toEqual([
      "anthropic/claude-haiku-5.5",
      "openai/gpt-6.1-sol",
      "x-ai/grok-4.7",
      "moonshotai/kimi-k3.1-pro",
      "~anthropic/claude-haiku-latest",
      "mistralai/mistral-large",
      "openrouter/auto",
      "qwen/qwen-2.5-72b-instruct",
    ]);
  });

  it("maps names, prices per million tokens, reasoning and the seat cost estimate", () => {
    const pricing = {
      inputPerMTok: 0.1,
      outputPerMTok: 0.5,
      cacheReadPerMTok: 0.01,
      cacheWritePerMTok: 0.125,
    };

    expect(entry("anthropic/claude-haiku-5.5")).toEqual({
      model: "anthropic/claude-haiku-5.5",
      label: "Claude Haiku 5.5",
      provider: "Anthropic",
      providerSlug: "anthropic",
      featured: true,
      reasoning: true,
      contextLength: 1_000_000,
      pricing,
      estimatedSeatCostUsd: estimateSeatCostUsd(pricing),
    });
    expect(entry("x-ai/grok-4.7")).toMatchObject({
      provider: "SpaceXAI",
      label: "Grok 4.7",
      pricing: { cacheReadPerMTok: 0.5, cacheWritePerMTok: null },
    });
    expect(entry("mistralai/mistral-large")).toMatchObject({
      provider: "Mistral",
      label: "Mistral Large",
      reasoning: false,
      featured: false,
    });
    expect(entry("~anthropic/claude-haiku-latest")?.providerSlug).toBe("anthropic");
  });

  it("has no price for variable-price routers", () => {
    expect(entry("openrouter/auto")).toMatchObject({
      provider: "OpenRouter",
      pricing: null,
      estimatedSeatCostUsd: null,
    });
  });

  it("skips list entries that do not decode", () => {
    const listings = listingsOfModelList(
      '{"data":[{"id":1},{"id":"a/b","supported_parameters":["tools"],"extra":true}]}',
    );

    expect(listings).toEqual([{ id: "a/b", supported_parameters: ["tools"] }]);
    expect(() => listingsOfModelList('{"models":[]}')).toThrow();
  });

  it("falls back to pi-ai's bundled OpenRouter list, priced and featured first", () => {
    const bundled = bundledCatalog();
    const featured = bundled.filter((candidate) => candidate.featured);

    expect(bundled.length).toBeGreaterThan(300);
    expect(bundled.slice(0, featured.length)).toEqual(featured);
    expect(featured.map((candidate) => candidate.model)).toEqual(
      featuredModels.filter((model) => bundled.some((candidate) => candidate.model === model)),
    );
    expect(
      bundled.find((candidate) => candidate.model === "anthropic/claude-haiku-5.5"),
    ).toMatchObject({
      label: "Claude Haiku 5.5",
      provider: "Anthropic",
      pricing: { inputPerMTok: expect.any(Number) },
    });
  });

  it("gives the bundled list's OpenRouter routers no price, so runs cannot seat them (F1)", () => {
    const routers = bundledCatalog().filter((candidate) => candidate.providerSlug === "openrouter");

    expect(routers.length).toBeGreaterThan(0);
    expect(routers.every((router) => router.pricing === null)).toBe(true);
  });

  it("labels models by their pi-ai name", () => {
    expect(catalogLabel("anthropic/claude-haiku-5.5")).toBe("Claude Haiku 5.5");
    expect(catalogLabel("example/unknown")).toBe("example/unknown");
  });
});
