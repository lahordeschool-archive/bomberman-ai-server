import {
  changePasswordBody,
  loginBody,
  registerBody,
  type SessionResponse,
} from '@bomberman/protocol';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { hashPassword, verifyPassword } from '../../auth/password.ts';
import { createSession, deleteSession, deleteUserSessions } from '../../auth/sessions.ts';
import type { AppContext } from '../../context.ts';
import { isUniqueViolation } from '../../db/rows.ts';
import {
  createUser,
  DEPLOY_CHECK_USERNAME,
  findUserByUsername,
  recordAudit,
  toPublicUser,
  updatePasswordHash,
  type UserRow,
} from '../../store/users.ts';
import { HttpError } from '../errors.ts';
import { clearSessionCookie, requireUser, setSessionCookie } from '../session-plugin.ts';

const RESERVED_USERNAMES = new Set([
  'house',
  'admin',
  'root',
  'system',
  'moderator',
  'support',
  'api',
  'sharkey',
]);
const INVALID_LOGIN = 'Incorrect username or password.';

export function registerAuthRoutes(app: FastifyInstance, context: AppContext): void {
  const { db, config } = context;

  async function startSession(
    request: FastifyRequest,
    reply: FastifyReply,
    user: UserRow,
  ): Promise<SessionResponse> {
    const session = await createSession(db, user.id, config.sessionTtlMs, {
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    });
    setSessionCookie(reply, context, session.token, session.expiresAt);
    return { user: toPublicUser(user, { includeEmail: true }), csrfToken: session.csrfToken };
  }

  app.get('/api/auth/session', async (request): Promise<SessionResponse> => {
    if (!request.session) return { user: null, csrfToken: null };
    return {
      user: toPublicUser(request.session.user, { includeEmail: true }),
      csrfToken: request.session.csrfToken,
    };
  });

  app.post(
    '/api/auth/register',
    { config: { rateLimit: { max: config.registrationsPerHour, timeWindow: '1 hour' } } },
    async (request, reply) => {
      const body = registerBody.parse(request.body);
      if (RESERVED_USERNAMES.has(body.username)) {
        throw new HttpError(409, 'username_taken', 'That username is not available.');
      }
      let user: UserRow;
      try {
        user = await createUser(db, {
          username: body.username,
          displayName: body.displayName ?? body.username,
          email: body.email,
          passwordHash: await hashPassword(body.password),
          rankedEligible: body.username !== DEPLOY_CHECK_USERNAME,
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          const hint = `${(error as { constraint?: string }).constraint ?? ''} ${(error as { detail?: string }).detail ?? ''}`;
          if (hint.includes('email')) {
            throw new HttpError(409, 'email_taken', 'That email is already registered.');
          }
          throw new HttpError(409, 'username_taken', 'That username is not available.');
        }
        throw error;
      }
      if (request.session) await deleteSession(db, request.session.tokenHash);
      await recordAudit(db, { userId: user.id, action: 'register', ip: request.ip });
      reply.status(201);
      return startSession(request, reply, user);
    },
  );

  app.post(
    '/api/auth/login',
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: '5 minutes',
          hook: 'preHandler',
          keyGenerator: (request: FastifyRequest) => {
            const username = (request.body as { username?: unknown } | undefined)?.username;
            return `${request.ip}:${typeof username === 'string' ? username.toLowerCase().slice(0, 64) : ''}`;
          },
        },
      },
    },
    async (request, reply) => {
      const body = loginBody.parse(request.body);
      const user = await findUserByUsername(db, body.username);
      const valid = await verifyPassword(
        user && !user.is_house ? user.password_hash : null,
        body.password,
      );
      if (!user || !valid) {
        await recordAudit(db, {
          userId: user?.id ?? null,
          action: 'login_failed',
          ip: request.ip,
          detail: user ? undefined : { username: body.username.slice(0, 64) },
        });
        throw new HttpError(401, 'invalid_credentials', INVALID_LOGIN);
      }
      if (request.session) await deleteSession(db, request.session.tokenHash);
      await recordAudit(db, { userId: user.id, action: 'login', ip: request.ip });
      return startSession(request, reply, user);
    },
  );

  app.post('/api/auth/logout', async (request, reply) => {
    if (request.session) {
      await deleteSession(db, request.session.tokenHash);
      await recordAudit(db, { userId: request.session.user.id, action: 'logout', ip: request.ip });
    }
    clearSessionCookie(reply, context);
    return reply.status(204).send();
  });

  app.post(
    '/api/auth/password',
    { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const session = requireUser(request);
      const body = changePasswordBody.parse(request.body);
      if (!(await verifyPassword(session.user.password_hash, body.currentPassword))) {
        await recordAudit(db, {
          userId: session.user.id,
          action: 'password_change_failed',
          ip: request.ip,
        });
        throw new HttpError(400, 'invalid_password', 'Your current password is incorrect.');
      }
      await updatePasswordHash(db, session.user.id, await hashPassword(body.newPassword));
      await deleteUserSessions(db, session.user.id);
      await recordAudit(db, {
        userId: session.user.id,
        action: 'password_changed',
        ip: request.ip,
      });
      return startSession(request, reply, session.user);
    },
  );
}
