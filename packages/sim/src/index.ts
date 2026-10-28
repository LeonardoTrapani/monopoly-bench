/**
 * `@mb/sim`: in-process game host used by tests and the CLI (SPEC §2).
 *
 * `runGame({ config, drivers })` plays a game to the end with one async driver per
 * seat; drivers of a simultaneous round are awaited concurrently and their commands
 * applied afterwards. `runGameSync` is the fast path for bots.
 */
import { createBot } from "@mb/bots";
import { createConfig, SEATS } from "@mb/engine";

import { Host } from "./host.ts";

import type { BotPolicy } from "@mb/bots";
import type {
  Command,
  DecisionRequest,
  GameConfig,
  PlayerView,
  RulesConfig,
  Seat,
  SeatConfig,
} from "@mb/engine";
import type { GameResult, HostOptions, Wake } from "./host.ts";

export { Host } from "./host.ts";

export type { GameResult, HostOptions, SeatStats, Wake } from "./host.ts";

/** Answers one wake; async so that LLM drivers can plug in. */
export type Driver = (
  request: DecisionRequest,
  view: PlayerView,
  digestLines: ReadonlyArray<string>,
) => Promise<ReadonlyArray<Command>>;

/** Synchronous driver (bots). */
export type SyncDriver = (
  request: DecisionRequest,
  view: PlayerView,
  digestLines: ReadonlyArray<string>,
) => ReadonlyArray<Command>;

export interface RunOptions extends HostOptions {
  readonly config: GameConfig;
  readonly drivers: ReadonlyMap<Seat, Driver>;
  /** Wake timeout in ms; defaults to `config.rules.wakeTimeoutMs`. */
  readonly timeoutMs?: number;
}

export interface SyncRunOptions extends HostOptions {
  readonly config: GameConfig;
  readonly drivers: ReadonlyMap<Seat, SyncDriver>;
}

const withTimeout = (work: Promise<ReadonlyArray<Command>>, ms: number) =>
  new Promise<ReadonlyArray<Command> | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);

    work.then(
      (commands) => {
        clearTimeout(timer);
        resolve(commands);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });

/** Plays a whole game with async drivers. A missing driver, an error or a timeout applies the seat's default. */
export const runGame = async (options: RunOptions): Promise<GameResult> => {
  const host = new Host(options.config, options);
  const timeoutMs = options.timeoutMs ?? options.config.rules.wakeTimeoutMs;

  while (host.playing) {
    const wakes = host.pendingSeats().flatMap((seat) => {
      const wake = host.wake(seat);

      return wake === null ? [] : [wake];
    });

    const answers = await Promise.all(
      wakes.map((wake: Wake) => {
        const driver = options.drivers.get(wake.request.seat);

        return driver === undefined
          ? Promise.resolve(null)
          : withTimeout(driver(wake.request, wake.view, wake.digest), timeoutMs);
      }),
    );

    for (const [index, wake] of wakes.entries()) {
      const commands = answers[index] ?? null;

      if (commands === null) host.timeout(wake.request.seat);
      else host.submit(wake.request, commands);
    }
  }

  return host.result();
};

/** Plays a whole game with synchronous drivers (fast path for bots). */
export const runGameSync = (options: SyncRunOptions): GameResult => {
  const host = new Host(options.config, options);

  while (host.playing) {
    for (const seat of host.pendingSeats()) {
      const wake = host.wake(seat);

      if (wake === null) continue;

      const driver = options.drivers.get(seat);

      if (driver === undefined) host.timeout(seat);
      else host.submit(wake.request, driver(wake.request, wake.view, wake.digest));
    }
  }

  return host.result();
};

/** Seats A, B, ... for `policies`, labelled like `@mb/api` `competitorLabel`. */
export const botSeats = (policies: ReadonlyArray<BotPolicy>): ReadonlyArray<SeatConfig> =>
  policies.flatMap((policy, index) => {
    const seat = SEATS[index];

    return seat === undefined
      ? []
      : [{ seat, label: `Bot (${policy})`, competitorId: `bot:${policy}` }];
  });

/** Synchronous bot drivers for the seats of `config`, seeded with `<seed>:<seat>`. */
export const botDrivers = (
  policies: ReadonlyArray<BotPolicy>,
  seed: string,
): ReadonlyMap<Seat, SyncDriver> => {
  const drivers = new Map<Seat, SyncDriver>();

  for (const [index, policy] of policies.entries()) {
    const seat = SEATS[index];

    if (seat === undefined) continue;

    const bot = createBot(policy, `${seed}:${seat}`);

    drivers.set(seat, (request, view) => bot(view, request));
  }

  return drivers;
};

/** Wraps synchronous drivers for `runGame`. */
export const asyncDrivers = (drivers: ReadonlyMap<Seat, SyncDriver>): ReadonlyMap<Seat, Driver> =>
  new Map(
    [...drivers].map(([seat, driver]): [Seat, Driver] => [
      seat,
      (request, view, lines) => Promise.resolve(driver(request, view, lines)),
    ]),
  );

export interface BotGameInput extends HostOptions {
  readonly gameId: string;
  readonly seed: string;
  readonly policies: ReadonlyArray<BotPolicy>;
  readonly rules?: Partial<RulesConfig>;
}

/** Plays a bot-only game synchronously. */
export const runBotGame = (input: BotGameInput): GameResult =>
  runGameSync({
    digest: false,
    ...input,
    config: createConfig({
      gameId: input.gameId,
      seed: input.seed,
      seats: botSeats(input.policies),
      rules: input.rules ?? {},
    }),
    drivers: botDrivers(input.policies, input.seed),
  });
