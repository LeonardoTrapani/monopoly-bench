/** RunDO: one per run, SQLite-backed. A thin adapter to `RunCoordinator`. */
import { DurableObject } from "cloudflare:workers";
import type { RunConfig, RunSummary } from "@mb/api";

import type { WorkerEnv } from "../../alchemy.run.ts";
import type { ChargeResult, GameOutcome, ModelListing } from "../contracts.ts";
import { applyGameRatings } from "../db/ratings-store.ts";
import { abortQueuedGames, insertRun, updateRun } from "../db/writes.ts";
import { RunCoordinator } from "../runs/run-coordinator.ts";
import { durableAlarm, durableSql, logError, runD1 } from "./runtime.ts";

export class RunDO extends DurableObject<WorkerEnv> {
  private readonly coordinator: RunCoordinator;

  constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, env);
    this.coordinator = new RunCoordinator({
      sql: durableSql(ctx.storage),
      db: {
        insertRun: (run) => runD1(env.DB, insertRun(run)),
        updateRun: (runId, status, spentUsd, finishedAt) =>
          runD1(env.DB, updateRun(runId, status, spentUsd, finishedAt)),
        abortQueued: (gameIds, at) => runD1(env.DB, abortQueuedGames(gameIds, at)),
        applyRatings: async (input) => {
          await runD1(env.DB, applyGameRatings(input));
        },
      },
      games: {
        start: (start) => env.GAMES.getByName(start.gameId).start(start),
        abort: (gameId, reason) => env.GAMES.getByName(gameId).abort(reason),
      },
      setAlarm: durableAlarm(ctx.storage),
      now: Date.now,
      log: logError,
    });
  }

  create(
    runId: string,
    config: RunConfig,
    listings: ReadonlyArray<ModelListing>,
  ): Promise<RunSummary> {
    return this.coordinator.create(runId, config, listings);
  }

  gameFinished(outcome: GameOutcome): Promise<void> {
    return this.coordinator.gameFinished(outcome);
  }

  charge(gameId: string, key: string, costUsd: number): Promise<ChargeResult> {
    return this.coordinator.charge(gameId, key, costUsd);
  }

  cancel(): Promise<RunSummary | null> {
    return this.coordinator.cancel();
  }

  summary(): RunSummary | null {
    return this.coordinator.summary();
  }

  override alarm(): Promise<void> {
    return this.coordinator.alarm();
  }
}
