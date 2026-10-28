import { describe, expect, it } from "vite-plus/test";

import { CHANCE_CARDS, COMMUNITY_CHEST_CARDS } from "./data/cards.ts";
import { PROPERTIES, SPACES, propertyInfo } from "./data/board.ts";
import {
  buildProblem,
  liquidationValue,
  mortgageInterest,
  mortgageProblem,
  netWorth,
  rentFor,
  sellChanges,
  sellProblem,
  unmortgageCost,
} from "./rules.ts";
import { build, own, startGame, withDeeds, withPlayer } from "./testing.ts";

describe("board and decks", () => {
  it("has 40 spaces, 28 deeds and the printed prices", () => {
    expect(SPACES).toHaveLength(40);
    expect(PROPERTIES).toHaveLength(28);
    expect(propertyInfo("boardwalk").rents).toEqual([50, 200, 600, 1400, 1700, 2000]);
    expect(propertyInfo("mediterranean-avenue").mortgage).toBe(30);
    expect(propertyInfo("illinois-avenue").houseCost).toBe(150);
    expect(SPACES[4]?.name).toBe("Income Tax");
    expect(SPACES[38]?.name).toBe("Luxury Tax");
  });

  it("has 16 Chance and 16 Community Chest cards with the 2021 texts", () => {
    expect(CHANCE_CARDS).toHaveLength(16);
    expect(COMMUNITY_CHEST_CARDS).toHaveLength(16);
    expect(COMMUNITY_CHEST_CARDS[4]?.text).toContain("You rescue a puppy");
    expect(COMMUNITY_CHEST_CARDS[14]?.text).toContain("PAY $40");
  });
});

describe("rent", () => {
  const base = own(startGame(2), "B", ["st-james-place", "tennessee-avenue"]);

  it("charges the base rent on a lone street", () => {
    expect(rentFor(base, "st-james-place", 7, "none")).toBe(14);
  });

  it("doubles unimproved streets of a complete set, also with a mortgaged sibling", () => {
    const set = own(base, "B", ["new-york-avenue"]);
    const mortgagedSibling = withDeeds(set, ["new-york-avenue"], { mortgaged: true });

    expect(rentFor(set, "st-james-place", 7, "none")).toBe(28);
    expect(rentFor(mortgagedSibling, "st-james-place", 7, "none")).toBe(28);
    expect(rentFor(mortgagedSibling, "new-york-avenue", 7, "none")).toBe(0);
  });

  it("uses the title deed with houses and hotels", () => {
    const set = build(own(base, "B", ["new-york-avenue"]), [
      ["st-james-place", 3],
      ["tennessee-avenue", 3],
      ["new-york-avenue", 5],
    ]);

    expect(rentFor(set, "st-james-place", 7, "none")).toBe(550);
    expect(rentFor(set, "new-york-avenue", 7, "none")).toBe(1000);
  });

  it("charges railroads 25/50/100/200 and twice that from the card", () => {
    const one = own(startGame(2), "B", ["reading-railroad"]);
    const four = own(one, "B", ["pennsylvania-railroad", "b-and-o-railroad", "short-line"]);

    expect(rentFor(one, "reading-railroad", 4, "none")).toBe(25);
    expect(rentFor(own(one, "B", ["short-line"]), "reading-railroad", 4, "none")).toBe(50);
    expect(rentFor(four, "short-line", 4, "none")).toBe(200);
    expect(rentFor(four, "short-line", 4, "railroadTwice")).toBe(400);
  });

  it("charges utilities 4× or 10× the dice, and 10× from the card", () => {
    const one = own(startGame(2), "B", ["electric-company"]);
    const both = own(one, "B", ["water-works"]);

    expect(rentFor(one, "electric-company", 9, "none")).toBe(36);
    expect(rentFor(both, "electric-company", 9, "none")).toBe(90);
    expect(rentFor(one, "electric-company", 9, "utilityTenTimes")).toBe(90);
  });
});

describe("mortgages", () => {
  it("unmortgages for the mortgage value plus 10% rounded up", () => {
    expect(unmortgageCost("mediterranean-avenue")).toBe(33);
    expect(unmortgageCost("electric-company")).toBe(83);
    expect(unmortgageCost("park-place")).toBe(193);
    expect(mortgageInterest("electric-company")).toBe(8);
    expect(mortgageInterest("boardwalk")).toBe(20);
  });

  it("refuses to mortgage a street while its set has buildings", () => {
    const state = build(own(startGame(2), "A", ["mediterranean-avenue", "baltic-avenue"]), [
      ["baltic-avenue", 1],
    ]);

    expect(mortgageProblem(state, "A", "mediterranean-avenue")).toContain("sell the buildings");
  });
});

describe("building and selling evenly", () => {
  const set = own(startGame(2), "A", ["oriental-avenue", "vermont-avenue", "connecticut-avenue"]);

  it("needs the whole set, unmortgaged", () => {
    const partial = withDeeds(set, ["vermont-avenue"], { owner: "B" });
    const mortgaged = withDeeds(set, ["vermont-avenue"], { mortgaged: true });

    expect(buildProblem(partial, "A", "oriental-avenue")).toContain("whole color set");
    expect(buildProblem(mortgaged, "A", "oriental-avenue")).toContain("mortgaged");
    expect(buildProblem(set, "A", "oriental-avenue")).toBeNull();
  });

  it("builds and sells evenly", () => {
    const one = build(set, [["oriental-avenue", 1]]);

    expect(buildProblem(one, "A", "oriental-avenue")).toContain("evenly");
    expect(buildProblem(one, "A", "vermont-avenue")).toBeNull();
    expect(sellProblem(one, "A", "vermont-avenue")).toContain("no buildings");

    const two = build(one, [
      ["vermont-avenue", 1],
      ["connecticut-avenue", 1],
      ["oriental-avenue", 2],
    ]);

    expect(sellProblem(two, "A", "vermont-avenue")).toContain("evenly");
    expect(sellProblem(two, "A", "oriental-avenue")).toBeNull();
  });

  it("needs houses and hotels in the bank", () => {
    const noHouses = { ...set, bank: { houses: 0, hotels: 12 } };

    const atFour = build(set, [
      ["oriental-avenue", 4],
      ["vermont-avenue", 4],
      ["connecticut-avenue", 4],
    ]);

    expect(buildProblem(noHouses, "A", "oriental-avenue")).toContain("no houses");
    expect(
      buildProblem({ ...atFour, bank: { ...atFour.bank, hotels: 0 } }, "A", "oriental-avenue"),
    ).toContain("no hotels");
  });

  it("sells a hotel back to 4 houses when the bank has them", () => {
    const hotels = build(set, [
      ["oriental-avenue", 5],
      ["vermont-avenue", 5],
      ["connecticut-avenue", 5],
    ]);

    expect(sellChanges(hotels, "oriental-avenue")).toEqual([
      { property: "oriental-avenue", from: 5, to: 4, proceeds: 25 },
    ]);
  });

  it("drops a hotel to the houses the bank can supply and evens the siblings", () => {
    const hotels = build(set, [
      ["oriental-avenue", 5],
      ["vermont-avenue", 5],
      ["connecticut-avenue", 5],
    ]);

    const shortage = { ...hotels, bank: { houses: 1, hotels: hotels.bank.hotels } };
    const changes = sellChanges(shortage, "oriental-avenue");
    const proceeds = changes.reduce((total, change) => total + change.proceeds, 0);
    const removed = changes.reduce((total, change) => total + change.from - change.to, 0);

    expect(changes[0]).toEqual({ property: "oriental-avenue", from: 5, to: 1, proceeds: 100 });
    expect(proceeds).toBe(removed * 25);

    const final = new Map<string, number>([
      ["oriental-avenue", 5],
      ["vermont-avenue", 5],
      ["connecticut-avenue", 5],
    ]);

    for (const change of changes) final.set(change.property, change.to);

    const levels = [...final.values()];

    expect(Math.max(...levels) - Math.min(...levels)).toBeLessThanOrEqual(1);
  });
});

describe("valuations", () => {
  it("values net worth as cash + printed prices + mortgage values + buildings at cost", () => {
    const state = build(
      withDeeds(
        own(withPlayer(startGame(2), "A", { cash: 100 }), "A", [
          "mediterranean-avenue",
          "baltic-avenue",
          "boardwalk",
        ]),
        ["boardwalk"],
        { mortgaged: true },
      ),
      [
        ["mediterranean-avenue", 5],
        ["baltic-avenue", 4],
      ],
    );

    // 100 cash + 60 + 60 printed + 200 mortgage value + (5 + 4) × $50 buildings.
    expect(netWorth(state, "A")).toBe(100 + 60 + 60 + 200 + 450);
    // Liquidation: 100 + 30 + 30 mortgages + half of 9 × $50.
    expect(liquidationValue(state, "A")).toBe(100 + 30 + 30 + 225);
  });
});
