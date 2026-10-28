/**
 * PlayerDO: one per LLM seat per game, SQLite-backed. A thin adapter from the Cloudflare
 * runtime to `PlayerHost`, which runs the Pi agent from the alarm handler.
 */
import { DurableObject } from "cloudflare:workers";
import { openRouterModels, resolveOpenRouterModel } from "@mb/agent";

import type { WorkerEnv } from "../../alchemy.run.ts";
import type { WakeRequest } from "../contracts.ts";
import { PlayerHost } from "../player/player-host.ts";
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
      models: (request) => ({
        model: resolveOpenRouterModel(models, request.spec.model, request.listing ?? undefined),
        streamFn: models.streamSimple.bind(models),
        apiKey: env.OPENROUTER_API_KEY.length === 0 ? undefined : env.OPENROUTER_API_KEY,
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

  override alarm(): Promise<void> {
    return this.host.alarm();
  }
}
