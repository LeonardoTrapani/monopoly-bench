/**
 * Engine-only steps (SPEC §4.2, §5.1): the turn loop, dice, movement, landing, cards,
 * payments and debts, round closes, auctions, bankruptcy and liquidation. `advance`
 * runs them until some seat must act or the game ends.
 */
import { Predicate } from "effect";

import {
  BOARD_SIZE,
  nearestForward,
  PROPERTIES,
  propertyInfo,
  RAILROAD_POSITIONS,
  Space,
  spaceAt,
  UTILITY_POSITIONS,
} from "./data/board.ts";
import { CardEffect, cardAt } from "./data/cards.ts";
import {
  activeSeats,
  deed,
  findFrame,
  fixedOrder,
  isFrameKind,
  player,
  topFrame,
  turnOrderFrom,
} from "./access.ts";
import { applyDraft, computeWake, CreditBook, sellOneLevel, tradedThisRound } from "./drafts.ts";
import { Machine, popFrame, pushFrame, task } from "./machine.ts";
import { rollDie } from "./rng.ts";
import { buildingsOf, liquidationValue, mortgageProblem, rentFor } from "./rules.ts";
import { PUBLIC } from "./schema/events.ts";
import { Frame, Task } from "./schema/state.ts";
import { standings } from "./standings.ts";

import type { SessionFrame } from "./drafts.ts";
import type { RentModifier } from "./rules.ts";
import type {
  BuildingKind,
  DeckId,
  Dice,
  Party,
  PropertyId,
  Seat,
  SeatReasons,
} from "./schema/common.ts";
import type { SeatBid } from "./schema/events.ts";
import type { EndReason, FrameOf, GameState, HighBid, PaymentReason } from "./schema/state.ts";
import type { LiquidationStep } from "./schema/views.ts";

const MAX_STEPS = 1_000_000;

export const payTask = (
  from: Seat,
  to: Party,
  amount: number,
  reason: PaymentReason,
  property: PropertyId | null,
) => task("Pay", { from, to, amount, reason, property });

const bidders = (seats: ReadonlyArray<Seat>): ReadonlyArray<SeatReasons> =>
  seats.map((seat) => ({ seat, reasons: ["bidder"] }));

const allDone = (frame: {
  readonly awaiting: ReadonlyArray<Seat>;
  readonly done: ReadonlyArray<Seat>;
}): boolean => frame.awaiting.every((seat) => frame.done.includes(seat));

/** Ends the game with the current standings. */
export const endGame = (machine: Machine, reason: EndReason): void => {
  const table = standings(machine.state);

  machine.emit("GameEnded", {
    reason,
    winner: reason === "aborted" ? null : (table[0]?.seat ?? null),
    standings: table,
  });
};

// ---------------------------------------------------------------------------
// Dice, movement and landing
// ---------------------------------------------------------------------------

/** Rolls two dice from the counter-based stream; the event carries the outcome. */
export const rollDice = (
  machine: Machine,
  seat: Seat,
  purpose: "move" | "jail" | "utility",
): Dice => {
  const { key, counter } = machine.state.rng;
  const dice: Dice = [rollDie(key, counter), rollDie(key, counter + 1)];

  machine.emit("DiceRolled", { seat, dice, purpose, rng: counter + 2 });

  return dice;
};

const collectSalary = (machine: Machine, seat: Seat): void => {
  const amount = machine.state.config.rules.goSalary;

  if (amount > 0) {
    machine.emit("Paid", { from: "bank", to: seat, amount, reason: "salary", property: null });
  }
};

const sendToJail = (
  machine: Machine,
  seat: Seat,
  reason: "goToJail" | "card" | "threeDoubles",
): void => machine.emit("SentToJail", { seat, reason });

/** Moves forward by `steps` (GO salary when passing or landing) and resolves the landing. */
export const moveBy = (machine: Machine, seat: Seat, steps: number): void => {
  const from = player(machine.state, seat).position;
  const to = (from + steps) % BOARD_SIZE;
  const passedGo = from + steps >= BOARD_SIZE;

  machine.emit("Moved", { seat, from, to, passedGo, via: "roll" });

  if (passedGo) collectSalary(machine, seat);

  land(machine, seat, to, "none");
};

/** The normal roll of a turn: three consecutive doubles send the player to jail. */
export const rollAndMove = (machine: Machine, seat: Seat): void => {
  const dice = rollDice(machine, seat, "move");

  if (dice[0] === dice[1] && machine.state.control.doubles >= 3) {
    return sendToJail(machine, seat, "threeDoubles");
  }

  moveBy(machine, seat, dice[0] + dice[1]);
};

const advanceTo = (machine: Machine, seat: Seat, target: number, modifier: RentModifier): void => {
  const from = player(machine.state, seat).position;
  const passedGo = target < from;

  machine.emit("Moved", { seat, from, to: target, passedGo, via: "card" });

  if (passedGo) collectSalary(machine, seat);

  land(machine, seat, target, modifier);
};

const landOnProperty = (
  machine: Machine,
  seat: Seat,
  id: PropertyId,
  modifier: RentModifier,
): void => {
  const property = deed(machine.state, id);
  const owner = property.owner;

  if (owner === null) return pushFrame(machine, "BuyChoice", { seat, property: id });

  if (owner === seat || property.mortgaged) return;

  if (propertyInfo(id).kind === "utility" && modifier === "utilityTenTimes") {
    const dice = rollDice(machine, seat, "utility");

    return machine.next(payTask(seat, owner, 10 * (dice[0] + dice[1]), "rent", id));
  }

  const dice = machine.state.lastDice;
  const total = dice === null ? 0 : dice[0] + dice[1];

  machine.next(payTask(seat, owner, rentFor(machine.state, id, total, modifier), "rent", id));
};

const land = (machine: Machine, seat: Seat, position: number, modifier: RentModifier): void =>
  Space.match(spaceAt(position), {
    Go: () => undefined,
    Jail: () => undefined,
    FreeParking: () => undefined,
    GoToJail: () => sendToJail(machine, seat, "goToJail"),
    Tax: (space) => machine.next(payTask(seat, "bank", space.amount, "tax", null)),
    Chance: () => drawCard(machine, seat, "chance"),
    CommunityChest: () => drawCard(machine, seat, "communityChest"),
    Property: (space) => landOnProperty(machine, seat, space.property, modifier),
  });

const othersInTurnOrder = (state: GameState, seat: Seat): ReadonlyArray<Seat> =>
  turnOrderFrom(state, seat).filter((other) => other !== seat);

const drawCard = (machine: Machine, seat: Seat, deck: DeckId): void => {
  const order = deck === "chance" ? machine.state.decks.chance : machine.state.decks.communityChest;
  const top = order[0];

  if (top === undefined) return;

  const card = cardAt(deck, top);

  machine.emit("CardDrawn", {
    seat,
    deck,
    card: top,
    kept: Predicate.isTagged(card.effect, "GetOutOfJailFree"),
  });

  CardEffect.match(card.effect, {
    AdvanceTo: (effect) => advanceTo(machine, seat, effect.position, "none"),
    AdvanceToNearest: (effect) => {
      const from = player(machine.state, seat).position;
      const railroad = effect.kind === "railroad";
      const target = nearestForward(from, railroad ? RAILROAD_POSITIONS : UTILITY_POSITIONS);

      advanceTo(machine, seat, target, railroad ? "railroadTwice" : "utilityTenTimes");
    },
    Collect: (effect) =>
      machine.emit("Paid", {
        from: "bank",
        to: seat,
        amount: effect.amount,
        reason: "card",
        property: null,
      }),
    Pay: (effect) => machine.next(payTask(seat, "bank", effect.amount, "card", null)),
    GetOutOfJailFree: () => undefined,
    GoBack: (effect) => {
      const from = player(machine.state, seat).position;
      const to = (from - effect.spaces + BOARD_SIZE) % BOARD_SIZE;

      machine.emit("Moved", { seat, from, to, passedGo: false, via: "card" });
      land(machine, seat, to, "none");
    },
    GoToJail: () => sendToJail(machine, seat, "card"),
    Repairs: (effect) => {
      const owned = buildingsOf(machine.state, seat);
      const amount = owned.houses * effect.perHouse + owned.hotels * effect.perHotel;

      if (amount > 0) machine.next(payTask(seat, "bank", amount, "card", null));
    },
    PayEachPlayer: (effect) =>
      machine.next(
        ...othersInTurnOrder(machine.state, seat).map((other) =>
          payTask(seat, other, effect.amount, "card", null),
        ),
      ),
    CollectFromEachPlayer: (effect) =>
      machine.next(
        ...othersInTurnOrder(machine.state, seat).map((other) =>
          payTask(other, seat, effect.amount, "card", null),
        ),
      ),
  });
};

// ---------------------------------------------------------------------------
// Payments, debts, bankruptcy and liquidation
// ---------------------------------------------------------------------------

const hasTradeableAssets = (state: GameState, seat: Seat): boolean =>
  player(state, seat).jailCards.length > 0 ||
  state.properties.some((property) => property.owner === seat);

const settlePayment = (machine: Machine, payment: Extract<Task, { readonly _tag: "Pay" }>) => {
  const state = machine.state;
  const debtor = player(state, payment.from);

  if (debtor.bankrupt || payment.amount <= 0) return;

  if (payment.to !== "bank" && player(state, payment.to).bankrupt) return;

  if (debtor.cash >= payment.amount) {
    return machine.emit("Paid", {
      from: payment.from,
      to: payment.to,
      amount: payment.amount,
      reason: payment.reason,
      property: payment.property,
    });
  }

  if (!hasTradeableAssets(state, payment.from)) {
    return bankrupt(machine, payment.from, payment.to);
  }

  pushFrame(machine, "RaiseFunds", {
    round: 1,
    awaiting: [payment.from],
    done: [],
    reasons: [{ seat: payment.from, reasons: ["debtor"] }],
    phase: "collecting",
    nextWake: [],
    debtor: payment.from,
    creditor: payment.to,
    amount: payment.amount,
    reason: payment.reason,
    property: payment.property,
    debtorActive: false,
    liquidate: false,
    declared: false,
  });
};

/** Board-ordered deeds of `seat`. */
const deedIds = (state: GameState, seat: Seat): ReadonlyArray<PropertyId> =>
  state.properties.flatMap((property) => (property.owner === seat ? [property.id] : []));

/** The street to sell from next: most expensive set first, a tallest street in it. */
const nextBuildingToSell = (state: GameState, seat: Seat): PropertyId | null => {
  let best: { readonly id: PropertyId; readonly cost: number; readonly level: number } | null =
    null;

  for (const property of state.properties) {
    if (property.owner !== seat || property.level === 0) continue;

    const cost = propertyInfo(property.id).houseCost;

    if (best === null || cost > best.cost || (cost === best.cost && property.level >= best.level)) {
      best = { id: property.id, cost, level: property.level };
    }
  }

  return best?.id ?? null;
};

const nextDeedToMortgage = (state: GameState, seat: Seat): PropertyId | null => {
  let best: PropertyId | null = null;

  for (const info of PROPERTIES) {
    if (mortgageProblem(state, seat, info.id) !== null) continue;

    if (best === null || info.mortgage < propertyInfo(best).mortgage) best = info.id;
  }

  return best;
};

/**
 * Automatic liquidation (SPEC §6.5): sell buildings evenly from the most expensive
 * set, then mortgage deeds from the cheapest, until `seat` has `target` cash.
 */
export const liquidate = (
  machine: Machine,
  seat: Seat,
  target: number,
  onStep: (step: LiquidationStep) => void,
): void => {
  for (let guard = 0; guard < 400; guard += 1) {
    const state = machine.state;
    const before = player(state, seat).cash;

    if (before >= target) return;

    const street = nextBuildingToSell(state, seat);

    if (street !== null) {
      sellOneLevel(machine, seat, street);
      onStep({
        action: "sellBuilding",
        property: street,
        proceeds: player(machine.state, seat).cash - before,
      });

      continue;
    }

    const mortgaged = nextDeedToMortgage(state, seat);

    if (mortgaged === null) return;

    const amount = propertyInfo(mortgaged).mortgage;

    machine.emit("PropertyMortgaged", { seat, property: mortgaged, amount });
    onStep({ action: "mortgage", property: mortgaged, proceeds: amount });
  }
};

const sellAllBuildings = (machine: Machine, seat: Seat): void => {
  for (let guard = 0; guard < 400; guard += 1) {
    const street = nextBuildingToSell(machine.state, seat);

    if (street === null) return;

    sellOneLevel(machine, seat, street);
  }
};

const ownedBy = (frame: Frame, seat: Seat): boolean =>
  Frame.match(frame, {
    Table: () => false,
    RaiseFunds: (current) => current.debtor === seat,
    JailChoice: (current) => current.seat === seat,
    BuyChoice: (current) => current.seat === seat,
    Auction: () => false,
    BuildingAuction: () => false,
    MortgagedTransfer: (current) => current.seat === seat,
  });

/** Closes a session: its offers expire and the frame pops. */
export const endSession = (machine: Machine, frame: SessionFrame): void => {
  const offers = machine.state.offers.filter((offer) => offer.session === frame.id);

  if (offers.length > 0) {
    machine.emit("OffersExpired", {
      session: frame.id,
      offerIds: offers.flatMap((offer) => (offer.status === "open" ? [offer.id] : [])),
    });
  }

  popFrame(machine, frame);
};

/**
 * Bankruptcy (SPEC §3.1). To a player: buildings are sold to the bank first, then
 * cash, deeds and jail cards go to the creditor, who then decides on each mortgaged
 * deed. To the bank: mortgages are cancelled and every deed is auctioned in board
 * order; jail cards return to their decks.
 */
export const bankrupt = (machine: Machine, seat: Seat, creditor: Party): void => {
  if (player(machine.state, seat).bankrupt) return;

  const to: Party =
    creditor !== "bank" && creditor !== seat && !player(machine.state, creditor).bankrupt
      ? creditor
      : "bank";

  for (const frame of [...machine.state.control.stack].reverse()) {
    if (!ownedBy(frame, seat)) continue;

    if (isFrameKind(frame, "RaiseFunds")) endSession(machine, frame);
    else popFrame(machine, frame);
  }

  if (to === "bank") {
    const current = player(machine.state, seat);
    const deeds = deedIds(machine.state, seat);

    machine.emit("AssetsSurrendered", {
      seat,
      cash: current.cash,
      properties: deeds,
      jailCards: current.jailCards,
    });
    machine.next(...deeds.map((property) => task("AuctionDeed", { property })));
  } else {
    sellAllBuildings(machine, seat);

    const current = player(machine.state, seat);
    const deeds = deedIds(machine.state, seat);
    const mortgaged = deeds.filter((id) => deed(machine.state, id).mortgaged);

    machine.emit("AssetsTransferred", {
      from: seat,
      to,
      cash: current.cash,
      properties: deeds,
      jailCards: current.jailCards,
    });

    if (mortgaged.length > 0) {
      machine.next(task("ResolveMortgaged", { seat: to, properties: mortgaged }));
    }
  }

  machine.emit("PlayerBankrupt", { seat, creditor: to });

  if (activeSeats(machine.state).length <= 1) endGame(machine, "lastPlayerStanding");
};

// ---------------------------------------------------------------------------
// Auctions
// ---------------------------------------------------------------------------

/** Opens an auction of a bank deed among every seat able to make the opening bid. */
export const openAuction = (machine: Machine, property: PropertyId): void => {
  const minimum = machine.state.config.rules.auctionMinOpening;

  const seats = fixedOrder(machine.state).filter(
    (seat) => liquidationValue(machine.state, seat) >= minimum,
  );

  pushFrame(machine, "Auction", {
    property,
    round: 1,
    awaiting: seats,
    done: [],
    reasons: bidders(seats),
    active: seats,
    high: null,
  });
};

interface BidRoundOutcome {
  readonly ended: boolean;
  readonly high: HighBid | null;
}

/** Closes one simultaneous bidding round (SPEC §5.5); opens the next one when needed. */
const closeBidRound = (
  machine: Machine,
  frame: FrameOf<"Auction"> | FrameOf<"BuildingAuction">,
): BidRoundOutcome => {
  const state = machine.state;

  const drafts = state.drafts.filter(
    (draft) => draft.frame === frame.id && draft.round === frame.round,
  );

  const bids: Array<SeatBid> = [];
  let best: HighBid | null = null;

  for (const seat of fixedOrder(state)) {
    if (!frame.awaiting.includes(seat)) continue;

    const draft = drafts.find((candidate) => candidate.seat === seat);

    const amount =
      draft !== undefined && Predicate.isTagged(draft.command, "Bid") ? draft.command.amount : null;

    bids.push({ seat, amount });

    if (amount !== null && (best === null || amount > best.amount)) best = { seat, amount };
  }

  const passed = new Set(bids.flatMap((bid) => (bid.amount === null ? [bid.seat] : [])));
  const active = frame.active.filter((seat) => !passed.has(seat) && !player(state, seat).bankrupt);
  const high = best ?? frame.high;

  machine.emit("AuctionRoundClosed", {
    frameId: frame.id,
    round: frame.round,
    bids,
    high,
    active,
  });

  const next = active.filter((seat) => seat !== high?.seat);

  if (best === null || next.length === 0) return { ended: true, high };

  machine.emit("RoundOpened", {
    frameId: frame.id,
    round: frame.round + 1,
    awaiting: next,
    reasons: bidders(next),
  });

  return { ended: false, high };
};

const stepAuction = (machine: Machine, frame: FrameOf<"Auction">): boolean => {
  if (!allDone(frame)) return false;

  const outcome = closeBidRound(machine, frame);

  if (!outcome.ended) return true;

  const high = outcome.high;

  machine.emit("AuctionEnded", {
    frameId: frame.id,
    property: frame.property,
    winner: high?.seat ?? null,
    amount: high?.amount ?? 0,
  });

  if (high !== null) {
    machine.next(payTask(high.seat, "bank", high.amount, "auction", frame.property));
  }

  popFrame(machine, frame);

  return true;
};

// ---------------------------------------------------------------------------
// Building shortage (SPEC §4.3 step 4)
// ---------------------------------------------------------------------------

/** Scarce units requested per kind and seat by the Build drafts of a table round. */
const buildRequests = (
  state: GameState,
  frame: FrameOf<"Table">,
): ReadonlyMap<BuildingKind, ReadonlyMap<Seat, number>> => {
  const requests = new Map<BuildingKind, Map<Seat, number>>([
    ["house", new Map()],
    ["hotel", new Map()],
  ]);

  const planned = new Map<string, number>();

  for (const draft of state.drafts) {
    if (draft.frame !== frame.id || draft.round !== frame.round) continue;

    if (!Predicate.isTagged(draft.command, "Build")) continue;

    const id = draft.command.property;
    const key = `${draft.seat}:${id}`;
    const level = deed(state, id).level + (planned.get(key) ?? 0);

    planned.set(key, (planned.get(key) ?? 0) + 1);

    if (level >= 5) continue;

    const perSeat = requests.get(level === 4 ? "hotel" : "house");

    perSeat?.set(draft.seat, (perSeat.get(draft.seat) ?? 0) + 1);
  }

  return requests;
};

const contestedKinds = (state: GameState, frame: FrameOf<"Table">): ReadonlyArray<BuildingKind> => {
  const requests = buildRequests(state, frame);
  const contested: Array<BuildingKind> = [];

  for (const kind of ["house", "hotel"] as const) {
    const perSeat = requests.get(kind) ?? new Map<Seat, number>();
    const supply = kind === "house" ? state.bank.houses : state.bank.hotels;
    let total = 0;

    for (const units of perSeat.values()) total += units;

    if (supply > 0 && total > supply && perSeat.size >= 2) contested.push(kind);
  }

  return contested;
};

const openBuildingAuction = (
  machine: Machine,
  table: FrameOf<"Table">,
  kind: BuildingKind,
): void => {
  const state = machine.state;
  const perSeat = buildRequests(state, table).get(kind) ?? new Map<Seat, number>();

  const demand = fixedOrder(state).flatMap((seat) => {
    const units = perSeat.get(seat) ?? 0;

    return units > 0 ? [{ seat, units }] : [];
  });

  pushFrame(machine, "BuildingAuction", {
    table: table.id,
    kind,
    unitsLeft: kind === "house" ? state.bank.houses : state.bank.hotels,
    demand,
    credits: [],
    round: 0,
    awaiting: [],
    done: [],
    reasons: [],
    active: [],
    high: null,
  });
};

const settleBuildingAuction = (machine: Machine, frameId: number): boolean => {
  const frame = findFrame(machine.state, frameId);

  if (frame === undefined || !isFrameKind(frame, "BuildingAuction")) return true;

  machine.emit("BuildingCreditsSettled", {
    table: frame.table,
    kind: frame.kind,
    credits: frame.credits.filter((credit) => credit.units > 0),
  });
  popFrame(machine, frame);

  return true;
};

const stepBuildingAuction = (machine: Machine, frame: FrameOf<"BuildingAuction">): boolean => {
  if (frame.active.length === 0) {
    const wanting = frame.demand.filter(
      (entry) => entry.units > 0 && !player(machine.state, entry.seat).bankrupt,
    );

    let total = 0;

    for (const entry of wanting) total += entry.units;

    if (frame.unitsLeft === 0 || wanting.length === 0) {
      return settleBuildingAuction(machine, frame.id);
    }

    if (total <= frame.unitsLeft || wanting.length === 1) {
      machine.emit("BuildingUnitsGranted", {
        frameId: frame.id,
        grants: wanting.map((entry) => ({
          seat: entry.seat,
          units: Math.min(entry.units, frame.unitsLeft),
        })),
      });

      return true;
    }

    machine.emit("BuildingUnitOpened", {
      frameId: frame.id,
      active: wanting.map((entry) => entry.seat),
    });

    return true;
  }

  if (!allDone(frame)) return false;

  const outcome = closeBidRound(machine, frame);

  if (!outcome.ended) return true;

  const high = outcome.high;

  machine.emit("BuildingUnitAuctioned", {
    frameId: frame.id,
    kind: frame.kind,
    winner: high?.seat ?? null,
    premium: high?.amount ?? 0,
  });

  if (high === null) return settleBuildingAuction(machine, frame.id);

  if (high.amount > 0) {
    machine.emit("Paid", {
      from: high.seat,
      to: "bank",
      amount: high.amount,
      reason: "buildingAuction",
      property: null,
    });
  }

  return true;
};

// ---------------------------------------------------------------------------
// Sessions (Table, RaiseFunds)
// ---------------------------------------------------------------------------

const roundDrafts = (state: GameState, frame: SessionFrame) => {
  const drafts = state.drafts.filter(
    (draft) => draft.frame === frame.id && draft.round === frame.round,
  );

  return fixedOrder(state).flatMap((seat) => drafts.filter((draft) => draft.seat === seat));
};

/** Applies the round's drafts in fixed order and records who to wake next. */
const applyRound = (machine: Machine, frame: SessionFrame, credits: CreditBook | null): void => {
  const start = machine.events.length;

  const debtorActive =
    isFrameKind(frame, "RaiseFunds") && tradedThisRound(machine.state, frame, frame.debtor);

  for (const draft of roundDrafts(machine.state, frame)) {
    if (player(machine.state, draft.seat).bankrupt) continue;

    applyDraft(machine, frame, draft.seat, draft.command, credits);
  }

  machine.emit("RoundClosed", {
    frameId: frame.id,
    round: frame.round,
    nextWake: computeWake(machine.state, frame, machine.events.slice(start)),
    debtorActive,
  });
};

const openNextRound = (machine: Machine, frame: SessionFrame): void => {
  const wake = frame.nextWake.filter((entry) => !player(machine.state, entry.seat).bankrupt);

  machine.emit("RoundOpened", {
    frameId: frame.id,
    round: frame.round + 1,
    awaiting: wake.map((entry) => entry.seat),
    reasons: wake,
  });
};

const stepTable = (machine: Machine, frame: FrameOf<"Table">): boolean => {
  const rules = machine.state.config.rules;

  if (frame.phase === "collecting") {
    if (!allDone(frame)) return false;

    const closing = frame.closing;

    if (closing === null) {
      const contested = contestedKinds(machine.state, frame);

      if (contested.length > 0) machine.emit("TableClosing", { frameId: frame.id, contested });
      else applyRound(machine, frame, null);

      return true;
    }

    const pending = closing.pending[0];

    if (pending !== undefined) openBuildingAuction(machine, frame, pending);
    else applyRound(machine, frame, new CreditBook(closing.contested, closing.credits));

    return true;
  }

  const anyone = frame.nextWake.some((entry) => !player(machine.state, entry.seat).bankrupt);

  if (!anyone || frame.round >= rules.maxTableRounds) endSession(machine, frame);
  else openNextRound(machine, frame);

  return true;
};

const settleDebt = (machine: Machine, frame: FrameOf<"RaiseFunds">): void => {
  const creditor = frame.creditor;

  const to: Party =
    creditor !== "bank" && player(machine.state, creditor).bankrupt ? "bank" : creditor;

  machine.emit("Paid", {
    from: frame.debtor,
    to,
    amount: frame.amount,
    reason: frame.reason,
    property: frame.property,
  });
  endSession(machine, frame);
};

const stepRaiseFunds = (machine: Machine, frame: FrameOf<"RaiseFunds">): boolean => {
  const rules = machine.state.config.rules;

  if (frame.phase === "collecting") {
    if (!allDone(frame)) return false;

    applyRound(machine, frame, null);

    return true;
  }

  if (player(machine.state, frame.debtor).cash >= frame.amount) {
    settleDebt(machine, frame);

    return true;
  }

  if (frame.declared) {
    endSession(machine, frame);
    bankrupt(machine, frame.debtor, frame.creditor);

    return true;
  }

  const debtorReasons = frame.nextWake.find((entry) => entry.seat === frame.debtor)?.reasons ?? [];
  const othersWoken = frame.nextWake.some((entry) => entry.seat !== frame.debtor);

  const idle =
    !frame.debtorActive && !othersWoken && debtorReasons.every((reason) => reason === "debtor");

  if (!frame.liquidate && !idle && frame.round < rules.maxTableRounds) {
    openNextRound(machine, frame);

    return true;
  }

  liquidate(machine, frame.debtor, frame.amount, () => undefined);

  if (player(machine.state, frame.debtor).cash >= frame.amount) {
    settleDebt(machine, frame);
  } else {
    endSession(machine, frame);
    bankrupt(machine, frame.debtor, frame.creditor);
  }

  return true;
};

// ---------------------------------------------------------------------------
// Turn loop
// ---------------------------------------------------------------------------

const tableDue = (state: GameState): boolean => {
  const control = state.control;

  switch (state.config.rules.tableFrequency) {
    case "off":
      return false;
    case "everyRoll":
      return true;
    case "everyTurn":
      return control.doubles === 0;
    case "everyRound":
      return control.doubles === 0 && control.newRound;
  }
};

const openTable = (machine: Machine): void => {
  const seats = fixedOrder(machine.state);

  pushFrame(machine, "Table", {
    round: 1,
    awaiting: seats,
    done: [],
    reasons: seats.map((seat) => ({ seat, reasons: ["opening"] })),
    phase: "collecting",
    nextWake: [],
    closing: null,
  });
};

/** Passes the turn to the next active seat, or ends the game at the turn cap. */
const nextTurn = (machine: Machine): void => {
  const state = machine.state;
  const control = state.control;
  const current = state.players.findIndex((candidate) => candidate.seat === control.activeSeat);

  for (let offset = 1; offset <= state.players.length; offset += 1) {
    const index = (current + offset) % state.players.length;
    const candidate = state.players[index];

    if (candidate === undefined || candidate.bankrupt) continue;

    const wrapped = index <= current;
    const gameRound = wrapped ? control.gameRound + 1 : control.gameRound;

    if (gameRound > state.config.rules.maxRounds) return endGame(machine, "turnCap");

    return machine.emit(
      "TurnStarted",
      { seat: candidate.seat, gameRound, newRound: wrapped },
      PUBLIC,
      control.turn + 1,
    );
  }

  endGame(machine, "lastPlayerStanding");
};

const turnStep = (machine: Machine): void => {
  const control = machine.state.control;
  const seat = control.activeSeat;
  const current = player(machine.state, seat);

  if (current.bankrupt) return nextTurn(machine);

  if (!control.rolled) {
    if (!control.tableOpened && tableDue(machine.state)) return openTable(machine);

    if (current.inJail) return pushFrame(machine, "JailChoice", { seat });

    return rollAndMove(machine, seat);
  }

  if (control.extraRoll && !current.inJail) {
    return machine.emit("RolledAgain", { seat, doubles: control.doubles });
  }

  nextTurn(machine);
};

const runTask = (machine: Machine, next: Task): void =>
  Task.match(next, {
    Pay: (payment) => settlePayment(machine, payment),
    MoveBy: (move) => {
      if (player(machine.state, move.seat).bankrupt) return;

      if (move.fromJail) machine.emit("LeftJail", { seat: move.seat, via: "forcedFine" });

      moveBy(machine, move.seat, move.steps);
    },
    AuctionDeed: (auction) => {
      if (deed(machine.state, auction.property).owner === null) {
        openAuction(machine, auction.property);
      }
    },
    ResolveMortgaged: (resolve) => {
      if (player(machine.state, resolve.seat).bankrupt) return;

      const properties = resolve.properties.filter((id) => {
        const property = deed(machine.state, id);

        return property.owner === resolve.seat && property.mortgaged;
      });

      if (properties.length > 0) {
        pushFrame(machine, "MortgagedTransfer", { seat: resolve.seat, properties });
      }
    },
  });

/** Steps the top frame; false when it waits for input. */
const stepFrame = (machine: Machine, frame: Frame): boolean =>
  Frame.match(frame, {
    Table: (current) => stepTable(machine, current),
    RaiseFunds: (current) => stepRaiseFunds(machine, current),
    JailChoice: () => false,
    BuyChoice: () => false,
    Auction: (current) => stepAuction(machine, current),
    BuildingAuction: (current) => stepBuildingAuction(machine, current),
    MortgagedTransfer: (current) => {
      if (current.properties.length > 0) return false;

      popFrame(machine, current);

      return true;
    },
  });

/**
 * Runs every automatic step (round closes, dice, movement, rent, cards, auctions
 * resolution, the next turn) until a seat must act or the game ends.
 */
export const advance = (machine: Machine): void => {
  for (let step = 0; step < MAX_STEPS; step += 1) {
    if (machine.state.status !== "playing") return;

    const next = machine.queue.shift();

    if (next !== undefined) {
      runTask(machine, next);

      continue;
    }

    const frame = topFrame(machine.state);

    if (frame === undefined) {
      turnStep(machine);

      continue;
    }

    if (!stepFrame(machine, frame)) return;
  }

  throw new Error("The engine did not reach a decision point");
};
