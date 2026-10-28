/**
 * In-process game host: applies drivers' commands through the engine with the
 * per-wake limits of SPEC §6.4, falls back to `TimeoutSeat` (SPEC §6.5), and keeps
 * per-seat digest cursors and statistics.
 */
import { Result } from "effect";

import {
  apply,
  checkInvariants,
  decisionIdOf,
  digest,
  evolve,
  initialState,
  newGame,
  pendingSeats,
  playerView,
  requestOf,
  standings,
  timeoutCommand,
} from "@mb/engine";

import type {
  Command,
  DecisionRequest,
  GameConfig,
  GameEvent,
  GameState,
  IllegalCommand,
  PlayerView,
  Seat,
  Standing,
} from "@mb/engine";

/** Everything a driver needs for one wake. */
export interface Wake {
  readonly request: DecisionRequest;
  readonly view: PlayerView;
  /** English lines for what happened since this seat's previous wake. */
  readonly digest: ReadonlyArray<string>;
}

export interface SeatStats {
  readonly seat: Seat;
  wakes: number;
  commands: number;
  invalid: number;
  timeouts: number;
}

export interface GameResult {
  readonly config: GameConfig;
  readonly state: GameState;
  readonly events: ReadonlyArray<GameEvent>;
  readonly standings: ReadonlyArray<Standing>;
  readonly stats: ReadonlyArray<SeatStats>;
  /** Full rounds played (the last one may be partial). */
  readonly rounds: number;
  readonly turns: number;
}

export interface HostOptions {
  /** Check invariants after every event and that a decision is always pending (slow). */
  readonly verify?: boolean;
  /** Called with each batch of new events and the resulting state. */
  readonly onEvents?: (events: ReadonlyArray<GameEvent>, state: GameState) => void;
  /** Render digest lines for wakes (default true; bots do not read them). */
  readonly digest?: boolean;
  /** Called for every command the engine rejects. */
  readonly onInvalid?: (command: Command, problem: IllegalCommand) => void;
}

/** Safety net against a non-terminating host loop. */
const MAX_WAKES = 1_000_000;

export class Host {
  state: GameState;
  readonly events: Array<GameEvent> = [];
  readonly config: GameConfig;
  private readonly stats = new Map<Seat, SeatStats>();
  private readonly cursors = new Map<Seat, number>();
  private readonly options: HostOptions;
  wakes = 0;

  constructor(config: GameConfig, options: HostOptions) {
    const started = newGame(config);

    this.config = config;
    this.options = options;
    this.state = started.state;

    for (const seat of config.seats) {
      this.stats.set(seat.seat, {
        seat: seat.seat,
        wakes: 0,
        commands: 0,
        invalid: 0,
        timeouts: 0,
      });
    }

    this.verify(initialState(config), started.events);
    this.record(started.events);
  }

  get playing(): boolean {
    return this.state.status === "playing";
  }

  /** Seats that must act now. */
  pendingSeats(): ReadonlyArray<Seat> {
    return pendingSeats(this.state);
  }

  /** Builds the wake of `seat` (request, view, digest) and advances its digest cursor. */
  wake(seat: Seat): Wake | null {
    const request = requestOf(this.state, seat);

    if (request === null) return null;

    const lines =
      this.options.digest === false ? [] : digest(this.events, this.cursors.get(seat) ?? 0, seat);

    this.cursors.set(seat, this.state.seq);
    this.wakes += 1;

    if (this.wakes > MAX_WAKES) throw new Error("The game did not terminate");

    return { request, view: playerView(this.state, seat), digest: lines };
  }

  /**
   * Applies a driver's answer: at most `maxToolCallsPerWake` commands, stopping after
   * `maxInvalidPerWake` illegal ones or once the decision is answered. A decision left
   * open falls back to `TimeoutSeat`.
   */
  submit(request: DecisionRequest, commands: ReadonlyArray<Command>): void {
    const rules = this.config.rules;
    const stats = this.statsOf(request.seat);
    let used = 0;
    let invalid = 0;

    stats.wakes += 1;

    for (const next of commands) {
      if (!this.isPending(request) || used >= rules.maxToolCallsPerWake) break;

      if (invalid >= rules.maxInvalidPerWake) break;

      used += 1;
      stats.commands += 1;

      if (!this.applyCommand(next)) {
        invalid += 1;
        stats.invalid += 1;
      }
    }

    if (this.isPending(request)) this.timeout(request.seat);
  }

  /** Applies the default action of SPEC §6.5 for `seat` (driver failure or timeout). */
  timeout(seat: Seat): void {
    const fallback = timeoutCommand(this.state, seat);

    if (fallback === null) return;

    this.statsOf(seat).timeouts += 1;

    if (!this.applyCommand(fallback)) throw new Error(`TimeoutSeat rejected for ${seat}`);
  }

  /** Applies one command; false when the engine rejects it. */
  applyCommand(next: Command): boolean {
    const result = apply(this.state, next);

    if (Result.isFailure(result)) {
      this.options.onInvalid?.(next, result.failure);

      return false;
    }

    this.verify(this.state, result.success.events);
    this.state = result.success.state;
    this.record(result.success.events);

    if (this.options.verify === true && this.playing && pendingSeats(this.state).length === 0) {
      throw new Error(`No pending decision at seq ${this.state.seq}`);
    }

    return true;
  }

  result(): GameResult {
    return {
      config: this.config,
      state: this.state,
      events: this.events,
      standings: standings(this.state),
      stats: [...this.stats.values()],
      rounds: this.state.control.gameRound,
      turns: this.state.control.turn,
    };
  }

  private isPending(request: DecisionRequest): boolean {
    return decisionIdOf(this.state, request.seat) === request.decisionId;
  }

  private statsOf(seat: Seat): SeatStats {
    const found = this.stats.get(seat);

    if (found === undefined) throw new Error(`Unknown seat ${seat}`);

    return found;
  }

  private record(events: ReadonlyArray<GameEvent>): void {
    for (const event of events) this.events.push(event);

    this.options.onEvents?.(events, this.state);
  }

  /** With `verify`, folds `events` one by one and checks the invariants after each. */
  private verify(from: GameState, events: ReadonlyArray<GameEvent>): void {
    if (this.options.verify !== true) return;

    let state = from;

    for (const event of events) {
      state = evolve(state, event);

      const problems = checkInvariants(state);

      if (problems.length > 0) {
        throw new Error(
          `Invariant broken after ${event._tag} #${event.seq}: ${problems.join("; ")}`,
        );
      }
    }
  }
}
