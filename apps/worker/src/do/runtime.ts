/** Glue between the Cloudflare runtime and the runtime-independent hosts. */
import type { D1Database, DurableObjectStorage } from "@cloudflare/workers-types";
import { D1Client } from "@effect/sql-d1";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql/SqlClient";

import type { SqlPort, SqlRow } from "../sql.ts";

export const durableSql = (storage: DurableObjectStorage): SqlPort => ({
  exec: (query, ...bindings) =>
    // SAFETY: our Durable Objects never store blobs, so every column is a string, a number or
    // NULL; that is exactly SqlRow (SqlStorageValue minus ArrayBuffer).
    storage.sql.exec(query, ...bindings).toArray() as ReadonlyArray<SqlRow>,
  transaction: (body) => storage.transactionSync(body),
});

export const durableAlarm =
  (storage: DurableObjectStorage) =>
  async (at: number | null): Promise<void> => {
    if (at === null) {
      await storage.deleteAlarm();

      return;
    }

    await storage.setAlarm(at);
  };

/** Run a D1 effect with a per-call `@effect/sql-d1` client. */
export const runD1 = <A, E>(
  db: D1Database,
  effect: Effect.Effect<A, E, D1Client.D1Client | SqlClient>,
): Promise<A> => Effect.runPromise(effect.pipe(Effect.provide(D1Client.layer({ db }))));

export const logError = (message: string, cause?: unknown): void => {
  console.error(message, cause);
};
