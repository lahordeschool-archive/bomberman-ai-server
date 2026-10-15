import { randomInt } from 'node:crypto';
import { type BotController, botSeed, DECISION_BUDGET_MS } from '@bomberman/bot-sdk';
import { MAX_PLAYERS, MIN_PLAYERS, randomSeed } from '@bomberman/game-engine';
import {
  type CasualLobby,
  casualCreatePayload,
  casualJoinPayload,
  casualStartPayload,
  rawActionPayload,
  type ClientToServerEvents,
  type ServerToClientEvents,
  type SkinSlug,
} from '@bomberman/protocol';
import type { FastifyBaseLogger } from 'fastify';
import type { Server, Socket } from 'socket.io';
import { type Arena, type ArenaParticipant, matchRoom } from '../arena/arena.ts';
import type { AppContext } from '../context.ts';

export interface SocketUser {
  id: string;
  username: string;
  displayName: string;
}

export type GameSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  { user: SocketUser | null }
>;
export type GameServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  { user: SocketUser | null }
>;

const MAX_LOBBIES = 500;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

interface Member {
  userId: string;
  displayName: string;
  botName: string;
  socket: GameSocket;
  skin: SkinSlug | null;
}

interface Lobby {
  code: string;
  hostUserId: string;
  members: Member[];
  status: 'waiting' | 'playing';
  matchId: string | null;
}

export class UserError extends Error {}

/**
 * The server runs the authoritative match and asks each member's browser for its
 * bot's decision; casual code never leaves the player's machine, so results are
 * stored for replay but never rated.
 */
function browserController(socket: GameSocket, matchId: string): BotController {
  return {
    async decide(observation, signal, budgetMs) {
      if (!socket.connected) return null;
      const raw: unknown = await socket
        .timeout(budgetMs)
        .emitWithAck('bot:observe', { matchId, observation, budgetMs });
      if (signal.aborted) return null;
      const parsed = rawActionPayload.safeParse(raw);
      return parsed.success ? parsed.data : null;
    },
  };
}

export class CasualRooms {
  private readonly context: AppContext;
  private readonly arena: Arena;
  private readonly io: GameServer;
  private readonly log: FastifyBaseLogger;
  private readonly lobbies = new Map<string, Lobby>();
  private readonly lobbyOf = new Map<string, string>();

  constructor(context: AppContext, arena: Arena, io: GameServer, log: FastifyBaseLogger) {
    this.context = context;
    this.arena = arena;
    this.io = io;
    this.log = log;
  }

  private view(lobby: Lobby): CasualLobby {
    return {
      code: lobby.code,
      hostUserId: lobby.hostUserId,
      members: lobby.members.map(({ userId, displayName, botName }) => ({
        userId,
        displayName,
        botName,
      })),
      status: lobby.status,
      matchId: lobby.matchId,
    };
  }

  private broadcast(lobby: Lobby): void {
    this.io.to(`casual:${lobby.code}`).emit('casual:lobby', this.view(lobby));
  }

  private newCode(): string {
    for (;;) {
      let code = '';
      for (let i = 0; i < 6; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      if (!this.lobbies.has(code)) return code;
    }
  }

  private requireUser(socket: GameSocket): SocketUser {
    if (!socket.data.user) throw new UserError('Sign in to play online.');
    return socket.data.user;
  }

  async create(socket: GameSocket, payload: unknown): Promise<CasualLobby> {
    const user = this.requireUser(socket);
    const { botName, botId } = casualCreatePayload.parse(payload ?? {});
    const skin = await this.botSkin(user.id, botId);
    this.leave(socket);
    if (this.lobbies.size >= MAX_LOBBIES)
      throw new UserError('Too many rooms are open. Try again soon.');
    const lobby: Lobby = {
      code: this.newCode(),
      hostUserId: user.id,
      members: [{ userId: user.id, displayName: user.displayName, botName, socket, skin }],
      status: 'waiting',
      matchId: null,
    };
    this.lobbies.set(lobby.code, lobby);
    this.lobbyOf.set(socket.id, lobby.code);
    void socket.join(`casual:${lobby.code}`);
    return this.view(lobby);
  }

  async join(socket: GameSocket, payload: unknown): Promise<CasualLobby> {
    const user = this.requireUser(socket);
    const { code, botName, botId } = casualJoinPayload.parse(payload);
    const lobby = this.lobbies.get(code);
    if (!lobby) throw new UserError('No room with that code.');
    if (lobby.status !== 'waiting') throw new UserError('That room is already playing.');
    if (lobby.members.some((member) => member.userId === user.id)) {
      throw new UserError('You are already in that room.');
    }
    if (lobby.members.length >= MAX_PLAYERS) throw new UserError('That room is full.');
    this.leave(socket);
    const skin = await this.botSkin(user.id, botId);
    lobby.members.push({ userId: user.id, displayName: user.displayName, botName, socket, skin });
    this.lobbyOf.set(socket.id, code);
    void socket.join(`casual:${code}`);
    this.broadcast(lobby);
    return this.view(lobby);
  }

  private async botSkin(userId: string, botId: string | undefined): Promise<SkinSlug | null> {
    if (!botId) return null;
    const result = await this.context.db.query<{ skin_slug: SkinSlug | null }>(
      'select skin_slug from bots where id = $1 and owner_id = $2 and deleted_at is null',
      [botId, userId],
    );
    if (!result.rows[0]) throw new UserError('That bot is not available.');
    return result.rows[0].skin_slug;
  }

  leave(socket: GameSocket): void {
    const code = this.lobbyOf.get(socket.id);
    if (!code) return;
    this.lobbyOf.delete(socket.id);
    void socket.leave(`casual:${code}`);
    const lobby = this.lobbies.get(code);
    if (!lobby) return;
    lobby.members = lobby.members.filter((member) => member.socket.id !== socket.id);
    const hostLeft = !lobby.members.some((member) => member.userId === lobby.hostUserId);
    if (lobby.members.length === 0 || (hostLeft && lobby.status === 'waiting')) {
      this.lobbies.delete(code);
      for (const member of lobby.members) {
        this.lobbyOf.delete(member.socket.id);
        void member.socket.leave(`casual:${code}`);
        member.socket.emit('casual:lobby', null);
      }
      return;
    }
    this.broadcast(lobby);
  }

  async start(socket: GameSocket, payload: unknown): Promise<{ matchId: string }> {
    const user = this.requireUser(socket);
    const lobby = this.lobbies.get(this.lobbyOf.get(socket.id) ?? '');
    if (!lobby) throw new UserError('Create or join a room first.');
    if (lobby.hostUserId !== user.id) throw new UserError('Only the host can start the match.');
    if (lobby.status !== 'waiting') throw new UserError('The match already started.');
    const { houseBots } = casualStartPayload.parse(payload ?? {});
    const house = houseBots.map((slug) => {
      const bot = this.context.house.find((candidate) => candidate.slug === slug);
      if (!bot) throw new UserError(`Unknown sample bot ${slug}.`);
      return bot;
    });
    const total = lobby.members.length + house.length;
    if (total < MIN_PLAYERS || total > MAX_PLAYERS) {
      throw new UserError(`A match needs ${MIN_PLAYERS} to ${MAX_PLAYERS} players.`);
    }

    lobby.status = 'playing';
    const seed = randomSeed();
    const participants: ArenaParticipant[] = [];
    const members = [...lobby.members];
    let matchId = '';
    try {
      for (const member of members) {
        participants.push({
          info: {
            name: member.botName,
            owner: member.displayName,
            kind: 'browser',
            skin: member.skin,
          },
          record: {
            kind: 'browser',
            botId: null,
            botVersionId: null,
            userId: member.userId,
            botName: member.botName,
            skin: member.skin,
          },
          controller: {
            decide: (observation, signal, budgetMs) =>
              browserController(member.socket, matchId).decide(observation, signal, budgetMs),
          },
        });
      }
      for (const bot of house) {
        participants.push({
          info: { name: bot.name, owner: 'House', kind: 'house', skin: null },
          record: {
            kind: 'house',
            botId: bot.botId,
            botVersionId: bot.versionId,
            userId: null,
            botName: bot.name,
            skin: null,
          },
          controller: await this.context.executor.createSession(
            bot.source,
            botSeed(seed, participants.length),
          ),
        });
      }
      const started = await this.arena.start({
        kind: 'casual',
        seed,
        participants,
        decisionTimeoutMs: DECISION_BUDGET_MS,
        beforeRun: (init) => {
          matchId = init.matchId;
          lobby.matchId = init.matchId;
          members.forEach((member, slot) => {
            void member.socket.join(matchRoom(init.matchId));
            member.socket.emit('casual:match', { matchId: init.matchId, slot });
          });
        },
        onFinished: () => {
          lobby.status = 'waiting';
          lobby.matchId = null;
          if (this.lobbies.get(lobby.code) === lobby) {
            if (!lobby.members.some((member) => member.userId === lobby.hostUserId)) {
              const [next] = lobby.members;
              if (next) lobby.hostUserId = next.userId;
            }
            this.broadcast(lobby);
          }
        },
      });
      this.broadcast(lobby);
      this.log.info({ matchId: started.matchId, code: lobby.code }, 'casual match started');
      return { matchId: started.matchId };
    } catch (error) {
      lobby.status = 'waiting';
      await Promise.allSettled(
        participants.map((participant) => participant.controller?.dispose?.()),
      );
      throw error;
    }
  }
}
