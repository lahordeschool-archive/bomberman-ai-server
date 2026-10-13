import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import { BOT_HARNESS, BOT_TRAILER, buildObservation, parseHarnessOutput } from '@bomberman/bot-sdk';
import { createGame, TICK_MS } from '@bomberman/game-engine';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { loadConfig } from '../src/config.ts';
import type { AppContext } from '../src/context.ts';
import { connectDatabase } from '../src/db/database.ts';
import { migrate } from '../src/db/migrate.ts';
import { buildApp } from '../src/http/app.ts';
import type { BotExecutor, SandboxSession } from '../src/runner/executor.ts';
import { ensureHouseBots } from '../src/store/house.ts';

interface HarnessApi {
  seed(seed: number): void;
  call(json: string, now: number): void;
  read(): string;
}

function load(source: string, seed: number): HarnessApi {
  const context = vm.createContext({});
  vm.runInContext(BOT_HARNESS, context);
  vm.runInContext(source + BOT_TRAILER, context, { timeout: 500 });
  const api = (context as { __bomber: HarnessApi; __bomberResolve: () => unknown }).__bomber;
  if (typeof (context as { __bomberResolve: () => unknown }).__bomberResolve() !== 'function') {
    throw new Error('Your bot must define a gameLoop function');
  }
  api.seed(seed);
  return api;
}

/** Runs bots in-process with `node:vm`. Test only: production always uses the isolated runner. */
export class VmExecutor implements BotExecutor {
  sessions = 0;

  async validate(source: string) {
    try {
      const api = load(source, 1);
      api.call(JSON.stringify(buildObservation(createGame({ seed: 1, playerCount: 2 }), 0)), 0);
      const output = parseHarnessOutput(api.read());
      return output.error ? { ok: false as const, error: output.error } : { ok: true as const };
    } catch (error) {
      return { ok: false as const, error: (error as Error).message };
    }
  }

  async createSession(source: string, seed: number): Promise<SandboxSession> {
    const api = load(source, seed);
    this.sessions++;
    return {
      decide: async (observation) => {
        api.call(JSON.stringify(observation), observation.tick * TICK_MS);
        await new Promise((resolve) => setImmediate(resolve));
        const output = parseHarnessOutput(api.read());
        if (output.error) throw new Error(output.error);
        return output.result;
      },
      dispose: async () => {
        this.sessions--;
      },
    };
  }

  async healthy() {
    return true;
  }
}

/**
 * In memory PGlite by default. With TEST_DATABASE_URL (CI), each test file gets a
 * fresh schema on a real PostgreSQL server so files can run in parallel.
 */
async function testDatabaseUrl(): Promise<string> {
  const base = process.env.TEST_DATABASE_URL;
  if (!base) return 'pglite:memory';
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  const admin = await connectDatabase(base);
  await admin.exec(`create schema ${schema}`);
  await admin.close();
  const url = new URL(base);
  url.searchParams.set('options', `-c search_path=${schema}`);
  return url.toString();
}

export async function createTestContext(
  overrides: Record<string, string> = {},
): Promise<AppContext> {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: await testDatabaseUrl(),
    LOG_LEVEL: 'silent',
    WEB_DIST: '/nonexistent',
    RANKED_CONCURRENCY: '0',
    ...overrides,
  });
  const db = await connectDatabase(config.databaseUrl);
  await migrate(db);
  const house = await ensureHouseBots(db);
  return { config, db, executor: new VmExecutor(), house };
}

export async function createTestApp(overrides: Record<string, string> = {}) {
  const context = await createTestContext(overrides);
  const app = await buildApp(context, { logger: false });
  await app.ready();
  return { app, context };
}

/** A cookie jar plus CSRF token, acting like one browser tab. */
export class TestClient {
  private readonly app: FastifyInstance;
  private static nextIp = 1;
  readonly ip = `10.0.${Math.floor(TestClient.nextIp / 250)}.${(TestClient.nextIp++ % 250) + 1}`;
  cookie = '';
  csrf: string | null = null;

  constructor(app: FastifyInstance) {
    this.app = app;
  }

  async request(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
    const response: LightMyRequestResponse = await this.app.inject({
      method: method as 'GET',
      url,
      remoteAddress: this.ip,
      headers: {
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(this.csrf && method !== 'GET' ? { 'x-csrf-token': this.csrf } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      payload: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = response.headers['set-cookie'];
    for (const line of Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : []) {
      const [pair] = line.split(';');
      this.cookie = pair!.endsWith('=') ? '' : pair!;
    }
    const json = response.body ? (JSON.parse(response.body) as Record<string, unknown>) : null;
    if (json && 'csrfToken' in json) this.csrf = json.csrfToken as string | null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests assert on loosely typed JSON
    return { status: response.statusCode, body: json as any, headers: response.headers };
  }

  async register(username: string, password = 'correct horse battery') {
    const response = await this.request('POST', '/api/auth/register', { username, password });
    if (response.status !== 201)
      throw new Error(`register failed: ${JSON.stringify(response.body)}`);
    return response.body.user as { id: string; username: string };
  }
}
