import { purgeExpiredSessions } from './auth/sessions.ts';
import { loadConfig } from './config.ts';
import type { AppContext } from './context.ts';
import { connectDatabase } from './db/database.ts';
import { migrate } from './db/migrate.ts';
import { RunnerClient } from './runner/executor.ts';
import { createServer } from './server.ts';
import { ensureHouseBots } from './store/house.ts';
import { abortStaleMatches } from './store/matches.ts';

let config;
try {
  config = loadConfig();
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

const db = await connectDatabase(config.databaseUrl);
const context: AppContext = {
  config,
  db,
  executor: new RunnerClient(config.runnerUrl, config.runnerToken),
  house: [],
};
const { app, matchmaker, close } = await createServer(context);

await migrate(db, (message) => app.log.info(message));
context.house = await ensureHouseBots(db);
const aborted = await abortStaleMatches(db);
if (aborted > 0) app.log.warn({ count: aborted }, 'marked interrupted matches as aborted');

await app.listen({ host: config.host, port: config.port });
matchmaker.start();

const purge = setInterval(
  () => {
    purgeExpiredSessions(db).catch((error: unknown) =>
      app.log.error({ err: error }, 'session purge failed'),
    );
  },
  60 * 60 * 1000,
);
purge.unref();

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  app.log.info({ signal }, 'shutting down');
  clearInterval(purge);
  const force = setTimeout(() => process.exit(1), 15_000);
  force.unref();
  await close();
  await db.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
