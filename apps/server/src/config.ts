import { fileURLToPath } from 'node:url';
import { TICK_MS } from '@bomberman/game-engine';
import { z } from 'zod';

const DEV_RUNNER_TOKEN = 'dev-only-runner-token';

/**
 * Normalizes origins the way hosting panels fill them: surrounding quotes, a list of
 * domains (the first one wins), or a bare `bomber-arena.com` for `https://…`.
 */
const withScheme = (value: unknown) => {
  if (typeof value !== 'string') return value;
  const first = value
    .split(',')[0]!
    .trim()
    .replace(/^["']|["']$/g, '')
    .trim();
  if (!first) return undefined;
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(first) ? first : `https://${first}`;
};

/** Hostnames from a comma/space separated list (bare host or full URL). */
const hostnames = (value: string): string[] =>
  value
    .split(/[,\s]+/)
    .map((part) => part.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean)
    .map((part) => {
      try {
        const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(part) ? part : `https://${part}`);
        return url.hostname.toLowerCase();
      } catch {
        return '';
      }
    })
    .filter(Boolean);

const isLoopbackOrIp = (hostname: string) =>
  hostname === 'localhost' ||
  hostname === '127.0.0.1' ||
  hostname === '[::1]' ||
  hostname === '::1' ||
  /^(?:\d{1,3}\.){3}\d{1,3}$/.test(hostname);

const boolean = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');
const optionalSecret = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().min(12).max(200).optional(),
);

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    HOST: z.string().default('0.0.0.0'),
    PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    DATABASE_URL: z.string().min(1).default('pglite:./data/pglite'),
    PUBLIC_ORIGIN: z.preprocess(withScheme, z.url().default('http://localhost:8080')),
    EXTRA_ORIGINS: z.string().default(''),
    /**
     * Hostnames that permanently redirect to PUBLIC_ORIGIN (path preserved).
     * `www.` of the public host is always included when that host is a real domain.
     * Add your previous Coolify / sslip.io hostname so old bookmarks keep working.
     */
    REDIRECT_HOSTS: z.string().default(''),
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
    SHARKEY_ADMIN_PASSWORD: optionalSecret,
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
  /** Hostnames that 301 to `publicOrigin` (includes `www.` of a real domain). */
  redirectHosts: string[];
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
  sharkeyAdminPassword: string | undefined;
}

/** Settings that hold no secret, echoed back in configuration errors. */
const PUBLIC_VARIABLES = new Set([
  'PUBLIC_ORIGIN',
  'EXTRA_ORIGINS',
  'REDIRECT_HOSTS',
  'RUNNER_URL',
  'TRUST_PROXY',
]);

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(source);
  const details = parsed.success
    ? []
    : parsed.error.issues.map((issue) => {
        const name = issue.path.join('.');
        const shown = PUBLIC_VARIABLES.has(name) ? ` (got ${JSON.stringify(source[name])})` : '';
        return `${name}: ${issue.message}${shown}`;
      });
  if (source.NODE_ENV === 'production' && !withScheme(source.PUBLIC_ORIGIN ?? '')) {
    details.push('PUBLIC_ORIGIN: Required in production, e.g. https://bomber-arena.com');
  }
  if (!parsed.success || details.length > 0) {
    throw new Error(`Invalid configuration\n  ${details.join('\n  ')}`);
  }
  const env = parsed.data;
  const publicOrigin = new URL(env.PUBLIC_ORIGIN).origin;
  const publicHost = new URL(env.PUBLIC_ORIGIN).hostname.toLowerCase();
  const allowedOrigins = new Set([publicOrigin]);
  for (const origin of env.EXTRA_ORIGINS.split(',').map((value) => value.trim())) {
    if (origin) allowedOrigins.add(new URL(String(withScheme(origin))).origin);
  }
  const redirectHosts = new Set(hostnames(env.REDIRECT_HOSTS));
  if (!isLoopbackOrIp(publicHost)) redirectHosts.add(`www.${publicHost}`);
  redirectHosts.delete(publicHost);
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
    redirectHosts: [...redirectHosts],
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
    sharkeyAdminPassword: env.SHARKEY_ADMIN_PASSWORD,
  };
}
