/**
 * PlayerDO: one per LLM seat per game, SQLite-backed. A thin adapter from the Cloudflare
 * runtime to `PlayerHost`, which runs the Pi agent from the alarm handler.
 */
import { DurableObject } from "cloudflare:workers";
import { openRouterModels, resolveOpenRouterModel } from "@mb/agent";

import type { WorkerEnv } from "../../alchemy.run.ts";
import type { WakeRequest } from "../contracts.ts";
import { openRouterKeyFor, PlayerHost } from "../player/player-host.ts";
import { durableAlarm, durableSql, logError } from "./runtime.ts";

export class PlayerDO extends DurableObject<WorkerEnv> {
  private readonly host: PlayerHost;

  constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, env);
    const models = openRouterModels();
    const game = (gameId: string) => env.GAMES.getByName(gameId);

    this.host = new PlayerHost({
      sql: durableSql(ctx.storage),
      game: {
        submit: (call) => game(call.gameId).submit(call),
        done: (call) => game(call.gameId).done(call),
        inspect: (call) => game(call.gameId).inspect(call),
        activity: (gameId, activity) => game(gameId).activity(activity),
        wakeFinished: (report) => game(report.gameId).wakeFinished(report),
      },
      // Who pays is asked of the run before every wake: an own-key run's key is never stored here.
      models: async (request) => ({
        model: resolveOpenRouterModel(models, request.spec.model, request.listing ?? undefined),
        streamFn: models.streamSimple.bind(models),
        apiKey: openRouterKeyFor(
          await env.RUNS.getByName(request.runId).credentials(),
          env.OPENROUTER_API_KEY,
        ),
      }),
      setAlarm: durableAlarm(ctx.storage),
      now: Date.now,
      log: logError,
    });
  }

  /** GameDO → PlayerDO: acknowledged at once; the alarm runs the model. */
  wake(request: WakeRequest): Promise<void> {
    return this.host.wake(request);
  }

  /** RunDO → PlayerDO when the run is deleted. */
  purge(): Promise<void> {
    return this.host.purge();
  }

  override alarm(): Promise<void> {
    return this.host.alarm();
  }
}
