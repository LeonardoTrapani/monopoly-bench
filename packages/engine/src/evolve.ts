/**
 * `evolve(state, event)`: the pure fold of SPEC §4.1. It never fails, never draws
 * randomness and never mutates its input; events carry every outcome.
 */
import { jailCardIndex } from "./data/cards.ts";
import { propertyIndex } from "./data/board.ts";
import { isFrameKind, without, withItem } from "./access.ts";
import { hotelsAt, housesAt } from "./rules.ts";

import type { DeckId, PropertyId, Seat } from "./schema/common.ts";
import type { EventKind, EventOf, GameEvent } from "./schema/events.ts";
import type {
  Control,
  Decks,
  Frame,
  FrameOf,
  GameState,
  Offer,
  PlayerState,
  PropertyState,
  SeatUnits,
} from "./schema/state.ts";
import { Frame as FrameSchema } from "./schema/state.ts";

type Changes = Partial<GameState>;

type Handlers = {
  readonly [K in EventKind]: (state: GameState, event: EventOf<K>) => Changes;
};

const mapPlayer = (
  state: GameState,
  seat: Seat,
  update: (player: PlayerState) => PlayerState,
): ReadonlyArray<PlayerState> =>
  state.players.map((candidate) => (candidate.seat === seat ? update(candidate) : candidate));

const addCash = (state: GameState, seat: Seat, amount: number): ReadonlyArray<PlayerState> =>
  mapPlayer(state, seat, (current) => ({ ...current, cash: current.cash + amount }));

const mapProperties = (
  properties: ReadonlyArray<PropertyState>,
  ids: ReadonlyArray<PropertyId>,
  update: (property: PropertyState) => PropertyState,
): ReadonlyArray<PropertyState> => {
  const next = properties.slice();

  for (const id of ids) {
    const index = propertyIndex(id);
    const current = next[index];

    if (current !== undefined) next[index] = update(current);
  }

  return next;
};

const mapControl = (state: GameState, update: Partial<Control>): Control => ({
  ...state.control,
  ...update,
});

const mapStack = (state: GameState, update: (frame: Frame) => Frame): Control =>
  mapControl(state, { stack: state.control.stack.map(update) });

/** Replaces only the frame with id `frameId` (the common case: the top frame). */
const mapFrame = (state: GameState, frameId: number, update: (frame: Frame) => Frame): Control => {
  const stack = state.control.stack;
  const index = stack.findIndex((frame) => frame.id === frameId);
  const current = stack[index];

  if (current === undefined) return state.control;

  const next = stack.slice();

  next[index] = update(current);

  return mapControl(state, { stack: next });
};

const mapFrameOf = <K extends Frame["_tag"]>(
  state: GameState,
  frameId: number,
  kind: K,
  update: (frame: FrameOf<K>) => Frame,
): Control =>
  mapFrame(state, frameId, (frame) => (isFrameKind(frame, kind) ? update(frame) : frame));

const mapOffer = (
  state: GameState,
  offerId: number,
  update: (offer: Offer) => Offer,
): ReadonlyArray<Offer> =>
  state.offers.map((offer) => (offer.id === offerId ? update(offer) : offer));

const dropDraftsOf = (state: GameState, frameId: number) =>
  state.drafts.filter((draft) => draft.frame !== frameId);

const addUnits = (
  units: ReadonlyArray<SeatUnits>,
  seat: Seat,
  delta: number,
): ReadonlyArray<SeatUnits> => {
  const found = units.some((entry) => entry.seat === seat);

  const updated = units.map((entry) =>
    entry.seat === seat ? { seat, units: entry.units + delta } : entry,
  );

  return found ? updated : [...updated, { seat, units: delta }];
};

const putBottom = (decks: Decks, deck: DeckId, card: number): Decks =>
  deck === "chance"
    ? { ...decks, chance: [...decks.chance, card] }
    : { ...decks, communityChest: [...decks.communityChest, card] };

const takeJailCards = (cards: ReadonlyArray<DeckId>, count: number) => ({
  moved: cards.slice(0, count),
  kept: cards.slice(count),
});

/** Removes a bankrupt seat from every multi-actor frame. */
const dropSeat = (frame: Frame, seat: Seat): Frame => {
  const rounds = <F extends FrameOf<"Table" | "RaiseFunds" | "Auction" | "BuildingAuction">>(
    current: F,
  ): F => ({
    ...current,
    awaiting: without(current.awaiting, seat),
    done: without(current.done, seat),
    reasons: current.reasons.filter((entry) => entry.seat !== seat),
  });

  return FrameSchema.match(frame, {
    Table: (current): Frame => rounds(current),
    RaiseFunds: (current): Frame => ({
      ...rounds(current),
      nextWake: current.nextWake.filter((entry) => entry.seat !== seat),
    }),
    JailChoice: (current): Frame => current,
    BuyChoice: (current): Frame => current,
    Auction: (current): Frame => ({
      ...rounds(current),
      active: without(current.active, seat),
      high: current.high?.seat === seat ? null : current.high,
    }),
    BuildingAuction: (current): Frame => ({
      ...rounds(current),
      active: without(current.active, seat),
      demand: current.demand.filter((entry) => entry.seat !== seat),
      high: current.high?.seat === seat ? null : current.high,
    }),
    MortgagedTransfer: (current): Frame => current,
  });
};

const openRound = (frame: Frame, event: EventOf<"RoundOpened">): Frame => {
  const round = { round: event.round, awaiting: event.awaiting, reasons: event.reasons, done: [] };

  return FrameSchema.match(frame, {
    Table: (current): Frame => ({ ...current, ...round, phase: "collecting" }),
    RaiseFunds: (current): Frame => ({
      ...current,
      ...round,
      phase: "collecting",
      debtorActive: false,
    }),
    JailChoice: (current): Frame => current,
    BuyChoice: (current): Frame => current,
    Auction: (current): Frame => ({ ...current, ...round }),
    BuildingAuction: (current): Frame => ({ ...current, ...round }),
    MortgagedTransfer: (current): Frame => current,
  });
};

const markDone = (frame: Frame, event: EventOf<"SeatDone">): Frame => {
  const done = withItem(doneOf(frame), event.seat);

  return FrameSchema.match(frame, {
    Table: (current): Frame => ({ ...current, done }),
    RaiseFunds: (current): Frame => ({
      ...current,
      done,
      liquidate: current.liquidate || (event.seat === current.debtor && event.via === "timeout"),
      declared:
        current.declared || (event.seat === current.debtor && event.via === "declareBankruptcy"),
    }),
    JailChoice: (current): Frame => current,
    BuyChoice: (current): Frame => current,
    Auction: (current): Frame => ({ ...current, done }),
    BuildingAuction: (current): Frame => ({ ...current, done }),
    MortgagedTransfer: (current): Frame => current,
  });
};

const doneOf = (frame: Frame): ReadonlyArray<Seat> =>
  FrameSchema.match(frame, {
    Table: (current) => current.done,
    RaiseFunds: (current) => current.done,
    JailChoice: () => [],
    BuyChoice: () => [],
    Auction: (current) => current.done,
    BuildingAuction: (current) => current.done,
    MortgagedTransfer: () => [],
  });

const handlers: Handlers = {
  GameStarted: () => ({ status: "playing" }),
  DecksShuffled: (state, event) => ({
    decks: { chance: event.chance, communityChest: event.communityChest },
    rng: { key: state.rng.key, counter: event.rng },
  }),
  TurnStarted: (state, event) => ({
    control: mapControl(state, {
      turn: event.turn,
      gameRound: event.gameRound,
      activeSeat: event.seat,
      newRound: event.newRound,
      doubles: 0,
      tableOpened: false,
      rolled: false,
      extraRoll: false,
    }),
  }),
  RolledAgain: (state, event) => ({
    control: mapControl(state, {
      doubles: event.doubles,
      tableOpened: false,
      rolled: false,
      extraRoll: false,
    }),
  }),
  FramePushed: (state, event) => ({
    control: mapControl(state, {
      stack: [...state.control.stack, event.frame],
      tableOpened: state.control.tableOpened || isFrameKind(event.frame, "Table"),
    }),
    nextFrameId: Math.max(state.nextFrameId, event.frame.id + 1),
  }),
  FramePopped: (state, event) => ({
    control: mapControl(state, {
      stack: state.control.stack.filter((frame) => frame.id !== event.frameId),
    }),
    drafts: dropDraftsOf(state, event.frameId),
  }),
  RoundOpened: (state, event) => ({
    control: mapFrame(state, event.frameId, (frame) => openRound(frame, event)),
  }),
  DraftAdded: (state, event) => ({
    drafts: [
      ...state.drafts,
      { frame: event.frameId, round: event.round, seat: event.seat, command: event.command },
    ],
  }),
  SeatDone: (state, event) => ({
    control: mapFrame(state, event.frameId, (frame) => markDone(frame, event)),
  }),
  SeatTimedOut: () => ({}),
  RoundClosed: (state, event) => ({
    control: mapFrame(state, event.frameId, (frame) => {
      if (isFrameKind(frame, "Table")) {
        return { ...frame, phase: "closed", nextWake: event.nextWake, closing: null };
      }

      if (isFrameKind(frame, "RaiseFunds")) {
        return {
          ...frame,
          phase: "closed",
          nextWake: event.nextWake,
          debtorActive: event.debtorActive,
        };
      }

      return frame;
    }),
    drafts: dropDraftsOf(state, event.frameId),
  }),
  TableClosing: (state, event) => ({
    control: mapFrameOf(state, event.frameId, "Table", (frame) => ({
      ...frame,
      closing: { contested: event.contested, pending: event.contested, credits: [] },
    })),
  }),
  ActionDropped: () => ({}),
  FollowChanged: (state, event) => ({
    players: mapPlayer(state, event.seat, (current) =>
      event.following
        ? {
            ...current,
            followed: withItem(current.followed, event.group),
            unfollowed: without(current.unfollowed, event.group),
          }
        : {
            ...current,
            followed: without(current.followed, event.group),
            unfollowed: withItem(current.unfollowed, event.group),
          },
    ),
  }),
  DiceRolled: (state, event) => {
    const isDouble = event.dice[0] === event.dice[1];
    const rng = { key: state.rng.key, counter: event.rng };

    if (event.purpose === "utility") return { rng, lastDice: event.dice };

    if (event.purpose === "jail") {
      return {
        rng,
        lastDice: event.dice,
        control: mapControl(state, { rolled: true, extraRoll: false }),
      };
    }

    return {
      rng,
      lastDice: event.dice,
      control: mapControl(state, {
        rolled: true,
        extraRoll: isDouble,
        doubles: isDouble ? state.control.doubles + 1 : state.control.doubles,
      }),
    };
  },
  Moved: (state, event) => ({
    players: mapPlayer(state, event.seat, (current) => ({ ...current, position: event.to })),
  }),
  Paid: (state, event) => ({
    players: state.players.map((candidate) => {
      const paid = candidate.seat === event.from ? event.amount : 0;
      const received = candidate.seat === event.to ? event.amount : 0;

      return paid === received
        ? candidate
        : { ...candidate, cash: candidate.cash - paid + received };
    }),
  }),
  SentToJail: (state, event) => ({
    players: mapPlayer(state, event.seat, (current) => ({
      ...current,
      position: 10,
      inJail: true,
      jailAttempts: 0,
    })),
    control:
      event.seat === state.control.activeSeat
        ? mapControl(state, { extraRoll: false })
        : state.control,
  }),
  LeftJail: (state, event) => ({
    players: mapPlayer(state, event.seat, (current) => ({
      ...current,
      inJail: false,
      jailAttempts: 0,
    })),
  }),
  JailRollFailed: (state, event) => ({
    players: mapPlayer(state, event.seat, (current) => ({
      ...current,
      jailAttempts: event.attempts,
    })),
  }),
  CardDrawn: (state, event) => {
    const order = event.deck === "chance" ? state.decks.chance : state.decks.communityChest;
    const rest = order.slice(1);
    const reordered = event.kept ? rest : [...rest, event.card];

    const decks =
      event.deck === "chance"
        ? { ...state.decks, chance: reordered }
        : { ...state.decks, communityChest: reordered };

    if (!event.kept) return { decks };

    return {
      decks,
      players: mapPlayer(state, event.seat, (current) => ({
        ...current,
        jailCards: [...current.jailCards, event.deck],
      })),
    };
  },
  JailCardUsed: (state, event) => ({
    decks: putBottom(state.decks, event.deck, jailCardIndex(event.deck)),
    players: mapPlayer(state, event.seat, (current) => {
      const index = current.jailCards.indexOf(event.deck);

      return {
        ...current,
        jailCards: current.jailCards.filter((_, position) => position !== index),
      };
    }),
  }),
  PropertyBought: (state, event) => ({
    properties: mapProperties(state.properties, [event.property], (property) => ({
      ...property,
      owner: event.seat,
    })),
    players: addCash(state, event.seat, -event.price),
  }),
  PurchaseDeclined: () => ({}),
  AuctionRoundClosed: (state, event) => ({
    control: mapFrame(state, event.frameId, (frame) => {
      if (isFrameKind(frame, "Auction") || isFrameKind(frame, "BuildingAuction")) {
        return { ...frame, high: event.high, active: event.active };
      }

      return frame;
    }),
    drafts: dropDraftsOf(state, event.frameId),
  }),
  AuctionEnded: (state, event) => {
    const winner = event.winner;

    if (winner === null) return {};

    return {
      properties: mapProperties(state.properties, [event.property], (property) => ({
        ...property,
        owner: winner,
      })),
    };
  },
  BuildingUnitOpened: (state, event) => ({
    control: mapFrameOf(state, event.frameId, "BuildingAuction", (frame) => ({
      ...frame,
      round: frame.round + 1,
      awaiting: event.active,
      done: [],
      reasons: event.active.map((seat) => ({ seat, reasons: ["bidder"] })),
      active: event.active,
      high: null,
    })),
  }),
  BuildingUnitAuctioned: (state, event) => {
    const winner = event.winner;

    return {
      control: mapFrameOf(state, event.frameId, "BuildingAuction", (frame) => {
        const closed = { ...frame, awaiting: [], done: [], reasons: [], active: [], high: null };

        return winner === null
          ? closed
          : {
              ...closed,
              unitsLeft: frame.unitsLeft - 1,
              credits: addUnits(frame.credits, winner, 1),
              demand: addUnits(frame.demand, winner, -1),
            };
      }),
      drafts: dropDraftsOf(state, event.frameId),
    };
  },
  BuildingUnitsGranted: (state, event) => ({
    control: mapFrameOf(state, event.frameId, "BuildingAuction", (frame) => {
      let credits = frame.credits;
      let demand = frame.demand;
      let granted = 0;

      for (const grant of event.grants) {
        credits = addUnits(credits, grant.seat, grant.units);
        demand = addUnits(demand, grant.seat, -grant.units);
        granted += grant.units;
      }

      return { ...frame, credits, demand, unitsLeft: frame.unitsLeft - granted };
    }),
  }),
  BuildingCreditsSettled: (state, event) => ({
    control: mapFrameOf(state, event.table, "Table", (frame) => {
      const closing = frame.closing;

      if (closing === null) return frame;

      return {
        ...frame,
        closing: {
          ...closing,
          pending: without(closing.pending, event.kind),
          credits: [
            ...closing.credits,
            ...event.credits.map((credit) => ({ ...credit, kind: event.kind })),
          ],
        },
      };
    }),
  }),
  BuildingBuilt: (state, event) => ({
    properties: mapProperties(state.properties, [event.property], (property) => ({
      ...property,
      level: event.level,
    })),
    bank:
      event.level === 5
        ? { houses: state.bank.houses + 4, hotels: state.bank.hotels - 1 }
        : { houses: state.bank.houses - 1, hotels: state.bank.hotels },
    players: addCash(state, event.seat, -event.cost),
  }),
  BuildingSold: (state, event) => {
    let properties = state.properties;
    let houses = state.bank.houses;
    let hotels = state.bank.hotels;

    for (const change of event.changes) {
      properties = mapProperties(properties, [change.property], (property) => ({
        ...property,
        level: change.to,
      }));
      houses += housesAt(change.from) - housesAt(change.to);
      hotels += hotelsAt(change.from) - hotelsAt(change.to);
    }

    return {
      properties,
      bank: { houses, hotels },
      players: addCash(state, event.seat, event.proceeds),
    };
  },
  PropertyMortgaged: (state, event) => ({
    properties: mapProperties(state.properties, [event.property], (property) => ({
      ...property,
      mortgaged: true,
    })),
    players: addCash(state, event.seat, event.amount),
  }),
  PropertyUnmortgaged: (state, event) => ({
    properties: mapProperties(state.properties, [event.property], (property) => ({
      ...property,
      mortgaged: false,
    })),
    players: addCash(state, event.seat, -event.amount),
  }),
  MortgagedDeedDecided: (state, event) => ({
    control: mapFrameOf(state, event.frameId, "MortgagedTransfer", (frame) => ({
      ...frame,
      properties: without(frame.properties, event.property),
    })),
  }),
  OfferPosted: (state, event) => ({
    offers: [...state.offers, event.offer],
    nextOfferId: Math.max(state.nextOfferId, event.offer.id + 1),
  }),
  OfferRejected: (state, event) => ({
    offers: mapOffer(state, event.offerId, (offer) =>
      offer.to === null
        ? { ...offer, rejectedBy: withItem(offer.rejectedBy, event.seat) }
        : { ...offer, status: "rejected", rejectedBy: withItem(offer.rejectedBy, event.seat) },
    ),
  }),
  OfferWithdrawn: (state, event) => ({
    offers: mapOffer(state, event.offerId, (offer) => ({ ...offer, status: "withdrawn" })),
  }),
  OfferMessage: (state, event) => ({
    offers: mapOffer(state, event.offerId, (offer) => ({
      ...offer,
      messages: [...offer.messages, { seat: event.seat, text: event.text, round: event.round }],
    })),
  }),
  TradeExecuted: (state, event) => {
    const fromPlayer = state.players.find((candidate) => candidate.seat === event.from);
    const toPlayer = state.players.find((candidate) => candidate.seat === event.to);
    const fromCards = takeJailCards(fromPlayer?.jailCards ?? [], event.give.jailCards);
    const toCards = takeJailCards(toPlayer?.jailCards ?? [], event.get.jailCards);
    const cashDelta = event.get.cash - event.give.cash;

    let properties = mapProperties(state.properties, event.give.properties, (property) => ({
      ...property,
      owner: event.to,
    }));

    properties = mapProperties(properties, event.get.properties, (property) => ({
      ...property,
      owner: event.from,
    }));

    const players = state.players.map((candidate) => {
      if (candidate.seat === event.from) {
        return {
          ...candidate,
          cash: candidate.cash + cashDelta,
          jailCards: [...fromCards.kept, ...toCards.moved],
        };
      }

      if (candidate.seat === event.to) {
        return {
          ...candidate,
          cash: candidate.cash - cashDelta,
          jailCards: [...toCards.kept, ...fromCards.moved],
        };
      }

      return candidate;
    });

    return {
      properties,
      players,
      offers: mapOffer(state, event.offerId, (offer) => ({ ...offer, status: "accepted" })),
    };
  },
  OfferInvalidated: (state, event) => ({
    offers: event.closed
      ? mapOffer(state, event.offerId, (offer) =>
          offer.status === "open" ? { ...offer, status: "invalidated" } : offer,
        )
      : state.offers,
  }),
  OffersExpired: (state, event) => ({
    offers: state.offers.filter((offer) => offer.session !== event.session),
  }),
  PlayerBankrupt: (state, event) => ({
    players: mapPlayer(state, event.seat, (current) => ({
      ...current,
      bankrupt: true,
      bankruptcy: { turn: event.turn, order: state.bankruptcies + 1, creditor: event.creditor },
    })),
    bankruptcies: state.bankruptcies + 1,
    control: mapStack(state, (frame) => dropSeat(frame, event.seat)),
    drafts: state.drafts.filter((draft) => draft.seat !== event.seat),
    offers: state.offers.map((offer) =>
      offer.status === "open" && (offer.from === event.seat || offer.to === event.seat)
        ? { ...offer, status: "withdrawn" }
        : offer,
    ),
  }),
  AssetsTransferred: (state, event) => ({
    properties: mapProperties(state.properties, event.properties, (property) => ({
      ...property,
      owner: event.to,
    })),
    players: state.players.map((candidate) => {
      if (candidate.seat === event.from) {
        return { ...candidate, cash: candidate.cash - event.cash, jailCards: [] };
      }

      if (candidate.seat === event.to) {
        return {
          ...candidate,
          cash: candidate.cash + event.cash,
          jailCards: [...candidate.jailCards, ...event.jailCards],
        };
      }

      return candidate;
    }),
  }),
  AssetsSurrendered: (state, event) => {
    let houses = state.bank.houses;
    let hotels = state.bank.hotels;
    let decks = state.decks;

    for (const id of event.properties) {
      const level = state.properties[propertyIndex(id)]?.level ?? 0;

      houses += housesAt(level);
      hotels += hotelsAt(level);
    }

    for (const deck of event.jailCards) decks = putBottom(decks, deck, jailCardIndex(deck));

    return {
      properties: mapProperties(state.properties, event.properties, (property) => ({
        ...property,
        owner: null,
        mortgaged: false,
        level: 0,
      })),
      bank: { houses, hotels },
      decks,
      players: mapPlayer(state, event.seat, (current) => ({
        ...current,
        cash: current.cash - event.cash,
        jailCards: [],
      })),
    };
  },
  GameEnded: (state, event) => ({
    status: "finished",
    endReason: event.reason,
    winner: event.winner,
    control: mapControl(state, { stack: [] }),
    drafts: [],
  }),
};

/** Applies one event to the state (pure; never fails). */
export const evolve = (state: GameState, event: GameEvent): GameState => {
  // SAFETY: `handlers` is keyed by event tag, so the handler picked by `event._tag` receives
  // exactly the variant it was written for.
  const handler = handlers[event._tag] as (state: GameState, event: GameEvent) => Changes;

  return { ...state, ...handler(state, event), seq: event.seq };
};
