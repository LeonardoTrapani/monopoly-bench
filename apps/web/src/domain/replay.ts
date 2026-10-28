/**
 * The replay timeline of one game: the event log plus caches that make scrubbing cheap.
 *
 * The engine rebuilds any state with `replay(config, events)`, but a 4-player game has thousands
 * of events, so folding from the start on every render or scrub is too slow. `Replay` keeps a
 * checkpoint every `CHECKPOINT_INTERVAL` events, the head state, and one `TurnMark` per turn
 * (start index, net worths, notable events) for the scrubber and the net worth chart. Every
 * cache is derived from `config` and `events` by `appendEvents` and nothing else.
 */
import {
  GameConfig,
  GameEvent,
  GameState,
  Seat,
  evolve,
  initialState,
  netWorth,
  type EventOf,
} from "@mb/engine";
import { Match, Predicate, Schema } from "effect";

export const CHECKPOINT_INTERVAL = 200;

/** Events worth a marker on the timeline. */
export const MarkerKind = Schema.Literals(["Auction", "Trade", "Bankruptcy", "Jail", "Build"]);

export type MarkerKind = typeof MarkerKind.Type;

/**
 * A state after `index` events, with the number of laps each seat has completed (in config seat
 * order). Laps let tokens keep moving forward around the board when they pass GO.
 */
export const Snapshot = Schema.Struct({
  index: Schema.Int,
  state: GameState,
  laps: Schema.Array(Schema.Int),
});

export type Snapshot = typeof Snapshot.Type;

/** One turn of the game: where it starts in the log, who plays it, and net worths at its start. */
export const TurnMark = Schema.Struct({
  turn: Schema.Int,
  gameRound: Schema.Int,
  seat: Seat,
  /** Index of the `TurnStarted` event. */
  index: Schema.Int,
  /** Net worth of each seat at the start of the turn, in config seat order. */
  worths: Schema.Array(Schema.Int),
  markers: Schema.Array(MarkerKind),
});

export type TurnMark = typeof TurnMark.Type;

export const Replay = Schema.Struct({
  config: GameConfig,
  events: Schema.Array(GameEvent),
  checkpoints: Schema.Array(Snapshot),
  head: Snapshot,
  turns: Schema.Array(TurnMark),
});

export type Replay = typeof Replay.Type;

const initialSnapshot = (config: GameConfig): Snapshot => ({
  index: 0,
  state: initialState(config),
  laps: config.seats.map(() => 0),
});

/** Whether a move went forward past GO (rolls and "advance to" cards, not "go back 3"). */
const isLap = (event: EventOf<"Moved">): boolean =>
  event.to < event.from && (event.via === "roll" || event.passedGo || event.to === 0);

const nextLaps = (
  config: GameConfig,
  laps: ReadonlyArray<number>,
  event: GameEvent,
): ReadonlyArray<number> => {
  if (!Predicate.isTagged(event, "Moved") || !isLap(event)) return laps;

  const seatIndex = config.seats.findIndex((seat) => seat.seat === event.seat);

  return laps.map((count, index) => (index === seatIndex ? count + 1 : count));
};

/** Folds one event into a snapshot. */
export const step = (config: GameConfig, snapshot: Snapshot, event: GameEvent): Snapshot => ({
  index: snapshot.index + 1,
  state: evolve(snapshot.state, event),
  laps: nextLaps(config, snapshot.laps, event),
});

/** Net worth of every seat (config order); bankrupt seats are worth 0. */
export const worthsOf = (state: GameState): ReadonlyArray<number> =>
  state.players.map((player) => (player.bankrupt ? 0 : netWorth(state, player.seat)));

const markerOf = (event: GameEvent): MarkerKind | null =>
  Match.value(event).pipe(
    Match.withReturnType<MarkerKind | null>(),
    Match.tag("AuctionEnded", (ended) => (ended.winner === null ? null : "Auction")),
    Match.tag("TradeExecuted", () => "Trade"),
    Match.tag("PlayerBankrupt", () => "Bankruptcy"),
    Match.tag("SentToJail", () => "Jail"),
    Match.tag("BuildingBuilt", () => "Build"),
    Match.orElse(() => null),
  );

/** An empty timeline for `config` (before any event arrived). */
export const emptyReplay = (config: GameConfig): Replay => {
  const start = initialSnapshot(config);

  return { config, events: [], checkpoints: [start], head: start, turns: [] };
};

/**
 * Appends events to the timeline, skipping any already present (`seq` at or below the last one).
 * Live feeds and `/events?since=` may overlap; duplicates are dropped here.
 */
export const appendEvents = (replay: Replay, incoming: ReadonlyArray<GameEvent>): Replay => {
  const lastSeq = replay.events.at(-1)?.seq ?? 0;
  const fresh = incoming.filter((event) => event.seq > lastSeq);

  if (fresh.length === 0) return replay;

  const events = [...replay.events];
  const checkpoints = [...replay.checkpoints];
  const turns = [...replay.turns];
  let head = replay.head;

  for (const event of fresh) {
    head = step(replay.config, head, event);
    events.push(event);

    if (head.index % CHECKPOINT_INTERVAL === 0) checkpoints.push(head);

    if (Predicate.isTagged(event, "TurnStarted")) {
      turns.push({
        turn: event.turn,
        gameRound: event.gameRound,
        seat: event.seat,
        index: head.index - 1,
        worths: worthsOf(head.state),
        markers: [],
      });

      continue;
    }

    const marker = markerOf(event);
    const last = turns.at(-1);

    if (marker !== null && last !== undefined && !last.markers.includes(marker)) {
      turns[turns.length - 1] = { ...last, markers: [...last.markers, marker] };
    }
  }

  return { config: replay.config, events, checkpoints, head, turns };
};

/** Builds a timeline from a full log. */
export const fromEvents = (config: GameConfig, events: ReadonlyArray<GameEvent>): Replay =>
  appendEvents(emptyReplay(config), events);

/** Last seq in the log (0 when empty). */
export const lastSeq = (replay: Replay): number => replay.events.at(-1)?.seq ?? 0;

/** The state after `cursor` events (clamped to the log), from the nearest checkpoint. */
export const snapshotAt = (replay: Replay, cursor: number): Snapshot => {
  const target = Math.max(0, Math.min(cursor, replay.events.length));

  if (target === replay.head.index) return replay.head;

  let snapshot = replay.checkpoints[0] ?? initialSnapshot(replay.config);

  for (const checkpoint of replay.checkpoints) {
    if (checkpoint.index <= target) snapshot = checkpoint;
  }

  for (let index = snapshot.index; index < target; index += 1) {
    const event = replay.events[index];

    if (event !== undefined) snapshot = step(replay.config, snapshot, event);
  }

  return snapshot;
};

/** Index (into `turns`) of the turn that contains the event just before `cursor`. */
export const turnIndexAt = (replay: Replay, cursor: number): number => {
  let found = 0;

  for (const [position, mark] of replay.turns.entries()) {
    if (mark.index < cursor) found = position;
    else break;
  }

  return found;
};

/** Cursor at the end of turn number `position` (into `turns`): right before the next turn starts. */
export const turnEndCursor = (replay: Replay, position: number): number => {
  const next = replay.turns[position + 1];

  return next === undefined ? replay.events.length : next.index;
};

/** Events that change what a spectator sees (playback steps skip pure control events). */
export const isVisibleStep = (event: GameEvent): boolean =>
  !Predicate.isTagged(event, "SeatDone") &&
  !Predicate.isTagged(event, "RoundOpened") &&
  !Predicate.isTagged(event, "RoundClosed") &&
  !Predicate.isTagged(event, "FramePopped") &&
  !Predicate.isTagged(event, "DecksShuffled") &&
  !Predicate.isTagged(event, "FollowChanged") &&
  !Predicate.isTagged(event, "BuildingCreditsSettled") &&
  !Predicate.isTagged(event, "OffersExpired");

/** Cursor after the next visible event from `cursor` (or the end of the log). */
export const nextStepCursor = (replay: Replay, cursor: number): number => {
  for (let index = cursor; index < replay.events.length; index += 1) {
    const event = replay.events[index];

    if (event !== undefined && isVisibleStep(event)) return index + 1;
  }

  return replay.events.length;
};

/** Cursor before the previous visible event, so stepping back undoes one visible step. */
export const previousStepCursor = (replay: Replay, cursor: number): number => {
  for (let index = Math.min(cursor, replay.events.length) - 2; index >= 0; index -= 1) {
    const event = replay.events[index];

    if (event !== undefined && isVisibleStep(event)) return index + 1;
  }

  return 0;
};
