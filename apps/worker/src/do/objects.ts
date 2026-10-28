/**
 * The RPC surface of each Durable Object, and stubs to reach them from inside another one. The
 * three classes call each other, so they address one another by class name in the Worker's
 * environment instead of through each other's Alchemy tags (which would form a cycle).
 */
import * as Cloudflare from "@alchemy.run/cloudflare";
import { WorkerEnvironment } from "@alchemy.run/cloudflare/Workers/WorkerRuntime";
import type { RunConfig, RunSummary, Seat, SeatActivity } from "@mb/api";
import { Effect } from "effect";

import type {
  ChargeResult,
  GameOutcome,
  GameStart,
  ModelCredentials,
  ModelListing,
  OwnKeyFunding,
  SeatCall,
  SeatCallResult,
  WakeReport,
  WakeRequest,
} from "../contracts.ts";
import type { UpstreamError } from "../errors.ts";
import type { RunNotStored } from "../runs/run-coordinator.ts";

export interface GameObject {
  readonly start: (input: GameStart) => Effect.Effect<void>;
  readonly submit: (call: SeatCall) => Effect.Effect<SeatCallResult>;
  readonly done: (call: SeatCall) => Effect.Effect<SeatCallResult>;
  readonly inspect: (call: SeatCall) => Effect.Effect<SeatCallResult>;
  readonly wakeFinished: (report: WakeReport) => Effect.Effect<void, UpstreamError>;
  readonly activity: (activity: SeatActivity) => Effect.Effect<void>;
  readonly abort: (reason: string) => Effect.Effect<void>;
  readonly budgetExhausted: () => Effect.Effect<void>;
  readonly purge: () => Effect.Effect<void>;
  readonly events: (since: number) => Effect.Effect<string>;
  readonly transcripts: (seat: Seat | null) => Effect.Effect<string>;
  readonly config: () => Effect.Effect<string | null>;
}

export interface PlayerObject {
  readonly wake: (request: WakeRequest) => Effect.Effect<void>;
  readonly purge: () => Effect.Effect<void>;
}

export interface RunObject {
  readonly create: (
    runId: string,
    config: RunConfig,
    listings: ReadonlyArray<ModelListing>,
    ownKey: OwnKeyFunding | null,
  ) => Effect.Effect<RunSummary, UpstreamError | RunNotStored>;
  readonly gameFinished: (outcome: GameOutcome) => Effect.Effect<void, UpstreamError>;
  readonly charge: (
    gameId: string,
    key: string,
    costUsd: number,
  ) => Effect.Effect<ChargeResult, UpstreamError>;
  readonly credentials: () => Effect.Effect<ModelCredentials | null>;
  readonly cancelTokenMatches: (tokenSha256: string) => Effect.Effect<boolean>;
  readonly cancel: () => Effect.Effect<RunSummary | null, UpstreamError>;
  readonly purge: () => Effect.Effect<void, UpstreamError>;
  readonly summary: () => Effect.Effect<RunSummary | null>;
}

export interface Objects {
  readonly game: (gameId: string) => Cloudflare.DurableObjectStub<GameObject>;
  readonly player: (gameId: string, seat: Seat) => Cloudflare.DurableObjectStub<PlayerObject>;
  readonly run: (runId: string) => Cloudflare.DurableObjectStub<RunObject>;
}

/**
 * Stubs of the Worker's Durable Objects. Yield it at init; the stubs are only built when called,
 * at run time (the environment is empty while Alchemy plans a deploy).
 */
export const objects: Effect.Effect<Objects, never, WorkerEnvironment> = Effect.gen(function* () {
  const env = yield* WorkerEnvironment;

  const stub =
    <Surface>(className: string) =>
    (name: string): Cloudflare.DurableObjectStub<Surface> =>
      Cloudflare.makeRpcStub<Cloudflare.DurableObjectStub<Surface>>(env[className].getByName(name));

  return {
    game: stub<GameObject>("GameDO"),
    player: (gameId, seat) => stub<PlayerObject>("PlayerDO")(`${gameId}:${seat}`),
    run: stub<RunObject>("RunDO"),
  };
});
