import { Predicate } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { jailCardIndex } from "./data/cards.ts";
import { standings } from "./standings.ts";
import {
  answerFor,
  build,
  cash,
  eventsOf,
  onlyAtTable,
  own,
  ownerOf,
  play,
  rejection,
  rollFromTable,
  startGame,
  tags,
  testConfig,
  topCard,
  topKind,
  withDice,
  withPlayer,
} from "./testing.ts";
import { newGame } from "./game.ts";
import { defaultCommand } from "./defaults.ts";
import { pendingSeats } from "./pending.ts";
import { command } from "./schema/commands.ts";

import type { GameState } from "./schema/state.ts";

const player = (state: GameState, seat: "A" | "B" | "C") => {
  const found = state.players.find((current) => current.seat === seat);

  if (found === undefined) throw new Error(`no seat ${seat}`);

  return found;
};

/** `[debtor, creditor, amount]` of the RaiseFunds frame on top, or null. */
const debtOf = (state: GameState) => {
  const frame = state.control.stack.at(-1);

  return frame !== undefined && Predicate.isTagged(frame, "RaiseFunds")
    ? [frame.debtor, frame.creditor, frame.amount]
    : null;
};

describe("turn flow", () => {
  it("opens the table for everyone before the first roll", () => {
    const state = startGame(3);

    expect(topKind(state)).toBe("Table");
    expect(state.control.turn).toBe(1);
    expect(state.control.activeSeat).toBe("A");
  });

  it("rolls, moves and offers an unowned deed", () => {
    const { state, events } = rollFromTable(startGame(2), [1, 2]);

    expect(tags(events)).toContain("DiceRolled");
    expect(player(state, "A").position).toBe(3);
    expect(topKind(state)).toBe("BuyChoice");
  });

  it("collects the GO salary when passing GO", () => {
    const at38 = withPlayer(startGame(2), "A", { position: 35 });
    const { state, events } = rollFromTable(at38, [3, 4]);

    expect(player(state, "A").position).toBe(2);
    expect(eventsOf(events, "Paid").some((paid) => paid.reason === "salary")).toBe(true);
  });

  it("rolls again after doubles, without reopening the table", () => {
    const { state, events } = rollFromTable(startGame(2), [2, 2], [3, 4]);

    expect(tags(events)).toContain("RolledAgain");
    expect(eventsOf(events, "DiceRolled")).toHaveLength(2);
    expect(player(state, "A").position).toBe(11);
    expect(cash(state, "A")).toBe(1300);
  });

  it("sends the player to jail on the third consecutive doubles", () => {
    const { state, events } = rollFromTable(startGame(2), [2, 2], [3, 3], [4, 4]);

    expect(eventsOf(events, "SentToJail")[0]?.reason).toBe("threeDoubles");
    expect(player(state, "A").inJail).toBe(true);
    expect(player(state, "A").position).toBe(10);
    expect(state.control.activeSeat).toBe("B");
  });

  it("sends the player to jail from the Go To Jail space without salary", () => {
    const { state, events } = rollFromTable(
      withPlayer(startGame(2), "A", { position: 25 }),
      [2, 3],
    );

    expect(player(state, "A").position).toBe(10);
    expect(player(state, "A").inJail).toBe(true);
    expect(eventsOf(events, "Paid")).toHaveLength(0);
  });
});

describe("jail", () => {
  const jailed = (attempts = 0, extra: Partial<GameState["players"][number]> = {}) =>
    withPlayer(startGame(2), "A", { position: 10, inJail: true, jailAttempts: attempts, ...extra });

  const atChoice = (state: GameState, ...rolls: ReadonlyArray<readonly [number, number]>) => {
    const ready = withDice(onlyAtTable(state, "A"), ...rolls);

    return play(ready, answerFor(ready, "A", "Done", {})).state;
  };

  it("asks the jailed player to choose before rolling", () => {
    expect(topKind(atChoice(jailed(), [1, 2]))).toBe("JailChoice");
  });

  it("pays the fine, then rolls and moves", () => {
    const choice = atChoice(jailed(), [1, 2]);
    const { state, events } = play(choice, answerFor(choice, "A", "PayJailFine", {}));

    expect(eventsOf(events, "LeftJail")[0]?.via).toBe("fine");
    expect(cash(state, "A")).toBe(1450);
    expect(player(state, "A").position).toBe(13);
  });

  it("uses a Get Out of Jail Free card, which returns to the bottom of its deck", () => {
    const base = jailed(0, { jailCards: ["chance"] });

    const withoutCard = {
      ...base,
      decks: {
        ...base.decks,
        chance: base.decks.chance.filter((card) => card !== jailCardIndex("chance")),
      },
    };

    const choice = atChoice(withoutCard, [1, 2]);
    const { state } = play(choice, answerFor(choice, "A", "UseJailCard", {}));

    expect(player(state, "A").jailCards).toEqual([]);
    expect(state.decks.chance.at(-1)).toBe(jailCardIndex("chance"));
    expect(player(state, "A").position).toBe(13);
  });

  it("leaves on doubles and moves with that roll, without an extra roll", () => {
    const choice = atChoice(own(jailed(), "B", ["virginia-avenue"]), [2, 2]);
    const { state, events } = play(choice, answerFor(choice, "A", "RollForDoubles", {}));

    expect(eventsOf(events, "LeftJail")[0]?.via).toBe("doubles");
    expect(player(state, "A").position).toBe(14);
    expect(tags(events)).not.toContain("RolledAgain");
    expect(state.control.activeSeat).toBe("B");
  });

  it("stays after a failed attempt", () => {
    const choice = atChoice(jailed(), [1, 2]);
    const { state } = play(choice, answerFor(choice, "A", "RollForDoubles", {}));

    expect(player(state, "A").inJail).toBe(true);
    expect(player(state, "A").jailAttempts).toBe(1);
    expect(state.control.activeSeat).toBe("B");
  });

  it("forces the fine after the third failed attempt and moves with that roll", () => {
    const choice = atChoice(jailed(2), [1, 2]);
    const { state, events } = play(choice, answerFor(choice, "A", "RollForDoubles", {}));

    expect(eventsOf(events, "LeftJail")[0]?.via).toBe("forcedFine");
    expect(cash(state, "A")).toBe(1450);
    expect(player(state, "A").position).toBe(13);
    expect(player(state, "A").inJail).toBe(false);
  });

  it("refuses the fine without the cash", () => {
    const choice = atChoice(jailed(0, { cash: 20 }), [1, 2]);

    expect(rejection(choice, answerFor(choice, "A", "PayJailFine", {}))).toContain(
      "not enough cash",
    );
  });
});

describe("cards", () => {
  const drawChance = (card: number, state = startGame(3)) =>
    rollFromTable(topCard(state, "chance", card), [3, 4]);

  const drawChest = (card: number, state = startGame(3)) =>
    rollFromTable(
      topCard(withPlayer(state, "A", { position: 10 }), "communityChest", card),
      [3, 4],
    );

  it("advances to Boardwalk, GO, Illinois Avenue and St. Charles Place", () => {
    expect(player(drawChance(0).state, "A").position).toBe(39);
    expect(cash(drawChance(1).state, "A")).toBe(1700);
    expect(player(drawChance(2).state, "A").position).toBe(24);
    expect(player(drawChance(3).state, "A").position).toBe(11);
  });

  it("takes a trip to Reading Railroad, collecting $200 when passing GO", () => {
    const { state } = drawChance(13);

    expect(player(state, "A").position).toBe(5);
    expect(cash(state, "A")).toBe(1700);
  });

  it("advances to the nearest railroad and pays twice the rent", () => {
    const { state } = drawChance(4, own(startGame(3), "B", ["pennsylvania-railroad"]));

    expect(player(state, "A").position).toBe(15);
    expect(cash(state, "A")).toBe(1450);
    expect(cash(state, "B")).toBe(1550);
  });

  it("advances to the nearest utility and pays ten times a fresh roll", () => {
    const owned = topCard(own(startGame(3), "B", ["electric-company"]), "chance", 6);
    const { state, events } = rollFromTable(owned, [3, 4], [5, 6]);

    expect(eventsOf(events, "DiceRolled").at(-1)?.purpose).toBe("utility");
    expect(player(state, "A").position).toBe(12);
    expect(cash(state, "A")).toBe(1500 - 110);
  });

  it("pays dividends, loans and fines", () => {
    expect(cash(drawChance(7).state, "A")).toBe(1550);
    expect(cash(drawChance(15).state, "A")).toBe(1650);
    expect(cash(drawChance(12).state, "A")).toBe(1485);
  });

  it("keeps Get Out of Jail Free until used", () => {
    const { state } = drawChance(8);

    expect(player(state, "A").jailCards).toEqual(["chance"]);
    expect(state.decks.chance).toHaveLength(15);
  });

  it("goes back 3 spaces onto Income Tax", () => {
    const { state } = drawChance(9);

    expect(player(state, "A").position).toBe(4);
    expect(cash(state, "A")).toBe(1300);
  });

  it("goes back 3 spaces onto Community Chest and draws again", () => {
    const from36 = topCard(withPlayer(startGame(3), "A", { position: 29 }), "chance", 9);
    const { events } = rollFromTable(topCard(from36, "communityChest", 7), [3, 4]);
    const draws = eventsOf(events, "CardDrawn");

    expect(draws.map((draw) => draw.deck)).toEqual(["chance", "communityChest"]);
  });

  it("goes to jail", () => {
    const { state } = drawChance(10);

    expect(player(state, "A").inJail).toBe(true);
    expect(player(state, "A").position).toBe(10);
  });

  it("charges general repairs per house and hotel", () => {
    const owner = build(own(startGame(3), "A", ["mediterranean-avenue", "baltic-avenue"]), [
      ["mediterranean-avenue", 4],
      ["baltic-avenue", 5],
    ]);

    expect(cash(drawChance(11, owner).state, "A")).toBe(1500 - (4 * 25 + 100));
    expect(cash(drawChest(14, owner).state, "A")).toBe(1500 - (4 * 40 + 115));
  });

  it("pays each player $50 as one debt per pair, in turn order", () => {
    const poor = own(withPlayer(startGame(3), "A", { cash: 60 }), "A", ["mediterranean-avenue"]);
    const { state } = drawChance(14, poor);

    expect(cash(state, "B")).toBe(1550);
    expect(topKind(state)).toBe("RaiseFunds");
    expect(debtOf(state)).toEqual(["A", "C", 50]);
  });

  it("collects $10 from each player at the street party", () => {
    const { state } = drawChest(5);

    expect(cash(state, "A")).toBe(1520);
    expect(cash(state, "B")).toBe(1490);
    expect(cash(state, "C")).toBe(1490);
  });

  it("applies the Community Chest money cards and Advance to GO", () => {
    expect(cash(drawChest(0).state, "A")).toBe(1600);
    expect(cash(drawChest(3).state, "A")).toBe(1450);
    expect(cash(drawChest(10).state, "A")).toBe(1400);
    expect(cash(drawChest(12).state, "A")).toBe(1700);
    expect(cash(drawChest(15).state, "A")).toBe(1525);
    expect(player(drawChest(11).state, "A").position).toBe(0);
    expect(cash(drawChest(11).state, "A")).toBe(1700);
    expect(player(drawChest(6).state, "A").inJail).toBe(true);
  });

  it("puts used cards at the bottom of the deck", () => {
    const { state } = drawChance(7);

    expect(state.decks.chance.at(-1)).toBe(7);
  });
});

describe("buying and auctions", () => {
  const atBaltic = () => rollFromTable(startGame(2), [1, 2]).state;

  it("buys at list price", () => {
    const choice = atBaltic();
    const { state } = play(choice, answerFor(choice, "A", "Buy", {}));

    expect(ownerOf(state, "baltic-avenue")).toBe("A");
    expect(cash(state, "A")).toBe(1440);
  });

  it("auctions a declined deed; the decliner may bid; highest bid wins", () => {
    const choice = atBaltic();
    const auction = play(choice, answerFor(choice, "A", "Decline", {})).state;

    expect(topKind(auction)).toBe("Auction");

    const round2 = play(
      auction,
      answerFor(auction, "A", "Bid", { amount: 20 }),
      answerFor(auction, "B", "Bid", { amount: 30 }),
    ).state;

    expect(round2.control.stack.at(-1)?._tag).toBe("Auction");

    const { state, events } = play(round2, answerFor(round2, "A", "PassBid", {}));

    expect(eventsOf(events, "AuctionEnded")[0]?.winner).toBe("B");
    expect(ownerOf(state, "baltic-avenue")).toBe("B");
    expect(cash(state, "B")).toBe(1470);
  });

  it("breaks ties by fixed order from the active player", () => {
    const choice = atBaltic();
    const auction = play(choice, answerFor(choice, "A", "Decline", {})).state;

    const { events } = play(
      auction,
      answerFor(auction, "A", "Bid", { amount: 25 }),
      answerFor(auction, "B", "Bid", { amount: 25 }),
    );

    expect(eventsOf(events, "AuctionRoundClosed")[0]?.high?.seat).toBe("A");
  });

  it("keeps the deed with the bank when nobody bids", () => {
    const choice = atBaltic();
    const auction = play(choice, answerFor(choice, "A", "Decline", {})).state;

    const { state } = play(
      auction,
      answerFor(auction, "A", "PassBid", {}),
      answerFor(auction, "B", "PassBid", {}),
    );

    expect(ownerOf(state, "baltic-avenue")).toBeNull();
  });

  it("enforces the opening bid, the raise and the liquidation value", () => {
    const choice = atBaltic();
    const auction = play(choice, answerFor(choice, "A", "Decline", {})).state;

    expect(rejection(auction, answerFor(auction, "A", "Bid", { amount: 5 }))).toContain("minimum");
    expect(rejection(auction, answerFor(auction, "A", "Bid", { amount: 5000 }))).toContain(
      "at most",
    );
  });

  it("puts a winner short of cash into debt with the bank", () => {
    const poorB = own(withPlayer(startGame(2), "B", { cash: 20 }), "B", ["boardwalk"]);
    const choice = rollFromTable(poorB, [1, 2]).state;
    const auction = play(choice, answerFor(choice, "A", "Decline", {})).state;

    const { state } = play(
      auction,
      answerFor(auction, "A", "PassBid", {}),
      answerFor(auction, "B", "Bid", { amount: 150 }),
    );

    expect(ownerOf(state, "baltic-avenue")).toBe("B");
    expect(debtOf(state)).toEqual(["B", "bank", 150]);
  });
});

describe("turn cap", () => {
  it("ends after maxRounds full rounds and ranks by net worth, then cash, then seat", () => {
    let state = newGame(testConfig(2, { maxRounds: 1 })).state;

    for (let guard = 0; guard < 200 && state.status === "playing"; guard += 1) {
      const seat = pendingSeats(state)[0];
      const next = seat === undefined ? null : defaultCommand(state, seat);

      if (next === null) break;

      state = play(state, next).state;
    }

    expect(state.status).toBe("finished");
    expect(state.control.gameRound).toBe(1);
    expect(state.endReason).toBe("turnCap");

    const table = standings(state);

    expect(table.map((row) => row.rank)).toEqual([1, 2]);
    expect(table[0]?.netWorth ?? 0).toBeGreaterThanOrEqual(table[1]?.netWorth ?? 0);
  });

  it("breaks net worth ties by cash, then seat order", () => {
    const base = startGame(3);
    const tied = own(withPlayer(base, "B", { cash: 1440 }), "B", ["baltic-avenue"]);
    const table = standings(tied);

    expect(table.map((row) => row.seat)).toEqual(["A", "C", "B"]);
  });
});

describe("decisions", () => {
  it("rejects stale or foreign decision ids without events", () => {
    const state = startGame(2);
    const done = answerFor(state, "A", "Done", {});

    expect(rejection(state, { ...done, decisionId: "0.1.A" })).toContain("no pending decision");
    expect(rejection(state, { ...done, seat: "B" })).toContain("no pending decision");
  });

  it("applies defaults on timeout: decline then auction", () => {
    const choice = rollFromTable(startGame(2), [1, 2]).state;
    const { state, events } = play(choice, answerFor(choice, "A", "TimeoutSeat", {}));

    expect(tags(events)).toContain("SeatTimedOut");
    expect(tags(events)).toContain("PurchaseDeclined");
    expect(topKind(state)).toBe("Auction");
  });

  it("aborts on request", () => {
    const state = startGame(2);
    const { state: ended } = play(state, command("AbortGame", { reason: "test" }));

    expect(ended.endReason).toBe("aborted");
  });
});
