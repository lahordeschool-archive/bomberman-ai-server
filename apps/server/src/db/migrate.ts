import { readdir, readFile } from 'node:fs/promises';
import type { Database } from './database.ts';

const MIGRATIONS_DIR = new URL('./migrations/', import.meta.url);
/** Arbitrary constant shared by every server instance so only one migrates at a time. */
const LOCK_ID = 727_301;

export async function migrate(
  db: Database,
  log: (message: string) => void = () => {},
): Promise<string[]> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((file) => file.endsWith('.sql')).sort();
  return db.transaction(async (tx) => {
    if (db.kind === 'postgres') await tx.query('select pg_advisory_xact_lock($1)', [LOCK_ID]);
    await tx.query(
      `create table if not exists schema_migrations (
         name text primary key,
         applied_at timestamptz not null default now()
       )`,
    );
    const applied = new Set(
      (await tx.query<{ name: string }>('select name from schema_migrations')).rows.map(
        (row) => row.name,
      ),
    );
    const ran: string[] = [];
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(new URL(file, MIGRATIONS_DIR), 'utf8');
      log(`applying migration ${file}`);
      await tx.exec(sql);
      await tx.query('insert into schema_migrations (name) values ($1)', [file]);
      ran.push(file);
    }
    return ran;
  });
}
