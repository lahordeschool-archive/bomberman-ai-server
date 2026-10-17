import type { Server as HttpServer } from 'node:http';
import { chatSendPayload, watchMatchPayload, type Ack } from '@bomberman/protocol';
import type { FastifyBaseLogger } from 'fastify';
import { ZodError } from 'zod';
import { type Arena, matchRoom } from '../arena/arena.ts';
import { findSession } from '../auth/sessions.ts';
import type { AppContext } from '../context.ts';
import { sessionCookieName } from '../http/session-plugin.ts';
import { CasualRooms, type GameServer, type GameSocket, UserError } from './casual.ts';

const EVENTS_PER_SECOND = 20;
const VIEWERS_DEBOUNCE_MS = 250;
const MATCH_ROOM_PREFIX = matchRoom('');

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

  /** Viewer counts go out once per burst of joins and leaves, not once per socket. */
  const pendingViewers = new Map<string, ReturnType<typeof setTimeout>>();
  const countViewers = (room: string) => {
    if (!room.startsWith(MATCH_ROOM_PREFIX) || pendingViewers.has(room)) return;
    const timer = setTimeout(() => {
      pendingViewers.delete(room);
      const viewers = io.of('/').adapter.rooms.get(room)?.size ?? 0;
      if (viewers === 0) return;
      io.to(room).emit('match:viewers', {
        matchId: room.slice(MATCH_ROOM_PREFIX.length),
        viewers,
      });
    }, VIEWERS_DEBOUNCE_MS);
    timer.unref();
    pendingViewers.set(room, timer);
  };
  io.of('/').adapter.on('join-room', countViewers);
  io.of('/').adapter.on('leave-room', countViewers);

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
    socket.on('match:chat', (payload, ack) =>
      handle(ack, () => {
        const user = socket.data.user;
        if (!user) throw new UserError('Sign in to chat.');
        const { matchId, text } = chatSendPayload.parse(payload);
        if (!socket.rooms.has(matchRoom(matchId))) {
          throw new UserError('Watch the match to chat.');
        }
        const outcome = arena.chat(
          matchId,
          `user:${user.id}`,
          { kind: 'user', name: user.displayName, username: user.username },
          text,
        );
        if (outcome.ok) return outcome.message;
        throw new UserError(
          outcome.reason === 'too-fast'
            ? 'One message per second, please.'
            : outcome.reason === 'empty'
              ? 'Type a message first.'
              : 'The chat of that match is closed.',
        );
      }),
    );
    socket.on('casual:create', (payload, ack) => handle(ack, () => rooms.create(socket, payload)));
    socket.on('casual:join', (payload, ack) => handle(ack, () => rooms.join(socket, payload)));
    socket.on('casual:start', (payload, ack) => handle(ack, () => rooms.start(socket, payload)));
    socket.on('casual:leave', () => rooms.leave(socket));
    socket.on('disconnect', () => rooms.leave(socket));
  });

  return rooms;
}
