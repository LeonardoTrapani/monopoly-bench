/**
 * Mock competitors: a latent skill per model drives plausible ratings, head-to-head results,
 * behavior stats and costs. Deterministic: the same numbers on every load. LLMs only, like the
 * public leaderboard.
 */
import type {
  BehaviorStats,
  HeadToHeadCell,
  Leaderboard,
  LeaderboardEntry,
  ModelProfile,
  PlayersCount,
} from "@mb/api";

import { catalogLabel } from "./catalog.ts";
import { between, intBetween, noise, unit } from "./random.ts";

export interface MockCompetitor {
  readonly competitorId: string;
  readonly label: string;
  /** Latent strength, roughly 0 (plays at random) to 1 (best model). */
  readonly skill: number;
  readonly costPerGameUsd: number;
  readonly avgWakeMs: number;
  readonly invalidRate: number;
}

const llm = (
  model: string,
  reasoning: string | null,
  skill: number,
  costPerGameUsd: number,
  avgWakeMs: number,
  invalidRate: number,
): MockCompetitor => ({
  competitorId: reasoning === null ? model : `${model}:${reasoning}`,
  label: reasoning === null ? catalogLabel(model) : `${catalogLabel(model)} (${reasoning})`,
  skill,
  costPerGameUsd,
  avgWakeMs,
  invalidRate,
});

export const COMPETITORS: ReadonlyArray<MockCompetitor> = [
  llm("anthropic/claude-opus-5.5", "high", 0.94, 6.4, 21400, 0.004),
  llm("openai/gpt-6.1-sol", "high", 0.91, 5.1, 26800, 0.006),
  llm("google/gemini-4-argon", null, 0.86, 2.3, 9800, 0.011),
  llm("anthropic/claude-sonnet-5.5", null, 0.84, 1.9, 8600, 0.007),
  llm("x-ai/grok-4.7", null, 0.78, 2.6, 12100, 0.015),
  llm("openai/gpt-6-astra", null, 0.76, 1.2, 7400, 0.012),
  llm("deepseek/deepseek-v4-pro-0813", null, 0.72, 0.46, 15800, 0.019),
  llm("moonshotai/kimi-k3.1-pro", null, 0.69, 0.71, 11200, 0.022),
  llm("qwen/qwen3.8-max-0902", null, 0.66, 0.58, 10400, 0.024),
  llm("z-ai/glm-5.3", null, 0.6, 0.39, 9100, 0.031),
  llm("anthropic/claude-haiku-5.5", null, 0.57, 0.32, 3900, 0.018),
  llm("google/gemini-4-flash", null, 0.55, 0.21, 3100, 0.027),
  llm("mistralai/mistral-large-4-0", null, 0.51, 0.62, 6800, 0.038),
  llm("minimax/minimax-m3", null, 0.48, 0.18, 7900, 0.035),
  llm("meta-llama/llama-5-maverick", null, 0.4, 0.2, 5200, 0.052),
  llm("sao10k/l4-euryale-90b", null, 0.28, 0.31, 6100, 0.071),
];

export const competitorById = (competitorId: string): MockCompetitor | undefined =>
  COMPETITORS.find((competitor) => competitor.competitorId === competitorId);

/** Fewer models have played the large tables. */
const playsAt = (competitor: MockCompetitor, players: PlayersCount): boolean =>
  players === 4 || players === 2 || unit(`${competitor.competitorId}:plays:${players}`) < 0.82;

const gamesAt = (competitor: MockCompetitor, players: PlayersCount): number =>
  intBetween(
    `${competitor.competitorId}:games:${players}`,
    players === 4 ? 30 : 10,
    players === 4 ? 96 : 48,
  );

const entryFor = (competitor: MockCompetitor, players: PlayersCount): LeaderboardEntry => {
  const key = `${competitor.competitorId}:${players}`;
  const games = gamesAt(competitor, players);
  const mu = 14 + competitor.skill * 22 + noise(`${key}:mu`, 1.1);
  const sigma = Math.max(0.8, 7.5 / Math.sqrt(games / 3) + noise(`${key}:sigma`, 0.3));

  const expectedShare = Math.min(
    0.92,
    Math.max(0.01, (1 / players) * (0.25 + competitor.skill * 1.9)),
  );

  const wins = Math.round(
    games * Math.min(0.95, Math.max(0, expectedShare + noise(`${key}:wins`, 0.06))),
  );

  const avgPlace = Math.min(
    players,
    Math.max(1, 1 + (players - 1) * (1 - competitor.skill) * 0.95 + noise(`${key}:place`, 0.25)),
  );

  return {
    competitorId: competitor.competitorId,
    label: competitor.label,
    kind: "llm",
    mu,
    sigma,
    score: mu - 3 * sigma,
    games,
    wins,
    avgPlace,
    avgNetWorth: Math.round(
      (900 + competitor.skill * 4200 + noise(`${key}:worth`, 500)) * (4 / players),
    ),
    invalidRate: competitor.invalidRate * between(`${key}:invalid`, 0.7, 1.3),
    timeoutRate: between(`${key}:timeout`, 0, 0.012),
    modelAborts: 0,
    abortRate: 0,
    costPerGameUsd: competitor.costPerGameUsd * (players / 4) * between(`${key}:cost`, 0.85, 1.15),
    avgWakeMs: competitor.avgWakeMs * between(`${key}:latency`, 0.9, 1.1),
  };
};

const headToHeadFor = (
  entries: ReadonlyArray<LeaderboardEntry>,
  players: PlayersCount,
): ReadonlyArray<HeadToHeadCell> =>
  entries.flatMap((left, leftIndex) =>
    entries.slice(leftIndex + 1).flatMap((right) => {
      const leftSkill = competitorById(left.competitorId)?.skill ?? 0.5;
      const rightSkill = competitorById(right.competitorId)?.skill ?? 0.5;
      const key = `${left.competitorId}|${right.competitorId}|${players}`;

      if (unit(`${key}:met`) < 0.12) return [];

      const games = intBetween(`${key}:games`, 4, 26);
      const share = 1 / (1 + Math.exp(-(leftSkill - rightSkill) * 5)) + noise(`${key}:share`, 0.12);

      return [
        {
          a: left.competitorId,
          b: right.competitorId,
          games,
          aAhead: Math.round(games * Math.min(1, Math.max(0, share))),
        },
      ];
    }),
  );

export const mockLeaderboard = (players: PlayersCount): Leaderboard => {
  const entries = COMPETITORS.flatMap((competitor) =>
    playsAt(competitor, players) ? [entryFor(competitor, players)] : [],
  );

  return {
    playersCount: players,
    updatedAt: "2026-10-28T07:42:00.000Z",
    entries,
    headToHead: headToHeadFor(entries, players),
  };
};

const behaviorFor = (competitor: MockCompetitor): BehaviorStats => {
  const key = competitor.competitorId;
  const games = gamesAt(competitor, 4) + gamesAt(competitor, 2);

  const offersMade = Math.round(games * between(`${key}:offers`, 1.5, 6));

  return {
    offersMade,
    offersAccepted: Math.round(offersMade * between(`${key}:accepted`, 0.12, 0.38)),
    offersReceived: Math.round(offersMade * between(`${key}:received`, 0.8, 1.3)),
    offersAcceptedFromOthers: Math.round(offersMade * between(`${key}:acceptedOthers`, 0.08, 0.3)),
    auctionsWon: Math.round(games * between(`${key}:auctions`, 0.6, 2.4)),
    auctionPremium: between(`${key}:premium`, 0.62, 1.35),
    propertiesBought: Math.round(games * between(`${key}:bought`, 4, 7)),
    housesBuilt: Math.round(
      games * (2 + competitor.skill * 9) * between(`${key}:houses`, 0.7, 1.2),
    ),
    hotelsBuilt: Math.round(games * competitor.skill * 1.4 * between(`${key}:hotels`, 0.5, 1.2)),
    mortgages: Math.round(games * between(`${key}:mortgages`, 0.8, 3.2)),
    bankruptcies: Math.round(games * (1 - competitor.skill) * 0.55),
    jailTurns: Math.round(games * between(`${key}:jail`, 1.2, 2.8)),
  };
};

const ALL_COUNTS: ReadonlyArray<PlayersCount> = [2, 3, 4, 5, 6];

const HISTORY_POINTS = 14;

export const mockProfile = (
  competitor: MockCompetitor,
  recentGames: ModelProfile["recentGames"],
): ModelProfile => {
  const ratings = ALL_COUNTS.flatMap((players) => {
    if (!playsAt(competitor, players)) return [];

    const entry = entryFor(competitor, players);

    return [
      {
        playersCount: players,
        mu: entry.mu,
        sigma: entry.sigma,
        score: entry.score,
        games: entry.games,
        wins: entry.wins,
      },
    ];
  });

  const ratingHistory = ratings.flatMap((rating) =>
    Array.from({ length: HISTORY_POINTS }, (_, index) => {
      const progress = (index + 1) / HISTORY_POINTS;
      const day = 14 + index;

      return {
        playersCount: rating.playersCount,
        at: `2026-10-${day.toString().padStart(2, "0")}T12:00:00.000Z`,
        score:
          rating.score * (0.35 + 0.65 * progress) +
          noise(`${competitor.competitorId}:${rating.playersCount}:${index}`, 1.4) * (1 - progress),
      };
    }),
  );

  return {
    competitorId: competitor.competitorId,
    label: competitor.label,
    kind: "llm",
    ratings,
    ratingHistory,
    behavior: behaviorFor(competitor),
    costPerGameUsd: competitor.costPerGameUsd,
    avgWakeMs: competitor.avgWakeMs,
    recentGames,
  };
};
