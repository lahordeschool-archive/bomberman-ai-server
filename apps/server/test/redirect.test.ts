import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/context.ts';
import { createTestApp } from './helpers.ts';

let app: FastifyInstance;
let context: AppContext;

beforeAll(async () => {
  ({ app, context } = await createTestApp({
    PUBLIC_ORIGIN: 'https://bomber-arena.com',
    REDIRECT_HOSTS: 'bomber.old.sslip.io',
  }));
});

afterAll(async () => {
  await app.close();
  await context.db.close();
});

describe('host redirects', () => {
  it('includes www of the public domain and configured legacy hosts', () => {
    expect(context.config.redirectHosts).toEqual(['bomber.old.sslip.io', 'www.bomber-arena.com']);
  });

  it('permanently redirects www and legacy hosts to PUBLIC_ORIGIN', async () => {
    const www = await app.inject({
      method: 'GET',
      url: '/matches?tab=live',
      headers: { host: 'www.bomber-arena.com' },
    });
    expect(www.statusCode).toBe(301);
    expect(www.headers.location).toBe('https://bomber-arena.com/matches?tab=live');

    const legacy = await app.inject({
      method: 'GET',
      url: '/bots/1',
      headers: { host: 'bomber.old.sslip.io' },
    });
    expect(legacy.statusCode).toBe(301);
    expect(legacy.headers.location).toBe('https://bomber-arena.com/bots/1');
  });

  it('does not redirect health checks or the canonical host', async () => {
    const health = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { host: 'www.bomber-arena.com' },
    });
    expect(health.statusCode).toBe(200);

    const canonical = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { host: 'bomber-arena.com' },
    });
    expect(canonical.statusCode).toBe(200);
  });
});
