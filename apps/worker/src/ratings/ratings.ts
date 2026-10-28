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

/** One seat of a finished game, as ratings read it. */
export interface RatedSeat {
  readonly competitorId: string;
  readonly label: string;
  readonly kind: "llm" | "bot";
  /** Null when the seat has no final rank. */
  readonly rank: number | null;
}

export interface RatedGame {
  readonly gameId: string;
  /** When the game finished: its place in the replay and its rating history entries. */
  readonly at: string;
  readonly seats: ReadonlyArray<RatedSeat>;
}

/** The rating table row of one competitor. */
export interface CompetitorRating extends Skill {
  readonly competitorId: string;
  readonly label: string;
  readonly kind: "llm" | "bot";
  readonly score: number;
  readonly games: number;
  readonly wins: number;
  readonly updatedAt: string;
}

export interface RatingHistoryEntry extends Skill {
  readonly competitorId: string;
  readonly gameId: string;
  readonly at: string;
  readonly score: number;
}

export interface RatingTable {
  readonly ratings: ReadonlyArray<CompetitorRating>;
  readonly history: ReadonlyArray<RatingHistoryEntry>;
}

/**
 * Public ratings count games of LLM seats only (SPEC §8): a game with a bot seat, or with fewer
 * than two ranked seats, leaves the table unchanged.
 */
export const isRatedGame = (seats: ReadonlyArray<RatedSeat>): boolean =>
  seats.every((seat) => seat.kind === "llm") &&
  seats.filter((seat) => seat.rank !== null).length >= 2;

/**
 * Rates `table` updated by one game: `rateGame` from the table's priors, games and wins counted.
 * The incremental update after a game and the replay after a deletion both use it.
 */
export const applyGame = (
  priors: ReadonlyMap<string, CompetitorRating>,
  game: RatedGame,
): ReadonlyArray<CompetitorRating> => {
  const placements = game.seats.flatMap((seat) =>
    seat.rank === null ? [] : [{ competitorId: seat.competitorId, rank: seat.rank }],
  );

  const identity = new Map(game.seats.map((seat) => [seat.competitorId, seat]));

  return rateGame(placements, priors).map((rated) => {
    const prior = priors.get(rated.competitorId);
    const seat = identity.get(rated.competitorId);

    return {
      competitorId: rated.competitorId,
      label: seat?.label ?? rated.competitorId,
      kind: seat?.kind ?? "llm",
      mu: rated.mu,
      sigma: rated.sigma,
      score: rated.score,
      games: (prior?.games ?? 0) + 1,
      wins: (prior?.wins ?? 0) + (rated.won ? 1 : 0),
      updatedAt: game.at,
    };
  });
};

/** Replays rated games in order from the default prior: the table they produce. */
export const replayRatings = (games: ReadonlyArray<RatedGame>): RatingTable => {
  const ratings = new Map<string, CompetitorRating>();
  const history: Array<RatingHistoryEntry> = [];

  for (const game of games) {
    if (!isRatedGame(game.seats)) continue;

    for (const rated of applyGame(ratings, game)) {
      ratings.set(rated.competitorId, rated);
      history.push({
        competitorId: rated.competitorId,
        gameId: game.gameId,
        at: game.at,
        mu: rated.mu,
        sigma: rated.sigma,
        score: rated.score,
      });
    }
  }

  return { ratings: [...ratings.values()], history };
};
