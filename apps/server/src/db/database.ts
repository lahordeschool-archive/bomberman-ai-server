import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import pg from 'pg';

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export interface Queryable {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<T>>;
  /** Runs a script of several statements without parameters. */
  exec(sql: string): Promise<void>;
}

export interface Database extends Queryable {
  readonly kind: 'postgres' | 'pglite';
  transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Makes `bigint`/`numeric` columns JS numbers; every such column here stays far below 2^53. */
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number(value));
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (value) => Number(value));

class PostgresDatabase implements Database {
  readonly kind = 'postgres' as const;
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 10, idleTimeoutMillis: 30_000 });
  }

  async query<T>(sql: string, params: readonly unknown[] = []): Promise<QueryResult<T>> {
    const result = await this.pool.query(sql, params as unknown[]);
    return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const tx: Queryable = {
      async query<R>(sql: string, params: readonly unknown[] = []) {
        const result = await client.query(sql, params as unknown[]);
        return { rows: result.rows as R[], rowCount: result.rowCount ?? 0 };
      },
      async exec(sql: string) {
        await client.query(sql);
      },
    };
    try {
      await client.query('begin');
      const value = await work(tx);
      await client.query('commit');
      return value;
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  close(): Promise<void> {
    return this.pool.end();
  }
}

type PGliteInstance = PGlite;

/** Embedded PostgreSQL (WASM) used for local development and tests. */
class PgliteDatabase implements Database {
  readonly kind = 'pglite' as const;
  private readonly db: PGliteInstance;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(db: PGliteInstance) {
    this.db = db;
  }

  async query<T>(sql: string, params: readonly unknown[] = []): Promise<QueryResult<T>> {
    await this.queue;
    return this.run<T>(sql, params);
  }

  private async run<T>(sql: string, params: readonly unknown[]): Promise<QueryResult<T>> {
    const result = await this.db.query<T>(sql, params as unknown[]);
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  }

  async exec(sql: string): Promise<void> {
    await this.queue;
    await this.db.exec(sql);
  }

  /** PGlite has a single connection, so transactions are serialized with other queries. */
  transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T> {
    const next = this.queue.then(() =>
      this.db.transaction(async (inner) => {
        const tx: Queryable = {
          async query<R>(sql: string, params: readonly unknown[] = []) {
            const result = await inner.query<R>(sql, params as unknown[]);
            return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
          },
          async exec(sql: string) {
            await inner.exec(sql);
          },
        };
        return work(tx);
      }),
    );
    this.queue = next.catch(() => undefined);
    return next;
  }

  async close(): Promise<void> {
    await this.queue;
    await this.db.close();
  }
}

/**
 * `postgres://…` uses a connection pool; `pglite:memory` or `pglite:<dir>` runs an
 * embedded PostgreSQL so development needs no database server.
 */
export async function connectDatabase(url: string): Promise<Database> {
  if (!url.startsWith('pglite:')) return new PostgresDatabase(url);
  const { PGlite } = await import('@electric-sql/pglite');
  const target = url.slice('pglite:'.length);
  if (target === 'memory' || target === '') return new PgliteDatabase(await PGlite.create());
  const dataDir = resolve(target);
  mkdirSync(dirname(dataDir), { recursive: true });
  return new PgliteDatabase(await PGlite.create({ dataDir }));
}
