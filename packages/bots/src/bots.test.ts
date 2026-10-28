import { Predicate } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { playerView, requestOf } from "@mb/engine";
import {
  answerFor,
  build,
  own,
  play,
  rollFromTable,
  startGame,
  withDeeds,
  withPlayer,
} from "@mb/engine/testing";

import { createBot, heuristicBot, randomBot } from "./index.ts";

import type { Command, GameState, Seat } from "@mb/engine";

const decide = (bot: ReturnType<typeof createBot>, state: GameState, seat: Seat) => {
  const request = requestOf(state, seat);

  if (request === null) throw new Error(`no decision for ${seat}`);

  return bot(playerView(state, seat), request);
};

const kinds = (commands: ReadonlyArray<Command>) => commands.map((next) => next._tag);

describe("determinism", () => {
  it("returns the same commands for the same seed, view and request", () => {
    const state = rollFromTable(startGame(3), [1, 2]).state;

    for (const policy of ["random", "heuristic"] as const) {
      expect(decide(createBot(policy, "s1"), state, "A")).toEqual(
        decide(createBot(policy, "s1"), state, "A"),
      );
    }
  });

  it("always ends its answer with a terminal command", () => {
    const state = startGame(4);

    for (const seat of ["A", "B", "C", "D"] as const) {
      expect(kinds(decide(randomBot(`seed-${seat}`), state, seat)).at(-1)).toBe("Done");
    }
  });
});

describe("heuristic buying and bidding", () => {
  it("buys when it keeps its reserve and declines otherwise", () => {
    const rich = rollFromTable(startGame(2), [1, 2]).state;
    const poor = rollFromTable(withPlayer(startGame(2), "A", { cash: 100 }), [1, 2]).state;

    expect(kinds(decide(heuristicBot("h"), rich, "A"))).toEqual(["Buy"]);
    expect(kinds(decide(heuristicBot("h"), poor, "A"))).toEqual(["Decline"]);
  });

  it("mortgages to buy the deed that completes its set", () => {
    const owner = own(withPlayer(startGame(2), "A", { cash: 40 }), "A", [
      "mediterranean-avenue",
      "boardwalk",
    ]);

    const choice = rollFromTable(owner, [1, 2]).state;

    expect(kinds(decide(heuristicBot("h"), choice, "A"))).toEqual(["Mortgage", "Buy"]);
  });

  it("bids in auctions up to a value-based cap", () => {
    const choice = rollFromTable(startGame(2), [1, 2]).state;
    const auction = play(choice, answerFor(choice, "A", "Decline", {})).state;
    const [bid] = decide(heuristicBot("h"), auction, "B");

    expect(bid?._tag).toBe("Bid");
    expect(bid !== undefined && "amount" in bid ? bid.amount : 0).toBeLessThanOrEqual(60 * 1.3);
  });
});

describe("heuristic building and raising funds", () => {
  it("builds evenly on its monopolies", () => {
    const set = own(startGame(2), "A", ["oriental-avenue", "vermont-avenue", "connecticut-avenue"]);

    const builds = decide(heuristicBot("h"), set, "A").flatMap((next) =>
      Predicate.isTagged(next, "Build") ? [next.property] : [],
    );

    const counts = new Map<string, number>();

    for (const id of builds) counts.set(id, (counts.get(id) ?? 0) + 1);

    expect(builds.length).toBeGreaterThan(2);
    expect(Math.max(...counts.values()) - Math.min(...counts.values())).toBeLessThanOrEqual(1);
  });

  it("mortgages its cheapest deeds first when raising funds", () => {
    const debtor = own(withPlayer(startGame(2), "A", { cash: 10, position: 36 }), "A", [
      "pacific-avenue",
      "mediterranean-avenue",
    ]);

    const debt = rollFromTable(own(debtor, "B", ["boardwalk"]), [1, 2]).state;
    const answer = decide(heuristicBot("h"), debt, "A");

    expect(answer[0]?._tag).toBe("Mortgage");
    expect(answer[0] !== undefined && "property" in answer[0] ? answer[0].property : null).toBe(
      "mediterranean-avenue",
    );
    expect(answer.at(-1)?._tag).toBe("Done");
  });
});

describe("heuristic trading", () => {
  /** B owns two oranges, A the third; a round of table, then B's view of A's offer. */
  const offered = (cash: number) => {
    const base = own(own(startGame(3), "B", ["st-james-place", "tennessee-avenue"]), "A", [
      "new-york-avenue",
    ]);

    const posted = play(
      base,
      answerFor(base, "B", "Offer", {
        to: "A",
        give: { cash, properties: [], jailCards: 0 },
        get: { cash: 0, properties: ["new-york-avenue"], jailCards: 0 },
      }),
      answerFor(base, "A", "Done", {}),
      answerFor(base, "B", "Done", {}),
      answerFor(base, "C", "Done", {}),
    ).state;

    return decide(heuristicBot("h"), posted, "A");
  };

  it("rejects a cheap offer that would complete an opponent's set", () => {
    expect(kinds(offered(210))).toEqual(["Reject", "Done"]);
  });

  it("accepts a generous one", () => {
    expect(kinds(offered(900))).toEqual(["Accept", "Done"]);
  });

  it("proposes to buy the deed that completes its own set", () => {
    const base = own(
      own(withPlayer(startGame(3), "A", { cash: 3000 }), "A", [
        "st-james-place",
        "tennessee-avenue",
      ]),
      "B",
      ["new-york-avenue"],
    );

    const offers = Array.from({ length: 12 }, (_, index) =>
      heuristicBot(`trade-${index}`)(playerView(base, "A"), requestOf(base, "A") ?? never()),
    ).flatMap((answer) => answer.filter((next) => Predicate.isTagged(next, "Offer")));

    expect(offers.length).toBeGreaterThan(0);
  });

  it("does not trade deeds whose set has buildings", () => {
    const built = build(own(startGame(2), "A", ["mediterranean-avenue", "baltic-avenue"]), [
      ["mediterranean-avenue", 1],
    ]);

    expect(kinds(decide(heuristicBot("h"), withDeeds(built, [], {}), "A"))).not.toContain("Offer");
  });
});

const never = (): never => {
  throw new Error("expected a pending request");
};
