/**
 * Session drafts (SPEC §4.3) and offers (SPEC §5.4): validation when a draft is
 * submitted (against the round snapshot plus the seat's own drafts), re-validation and
 * application at round close in fixed order, and the wake rules of SPEC §5.3.
 */
import { Predicate } from "effect";

import { propertyInfo } from "./data/board.ts";
import { activeSeats, effectiveFollows, fixedOrder, hasSeat, player } from "./access.ts";
import { Machine, task } from "./machine.ts";
import {
  buildProblem,
  mortgageInterest,
  mortgageProblem,
  sellChanges,
  sellProblem,
  tradeProblem,
  unmortgageCost,
  unmortgageProblem,
} from "./rules.ts";
import { DraftCommand } from "./schema/commands.ts";

import type { CommandOf } from "./schema/commands.ts";
import type {
  Assets,
  BuildingKind,
  GroupId,
  PropertyId,
  Seat,
  SeatReasons,
  WakeReason,
} from "./schema/common.ts";
import type { GameEvent } from "./schema/events.ts";
import type { FrameOf, GameState, Offer } from "./schema/state.ts";

export type SessionFrame = FrameOf<"Table"> | FrameOf<"RaiseFunds">;

const isEmpty = (assets: Assets): boolean =>
  assets.cash === 0 && assets.properties.length === 0 && assets.jailCards === 0;

const interestOn = (state: GameState, ids: ReadonlyArray<PropertyId>): number => {
  let total = 0;

  for (const id of ids) {
    if (state.properties[propertyInfo(id).index]?.mortgaged === true) total += mortgageInterest(id);
  }

  return total;
};

export const sessionOffer = (
  state: GameState,
  session: number,
  offerId: number,
): Offer | undefined =>
  state.offers.find((offer) => offer.id === offerId && offer.session === session);

const counterpartyProblem = (
  state: GameState,
  seat: Seat,
  to: Seat | undefined,
  get: Assets,
): string | null => {
  if (to !== undefined) {
    for (const id of get.properties) {
      const problem = tradeProblem(state, to, id);

      if (problem !== null) return problem;
    }

    return get.jailCards > player(state, to).jailCards.length
      ? `${to} does not hold ${get.jailCards} Get Out of Jail Free card(s)`
      : null;
  }

  const owners = new Set<Seat>();

  for (const id of get.properties) {
    const owner = state.properties[propertyInfo(id).index]?.owner ?? null;

    if (owner === null || owner === seat) {
      return `${propertyInfo(id).name} is not owned by another player`;
    }

    const problem = tradeProblem(state, owner, id);

    if (problem !== null) return problem;

    owners.add(owner);
  }

  return owners.size > 1 ? "an open offer may only ask for deeds of a single owner" : null;
};

/** Reason `seat` may not post `offer` in session `session`, or null. */
export const offerProblem = (
  state: GameState,
  seat: Seat,
  offer: CommandOf<"Offer">,
  session: number,
): string | null => {
  const rules = state.config.rules;
  const proposer = player(state, seat);

  if (offer.to !== undefined) {
    if (offer.to === seat) return "you cannot make an offer to yourself";

    if (!hasSeat(state, offer.to) || player(state, offer.to).bankrupt) {
      return `${offer.to} is not in the game`;
    }
  }

  if (isEmpty(offer.give) && isEmpty(offer.get)) return "an offer must contain something";

  const listed = [...offer.give.properties, ...offer.get.properties];

  if (new Set(listed).size !== listed.length) return "a property appears twice in the offer";

  for (const id of offer.give.properties) {
    const problem = tradeProblem(state, seat, id);

    if (problem !== null) return problem;
  }

  if (offer.give.cash > proposer.cash) return `you only have $${proposer.cash}`;

  if (offer.give.jailCards > proposer.jailCards.length) {
    return `you hold ${proposer.jailCards.length} Get Out of Jail Free card(s)`;
  }

  const counterparty = counterpartyProblem(state, seat, offer.to, offer.get);

  if (counterparty !== null) return counterparty;

  if ((offer.comment ?? "").length > rules.commentMaxChars) {
    return `comment longer than ${rules.commentMaxChars} characters`;
  }

  if (offer.replyTo !== undefined && sessionOffer(state, session, offer.replyTo) === undefined) {
    return `offer ${offer.replyTo} does not exist in this session`;
  }

  const cashAfter = proposer.cash - offer.give.cash + offer.get.cash;

  if (cashAfter < interestOn(state, offer.get.properties)) {
    return "you could not pay the 10% interest on the mortgaged deeds you would receive";
  }

  return null;
};

export interface AcceptFailure {
  readonly reason: string;
  /** `acceptor`: only this acceptance fails; otherwise the offer itself is dead. */
  readonly side: "offer" | "proposer" | "acceptor";
}

const failure = (reason: string, side: AcceptFailure["side"]): AcceptFailure => ({
  reason,
  side,
});

const sideProblem = (state: GameState, seat: Seat, assets: Assets): string | null => {
  const holder = player(state, seat);

  if (holder.bankrupt) return `${seat} is bankrupt`;

  for (const id of assets.properties) {
    const problem = tradeProblem(state, seat, id);

    if (problem !== null) return problem;
  }

  if (assets.cash > holder.cash) return `${seat} only has $${holder.cash}`;

  return assets.jailCards > holder.jailCards.length
    ? `${seat} lacks Get Out of Jail Free cards`
    : null;
};

/** Why `seat` may not accept `offer` now, or null. */
export const acceptProblem = (state: GameState, seat: Seat, offer: Offer): AcceptFailure | null => {
  if (offer.status !== "open") return failure("the offer is no longer open", "offer");

  if (offer.from === seat) return failure("you cannot accept your own offer", "acceptor");

  if (offer.to !== null && offer.to !== seat) {
    return failure(`the offer is addressed to ${offer.to}`, "acceptor");
  }

  const proposer = sideProblem(state, offer.from, offer.give);

  if (proposer !== null) return failure(proposer, "proposer");

  const acceptor = sideProblem(state, seat, offer.get);

  if (acceptor !== null) return failure(acceptor, "acceptor");

  const proposerCash = player(state, offer.from).cash - offer.give.cash + offer.get.cash;

  if (proposerCash < interestOn(state, offer.get.properties)) {
    return failure(`${offer.from} could not pay the interest on mortgaged deeds`, "proposer");
  }

  const acceptorCash = player(state, seat).cash - offer.get.cash + offer.give.cash;

  if (acceptorCash < interestOn(state, offer.give.properties)) {
    return failure("you could not pay the interest on the mortgaged deeds received", "acceptor");
  }

  return null;
};

const respondProblem = (state: GameState, frame: SessionFrame, seat: Seat, offerId: number) => {
  const offer = sessionOffer(state, frame.id, offerId);

  if (offer === undefined || offer.status !== "open") return `offer ${offerId} is not open`;

  if (offer.from === seat) return "you cannot answer your own offer";

  return offer.to !== null && offer.to !== seat ? `offer ${offerId} is not addressed to you` : null;
};

const withdrawProblem = (state: GameState, frame: SessionFrame, seat: Seat, offerId: number) => {
  const offer = sessionOffer(state, frame.id, offerId);

  if (offer === undefined || offer.status !== "open") return `offer ${offerId} is not open`;

  return offer.from === seat ? null : "you can only withdraw your own offers";
};

const messageProblem = (
  state: GameState,
  frame: SessionFrame,
  seat: Seat,
  message: CommandOf<"Message">,
) => {
  const offer = sessionOffer(state, frame.id, message.offerId);
  const limit = state.config.rules.commentMaxChars;

  if (message.text.trim().length === 0) return "empty message";

  if (message.text.length > limit) return `message longer than ${limit} characters`;

  if (offer === undefined) return `offer ${message.offerId} does not exist in this session`;

  return offer.from === seat || offer.to === seat || offer.to === null
    ? null
    : "you are not a party of this offer";
};

const rejectProblem = (state: GameState, frame: SessionFrame, reject: CommandOf<"Reject">) => {
  const limit = state.config.rules.commentMaxChars;

  if ((reject.comment ?? "").length > limit) return `comment longer than ${limit} characters`;

  return respondProblem(state, frame, reject.seat, reject.offerId);
};

/** Counts this seat's drafts of a kind in the current round of `frame`. */
const countDrafts = (
  state: GameState,
  frame: SessionFrame,
  seat: Seat,
  kind: "Offer" | "Message",
) =>
  state.drafts.filter(
    (draft) =>
      draft.frame === frame.id &&
      draft.round === frame.round &&
      draft.seat === seat &&
      Predicate.isTagged(draft.command, kind),
  ).length;

/** State after applying `seat`'s own drafts of the current round (SPEC §4.3 step 2). */
export const projectDrafts = (state: GameState, frame: SessionFrame, seat: Seat): GameState => {
  const own = state.drafts.filter(
    (draft) => draft.frame === frame.id && draft.round === frame.round && draft.seat === seat,
  );

  if (own.length === 0) return state;

  const sandbox = new Machine(state);

  for (const draft of own) applyDraft(sandbox, frame, draft.seat, draft.command, null);

  return sandbox.state;
};

/** Reason a session draft is illegal now, or null (validated on the projected state). */
export const draftProblem = (
  state: GameState,
  frame: SessionFrame,
  seat: Seat,
  command: DraftCommand,
): string | null => {
  const rules = state.config.rules;
  const projected = projectDrafts(state, frame, seat);

  return DraftCommand.match(command, {
    Build: (build) => buildProblem(projected, seat, build.property),
    SellBuilding: (sale) => sellProblem(projected, seat, sale.property),
    Mortgage: (mortgage) => mortgageProblem(projected, seat, mortgage.property),
    Unmortgage: (unmortgage) => unmortgageProblem(projected, seat, unmortgage.property),
    Offer: (offer) =>
      countDrafts(state, frame, seat, "Offer") >= rules.maxOffersPerRound
        ? `at most ${rules.maxOffersPerRound} new offers per round`
        : offerProblem(projected, seat, offer, frame.id),
    Accept: (accept) => {
      const offer = sessionOffer(projected, frame.id, accept.offerId);

      if (offer === undefined) return `offer ${accept.offerId} does not exist in this session`;

      return acceptProblem(projected, seat, offer)?.reason ?? null;
    },
    Reject: (reject) => rejectProblem(projected, frame, reject),
    Withdraw: (withdraw) => withdrawProblem(projected, frame, seat, withdraw.offerId),
    Message: (message) =>
      countDrafts(state, frame, seat, "Message") >= rules.maxMessagesPerRound
        ? `at most ${rules.maxMessagesPerRound} messages per round`
        : messageProblem(projected, frame, seat, message),
    Bid: () => "bids belong to auctions",
    PassBid: () => "bids belong to auctions",
  });
};

/** Scarce building units won at the shortage auction, consumed as builds are applied. */
export class CreditBook {
  private readonly units = new Map<string, number>();

  constructor(
    readonly contested: ReadonlyArray<BuildingKind>,
    credits: ReadonlyArray<{
      readonly seat: Seat;
      readonly kind: BuildingKind;
      readonly units: number;
    }>,
  ) {
    for (const credit of credits) {
      const key = `${credit.seat}:${credit.kind}`;

      this.units.set(key, (this.units.get(key) ?? 0) + credit.units);
    }
  }

  /** Takes one unit of `kind` for `seat`; true when the build may proceed. */
  take(seat: Seat, kind: BuildingKind): boolean {
    if (!this.contested.includes(kind)) return true;

    const key = `${seat}:${kind}`;
    const left = this.units.get(key) ?? 0;

    if (left <= 0) return false;

    this.units.set(key, left - 1);

    return true;
  }
}

/** Emits the sale of one level on `id` (with hotel shortage cascades) as one event. */
export const sellOneLevel = (machine: Machine, seat: Seat, id: PropertyId): void => {
  const changes = sellChanges(machine.state, id);
  let proceeds = 0;

  for (const change of changes) proceeds += change.proceeds;

  machine.emit("BuildingSold", {
    seat,
    property: id,
    changes: changes.map((change) => ({
      property: change.property,
      from: change.from,
      to: change.to,
    })),
    proceeds,
  });
};

const drop = (
  machine: Machine,
  frame: SessionFrame,
  seat: Seat,
  command: DraftCommand,
  reason: string,
) => machine.emit("ActionDropped", { frameId: frame.id, seat, command, reason });

const executeTrade = (machine: Machine, seat: Seat, offer: Offer): void => {
  const state = machine.state;

  const mortgagedIn = (ids: ReadonlyArray<PropertyId>) =>
    ids.filter((id) => state.properties[propertyInfo(id).index]?.mortgaged === true);

  const toAcceptor = mortgagedIn(offer.give.properties);
  const toProposer = mortgagedIn(offer.get.properties);

  machine.emit("TradeExecuted", {
    offerId: offer.id,
    from: offer.from,
    to: seat,
    give: offer.give,
    get: offer.get,
  });

  if (toAcceptor.length > 0) {
    machine.queue.push(task("ResolveMortgaged", { seat, properties: toAcceptor }));
  }

  if (toProposer.length > 0) {
    machine.queue.push(task("ResolveMortgaged", { seat: offer.from, properties: toProposer }));
  }
};

/**
 * Applies one draft at round close (or on a sandbox when projecting). Each draft is
 * re-validated and dropped with `ActionDropped` / `OfferInvalidated` when it no
 * longer holds. `credits` is null outside a building shortage.
 */
export const applyDraft = (
  machine: Machine,
  frame: SessionFrame,
  seat: Seat,
  command: DraftCommand,
  credits: CreditBook | null,
): void => {
  const state = machine.state;

  DraftCommand.match(command, {
    Build: (build) => {
      const level = state.properties[propertyInfo(build.property).index]?.level ?? 0;
      const problem = buildProblem(state, seat, build.property);

      if (problem !== null) return drop(machine, frame, seat, command, problem);

      if (credits !== null && !credits.take(seat, level === 4 ? "hotel" : "house")) {
        return drop(
          machine,
          frame,
          seat,
          command,
          "no scarce building won at the shortage auction",
        );
      }

      machine.emit("BuildingBuilt", {
        seat,
        property: build.property,
        level: level + 1,
        cost: propertyInfo(build.property).houseCost,
      });
    },
    SellBuilding: (sale) => {
      const problem = sellProblem(state, seat, sale.property);

      if (problem !== null) return drop(machine, frame, seat, command, problem);

      sellOneLevel(machine, seat, sale.property);
    },
    Mortgage: (mortgage) => {
      const problem = mortgageProblem(state, seat, mortgage.property);

      if (problem !== null) return drop(machine, frame, seat, command, problem);

      machine.emit("PropertyMortgaged", {
        seat,
        property: mortgage.property,
        amount: propertyInfo(mortgage.property).mortgage,
      });
    },
    Unmortgage: (unmortgage) => {
      const problem = unmortgageProblem(state, seat, unmortgage.property);

      if (problem !== null) return drop(machine, frame, seat, command, problem);

      machine.emit("PropertyUnmortgaged", {
        seat,
        property: unmortgage.property,
        amount: unmortgageCost(unmortgage.property),
      });
    },
    Offer: (offer) => {
      const problem = offerProblem(state, seat, offer, frame.id);

      if (problem !== null) return drop(machine, frame, seat, command, problem);

      const id = state.nextOfferId;

      const parent =
        offer.replyTo === undefined ? undefined : sessionOffer(state, frame.id, offer.replyTo);

      machine.emit("OfferPosted", {
        offer: {
          id,
          session: frame.id,
          from: seat,
          to: offer.to ?? null,
          give: offer.give,
          get: offer.get,
          comment: offer.comment ?? null,
          replyTo: parent?.id ?? null,
          thread: parent?.thread ?? id,
          round: frame.round,
          status: "open",
          rejectedBy: [],
          messages: [],
        },
      });
    },
    Accept: (accept) => {
      const offer = sessionOffer(state, frame.id, accept.offerId);

      if (offer === undefined) {
        return drop(machine, frame, seat, command, `offer ${accept.offerId} does not exist`);
      }

      const problem = acceptProblem(state, seat, offer);

      if (problem !== null) {
        return machine.emit("OfferInvalidated", {
          offerId: offer.id,
          seat,
          reason: problem.reason,
          closed: problem.side !== "acceptor" && offer.status === "open",
        });
      }

      executeTrade(machine, seat, offer);
    },
    Reject: (reject) => {
      const problem = rejectProblem(state, frame, reject);

      if (problem !== null) return drop(machine, frame, seat, command, problem);

      machine.emit("OfferRejected", {
        offerId: reject.offerId,
        seat,
        comment: reject.comment ?? null,
      });
    },
    Withdraw: (withdraw) => {
      const problem = withdrawProblem(state, frame, seat, withdraw.offerId);

      if (problem !== null) return drop(machine, frame, seat, command, problem);

      machine.emit("OfferWithdrawn", { offerId: withdraw.offerId, seat });
    },
    Message: (message) => {
      const problem = messageProblem(state, frame, seat, message);

      if (problem !== null) return drop(machine, frame, seat, command, problem);

      machine.emit("OfferMessage", {
        offerId: message.offerId,
        seat,
        text: message.text,
        round: frame.round,
      });
    },
    Bid: () => drop(machine, frame, seat, command, "bids belong to auctions"),
    PassBid: () => drop(machine, frame, seat, command, "bids belong to auctions"),
  });
};

const groupsOf = (offer: Offer): ReadonlySet<GroupId> =>
  new Set([...offer.give.properties, ...offer.get.properties].map((id) => propertyInfo(id).group));

const threadParticipants = (state: GameState, offer: Offer): ReadonlySet<Seat> => {
  const seats = new Set<Seat>();

  for (const candidate of state.offers) {
    if (candidate.session !== offer.session || candidate.thread !== offer.thread) continue;

    seats.add(candidate.from);

    if (candidate.to !== null) seats.add(candidate.to);
  }

  return seats;
};

/**
 * Seats to wake in the next round of a session, from what happened while closing the
 * previous one (SPEC §5.3), in fixed order. The RaiseFunds debtor is always woken.
 */
export const computeWake = (
  state: GameState,
  frame: SessionFrame,
  closeEvents: ReadonlyArray<GameEvent>,
): ReadonlyArray<SeatReasons> => {
  const reasons = new Map<Seat, Set<WakeReason>>();
  const active = activeSeats(state);

  const add = (seat: Seat, reason: WakeReason) => {
    if (!active.includes(seat)) return;

    const set = reasons.get(seat) ?? new Set<WakeReason>();

    set.add(reason);
    reasons.set(seat, set);
  };

  for (const event of closeEvents) {
    if (Predicate.isTagged(event, "OfferPosted")) {
      const offer = event.offer;
      const groups = groupsOf(offer);

      if (offer.to !== null) add(offer.to, "addressed");
      else for (const seat of active) if (seat !== offer.from) add(seat, "openCall");

      for (const seat of threadParticipants(state, offer)) {
        if (seat !== offer.from) add(seat, "inThread");
      }

      for (const seat of active) {
        if (seat === offer.from) continue;

        if (effectiveFollows(state, seat).some((group) => groups.has(group))) {
          add(seat, "follows");
        }
      }
    }

    if (Predicate.isTagged(event, "OfferRejected")) {
      const offer = sessionOffer(state, frame.id, event.offerId);

      if (offer !== undefined && offer.from !== event.seat) add(offer.from, "addressed");
    }

    if (Predicate.isTagged(event, "OfferMessage")) {
      const offer = sessionOffer(state, frame.id, event.offerId);

      if (offer === undefined) continue;

      if (event.seat !== offer.from) add(offer.from, "addressed");
      else if (offer.to !== null) add(offer.to, "addressed");
      else {
        for (const seat of threadParticipants(state, offer)) {
          if (seat !== event.seat) add(seat, "addressed");
        }
      }
    }
  }

  if (Predicate.isTagged(frame, "RaiseFunds")) add(frame.debtor, "debtor");

  return fixedOrder(state).flatMap((seat) => {
    const set = reasons.get(seat);

    return set === undefined ? [] : [{ seat, reasons: [...set] }];
  });
};

/** Whether `seat` used a trade command in the current round of `frame`. */
export const tradedThisRound = (state: GameState, frame: SessionFrame, seat: Seat): boolean =>
  state.drafts.some(
    (draft) =>
      draft.frame === frame.id &&
      draft.round === frame.round &&
      draft.seat === seat &&
      (Predicate.isTagged(draft.command, "Offer") ||
        Predicate.isTagged(draft.command, "Accept") ||
        Predicate.isTagged(draft.command, "Reject") ||
        Predicate.isTagged(draft.command, "Withdraw") ||
        Predicate.isTagged(draft.command, "Message")),
  );
