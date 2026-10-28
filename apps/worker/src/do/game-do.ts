/**
 * GameDO: one per game, SQLite-backed. A thin adapter from the Durable Object runtime to
 * `GameHost`; spectators connect with hibernatable WebSockets (server → client only).
 */
import * as Cloudflare from "@alchemy.run/cloudflare";
import { RuntimeContext } from "alchemy/RuntimeContext";
import { Effect, Layer } from "effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import { finishGame, gameProgress, markGameRunning, recordWake } from "../db/writes.ts";
import { upstream } from "../errors.ts";
import { engineBinding } from "../game/engine-binding.ts";
import { GameHost } from "../game/game-host.ts";
import { Archive, Database } from "../resources.ts";
import { type GameObject, objects } from "./objects.ts";
import { durableAlarm, durableSql, runD1 } from "./runtime.ts";

export class GameDO extends Cloudflare.DurableObject<GameDO>()(
  "GameDO",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    const { player, run } = yield* objects;
    const database = yield* Cloudflare.D1.QueryDatabase(Database);
    const archive = yield* Cloudflare.R2.ReadWriteBucket(Archive);

    return Effect.gen(function* () {
      const d1 = runD1(yield* database.raw);
      const runtime = yield* RuntimeContext;
      const { storage } = state.raw;

      const host = new GameHost(
        {
          sql: durableSql(storage),
          db: {
            markRunning: (gameId, at) =>
              d1(markGameRunning(gameId, at)).pipe(upstream("D1 markRunning")),
            progress: (gameId, turn, round, at) =>
              d1(gameProgress(gameId, turn, round, at)).pipe(upstream("D1 progress")),
            recordWake: (row) => d1(recordWake(row)).pipe(upstream("D1 recordWake")),
            finish: (game) => d1(finishGame(game)).pipe(upstream("D1 finish")),
          },
          archive: {
            put: (key, body, contentType) =>
              archive
                .put(key, body, { httpMetadata: { contentType } })
                .pipe(
                  Effect.asVoid,
                  Effect.provideService(RuntimeContext, runtime),
                  upstream(`R2 put ${key}`),
                ),
          },
          players: {
            wake: (request) =>
              player(request.gameId, request.seat).wake(request).pipe(upstream("PlayerDO wake")),
          },
          run: {
            charge: (runId, gameId, key, costUsd) =>
              run(runId).charge(gameId, key, costUsd).pipe(upstream("RunDO charge")),
            gameFinished: (runId, outcome) =>
              run(runId).gameFinished(outcome).pipe(upstream("RunDO gameFinished")),
          },
          broadcast: (message) => {
            for (const socket of state.raw.getWebSockets()) {
              try {
                socket.send(message);
              } catch {
                // A socket closing under us: its close handler cleans it up.
              }
            }
          },
          setAlarm: durableAlarm(storage),
          now: Date.now,
        },
        engineBinding,
      );

      const surface: GameObject = {
        start: (input) => host.start(input),
        submit: (call) => host.submit(call),
        done: (call) => host.done(call),
        inspect: (call) => host.inspect(call),
        wakeFinished: (report) => host.wakeFinished(report),
        activity: (activity) => Effect.sync(() => host.activity(activity)),
        abort: (reason) => host.abort(reason),
        budgetExhausted: () => host.budgetExhausted(),
        /** RunDO → GameDO when the run is deleted: forget the game and close spectator sockets. */
        purge: () =>
          host.purge().pipe(
            Effect.andThen(
              Effect.sync(() => {
                for (const socket of state.raw.getWebSockets()) socket.close(1000, "game deleted");
              }),
            ),
          ),
        events: (since) => Effect.sync(() => host.eventsSince(since)),
        transcripts: (seat) => Effect.sync(() => host.transcripts(seat)),
        config: () => Effect.sync(() => host.config()),
      };

      return {
        ...surface,
        alarm: () => host.alarm(),
        /** Spectator WebSocket upgrade, forwarded by the Worker from `GET /api/games/:id/ws`. */
        fetch: Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;

          if (request.headers.upgrade?.toLowerCase() !== "websocket") {
            return HttpServerResponse.text("Expected a WebSocket upgrade", { status: 426 });
          }

          // The Worker forwards `/api/games/<id>/ws`; the id names a game that has not started yet.
          const gameId = decodeURIComponent(request.url.split("?")[0]?.split("/")[3] ?? "");
          const [response, socket] = yield* Cloudflare.upgrade();

          yield* socket.send(host.helloMessage(gameId));

          return response;
        }),
        /** Spectators only listen; anything they send is ignored. */
        webSocketMessage: () => Effect.void,
        webSocketClose: (socket: Cloudflare.WebSocket, code: number) =>
          socket.close(code === 1005 ? 1000 : code, "closing"),
      };
    });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(Cloudflare.D1.QueryDatabaseBinding, Cloudflare.R2.ReadWriteBucketBinding),
    ),
  ),
) {}
