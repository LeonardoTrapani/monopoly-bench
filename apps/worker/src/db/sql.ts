/** Helpers for D1 through `@effect/sql-d1`. */
import { D1Client } from "@effect/sql-d1";
import { Effect, Schema } from "effect";
import type { SqlError } from "effect/sql/SqlError";
import type { Statement } from "effect/sql/Statement";

/** D1 accepts at most 100 bound parameters per statement. */
export const D1_MAX_PARAMS = 100;

export const chunk = <A>(
  items: ReadonlyArray<A>,
  size: number,
): ReadonlyArray<ReadonlyArray<A>> => {
  const chunks: Array<ReadonlyArray<A>> = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
};

/** Run a statement and decode every row with `row`. */
export const decodeRows =
  <S extends Schema.ConstraintDecoder<unknown>>(row: S) =>
  <A extends object>(
    statement: Statement<A>,
  ): Effect.Effect<ReadonlyArray<S["Type"]>, SqlError | Schema.SchemaError> =>
    statement.pipe(Effect.flatMap((rows) => Schema.decodeUnknownEffect(Schema.Array(row))(rows)));

/** Run statements as one D1 batch (a single transaction), in chunks of `size`. */
export const batchAll = <A extends object>(
  statements: ReadonlyArray<Statement<A>>,
  size = 50,
): Effect.Effect<void, SqlError, D1Client.D1Client> =>
  Effect.gen(function* () {
    const client = yield* D1Client.D1Client;

    for (const group of chunk(statements, size)) {
      yield* client.batch(group);
    }
  });

export const nowIso = (date: Date): string => date.toISOString();
