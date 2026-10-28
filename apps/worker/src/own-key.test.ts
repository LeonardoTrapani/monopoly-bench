/**
 * An own-key run end to end (SPEC.md §7.2): the API, RunCoordinator, GameHosts and PlayerHosts
 * wired together over `node:sqlite` (D1 and Durable Object storage), an in-memory R2 and a
 * scripted model. The creator's key must reach the model and nothing else.
 */
import { listingsOfModelList } from "@mb/agent";
import {
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseStep,
  openRouterModelListSample,
  scriptedModel,
} from "@mb/agent/testing";
import { CreateRunResponse, LlmSeat, type RunConfig } from "@mb/api";
import type { Command, GameEvent, GameState } from "@mb/engine";
import type { D1Client } from "@effect/sql-d1";
import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/sql/SqlClient";
import { describe, expect, it } from "vite-plus/test";

import { type ApiDeps, handleApi } from "./api/router.ts";
import { liveSnapshot } from "./catalog.ts";
import { applyGameRatings } from "./db/ratings-store.ts";
import {
  abortQueuedGames,
  finishGame,
  gameProgress,
  insertRun,
  markGameRunning,
  recordWake,
  updateRun,
} from "./db/writes.ts";
import { engineBinding } from "./game/engine-binding.ts";
import { archiveKeys, GameHost } from "./game/game-host.ts";
import { openRouterKeyFor, PlayerHost } from "./player/player-host.ts";
import { RunCoordinator } from "./runs/run-coordinator.ts";
import { type MemorySqlPort, memoryD1, memorySqlPort } from "./testing/sqlite.ts";

const OWN_KEY = "sk-or-v1-own-key-canary-5f3a9c";

const SERVER_KEY = "sk-or-v1-server-key";

const PREFERRED = [
  "done",
  "decline",
  "pass_bid",
  "roll_for_doubles",
  "pay_jail_fine",
  "declare_bankruptcy",
];

/** Answers with the first cheap answering tool the latest wake message offers. */
const answerFromMessage: FauxResponseStep = (context) => {
  const prompts = context.messages.flatMap((message) => {
    if (message.role !== "user") return [];

    const content = message.content;

    return [
      Array.isArray(content)
        ? content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("")
        : content,
    ];
  });

  const wake =
    [...prompts].reverse().find((text) => text.includes("End this wake with one of:")) ?? "";

  const offered = /End this wake with one of: ([^.]*)\./.exec(wake)?.[1]?.split(", ") ?? [];
  const tool = PREFERRED.find((name) => offered.includes(name));

  return tool === undefined
    ? fauxAssistantMessage("I keep my mortgages.")
    : fauxAssistantMessage([fauxToolCall(tool, {})], { stopReason: "toolUse" });
};

const decodeCreated = Schema.decodeUnknownSync(Schema.fromJsonString(CreateRunResponse));

const TABLES = "SELECT name FROM sqlite_master WHERE type = 'table'";

/** Every row of every table of a Durable Object's storage, as text. */
const dumpStorage = (port: MemorySqlPort): string =>
  port
    .exec(TABLES)
    .map((table) => JSON.stringify(port.exec(`SELECT * FROM "${String(table["name"])}"`)))
    .join("\n");

describe("own-key runs end to end", () => {
  it("call the model with the creator's key and never store, archive, log or return it", async () => {
    const now = 1_800_000_000_000;
    const d1 = memoryD1();

    const runD1 = <A, E>(effect: Effect.Effect<A, E, D1Client.D1Client | SqlClient>) =>
      Effect.runPromise(effect.pipe(Effect.provide(d1.layer)));

    const archive = new Map<string, string>();
    const broadcasts: Array<string> = [];
    const logs: Array<string> = [];
    const keysSeen: Array<string | undefined> = [];
    const storages: Array<MemorySqlPort> = [];
    const alarms = new Map<string, number | null>();
    const runners = new Map<string, () => Promise<void>>();

    const log = (message: string, cause?: unknown) => {
      logs.push(`${message} ${cause instanceof Error ? (cause.stack ?? "") : String(cause)}`);
    };

    const storage = () => {
      const port = memorySqlPort();

      storages.push(port);

      return port;
    };

    const alarmOf = (name: string) => async (at: number | null) => {
      alarms.set(name, at);
    };

    let echoed = false;

    const scripted = scriptedModel(
      Array.from({ length: 3_000 }, (): FauxResponseStep => (context, options, state, model) => {
        keysSeen.push(options?.apiKey);

        // A provider error that echoes the key: it must be scrubbed wherever it ends up.
        if (!echoed) {
          echoed = true;

          return fauxAssistantMessage([], {
            stopReason: "error",
            errorMessage: `401 Unauthorized for ${OWN_KEY}`,
          });
        }

        return answerFromMessage(context, options, state, model);
      }),
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    );

    const coordinator: RunCoordinator = new RunCoordinator({
      sql: storage(),
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
        start: (start) => game(start.gameId).start(start),
        abort: (gameId, reason) => game(gameId).abort(reason),
        purge: async () => {},
      },
      setAlarm: alarmOf("run"),
      now: () => now,
      log,
    });

    const games = new Map<string, GameHost<GameState, GameEvent, Command>>();
    const players = new Map<string, PlayerHost>();

    const game = (gameId: string) => {
      const existing = games.get(gameId);

      if (existing !== undefined) return existing;

      const created = new GameHost(
        {
          sql: storage(),
          db: {
            markRunning: (id, at) => runD1(markGameRunning(id, at)),
            progress: (id, turn, round, at) => runD1(gameProgress(id, turn, round, at)),
            recordWake: (row) => runD1(recordWake(row)),
            finish: (finished) => runD1(finishGame(finished)),
          },
          archive: {
            put: async (key, body) => {
              archive.set(key, body);
            },
          },
          players: { wake: (request) => player(`${request.gameId}:${request.seat}`).wake(request) },
          run: {
            charge: async (_runId, id, key, costUsd) => coordinator.charge(id, key, costUsd),
            gameFinished: (_runId, outcome) => coordinator.gameFinished(outcome),
          },
          broadcast: (message) => {
            broadcasts.push(message);
          },
          setAlarm: alarmOf(`game:${gameId}`),
          now: () => now,
          log,
        },
        engineBinding,
      );

      games.set(gameId, created);
      runners.set(`game:${gameId}`, () => created.alarm());

      return created;
    };

    const player = (name: string) => {
      const existing = players.get(name);

      if (existing !== undefined) return existing;

      const created = new PlayerHost({
        sql: storage(),
        game: {
          submit: (call) => game(call.gameId).submit(call),
          done: (call) => game(call.gameId).done(call),
          inspect: (call) => game(call.gameId).inspect(call),
          activity: async (gameId, activity) => game(gameId).activity(activity),
          wakeFinished: (report) => game(report.gameId).wakeFinished(report),
        },
        // As PlayerDO: who pays is asked of the run before every wake.
        models: async () => ({
          model: scripted.model,
          streamFn: scripted.streamFn,
          apiKey: openRouterKeyFor(coordinator.credentials(), SERVER_KEY),
        }),
        setAlarm: alarmOf(`player:${name}`),
        now: () => now,
        log,
      });

      players.set(name, created);
      runners.set(`player:${name}`, () => created.alarm());

      return created;
    };

    const deps: ApiDeps = {
      benchApiKey: "bench-key",
      runs: {
        create: (runId, config, listings, ownKey) =>
          coordinator.create(runId, config, listings, ownKey),
        cancel: async () => coordinator.cancel(),
        cancelTokenMatches: async (_runId, tokenSha256) =>
          coordinator.cancelTokenMatches(tokenSha256),
        purge: () => coordinator.purge(),
      },
      games: {
        liveEvents: async (gameId, since) => game(gameId).eventsSince(since),
        archivedEvents: async (gameId) => archive.get(archiveKeys.events(gameId)) ?? null,
        liveTranscripts: async (gameId, seat) => game(gameId).transcripts(seat),
        archivedTranscripts: async (gameId, seat) =>
          archive.get(archiveKeys.seat(gameId, seat)) ?? null,
        liveConfig: async (gameId) => game(gameId).config(),
        archivedConfig: async (gameId) => archive.get(archiveKeys.config(gameId)) ?? null,
        spectate: async () => new Response(null, { status: 204 }),
        deleteArchives: async () => {},
      },
      catalog: async () =>
        liveSnapshot(listingsOfModelList(openRouterModelListSample()), "2026-10-28T09:00:00.000Z"),
      checkOpenRouterKey: async () => ({ status: "valid", limitRemainingUsd: null }),
      newRunId: () => "r-own",
      newCancelToken: () => "cancel-token-1",
    };

    const responses: Array<string> = [];

    const call = async (
      method: string,
      path: string,
      headers: Record<string, string> = {},
      body?: string,
    ) => {
      const response = await runD1(
        handleApi(
          new Request(`https://bench.test${path}`, { method, headers, body: body ?? null }),
          deps,
        ),
      );

      const text = await response.text();

      responses.push(text);

      return text;
    };

    const config: RunConfig = {
      players: [
        LlmSeat.make({ model: "anthropic/claude-haiku-5.5", label: "Claude Haiku 5.5" }),
        LlmSeat.make({ model: "openai/gpt-6.1-sol", label: "GPT-6.1 Sol" }),
      ],
      seeds: 1,
      maxRounds: 2,
      budgetUsd: 100,
    };

    const created = decodeCreated(
      await call("POST", "/api/runs", { "x-openrouter-key": OWN_KEY }, JSON.stringify(config)),
    );

    expect(created.run.funding).toBe("ownKey");
    expect(created.cancelToken).toBe("cancel-token-1");
    // While the run is active, its RunDO holds the key: the scan below is meaningful.
    expect(coordinator.credentials()?.openRouterKey).toBe(OWN_KEY);

    // Run every due alarm (the clock never moves, so deadlines never expire).
    for (let step = 0; step < 20_000; step += 1) {
      const due = [...alarms.entries()].find(([, at]) => at !== null && at <= now);

      if (due === undefined) break;

      alarms.set(due[0], null);
      await runners.get(due[0])?.();
    }

    expect(coordinator.summary()?.status).toBe("finished");
    expect(keysSeen.length).toBeGreaterThan(4);
    expect(new Set(keysSeen)).toEqual(new Set([OWN_KEY]));
    expect(coordinator.credentials()).toBeNull();

    await call("GET", "/api/runs");
    await call("GET", "/api/runs/r-own");
    await call("GET", "/api/games");
    await call("GET", "/api/games/r-own-0-0/transcripts");
    await call("GET", "/api/games/r-own-0-1/transcripts");
    await call("GET", "/api/leaderboard?players=2");

    const archived = [...archive.values()].join("\n");

    // The echoed key reached a transcript, scrubbed.
    expect(archived).toContain("[redacted key]");

    const d1Rows = d1.db
      .prepare(TABLES)
      .all()
      .map((table) =>
        JSON.stringify(d1.db.prepare(`SELECT * FROM "${String(table["name"])}"`).all()),
      )
      .join("\n");

    const places: ReadonlyArray<readonly [string, string]> = [
      ["D1", d1Rows],
      ["R2 archives", archived],
      ...storages.map(
        (port, index) => [`Durable Object storage ${index}`, dumpStorage(port)] as const,
      ),
      ["API responses", responses.join("\n")],
      ["spectator messages", broadcasts.join("\n")],
      ["logs", logs.join("\n")],
    ];

    expect(storages.length).toBeGreaterThan(4);
    expect(d1Rows).toContain('"funding":"ownKey"');

    for (const [place, text] of places) {
      expect({ place, leaked: text.includes(OWN_KEY) }).toEqual({ place, leaked: false });
    }
  });
});
