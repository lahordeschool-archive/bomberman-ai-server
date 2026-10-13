import type { Server as HttpServer } from 'node:http';
import { watchMatchPayload, type Ack } from '@bomberman/protocol';
import type { FastifyBaseLogger } from 'fastify';
import { ZodError } from 'zod';
import { type Arena, matchRoom } from '../arena/arena.ts';
import { findSession } from '../auth/sessions.ts';
import type { AppContext } from '../context.ts';
import { sessionCookieName } from '../http/session-plugin.ts';
import { CasualRooms, type GameServer, type GameSocket, UserError } from './casual.ts';

const EVENTS_PER_SECOND = 20;

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) {
      try {
        return decodeURIComponent(part.slice(index + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

function failure(error: unknown, log: FastifyBaseLogger): { ok: false; error: string } {
  if (error instanceof UserError) return { ok: false, error: error.message };
  if (error instanceof ZodError) return { ok: false, error: 'Invalid request.' };
  log.error({ err: error }, 'socket handler failed');
  return { ok: false, error: 'Something went wrong on our side. Please try again.' };
}

/**
 * Socket.IO carries live snapshots to spectators and bot decisions for casual rooms.
 * The handshake must come from our origin; the session cookie identifies the user,
 * and anonymous sockets may only watch.
 */
export function createRealtime(
  httpServer: HttpServer,
  context: AppContext,
  arena: Arena,
  io: GameServer,
  log: FastifyBaseLogger,
): CasualRooms {
  const allowed = new Set(context.config.allowedOrigins);
  const cookieName = sessionCookieName(context.config.cookieSecure);
  const rooms = new CasualRooms(context, arena, io, log);

  io.attach(httpServer, {
    path: '/socket.io',
    serveClient: false,
    maxHttpBufferSize: 64 * 1024,
    allowRequest: (request, callback) => {
      const origin = request.headers.origin;
      callback(null, !origin || allowed.has(origin));
    },
  });

  io.use((socket, next) => {
    const token = readCookie(socket.request.headers.cookie, cookieName);
    socket.data.user = null;
    if (!token) return next();
    findSession(context.db, token, context.config.sessionTtlMs).then(
      (session) => {
        socket.data.user = session
          ? {
              id: session.user.id,
              username: session.user.username,
              displayName: session.user.display_name,
            }
          : null;
        next();
      },
      (error: unknown) => next(error as Error),
    );
  });

  io.on('connection', (socket: GameSocket) => {
    let windowStart = Date.now();
    let count = 0;
    socket.use((_packet, next) => {
      const now = Date.now();
      if (now - windowStart > 1000) {
        windowStart = now;
        count = 0;
      }
      if (++count > EVENTS_PER_SECOND) return next(new Error('rate limited'));
      next();
    });
    socket.on('error', () => undefined);

    const handle = <T>(ack: unknown, work: () => T | Promise<T>) => {
      const reply = typeof ack === 'function' ? (ack as Ack<T>) : () => undefined;
      Promise.resolve()
        .then(work)
        .then(
          (data) => reply({ ok: true, data }),
          (error: unknown) => reply(failure(error, log)),
        );
    };

    socket.on('match:watch', (payload, ack) =>
      handle(ack, () => {
        const { matchId } = watchMatchPayload.parse(payload);
        const init = arena.watch(matchId);
        if (!init) throw new UserError('That match is not live.');
        void socket.join(matchRoom(matchId));
        return init;
      }),
    );
    socket.on('match:unwatch', (payload) => {
      const parsed = watchMatchPayload.safeParse(payload);
      if (parsed.success) void socket.leave(matchRoom(parsed.data.matchId));
    });
    socket.on('casual:create', (payload, ack) => handle(ack, () => rooms.create(socket, payload)));
    socket.on('casual:join', (payload, ack) => handle(ack, () => rooms.join(socket, payload)));
    socket.on('casual:start', (payload, ack) => handle(ack, () => rooms.start(socket, payload)));
    socket.on('casual:leave', () => rooms.leave(socket));
    socket.on('disconnect', () => rooms.leave(socket));
  });

  return rooms;
}
