/**
 * Ratings (SPEC.md §8): OpenSkill with the Plackett–Luce model, one table per player count,
 * ranks from the final standings, leaderboard score = mu − 3σ. Pure: callers load the priors
 * and store the posteriors.
 *
 * A competitor may hold several seats of one game (e.g. two `bot:random` seats). Each seat is
 * rated as its own player starting from the competitor's prior, and the competitor's posterior
 * is the mean of its seats' posteriors.
 */
import { rate, rating } from "openskill";
import { plackettLuce } from "openskill/models";

export interface Skill {
  readonly mu: number;
  readonly sigma: number;
}

export const DEFAULT_SKILL: Skill = rating();

export const score = (skill: Skill): number => skill.mu - 3 * skill.sigma;

export interface Placement {
  readonly competitorId: string;
  /** 1 = winner. Equal ranks are ties. */
  readonly rank: number;
}

export interface RatedCompetitor {
  readonly competitorId: string;
  readonly mu: number;
  readonly sigma: number;
  readonly score: number;
  /** Best rank of the competitor in this game. */
  readonly rank: number;
  readonly won: boolean;
}

export const rateGame = (
  placements: ReadonlyArray<Placement>,
  priors: ReadonlyMap<string, Skill>,
): ReadonlyArray<RatedCompetitor> => {
  if (placements.length < 2) return [];

  const teams = placements.map((placement) => {
    const prior = priors.get(placement.competitorId) ?? DEFAULT_SKILL;

    return [{ mu: prior.mu, sigma: prior.sigma }];
  });

  const posteriors = rate(teams, {
    rank: placements.map((placement) => placement.rank),
    model: plackettLuce,
  });

  const bestRank = Math.min(...placements.map((placement) => placement.rank));

  const byCompetitor = new Map<
    string,
    { mus: Array<number>; sigmas: Array<number>; rank: number }
  >();

  placements.forEach((placement, index) => {
    const posterior = posteriors[index]?.[0];

    if (posterior === undefined) return;

    const entry = byCompetitor.get(placement.competitorId) ?? {
      mus: [],
      sigmas: [],
      rank: placement.rank,
    };

    entry.mus.push(posterior.mu);
    entry.sigmas.push(posterior.sigma);
    entry.rank = Math.min(entry.rank, placement.rank);
    byCompetitor.set(placement.competitorId, entry);
  });

  const mean = (values: ReadonlyArray<number>): number =>
    values.reduce((sum, value) => sum + value, 0) / values.length;

  return [...byCompetitor.entries()].map(([competitorId, entry]) => {
    const skill = { mu: mean(entry.mus), sigma: mean(entry.sigmas) };

    return {
      competitorId,
      ...skill,
      score: score(skill),
      rank: entry.rank,
      won: entry.rank === bestRank,
    };
  });
};
