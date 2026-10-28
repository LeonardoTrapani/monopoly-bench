import { listingsOfModelList } from "@mb/agent";
import { openRouterModelListSample } from "@mb/agent/testing";
import {
  BotSeat,
  CatalogResponse,
  CreateRunResponse,
  ErrorResponse,
  GameSummary,
  GamesResponse,
  Leaderboard,
  LlmSeat,
  ModelProfile,
  ModelsResponse,
  type RunConfig,
  RunDetail,
  RunsResponse,
} from "@mb/api";
import type { D1Client } from "@effect/sql-d1";
import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/sql/SqlClient";
import { describe, expect, it } from "vite-plus/test";

import { deleteRunArchives } from "../archive.ts";
import { liveSnapshot } from "../catalog.ts";
import type { GameStart } from "../contracts.ts";
import { applyGameRatings } from "../db/ratings-store.ts";
import {
  abortQueuedGames,
  finishGame,
  insertRun,
  markGameRunning,
  recordWake,
  updateRun,
} from "../db/writes.ts";
import { archiveKeys } from "../game/game-host.ts";
import type { KeyCheck } from "../openrouter-key.ts";
import { RunCoordinator } from "../runs/run-coordinator.ts";
import { memoryBucket } from "../testing/archive.ts";
import { memoryD1, memorySqlPort } from "../testing/sqlite.ts";
import { sha256Hex } from "./auth.ts";
import { type ApiDeps, handleApi } from "./router.ts";

const API_KEY = "test-key";

const OWN_KEY = "sk-or-v1-creator-own-key-0123456789";

const haiku = LlmSeat.make({ model: "anthropic/claude-haiku-5.5", label: "Claude Haiku 5.5" });

const sol = LlmSeat.make({ model: "openai/gpt-6.1-sol", label: "GPT-6.1 Sol" });

const grok = LlmSeat.make({ model: "x-ai/grok-4.7", label: "Grok 4.7" });

/** Two of its four games at once, so queueing is exercised (the default would start all four). */
const runConfig: RunConfig = {
  name: "smoke",
  players: [haiku, sol],
  seeds: 2,
  concurrency: 2,
  budgetUsd: 10,
};

const decode = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, text: string): S["Type"] =>
  Schema.decodeUnknownSync(Schema.fromJsonString(schema))(text);

const snapshot = liveSnapshot(
  listingsOfModelList(openRouterModelListSample()),
  "2026-10-28T09:00:00.000Z",
);

interface CallInit {
  readonly body?: string;
  readonly key?: string;
  readonly ownKey?: string;
  readonly runToken?: string;
}

/** What the fake OpenRouter answers about the next key it is asked about. */
interface KeyCheckScript {
  next: KeyCheck;
}

const setup = () => {
  const d1 = memoryD1();

  const runD1 = <A, E>(effect: Effect.Effect<A, E, D1Client.D1Client | SqlClient>) =>
    Effect.runPromise(effect.pipe(Effect.provide(d1.layer)));

  const started: Array<GameStart> = [];
  const purged: Array<string> = [];
  const keyChecks: Array<string> = [];
  const archive = memoryBucket();
  const coordinators = new Map<string, RunCoordinator>();
  const keyCheck: KeyCheckScript = { next: { status: "valid", limitRemainingUsd: null } };
  let finishedGames = 0;

  const coordinator = (runId: string): RunCoordinator => {
    const existing = coordinators.get(runId);

    if (existing !== undefined) return existing;

    const created = new RunCoordinator({
      sql: memorySqlPort(),
      db: {
        insertRun: (run) => runD1(insertRun(run)),
        updateRun: (id, status, spent, finishedAt) =>
          runD1(updateRun(id, status, spent, finishedAt)),
        abortQueued: (ids, at) => runD1(abortQueuedGames(ids, at)),
        applyRatings: async (input) => {
          await runD1(applyGameRatings(input));
        },
      },
      games: {
        start: async (start) => {
          started.push(start);
          await runD1(markGameRunning(start.gameId, "2026-10-28T10:00:00.000Z"));
        },
        abort: async () => {},
        purge: async (gameId) => {
          purged.push(gameId);
        },
      },
      setAlarm: async () => {},
      now: () => Date.parse("2026-10-28T10:00:00.000Z"),
      log: () => {},
    });

    coordinators.set(runId, created);

    return created;
  };

  let nextRun = 0;

  const deps: ApiDeps = {
    benchApiKey: API_KEY,
    runs: {
      create: (runId, config, listings, ownKey) =>
        coordinator(runId).create(runId, config, listings, ownKey),
      cancel: async (runId) => (coordinators.has(runId) ? coordinator(runId).cancel() : null),
      cancelTokenMatches: async (runId, tokenSha256) =>
        coordinators.has(runId) && coordinator(runId).cancelTokenMatches(tokenSha256),
      purge: async (runId) => {
        if (coordinators.has(runId)) await coordinator(runId).purge();
      },
    },
    games: {
      liveEvents: async () => '{"seq":1}\n',
      archivedEvents: async (gameId) => archive.objects.get(archiveKeys.events(gameId)) ?? null,
      liveTranscripts: async () => "",
      archivedTranscripts: async (gameId, seat) => `{"gameId":"${gameId}","seat":"${seat}"}\n`,
      liveConfig: async () => null,
      archivedConfig: async (gameId) => `{"gameId":"${gameId}"}`,
      spectate: async () => new Response(null, { status: 204 }),
      deleteArchives: async (runId, gameIds) => {
        await deleteRunArchives(archive.bucket, runId, gameIds);
      },
    },
    catalog: async () => snapshot,
    checkOpenRouterKey: async (key) => {
      keyChecks.push(key);

      return keyCheck.next;
    },
    newRunId: () => {
      nextRun += 1;

      return `r-test-${nextRun}`;
    },
    newCancelToken: () => `token-${nextRun + 1}`,
  };

  const call = (method: string, path: string, init: CallInit = {}) => {
    const headers = new Headers({ "content-type": "application/json" });

    if (init.key !== undefined) headers.set("authorization", `Bearer ${init.key}`);

    if (init.ownKey !== undefined) headers.set("x-openrouter-key", init.ownKey);

    if (init.runToken !== undefined) headers.set("x-run-token", init.runToken);

    const request = new Request(`https://bench.test${path}`, {
      method,
      headers,
      body: init.body ?? null,
    });

    return runD1(handleApi(request, deps));
  };

  const create = async (config: RunConfig = runConfig) =>
    decode(
      CreateRunResponse,
      await (
        await call("POST", "/api/runs", { body: JSON.stringify(config), key: API_KEY })
      ).text(),
    );

  /** Finish one started game: the `winner` model's seat wins; its seat made one wake. */
  const finishStarted = async (start: GameStart, winner = haiku.model) => {
    const winnerSeat = start.seats.find((seat) => seat.competitorId === winner);
    const loserSeat = start.seats.find((seat) => seat.competitorId !== winner);

    if (winnerSeat === undefined || loserSeat === undefined) throw new Error("bad plan");

    finishedGames += 1;

    const finishedAt = `2026-10-28T11:00:${String(finishedGames).padStart(2, "0")}.000Z`;

    await runD1(
      recordWake({
        gameId: start.gameId,
        seat: winnerSeat.seat,
        decisionId: "1.1",
        competitorId: winnerSeat.competitorId,
        turn: 1,
        kind: "Table",
        round: 1,
        reasons: ["round1"],
        startedAt: "2026-10-28T10:00:01.000Z",
        latencyMs: 1200,
        inputTokens: 1000,
        outputTokens: 100,
        reasoningTokens: 50,
        costUsd: 0.5,
        toolCalls: 4,
        invalidActions: 1,
        timedOut: false,
        endReason: "answered",
        compactions: 0,
      }),
    );
    await runD1(
      finishGame({
        gameId: start.gameId,
        status: "finished",
        endReason: "turnCap",
        abortReason: null,
        winnerSeat: winnerSeat.seat,
        finishedAt,
        turn: 40,
        round: 1,
        seats: [
          {
            seat: winnerSeat.seat,
            rank: 1,
            netWorth: 3000,
            cash: 900,
            bankruptAtTurn: null,
            propertiesBought: 5,
            housesBuilt: 3,
            hotelsBuilt: 0,
            mortgages: 1,
            jailTurns: 2,
          },
          {
            seat: loserSeat.seat,
            rank: 2,
            netWorth: 1000,
            cash: 100,
            bankruptAtTurn: null,
            propertiesBought: 2,
            housesBuilt: 0,
            hotelsBuilt: 0,
            mortgages: 0,
            jailTurns: 0,
          },
        ],
        offers: [
          {
            offerId: "o1",
            turn: 5,
            round: 1,
            fromSeat: winnerSeat.seat,
            fromCompetitor: winnerSeat.competitorId,
            toSeat: loserSeat.seat,
            toCompetitor: loserSeat.competitorId,
            give: { cash: 100 },
            get: { properties: ["Baltic Avenue"] },
            replyTo: null,
            comment: "Fair?",
            status: "accepted",
            acceptedBySeat: loserSeat.seat,
            acceptedByCompetitor: loserSeat.competitorId,
          },
        ],
        auctions: [
          {
            auctionId: "a1",
            turn: 7,
            kind: "property",
            property: "Boardwalk",
            listPrice: 400,
            winnerSeat: winnerSeat.seat,
            winnerCompetitor: winnerSeat.competitorId,
            price: 500,
            bids: 3,
          },
        ],
      }),
    );

    archive.objects.set(archiveKeys.events(start.gameId), '{"seq":1}\n{"seq":2}\n{"seq":3}\n');
    archive.objects.set(archiveKeys.config(start.gameId), "{}");
    archive.objects.set(archiveKeys.seat(start.gameId, "A"), "");

    await coordinator(start.runId).gameFinished({
      gameId: start.gameId,
      status: "finished",
      playersCount: 2,
      finishedAt,
      results: start.seats.map((seat) => ({
        seat: seat.seat,
        competitorId: seat.competitorId,
        label: seat.label,
        kind: seat.kind,
        rank: seat.competitorId === winner ? 1 : 2,
      })),
    });
  };

  /** Plays every game of the run (including those started as others finish). */
  const finishRun = async (runId: string, winner = haiku.model) => {
    for (let index = 0; index < started.length; index += 1) {
      const start = started[index];

      if (start !== undefined && start.runId === runId) await finishStarted(start, winner);
    }
  };

  /** A finished game of a legacy run with a bot seat, as D1 may still hold. */
  const legacyBotGame = () => {
    d1.db.exec(`
      INSERT INTO runs (id, name, created_at, status, players_count, config_json, seats_json, games_total, budget_usd)
        VALUES ('r-legacy', 'legacy', '2026-10-01T00:00:00.000Z', 'finished', 2, '{}',
          '[{"_tag":"llm","model":"anthropic/claude-haiku-5.5","label":"Claude Haiku 5.5"},{"_tag":"bot","policy":"heuristic"}]', 1, 0);
      INSERT INTO games (id, run_id, game_index, seed_index, rotation, seed, status, players_count, finished_at, updated_at)
        VALUES ('r-legacy-0-0', 'r-legacy', 0, 0, 0, '1', 'finished', 2, '2026-10-01T01:00:00.000Z', '2026-10-01T01:00:00.000Z');
      INSERT INTO seats (game_id, seat, competitor_id, label, kind, spec_json, final_rank, net_worth, properties_bought)
        VALUES ('r-legacy-0-0', 'A', 'anthropic/claude-haiku-5.5', 'Claude Haiku 5.5', 'llm', '{}', 2, 10, 50),
               ('r-legacy-0-0', 'B', 'bot:heuristic', 'Bot (heuristic)', 'bot', '{}', 1, 9000, 0);
      INSERT INTO offers (game_id, offer_id, turn, round, from_seat, from_competitor, to_seat, to_competitor, give_json, get_json, status)
        VALUES ('r-legacy-0-0', 'o9', 1, 1, 'A', 'anthropic/claude-haiku-5.5', 'B', 'bot:heuristic', '{}', '{}', 'open');
      INSERT INTO ratings (competitor_id, players_count, label, kind, mu, sigma, score, games, wins, updated_at)
        VALUES ('bot:heuristic', 2, 'Bot (heuristic)', 'bot', 40, 2, 34, 1, 1, '2026-10-01T01:00:00.000Z');
    `);
  };

  return {
    call,
    create,
    started,
    purged,
    keyChecks,
    keyCheck,
    archive,
    d1,
    finishStarted,
    finishRun,
    legacyBotGame,
  };
};

describe("HTTP API", () => {
  it("answers CORS preflights and unknown routes", async () => {
    const h = setup();
    const preflight = await h.call("OPTIONS", "/api/runs");

    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
    expect(preflight.headers.get("access-control-allow-headers")).toBe(
      "authorization, content-type, x-openrouter-key, x-run-token",
    );
    expect(preflight.headers.get("access-control-allow-methods")).toContain("DELETE");

    const missing = await h.call("GET", "/api/nothing");

    expect(missing.status).toBe(404);
    expect(decode(ErrorResponse, await missing.text()).error).toBe("Not found");
  });

  it("serves the catalog of tool models with prices and estimates", async () => {
    const h = setup();
    const response = await h.call("GET", "/api/catalog");
    const catalog = decode(CatalogResponse, await response.text());

    expect(response.status).toBe(200);
    expect(catalog.source).toBe("openrouter");
    expect(catalog.models.map((entry) => entry.model)).toContain("anthropic/claude-haiku-5.5");
    expect(catalog.models.map((entry) => entry.model)).not.toContain(
      "moondream/moondream3-preview",
    );
    expect(catalog.models[0]).toMatchObject({ featured: true, providerSlug: "anthropic" });
  });

  it("protects run creation and validates the RunConfig", async () => {
    const h = setup();
    const body = JSON.stringify(runConfig);
    const unauthorized = await h.call("POST", "/api/runs", { body });

    expect(unauthorized.status).toBe(401);
    expect(decode(ErrorResponse, await unauthorized.text()).error).toContain("x-openrouter-key");
    expect((await h.call("POST", "/api/runs", { body, key: "wrong" })).status).toBe(401);

    const invalid = await h.call("POST", "/api/runs", {
      body: JSON.stringify({ ...runConfig, seeds: 0 }),
      key: API_KEY,
    });

    expect(invalid.status).toBe(400);
    expect(decode(ErrorResponse, await invalid.text()).error).toContain("Invalid RunConfig");
    expect(h.started).toHaveLength(0);
  });

  it("seats LLMs only, from the catalog, with tools", async () => {
    const h = setup();

    const rejected = async (players: ReadonlyArray<unknown>) => {
      const response = await h.call("POST", "/api/runs", {
        body: JSON.stringify({ ...runConfig, players }),
        key: API_KEY,
      });

      expect(response.status).toBe(400);

      return decode(ErrorResponse, await response.text()).error;
    };

    expect(await rejected([haiku, BotSeat.make({ policy: "heuristic" })])).toContain(
      "Public runs seat LLMs only",
    );
    expect(await rejected([haiku, { ...sol, model: "nobody/nothing" }])).toContain(
      'Model "nobody/nothing" is not in the catalog',
    );
    expect(await rejected([haiku, { ...sol, model: "moondream/moondream3-preview" }])).toContain(
      "does not support tool calling",
    );
    expect(h.started).toHaveLength(0);
  });

  it("creates a run, starts games up to the concurrency and lists them", async () => {
    const h = setup();

    const created = await h.call("POST", "/api/runs", {
      body: JSON.stringify(runConfig),
      key: API_KEY,
    });

    expect(created.status).toBe(201);
    expect(created.headers.get("access-control-allow-origin")).toBe("*");

    const { run, cancelToken } = decode(CreateRunResponse, await created.text());

    expect(cancelToken).toBeNull();
    expect(run).toMatchObject({
      funding: "server",
      name: "smoke",
      status: "running",
      playersCount: 2,
      gamesTotal: 4,
      budgetUsd: 10,
    });
    expect(h.started.map((start) => start.gameId)).toEqual([`${run.id}-0-0`, `${run.id}-0-1`]);
    // The run is priced from OpenRouter's listing of its models.
    expect(h.started[0]?.listings.map((listing) => listing.id).sort()).toEqual([
      haiku.model,
      sol.model,
    ]);

    const runs = decode(RunsResponse, await (await h.call("GET", "/api/runs")).text());

    expect(runs.runs.map((entry) => [entry.id, entry.funding])).toEqual([[run.id, "server"]]);
    expect(runs.runs[0]?.gamesRunning).toBe(2);

    const detail = decode(RunDetail, await (await h.call("GET", `/api/runs/${run.id}`)).text());

    expect(detail.games).toHaveLength(4);
    expect(detail.games.map((game) => game.status)).toEqual([
      "running",
      "running",
      "queued",
      "queued",
    ]);
    expect(detail.games[1]?.seats.map((seat) => seat.competitorId)).toEqual([
      sol.model,
      haiku.model,
    ]);
    expect((await h.call("GET", "/api/runs/r-missing")).status).toBe(404);
  });

  it("serves leaderboard, models, profiles and games once games finish", async () => {
    const h = setup();
    const { run } = await h.create();

    await h.finishRun(run.id);

    expect(h.started).toHaveLength(4);

    const detail = decode(RunDetail, await (await h.call("GET", `/api/runs/${run.id}`)).text());

    expect(detail.run.status).toBe("finished");
    expect(detail.run.gamesFinished).toBe(4);
    expect(detail.games[0]?.seats.find((seat) => seat.competitorId === haiku.model)).toMatchObject({
      finalRank: 1,
      costUsd: 0.5,
      wakes: 1,
      invalidActions: 1,
    });

    const board = decode(
      Leaderboard,
      await (await h.call("GET", "/api/leaderboard?players=2")).text(),
    );

    expect(board.entries.map((entry) => entry.competitorId)).toEqual([haiku.model, sol.model]);
    expect(board.entries[0]).toMatchObject({
      kind: "llm",
      games: 4,
      wins: 4,
      avgPlace: 1,
      invalidRate: 0.25,
      costPerGameUsd: 0.5,
    });
    expect(board.entries[0]?.score).toBeCloseTo(
      (board.entries[0]?.mu ?? 0) - 3 * (board.entries[0]?.sigma ?? 0),
    );
    expect(board.entries[1]?.wins).toBe(0);
    expect(board.headToHead).toContainEqual({ a: haiku.model, b: sol.model, games: 4, aAhead: 4 });
    expect(board.updatedAt).not.toBeNull();

    const empty = decode(
      Leaderboard,
      await (await h.call("GET", "/api/leaderboard?players=5")).text(),
    );

    expect(empty.entries).toEqual([]);
    expect((await h.call("GET", "/api/leaderboard?players=9")).status).toBe(400);

    const models = decode(ModelsResponse, await (await h.call("GET", "/api/models")).text());

    expect(models.competitors.map((entry) => [entry.competitorId, entry.games])).toEqual([
      [haiku.model, 4],
      [sol.model, 4],
    ]);

    for (const path of [
      "/api/models/anthropic%2Fclaude-haiku-5.5",
      "/api/models/anthropic/claude-haiku-5.5",
    ]) {
      const profile = decode(ModelProfile, await (await h.call("GET", path)).text());

      expect(profile.label).toBe("Claude Haiku 5.5");
      expect(profile.ratings).toHaveLength(1);
      expect(profile.ratingHistory).toHaveLength(4);
      expect(profile.behavior).toMatchObject({
        offersMade: 4,
        offersAccepted: 4,
        auctionsWon: 4,
        auctionPremium: 1.25,
        propertiesBought: 20,
        housesBuilt: 12,
        mortgages: 4,
        jailTurns: 8,
        bankruptcies: 0,
      });
      expect(profile.recentGames).toHaveLength(4);
    }

    const loser = decode(
      ModelProfile,
      await (await h.call("GET", "/api/models/openai/gpt-6.1-sol")).text(),
    );

    expect(loser.behavior.offersReceived).toBe(4);
    expect(loser.behavior.offersAcceptedFromOthers).toBe(4);
    expect((await h.call("GET", "/api/models/nobody%2Fnothing")).status).toBe(404);

    const games = decode(
      GamesResponse,
      await (
        await h.call("GET", "/api/games?status=finished&players=2&model=anthropic/claude-haiku-5.5")
      ).text(),
    );

    expect(games.games).toHaveLength(4);
    expect(
      decode(GamesResponse, await (await h.call("GET", "/api/games?status=live")).text()).games,
    ).toEqual([]);
    expect((await h.call("GET", "/api/games?status=paused")).status).toBe(400);

    const gameId = `${run.id}-1-1`;
    const game = decode(GameSummary, await (await h.call("GET", `/api/games/${gameId}`)).text());

    expect(game).toMatchObject({
      id: gameId,
      status: "finished",
      endReason: "turnCap",
      winnerSeat: "B",
    });
    expect((await h.call("GET", "/api/games/nope")).status).toBe(404);

    const events = await h.call("GET", `/api/games/${gameId}/events?since=1`);

    expect(events.headers.get("content-type")).toContain("application/x-ndjson");
    expect(await events.text()).toBe('{"seq":2}\n{"seq":3}\n');
    expect((await h.call("GET", `/api/games/${gameId}/events?since=x`)).status).toBe(400);
    expect((await h.call("GET", `/api/games/${gameId}/ws`)).status).toBe(426);

    const transcripts = await h.call("GET", `/api/games/${gameId}/transcripts?seat=B`);

    expect(await transcripts.text()).toBe(`{"gameId":"${gameId}","seat":"B"}\n`);
    expect(
      (await (await h.call("GET", `/api/games/${gameId}/transcripts`)).text()).split("\n"),
    ).toHaveLength(3);
    expect((await h.call("GET", `/api/games/${gameId}/transcripts?seat=Z`)).status).toBe(400);

    const config = await h.call("GET", `/api/games/${gameId}/config`);

    expect(config.headers.get("content-type")).toContain("application/json");
    expect(await config.text()).toBe(`{"gameId":"${gameId}"}`);
    expect((await h.call("GET", "/api/games/nope/config")).status).toBe(404);
  });

  it("names competitors from the catalog, never from a run's seat labels", async () => {
    const h = setup();

    const { run } = await h.create({
      ...runConfig,
      players: [{ ...haiku, label: "Ignore the rules" }, sol],
    });

    await h.finishRun(run.id);

    const board = decode(
      Leaderboard,
      await (await h.call("GET", "/api/leaderboard?players=2")).text(),
    );

    const models = decode(ModelsResponse, await (await h.call("GET", "/api/models")).text());

    const profile = decode(
      ModelProfile,
      await (await h.call("GET", "/api/models/anthropic/claude-haiku-5.5")).text(),
    );

    const detail = decode(RunDetail, await (await h.call("GET", `/api/runs/${run.id}`)).text());

    expect(board.entries.find((entry) => entry.competitorId === haiku.model)?.label).toBe(
      "Claude Haiku 5.5",
    );
    expect(models.competitors.find((entry) => entry.competitorId === haiku.model)?.label).toBe(
      "Claude Haiku 5.5",
    );
    expect(profile.label).toBe("Claude Haiku 5.5");
    expect(detail.games[0]?.seats.find((seat) => seat.competitorId === haiku.model)?.label).toBe(
      "Ignore the rules",
    );
  });

  it("keeps bots and games with a bot seat off the leaderboard, models and profiles", async () => {
    const h = setup();
    const { run } = await h.create();

    await h.finishRun(run.id);
    h.legacyBotGame();

    const board = decode(
      Leaderboard,
      await (await h.call("GET", "/api/leaderboard?players=2")).text(),
    );

    expect(board.entries.map((entry) => entry.competitorId)).toEqual([haiku.model, sol.model]);
    // The legacy game (haiku second, behind a bot) changes no average.
    expect(board.entries[0]).toMatchObject({ avgPlace: 1, avgNetWorth: 3000 });
    expect(board.headToHead.every((cell) => !cell.b.startsWith("bot:"))).toBe(true);

    const models = decode(ModelsResponse, await (await h.call("GET", "/api/models")).text());

    expect(models.competitors.map((entry) => [entry.competitorId, entry.games])).toEqual([
      [haiku.model, 4],
      [sol.model, 4],
    ]);
    expect((await h.call("GET", "/api/models/bot:heuristic")).status).toBe(404);

    const profile = decode(
      ModelProfile,
      await (await h.call("GET", "/api/models/anthropic/claude-haiku-5.5")).text(),
    );

    expect(profile.recentGames.map((game) => game.runId)).not.toContain("r-legacy");
    expect(profile.behavior).toMatchObject({ offersMade: 4, propertiesBought: 20 });

    // The game list still shows it.
    const games = decode(GamesResponse, await (await h.call("GET", "/api/games")).text());

    expect(games.games.map((game) => game.id)).toContain("r-legacy-0-0");
  });

  it("cancels a run with the API key", async () => {
    const h = setup();
    const { run } = await h.create();

    expect((await h.call("POST", `/api/runs/${run.id}/cancel`)).status).toBe(401);

    const cancelled = await h.call("POST", `/api/runs/${run.id}/cancel`, { key: API_KEY });

    expect(cancelled.status).toBe(200);
    expect(decode(CreateRunResponse, await cancelled.text()).run.status).toBe("cancelled");

    const detail = decode(RunDetail, await (await h.call("GET", `/api/runs/${run.id}`)).text());

    expect(detail.run.status).toBe("cancelled");
    expect(detail.games.filter((game) => game.status === "aborted")).toHaveLength(2);
    expect((await h.call("POST", "/api/runs/r-unknown/cancel", { key: API_KEY })).status).toBe(404);
  });
});

describe("own-key runs", () => {
  const ownKeyRun = (h: ReturnType<typeof setup>, config: RunConfig = runConfig) =>
    h.call("POST", "/api/runs", { body: JSON.stringify(config), ownKey: OWN_KEY });

  it("creates a run paid with the creator's key, without the bench key, and returns a cancel token once", async () => {
    const h = setup();
    const created = await ownKeyRun(h);

    expect(created.status).toBe(201);

    const { run, cancelToken } = decode(CreateRunResponse, await created.text());

    expect(h.keyChecks).toEqual([OWN_KEY]);
    expect(run.funding).toBe("ownKey");
    expect(cancelToken).toBe("token-1");

    const listed = await (await h.call("GET", "/api/runs")).text();
    const detail = await (await h.call("GET", `/api/runs/${run.id}`)).text();

    expect(decode(RunsResponse, listed).runs[0]?.funding).toBe("ownKey");

    // The key and the token are in no response and no D1 row; only the token's hash is kept.
    for (const text of [
      listed,
      detail,
      JSON.stringify(h.d1.db.prepare("SELECT * FROM runs").all()),
    ]) {
      expect(text).not.toContain(OWN_KEY);
      expect(text).not.toContain("token-1");
    }
  });

  it("cancels with the run token or the bench key, and refuses other tokens", async () => {
    const h = setup();
    const { run } = decode(CreateRunResponse, await (await ownKeyRun(h)).text());
    const path = `/api/runs/${run.id}/cancel`;

    expect((await h.call("POST", path)).status).toBe(401);
    expect((await h.call("POST", path, { runToken: "token-2" })).status).toBe(401);
    expect((await h.call("POST", path, { runToken: await sha256Hex("token-1") })).status).toBe(401);

    const cancelled = await h.call("POST", path, { runToken: "token-1" });

    expect(cancelled.status).toBe(200);
    expect(decode(CreateRunResponse, await cancelled.text()).run.status).toBe("cancelled");

    // A server-funded run has no token: only the bench key cancels it.
    const server = await h.create();

    expect(
      (await h.call("POST", `/api/runs/${server.run.id}/cancel`, { runToken: "token-1" })).status,
    ).toBe(401);
    expect(
      (await h.call("POST", `/api/runs/${server.run.id}/cancel`, { key: API_KEY })).status,
    ).toBe(200);
  });

  it("rejects a key OpenRouter refuses, one it cannot check, and one short of the budget", async () => {
    const h = setup();

    const failure = async (next: KeyCheck) => {
      h.keyCheck.next = next;

      const response = await ownKeyRun(h);

      return [response.status, decode(ErrorResponse, await response.text()).error] as const;
    };

    const [rejectedStatus, rejected] = await failure({ status: "rejected" });

    expect(rejectedStatus).toBe(401);
    expect(rejected).toContain("OpenRouter rejected the key in x-openrouter-key");

    const [unavailableStatus, unavailable] = await failure({
      status: "unavailable",
      reason: "OpenRouter answered 503",
    });

    expect(unavailableStatus).toBe(502);
    expect(unavailable).toContain("try again");

    const [shortStatus, short] = await failure({ status: "valid", limitRemainingUsd: 2.5 });

    expect(shortStatus).toBe(400);
    expect(short).toContain("$2.50 of credit left, less than the run budget of $10.00");

    h.keyCheck.next = { status: "valid", limitRemainingUsd: 10 };

    expect((await ownKeyRun(h)).status).toBe(201);
    expect(h.started).toHaveLength(2);

    for (const message of [rejected, unavailable, short]) expect(message).not.toContain(OWN_KEY);
  });

  it("checks the run before the key: an invalid body never reaches OpenRouter", async () => {
    const h = setup();

    const response = await h.call("POST", "/api/runs", {
      body: JSON.stringify({ ...runConfig, players: [haiku, { ...sol, model: "nobody/x" }] }),
      ownKey: OWN_KEY,
    });

    expect(response.status).toBe(400);
    expect(h.keyChecks).toEqual([]);
  });
});

describe("deleting runs", () => {
  it("needs the bench key and an existing run", async () => {
    const h = setup();
    const { run } = await h.create();

    expect((await h.call("DELETE", `/api/runs/${run.id}`)).status).toBe(401);
    expect((await h.call("DELETE", `/api/runs/${run.id}`, { ownKey: OWN_KEY })).status).toBe(401);
    expect((await h.call("DELETE", "/api/runs/r-missing", { key: API_KEY })).status).toBe(404);
  });

  it("removes the run's rows, archives and Durable Objects, and replays the ratings without it", async () => {
    // Reference: a bench where only the second run (sol beats grok) was ever played.
    const reference = setup();
    const kept = await reference.create({ ...runConfig, players: [sol, grok] });

    await reference.finishRun(kept.run.id, sol.model);

    const expected = decode(
      Leaderboard,
      await (await reference.call("GET", "/api/leaderboard?players=2")).text(),
    );

    const h = setup();
    const deleted = await h.create();

    await h.finishRun(deleted.run.id);

    const other = await h.create({ ...runConfig, players: [sol, grok] });

    await h.finishRun(other.run.id, sol.model);

    const before = decode(
      Leaderboard,
      await (await h.call("GET", "/api/leaderboard?players=2")).text(),
    );

    expect(before.entries.map((entry) => entry.competitorId).sort()).toEqual(
      [haiku.model, sol.model, grok.model].sort(),
    );
    expect(h.archive.objects.size).toBe(24);

    const response = await h.call("DELETE", `/api/runs/${deleted.run.id}`, { key: API_KEY });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(h.purged).toEqual(
      ["0-0", "0-1", "1-0", "1-1"].map((suffix) => `${deleted.run.id}-${suffix}`),
    );

    // D1: nothing left of the deleted run.
    for (const table of ["seats", "wakes", "offers", "auctions", "rating_history"]) {
      const rows = h.d1.db
        .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE game_id LIKE ?`)
        .get(`${deleted.run.id}-%`);

      expect({ table, rows }).toEqual({ table, rows: { n: 0 } });
    }

    expect(
      h.d1.db.prepare("SELECT COUNT(*) AS n FROM games WHERE run_id = ?").get(deleted.run.id),
    ).toEqual({ n: 0 });
    expect(h.d1.db.prepare("SELECT id FROM runs").all()).toEqual([{ id: other.run.id }]);
    expect((await h.call("GET", `/api/runs/${deleted.run.id}`)).status).toBe(404);

    // R2: only the other run's archives are left.
    expect(
      [...h.archive.objects.keys()].every((key) => key.startsWith(`games/${other.run.id}-`)),
    ).toBe(true);
    expect(h.archive.objects.size).toBe(12);

    // Ratings: replayed from the remaining games, as if the deleted run never happened.
    const after = decode(
      Leaderboard,
      await (await h.call("GET", "/api/leaderboard?players=2")).text(),
    );

    expect(after.entries.map((entry) => entry.competitorId)).toEqual([sol.model, grok.model]);
    expect(
      after.entries.map((entry) => [
        entry.competitorId,
        entry.mu,
        entry.sigma,
        entry.games,
        entry.wins,
      ]),
    ).toEqual(
      expected.entries.map((entry) => [
        entry.competitorId,
        entry.mu,
        entry.sigma,
        entry.games,
        entry.wins,
      ]),
    );
    expect(after.headToHead).toEqual(expected.headToHead);

    const profile = decode(
      ModelProfile,
      await (await h.call("GET", "/api/models/openai/gpt-6.1-sol")).text(),
    );

    expect(profile.ratingHistory).toHaveLength(4);

    // Deleting again: the run is gone.
    expect((await h.call("DELETE", `/api/runs/${deleted.run.id}`, { key: API_KEY })).status).toBe(
      404,
    );
  });

  it("deletes a running run: its games stop for good", async () => {
    const h = setup();

    const { run } = decode(
      CreateRunResponse,
      await (
        await h.call("POST", "/api/runs", { body: JSON.stringify(runConfig), ownKey: OWN_KEY })
      ).text(),
    );

    expect((await h.call("DELETE", `/api/runs/${run.id}`, { key: API_KEY })).status).toBe(204);
    expect(h.purged).toEqual([`${run.id}-0-0`, `${run.id}-0-1`]);
    expect(h.d1.db.prepare("SELECT COUNT(*) AS n FROM games").get()).toEqual({ n: 0 });
  });
});
