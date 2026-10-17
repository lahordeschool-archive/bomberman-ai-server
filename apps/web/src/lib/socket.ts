import type { ClientToServerEvents, ServerToClientEvents } from '@bomberman/protocol';
import { io, type Socket } from 'socket.io-client';

export type ArenaSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

let socket: ArenaSocket | null = null;

export function getSocket(): ArenaSocket {
  socket ??= io({ withCredentials: true, transports: ['websocket', 'polling'] });
  return socket;
}

/**
 * Reconnects with fresh cookies after login or logout. The instance stays the same so
 * listeners survive; they see a disconnect then a connect, and rejoin their rooms.
 */
export function resetSocket(): void {
  socket?.disconnect().connect();
}

export function emitWithAck<T>(
  event: 'match:watch' | 'match:chat' | 'casual:create' | 'casual:join' | 'casual:start',
  payload: unknown,
): Promise<T> {
  type Response = { ok: true; data: unknown } | { ok: false; error: string };
  const socket = getSocket() as unknown as {
    timeout(ms: number): {
      emit(
        event: string,
        payload: unknown,
        ack: (error: Error | null, response: Response) => void,
      ): void;
    };
  };
  return new Promise((resolve, reject) => {
    socket.timeout(5000).emit(event, payload, (error, response) => {
      if (error) reject(new Error('The server did not answer. Please try again.'));
      else if (!response.ok) reject(new Error(response.error));
      else resolve(response.data as T);
    });
  });
}
