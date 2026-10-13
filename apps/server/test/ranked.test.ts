import type { AddressInfo } from 'node:net';
import { SAMPLE_BOTS } from '@bomberman/bot-sdk';
import { hashState, runReplay } from '@bomberman/game-engine';
import {
  decodeIntent,
  type ClientToServerEvents,
  type ServerToClientEvents,
} from '@bomberman/protocol';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/context.ts';
import { createServer } from '../src/server.ts';
import { abortStaleMatches, insertMatch } from '../src/store/matches.ts';
import { createTestContext, TestClient } from './helpers.ts';

type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

let context: AppContext;
let server: Awaited<ReturnType<typeof createServer>>;
let baseUrl: string;
const sockets: ClientSocket[] = [];

beforeAll(async () => {
  context = await createTestContext({
    RANKED_CONCURRENCY: '1',
    MATCHMAKER_INTERVAL_MS: '250',
    RANKED_MAX_TICKS: '600',
    MATCH_TICK_MS: '2',
  });
  server = await createServer(context, { logger: false });
  await server.app.listen({ host: '127.0.0.1', port: 0 });
  baseUrl = `http://127.0.0.1:${(server.app.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const socket of sockets) socket.close();
  await server.close();
  await context.db.close();
});

function openSocket(client?: TestClient, origin = 'http://localhost:8080'): ClientSocket {
  const socket: ClientSocket = connect(baseUrl, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    extraHeaders: { origin, ...(client?.cookie ? { cookie: client.cookie } : {}) },
  });
  sockets.push(socket);
  return socket;
}

const waitFor = async <T>(
  probe: () => Promise<T | null | undefined> | T | null | undefined,
  timeoutMs = 20_000,
) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

describe('ranked matches', () => {
  it('runs a queued bot in the sandbox, records a verifiable replay, and updates the ladder', async () => {
    const client = new TestClient(server.app);
    await client.register('ranked_player');
    const bot = await client.request('POST', '/api/bots', { name: 'Ladder Climber' });
    const cautious = SAMPLE_BOTS.find((sample) => sample.slug === 'cautious-bomber')!;
    await client.request('POST', `/api/bots/${bot.body.id}/versions`, { source: cautious.source });

    const spectator = openSocket();
    await new Promise<void>((resolve) => spectator.on('connect', () => resolve()));
    const seen = { snapshots: 0, ended: false };
    spectator.on('match:snapshot', () => seen.snapshots++);
    spectator.on('match:end', () => (seen.ended = true));

    await client.request('POST', `/api/bots/${bot.body.id}/ranked`);
    const live = await waitFor(async () => {
      const status = await client.request('GET', '/api/ranked/status');
      return status.body.liveMatches[0] as { id: string } | undefined;
    });
    const init = await spectator.emitWithAck('match:watch', { matchId: live.id });
    if (init.ok) {
      expect(init.data.kind).toBe('ranked');
      expect(init.data.participants.map((participant) => participant.name)).toContain(
        'Ladder Climber',
      );
    }

    const match = await waitFor(async () => {
      const response = await client.request('GET', `/api/matches/${live.id}`);
      return response.body.status === 'completed' ? response.body : null;
    });
    expect(match.kind).toBe('ranked');
    expect(match.participants).toHaveLength(1 + context.house.length);
    const mine = match.participants.find(
      (participant: { botId: string }) => participant.botId === bot.body.id,
    );
    expect(mine.botVersion).toBe(1);
    expect(mine.ratingBefore).toBe(1200);
    expect(mine.ratingAfter).not.toBeNull();

    const replay = (await client.request('GET', `/api/matches/${live.id}/replay`)).body;
    expect(replay.intents.length).toBeGreaterThan(0);
    const final = runReplay({
      engineVersion: replay.engineVersion,
      seed: replay.seed,
      playerCount: replay.playerCount,
      settings: replay.settings,
      intents: replay.intents.map(([tick, playerId, code]: [number, number, string]) => ({
        tick,
        playerId,
        intent: decodeIntent(code),
      })),
    });
    expect(hashState(final)).toBe(replay.finalHash);
    expect(final.result!.endTick).toBe(match.endTick);

    if (init.ok) {
      await waitFor(() => seen.ended);
      expect(seen.snapshots).toBeGreaterThan(0);
    }

    const leaderboard = (await client.request('GET', '/api/leaderboard')).body;
    expect(leaderboard.entries.map((entry: { botId: string }) => entry.botId)).toContain(
      bot.body.id,
    );
    const mineOnBoard = leaderboard.entries.find(
      (entry: { botId: string }) => entry.botId === bot.body.id,
    );
    expect(mineOnBoard.games).toBeGreaterThanOrEqual(1);

    await client.request('DELETE', `/api/bots/${bot.body.id}/ranked`);
    await waitFor(() => server.arena.runningCount('ranked') === 0);
  });
});

describe('realtime', () => {
  it('rejects handshakes from foreign origins', async () => {
    const socket = openSocket(undefined, 'https://evil.test');
    const error = await new Promise<Error>((resolve) => socket.on('connect_error', resolve));
    expect(error).toBeInstanceOf(Error);
  });

  it('lets anonymous sockets watch but not play', async () => {
    const socket = openSocket();
    await new Promise<void>((resolve) => socket.on('connect', () => resolve()));
    const created = await socket.emitWithAck('casual:create', { botName: 'Nope' });
    expect(created).toEqual({ ok: false, error: 'Sign in to play online.' });
    const missing = await socket.emitWithAck('match:watch', { matchId: 'not-a-match' });
    expect(missing.ok).toBe(false);
  });

  it('plays a casual room where each browser answers for its own bot', async () => {
    const host = new TestClient(server.app);
    await host.register('casual_host');
    const guest = new TestClient(server.app);
    await guest.register('casual_guest');
    const hostSocket = openSocket(host);
    const guestSocket = openSocket(guest);
    await Promise.all(
      [hostSocket, guestSocket].map(
        (socket) => new Promise<void>((resolve) => socket.on('connect', () => resolve())),
      ),
    );

    const observed = { host: 0, guest: 0 };
    hostSocket.on('bot:observe', (_payload, ack) => {
      observed.host++;
      ack('MOVE DOWN');
    });
    guestSocket.on('bot:observe', (_payload, ack) => {
      observed.guest++;
      ack({ type: 'move', direction: 'up' });
    });
    const slots: Record<string, number> = {};
    hostSocket.on('casual:match', ({ slot }) => (slots.host = slot));
    guestSocket.on('casual:match', ({ slot }) => (slots.guest = slot));
    let ended = false;
    hostSocket.on('match:end', () => (ended = true));

    const lobby = await hostSocket.emitWithAck('casual:create', { botName: 'Host Bot' });
    if (!lobby.ok) throw new Error(lobby.error);
    const joined = await guestSocket.emitWithAck('casual:join', {
      code: lobby.data.code.toLowerCase(),
      botName: 'Guest Bot',
    });
    if (!joined.ok) throw new Error(joined.error);
    expect(joined.data.members.map((member) => member.botName)).toEqual(['Host Bot', 'Guest Bot']);

    const notHost = await guestSocket.emitWithAck('casual:start', { houseBots: [] });
    expect(notHost.ok).toBe(false);
    const started = await hostSocket.emitWithAck('casual:start', { houseBots: ['random-walker'] });
    if (!started.ok) throw new Error(started.error);

    await waitFor(() => ended);
    expect(slots).toEqual({ host: 0, guest: 1 });
    expect(observed.host).toBeGreaterThan(0);
    expect(observed.guest).toBeGreaterThan(0);

    const match = (await host.request('GET', `/api/matches/${started.data.matchId}`)).body;
    expect(match.kind).toBe('casual');
    expect(match.status).toBe('completed');
    expect(
      match.participants.map((participant: { botName: string }) => participant.botName),
    ).toEqual(['Host Bot', 'Guest Bot', 'Random Walker']);
    expect(
      match.participants.every(
        (participant: { ratingAfter: number | null }) => participant.ratingAfter === null,
      ),
    ).toBe(true);
    const replay = (await host.request('GET', `/api/matches/${started.data.matchId}/replay`)).body;
    expect(
      replay.intents.some(([, slot, code]: [number, number, string]) => slot === 0 && code === 'd'),
    ).toBe(true);
  });
});

describe('startup recovery', () => {
  it('marks matches interrupted by a restart as aborted', async () => {
    const id = await insertMatch(context.db, {
      kind: 'ranked',
      engineVersion: 1,
      sdkVersion: 1,
      seed: 9,
      settings: { bombs: 1, flames: 2, speed: 1, maxTicks: 3600 },
      participants: [],
    });
    expect(await abortStaleMatches(context.db)).toBeGreaterThanOrEqual(1);
    const { rows } = await context.db.query<{ status: string }>(
      'select status from matches where id = $1',
      [id],
    );
    expect(rows[0]!.status).toBe('aborted');
  });
});
