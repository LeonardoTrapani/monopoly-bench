/**
 * `heuristic` policy: a sane scripted player. Buys when it keeps a cash reserve, bids
 * up to a value-based cap, builds evenly on its monopolies, mortgages the cheapest
 * deeds first when raising funds, and proposes / accepts trades that complete color
 * sets when a simple value function says they are worth it.
 */
import { Predicate } from "effect";

import {
  buildProblem,
  command,
  countOwnedInGroup,
  groupMembers,
  liquidationValue,
  mortgageInterest,
  mortgageProblem,
  propertyInfo,
  tradeProblem,
  unmortgageCost,
  unmortgageProblem,
} from "@mb/engine";

import {
  answer,
  decisionRandom,
  deedState,
  frameAs,
  me,
  minimumBid,
  ownedIds,
  Plan,
  streetsOfCompleteSets,
} from "./common.ts";

import type { Bot } from "./common.ts";
import type {
  Assets,
  Command,
  DecisionRequest,
  GroupId,
  Holdings,
  Offer,
  PlayerView,
  PropertyId,
  Seat,
} from "@mb/engine";

/** Build priority by group (best return on investment first). */
const BUILD_ORDER: ReadonlyArray<GroupId> = [
  "orange",
  "red",
  "light-blue",
  "pink",
  "yellow",
  "dark-blue",
  "green",
  "brown",
];

const NOTHING: Assets = { cash: 0, properties: [], jailCards: 0 };

const groupPrice = (group: GroupId): number =>
  groupMembers(group).reduce((total, id) => total + propertyInfo(id).price, 0);

const developCost = (group: GroupId): number =>
  groupMembers(group).reduce((total, id) => total + propertyInfo(id).houseCost * 2, 0);

const cashOf = (view: PlayerView, seat: Seat): number =>
  view.players.find((player) => player.seat === seat)?.cash ?? 0;

/** Cash kept aside: grows with the most dangerous rent on the board. */
const reserveFor = (view: PlayerView): number => {
  let worst = 0;

  for (const property of view.properties) {
    if (property.owner === null || property.owner === view.seat || property.mortgaged) continue;

    const info = propertyInfo(property.id);

    if (info.kind === "street" && property.level > 0) {
      worst = Math.max(worst, info.rents[property.level] ?? 0);
    }
  }

  return Math.min(600, 150 + Math.round(worst * 0.3));
};

const worth = (holdings: Holdings, id: PropertyId): number => {
  const info = propertyInfo(id);

  return deedState(holdings, id).mortgaged ? info.price - unmortgageCost(id) : info.price;
};

/** Whether `seat` owns every street of `group` once `owner` maps the deeds. */
const completes = (group: GroupId, seat: Seat, owner: (id: PropertyId) => Seat | null) =>
  groupMembers(group).every((id) => owner(id) === seat);

/**
 * Value for `seat` of receiving `receive` from `partner` and paying `pay`: cash, deed
 * prices, and bonuses / penalties when color sets are completed or broken.
 */
const tradeGain = (
  view: PlayerView,
  seat: Seat,
  partner: Seat,
  receive: Assets,
  pay: Assets,
): number => {
  const before = (id: PropertyId) => deedState(view, id).owner;

  const after = (id: PropertyId) =>
    receive.properties.includes(id) ? seat : pay.properties.includes(id) ? partner : before(id);

  const cashAfter = cashOf(view, seat) + receive.cash - pay.cash;
  const partnerCashAfter = cashOf(view, partner) - receive.cash + pay.cash;
  const groups = new Set<GroupId>();
  // Strengthening one opponent hurts less when there are several: they compete with each other.
  const opponents = Math.max(1, view.players.filter((player) => !player.bankrupt).length - 1);
  const danger = 1 / Math.sqrt(opponents);
  let gain = receive.cash - pay.cash + 30 * (receive.jailCards - pay.jailCards);

  for (const id of receive.properties) {
    gain += worth(view, id);
    groups.add(propertyInfo(id).group);
  }

  for (const id of pay.properties) {
    gain -= worth(view, id);
    groups.add(propertyInfo(id).group);
  }

  let mine = 0;
  let theirs = false;

  for (const group of groups) {
    if (group === "railroads" || group === "utilities") continue;

    const price = groupPrice(group);
    const buildable = (cash: number) => (cash >= developCost(group) ? 0.4 : 0);

    if (!completes(group, seat, before) && completes(group, seat, after)) {
      gain += price * (0.6 + buildable(cashAfter));
      mine += price;
    }

    if (completes(group, seat, before) && !completes(group, seat, after)) gain -= price;

    if (!completes(group, partner, before) && completes(group, partner, after)) {
      gain -= price * (0.6 + buildable(partnerCashAfter)) * danger;
      theirs = true;
    }
  }

  // A swap that completes a set on both sides unlocks building for both: worth doing.
  if (mine > 0 && theirs) gain += mine * 0.25;

  return gain;
};

const offerGain = (view: PlayerView, offer: Offer): number =>
  tradeGain(view, view.seat, offer.from, offer.give, offer.get);

/** Seat that owns all the other streets of `id`'s group, if any (a set blocker). */
const wouldComplete = (view: PlayerView, id: PropertyId): Seat | null => {
  const info = propertyInfo(id);

  if (info.kind !== "street") return null;

  const others = groupMembers(info.group).filter((member) => member !== id);
  const owner = deedState(view, others[0] ?? id).owner;

  return owner !== null && others.every((member) => deedState(view, member).owner === owner)
    ? owner
    : null;
};

const propertyValue = (view: PlayerView, id: PropertyId): number => {
  const info = propertyInfo(id);
  const completer = wouldComplete(view, id);

  if (completer === view.seat) return info.price * 1.6;

  if (completer !== null) return info.price * 1.3;

  if (info.kind === "railroad") {
    return info.price * (1 + 0.15 * countOwnedInGroup(view, view.seat, "railroads"));
  }

  return info.kind === "utility" ? info.price * 0.8 : info.price;
};

const buyChoice = (view: PlayerView, request: DecisionRequest): ReadonlyArray<Command> => {
  const frame = frameAs(view, "BuyChoice");

  if (frame === null) return [command("Decline", answer(request))];

  const price = propertyInfo(frame.property).price;
  const cash = me(view).cash;
  const reserve = reserveFor(view);
  const key = wouldComplete(view, frame.property) !== null;

  if (cash - price >= reserve || (key && cash >= price)) return [command("Buy", answer(request))];

  if (wouldComplete(view, frame.property) !== view.seat)
    return [command("Decline", answer(request))];

  const plan = new Plan(view);
  const commands: Array<Command> = [];
  const sets = new Set(streetsOfCompleteSets(view, view.seat));

  const candidates = ownedIds(view, view.seat)
    .filter((id) => !sets.has(id) && mortgageProblem(plan, view.seat, id) === null)
    .toSorted((left, right) => propertyInfo(left).mortgage - propertyInfo(right).mortgage);

  for (const id of candidates) {
    if (plan.cash(view.seat) >= price) break;

    plan.update(id, { mortgaged: true });
    plan.addCash(view.seat, propertyInfo(id).mortgage);
    commands.push(command("Mortgage", { ...answer(request), property: id }));
  }

  if (plan.cash(view.seat) < price) return [command("Decline", answer(request))];

  return [...commands, command("Buy", answer(request))];
};

const bid = (view: PlayerView, request: DecisionRequest): Command => {
  const auction = frameAs(view, "Auction");
  const building = frameAs(view, "BuildingAuction");
  const pass = command("PassBid", answer(request));
  const reserve = reserveFor(view);

  if (!request.allowed.includes("Bid")) return pass;

  if (auction !== null) {
    const minimum = minimumBid(view, auction);

    const cap = Math.min(
      propertyValue(view, auction.property),
      me(view).cash - reserve / 2,
      liquidationValue(view, view.seat),
    );

    if (cap < minimum) return pass;

    const step = Math.max(5, Math.round(propertyInfo(auction.property).price * 0.05));

    return command("Bid", {
      ...answer(request),
      amount: Math.floor(Math.min(cap, minimum + step)),
    });
  }

  if (building !== null) {
    const minimum = minimumBid(view, building);

    if (minimum > 40 || me(view).cash - minimum - 200 < reserve) return pass;

    return command("Bid", { ...answer(request), amount: minimum });
  }

  return pass;
};

const jailChoice = (view: PlayerView, request: DecisionRequest): Command => {
  const unowned = view.properties.filter((property) => property.owner === null).length;

  const danger = view.properties.some(
    (property) => property.owner !== view.seat && property.owner !== null && property.level >= 3,
  );

  if (unowned >= 6 && !danger) {
    if (request.allowed.includes("UseJailCard")) return command("UseJailCard", answer(request));

    if (
      request.allowed.includes("PayJailFine") &&
      me(view).cash - view.rules.jailFine >= reserveFor(view)
    ) {
      return command("PayJailFine", answer(request));
    }
  }

  return command("RollForDoubles", answer(request));
};

const mortgagedTransfer = (view: PlayerView, request: DecisionRequest): ReadonlyArray<Command> => {
  const frame = frameAs(view, "MortgagedTransfer");
  const reserve = reserveFor(view);
  let cash = me(view).cash;

  return (frame?.properties ?? []).map((property) => {
    const cost = unmortgageCost(property);

    if (cash - cost >= reserve * 1.5) {
      cash -= cost;

      return command("PayOffMortgage", { ...answer(request), property });
    }

    return command("KeepMortgage", { ...answer(request), property });
  });
};

/** Plans even building on owned sets while keeping the reserve. */
const planBuilds = (view: PlayerView, plan: Plan, reserve: number): ReadonlyArray<PropertyId> => {
  const seat = view.seat;
  const built: Array<PropertyId> = [];

  for (let guard = 0; guard < 40; guard += 1) {
    let choice: PropertyId | null = null;
    let best = Number.POSITIVE_INFINITY;

    for (const [rank, group] of BUILD_ORDER.entries()) {
      for (const id of groupMembers(group)) {
        if (plan.cash(seat) - propertyInfo(id).houseCost < reserve) continue;

        if (buildProblem(plan, seat, id) !== null) continue;

        const score = deedState(plan, id).level * 100 + rank;

        if (score < best) {
          best = score;
          choice = id;
        }
      }
    }

    if (choice === null || !plan.build(seat, choice)) break;

    built.push(choice);
  }

  return built;
};

const proposeTrade = (view: PlayerView, request: DecisionRequest, plan: Plan): Command | null => {
  const seat = view.seat;
  const reserve = reserveFor(view);
  const spendable = plan.cash(seat) - reserve;

  for (const group of BUILD_ORDER) {
    const members = groupMembers(group);
    const missing = members.filter((id) => deedState(view, id).owner !== seat);
    const target = missing[0];

    if (missing.length !== 1 || target === undefined) continue;

    const owner = deedState(view, target).owner;

    if (owner === null || owner === seat || tradeProblem(view, owner, target) !== null) continue;

    const get: Assets = { cash: 0, properties: [target], jailCards: 0 };
    const theirBase = tradeGain(view, owner, seat, NOTHING, get);
    const price = Math.ceil(Math.max(0, -theirBase) / 10) * 10 + 10;
    const interest = deedState(view, target).mortgaged ? mortgageInterest(target) : 0;
    const budget = spendable - interest;

    if (price <= budget && tradeGain(view, seat, owner, get, { ...NOTHING, cash: price }) > 0) {
      return command("Offer", {
        ...answer(request),
        to: owner,
        give: { ...NOTHING, cash: price },
        get,
        comment: `Buying ${propertyInfo(target).name} to complete my set.`,
      });
    }

    for (const swap of ownedIds(view, seat)) {
      if (wouldComplete(view, swap) !== owner || tradeProblem(view, seat, swap) !== null) continue;

      const give: Assets = { ...NOTHING, properties: [swap] };
      const theirGain = tradeGain(view, owner, seat, give, get);
      const compensation = theirGain > 0 ? 0 : Math.ceil(-theirGain / 10) * 10 + 10;
      const offered: Assets = { ...give, cash: compensation };

      if (compensation <= budget && tradeGain(view, seat, owner, get, offered) > 0) {
        return command("Offer", {
          ...answer(request),
          to: owner,
          give: offered,
          get,
          comment: `Swap: ${propertyInfo(swap).name} for ${propertyInfo(target).name}, both sets complete.`,
        });
      }
    }
  }

  return null;
};

const raiseFunds = (
  view: PlayerView,
  request: DecisionRequest,
  plan: Plan,
  amount: number,
): ReadonlyArray<Command> => {
  const seat = view.seat;

  if (request.allowed.includes("DeclareBankruptcy") && liquidationValue(plan, seat) < amount) {
    return [command("DeclareBankruptcy", answer(request))];
  }

  const sets = new Set(streetsOfCompleteSets(plan, seat));

  const order = ownedIds(plan, seat).toSorted(
    (left, right) =>
      Number(sets.has(left)) - Number(sets.has(right)) ||
      propertyInfo(left).mortgage - propertyInfo(right).mortgage,
  );

  const commands: Array<Command> = [];

  for (const id of order) {
    if (plan.cash(seat) >= amount) break;

    if (mortgageProblem(plan, seat, id) !== null) continue;

    plan.update(id, { mortgaged: true });
    plan.addCash(seat, propertyInfo(id).mortgage);
    commands.push(command("Mortgage", { ...answer(request), property: id }));
  }

  return commands;
};

const session = (
  view: PlayerView,
  request: DecisionRequest,
  random: () => number,
): ReadonlyArray<Command> => {
  const seat = view.seat;
  const plan = new Plan(view);
  const reserve = reserveFor(view);
  const commands: Array<Command> = [];
  const debt = frameAs(view, "RaiseFunds");
  const isDebtor = debt !== null && debt.debtor === seat;

  const open = view.offers.filter(
    (offer) => offer.status === "open" && offer.from !== seat && (offer.to ?? seat) === seat,
  );

  const best = open
    .flatMap((offer) => {
      const gain = offerGain(view, offer);

      const affordable =
        offer.get.cash <= plan.cash(seat) && offer.give.cash <= cashOf(view, offer.from);

      return gain > 0 && affordable ? [{ offer, gain }] : [];
    })
    .toSorted((left, right) => right.gain - left.gain)[0];

  if (best !== undefined) {
    commands.push(command("Accept", { ...answer(request), offerId: best.offer.id }));
    plan.addCash(seat, best.offer.give.cash - best.offer.get.cash);

    for (const id of best.offer.give.properties) plan.update(id, { owner: seat });

    for (const id of best.offer.get.properties) plan.update(id, { owner: best.offer.from });
  }

  for (const offer of open) {
    if (offer.id === best?.offer.id || offer.to !== seat) continue;

    commands.push(
      command("Reject", { ...answer(request), offerId: offer.id, comment: "Not enough for me." }),
    );
  }

  if (isDebtor) {
    const tail = raiseFunds(view, request, plan, debt.amount);

    if (tail.some((next) => Predicate.isTagged(next, "DeclareBankruptcy"))) return tail;

    return [...commands, ...tail, command("Done", answer(request))];
  }

  if (request.frame === "Table") {
    for (const id of ownedIds(plan, seat).toSorted(
      (left, right) => propertyInfo(right).price - propertyInfo(left).price,
    )) {
      if (plan.cash(seat) - unmortgageCost(id) < reserve * 2) continue;

      if (unmortgageProblem(plan, seat, id) !== null) continue;

      plan.update(id, { mortgaged: false });
      plan.addCash(seat, -unmortgageCost(id));
      commands.push(command("Unmortgage", { ...answer(request), property: id }));
    }

    for (const id of planBuilds(view, plan, reserve)) {
      commands.push(command("Build", { ...answer(request), property: id }));
    }

    const mine = view.offers.some((offer) => offer.status === "open" && offer.from === seat);

    if (request.round === 1 && !mine && random() < 0.35) {
      const offer = proposeTrade(view, request, plan);

      if (offer !== null) commands.push(offer);
    }
  }

  // Leave room for the terminal command within the per-wake limit.
  return [
    ...commands.slice(0, view.rules.maxToolCallsPerWake - 1),
    command("Done", answer(request)),
  ];
};

/** The `heuristic` policy for one seed. */
export const heuristicBot =
  (seed: string): Bot =>
  (view, request) => {
    const random = decisionRandom(seed, request);

    switch (request.frame) {
      case "Table":
      case "RaiseFunds":
        return session(view, request, random);
      case "JailChoice":
        return [jailChoice(view, request)];
      case "BuyChoice":
        return buyChoice(view, request);
      case "Auction":
      case "BuildingAuction":
        return [bid(view, request)];
      case "MortgagedTransfer":
        return mortgagedTransfer(view, request);
    }
  };
