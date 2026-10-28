/** Glue between the Cloudflare runtime and the runtime-independent hosts. */
import type { D1Database, DurableObjectStorage } from "@cloudflare/workers-types";
import { D1Client } from "@effect/sql-d1";
import { Config, Effect, Layer, Redacted } from "effect";
import type { SqlClient } from "effect/sql/SqlClient";

import type { SqlPort, SqlRow } from "../sql.ts";

export const durableSql = (storage: DurableObjectStorage): SqlPort => ({
  exec: (query, ...bindings) =>
    // SAFETY: our Durable Objects never store blobs, so every column is a string, a number or
    // NULL; that is exactly SqlRow (SqlStorageValue minus ArrayBuffer).
    storage.sql.exec(query, ...bindings).toArray() as ReadonlyArray<SqlRow>,
  transaction: (body) => storage.transactionSync(body),
});

/** Replace the object's single alarm; `null` clears it. */
export const durableAlarm =
  (storage: DurableObjectStorage) =>
  (at: number | null): Effect.Effect<void> =>
    Effect.promise(() => (at === null ? storage.deleteAlarm() : storage.setAlarm(at)));

/** Run a D1 effect with a per-call `@effect/sql-d1` client. */
export const runD1 =
  (db: D1Database) =>
  <A, E>(effect: Effect.Effect<A, E, D1Client.D1Client | SqlClient>): Effect.Effect<A, E> =>
    effect.pipe(Effect.provide(Layer.orDie(D1Client.layer({ db }))));

const isDev = process.env.ALCHEMY_DEV === "true" || process.env.ALCHEMY_DEV === "1";

/**
 * A secret read from the deploy environment and bound to the Worker (its `env` prop). In local
 * dev it falls back to a fixed value; deploys must provide it.
 */
export const deploySecret = (name: string, devDefault: string) =>
  isDev
    ? Config.Redacted(name).pipe(Config.withDefault(Redacted.make(devDefault)))
    : Config.Redacted(name);

/** A secret bound with `deploySecret`, read while the Worker or a Durable Object runs. */
export const boundSecret = (name: string): Effect.Effect<string> =>
  Effect.gen(function* () {
    return Redacted.value(yield* Config.Redacted(name));
  }).pipe(Effect.orDie);
