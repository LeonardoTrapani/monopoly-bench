import {
  BotSeat,
  CreateRunResponse,
  defaultModelCatalog,
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
import { RunCoordinator } from "../runs/run-coordinator.ts";
import { memoryD1, memorySqlPort } from "../testing/sqlite.ts";
import { type ApiDeps, handleApi } from "./router.ts";

const API_KEY = "test-key";

const opus = LlmSeat.make({ model: "anthropic/claude-opus-5.5", label: "Claude Opus 5.5" });

const heuristic = BotSeat.make({ policy: "heuristic" });

const runConfig: RunConfig = { name: "smoke", players: [opus, heuristic], seeds: 2, budgetUsd: 10 };

const decode = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, text: string): S["Type"] =>
  Schema.decodeUnknownSync(Schema.fromJsonString(schema))(text);

const setup = () => {
  const d1 = memoryD1();

  const runD1 = <A, E>(effect: Effect.Effect<A, E, D1Client.D1Client | SqlClient>) =>
    Effect.runPromise(effect.pipe(Effect.provide(d1.layer)));

  const started: Array<GameStart> = [];
  const archive = new Map<string, string>();
  const coordinators = new Map<string, RunCoordinator>();

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
    catalog: defaultModelCatalog,
    runs: {
      create: (runId, config, listings) => coordinator(runId).create(runId, config, listings),
      cancel: async (runId) => (coordinators.has(runId) ? coordinator(runId).cancel() : null),
    },
    games: {
      liveEvents: async () => '{"seq":1}\n',
      archivedEvents: async (gameId) => archive.get(gameId) ?? null,
      liveTranscripts: async () => "",
      archivedTranscripts: async (gameId, seat) => `{"gameId":"${gameId}","seat":"${seat}"}\n`,
      spectate: async () => new Response(null, { status: 204 }),
    },
    listings: async () => [],
    newRunId: () => {
      nextRun += 1;

      return `r-test-${nextRun}`;
    },
  };

  const call = (method: string, path: string, init: { body?: string; key?: string } = {}) => {
    const headers = new Headers({ "content-type": "application/json" });

    if (init.key !== undefined) headers.set("authorization", `Bearer ${init.key}`);

    const request = new Request(`https://bench.test${path}`, {
      method,
      headers,
      body: init.body ?? null,
    });

    return runD1(handleApi(request, deps));
  };

  /** Finish one started game: the LLM seat (A or B) wins every game it plays. */
  const finishStarted = async (start: GameStart) => {
    const llmSeat = start.seats.find((seat) => seat.kind === "llm");
    const botSeat = start.seats.find((seat) => seat.kind === "bot");

    if (llmSeat === undefined || botSeat === undefined) throw new Error("bad plan");

    await runD1(
      recordWake({
        gameId: start.gameId,
        seat: llmSeat.seat,
        decisionId: "1.1",
        competitorId: llmSeat.competitorId,
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
      }),
    );
    await runD1(
      finishGame({
        gameId: start.gameId,
        status: "finished",
        endReason: "turnCap",
        winnerSeat: llmSeat.seat,
        finishedAt: "2026-10-28T11:00:00.000Z",
        turn: 40,
        round: 1,
        seats: [
          {
            seat: llmSeat.seat,
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
            seat: botSeat.seat,
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
            fromSeat: llmSeat.seat,
            fromCompetitor: llmSeat.competitorId,
            toSeat: botSeat.seat,
            toCompetitor: botSeat.competitorId,
            give: { cash: 100 },
            get: { properties: ["Baltic Avenue"] },
            replyTo: null,
            comment: "Fair?",
            status: "accepted",
            acceptedBySeat: botSeat.seat,
            acceptedByCompetitor: botSeat.competitorId,
          },
        ],
        auctions: [
          {
            auctionId: "a1",
            turn: 7,
            kind: "property",
            property: "Boardwalk",
            listPrice: 400,
            winnerSeat: llmSeat.seat,
            winnerCompetitor: llmSeat.competitorId,
            price: 500,
            bids: 3,
          },
        ],
      }),
    );
    archive.set(start.gameId, '{"seq":1}\n{"seq":2}\n{"seq":3}\n');
    await coordinator(start.runId).gameFinished({
      gameId: start.gameId,
      status: "finished",
      playersCount: 2,
      finishedAt: "2026-10-28T11:00:00.000Z",
      results: start.seats.map((seat) => ({
        seat: seat.seat,
        competitorId: seat.competitorId,
        label: seat.label,
        kind: seat.kind,
        rank: seat.kind === "llm" ? 1 : 2,
      })),
    });
  };

  return { call, started, finishStarted };
};

describe("HTTP API", () => {
  it("answers CORS preflights and unknown routes", async () => {
    const h = setup();
    const preflight = await h.call("OPTIONS", "/api/runs");

    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
    expect(preflight.headers.get("access-control-allow-headers")).toContain("authorization");

    const missing = await h.call("GET", "/api/nothing");

    expect(missing.status).toBe(404);
    expect(decode(ErrorResponse, await missing.text()).error).toBe("Not found");
  });

  it("protects run creation and validates the RunConfig", async () => {
    const h = setup();
    const body = JSON.stringify(runConfig);

    expect((await h.call("POST", "/api/runs", { body })).status).toBe(401);
    expect((await h.call("POST", "/api/runs", { body, key: "wrong" })).status).toBe(401);

    const invalid = await h.call("POST", "/api/runs", {
      body: JSON.stringify({ ...runConfig, seeds: 0 }),
      key: API_KEY,
    });

    expect(invalid.status).toBe(400);
    expect(decode(ErrorResponse, await invalid.text()).error).toContain("Invalid RunConfig");
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

    const { run } = decode(CreateRunResponse, await created.text());

    expect(run).toMatchObject({
      name: "smoke",
      status: "running",
      playersCount: 2,
      gamesTotal: 4,
      budgetUsd: 10,
    });
    expect(h.started.map((start) => start.gameId)).toEqual([`${run.id}-0-0`, `${run.id}-0-1`]);

    const runs = decode(RunsResponse, await (await h.call("GET", "/api/runs")).text());

    expect(runs.runs.map((entry) => entry.id)).toEqual([run.id]);
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
      "bot:heuristic",
      "anthropic/claude-opus-5.5",
    ]);
    expect((await h.call("GET", "/api/runs/r-missing")).status).toBe(404);
  });

  it("serves leaderboard, models, profiles and games once games finish", async () => {
    const h = setup();

    const created = await h.call("POST", "/api/runs", {
      body: JSON.stringify(runConfig),
      key: API_KEY,
    });

    const { run } = decode(CreateRunResponse, await created.text());

    for (let index = 0; index < h.started.length; index += 1) {
      const start = h.started[index];

      if (start !== undefined) await h.finishStarted(start);
    }

    expect(h.started).toHaveLength(4);

    const detail = decode(RunDetail, await (await h.call("GET", `/api/runs/${run.id}`)).text());

    expect(detail.run.status).toBe("finished");
    expect(detail.run.gamesFinished).toBe(4);
    expect(detail.games[0]?.seats.find((seat) => seat.kind === "llm")).toMatchObject({
      finalRank: 1,
      costUsd: 0.5,
      wakes: 1,
      invalidActions: 1,
    });

    const board = decode(
      Leaderboard,
      await (await h.call("GET", "/api/leaderboard?players=2")).text(),
    );

    expect(board.entries.map((entry) => entry.competitorId)).toEqual([
      "anthropic/claude-opus-5.5",
      "bot:heuristic",
    ]);
    expect(board.entries[0]).toMatchObject({
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
    expect(board.headToHead).toContainEqual({
      a: "anthropic/claude-opus-5.5",
      b: "bot:heuristic",
      games: 4,
      aAhead: 4,
    });
    expect(board.updatedAt).not.toBeNull();

    const empty = decode(
      Leaderboard,
      await (await h.call("GET", "/api/leaderboard?players=5")).text(),
    );

    expect(empty.entries).toEqual([]);
    expect((await h.call("GET", "/api/leaderboard?players=9")).status).toBe(400);

    const models = decode(ModelsResponse, await (await h.call("GET", "/api/models")).text());

    expect(models.catalog).toEqual(defaultModelCatalog);
    expect(models.competitors.map((entry) => [entry.competitorId, entry.games])).toEqual([
      ["anthropic/claude-opus-5.5", 4],
      ["bot:heuristic", 4],
    ]);

    for (const path of [
      "/api/models/anthropic%2Fclaude-opus-5.5",
      "/api/models/anthropic/claude-opus-5.5",
    ]) {
      const profile = decode(ModelProfile, await (await h.call("GET", path)).text());

      expect(profile.label).toBe("Claude Opus 5.5");
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

    const bot = decode(
      ModelProfile,
      await (await h.call("GET", "/api/models/bot:heuristic")).text(),
    );

    expect(bot.behavior.offersReceived).toBe(4);
    expect(bot.behavior.offersAcceptedFromOthers).toBe(4);
    expect((await h.call("GET", "/api/models/nobody%2Fnothing")).status).toBe(404);

    const games = decode(
      GamesResponse,
      await (
        await h.call("GET", "/api/games?status=finished&players=2&model=anthropic/claude-opus-5.5")
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
  });

  it("cancels a run with the API key", async () => {
    const h = setup();

    const created = await h.call("POST", "/api/runs", {
      body: JSON.stringify(runConfig),
      key: API_KEY,
    });

    const { run } = decode(CreateRunResponse, await created.text());

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
