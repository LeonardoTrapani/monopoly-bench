/**
 * `random` policy: plays legal moves chosen at random (deterministic given the seed).
 * A weak baseline that still exercises every command kind, including trades.
 */
import {
  command,
  liquidationValue,
  mortgageProblem,
  propertyInfo,
  sellProblem,
  tradeProblem,
  unmortgageCost,
  unmortgageProblem,
} from "@mb/engine";

import { answer, decisionRandom, frameAs, me, minimumBid, ownedIds, pick, Plan } from "./common.ts";

import type { Bot } from "./common.ts";
import type { Command, DecisionRequest, PlayerView } from "@mb/engine";

type Random = () => number;

const randomOffer = (view: PlayerView, request: DecisionRequest, random: Random, plan: Plan) => {
  const seat = view.seat;

  const opponents = view.players.flatMap((player) =>
    player.seat !== seat && !player.bankrupt ? [player.seat] : [],
  );

  const to = pick(random, opponents);

  if (to === undefined) return null;

  if (random() < 0.5) {
    const mine = ownedIds(plan, seat).filter((id) => tradeProblem(plan, seat, id) === null);
    const give = pick(random, mine);

    if (give === undefined) return null;

    const price = Math.round(propertyInfo(give).price * (0.5 + random()));

    const base = {
      ...answer(request),
      give: { cash: 0, properties: [give], jailCards: 0 },
      get: { cash: price, properties: [], jailCards: 0 },
      comment: "Random sale.",
    };

    return random() < 0.5 ? command("Offer", base) : command("Offer", { ...base, to });
  }

  const theirs = ownedIds(plan, to).filter((id) => tradeProblem(plan, to, id) === null);
  const get = pick(random, theirs);

  if (get === undefined) return null;

  const cash = Math.min(plan.cash(seat), Math.round(propertyInfo(get).price * (0.8 + random())));

  return command("Offer", {
    ...answer(request),
    to,
    give: { cash, properties: [], jailCards: 0 },
    get: { cash: 0, properties: [get], jailCards: 0 },
  });
};

const randomSession = (view: PlayerView, request: DecisionRequest, random: Random) => {
  const seat = view.seat;
  const allowed = request.allowed;
  const plan = new Plan(view);
  const commands: Array<Command> = [];
  const debt = frameAs(view, "RaiseFunds");
  const isDebtor = debt !== null && debt.debtor === seat;

  for (const offer of view.offers) {
    if (offer.status !== "open" || offer.from === seat) continue;

    if (offer.to !== null && offer.to !== seat) continue;

    const roll = random();

    if (roll < 0.25 && allowed.includes("Accept")) {
      commands.push(command("Accept", { ...answer(request), offerId: offer.id }));
    } else if (roll < 0.5 && offer.to === seat && allowed.includes("Reject")) {
      commands.push(command("Reject", { ...answer(request), offerId: offer.id, comment: "No." }));
    }
  }

  if (allowed.includes("Build") && random() < 0.5) {
    const streets = ownedIds(plan, seat).filter((id) => propertyInfo(id).kind === "street");

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const target = pick(random, streets);

      if (target !== undefined && plan.build(seat, target)) {
        commands.push(command("Build", { ...answer(request), property: target }));
      }
    }
  }

  if (allowed.includes("Mortgage") && random() < (isDebtor ? 0.8 : 0.1)) {
    const target = pick(
      random,
      ownedIds(plan, seat).filter((id) => mortgageProblem(plan, seat, id) === null),
    );

    if (target !== undefined) {
      plan.update(target, { mortgaged: true });
      plan.addCash(seat, propertyInfo(target).mortgage);
      commands.push(command("Mortgage", { ...answer(request), property: target }));
    }
  }

  if (allowed.includes("SellBuilding") && random() < (isDebtor ? 0.5 : 0.05)) {
    const target = pick(
      random,
      ownedIds(plan, seat).filter((id) => sellProblem(plan, seat, id) === null),
    );

    if (target !== undefined) {
      commands.push(command("SellBuilding", { ...answer(request), property: target }));
    }
  }

  if (allowed.includes("Unmortgage") && random() < 0.1) {
    const target = pick(
      random,
      ownedIds(plan, seat).filter((id) => unmortgageProblem(plan, seat, id) === null),
    );

    if (target !== undefined) {
      plan.update(target, { mortgaged: false });
      plan.addCash(seat, -unmortgageCost(target));
      commands.push(command("Unmortgage", { ...answer(request), property: target }));
    }
  }

  if (allowed.includes("Offer") && request.round === 1 && random() < 0.08) {
    const offer = randomOffer(view, request, random, plan);

    if (offer !== null) commands.push(offer);
  }

  if (isDebtor && allowed.includes("DeclareBankruptcy") && random() < 0.3) {
    return [...commands, command("DeclareBankruptcy", answer(request))];
  }

  return [...commands, command("Done", answer(request))];
};

const randomBid = (view: PlayerView, request: DecisionRequest, random: Random): Command => {
  const auction = frameAs(view, "Auction");
  const building = frameAs(view, "BuildingAuction");
  const frame = auction ?? building;

  if (frame === null || !request.allowed.includes("Bid")) {
    return command("PassBid", answer(request));
  }

  const amount = minimumBid(view, frame) + Math.floor(random() * 40);
  const limit = auction === null ? me(view).cash - 400 : liquidationValue(view, view.seat);

  if (amount <= limit && random() < (request.round === 1 ? 0.5 : 0.35)) {
    return command("Bid", { ...answer(request), amount });
  }

  return command("PassBid", answer(request));
};

const randomMortgaged = (view: PlayerView, request: DecisionRequest, random: Random) => {
  const frame = frameAs(view, "MortgagedTransfer");
  let cash = me(view).cash;

  return (frame?.properties ?? []).map((property) => {
    const cost = unmortgageCost(property);

    if (cash >= cost && random() < 0.4) {
      cash -= cost;

      return command("PayOffMortgage", { ...answer(request), property });
    }

    return command("KeepMortgage", { ...answer(request), property });
  });
};

/** The `random` policy for one seed. */
export const randomBot =
  (seed: string): Bot =>
  (view, request) => {
    const random = decisionRandom(seed, request);

    switch (request.frame) {
      case "Table":
      case "RaiseFunds":
        return randomSession(view, request, random);
      case "JailChoice": {
        const kind = pick(random, request.allowed) ?? "RollForDoubles";

        return [
          kind === "PayJailFine" || kind === "UseJailCard"
            ? command(kind, answer(request))
            : command("RollForDoubles", answer(request)),
        ];
      }

      case "BuyChoice":
        return [
          request.allowed.includes("Buy") && random() < 0.6
            ? command("Buy", answer(request))
            : command("Decline", answer(request)),
        ];
      case "Auction":
      case "BuildingAuction":
        return [randomBid(view, request, random)];
      case "MortgagedTransfer":
        return randomMortgaged(view, request, random);
    }
  };
