import { describe, expect, it } from "vite-plus/test";

import { playerView, spectatorView } from "./views.ts";
import {
  answerFor,
  build,
  cash,
  eventsOf,
  levelOf,
  own,
  ownerOf,
  play,
  rejection,
  startGame,
  tags,
  topKind,
  withDeeds,
  withDice,
} from "./testing.ts";

import type { Assets } from "./schema/common.ts";
import type { GameState } from "./schema/state.ts";

const NONE: Assets = { cash: 0, properties: [], jailCards: 0 };

/** Every listed seat answers Done (the last one closes the round); harmless dice for A. */
const closeRound = (state: GameState, ...seats: ReadonlyArray<"A" | "B" | "C">) =>
  play(withDice(state, [1, 2]), ...seats.map((seat) => answerFor(state, seat, "Done", {})));

const reasonsOf = (state: GameState, seat: "A" | "B" | "C") => {
  const frame = state.control.stack.at(-1);

  return frame !== undefined && "reasons" in frame
    ? (frame.reasons.find((entry) => entry.seat === seat)?.reasons ?? [])
    : [];
};

describe("building at the table", () => {
  const brown = own(startGame(2), "A", ["mediterranean-avenue", "baltic-avenue"]);

  it("stores builds as private drafts and applies them at round close", () => {
    const drafted = play(
      brown,
      answerFor(brown, "A", "Build", { property: "mediterranean-avenue" }),
      answerFor(brown, "A", "Build", { property: "baltic-avenue" }),
    );

    expect(levelOf(drafted.state, "mediterranean-avenue")).toBe(0);
    expect(eventsOf(drafted.events, "DraftAdded")[0]?.visibility).toEqual({ seats: ["A"] });
    expect(playerView(drafted.state, "A").drafts).toHaveLength(2);
    expect(playerView(drafted.state, "B").drafts).toHaveLength(0);
    expect(spectatorView(drafted.state).drafts).toHaveLength(2);

    const closed = closeRound(drafted.state, "A", "B").state;

    expect(levelOf(closed, "mediterranean-avenue")).toBe(1);
    expect(levelOf(closed, "baltic-avenue")).toBe(1);
    expect(closed.bank.houses).toBe(30);
  });

  it("validates drafts against the seat's own drafts (even building)", () => {
    const one = play(brown, answerFor(brown, "A", "Build", { property: "mediterranean-avenue" }));

    expect(
      rejection(
        one.state,
        answerFor(one.state, "A", "Build", { property: "mediterranean-avenue" }),
      ),
    ).toContain("evenly");
  });

  it("mortgages and unmortgages for the mortgage value plus 10%", () => {
    const deed = own(startGame(2), "A", ["boardwalk"]);

    const { state } = play(
      deed,
      answerFor(deed, "A", "Mortgage", { property: "boardwalk" }),
      answerFor(deed, "A", "Unmortgage", { property: "boardwalk" }),
    );

    const closed = closeRound(state, "A", "B").state;

    expect(cash(closed, "A")).toBe(1500 + 200 - 220);
    expect(closed.properties.find((property) => property.id === "boardwalk")?.mortgaged).toBe(
      false,
    );
  });

  it("sells a hotel with a house shortage, keeping the set even", () => {
    const hotels = build(
      own(startGame(2), "A", ["oriental-avenue", "vermont-avenue", "connecticut-avenue"]),
      [
        ["oriental-avenue", 5],
        ["vermont-avenue", 5],
        ["connecticut-avenue", 5],
      ],
    );

    const shortage = { ...hotels, bank: { houses: 1, hotels: hotels.bank.hotels } };

    const drafted = play(
      shortage,
      answerFor(shortage, "A", "SellBuilding", { property: "oriental-avenue" }),
    );

    const { state, events } = closeRound(drafted.state, "A", "B");
    const sale = eventsOf(events, "BuildingSold")[0];
    const levels = ["oriental-avenue", "vermont-avenue", "connecticut-avenue"] as const;
    const removed = levels.reduce((total, id) => total + 5 - levelOf(state, id), 0);

    expect(sale?.changes.length).toBeGreaterThan(1);
    expect(
      Math.max(...levels.map((id) => levelOf(state, id))) -
        Math.min(...levels.map((id) => levelOf(state, id))),
    ).toBeLessThanOrEqual(1);
    expect(sale?.proceeds).toBe(removed * 25);

    const housesOnBoard = levels.reduce(
      (total, id) => total + (levelOf(state, id) === 5 ? 0 : levelOf(state, id)),
      0,
    );

    // The bank had 1 house and the board none: houses are conserved.
    expect(state.bank.houses + housesOnBoard).toBe(1);
  });

  it("auctions scarce houses among several requesters; winners build in draft order", () => {
    const setup = own(own(startGame(2), "A", ["mediterranean-avenue", "baltic-avenue"]), "B", [
      "oriental-avenue",
      "vermont-avenue",
      "connecticut-avenue",
    ]);

    const scarce = { ...setup, bank: { houses: 2, hotels: 12 } };

    const drafted = play(
      scarce,
      answerFor(scarce, "A", "Build", { property: "mediterranean-avenue" }),
      answerFor(scarce, "A", "Build", { property: "baltic-avenue" }),
      answerFor(scarce, "B", "Build", { property: "oriental-avenue" }),
      answerFor(scarce, "B", "Build", { property: "vermont-avenue" }),
      answerFor(scarce, "A", "Done", {}),
      answerFor(scarce, "B", "Done", {}),
    );

    expect(tags(drafted.events)).toContain("TableClosing");
    expect(topKind(drafted.state)).toBe("BuildingAuction");

    const firstRound = play(
      drafted.state,
      answerFor(drafted.state, "A", "Bid", { amount: 15 }),
      answerFor(drafted.state, "B", "Bid", { amount: 10 }),
    ).state;

    // B is outbid and must raise or pass; passing gives the first unit to A.
    const firstUnit = play(firstRound, answerFor(firstRound, "B", "PassBid", {})).state;
    const secondUnit = withDice(firstUnit, [1, 2]);

    const { state, events } = play(
      secondUnit,
      answerFor(secondUnit, "A", "PassBid", {}),
      answerFor(secondUnit, "B", "Bid", { amount: 10 }),
    );

    expect(eventsOf(events, "BuildingCreditsSettled")[0]?.credits).toEqual([
      { seat: "A", units: 1 },
      { seat: "B", units: 1 },
    ]);
    expect(levelOf(state, "mediterranean-avenue")).toBe(1);
    expect(levelOf(state, "baltic-avenue")).toBe(0);
    expect(levelOf(state, "oriental-avenue")).toBe(1);
    expect(levelOf(state, "vermont-avenue")).toBe(0);
    expect(state.bank.houses).toBe(0);
    expect(eventsOf(events, "ActionDropped")).toHaveLength(2);
    expect(cash(state, "B")).toBe(1500 - 10 - 50);
  });
});

describe("offers", () => {
  const twoPlayers = own(startGame(2), "B", ["baltic-avenue"]);

  const buyBaltic = (state: GameState) =>
    answerFor(state, "A", "Offer", {
      to: "B",
      give: { ...NONE, cash: 100 },
      get: { ...NONE, properties: ["baltic-avenue"] },
      comment: "Baltic for $100?",
    });

  it("posts offers at round close and lets the addressee accept in the next round", () => {
    const posted = closeRound(play(twoPlayers, buyBaltic(twoPlayers)).state, "A", "B");

    expect(eventsOf(posted.events, "OfferPosted")[0]?.offer.id).toBe(1);
    expect(posted.state.control.stack.at(-1)?._tag).toBe("Table");
    expect(reasonsOf(posted.state, "B")).toContain("addressed");

    const { state, events } = play(
      withDice(posted.state, [1, 2]),
      answerFor(posted.state, "B", "Accept", { offerId: 1 }),
      answerFor(posted.state, "B", "Done", {}),
    );

    expect(tags(events)).toContain("TradeExecuted");
    expect(ownerOf(state, "baltic-avenue")).toBe("A");
    expect(cash(state, "B")).toBe(1600);
    expect(tags(events)).toContain("OffersExpired");
  });

  it("cannot accept an offer in the round it is posted", () => {
    const drafted = play(twoPlayers, buyBaltic(twoPlayers)).state;

    expect(rejection(drafted, answerFor(drafted, "B", "Accept", { offerId: 1 }))).toContain(
      "does not exist",
    );
  });

  it("asks the receiver of a mortgaged deed to pay 10% or unmortgage", () => {
    const mortgaged = withDeeds(twoPlayers, ["baltic-avenue"], { mortgaged: true });
    const posted = closeRound(play(mortgaged, buyBaltic(mortgaged)).state, "A", "B").state;

    const accepted = play(
      posted,
      answerFor(posted, "B", "Accept", { offerId: 1 }),
      answerFor(posted, "B", "Done", {}),
    ).state;

    expect(topKind(accepted)).toBe("MortgagedTransfer");

    const kept = play(
      withDice(accepted, [1, 2]),
      answerFor(accepted, "A", "KeepMortgage", { property: "baltic-avenue" }),
    );

    expect(
      eventsOf(kept.events, "Paid").find((paid) => paid.reason === "mortgageInterest")?.amount,
    ).toBe(3);

    const paidOff = play(
      withDice(accepted, [1, 2]),
      answerFor(accepted, "A", "PayOffMortgage", { property: "baltic-avenue" }),
    );

    expect(eventsOf(paidOff.events, "PropertyUnmortgaged")[0]?.amount).toBe(33);
  });

  it("limits new offers per round and comment length", () => {
    const first = play(twoPlayers, buyBaltic(twoPlayers), buyBaltic(twoPlayers)).state;

    expect(rejection(first, buyBaltic(first))).toContain("at most 2");
    expect(
      rejection(
        twoPlayers,
        answerFor(twoPlayers, "A", "Offer", {
          to: "B",
          give: { ...NONE, cash: 1 },
          get: NONE,
          comment: "x".repeat(281),
        }),
      ),
    ).toContain("280");
  });

  it("refuses deeds with buildings in their color set", () => {
    const built = build(own(startGame(2), "B", ["mediterranean-avenue", "baltic-avenue"]), [
      ["mediterranean-avenue", 1],
    ]);

    expect(rejection(built, buyBaltic(built))).toContain("buildings");
  });

  it("resolves competing acceptances of an open offer in fixed order", () => {
    const three = own(startGame(3), "A", ["baltic-avenue"]);

    const open = answerFor(three, "A", "Offer", {
      give: { ...NONE, properties: ["baltic-avenue"] },
      get: { ...NONE, cash: 50 },
    });

    const posted = closeRound(play(three, open).state, "A", "B", "C").state;

    expect(reasonsOf(posted, "B")).toContain("openCall");
    expect(reasonsOf(posted, "C")).toContain("openCall");

    const { state, events } = play(
      withDice(posted, [1, 2]),
      answerFor(posted, "C", "Accept", { offerId: 1 }),
      answerFor(posted, "B", "Accept", { offerId: 1 }),
      answerFor(posted, "C", "Done", {}),
      answerFor(posted, "B", "Done", {}),
    );

    expect(ownerOf(state, "baltic-avenue")).toBe("B");
    expect(eventsOf(events, "OfferInvalidated")[0]?.seat).toBe("C");
  });
});

describe("wake rules", () => {
  const three = own(own(startGame(3), "B", ["baltic-avenue"]), "C", ["mediterranean-avenue"]);

  const offer = answerFor(three, "A", "Offer", {
    to: "B",
    give: { ...NONE, cash: 100 },
    get: { ...NONE, properties: ["baltic-avenue"] },
  });

  it("wakes the addressee and the followers of the group, nobody else", () => {
    const posted = closeRound(play(three, offer).state, "A", "B", "C").state;
    const frame = posted.control.stack.at(-1);

    expect(frame !== undefined && "awaiting" in frame ? frame.awaiting : []).toEqual(["B", "C"]);
    expect(reasonsOf(posted, "C")).toEqual(["follows"]);
  });

  it("does not wake a seat that unfollowed the group", () => {
    const unfollowed = play(
      three,
      offer,
      answerFor(three, "C", "Unfollow", { group: "brown" }),
    ).state;

    const posted = closeRound(unfollowed, "A", "B", "C").state;
    const frame = posted.control.stack.at(-1);

    expect(frame !== undefined && "awaiting" in frame ? frame.awaiting : []).toEqual(["B"]);
  });

  it("wakes the proposer on a rejection and both parties on a counter-offer", () => {
    const posted = closeRound(play(three, offer).state, "A", "B", "C").state;

    const countered = play(
      posted,
      answerFor(posted, "B", "Reject", { offerId: 1, comment: "Too low." }),
      answerFor(posted, "B", "Offer", {
        to: "A",
        replyTo: 1,
        give: { ...NONE, properties: ["baltic-avenue"] },
        get: { ...NONE, cash: 150 },
      }),
      answerFor(posted, "B", "Done", {}),
      answerFor(posted, "C", "Done", {}),
    ).state;

    expect(reasonsOf(countered, "A")).toEqual(expect.arrayContaining(["addressed", "inThread"]));
  });

  it("ends the session when a round wakes nobody", () => {
    const { events } = closeRound(three, "A", "B", "C");
    const order = tags(events);

    expect(order).not.toContain("RoundOpened");
    expect(order.indexOf("FramePopped")).toBeLessThan(order.indexOf("DiceRolled"));
  });
});
