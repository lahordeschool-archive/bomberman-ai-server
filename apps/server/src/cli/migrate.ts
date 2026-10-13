import { loadConfig } from '../config.ts';
import { connectDatabase } from '../db/database.ts';
import { migrate } from '../db/migrate.ts';

const config = loadConfig();
const db = await connectDatabase(config.databaseUrl);
try {
  const applied = await migrate(db, (message) => console.log(message));
  console.log(applied.length ? `applied ${applied.length} migration(s)` : 'database is up to date');
} finally {
  await db.close();
}
