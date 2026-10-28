import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_SKILL, rateGame, score } from "./ratings.ts";

describe("ratings", () => {
  it("starts from mu 25, sigma 25/3 and scores mu − 3σ", () => {
    expect(DEFAULT_SKILL.mu).toBeCloseTo(25);
    expect(DEFAULT_SKILL.sigma).toBeCloseTo(25 / 3);
    expect(score({ mu: 30, sigma: 2 })).toBe(24);
  });

  it("moves the winner up and the last place down (Plackett–Luce)", () => {
    const rated = rateGame(
      [
        { competitorId: "a", rank: 1 },
        { competitorId: "b", rank: 2 },
        { competitorId: "c", rank: 3 },
        { competitorId: "d", rank: 4 },
      ],
      new Map(),
    );

    const byId = new Map(rated.map((entry) => [entry.competitorId, entry]));

    expect((byId.get("a")?.mu ?? 0) > DEFAULT_SKILL.mu).toBe(true);
    expect((byId.get("d")?.mu ?? 99) < DEFAULT_SKILL.mu).toBe(true);
    expect((byId.get("a")?.mu ?? 0) > (byId.get("b")?.mu ?? 0)).toBe(true);
    expect(rated.every((entry) => entry.sigma < DEFAULT_SKILL.sigma)).toBe(true);
    expect(rated.every((entry) => entry.score === entry.mu - 3 * entry.sigma)).toBe(true);
    expect(byId.get("a")?.won).toBe(true);
    expect(byId.get("b")?.won).toBe(false);
  });

  it("uses priors: beating a strong player is worth more", () => {
    const strong = new Map([["b", { mu: 35, sigma: 3 }]]);

    const upset = rateGame(
      [
        { competitorId: "a", rank: 1 },
        { competitorId: "b", rank: 2 },
      ],
      strong,
    );

    const even = rateGame(
      [
        { competitorId: "a", rank: 1 },
        { competitorId: "b", rank: 2 },
      ],
      new Map(),
    );

    expect(upset[0]?.mu ?? 0).toBeGreaterThan(even[0]?.mu ?? 0);
  });

  it("averages a competitor holding several seats", () => {
    const rated = rateGame(
      [
        { competitorId: "bot", rank: 1 },
        { competitorId: "llm", rank: 2 },
        { competitorId: "bot", rank: 3 },
      ],
      new Map(),
    );

    expect(rated).toHaveLength(2);

    const bot = rated.find((entry) => entry.competitorId === "bot");

    expect(bot?.rank).toBe(1);
    expect(bot?.won).toBe(true);
  });

  it("does not rate games with fewer than two placements", () => {
    expect(rateGame([{ competitorId: "a", rank: 1 }], new Map())).toEqual([]);
  });
});
