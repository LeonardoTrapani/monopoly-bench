/** RunDO: one per run, SQLite-backed. A thin adapter to `RunCoordinator`. */
import * as Cloudflare from "@alchemy.run/cloudflare";
import { Effect } from "effect";

import { applyGameRatings } from "../db/ratings-store.ts";
import { abortQueuedGames, insertRun, updateRun } from "../db/writes.ts";
import { upstream } from "../errors.ts";
import { RunCoordinator } from "../runs/run-coordinator.ts";
import { Database } from "../resources.ts";
import { type RunObject, objects } from "./objects.ts";
import { durableAlarm, durableSql, runD1 } from "./runtime.ts";

export class RunDO extends Cloudflare.DurableObject<RunDO>()(
  "RunDO",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    const { game, player } = yield* objects;
    const database = yield* Cloudflare.D1.QueryDatabase(Database);

    return Effect.gen(function* () {
      const d1 = runD1(yield* database.raw);
      const { storage } = state.raw;

      const coordinator = new RunCoordinator({
        sql: durableSql(storage),
        db: {
          insertRun: (run) => d1(insertRun(run)).pipe(upstream("D1 insertRun")),
          updateRun: (runId, status, spentUsd, finishedAt) =>
            d1(updateRun(runId, status, spentUsd, finishedAt)).pipe(upstream("D1 updateRun")),
          abortQueued: (gameIds, at) =>
            d1(abortQueuedGames(gameIds, at)).pipe(upstream("D1 abortQueued")),
          applyRatings: (input) =>
            d1(applyGameRatings(input)).pipe(Effect.asVoid, upstream("D1 applyRatings")),
        },
        games: {
          start: (start) => game(start.gameId).start(start).pipe(upstream("GameDO start")),
          abort: (gameId, reason) => game(gameId).abort(reason).pipe(upstream("GameDO abort")),
          purge: (gameId, llmSeats) =>
            game(gameId)
              .purge()
              .pipe(
                Effect.andThen(
                  Effect.forEach(llmSeats, (seat) => player(gameId, seat).purge(), {
                    discard: true,
                  }),
                ),
                upstream("purge game"),
              ),
        },
        setAlarm: durableAlarm(storage),
        now: Date.now,
      });

      const surface: RunObject = {
        create: (runId, config, listings, ownKey) =>
          coordinator.create(runId, config, listings, ownKey),
        gameFinished: (outcome) => coordinator.gameFinished(outcome),
        charge: (gameId, key, costUsd) => coordinator.charge(gameId, key, costUsd),
        credentials: () => Effect.sync(() => coordinator.credentials()),
        cancelTokenMatches: (tokenSha256) =>
          Effect.sync(() => coordinator.cancelTokenMatches(tokenSha256)),
        cancel: () => coordinator.cancel(),
        purge: () => coordinator.purge(),
        summary: () => Effect.sync(() => coordinator.summary()),
      };

      return { ...surface, alarm: () => coordinator.alarm() };
    });
  }).pipe(Effect.provide(Cloudflare.D1.QueryDatabaseBinding)),
) {}
