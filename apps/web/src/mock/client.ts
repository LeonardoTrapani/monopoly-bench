/**
 * The in-browser mock API (`VITE_API_MODE=mock`): generated leaderboards, model profiles and
 * runs, games backed by the sim fixtures, and a fake live game replayed on a timer. It simulates
 * a server, so unlike the app it keeps mutable state (runs created from the form).
 */
import {
  BotSeat,
  LlmSeat,
  defaultModelCatalog,
  type GameSummary,
  type RunConfig,
  type RunSummary,
  type SeatSpec,
} from "@mb/api";
import { Effect, Layer, Option, Stream } from "effect";

import { Api, ApiError, type ApiClient, type GamesQuery } from "../api/api.ts";
import { COMPETITORS, competitorById, mockLeaderboard, mockProfile } from "./competitors.ts";
import {
  GAME_DEFS,
  LIVE_GAME_ID,
  finishedSummary,
  gameDef,
  loadGame,
  summarize,
  type MockGameDef,
} from "./games.ts";
import {
  buildSchedule,
  isLiveFinished,
  liveEvents,
  liveFeed,
  liveTranscripts,
  type LiveSchedule,
} from "./live.ts";
import { mockWakes } from "./transcripts.ts";

const MIN_LATENCY_MS = 120;

const MAX_LATENCY_MS = 420;

const QUEUED_TO_RUNNING_MS = 6000;

const latency = <A>(effect: Effect.Effect<A, ApiError>): Effect.Effect<A, ApiError> =>
  Effect.sleep(MIN_LATENCY_MS + Math.random() * (MAX_LATENCY_MS - MIN_LATENCY_MS)).pipe(
    Effect.andThen(effect),
  );

const notFound = (what: string) =>
  Effect.fail(new ApiError({ status: 404, message: `${what} not found` }));

let liveSchedule: LiveSchedule | null = null;

const schedule = (): LiveSchedule => {
  if (liveSchedule !== null) return liveSchedule;

  const def = gameDef(LIVE_GAME_ID);

  if (def === undefined) throw new Error("The mock live game is missing");

  const game = loadGame(def);

  liveSchedule = buildSchedule(game, mockWakes(game.config, game.events));

  return liveSchedule;
};

const isLiveDef = (def: MockGameDef): boolean => def.isLive && !isLiveFinished(schedule());

const summaryOf = (def: MockGameDef): GameSummary => {
  if (!def.isLive) return finishedSummary(def);

  const live = schedule();

  return summarize(def, live.game.config, liveEvents(live), !isLiveFinished(live));
};

const seatSpec = (competitorId: string): SeatSpec => {
  const competitor = competitorById(competitorId);

  if (competitorId.startsWith("bot:")) {
    return BotSeat.make({ policy: competitorId === "bot:random" ? "random" : "heuristic" });
  }

  const [model = competitorId, reasoning] = competitorId.split(":");

  return reasoning === "high"
    ? LlmSeat.make({ model, label: competitor?.label ?? model, reasoning: "high" })
    : LlmSeat.make({ model, label: competitor?.label ?? model });
};

const lineupOf = (runId: string): ReadonlyArray<SeatSpec> =>
  (GAME_DEFS.find((def) => def.runId === runId)?.lineup ?? []).map(seatSpec);

const BASE_RUNS: ReadonlyArray<RunSummary> = [
  {
    id: "run-frontier-4p",
    name: "Frontier league · 4 players",
    createdAt: "2026-10-28T05:50:00.000Z",
    status: "running",
    playersCount: 4,
    seats: lineupOf("run-frontier-4p"),
    gamesTotal: 24,
    gamesFinished: 9,
    gamesRunning: 2,
    spentUsd: 41.27,
    budgetUsd: 150,
  },
  {
    id: "run-open-4p",
    name: "Open models vs baselines",
    createdAt: "2026-10-27T15:30:00.000Z",
    status: "finished",
    playersCount: 4,
    seats: lineupOf("run-open-4p"),
    gamesTotal: 16,
    gamesFinished: 16,
    gamesRunning: 0,
    spentUsd: 18.42,
    budgetUsd: 40,
  },
  {
    id: "run-heads-up",
    name: "Heads-up duels",
    createdAt: "2026-10-26T09:30:00.000Z",
    status: "finished",
    playersCount: 2,
    seats: lineupOf("run-heads-up"),
    gamesTotal: 8,
    gamesFinished: 8,
    gamesRunning: 0,
    spentUsd: 9.06,
    budgetUsd: 20,
  },
  {
    id: "run-big-3p",
    name: "Three-way tables",
    createdAt: "2026-10-25T13:50:00.000Z",
    status: "finished",
    playersCount: 3,
    seats: lineupOf("run-big-3p"),
    gamesTotal: 6,
    gamesFinished: 6,
    gamesRunning: 0,
    spentUsd: 7.9,
    budgetUsd: 15,
  },
  {
    id: "run-big-5p",
    name: "Five at the table",
    createdAt: "2026-10-25T15:20:00.000Z",
    status: "finished",
    playersCount: 5,
    seats: lineupOf("run-big-5p"),
    gamesTotal: 10,
    gamesFinished: 10,
    gamesRunning: 0,
    spentUsd: 12.35,
    budgetUsd: 30,
  },
  {
    id: "run-big-6p",
    name: "Full table · 6 players",
    createdAt: "2026-10-25T17:00:00.000Z",
    status: "cancelled",
    playersCount: 6,
    seats: lineupOf("run-big-6p"),
    gamesTotal: 12,
    gamesFinished: 5,
    gamesRunning: 0,
    spentUsd: 25,
    budgetUsd: 25,
  },
];

const createdRuns: Array<RunSummary> = [];

const withLiveStatus = (run: RunSummary): RunSummary => {
  if (run.status !== "queued") return run;

  return Date.now() - Date.parse(run.createdAt) > QUEUED_TO_RUNNING_MS
    ? { ...run, status: "running", gamesRunning: Math.min(run.gamesTotal, 2) }
    : run;
};

const allRuns = (): ReadonlyArray<RunSummary> => [
  ...createdRuns.map(withLiveStatus).reverse(),
  ...BASE_RUNS,
];

const matchesQuery = (summary: GameSummary, query: GamesQuery): boolean => {
  const isLive = summary.status === "running" || summary.status === "queued";

  const statusOk = Option.match(query.status, {
    onNone: () => true,
    onSome: (status) => (status === "live" ? isLive : !isLive),
  });

  const playersOk = Option.match(query.players, {
    onNone: () => true,
    onSome: (players) => summary.playersCount === players,
  });

  const modelOk = Option.match(query.model, {
    onNone: () => true,
    onSome: (model) =>
      summary.seats.some(
        (seat) => seat.competitorId === model || seat.competitorId.startsWith(`${model}:`),
      ),
  });

  return statusOk && playersOk && modelOk;
};

const allSummaries = (): ReadonlyArray<GameSummary> =>
  GAME_DEFS.map(summaryOf).sort((left, right) =>
    (right.startedAt ?? "").localeCompare(left.startedAt ?? ""),
  );

const mockClient = (): ApiClient => ({
  leaderboard: (players) => latency(Effect.sync(() => mockLeaderboard(players))),
  models: latency(
    Effect.sync(() => ({
      competitors: COMPETITORS.map((competitor) => ({
        competitorId: competitor.competitorId,
        label: competitor.label,
        kind: competitor.kind,
        games:
          mockLeaderboard(4).entries.find((entry) => entry.competitorId === competitor.competitorId)
            ?.games ?? 0,
      })),
      catalog: defaultModelCatalog,
    })),
  ),
  model: (competitorId) =>
    latency(
      Effect.suspend(() => {
        const competitor = competitorById(competitorId);

        if (competitor === undefined) return notFound("Model");

        const recent = allSummaries().filter((summary) =>
          summary.seats.some((seat) => seat.competitorId === competitorId),
        );

        return Effect.succeed(mockProfile(competitor, recent));
      }),
    ),
  runs: latency(Effect.sync(() => ({ runs: allRuns() }))),
  run: (runId) =>
    latency(
      Effect.suspend(() => {
        const run = allRuns().find((candidate) => candidate.id === runId);

        if (run === undefined) return notFound("Run");

        return Effect.succeed({
          run,
          games: GAME_DEFS.filter((def) => def.runId === runId).map(summaryOf),
        });
      }),
    ),
  games: (query) =>
    latency(
      Effect.sync(() => ({
        games: allSummaries().filter((summary) => matchesQuery(summary, query)),
      })),
    ),
  game: (gameId) =>
    latency(
      Effect.suspend(() => {
        const def = gameDef(gameId);

        return def === undefined ? notFound("Game") : Effect.succeed(summaryOf(def));
      }),
    ),
  gameConfig: (gameId) =>
    latency(
      Effect.suspend(() => {
        const def = gameDef(gameId);

        return def === undefined ? notFound("Game") : Effect.succeed(loadGame(def).config);
      }),
    ),
  gameEvents: (gameId, since) =>
    latency(
      Effect.suspend(() => {
        const def = gameDef(gameId);

        if (def === undefined) return notFound("Game");

        const events = def.isLive ? liveEvents(schedule()) : loadGame(def).events;

        return Effect.succeed(events.filter((event) => event.seq > since));
      }),
    ),
  transcripts: (gameId) =>
    latency(
      Effect.suspend(() => {
        const def = gameDef(gameId);

        if (def === undefined) return notFound("Game");

        if (def.isLive) return Effect.succeed(liveTranscripts(schedule()));

        const game = loadGame(def);

        return Effect.succeed(mockWakes(game.config, game.events).map((wake) => wake.transcript));
      }),
    ),
  createRun: (config: RunConfig, apiKey) =>
    latency(
      Effect.suspend(() => {
        if (apiKey.trim() === "" || apiKey === "invalid") {
          return Effect.fail(new ApiError({ status: 401, message: "Missing or invalid API key" }));
        }

        const run: RunSummary = {
          id: `run-${Date.now().toString(36)}`,
          name: config.name ?? null,
          createdAt: new Date().toISOString(),
          status: "queued",
          playersCount:
            config.players.length === 2 ||
            config.players.length === 3 ||
            config.players.length === 5 ||
            config.players.length === 6
              ? config.players.length
              : 4,
          seats: config.players,
          gamesTotal: config.seeds * config.players.length,
          gamesFinished: 0,
          gamesRunning: 0,
          spentUsd: 0,
          budgetUsd: config.budgetUsd,
        };

        createdRuns.push(run);

        return Effect.succeed(run);
      }),
    ),
  cancelRun: (runId, apiKey) =>
    latency(
      Effect.suspend(() => {
        if (apiKey.trim() === "")
          return Effect.fail(new ApiError({ status: 401, message: "Missing or invalid API key" }));

        const index = createdRuns.findIndex((run) => run.id === runId);
        const run = createdRuns[index];

        if (run === undefined) {
          const base = BASE_RUNS.find((candidate) => candidate.id === runId);

          return base === undefined
            ? notFound("Run")
            : Effect.succeed({ ...base, status: "cancelled" as const });
        }

        const cancelled: RunSummary = { ...run, status: "cancelled", gamesRunning: 0 };

        createdRuns[index] = cancelled;

        return Effect.succeed(cancelled);
      }),
    ),
  spectate: (gameId) => {
    const def = gameDef(gameId);

    if (def === undefined || !isLiveDef(def)) return Stream.empty;

    return liveFeed(schedule(), gameId);
  },
});

export const MockApiLive: Layer.Layer<Api> = Layer.sync(Api, mockClient);
