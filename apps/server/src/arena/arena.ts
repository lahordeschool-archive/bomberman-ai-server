import {
  type BotController,
  extractChat,
  runMatch,
  sanitizeChat,
  SDK_VERSION,
} from '@bomberman/bot-sdk';
import {
  createGame,
  DIRECTIONS,
  DIRECTION_DELTAS,
  hashState,
  isWalkable,
  randomSeed,
  type Snapshot,
  toSnapshot,
} from '@bomberman/game-engine';
import type {
  ChatAuthor,
  ChatMessage,
  MatchInit,
  MatchParticipantInfo,
  ServerToClientEvents,
} from '@bomberman/protocol';
import type { FastifyBaseLogger } from 'fastify';
import type { Server } from 'socket.io';
import type { AppContext } from '../context.ts';
import { inspectCompletedMatch } from '../store/integrity.ts';
import { captureServerEvent } from '../analytics/posthog.ts';
import { abortMatch, completeMatch, insertMatch, type NewParticipant } from '../store/matches.ts';

export interface ArenaParticipant {
  info: Omit<MatchParticipantInfo, 'slot'>;
  record: Omit<NewParticipant, 'slot'>;
  controller: BotController | null;
}

interface LiveMatch {
  init: MatchInit;
  snapshot: Snapshot;
  abort: AbortController;
  botIds: string[];
  done: Promise<void>;
  chat: ChatMessage[];
  nextChatId: number;
  /** Last accepted message time per sender (`user:<id>` or `bot:<slot>`). */
  lastChatAt: Map<string, number>;
}

/** Each bot and each spectator may post at most one line per interval. */
export const CHAT_INTERVAL_MS = 1000;
const CHAT_HISTORY = 100;
/** Spectators keep talking through the result and the wait for the next match. */
export const CHAT_GRACE_MS = 2 * 60_000;

export type ChatOutcome =
  { ok: true; message: ChatMessage } | { ok: false; reason: 'not-live' | 'too-fast' | 'empty' };

export interface StartOptions {
  kind: 'ranked' | 'casual' | 'tournament';
  tournamentId?: string;
  /** Bot seeds derive from this; random when omitted. */
  seed?: number;
  participants: ArenaParticipant[];
  decisionTimeoutMs: number;
  maxTicks?: number;
  /** Runs after the match exists and before the first tick, e.g. to join sockets to its room. */
  beforeRun?: (init: MatchInit) => void;
  onFinished?: (matchId: string) => void;
}

export const matchRoom = (matchId: string) => `match:${matchId}`;

/**
 * Runs authoritative matches in real time: drives the engine, streams snapshots to
 * the match room, and persists the result together with its replay log.
 */
export class Arena {
  private readonly context: AppContext;
  private readonly io: Server<Record<string, never>, ServerToClientEvents>;
  private readonly log: FastifyBaseLogger;
  private readonly live = new Map<string, LiveMatch>();
  /** Finished matches whose chat is still open, for `CHAT_GRACE_MS`. */
  private readonly ended = new Map<string, LiveMatch>();

  constructor(context: AppContext, io: Server, log: FastifyBaseLogger) {
    this.context = context;
    this.io = io as unknown as Server<Record<string, never>, ServerToClientEvents>;
    this.log = log;
  }

  get size(): number {
    return this.live.size;
  }

  runningCount(kind: 'ranked' | 'casual' | 'tournament'): number {
    let count = 0;
    for (const match of this.live.values()) if (match.init.kind === kind) count++;
    return count;
  }

  busyBotIds(): Set<string> {
    const ids = new Set<string>();
    for (const match of this.live.values()) for (const id of match.botIds) ids.add(id);
    return ids;
  }

  /** The init payload with the latest snapshot, for spectators joining mid match. */
  watch(matchId: string): MatchInit | null {
    const match = this.live.get(matchId);
    return match ? { ...match.init, snapshot: match.snapshot, chat: [...match.chat] } : null;
  }

  /** Posts a line to the chat of a live or just finished match, and broadcasts it to its room. */
  chat(matchId: string, sender: string, from: ChatAuthor, text: unknown): ChatOutcome {
    const match = this.live.get(matchId) ?? this.ended.get(matchId);
    if (!match) return { ok: false, reason: 'not-live' };
    const clean = sanitizeChat(text);
    if (!clean) return { ok: false, reason: 'empty' };
    const now = Date.now();
    const last = match.lastChatAt.get(sender);
    if (last !== undefined && now - last < CHAT_INTERVAL_MS)
      return { ok: false, reason: 'too-fast' };
    match.lastChatAt.set(sender, now);
    const message: ChatMessage = { id: match.nextChatId++, matchId, at: now, from, text: clean };
    match.chat.push(message);
    if (match.chat.length > CHAT_HISTORY) match.chat.splice(0, match.chat.length - CHAT_HISTORY);
    this.io.to(matchRoom(matchId)).emit('match:chat', message);
    return { ok: true, message };
  }

  async start(options: StartOptions): Promise<{ matchId: string; done: Promise<void> }> {
    const seed = options.seed ?? randomSeed();
    const state = createGame({
      seed,
      playerCount: options.participants.length,
      settings: options.maxTicks ? { maxTicks: options.maxTicks } : undefined,
    });
    const controllers = options.participants.map((participant) => participant.controller);
    let matchId: string;
    try {
      matchId = await insertMatch(this.context.db, {
        kind: options.kind,
        tournamentId: options.tournamentId,
        engineVersion: state.engineVersion,
        sdkVersion: SDK_VERSION,
        seed,
        settings: state.settings,
        participants: options.participants.map((participant, slot) => ({
          ...participant.record,
          slot,
        })),
      });
    } catch (error) {
      await Promise.allSettled(controllers.map((controller) => controller?.dispose?.()));
      throw error;
    }
    const init: MatchInit = {
      matchId,
      kind: options.kind,
      participants: options.participants.map((participant, slot) => ({
        ...participant.info,
        slot,
      })),
      maxTicks: state.settings.maxTicks,
      snapshot: toSnapshot(state, []),
      chat: [],
    };
    const abort = new AbortController();
    const room = matchRoom(matchId);
    const entry: LiveMatch = {
      init,
      snapshot: init.snapshot,
      abort,
      botIds: options.participants.flatMap((participant) =>
        participant.record.botId && participant.record.kind === 'ranked'
          ? [participant.record.botId]
          : [],
      ),
      done: Promise.resolve(),
      chat: [],
      nextChatId: 1,
      lastChatAt: new Map(),
    };
    this.live.set(matchId, entry);
    options.beforeRun?.(init);
    this.io.to(room).emit('match:init', init);
    this.log.info(
      { matchId, kind: options.kind, players: options.participants.length },
      'match started',
    );

    entry.done = (async () => {
      try {
        const deaths: { playerId: number; killedBy: number | null; escapeAvailable: boolean }[] =
          [];
        const outcome = await runMatch({
          state,
          controllers,
          tickMs: this.context.config.matchTickMs,
          decisionTimeoutMs: options.decisionTimeoutMs,
          signal: abort.signal,
          onTick: (current, events) => {
            for (const event of events) {
              if (event.type !== 'playerDied') continue;
              const player = current.players[event.playerId];
              if (!player) continue;
              const escapeAvailable = DIRECTIONS.some((direction) => {
                const { dx, dy } = DIRECTION_DELTAS[direction];
                const x = player.x + dx;
                const y = player.y + dy;
                return (
                  isWalkable(current, x, y) &&
                  !current.flames.some((flame) => flame.x === x && flame.y === y)
                );
              });
              deaths.push({
                playerId: event.playerId,
                killedBy: event.killedBy,
                escapeAvailable,
              });
            }
            const snapshot = toSnapshot(current, events);
            entry.snapshot = snapshot;
            this.io.to(room).emit('match:snapshot', { matchId, snapshot });
          },
          onRawDecision: (slot, raw) => {
            const text = extractChat(raw);
            const participant = init.participants[slot];
            if (!text || !participant) return;
            this.chat(matchId, `bot:${slot}`, { kind: 'bot', name: participant.name, slot }, text);
          },
          onDecisionError: (slot, error) => {
            this.log.debug({ matchId, slot, err: String(error) }, 'decision dropped');
          },
        });
        const result = outcome.state.result!;
        await this.context.db.transaction((tx) =>
          completeMatch(tx, matchId, {
            result,
            intents: outcome.intents,
            finalHash: hashState(outcome.state),
            deaths,
          }),
        );
        if (options.kind === 'ranked') {
          await inspectCompletedMatch(this.context.db, matchId).catch((error: unknown) =>
            this.log.error({ matchId, err: error }, 'ranked integrity analysis failed'),
          );
        }
        this.io.to(room).emit('match:end', { matchId, result });
        captureServerEvent(this.context.config, 'match_finished', 'bomber-arena-server', {
          matchId,
          kind: options.kind,
          players: options.participants.length,
          endTick: result.endTick,
          winnerId: result.winnerId,
          deaths: deaths.length,
          $process_person_profile: false,
        });
        this.log.info(
          {
            matchId,
            kind: options.kind,
            endTick: result.endTick,
            winner: result.winnerId,
            intents: outcome.intents.length,
          },
          'match completed',
        );
      } catch (error) {
        await abortMatch(this.context.db, matchId).catch(() => undefined);
        if (!abort.signal.aborted) this.log.error({ matchId, err: error }, 'match failed');
      } finally {
        await Promise.allSettled(controllers.map((controller) => controller?.dispose?.()));
        this.live.delete(matchId);
        this.ended.set(matchId, entry);
        setTimeout(() => this.ended.delete(matchId), CHAT_GRACE_MS).unref();
        options.onFinished?.(matchId);
      }
    })();
    return { matchId, done: entry.done };
  }

  /** Cancels one live match and waits until its controllers and database state are settled. */
  async cancel(matchId: string): Promise<boolean> {
    const match = this.live.get(matchId);
    if (!match) return false;
    match.abort.abort();
    await match.done;
    return true;
  }

  /** Stops every running match; unfinished matches are recorded as aborted. */
  async shutdown(): Promise<void> {
    const pending = [...this.live.values()];
    for (const match of pending) match.abort.abort();
    await Promise.allSettled(pending.map((match) => match.done));
  }
}
