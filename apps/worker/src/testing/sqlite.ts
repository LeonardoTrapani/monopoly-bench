/**
 * Test doubles backed by `node:sqlite`: a D1 database (the `D1Database` surface that
 * `@effect/sql-d1` and this Worker use) and the Durable Object `SqlPort`. Tests run real SQL
 * against the real migrations.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import type {
  D1Database,
  D1DatabaseSession,
  D1ExecResult,
  D1PreparedStatement,
  D1Result,
} from "@cloudflare/workers-types";
import { D1Client } from "@effect/sql-d1";

import type { SqlPort, SqlRow, SqlValue } from "../sql.ts";

const isMultiStatement = (query: string): boolean =>
  query
    .split(";")
    .slice(1)
    .some((rest) => rest.trim().length > 0);

const withTransaction = <A>(db: DatabaseSync, body: () => A): A => {
  db.exec("BEGIN");

  try {
    const result = body();
    db.exec("COMMIT");

    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
};

export interface MemorySqlPort extends SqlPort {
  readonly db: DatabaseSync;
}

export const memorySqlPort = (): MemorySqlPort => {
  const db = new DatabaseSync(":memory:");

  return {
    db,
    exec: (query, ...bindings) => {
      if (bindings.length === 0 && isMultiStatement(query)) {
        db.exec(query);

        return [];
      }

      // SAFETY: the Durable Objects never bind or store blobs or bigints, so every column is a
      // string, a number or NULL, which is exactly SqlRow.
      return db.prepare(query).all(...bindings) as ReadonlyArray<SqlRow>;
    },
    transaction: (body) => withTransaction(db, body),
  };
};

const meta = (changes: number) => ({
  duration: 0,
  size_after: 0,
  rows_read: 0,
  rows_written: changes,
  last_row_id: 0,
  changed_db: changes > 0,
  changes,
});

const toInput = (value: SqlValue | boolean): SQLInputValue => {
  if (value === true) return 1;

  if (value === false) return 0;

  return value;
};

class NodeD1Statement implements D1PreparedStatement {
  constructor(
    readonly db: DatabaseSync,
    readonly query: string,
    readonly params: ReadonlyArray<SQLInputValue>,
  ) {}

  bind(...values: Array<SqlValue | boolean>): NodeD1Statement {
    return new NodeD1Statement(this.db, this.query, values.map(toInput));
  }

  rows<T>(): Array<T> {
    // SAFETY: test-only; callers decode rows with Effect schemas right after.
    return this.db.prepare(this.query).all(...this.params) as Array<T>;
  }

  async all<T>(): Promise<D1Result<T>> {
    return { results: this.rows<T>(), success: true, meta: meta(0) };
  }

  async run<T>(): Promise<D1Result<T>> {
    const info = this.db.prepare(this.query).run(...this.params);

    return { results: [], success: true, meta: meta(Number(info.changes)) };
  }

  async first<T>(): Promise<T | null> {
    return this.rows<T>()[0] ?? null;
  }

  raw<T = Array<SqlValue>>(options: { columnNames: true }): Promise<[Array<string>, ...Array<T>]>;
  raw<T = Array<SqlValue>>(options?: { columnNames?: false }): Promise<Array<T>>;
  async raw<T>(): Promise<Array<T>> {
    const statement = this.db.prepare(this.query);
    statement.setReturnArrays(true);

    // SAFETY: test-only; rows come back as arrays because of setReturnArrays(true).
    return statement.all(...this.params) as Array<T>;
  }
}

class NodeD1 implements D1Database {
  constructor(readonly db: DatabaseSync) {}

  prepare(query: string): NodeD1Statement {
    return new NodeD1Statement(this.db, query, []);
  }

  async batch<T>(statements: Array<NodeD1Statement>): Promise<Array<D1Result<T>>> {
    // D1 runs a batch as one transaction: any failing statement rolls back the whole batch.
    return withTransaction(this.db, () =>
      statements.map((statement) => ({
        results: statement.rows<T>(),
        success: true,
        meta: meta(0),
      })),
    );
  }

  async exec(query: string): Promise<D1ExecResult> {
    this.db.exec(query);

    return { count: 0, duration: 0 };
  }

  withSession(): D1DatabaseSession {
    throw new Error("D1 sessions are not emulated in tests");
  }

  async dump(): Promise<ArrayBuffer> {
    throw new Error("dump() is not emulated in tests");
  }
}

const migrationsSql = (): string =>
  readFileSync(join(import.meta.dirname, "../../migrations/0001_init.sql"), "utf8");

export const memoryD1 = () => {
  const db = new DatabaseSync(":memory:");
  db.exec(migrationsSql());
  const binding = new NodeD1(db);

  return { db, binding, layer: D1Client.layer({ db: binding }) };
};
