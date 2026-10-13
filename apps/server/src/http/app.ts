import { existsSync } from 'node:fs';
import { join } from 'node:path';
import fastifyCookie from '@fastify/cookie';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { AppContext } from '../context.ts';
import { errorHandler, notFound } from './errors.ts';
import { registerAuthRoutes } from './routes/auth.ts';
import { registerBotRoutes } from './routes/bots.ts';
import { registerPublicRoutes } from './routes/public.ts';
import { registerSessions } from './session-plugin.ts';

/**
 * Bot workers evaluate player code, which needs `unsafe-eval`. Only the worker script
 * gets it. Bots may call external HTTP APIs; the worker sends those requests without
 * cookies, so a bot cannot act on the player's account.
 */
const WORKER_CSP = "default-src 'none'; script-src 'self' 'unsafe-eval'; connect-src https: http:";

export interface BuildAppOptions {
  logger?: FastifyServerOptions['logger'];
}

export async function buildApp(
  context: AppContext,
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const { config } = context;
  const app = Fastify({
    logger: options.logger ?? { level: config.logLevel },
    trustProxy: config.trustProxy,
    bodyLimit: 16 * 1024,
    genReqId: () => crypto.randomUUID(),
  });

  app.setErrorHandler(errorHandler);
  await app.register(fastifyCookie);
  await app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        workerSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        mediaSrc: ["'self'", 'blob:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
      },
    },
    strictTransportSecurity: config.cookieSecure,
  });
  await app.register(fastifyRateLimit, {
    max: 300,
    timeWindow: '1 minute',
    allowList: (request) => !request.url.startsWith('/api/'),
    errorResponseBuilder: (_request, limit) => ({
      statusCode: 429,
      error: 'rate_limited',
      message: `Too many requests. Try again in ${Math.ceil(limit.ttl / 1000)} seconds.`,
    }),
  });

  registerSessions(app, context);

  app.addHook('onSend', async (request, reply, payload) => {
    if (request.url.startsWith('/api/') && !reply.hasHeader('cache-control')) {
      void reply.header('cache-control', 'no-store');
    }
    return payload;
  });

  app.get('/healthz', { logLevel: 'warn' }, async () => ({ ok: true }));
  app.get('/readyz', { logLevel: 'warn' }, async (_request, reply) => {
    const [database, runner] = await Promise.all([
      context.db.query('select 1').then(
        () => true,
        () => false,
      ),
      context.executor.healthy(),
    ]);
    if (!database || !runner) reply.status(503);
    return { ok: database && runner, database, runner };
  });

  registerAuthRoutes(app, context);
  registerBotRoutes(app, context);
  registerPublicRoutes(app, context);

  const indexFile = join(config.webDist, 'index.html');
  if (existsSync(indexFile)) {
    await app.register(fastifyStatic, {
      root: config.webDist,
      wildcard: false,
      index: false,
      cacheControl: false,
      setHeaders(reply, path) {
        if (/[\\/]assets[\\/]/.test(path)) {
          void reply.header('cache-control', 'public, max-age=31536000, immutable');
          if (/[\\/]bot-worker-[\w-]+\.js$/.test(path))
            void reply.header('content-security-policy', WORKER_CSP);
        } else if (/[\\/]game[\\/]/.test(path)) {
          void reply.header('cache-control', 'public, max-age=86400');
        } else {
          void reply.header('cache-control', 'no-cache');
        }
      },
    });
  }

  app.setNotFoundHandler((request, reply) => {
    const wantsPage =
      request.method === 'GET' &&
      !request.url.startsWith('/api/') &&
      !/\.[a-z0-9]+(\?|$)/i.test(request.url) &&
      existsSync(indexFile);
    if (!wantsPage) throw notFound();
    void reply.header('cache-control', 'no-cache');
    return reply.sendFile('index.html');
  });

  return app;
}
