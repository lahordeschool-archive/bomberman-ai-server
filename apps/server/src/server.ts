import { Server } from 'socket.io';
import { Arena } from './arena/arena.ts';
import { Matchmaker } from './arena/matchmaker.ts';
import type { AppContext } from './context.ts';
import { buildApp, type BuildAppOptions } from './http/app.ts';
import type { GameServer } from './realtime/casual.ts';
import { createRealtime } from './realtime/socket.ts';

/** Wires HTTP, Socket.IO, the arena, and the matchmaker around one context. */
export async function createServer(context: AppContext, options: BuildAppOptions = {}) {
  const app = await buildApp(context, options);
  const io: GameServer = new Server();
  const arena = new Arena(context, io as unknown as Server, app.log);
  const matchmaker = new Matchmaker(context, arena, app.log);
  context.nudgeMatchmaker = () => matchmaker.nudge();
  context.cancelMatch = (matchId) => arena.cancel(matchId);
  const rooms = createRealtime(app.server, context, arena, io, app.log);

  let closing: Promise<void> | null = null;
  const close = () => {
    closing ??= (async () => {
      await matchmaker.stop();
      await arena.shutdown();
      await io.close();
      await app.close();
    })();
    return closing;
  };

  return { app, io, arena, matchmaker, rooms, close };
}
