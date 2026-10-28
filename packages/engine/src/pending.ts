/** `pending(state)`: who must act now, with legal command kinds and a one-line question. */
import { Predicate } from "effect";

import { GROUP_NAMES, propertyInfo } from "./data/board.ts";
import { player, topFrame } from "./access.ts";
import { awaitedSeats, decisionIdFor, frameRound } from "./decisions.ts";
import {
  BID_KINDS,
  BUY_KINDS,
  CREDITOR_SIDE_KINDS,
  DEBTOR_KINDS,
  JAIL_KINDS,
  MORTGAGED_KINDS,
  TABLE_KINDS,
} from "./kinds.ts";
import {
  buildProblem,
  liquidationValue,
  mortgageProblem,
  sellProblem,
  unmortgageCost,
  unmortgageProblem,
} from "./rules.ts";
import { Frame } from "./schema/state.ts";
import { standings } from "./standings.ts";

import type { CommandKind } from "./schema/commands.ts";
import type { PropertyId, Seat, WakeReason } from "./schema/common.ts";
import type { FrameOf, GameState } from "./schema/state.ts";
import type { DecisionRequest, Pending } from "./schema/views.ts";

type PendingOf<K extends Pending["_tag"]> = Extract<Pending, { readonly _tag: K }>;

const pendingValue = <K extends Pending["_tag"]>(
  tag: K,
  input: Omit<PendingOf<K>, "_tag">,
): PendingOf<K> => {
  const value = { _tag: tag, ...input };

  // SAFETY: `input` is variant `K` without its tag, which is added back here.
  return value as PendingOf<K>;
};

const anyDeed = (
  state: GameState,
  seat: Seat,
  problem: (state: GameState, seat: Seat, id: PropertyId) => string | null,
): boolean =>
  state.properties.some(
    (property) => property.owner === seat && problem(state, seat, property.id) === null,
  );

const managementKinds = (
  state: GameState,
  seat: Seat,
  kinds: ReadonlyArray<CommandKind>,
): ReadonlyArray<CommandKind> =>
  kinds.filter((kind) => {
    switch (kind) {
      case "Build":
        return anyDeed(state, seat, buildProblem);
      case "SellBuilding":
        return anyDeed(state, seat, sellProblem);
      case "Mortgage":
        return anyDeed(state, seat, mortgageProblem);
      case "Unmortgage":
        return anyDeed(state, seat, unmortgageProblem);
      default:
        return true;
    }
  });

const offerKinds = (
  state: GameState,
  session: number,
  seat: Seat,
  kinds: ReadonlyArray<CommandKind>,
): ReadonlyArray<CommandKind> => {
  const offers = state.offers.filter((offer) => offer.session === session);

  const answerable = offers.some(
    (offer) =>
      offer.status === "open" && offer.from !== seat && (offer.to === null || offer.to === seat),
  );

  const own = offers.some((offer) => offer.status === "open" && offer.from === seat);

  const party = offers.some(
    (offer) => offer.from === seat || offer.to === seat || offer.to === null,
  );

  return kinds.filter((kind) => {
    switch (kind) {
      case "Accept":
      case "Reject":
        return answerable;
      case "Withdraw":
        return own;
      case "Message":
        return party;
      default:
        return true;
    }
  });
};

const sessionAllowed = (
  state: GameState,
  frame: FrameOf<"Table"> | FrameOf<"RaiseFunds">,
  seat: Seat,
): ReadonlyArray<CommandKind> => {
  if (Predicate.isTagged(frame, "Table")) {
    return offerKinds(state, frame.id, seat, managementKinds(state, seat, TABLE_KINDS));
  }

  const kinds =
    frame.debtor === seat
      ? DEBTOR_KINDS.filter(
          (kind) => kind !== "DeclareBankruptcy" || liquidationValue(state, seat) < frame.amount,
        )
      : CREDITOR_SIDE_KINDS;

  return offerKinds(state, frame.id, seat, managementKinds(state, seat, kinds));
};

const minimumBid = (state: GameState, frame: FrameOf<"Auction"> | FrameOf<"BuildingAuction">) =>
  frame.high === null
    ? state.config.rules.auctionMinOpening
    : frame.high.amount + state.config.rules.auctionMinRaise;

const allowedKinds = (state: GameState, frame: Frame, seat: Seat): ReadonlyArray<CommandKind> =>
  Frame.match(frame, {
    Table: (current) => sessionAllowed(state, current, seat),
    RaiseFunds: (current) => sessionAllowed(state, current, seat),
    JailChoice: () => {
      const current = player(state, seat);

      return JAIL_KINDS.filter(
        (kind) =>
          (kind !== "PayJailFine" || current.cash >= state.config.rules.jailFine) &&
          (kind !== "UseJailCard" || current.jailCards.length > 0),
      );
    },
    BuyChoice: (current) =>
      managementKinds(state, seat, BUY_KINDS).filter(
        (kind) =>
          kind !== "Buy" || player(state, seat).cash >= propertyInfo(current.property).price,
      ),
    Auction: (current) =>
      BID_KINDS.filter(
        (kind) => kind !== "Bid" || liquidationValue(state, seat) >= minimumBid(state, current),
      ),
    BuildingAuction: (current) =>
      BID_KINDS.filter(
        (kind) => kind !== "Bid" || player(state, seat).cash >= minimumBid(state, current),
      ),
    MortgagedTransfer: (current) =>
      MORTGAGED_KINDS.filter(
        (kind) =>
          kind !== "PayOffMortgage" ||
          current.properties.some((id) => player(state, seat).cash >= unmortgageCost(id)),
      ),
  });

const terminalKinds = (frame: Frame, seat: Seat): ReadonlyArray<CommandKind> =>
  Frame.match(frame, {
    Table: (): ReadonlyArray<CommandKind> => ["Done"],
    RaiseFunds: (current): ReadonlyArray<CommandKind> =>
      current.debtor === seat ? ["Done", "DeclareBankruptcy"] : ["Done"],
    JailChoice: () => JAIL_KINDS,
    BuyChoice: (): ReadonlyArray<CommandKind> => ["Buy", "Decline"],
    Auction: () => BID_KINDS,
    BuildingAuction: () => BID_KINDS,
    MortgagedTransfer: () => MORTGAGED_KINDS,
  });

const reasonsFor = (frame: Frame, seat: Seat): ReadonlyArray<WakeReason> => {
  const fromList = (current: {
    readonly reasons: ReadonlyArray<{
      readonly seat: Seat;
      readonly reasons: ReadonlyArray<WakeReason>;
    }>;
  }) => current.reasons.find((entry) => entry.seat === seat)?.reasons ?? [];

  return Frame.match(frame, {
    Table: fromList,
    RaiseFunds: fromList,
    JailChoice: (): ReadonlyArray<WakeReason> => ["active"],
    BuyChoice: (): ReadonlyArray<WakeReason> => ["active"],
    Auction: fromList,
    BuildingAuction: fromList,
    MortgagedTransfer: (): ReadonlyArray<WakeReason> => ["active"],
  });
};

const REASON_TEXT: Readonly<Record<WakeReason, string>> = {
  opening: "the table opened",
  addressed: "something was addressed to you",
  inThread: "a new offer in a thread you are part of",
  follows: "a new offer involves a group you follow",
  openCall: "a new open offer",
  debtor: "you owe money",
  bidder: "you are bidding",
  active: "your decision",
};

const creditorName = (creditor: Seat | "bank") => (creditor === "bank" ? "the bank" : creditor);

const questionFor = (state: GameState, frame: Frame, seat: Seat): string => {
  const rules = state.config.rules;
  const cash = player(state, seat).cash;

  return Frame.match(frame, {
    Table: (current) =>
      current.round === 1
        ? `Turn ${state.control.turn}: the table is open before ${state.control.activeSeat}'s roll. Build, sell, mortgage, unmortgage or trade, then end your round with done.`
        : `Table round ${current.round} of at most ${rules.maxTableRounds} (${reasonsFor(
            current,
            seat,
          )
            .map((reason) => REASON_TEXT[reason])
            .join("; ")}): answer offers or trade, then done.`,
    RaiseFunds: (current) => {
      const owed = current.amount;
      const debtor = player(state, current.debtor);

      return current.debtor === seat
        ? `You owe $${owed} (${current.reason}) to ${creditorName(current.creditor)} but have $${cash}: raise $${owed - cash} by selling buildings, mortgaging or trading, then done (whatever is still missing is raised automatically, or you go bankrupt).`
        : `${current.debtor} must raise $${owed - debtor.cash} to pay ${creditorName(current.creditor)}. Round ${current.round}: answer or make offers, then done.`;
    },
    JailChoice: () =>
      `You are in jail (attempt ${player(state, seat).jailAttempts + 1} of 3): pay the $${rules.jailFine} fine, use a Get Out of Jail Free card, or roll for doubles.`,
    BuyChoice: (current) => {
      const info = propertyInfo(current.property);

      return `You landed on ${info.name} (${GROUP_NAMES[info.group]}), unowned: buy it for $${info.price} (you have $${cash}), or decline and it is auctioned.`;
    },
    Auction: (current) => {
      const info = propertyInfo(current.property);

      const high =
        current.high === null
          ? "no bids yet"
          : `high bid $${current.high.amount} by ${current.high.seat}`;

      return `Auction for ${info.name} (list price $${info.price}), round ${current.round}: ${high}. Bid at least $${minimumBid(state, current)} or pass (passing leaves the auction).`;
    },
    BuildingAuction: (current) => {
      const high =
        current.high === null
          ? "no bids yet"
          : `high premium $${current.high.amount} by ${current.high.seat}`;

      return `Building shortage: ${current.unitsLeft} ${current.kind}(s) for more requests than supply. Bid a premium (paid on top of the building cost) of at least $${minimumBid(state, current)} for one ${current.kind}, or pass; ${high}.`;
    },
    MortgagedTransfer: (current) =>
      `You received mortgaged ${current.properties
        .map((id) => propertyInfo(id).name)
        .join(
          ", ",
        )}: for each deed, keep the mortgage (pay 10% interest now) or pay it off (mortgage + 10%).`,
  });
};

const requestFor = (state: GameState, frame: Frame, seat: Seat): DecisionRequest => ({
  decisionId: decisionIdFor(frame, seat),
  seat,
  frame: frame._tag,
  frameId: frame.id,
  round: frameRound(frame),
  turn: state.control.turn,
  reasons: reasonsFor(frame, seat),
  allowed: allowedKinds(state, frame, seat),
  terminal: terminalKinds(frame, seat),
  question: questionFor(state, frame, seat),
});

/** The pending decision of one seat, if it must act now. */
export const requestOf = (state: GameState, seat: Seat): DecisionRequest | null => {
  const frame = topFrame(state);

  if (state.status !== "playing" || frame === undefined) return null;

  return awaitedSeats(frame).includes(seat) ? requestFor(state, frame, seat) : null;
};

/**
 * Who must act now (SPEC §4.1). In a round every listed seat acts simultaneously;
 * single-actor frames list one seat. A finished game reports the final standings.
 */
export const pending = (state: GameState): Pending => {
  if (state.status === "finished") {
    return pendingValue("Finished", {
      reason: state.endReason,
      winner: state.winner,
      standings: standings(state),
    });
  }

  const frame = topFrame(state);

  if (frame === undefined) return pendingValue("Waiting", { requests: [] });

  return pendingValue("Waiting", {
    requests: awaitedSeats(frame).map((seat) => requestFor(state, frame, seat)),
  });
};

/** Seats that must act now, without building full requests (cheap). */
export const pendingSeats = (state: GameState): ReadonlyArray<Seat> => {
  const frame = topFrame(state);

  return state.status !== "playing" || frame === undefined ? [] : awaitedSeats(frame);
};

/** Id of the decision `seat` must take now, or null (cheap; for hosts checking staleness). */
export const decisionIdOf = (state: GameState, seat: Seat): string | null => {
  const frame = topFrame(state);

  if (state.status !== "playing" || frame === undefined) return null;

  return awaitedSeats(frame).includes(seat) ? decisionIdFor(frame, seat) : null;
};
