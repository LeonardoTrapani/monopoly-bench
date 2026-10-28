/** The sim fixtures (real bot games) and sample API payloads, for tests. */
import {
  estimateSeatCostUsd,
  featuredModels,
  providerSlugOf,
  type CatalogResponse,
  type GameSummary,
  type Leaderboard,
  type LeaderboardEntry,
  type ModelCatalogEntry,
  type ModelPricing,
} from "@mb/api";
import { GameConfig, GameEventJson, type GameEvent } from "@mb/engine";
import { Schema } from "effect";

import sample2pConfig from "../../../../packages/sim/fixtures/sample-2p.config.json";
import sample2pEvents from "../../../../packages/sim/fixtures/sample-2p.events.jsonl?raw";

const decodeEvent = Schema.decodeUnknownSync(GameEventJson);

export const sample2p = {
  config: Schema.decodeUnknownSync(GameConfig)(sample2pConfig),
  events: sample2pEvents
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line): GameEvent => decodeEvent(line)),
};

export const entry = (
  competitorId: string,
  score: number,
  games: number,
  wins: number,
): LeaderboardEntry => ({
  competitorId,
  label: competitorId.toUpperCase(),
  kind: "llm",
  mu: score + 6,
  sigma: 2,
  score,
  games,
  wins,
  avgPlace: 2,
  avgNetWorth: 3000,
  invalidRate: 0.01,
  timeoutRate: 0,
  costPerGameUsd: 1,
  avgWakeMs: 5000,
});

export const leaderboard = (playersCount: 2 | 3 | 4 | 5 | 6): Leaderboard => ({
  playersCount,
  updatedAt: null,
  entries: [entry("a/alpha", 20, 40, 10), entry("b/beta", 30, 50, 30), entry("c/gamma", 5, 80, 4)],
  headToHead: [{ a: "a/alpha", b: "b/beta", games: 10, aAhead: 3 }],
});

const catalogEntry = (
  model: string,
  label: string,
  provider: string,
  reasoning: boolean,
  pricing: ModelPricing | null,
): ModelCatalogEntry => ({
  model,
  label,
  provider,
  providerSlug: providerSlugOf(model),
  featured: featuredModels.includes(model),
  reasoning,
  contextLength: 200_000,
  pricing,
  estimatedSeatCostUsd: pricing === null ? null : estimateSeatCostUsd(pricing),
});

/** A small model catalog: three featured models, two others and one without a price. */
export const catalog: CatalogResponse = {
  updatedAt: "2026-10-28T09:00:00.000Z",
  source: "openrouter",
  models: [
    catalogEntry("zeta/zeta-1", "Zeta 1", "Zeta", false, {
      inputPerMTok: 1,
      outputPerMTok: 1,
      cacheReadPerMTok: null,
      cacheWritePerMTok: null,
    }),
    catalogEntry("anthropic/claude-haiku-5.5", "Claude Haiku 5.5", "Anthropic", true, {
      inputPerMTok: 1,
      outputPerMTok: 5,
      cacheReadPerMTok: 0.1,
      cacheWritePerMTok: 1.25,
    }),
    catalogEntry("deepseek/deepseek-v4-pro-0813", "DeepSeek V4 Pro", "DeepSeek", true, {
      inputPerMTok: 0.6,
      outputPerMTok: 2.2,
      cacheReadPerMTok: 0.06,
      cacheWritePerMTok: null,
    }),
    catalogEntry("anthropic/claude-sonnet-5.5", "Claude Sonnet 5.5", "Anthropic", true, {
      inputPerMTok: 3,
      outputPerMTok: 15,
      cacheReadPerMTok: 0.3,
      cacheWritePerMTok: 3.75,
    }),
    catalogEntry("acme/mystery-7b", "Mystery 7B", "Acme", false, null),
    catalogEntry("mistralai/devstral-2", "Devstral 2", "Mistral", false, {
      inputPerMTok: 0.5,
      outputPerMTok: 1.5,
      cacheReadPerMTok: null,
      cacheWritePerMTok: null,
    }),
  ],
};

export const summary = (status: GameSummary["status"]): GameSummary => ({
  id: "game-1",
  runId: "run-1",
  seed: "sample-2p",
  status,
  playersCount: 2,
  startedAt: "2026-10-28T08:00:00.000Z",
  finishedAt: null,
  turn: 10,
  round: 5,
  endReason: null,
  abortReason: null,
  winnerSeat: null,
  seats: [],
});
