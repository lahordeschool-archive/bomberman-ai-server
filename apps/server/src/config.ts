import { fileURLToPath } from 'node:url';
import { TICK_MS } from '@bomberman/game-engine';
import { z } from 'zod';

const DEV_RUNNER_TOKEN = 'dev-only-runner-token';

const boolean = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    HOST: z.string().default('0.0.0.0'),
    PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    DATABASE_URL: z.string().min(1).default('pglite:./data/pglite'),
    PUBLIC_ORIGIN: z.url().default('http://localhost:8080'),
    EXTRA_ORIGINS: z.string().default(''),
    COOKIE_SECURE: boolean.optional(),
    /** `true`, `false`, or a comma separated list of proxy addresses/CIDRs to trust. */
    TRUST_PROXY: z.string().default('false'),
    RUNNER_URL: z.url().default('http://localhost:8090'),
    RUNNER_TOKEN: z.string().min(16).optional(),
    WEB_DIST: z.string().default(fileURLToPath(new URL('../../web/dist', import.meta.url))),
    SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
    RANKED_CONCURRENCY: z.coerce.number().int().min(0).max(32).default(2),
    MATCHMAKER_INTERVAL_MS: z.coerce.number().int().min(250).default(5000),
    RANKED_MAX_TICKS: z.coerce.number().int().min(200).max(12000).optional(),
    /** Real time pacing of live matches. Lower only for tests; 0 runs as fast as possible. */
    MATCH_TICK_MS: z.coerce.number().int().min(0).max(1000).default(TICK_MS),
    MAX_BOTS_PER_USER: z.coerce.number().int().min(1).max(100).default(10),
    /** Per client IP. A classroom behind one NAT shares a single address. */
    REGISTRATIONS_PER_HOUR: z.coerce.number().int().min(1).max(10000).default(30),
  })
  .superRefine((env, context) => {
    if (env.NODE_ENV !== 'production') return;
    if (!env.RUNNER_TOKEN) {
      context.addIssue({
        code: 'custom',
        path: ['RUNNER_TOKEN'],
        message: 'Required in production',
      });
    }
    if (env.DATABASE_URL.startsWith('pglite:')) {
      context.addIssue({
        code: 'custom',
        path: ['DATABASE_URL'],
        message: 'Use a PostgreSQL connection string in production',
      });
    }
  });

export interface Config {
  env: 'development' | 'production' | 'test';
  host: string;
  port: number;
  logLevel: string;
  databaseUrl: string;
  publicOrigin: string;
  allowedOrigins: string[];
  cookieSecure: boolean;
  trustProxy: boolean | string;
  runnerUrl: string;
  runnerToken: string;
  webDist: string;
  sessionTtlMs: number;
  rankedConcurrency: number;
  matchmakerIntervalMs: number;
  rankedMaxTicks: number | undefined;
  matchTickMs: number;
  maxBotsPerUser: number;
  registrationsPerHour: number;
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`Invalid configuration\n  ${details.join('\n  ')}`);
  }
  const env = parsed.data;
  const publicOrigin = new URL(env.PUBLIC_ORIGIN).origin;
  const allowedOrigins = new Set([publicOrigin]);
  for (const origin of env.EXTRA_ORIGINS.split(',').map((value) => value.trim())) {
    if (origin) allowedOrigins.add(new URL(origin).origin);
  }
  if (env.NODE_ENV !== 'production') {
    // Browsers treat localhost, 127.0.0.1 and [::1] as different origins.
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
      allowedOrigins.add(`http://${host}:${env.PORT}`);
      allowedOrigins.add(`http://${host}:5173`);
    }
  }
  return {
    env: env.NODE_ENV,
    host: env.HOST,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    databaseUrl: env.DATABASE_URL,
    publicOrigin,
    allowedOrigins: [...allowedOrigins],
    cookieSecure: env.COOKIE_SECURE ?? publicOrigin.startsWith('https:'),
    trustProxy:
      env.TRUST_PROXY === 'true' ? true : env.TRUST_PROXY === 'false' ? false : env.TRUST_PROXY,
    runnerUrl: env.RUNNER_URL,
    runnerToken: env.RUNNER_TOKEN ?? DEV_RUNNER_TOKEN,
    webDist: env.WEB_DIST,
    sessionTtlMs: env.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
    rankedConcurrency: env.RANKED_CONCURRENCY,
    matchmakerIntervalMs: env.MATCHMAKER_INTERVAL_MS,
    rankedMaxTicks: env.RANKED_MAX_TICKS,
    matchTickMs: env.MATCH_TICK_MS,
    maxBotsPerUser: env.MAX_BOTS_PER_USER,
    registrationsPerHour: env.REGISTRATIONS_PER_HOUR,
  };
}
