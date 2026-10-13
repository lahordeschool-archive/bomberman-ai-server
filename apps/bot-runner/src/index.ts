import { availableParallelism } from 'node:os';
import { DEFAULT_EGRESS } from './egress.ts';
import { SandboxPool } from './pool.ts';
import { DEFAULT_LIMITS } from './sandbox.ts';
import { createRunnerServer } from './server.ts';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
const logLevel = (process.env.LOG_LEVEL ?? 'info') as keyof typeof LEVELS;

function log(entry: Record<string, unknown>): void {
  const level = (entry.level as keyof typeof LEVELS) ?? 'info';
  if (LEVELS[level] < (LEVELS[logLevel] ?? LEVELS.info)) return;
  process.stdout.write(
    `${JSON.stringify({ time: new Date().toISOString(), service: 'bot-runner', ...entry })}\n`,
  );
}

function intFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

const token =
  process.env.RUNNER_TOKEN ??
  (process.env.NODE_ENV === 'production' ? undefined : 'dev-only-runner-token');
if (!token || token.length < 16) {
  log({ level: 'error', msg: 'RUNNER_TOKEN must be set to at least 16 characters' });
  process.exit(1);
}

const port = intFromEnv('PORT', 8090);
const host = process.env.HOST ?? '0.0.0.0';
const pool = new SandboxPool(
  intFromEnv('RUNNER_WORKERS', Math.max(1, Math.min(4, availableParallelism() - 1))),
  {
    ...DEFAULT_LIMITS,
    memoryBytes: intFromEnv('BOT_MEMORY_MB', 32) * 1024 * 1024,
    callTimeoutMs: intFromEnv('BOT_CALL_TIMEOUT_MS', DEFAULT_LIMITS.callTimeoutMs),
  },
  intFromEnv('RUNNER_MAX_SESSIONS', 64),
  {
    ...DEFAULT_EGRESS,
    enabled: process.env.BOT_FETCH !== 'off',
    allowPrivateNetworks:
      process.env.BOT_FETCH_ALLOW_PRIVATE === 'true' && process.env.NODE_ENV !== 'production',
    timeoutMs: intFromEnv('BOT_FETCH_TIMEOUT_MS', DEFAULT_EGRESS.timeoutMs),
  },
);
log({ level: 'info', msg: `bot network access ${process.env.BOT_FETCH === 'off' ? 'off' : 'on'}` });

const server = createRunnerServer({ pool, token, log });
server.requestTimeout = 10_000;
server.listen(port, host, () => log({ level: 'info', msg: `listening on ${host}:${port}` }));

const sweeper = setInterval(() => {
  void pool.disposeIdle(10 * 60_000).then((count) => {
    if (count > 0) log({ level: 'info', msg: 'disposed idle sessions', count });
  });
}, 60_000);

function shutdown(signal: string): void {
  log({ level: 'info', msg: `received ${signal}, shutting down` });
  clearInterval(sweeper);
  server.close();
  void pool.close().then(() => process.exit(0));
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
