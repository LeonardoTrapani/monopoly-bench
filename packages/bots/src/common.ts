/** Helpers shared by the bot policies. Bots are pure functions of (seed, view, request). */
import { Predicate } from "effect";

import { buildProblem, groupMembers, hashString, propertyInfo, rngAt } from "@mb/engine";

import type {
  Bank,
  Command,
  DecisionRequest,
  Frame,
  FrameOf,
  Holdings,
  HolderInfo,
  PlayerView,
  PropertyId,
  PropertyState,
  PublicPlayer,
  Seat,
} from "@mb/engine";

/** A policy: given what a seat sees and the decision it must take, the commands to submit. */
export type Bot = (view: PlayerView, request: DecisionRequest) => ReadonlyArray<Command>;

/** Deterministic random stream for one decision: same seed, seat and decision ⇒ same draws. */
export const decisionRandom = (seed: string, request: DecisionRequest): (() => number) => {
  const key = (hashString(`${seed}:${request.seat}`) ^ hashString(request.decisionId)) >>> 0;
  let counter = 0;

  return () => {
    const value = rngAt(key, counter);

    counter += 1;

    return value;
  };
};

export const pick = <T>(random: () => number, items: ReadonlyArray<T>): T | undefined =>
  items[Math.floor(random() * items.length)];

export const me = (view: PlayerView): PublicPlayer => {
  const found = view.players.find((candidate) => candidate.seat === view.seat);

  if (found === undefined) throw new Error(`Seat ${view.seat} missing from its view`);

  return found;
};

export const deedState = (holdings: Holdings, id: PropertyId): PropertyState => {
  const found = holdings.properties[propertyInfo(id).index];

  if (found === undefined) throw new Error(`Unknown property ${id}`);

  return found;
};

export const ownedIds = (holdings: Holdings, seat: Seat): ReadonlyArray<PropertyId> =>
  holdings.properties.flatMap((property) => (property.owner === seat ? [property.id] : []));

export const frameAs = <K extends Frame["_tag"]>(view: PlayerView, kind: K): FrameOf<K> | null => {
  const frame = view.frame;

  if (frame === null || !Predicate.isTagged(frame, kind)) return null;

  // SAFETY: `isTagged` checked that the frame's tag is `K`, which selects variant `FrameOf<K>`.
  return frame as FrameOf<K>;
};

/** Minimum legal bid in the current auction frame. */
export const minimumBid = (
  view: PlayerView,
  frame: FrameOf<"Auction"> | FrameOf<"BuildingAuction">,
): number =>
  frame.high === null
    ? view.rules.auctionMinOpening
    : frame.high.amount + view.rules.auctionMinRaise;

/** Mutable planning copy of the holdings, used to chain several drafts in one wake. */
export class Plan implements Holdings {
  properties: Array<PropertyState>;
  players: Array<HolderInfo>;
  bank: Bank;

  constructor(holdings: Holdings) {
    this.properties = holdings.properties.slice();
    this.players = holdings.players.map((holder) => ({
      seat: holder.seat,
      cash: holder.cash,
      bankrupt: holder.bankrupt,
      jailCards: holder.jailCards,
    }));
    this.bank = holdings.bank;
  }

  cash(seat: Seat): number {
    return this.players.find((holder) => holder.seat === seat)?.cash ?? 0;
  }

  addCash(seat: Seat, delta: number): void {
    this.players = this.players.map((holder) =>
      holder.seat === seat ? { ...holder, cash: holder.cash + delta } : holder,
    );
  }

  update(id: PropertyId, change: Partial<PropertyState>): void {
    const index = propertyInfo(id).index;
    const current = this.properties[index];

    if (current !== undefined) this.properties[index] = { ...current, ...change };
  }

  /** Records one more level on `id` if legal; true when planned. */
  build(seat: Seat, id: PropertyId): boolean {
    if (buildProblem(this, seat, id) !== null) return false;

    const level = deedState(this, id).level;

    this.update(id, { level: level + 1 });
    this.addCash(seat, -propertyInfo(id).houseCost);
    this.bank =
      level === 4
        ? { houses: this.bank.houses + 4, hotels: this.bank.hotels - 1 }
        : { houses: this.bank.houses - 1, hotels: this.bank.hotels };

    return true;
  }
}

/** Groups (streets only) entirely owned by `seat`. */
export const streetsOfCompleteSets = (holdings: Holdings, seat: Seat): ReadonlyArray<PropertyId> =>
  holdings.properties.flatMap((property) => {
    const info = propertyInfo(property.id);

    return property.owner === seat &&
      info.kind === "street" &&
      groupMembers(info.group).every((id) => deedState(holdings, id).owner === seat)
      ? [property.id]
      : [];
  });

export const answer = (request: DecisionRequest) => ({
  seat: request.seat,
  decisionId: request.decisionId,
});
