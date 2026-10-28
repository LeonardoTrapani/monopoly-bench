/** Short English lines describing events, for wake messages (SPEC §4.6, §6.2). */
import { Predicate } from "effect";

import { GROUP_NAMES, propertyInfo, spaceName } from "./data/board.ts";
import { cardAt, DECK_NAMES } from "./data/cards.ts";
import { GameEvent } from "./schema/events.ts";
import { Frame } from "./schema/state.ts";

import type { Assets, Party, PropertyId, Seat } from "./schema/common.ts";
import type { EventOf } from "./schema/events.ts";
import type { PaymentReason } from "./schema/state.ts";

/** Viewer of an event stream: a seat, or a spectator who sees everything. */
export type Viewer = Seat | "spectator";

/** Whether `viewer` may see `event` (public, addressed to it, or a spectator). */
export const visibleTo = (event: GameEvent, viewer: Viewer): boolean =>
  event.visibility === "public" ||
  viewer === "spectator" ||
  event.visibility.seats.includes(viewer);

const name = (id: PropertyId): string => propertyInfo(id).name;

const party = (value: Party): string => (value === "bank" ? "the bank" : value);

const money = (amount: number): string => `$${amount}`;

const levelText = (level: number): string =>
  level >= 5 ? "a hotel" : level === 1 ? "1 house" : `${level} houses`;

/** Renders one side of a trade, e.g. "$100, Boardwalk and 1 jail card". */
export const assetsText = (assets: Assets): string => {
  const parts = [
    ...(assets.cash > 0 ? [money(assets.cash)] : []),
    ...assets.properties.map(name),
    ...(assets.jailCards > 0 ? [`${assets.jailCards} Get Out of Jail Free card(s)`] : []),
  ];

  return parts.length === 0 ? "nothing" : parts.join(", ");
};

const PAYMENT_TEXT: Readonly<Record<PaymentReason, string>> = {
  salary: "salary",
  rent: "rent",
  tax: "tax",
  card: "card",
  jailFine: "jail fine",
  auction: "auction",
  buildingAuction: "building auction premium",
  mortgageInterest: "mortgage interest",
};

const JAIL_REASONS: Readonly<Record<EventOf<"SentToJail">["reason"], string>> = {
  goToJail: "Go To Jail",
  card: "card",
  threeDoubles: "three doubles",
};

const paidLine = (event: EventOf<"Paid">): string => {
  const what = event.property === null ? "" : ` for ${name(event.property)}`;

  if (event.from === "bank") {
    return `${party(event.to)} collected ${money(event.amount)} (${PAYMENT_TEXT[event.reason]}).`;
  }

  return `${event.from} paid ${money(event.amount)} ${PAYMENT_TEXT[event.reason]} to ${party(event.to)}${what}.`;
};

const frameLine = (event: EventOf<"FramePushed">): string | null =>
  Frame.match(event.frame, {
    Table: () => "The table is open.",
    RaiseFunds: (frame) =>
      `${frame.debtor} owes ${money(frame.amount)} (${PAYMENT_TEXT[frame.reason]}) to ${party(frame.creditor)} and must raise funds.`,
    JailChoice: (frame) => `${frame.seat} is in jail and must choose how to get out.`,
    BuyChoice: (frame) =>
      `${frame.seat} may buy ${name(frame.property)} for ${money(propertyInfo(frame.property).price)}.`,
    Auction: (frame) =>
      `Auction opened for ${name(frame.property)} among ${frame.awaiting.join(", ") || "nobody"}.`,
    BuildingAuction: (frame) =>
      `Building shortage: ${frame.unitsLeft} ${frame.kind}(s) for ${frame.demand
        .map((entry) => `${entry.seat} (${entry.units})`)
        .join(", ")}.`,
    MortgagedTransfer: (frame) =>
      `${frame.seat} must decide on mortgaged ${frame.properties.map(name).join(", ")}.`,
  });

/** One line for `event`, or null when it is not worth a line. */
export const describeEvent = (event: GameEvent): string | null =>
  GameEvent.match(event, {
    GameStarted: (e) =>
      `Game ${e.gameId} started: ${e.seats.map((seat) => `${seat.seat} (${seat.label})`).join(", ")}.`,
    DecksShuffled: () => null,
    TurnStarted: (e) =>
      `Turn ${e.turn}${e.newRound ? `, round ${e.gameRound}` : ""}: ${e.seat} to play.`,
    RolledAgain: (e) => `${e.seat} rolled doubles and rolls again.`,
    FramePushed: frameLine,
    FramePopped: () => null,
    RoundOpened: () => null,
    DraftAdded: (e) => `(private) You drafted ${e.command._tag}.`,
    SeatDone: () => null,
    SeatTimedOut: (e) => `${e.seat} timed out (${e.frame}); the default action was applied.`,
    RoundClosed: () => null,
    TableClosing: (e) =>
      `Building shortage at round close: ${e.contested.join(" and ")} auctioned.`,
    ActionDropped: (e) => `${e.seat}'s ${e.command._tag} was dropped: ${e.reason}.`,
    FollowChanged: (e) =>
      `(private) You ${e.following ? "follow" : "unfollow"} ${GROUP_NAMES[e.group]}.`,
    DiceRolled: (e) => {
      const roll = `${e.dice[0]}+${e.dice[1]}`;

      if (e.purpose === "jail") return `${e.seat} rolled ${roll} trying for doubles in jail.`;

      if (e.purpose === "utility") return `${e.seat} rolled ${roll} for the utility rent.`;

      return `${e.seat} rolled ${roll}${e.dice[0] === e.dice[1] ? " (doubles)" : ""}.`;
    },
    Moved: (e) => `${e.seat} moved to ${spaceName(e.to)}${e.passedGo ? " (passed GO)" : ""}.`,
    Paid: paidLine,
    SentToJail: (e) => `${e.seat} went to jail (${JAIL_REASONS[e.reason]}).`,
    LeftJail: (e) => `${e.seat} left jail (${e.via}).`,
    JailRollFailed: (e) => `${e.seat} stays in jail (failed attempt ${e.attempts}).`,
    CardDrawn: (e) => `${e.seat} drew ${DECK_NAMES[e.deck]}: "${cardAt(e.deck, e.card).text}"`,
    JailCardUsed: (e) => `${e.seat} used a Get Out of Jail Free card.`,
    PropertyBought: (e) => `${e.seat} bought ${name(e.property)} for ${money(e.price)}.`,
    PurchaseDeclined: (e) => `${e.seat} declined ${name(e.property)}; it goes to auction.`,
    AuctionRoundClosed: (e) =>
      `Bids (round ${e.round}): ${
        e.bids
          .map((bid) => `${bid.seat} ${bid.amount === null ? "pass" : money(bid.amount)}`)
          .join(", ") || "none"
      }.`,
    AuctionEnded: (e) =>
      e.winner === null
        ? `Auction: nobody bid on ${name(e.property)}; it stays with the bank.`
        : `Auction: ${e.winner} won ${name(e.property)} for ${money(e.amount)}.`,
    BuildingUnitOpened: (e) => `Building auction for one unit among ${e.active.join(", ")}.`,
    BuildingUnitAuctioned: (e) =>
      e.winner === null
        ? `Building auction: no bids; the remaining ${e.kind}s are not sold this round.`
        : `Building auction: ${e.winner} won a ${e.kind} for a ${money(e.premium)} premium.`,
    BuildingUnitsGranted: (e) =>
      `Scarce buildings granted: ${e.grants.map((grant) => `${grant.seat} ${grant.units}`).join(", ")}.`,
    BuildingCreditsSettled: () => null,
    BuildingBuilt: (e) => `${e.seat} built on ${name(e.property)} (now ${levelText(e.level)}).`,
    BuildingSold: (e) =>
      `${e.seat} sold buildings for ${money(e.proceeds)}: ${e.changes
        .map(
          (change) =>
            `${name(change.property)} ${levelText(change.from)} → ${change.to === 0 ? "none" : levelText(change.to)}`,
        )
        .join(", ")}.`,
    PropertyMortgaged: (e) => `${e.seat} mortgaged ${name(e.property)} for ${money(e.amount)}.`,
    PropertyUnmortgaged: (e) =>
      `${e.seat} paid ${money(e.amount)} to unmortgage ${name(e.property)}.`,
    MortgagedDeedDecided: (e) =>
      `${e.seat} ${e.choice === "keep" ? "kept the mortgage on" : "paid off"} ${name(e.property)}.`,
    OfferPosted: (e) => {
      const offer = e.offer;
      const reply = offer.replyTo === null ? "" : ` (reply to #${offer.replyTo})`;
      const comment = offer.comment === null ? "" : ` "${offer.comment}"`;

      return `Offer #${offer.id}${reply} from ${offer.from} to ${offer.to ?? "anyone"}: gives ${assetsText(offer.give)} for ${assetsText(offer.get)}.${comment}`;
    },
    OfferRejected: (e) =>
      `${e.seat} rejected offer #${e.offerId}.${e.comment === null ? "" : ` "${e.comment}"`}`,
    OfferWithdrawn: (e) => `${e.seat} withdrew offer #${e.offerId}.`,
    OfferMessage: (e) => `${e.seat} on offer #${e.offerId}: "${e.text}"`,
    TradeExecuted: (e) =>
      `Trade #${e.offerId}: ${e.from} gave ${assetsText(e.give)} to ${e.to} for ${assetsText(e.get)}.`,
    OfferInvalidated: (e) => `${e.seat}'s acceptance of offer #${e.offerId} failed: ${e.reason}.`,
    OffersExpired: (e) =>
      e.offerIds.length === 0
        ? null
        : `Offers expired: ${e.offerIds.map((id) => `#${id}`).join(", ")}.`,
    PlayerBankrupt: (e) => `${e.seat} is bankrupt (creditor: ${party(e.creditor)}).`,
    AssetsTransferred: (e) =>
      `${e.from}'s assets go to ${e.to}: ${money(e.cash)}${e.properties.length > 0 ? `, ${e.properties.map(name).join(", ")}` : ""}.`,
    AssetsSurrendered: (e) =>
      `${e.seat}'s deeds return to the bank${e.properties.length > 0 ? " and are auctioned" : ""}.`,
    GameEnded: (e) =>
      `Game over (${e.reason}): ${e.standings
        .map((row) => `${row.rank}. ${row.seat} ${money(row.netWorth)}`)
        .join(", ")}.`,
  });

/**
 * Short English lines for the events after `sinceSeq` visible to `viewer` (SPEC §4.6),
 * e.g. "B rolled 5+3 and landed on Tennessee Avenue."
 */
export const digest = (
  events: ReadonlyArray<GameEvent>,
  sinceSeq: number,
  viewer: Viewer,
): ReadonlyArray<string> => {
  const lines: Array<string> = [];
  let rolled: EventOf<"DiceRolled"> | null = null;
  let low = 0;
  let high = events.length;

  // Events are ordered by seq: skip the already-seen prefix with a binary search.
  while (low < high) {
    const middle = (low + high) >>> 1;

    if ((events[middle]?.seq ?? 0) <= sinceSeq) low = middle + 1;
    else high = middle;
  }

  for (let index = low; index < events.length; index += 1) {
    const event = events[index];

    if (event === undefined || !visibleTo(event, viewer)) continue;

    if (rolled !== null) {
      const roll = rolled;

      rolled = null;

      if (Predicate.isTagged(event, "Moved") && event.seat === roll.seat && event.via === "roll") {
        lines.push(
          `${roll.seat} rolled ${roll.dice[0]}+${roll.dice[1]}${roll.dice[0] === roll.dice[1] ? " (doubles)" : ""} and landed on ${spaceName(event.to)}${event.passedGo ? " (passed GO)" : ""}.`,
        );

        continue;
      }

      const pendingLine = describeEvent(roll);

      if (pendingLine !== null) lines.push(pendingLine);
    }

    if (Predicate.isTagged(event, "DiceRolled") && event.purpose !== "utility") {
      rolled = event;

      continue;
    }

    const line = describeEvent(event);

    if (line !== null) lines.push(line);
  }

  if (rolled !== null) {
    const line = describeEvent(rolled);

    if (line !== null) lines.push(line);
  }

  return lines;
};
