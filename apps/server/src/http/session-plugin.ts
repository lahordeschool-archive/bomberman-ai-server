import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { findSession, type SessionRecord, safeEqual } from '../auth/sessions.ts';
import type { AppContext } from '../context.ts';
import { forbidden, unauthorized } from './errors.ts';

declare module 'fastify' {
  interface FastifyRequest {
    session: SessionRecord | null;
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function sessionCookieName(secure: boolean): string {
  return secure ? '__Host-bomber_session' : 'bomber_session';
}

export function setSessionCookie(
  reply: FastifyReply,
  context: AppContext,
  token: string,
  expiresAt: Date,
): void {
  void reply.setCookie(sessionCookieName(context.config.cookieSecure), token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: context.config.cookieSecure,
    expires: expiresAt,
  });
}

export function clearSessionCookie(reply: FastifyReply, context: AppContext): void {
  void reply.clearCookie(sessionCookieName(context.config.cookieSecure), {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: context.config.cookieSecure,
  });
}

export function requireUser(request: FastifyRequest): SessionRecord {
  if (!request.session) throw unauthorized();
  return request.session;
}

/**
 * Resolves the session cookie on every API request and enforces CSRF protection on
 * state changes: the Origin must be ours, and signed in requests must echo the
 * per session CSRF token in `x-csrf-token`.
 */
export function registerSessions(app: FastifyInstance, context: AppContext): void {
  const cookieName = sessionCookieName(context.config.cookieSecure);
  const allowedOrigins = new Set(context.config.allowedOrigins);
  app.decorateRequest('session', null);

  app.addHook('onRequest', async (request) => {
    if (!request.url.startsWith('/api/')) return;
    const token = request.cookies[cookieName];
    request.session = token
      ? await findSession(context.db, token, context.config.sessionTtlMs)
      : null;

    if (SAFE_METHODS.has(request.method)) return;
    const origin = request.headers.origin;
    if (origin && !allowedOrigins.has(origin))
      throw forbidden('Cross site requests are not allowed.');
    if (request.session) {
      const header = request.headers['x-csrf-token'];
      if (typeof header !== 'string' || !safeEqual(header, request.session.csrfToken)) {
        throw forbidden('Your session token is missing or stale. Reload the page and try again.');
      }
    }
  });
}
