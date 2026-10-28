/**
 * Narrow synchronous SQL port over Durable Object SQLite storage (`ctx.storage.sql`), so the
 * Durable Object logic runs unchanged against `node:sqlite` in unit tests. Rows are decoded
 * with Effect schemas at this boundary.
 */
import { Schema } from "effect";

/** We never store blobs, so a column is a string, a number or NULL. */
export type SqlValue = string | number | null;

export interface SqlRow {
  readonly [column: string]: SqlValue;
}

export interface SqlPort {
  readonly exec: (query: string, ...bindings: ReadonlyArray<SqlValue>) => ReadonlyArray<SqlRow>;
  /** Runs `body` in one transaction: every write commits or none does. */
  readonly transaction: <A>(body: () => A) => A;
}

export const queryRows = <S extends Schema.ConstraintDecoder<unknown>>(
  sql: SqlPort,
  row: S,
  query: string,
  ...bindings: ReadonlyArray<SqlValue>
): ReadonlyArray<S["Type"]> => {
  const decode = Schema.decodeUnknownSync(row);

  return sql.exec(query, ...bindings).map((value) => decode(value));
};

export const queryFirst = <S extends Schema.ConstraintDecoder<unknown>>(
  sql: SqlPort,
  row: S,
  query: string,
  ...bindings: ReadonlyArray<SqlValue>
): S["Type"] | undefined => queryRows(sql, row, query, ...bindings)[0];

/** A JSON column holding a value of `schema`. */
export const jsonColumn = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) =>
  Schema.decodeUnknownSync(Schema.fromJsonString(schema));

export const toJson = (value: Schema.Json): string => JSON.stringify(value);
