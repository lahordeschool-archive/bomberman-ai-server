import { loadConfig } from '../config.ts';
import { connectDatabase } from '../db/database.ts';
import { migrate } from '../db/migrate.ts';
import { rebuildRatings } from '../store/matches.ts';

const config = loadConfig();
const db = await connectDatabase(config.databaseUrl);
try {
  await migrate(db);
  const count = await db.transaction((tx) => rebuildRatings(tx));
  console.log(`recomputed ratings from ${count} ranked match(es)`);
} finally {
  await db.close();
}
