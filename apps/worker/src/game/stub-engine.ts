/**
 * Phase-1 placeholder bound to the engine seam, so the whole pipeline (runs, GameDO, PlayerDO,
 * bots, wakes, spectators, D1, R2, ratings) runs end to end before `@mb/engine` exists.
 *
 * It is NOT Monopoly: every turn opens one table round that wakes every seat; when all seats
 * are done the active player rolls two dice and earns 10× the total. After `maxRounds` full
 * rounds the richest player wins. Phase 2 replaces this binding with `@mb/engine`.
 */
import { type Seat as SeatLetter, Seat } from "@mb/api";
import { Result, Schema } from "effect";

import type {
  EndReason,
  EngineBinding,
  EngineGameConfig,
  GameEngine,
  Pending,
  SeatAdapter,
  Standings,
} from "./engine.ts";

const EndReasonSchema = Schema.Literals(["lastPlayerStanding", "turnCap", "aborted"]);

export const StubState = Schema.Struct({
  seed: Schema.String,
  seats: Schema.Array(Seat),
  maxRounds: Schema.Int,
  cash: Schema.Array(Schema.Int),
  turn: Schema.Int,
  active: Schema.Int,
  awaiting: Schema.Array(Seat),
  rng: Schema.Int,
  seq: Schema.Int,
  endReason: Schema.NullOr(EndReasonSchema),
});

export type StubState = typeof StubState.Type;

export const StubEvent = Schema.TaggedUnion({
  GameStarted: {
    seq: Schema.Int,
    turn: Schema.Int,
    seats: Schema.Array(Seat),
    seed: Schema.String,
  },
  RoundOpened: {
    seq: Schema.Int,
    turn: Schema.Int,
    round: Schema.Int,
    awaiting: Schema.Array(Seat),
  },
  SeatDone: { seq: Schema.Int, turn: Schema.Int, seat: Seat, timedOut: Schema.Boolean },
  DiceRolled: {
    seq: Schema.Int,
    turn: Schema.Int,
    seat: Seat,
    dice: Schema.Tuple([Schema.Int, Schema.Int]),
    cash: Schema.Int,
  },
  GameEnded: { seq: Schema.Int, turn: Schema.Int, reason: EndReasonSchema },
});

export type StubEvent = typeof StubEvent.Type;

export const StubCommand = Schema.TaggedUnion({
  Done: { seat: Seat, decisionId: Schema.String },
  TimeoutSeat: { seat: Seat, decisionId: Schema.String },
  AbortGame: { reason: Schema.String },
});

export type StubCommand = typeof StubCommand.Type;

const STARTING_CASH = 1500;

const ROUND = 1;

/** Deterministic die from the seed and a counter (counter-based randomness, SPEC §4.1). */
const die = (seed: string, counter: number): number => {
  let hash = 2166136261;

  for (const char of `${seed}:${counter}`) {
    hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  }

  hash = Math.imul(hash ^ (hash >>> 15), 2246822507) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 13), 3266489909) >>> 0;

  return (((hash ^ (hash >>> 16)) >>> 0) % 6) + 1;
};

export const stubDecisionId = (turn: number, seat: SeatLetter): string =>
  `${turn}.${ROUND}.${seat}`;

const fold = (state: StubState, event: StubEvent): StubState =>
  StubEvent.match(event, {
    GameStarted: (started) => ({ ...state, seq: started.seq }),
    RoundOpened: (opened) => ({
      ...state,
      seq: opened.seq,
      turn: opened.turn,
      awaiting: opened.awaiting,
    }),
    SeatDone: (done) => ({
      ...state,
      seq: done.seq,
      awaiting: state.awaiting.filter((seat) => seat !== done.seat),
    }),
    DiceRolled: (rolled) => ({
      ...state,
      seq: rolled.seq,
      rng: state.rng + 2,
      cash: state.cash.map((cash, index) =>
        state.seats[index] === rolled.seat ? rolled.cash : cash,
      ),
      active: (state.active + 1) % state.seats.length,
    }),
    GameEnded: (ended) => ({ ...state, seq: ended.seq, awaiting: [], endReason: ended.reason }),
  });

class EventLog {
  readonly events: Array<StubEvent> = [];

  constructor(public state: StubState) {}

  push(event: StubEvent): void {
    this.events.push(event);
    this.state = fold(this.state, event);
  }

  get next(): number {
    return this.state.seq + 1;
  }
}

const openTurn = (log: EventLog, turn: number): void => {
  const completedRounds = Math.floor((turn - 1) / log.state.seats.length);

  if (completedRounds >= log.state.maxRounds) {
    log.push(StubEvent.cases.GameEnded.make({ seq: log.next, turn: turn - 1, reason: "turnCap" }));

    return;
  }

  log.push(
    StubEvent.cases.RoundOpened.make({
      seq: log.next,
      turn,
      round: ROUND,
      awaiting: log.state.seats,
    }),
  );
};

const seatDone = (
  state: StubState,
  seat: SeatLetter,
  decisionId: string,
  timedOut: boolean,
): Result.Result<{ state: StubState; events: ReadonlyArray<StubEvent> }, string> => {
  if (state.endReason !== null) return Result.fail("The game is over.");

  if (!state.awaiting.includes(seat)) return Result.fail(`Seat ${seat} is not awaited now.`);

  if (decisionId !== stubDecisionId(state.turn, seat)) {
    return Result.fail(
      `Stale decision ${decisionId}; the open decision is ${stubDecisionId(state.turn, seat)}.`,
    );
  }

  const log = new EventLog(state);
  log.push(StubEvent.cases.SeatDone.make({ seq: log.next, turn: state.turn, seat, timedOut }));

  if (log.state.awaiting.length === 0) {
    const roller = log.state.seats[log.state.active] ?? seat;

    const dice: readonly [number, number] = [
      die(state.seed, state.rng),
      die(state.seed, state.rng + 1),
    ];

    const before = log.state.cash[log.state.active] ?? 0;
    log.push(
      StubEvent.cases.DiceRolled.make({
        seq: log.next,
        turn: state.turn,
        seat: roller,
        dice,
        cash: before + 10 * (dice[0] + dice[1]),
      }),
    );
    openTurn(log, state.turn + 1);
  }

  return Result.succeed({ state: log.state, events: log.events });
};

const standings = (state: StubState): Standings => {
  const finished = state.endReason !== null;

  const ranked = state.seats
    .map((seat, index) => ({ seat, index, cash: state.cash[index] ?? 0 }))
    .sort((a, b) => b.cash - a.cash || a.index - b.index);

  const rankOf = new Map(ranked.map((entry, position) => [entry.seat, position + 1]));
  const rated = finished && state.endReason !== "aborted";

  return {
    finished,
    endReason: state.endReason,
    winner: rated ? (ranked[0]?.seat ?? null) : null,
    seats: state.seats.map((seat, index) => ({
      seat,
      rank: rated ? (rankOf.get(seat) ?? null) : null,
      netWorth: state.cash[index] ?? 0,
      cash: state.cash[index] ?? 0,
      bankruptAtTurn: null,
    })),
  };
};

const pending = (state: StubState): Pending => ({
  turn: state.turn,
  round: ROUND,
  decisions:
    state.endReason === null
      ? state.awaiting.map((seat) => ({
          seat,
          decisionId: stubDecisionId(state.turn, seat),
          frame: "Table",
          round: ROUND,
          reasons: ["round1"],
          sessionKey: `${state.turn}:table`,
          legal: ["done", "note", "inspect"],
        }))
      : [],
});

const money = (amount: number): string => `$${amount.toLocaleString("en-US")}`;

const tableText = (state: StubState): string =>
  state.seats
    .map(
      (seat, index) =>
        `${seat} ${money(state.cash[index] ?? 0)}${index === state.active ? " (rolls next)" : ""}`,
    )
    .join(", ");

const describe = (event: StubEvent): string =>
  StubEvent.match(event, {
    GameStarted: (started) => `Game started with seats ${started.seats.join(", ")}.`,
    RoundOpened: (opened) => `Turn ${opened.turn}: table round ${opened.round} opened.`,
    SeatDone: (done) => `${done.seat} was done${done.timedOut ? " (timed out)" : ""}.`,
    DiceRolled: (rolled) =>
      `${rolled.seat} rolled ${rolled.dice[0]}+${rolled.dice[1]} and now has ${money(rolled.cash)}.`,
    GameEnded: (ended) => `Game ended (${ended.reason}).`,
  });

const engine: GameEngine<StubState, StubEvent, StubCommand> = {
  version: "stub-0",
  newGame: (config: EngineGameConfig) => {
    const log = new EventLog({
      seed: config.seed,
      seats: config.seats,
      maxRounds: config.maxRounds,
      cash: config.seats.map(() => STARTING_CASH),
      turn: 0,
      active: 0,
      awaiting: [],
      rng: 0,
      seq: 0,
      endReason: null,
    });

    log.push(
      StubEvent.cases.GameStarted.make({ seq: 1, turn: 0, seats: config.seats, seed: config.seed }),
    );
    openTurn(log, 1);

    return { state: log.state, events: log.events };
  },
  apply: (state, command) =>
    StubCommand.match(command, {
      Done: (done) => seatDone(state, done.seat, done.decisionId, false),
      TimeoutSeat: (timeout) => seatDone(state, timeout.seat, timeout.decisionId, true),
      AbortGame: () => {
        if (state.endReason !== null) return Result.fail("The game is over.");

        const log = new EventLog(state);
        log.push(
          StubEvent.cases.GameEnded.make({ seq: log.next, turn: state.turn, reason: "aborted" }),
        );

        return Result.succeed({ state: log.state, events: log.events });
      },
    }),
  pending,
  playerView: (state, seat) => ({
    seat,
    turn: state.turn,
    cash: state.cash,
    seats: state.seats,
    awaiting: state.awaiting,
  }),
  spectatorView: (state) => ({
    turn: state.turn,
    cash: state.cash,
    seats: state.seats,
    awaiting: state.awaiting,
    active: state.active,
    endReason: state.endReason,
  }),
  digest: (events, sinceSeq) => events.filter((event) => event.seq > sinceSeq).map(describe),
  visibleTo: () => true,
  standings,
  timeoutCommand: (seat, decisionId) => StubCommand.cases.TimeoutSeat.make({ seat, decisionId }),
  abortCommand: (reason) => StubCommand.cases.AbortGame.make({ reason }),
};

const seats: SeatAdapter<StubState, StubEvent, StubCommand> = {
  commandFromTool: (_state, decision, tool) =>
    tool === "done"
      ? Result.succeed(
          StubCommand.cases.Done.make({ seat: decision.seat, decisionId: decision.decisionId }),
        )
      : Result.fail(
          `${tool} is not available in the phase-1 placeholder game; the legal tools are done, note and inspect.`,
        ),
  botCommand: (_state, decision) =>
    StubCommand.cases.Done.make({ seat: decision.seat, decisionId: decision.decisionId }),
  wakeContext: (state) => ({
    view: `Turn ${state.turn}. Cash: ${tableText(state)}.`,
    question:
      "Placeholder game (phase 1): call done to finish this round. When every seat is done, the active player rolls two dice and earns 10× the total.",
    offers: "",
  }),
  inspect: (state) => `Turn ${state.turn}. Cash: ${tableText(state)}.`,
  records: (state) => ({
    offers: [],
    auctions: [],
    counters: state.seats.map((seat) => ({
      seat,
      propertiesBought: 0,
      housesBuilt: 0,
      hotelsBuilt: 0,
      mortgages: 0,
      jailTurns: 0,
    })),
  }),
};

const encodeState = Schema.encodeSync(StubState);
const decodeState = Schema.decodeUnknownSync(StubState);
const encodeEvent = Schema.encodeSync(StubEvent);
const decodeEvent = Schema.decodeUnknownSync(StubEvent);

export const stubEngineBinding: EngineBinding<StubState, StubEvent, StubCommand> = {
  engine,
  codec: { encodeState, decodeState, encodeEvent, decodeEvent },
  seats,
};

export type StubEndReason = EndReason;
