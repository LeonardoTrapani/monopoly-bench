/**
 * PlayerDO: one per LLM seat per game, SQLite-backed. A thin adapter from the Durable Object
 * runtime to `PlayerHost`, which runs the Pi agent from the alarm handler.
 */
import * as Cloudflare from "@alchemy.run/cloudflare";
import { openRouterModels, resolveOpenRouterModel } from "@mb/agent";
import { Effect } from "effect";

import { upstream } from "../errors.ts";
import { openRouterKeyFor, PlayerHost } from "../player/player-host.ts";
import { type PlayerObject, objects } from "./objects.ts";
import { boundSecret, durableAlarm, durableSql } from "./runtime.ts";

export class PlayerDO extends Cloudflare.DurableObject<PlayerDO>()(
  "PlayerDO",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    const { game, run } = yield* objects;

    return Effect.gen(function* () {
      const serverKey = yield* boundSecret("OPENROUTER_API_KEY");
      const { storage } = state.raw;
      const models = openRouterModels();

      const host = new PlayerHost({
        sql: durableSql(storage),
        game: {
          submit: (call) => game(call.gameId).submit(call).pipe(upstream("GameDO submit")),
          done: (call) => game(call.gameId).done(call).pipe(upstream("GameDO done")),
          inspect: (call) => game(call.gameId).inspect(call).pipe(upstream("GameDO inspect")),
          activity: (gameId, activity) =>
            game(gameId).activity(activity).pipe(upstream("GameDO activity")),
          wakeFinished: (report) =>
            game(report.gameId).wakeFinished(report).pipe(upstream("GameDO wakeFinished")),
        },
        // Who pays is asked of the run before every wake: an own-key run's key is never stored here.
        models: (request) =>
          run(request.runId)
            .credentials()
            .pipe(
              upstream("RunDO credentials"),
              Effect.map((credentials) => ({
                model: resolveOpenRouterModel(
                  models,
                  request.spec.model,
                  request.listing ?? undefined,
                ),
                streamFn: models.streamSimple.bind(models),
                apiKey: openRouterKeyFor(credentials, serverKey),
              })),
            ),
        setAlarm: durableAlarm(storage),
        now: Date.now,
      });

      const surface: PlayerObject = {
        /** GameDO → PlayerDO: acknowledged at once; the alarm runs the model. */
        wake: (request) => host.wake(request),
        /** RunDO → PlayerDO when the run is deleted. */
        purge: () => host.purge(),
      };

      return { ...surface, alarm: () => host.alarm() };
    });
  }),
) {}
