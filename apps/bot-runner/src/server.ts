import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { MAX_BOT_SOURCE_BYTES, type Observation } from '@bomberman/bot-sdk';
import type { SandboxPool } from './pool.ts';

const MAX_BODY_BYTES = MAX_BOT_SOURCE_BYTES + 64 * 1024;
const MAX_BUDGET_MS = 2000;

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!request.headers['content-type']?.startsWith('application/json')) {
    throw new HttpError(415, 'Expected application/json');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Body too large');
    chunks.push(chunk as Buffer);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    if (!value || typeof value !== 'object') throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(json),
    'cache-control': 'no-store',
  });
  response.end(json);
}

function requireString(body: Record<string, unknown>, key: string, max: number): string {
  const value = body[key];
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new HttpError(400, `Invalid ${key}`);
  }
  return value;
}

export interface RunnerServerOptions {
  pool: SandboxPool;
  token: string;
  log?: (entry: Record<string, unknown>) => void;
}

/**
 * Internal API used only by the game server. It is never exposed publicly: the
 * compose network is internal and every request must carry the shared token.
 */
export function createRunnerServer({ pool, token, log }: RunnerServerOptions): Server {
  const expected = digest(`Bearer ${token}`);

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://runner');
    if (request.method === 'GET' && url.pathname === '/healthz') {
      return send(response, 200, { ok: true, sessions: pool.sessionCount });
    }
    const authorization = request.headers.authorization ?? '';
    if (!timingSafeEqual(digest(authorization), expected)) throw new HttpError(401, 'Unauthorized');

    if (request.method === 'POST' && url.pathname === '/v1/validate') {
      const body = await readJson(request);
      try {
        const result = await pool.validate(requireString(body, 'source', MAX_BOT_SOURCE_BYTES));
        return send(response, 200, { ok: true, ...result });
      } catch (error) {
        return send(response, 200, { ok: false, error: (error as Error).message });
      }
    }
    if (request.method === 'POST' && url.pathname === '/v1/sessions') {
      const body = await readJson(request);
      const source = requireString(body, 'source', MAX_BOT_SOURCE_BYTES);
      const seed = Number(body.seed);
      if (!Number.isInteger(seed)) throw new HttpError(400, 'Invalid seed');
      try {
        return send(response, 201, { sessionId: await pool.create(source, seed) });
      } catch (error) {
        const message = (error as Error).message;
        return send(response, /capacity/.test(message) ? 503 : 422, { error: message });
      }
    }
    const actMatch = /^\/v1\/sessions\/([0-9a-f-]{36})(\/act)?$/.exec(url.pathname);
    if (actMatch && request.method === 'POST' && actMatch[2]) {
      const body = await readJson(request);
      if (!body.observation || typeof body.observation !== 'object') {
        throw new HttpError(400, 'Invalid observation');
      }
      const budget = Number(body.budgetMs);
      const budgetMs = Number.isFinite(budget)
        ? Math.min(MAX_BUDGET_MS, Math.max(1, budget))
        : undefined;
      try {
        return send(
          response,
          200,
          await pool.act(actMatch[1]!, body.observation as Observation, budgetMs),
        );
      } catch (error) {
        throw new HttpError(404, (error as Error).message);
      }
    }
    if (actMatch && request.method === 'DELETE' && !actMatch[2]) {
      await pool.dispose(actMatch[1]!);
      response.writeHead(204).end();
      return;
    }
    throw new HttpError(404, 'Not found');
  }

  return createServer((request, response) => {
    const started = performance.now();
    route(request, response)
      .catch((error: unknown) => {
        const status = error instanceof HttpError ? error.status : 500;
        if (status === 500)
          log?.({ level: 'error', msg: 'runner request failed', error: String(error) });
        if (!response.headersSent) send(response, status, { error: (error as Error).message });
      })
      .finally(() => {
        if (request.url !== '/healthz') {
          log?.({
            level: 'debug',
            msg: 'request',
            method: request.method,
            path: request.url?.replace(/[0-9a-f-]{36}/, ':id'),
            status: response.statusCode,
            ms: Math.round(performance.now() - started),
          });
        }
      });
  });
}
