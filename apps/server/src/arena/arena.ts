import { type BotController, runMatch, SDK_VERSION } from '@bomberman/bot-sdk';
import {
  createGame,
  hashState,
  randomSeed,
  type Snapshot,
  toSnapshot,
} from '@bomberman/game-engine';
import type { MatchInit, MatchParticipantInfo, ServerToClientEvents } from '@bomberman/protocol';
import type { FastifyBaseLogger } from 'fastify';
import type { Server } from 'socket.io';
import type { AppContext } from '../context.ts';
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
}

export interface StartOptions {
  kind: 'ranked' | 'casual';
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

  constructor(context: AppContext, io: Server, log: FastifyBaseLogger) {
    this.context = context;
    this.io = io as unknown as Server<Record<string, never>, ServerToClientEvents>;
    this.log = log;
  }

  get size(): number {
    return this.live.size;
  }

  runningCount(kind: 'ranked' | 'casual'): number {
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
    return match ? { ...match.init, snapshot: match.snapshot } : null;
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
      snapshot: toSnapshot(state, []),
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
        const outcome = await runMatch({
          state,
          controllers,
          tickMs: this.context.config.matchTickMs,
          decisionTimeoutMs: options.decisionTimeoutMs,
          signal: abort.signal,
          onTick: (current, events) => {
            const snapshot = toSnapshot(current, events);
            entry.snapshot = snapshot;
            this.io.to(room).emit('match:snapshot', { matchId, snapshot });
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
          }),
        );
        this.io.to(room).emit('match:end', { matchId, result });
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
        options.onFinished?.(matchId);
      }
    })();
    return { matchId, done: entry.done };
  }

  /** Stops every running match; unfinished matches are recorded as aborted. */
  async shutdown(): Promise<void> {
    const pending = [...this.live.values()];
    for (const match of pending) match.abort.abort();
    await Promise.allSettled(pending.map((match) => match.done));
  }
}
