import { Predicate } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { autoLiquidate } from "./defaults.ts";
import {
  answerFor,
  build,
  cash,
  eventsOf,
  own,
  ownerOf,
  play,
  rejection,
  rollFromTable,
  startGame,
  tags,
  topKind,
  withDeeds,
  withDice,
  withPlayer,
} from "./testing.ts";

import type { GameState } from "./schema/state.ts";

const debtOf = (state: GameState) => {
  const frame = state.control.stack.at(-1);

  return frame !== undefined && Predicate.isTagged(frame, "RaiseFunds")
    ? [frame.debtor, frame.creditor, frame.amount]
    : null;
};

const isBankrupt = (state: GameState, seat: "A" | "B" | "C") =>
  state.players.find((current) => current.seat === seat)?.bankrupt ?? false;

/** A (cash `money`, owning `deeds`) at 36 rolls 1+2 onto Boardwalk owned by B. */
const onBoardwalk = (
  players: number,
  money: number,
  deeds: ReadonlyArray<"mediterranean-avenue" | "baltic-avenue">,
  hotel = false,
) => {
  const base = own(withPlayer(startGame(players), "A", { cash: money, position: 36 }), "A", deeds);

  const owned = hotel
    ? build(own(base, "B", ["park-place", "boardwalk"]), [
        ["park-place", 5],
        ["boardwalk", 5],
      ])
    : own(base, "B", ["boardwalk"]);

  return rollFromTable(owned, [1, 2]).state;
};

describe("debts", () => {
  it("opens RaiseFunds when the rent exceeds the cash; drafts raise it and the engine pays", () => {
    const debt = onBoardwalk(2, 10, ["mediterranean-avenue", "baltic-avenue"]);

    expect(debtOf(debt)).toEqual(["A", "B", 50]);

    const { state } = play(
      withDice(debt, [1, 2]),
      answerFor(debt, "A", "Mortgage", { property: "mediterranean-avenue" }),
      answerFor(debt, "A", "Mortgage", { property: "baltic-avenue" }),
      answerFor(debt, "A", "Done", {}),
    );

    expect(cash(state, "A")).toBe(10 + 60 - 50);
    expect(cash(state, "B")).toBe(1550);
  });

  it("liquidates automatically when the debtor ends its round with assets left", () => {
    const debt = onBoardwalk(2, 10, ["mediterranean-avenue", "baltic-avenue"]);

    expect(autoLiquidate(debt, "A", 50).map((step) => step.property)).toEqual([
      "mediterranean-avenue",
      "baltic-avenue",
    ]);

    const { state, events } = play(withDice(debt, [1, 2]), answerFor(debt, "A", "Done", {}));

    expect(eventsOf(events, "PropertyMortgaged")).toHaveLength(2);
    expect(cash(state, "B")).toBe(1550);
    expect(isBankrupt(state, "A")).toBe(false);
  });

  it("only allows declaring bankruptcy when the bank could not cover the debt", () => {
    const debt = onBoardwalk(2, 10, ["mediterranean-avenue", "baltic-avenue"]);

    expect(rejection(debt, answerFor(debt, "A", "DeclareBankruptcy", {}))).toContain("still raise");
  });

  it("on timeout liquidates the debtor", () => {
    const debt = onBoardwalk(2, 10, ["mediterranean-avenue", "baltic-avenue"]);
    const { state } = play(withDice(debt, [1, 2]), answerFor(debt, "A", "TimeoutSeat", {}));

    expect(cash(state, "B")).toBe(1550);
  });
});

describe("bankruptcy", () => {
  it("to a player: buildings sold to the bank, everything else to the creditor", () => {
    const poor = build(
      own(
        withPlayer(startGame(3), "A", { cash: 10, position: 36, jailCards: ["communityChest"] }),
        "A",
        ["mediterranean-avenue", "baltic-avenue"],
      ),
      [
        ["mediterranean-avenue", 2],
        ["baltic-avenue", 2],
      ],
    );

    const decks = {
      ...poor.decks,
      communityChest: poor.decks.communityChest.filter((card) => card !== 4),
    };

    const owed = build(own({ ...poor, decks }, "B", ["park-place", "boardwalk"]), [
      ["park-place", 5],
      ["boardwalk", 5],
    ]);

    const debt = rollFromTable(owed, [1, 2]).state;

    expect(debtOf(debt)).toEqual(["A", "B", 2000]);

    const { state, events } = play(debt, answerFor(debt, "A", "DeclareBankruptcy", {}));
    const transfer = eventsOf(events, "AssetsTransferred")[0];

    expect(tags(events)).toContain("BuildingSold");
    expect(transfer?.cash).toBe(10 + 4 * 25);
    expect(transfer?.jailCards).toEqual(["communityChest"]);
    expect(ownerOf(state, "baltic-avenue")).toBe("B");
    expect(isBankrupt(state, "A")).toBe(true);
    expect(state.status).toBe("playing");
  });

  it("to a player with mortgaged deeds: the creditor keeps them for 10% or pays them off", () => {
    const poor = withDeeds(
      own(withPlayer(startGame(3), "A", { cash: 10, position: 36 }), "A", ["mediterranean-avenue"]),
      ["mediterranean-avenue"],
      { mortgaged: true },
    );

    const owed = build(own(poor, "B", ["park-place", "boardwalk"]), [
      ["park-place", 5],
      ["boardwalk", 5],
    ]);

    const debt = rollFromTable(owed, [1, 2]).state;
    const declared = play(debt, answerFor(debt, "A", "DeclareBankruptcy", {})).state;

    expect(topKind(declared)).toBe("MortgagedTransfer");

    const { events } = play(
      withDice(declared, [1, 2]),
      answerFor(declared, "B", "KeepMortgage", { property: "mediterranean-avenue" }),
    );

    expect(
      eventsOf(events, "Paid").find((paid) => paid.reason === "mortgageInterest")?.amount,
    ).toBe(3);
  });

  it("to the bank: mortgages cancelled, deeds auctioned one at a time in board order", () => {
    const poor = withDeeds(
      own(withPlayer(startGame(3), "A", { cash: 10, position: 1 }), "A", [
        "oriental-avenue",
        "baltic-avenue",
      ]),
      ["oriental-avenue"],
      { mortgaged: true },
    );

    const debt = rollFromTable(poor, [1, 2]).state;

    expect(debtOf(debt)).toEqual(["A", "bank", 200]);

    const { state, events } = play(debt, answerFor(debt, "A", "DeclareBankruptcy", {}));
    const frame = state.control.stack.at(-1);

    expect(tags(events)).toContain("AssetsSurrendered");
    expect(ownerOf(state, "oriental-avenue")).toBeNull();
    expect(state.properties.find((property) => property.id === "oriental-avenue")?.mortgaged).toBe(
      false,
    );
    expect(
      frame !== undefined && Predicate.isTagged(frame, "Auction") ? frame.property : null,
    ).toBe("baltic-avenue");
    expect(frame !== undefined && "awaiting" in frame ? frame.awaiting : []).toEqual(["B", "C"]);
  });

  it("ends the game when one player remains", () => {
    const debt = onBoardwalk(2, 10, ["mediterranean-avenue"], true);
    const { state } = play(debt, answerFor(debt, "A", "DeclareBankruptcy", {}));

    expect(state.status).toBe("finished");
    expect(state.endReason).toBe("lastPlayerStanding");
    expect(state.winner).toBe("B");
  });

  it("goes bankrupt at once when the debtor owns nothing to sell or trade", () => {
    const debt = onBoardwalk(2, 10, []);

    expect(debt.status).toBe("finished");
    expect(debt.winner).toBe("B");
  });
});
