import { botSeed, DECISION_BUDGET_MS } from '@bomberman/bot-sdk';
import { MAX_PLAYERS as MAX_PLAYERS_PER_MATCH, randomSeed } from '@bomberman/game-engine';
import type { FastifyBaseLogger } from 'fastify';
import type { AppContext } from '../context.ts';
import type { SkinSlug } from '@bomberman/protocol';
import { BotRejectedError, RunnerUnavailableError } from '../runner/executor.ts';
import {
  dequeueBot,
  getVersionSources,
  listQueue,
  markMatched,
  type QueueEntry,
} from '../store/bots.ts';
import type { Arena, ArenaParticipant } from './arena.ts';
import {
  activeTournamentQueue,
  markTournamentMatched,
  type TournamentQueueEntry,
} from '../store/tournaments.ts';

interface Pick {
  botId: string;
  versionId: string;
  name: string;
  owner: string;
  kind: 'ranked' | 'house';
  ownerId: string | null;
  skin: SkinSlug | null;
}

/**
 * Builds ranked matches from the queue: the bot that waited longest is matched with
 * the closest rated queued bots, and randomly drawn house bots fill the remaining seats. Every bot
 * runs inside the isolated runner; only these server completed matches are rated.
 */
export class Matchmaker {
  private readonly context: AppContext;
  private readonly arena: Arena;
  private readonly log: FastifyBaseLogger;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private stopped = false;

  constructor(context: AppContext, arena: Arena, log: FastifyBaseLogger) {
    this.context = context;
    this.arena = arena;
    this.log = log;
  }

  start(): void {
    if (this.timer || this.context.config.rankedConcurrency === 0) return;
    this.timer = setInterval(() => this.nudge(), this.context.config.matchmakerIntervalMs);
    this.timer.unref();
    this.nudge();
  }

  stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    return this.running ?? Promise.resolve();
  }

  nudge(): void {
    if (this.stopped) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = this.fill()
      .then(() => undefined)
      .catch((error: unknown) => this.log.error({ err: error }, 'matchmaker failed'))
      .finally(() => {
        this.running = null;
        if (this.again && this.timer) {
          this.again = false;
          this.nudge();
        }
      });
  }

  /** Starts matches until the concurrency limit is reached or nobody is waiting. */
  async fill(): Promise<string[]> {
    const started: string[] = [];
    while (
      !this.stopped &&
      this.arena.runningCount('ranked') + this.arena.runningCount('tournament') <
        this.context.config.rankedConcurrency
    ) {
      const busy = this.arena.busyBotIds();
      const tournamentQueue = (await activeTournamentQueue(this.context.db)).filter(
        (entry) => !busy.has(entry.botId),
      );
      if (tournamentQueue.length > 0) {
        const anchor = tournamentQueue[0]!;
        const sameTournament = tournamentQueue
          .filter((entry) => entry.tournamentId === anchor.tournamentId)
          .slice(0, MAX_PLAYERS_PER_MATCH);
        const matchId = await this.startMatch(
          this.pickTournament(sameTournament),
          'tournament',
          anchor.tournamentId,
        );
        if (!matchId) break;
        started.push(matchId);
        continue;
      }
      const queue = (await listQueue(this.context.db, 200)).filter(
        (entry) => !busy.has(entry.botId),
      );
      if (queue.length === 0) break;
      const matchId = await this.startMatch(this.pick(queue), 'ranked');
      if (!matchId) break;
      started.push(matchId);
    }
    return started;
  }

  private pickTournament(queue: TournamentQueueEntry[]): Pick[] {
    const picks: Pick[] = queue.map((entry) => ({
      botId: entry.botId,
      versionId: entry.versionId,
      name: entry.botName,
      owner: '',
      kind: 'ranked',
      ownerId: entry.ownerId,
      skin: null,
    }));
    const house = [...this.context.house];
    while (picks.length < MAX_PLAYERS_PER_MATCH && house.length > 0) {
      const [pick] = house.splice(Math.floor(Math.random() * house.length), 1);
      picks.push({
        botId: pick!.botId,
        versionId: pick!.versionId,
        name: pick!.name,
        owner: 'House',
        kind: 'house',
        ownerId: null,
        skin: null,
      });
    }
    return picks;
  }

  private pick(queue: QueueEntry[]): Pick[] {
    const [anchor, ...rest] = queue;
    const opponents = rest
      .sort((a, b) => Math.abs(a.rating - anchor!.rating) - Math.abs(b.rating - anchor!.rating))
      .slice(0, MAX_PLAYERS_PER_MATCH - 1);
    const picks: Pick[] = [anchor!, ...opponents].map((entry) => ({
      botId: entry.botId,
      versionId: entry.versionId,
      name: entry.botName,
      owner: '',
      kind: 'ranked',
      ownerId: entry.ownerId,
      skin: entry.skin,
    }));
    const house = [...this.context.house];
    while (picks.length < MAX_PLAYERS_PER_MATCH && house.length > 0) {
      const [pick] = house.splice(Math.floor(Math.random() * house.length), 1);
      picks.push({
        botId: pick!.botId,
        versionId: pick!.versionId,
        name: pick!.name,
        owner: 'House',
        kind: 'house',
        ownerId: null,
        skin: null,
      });
    }
    return picks;
  }

  private async startMatch(
    picks: Pick[],
    kind: 'ranked' | 'tournament',
    tournamentId?: string,
  ): Promise<string | null> {
    const { db, executor } = this.context;
    const sources = await getVersionSources(
      db,
      picks.map((pick) => pick.versionId),
    );
    const owners = await db.query<{
      bot_id: string;
      owner_id: string;
      display_name: string;
      skin_slug: SkinSlug | null;
    }>(
      `select b.id as bot_id, b.skin_slug, u.id as owner_id, u.display_name
       from bots b join users u on u.id = b.owner_id
       where b.id = any($1::uuid[])`,
      [picks.map((pick) => pick.botId)],
    );
    const ownerOf = new Map(owners.rows.map((row) => [row.bot_id, row]));
    const matchSeed = randomSeed();
    const participants: ArenaParticipant[] = [];
    try {
      for (const [slot, pick] of picks.entries()) {
        let controller = null;
        try {
          controller = await executor.createSession(
            sources.get(pick.versionId) ?? '',
            botSeed(matchSeed, slot),
          );
        } catch (error) {
          if (!(error instanceof BotRejectedError)) throw error;
          // A version that no longer loads still plays (idle) so the result stays honest.
          this.log.warn(
            { botId: pick.botId, err: error.message },
            'ranked bot failed to load; removed from queue',
          );
          await dequeueBot(db, pick.botId);
        }
        const owner = ownerOf.get(pick.botId);
        participants.push({
          info: {
            name: pick.name,
            owner: owner?.display_name ?? pick.owner,
            kind: pick.kind,
            skin: owner?.skin_slug ?? pick.skin,
          },
          record: {
            kind: pick.kind,
            botId: pick.botId,
            botVersionId: pick.versionId,
            userId: pick.kind === 'ranked' ? (owner?.owner_id ?? null) : null,
            botName: pick.name,
            skin: owner?.skin_slug ?? pick.skin,
          },
          controller,
        });
      }
    } catch (error) {
      await Promise.allSettled(
        participants.map((participant) => participant.controller?.dispose?.()),
      );
      if (error instanceof RunnerUnavailableError) {
        this.log.warn('bot runner unavailable; ranked matchmaking paused');
        return null;
      }
      throw error;
    }

    const playerBotIds = picks.filter((pick) => pick.kind === 'ranked').map((pick) => pick.botId);
    if (kind === 'tournament' && tournamentId) {
      await markTournamentMatched(db, tournamentId, playerBotIds);
    } else {
      await markMatched(db, playerBotIds);
    }
    const { matchId } = await this.arena.start({
      kind,
      tournamentId,
      seed: matchSeed,
      participants,
      decisionTimeoutMs: DECISION_BUDGET_MS,
      maxTicks: this.context.config.rankedMaxTicks,
      onFinished: () => this.nudge(),
    });
    return matchId;
  }
}
