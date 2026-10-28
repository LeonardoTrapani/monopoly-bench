/**
 * The decider (SPEC §4.1): `newGame`, `decide`, `apply`, `replay`. Commands are
 * validated against the pending decision; `decide` then emits every consequence until
 * the game needs input again or ends.
 */
import { Predicate, Result } from "effect";

import { PROPERTY_IDS } from "./data/ids.ts";
import { propertyInfo } from "./data/board.ts";
import { DECK_SIZE } from "./data/cards.ts";
import { player, topFrame } from "./access.ts";
import { draftProblem, projectDrafts, sellOneLevel } from "./drafts.ts";
import { evolve } from "./evolve.ts";
import { advance, endGame, moveBy, openAuction, payTask, rollAndMove, rollDice } from "./flow.ts";
import {
  BID_KINDS,
  BUY_KINDS,
  CREDITOR_SIDE_KINDS,
  DEBTOR_KINDS,
  isDraftCommand,
  JAIL_KINDS,
  MORTGAGED_KINDS,
  TABLE_KINDS,
} from "./kinds.ts";
import { Machine, popFrame, task } from "./machine.ts";
import { awaitedSeats, decisionIdFor } from "./decisions.ts";
import { hashString, shuffledRange } from "./rng.ts";
import {
  buildProblem,
  liquidationValue,
  mortgageInterest,
  mortgageProblem,
  sellProblem,
  unmortgageCost,
} from "./rules.ts";
import { command, illegal } from "./schema/commands.ts";
import { PUBLIC, privateTo } from "./schema/events.ts";
import { Frame } from "./schema/state.ts";

import type { SessionFrame } from "./drafts.ts";
import type { Command, IllegalCommand, SeatCommand } from "./schema/commands.ts";
import type { Seat } from "./schema/common.ts";
import type { GameConfig } from "./schema/config.ts";
import type { GameEvent } from "./schema/events.ts";
import type { FrameOf, GameState } from "./schema/state.ts";

/** A problem description, or null when the command was applied. */
type Outcome = string | null;

const OK: Outcome = null;

/** State before the first event: every seat on GO with the starting cash, decks empty. */
export const initialState = (config: GameConfig): GameState => {
  const rules = config.rules;
  const first = config.seats[0];

  if (first === undefined) throw new Error("A game needs at least two seats");

  return {
    config,
    seq: 0,
    rng: { key: hashString(config.seed), counter: 0 },
    status: "setup",
    endReason: null,
    winner: null,
    players: config.seats.map((seat) => ({
      seat: seat.seat,
      label: seat.label,
      competitorId: seat.competitorId,
      cash: rules.startingCash,
      position: 0,
      inJail: false,
      jailAttempts: 0,
      jailCards: [],
      bankrupt: false,
      bankruptcy: null,
      followed: [],
      unfollowed: [],
    })),
    properties: PROPERTY_IDS.map((id) => ({ id, owner: null, mortgaged: false, level: 0 })),
    bank: { houses: rules.houses, hotels: rules.hotels },
    decks: { chance: [], communityChest: [] },
    control: {
      turn: 0,
      gameRound: 0,
      activeSeat: first.seat,
      doubles: 0,
      tableOpened: false,
      rolled: false,
      extraRoll: false,
      newRound: false,
      stack: [],
    },
    offers: [],
    drafts: [],
    lastDice: null,
    nextFrameId: 1,
    nextOfferId: 1,
    bankruptcies: 0,
  };
};

const validateConfig = (config: GameConfig): void => {
  const seats = config.seats.map((seat) => seat.seat);

  if (seats.length < 2 || seats.length > 6) throw new Error("A game needs 2 to 6 seats");

  if (new Set(seats).size !== seats.length) throw new Error("Seats must be distinct");
};

export interface Started {
  readonly state: GameState;
  readonly events: ReadonlyArray<GameEvent>;
}

/** Starts a game: shuffles the decks from the seed and runs until the first decision. */
export const newGame = (config: GameConfig): Started => {
  validateConfig(config);

  const machine = new Machine(initialState(config));
  const key = machine.state.rng.key;
  const chance = shuffledRange(key, 0, DECK_SIZE);
  const communityChest = shuffledRange(key, chance.next, DECK_SIZE);
  const first = machine.state.players[0];

  machine.emit(
    "DecksShuffled",
    { chance: chance.order, communityChest: communityChest.order, rng: communityChest.next },
    privateTo(),
  );
  machine.emit("GameStarted", { gameId: config.gameId, seats: config.seats });

  if (first !== undefined) {
    machine.emit("TurnStarted", { seat: first.seat, gameRound: 1, newRound: true }, PUBLIC, 1);
  }

  advance(machine);

  return { state: machine.state, events: machine.events };
};

/** Folds `events` from the initial state of `config`. */
export const replay = (config: GameConfig, events: Iterable<GameEvent>): GameState => {
  let state = initialState(config);

  for (const event of events) state = evolve(state, event);

  return state;
};

// ---------------------------------------------------------------------------
// Single-actor frames
// ---------------------------------------------------------------------------

const leaveJailAndRoll = (machine: Machine, frame: FrameOf<"JailChoice">): void => {
  popFrame(machine, frame);
  rollAndMove(machine, frame.seat);
};

const rollForDoubles = (machine: Machine, frame: FrameOf<"JailChoice">): Outcome => {
  const seat = frame.seat;
  const dice = rollDice(machine, seat, "jail");

  if (dice[0] === dice[1]) {
    machine.emit("LeftJail", { seat, via: "doubles" });
    popFrame(machine, frame);
    moveBy(machine, seat, dice[0] + dice[1]);

    return OK;
  }

  const attempts = player(machine.state, seat).jailAttempts + 1;

  machine.emit("JailRollFailed", { seat, attempts });
  popFrame(machine, frame);

  if (attempts >= 3) {
    machine.next(
      payTask(seat, "bank", machine.state.config.rules.jailFine, "jailFine", null),
      task("MoveBy", { seat, steps: dice[0] + dice[1], fromJail: true }),
    );
  }

  return OK;
};

const jailCommand = (machine: Machine, frame: FrameOf<"JailChoice">, value: SeatCommand) => {
  const seat = frame.seat;
  const current = player(machine.state, seat);
  const fine = machine.state.config.rules.jailFine;

  if (Predicate.isTagged(value, "PayJailFine")) {
    if (current.cash < fine) return `not enough cash for the $${fine} fine`;

    machine.emit("Paid", {
      from: seat,
      to: "bank",
      amount: fine,
      reason: "jailFine",
      property: null,
    });
    machine.emit("LeftJail", { seat, via: "fine" });
    leaveJailAndRoll(machine, frame);

    return OK;
  }

  if (Predicate.isTagged(value, "UseJailCard")) {
    const deck = current.jailCards[0];

    if (deck === undefined) return "you have no Get Out of Jail Free card";

    machine.emit("JailCardUsed", { seat, deck });
    machine.emit("LeftJail", { seat, via: "card" });
    leaveJailAndRoll(machine, frame);

    return OK;
  }

  if (Predicate.isTagged(value, "RollForDoubles")) return rollForDoubles(machine, frame);

  return `${value._tag} is not allowed in jail; use ${JAIL_KINDS.join(", ")}`;
};

/** Management commands applied immediately in single-actor frames. */
const manage = (machine: Machine, seat: Seat, value: SeatCommand): Outcome | undefined => {
  const state = machine.state;

  if (Predicate.isTagged(value, "Build")) {
    const problem = buildProblem(state, seat, value.property);

    if (problem !== null) return problem;

    machine.emit("BuildingBuilt", {
      seat,
      property: value.property,
      level: (state.properties[propertyInfo(value.property).index]?.level ?? 0) + 1,
      cost: propertyInfo(value.property).houseCost,
    });

    return OK;
  }

  if (Predicate.isTagged(value, "SellBuilding")) {
    const problem = sellProblem(state, seat, value.property);

    if (problem !== null) return problem;

    sellOneLevel(machine, seat, value.property);

    return OK;
  }

  if (Predicate.isTagged(value, "Mortgage")) {
    const problem = mortgageProblem(state, seat, value.property);

    if (problem !== null) return problem;

    machine.emit("PropertyMortgaged", {
      seat,
      property: value.property,
      amount: propertyInfo(value.property).mortgage,
    });

    return OK;
  }

  return undefined;
};

const decline = (machine: Machine, frame: FrameOf<"BuyChoice">): Outcome => {
  machine.emit("PurchaseDeclined", { seat: frame.seat, property: frame.property });
  popFrame(machine, frame);
  openAuction(machine, frame.property);

  return OK;
};

const buyCommand = (machine: Machine, frame: FrameOf<"BuyChoice">, value: SeatCommand) => {
  const price = propertyInfo(frame.property).price;

  if (Predicate.isTagged(value, "Buy")) {
    if (player(machine.state, frame.seat).cash < price) return `not enough cash ($${price})`;

    machine.emit("PropertyBought", { seat: frame.seat, property: frame.property, price });
    popFrame(machine, frame);

    return OK;
  }

  if (Predicate.isTagged(value, "Decline")) return decline(machine, frame);

  const managed = manage(machine, frame.seat, value);

  return managed === undefined
    ? `${value._tag} is not allowed here; use ${BUY_KINDS.join(", ")}`
    : managed;
};

/** Bid ceiling: liquidation value for deeds (SPEC §5.5); cash left after building otherwise. */
const bidLimit = (
  state: GameState,
  frame: FrameOf<"Auction"> | FrameOf<"BuildingAuction">,
  seat: Seat,
): number => {
  if (Predicate.isTagged(frame, "Auction")) return liquidationValue(state, seat);

  let cheapest = Number.POSITIVE_INFINITY;

  for (const draft of state.drafts) {
    if (draft.frame !== frame.table || draft.seat !== seat) continue;

    if (Predicate.isTagged(draft.command, "Build")) {
      cheapest = Math.min(cheapest, propertyInfo(draft.command.property).houseCost);
    }
  }

  return player(state, seat).cash - (Number.isFinite(cheapest) ? cheapest : 0);
};

const submitBid = (
  machine: Machine,
  frame: FrameOf<"Auction"> | FrameOf<"BuildingAuction">,
  value: SeatCommand,
): Outcome => {
  const seat = value.seat;
  const rules = machine.state.config.rules;

  if (Predicate.isTagged(value, "Bid")) {
    const minimum =
      frame.high === null ? rules.auctionMinOpening : frame.high.amount + rules.auctionMinRaise;

    const limit = bidLimit(machine.state, frame, seat);

    if (value.amount < minimum) return `the minimum bid is $${minimum}`;

    if (value.amount > limit) return `you can bid at most $${limit}`;

    machine.emit(
      "DraftAdded",
      { frameId: frame.id, round: frame.round, seat, command: value },
      privateTo(seat),
    );
    machine.emit("SeatDone", { frameId: frame.id, round: frame.round, seat, via: "bid" });

    return OK;
  }

  if (Predicate.isTagged(value, "PassBid")) {
    machine.emit(
      "DraftAdded",
      { frameId: frame.id, round: frame.round, seat, command: value },
      privateTo(seat),
    );
    machine.emit("SeatDone", { frameId: frame.id, round: frame.round, seat, via: "bid" });

    return OK;
  }

  return `${value._tag} is not allowed in an auction; use ${BID_KINDS.join(", ")}`;
};

const keepMortgage = (
  machine: Machine,
  frame: FrameOf<"MortgagedTransfer">,
  property: FrameOf<"MortgagedTransfer">["properties"][number],
): void => {
  machine.emit("MortgagedDeedDecided", {
    frameId: frame.id,
    seat: frame.seat,
    property,
    choice: "keep",
  });
  machine.next(
    payTask(frame.seat, "bank", mortgageInterest(property), "mortgageInterest", property),
  );
};

const mortgagedCommand = (
  machine: Machine,
  frame: FrameOf<"MortgagedTransfer">,
  value: SeatCommand,
): Outcome => {
  if (!Predicate.isTagged(value, "KeepMortgage") && !Predicate.isTagged(value, "PayOffMortgage")) {
    return `${value._tag} is not allowed here; use ${MORTGAGED_KINDS.join(", ")}`;
  }

  const property = value.property;

  if (!frame.properties.includes(property)) {
    return `${propertyInfo(property).name} is not one of the mortgaged deeds to decide`;
  }

  if (Predicate.isTagged(value, "KeepMortgage")) {
    keepMortgage(machine, frame, property);

    return OK;
  }

  const cost = unmortgageCost(property);

  if (player(machine.state, frame.seat).cash < cost) return `not enough cash ($${cost})`;

  machine.emit("MortgagedDeedDecided", {
    frameId: frame.id,
    seat: frame.seat,
    property,
    choice: "payOff",
  });
  machine.emit("PropertyUnmortgaged", { seat: frame.seat, property, amount: cost });

  return OK;
};

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

const sessionKinds = (frame: SessionFrame, seat: Seat) => {
  if (Predicate.isTagged(frame, "Table")) return TABLE_KINDS;

  return frame.debtor === seat ? DEBTOR_KINDS : CREDITOR_SIDE_KINDS;
};

const sessionCommand = (machine: Machine, frame: SessionFrame, value: SeatCommand): Outcome => {
  const seat = value.seat;
  const state = machine.state;

  if (!sessionKinds(frame, seat).includes(value._tag)) {
    return `${value._tag} is not allowed in this session`;
  }

  if (Predicate.isTagged(value, "Done")) {
    machine.emit("SeatDone", { frameId: frame.id, round: frame.round, seat, via: "done" });

    return OK;
  }

  if (Predicate.isTagged(value, "DeclareBankruptcy")) {
    if (!Predicate.isTagged(frame, "RaiseFunds")) return "no debt to declare bankruptcy on";

    const projected = projectDrafts(state, frame, seat);

    if (liquidationValue(projected, seat) >= frame.amount) {
      return "you can still raise the money by selling buildings and mortgaging";
    }

    machine.emit("SeatDone", {
      frameId: frame.id,
      round: frame.round,
      seat,
      via: "declareBankruptcy",
    });

    return OK;
  }

  if (Predicate.isTagged(value, "Follow") || Predicate.isTagged(value, "Unfollow")) {
    const following = Predicate.isTagged(value, "Follow");
    const current = player(state, seat);
    const listed = following ? current.followed : current.unfollowed;

    if (!listed.includes(value.group)) {
      machine.emit("FollowChanged", { seat, group: value.group, following }, privateTo(seat));
    }

    return OK;
  }

  if (!isDraftCommand(value)) return `${value._tag} is not allowed in this session`;

  const problem = draftProblem(state, frame, seat, value);

  if (problem !== null) return problem;

  machine.emit(
    "DraftAdded",
    { frameId: frame.id, round: frame.round, seat, command: value },
    privateTo(seat),
  );

  return OK;
};

// ---------------------------------------------------------------------------
// Timeouts and dispatch
// ---------------------------------------------------------------------------

const passDefault = (
  machine: Machine,
  frame: FrameOf<"Auction"> | FrameOf<"BuildingAuction">,
  seat: Seat,
  decisionId: string,
): Outcome => {
  machine.emit(
    "DraftAdded",
    {
      frameId: frame.id,
      round: frame.round,
      seat,
      command: command("PassBid", { seat, decisionId }),
    },
    privateTo(seat),
  );
  machine.emit("SeatDone", { frameId: frame.id, round: frame.round, seat, via: "bid" });

  return OK;
};

/** Applies the default action of SPEC §6.5 for a seat that timed out. */
const timeout = (machine: Machine, frame: Frame, seat: Seat, decisionId: string): Outcome => {
  machine.emit("SeatTimedOut", { seat, decisionId, frame: frame._tag });

  const sessionDone = (current: SessionFrame): Outcome => {
    machine.emit("SeatDone", { frameId: current.id, round: current.round, seat, via: "timeout" });

    return OK;
  };

  return Frame.match(frame, {
    Table: sessionDone,
    RaiseFunds: sessionDone,
    JailChoice: (current) => rollForDoubles(machine, current),
    BuyChoice: (current) => decline(machine, current),
    Auction: (current) => passDefault(machine, current, seat, decisionId),
    BuildingAuction: (current) => passDefault(machine, current, seat, decisionId),
    MortgagedTransfer: (current) => {
      for (const property of current.properties) keepMortgage(machine, current, property);

      return OK;
    },
  });
};

const handle = (machine: Machine, value: Command): Outcome => {
  if (Predicate.isTagged(value, "AbortGame")) {
    if (machine.state.status !== "playing") return "the game is over";

    endGame(machine, "aborted");

    return OK;
  }

  if (machine.state.status !== "playing") return "the game is over";

  const frame = topFrame(machine.state);

  if (
    frame === undefined ||
    !awaitedSeats(frame).includes(value.seat) ||
    decisionIdFor(frame, value.seat) !== value.decisionId
  ) {
    return `no pending decision ${value.decisionId} for seat ${value.seat}`;
  }

  if (Predicate.isTagged(value, "TimeoutSeat")) {
    return timeout(machine, frame, value.seat, value.decisionId);
  }

  return Frame.match(frame, {
    Table: (current) => sessionCommand(machine, current, value),
    RaiseFunds: (current) => sessionCommand(machine, current, value),
    JailChoice: (current) => jailCommand(machine, current, value),
    BuyChoice: (current) => buyCommand(machine, current, value),
    Auction: (current) => submitBid(machine, current, value),
    BuildingAuction: (current) => submitBid(machine, current, value),
    MortgagedTransfer: (current) => mortgagedCommand(machine, current, value),
  });
};

const run = (state: GameState, value: Command): Result.Result<Machine, IllegalCommand> => {
  const machine = new Machine(state);
  const problem = handle(machine, value);

  if (problem !== null) return Result.fail(illegal(value._tag, problem));

  advance(machine);

  return Result.succeed(machine);
};

/**
 * Validates `command` against the pending decision and returns every event it causes,
 * including all automatic steps up to the next decision (SPEC §4.1).
 */
export const decide = (
  state: GameState,
  value: Command,
): Result.Result<ReadonlyArray<GameEvent>, IllegalCommand> =>
  Result.map(run(state, value), (machine) => machine.events);

export interface Applied {
  readonly state: GameState;
  readonly events: ReadonlyArray<GameEvent>;
}

/** `decide` followed by folding the events with `evolve`. */
export const apply = (state: GameState, value: Command): Result.Result<Applied, IllegalCommand> =>
  Result.map(run(state, value), (machine): Applied => ({
    state: machine.state,
    events: machine.events,
  }));
