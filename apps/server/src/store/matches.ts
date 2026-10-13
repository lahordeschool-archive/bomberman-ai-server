import type { MatchResult, MatchSettings, RecordedIntent } from '@bomberman/game-engine';
import type { MatchParticipantSummary, MatchSummary, ReplayResponse } from '@bomberman/protocol';
import { encodeIntent } from '@bomberman/protocol';
import type { Queryable } from '../db/database.ts';
import { iso, isoOrNull } from '../db/rows.ts';
import { multiplayerElo } from '../ratings/elo.ts';
import { DEFAULT_RATING } from './bots.ts';

export interface NewParticipant {
  slot: number;
  kind: 'ranked' | 'browser' | 'house';
  botId: string | null;
  botVersionId: string | null;
  userId: string | null;
  botName: string;
}

export interface NewMatch {
  kind: 'ranked' | 'casual';
  engineVersion: number;
  sdkVersion: number;
  seed: number;
  settings: MatchSettings;
  participants: NewParticipant[];
}

export async function insertMatch(db: Queryable, match: NewMatch): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into matches (kind, status, engine_version, sdk_version, seed, player_count, settings, rated)
     values ($1, 'running', $2, $3, $4, $5, $6, $7) returning id`,
    [
      match.kind,
      match.engineVersion,
      match.sdkVersion,
      match.seed,
      match.participants.length,
      JSON.stringify(match.settings),
      match.kind === 'ranked',
    ],
  );
  const id = rows[0]!.id;
  for (const participant of match.participants) {
    await db.query(
      `insert into match_participants (match_id, slot, kind, bot_id, bot_version_id, user_id, bot_name)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        id,
        participant.slot,
        participant.kind,
        participant.botId,
        participant.botVersionId,
        participant.userId,
        participant.botName,
      ],
    );
  }
  return id;
}

export async function abortMatch(db: Queryable, id: string): Promise<void> {
  await db.query(
    `update matches set status = 'aborted', ended_at = now() where id = $1 and status = 'running'`,
    [id],
  );
}

/** Matches left running by a crash or restart can never finish; mark them aborted. */
export async function abortStaleMatches(db: Queryable): Promise<number> {
  const { rowCount } = await db.query(
    `update matches set status = 'aborted', ended_at = now() where status = 'running'`,
  );
  return rowCount;
}

/**
 * Stores the outcome, the replay log, and (for ranked matches) the rating changes in
 * one transaction, so a result never exists without the replay that proves it.
 */
export async function completeMatch(
  tx: Queryable,
  id: string,
  outcome: { result: MatchResult; intents: RecordedIntent[]; finalHash: string },
): Promise<void> {
  const { result, intents, finalHash } = outcome;
  const { rows } = await tx.query<{ rated: boolean }>(
    `update matches set status = 'completed', ended_at = now(), end_tick = $2, end_reason = $3,
       winner_slot = $4, final_hash = $5
     where id = $1 and status = 'running' returning rated`,
    [id, result.endTick, result.reason, result.winnerId, finalHash],
  );
  if (!rows[0]) throw new Error(`Match ${id} is not running`);

  for (const player of result.players) {
    await tx.query(
      `update match_participants set placement = $3, score = $4, kills = $5, walls = $6, items = $7,
         died_at_tick = $8
       where match_id = $1 and slot = $2`,
      [
        id,
        player.playerId,
        player.placement,
        player.score,
        player.stats.kills,
        player.stats.wallsDestroyed,
        player.stats.itemsCollected,
        player.diedAtTick,
      ],
    );
  }

  if (intents.length > 0) {
    await tx.query(
      `insert into match_events (match_id, seq, tick, slot, intent)
       select $1::uuid, seq, tick, slot, intent
       from unnest($2::int[], $3::int[], $4::int[], $5::text[]) as e(seq, tick, slot, intent)`,
      [
        id,
        intents.map((_, index) => index),
        intents.map((record) => record.tick),
        intents.map((record) => record.playerId),
        intents.map((record) => encodeIntent(record.intent)),
      ],
    );
  }

  if (rows[0].rated) await applyRatings(tx, id);
}

/** Updates ratings for one completed ranked match from its stored placements. */
export async function applyRatings(tx: Queryable, matchId: string): Promise<void> {
  const { rows } = await tx.query<{ slot: number; bot_id: string; placement: number }>(
    `select slot, bot_id, placement from match_participants
     where match_id = $1 and bot_id is not null and placement is not null
     order by slot`,
    [matchId],
  );
  if (rows.length < 2) return;
  const ids = rows.map((row) => row.bot_id);
  await tx.query(
    `insert into ratings (bot_id, rating) select unnest($1::uuid[]), $2 on conflict (bot_id) do nothing`,
    [ids, DEFAULT_RATING],
  );
  const current = await tx.query<{ bot_id: string; rating: number }>(
    'select bot_id, rating from ratings where bot_id = any($1::uuid[]) for update',
    [ids],
  );
  const ratingOf = new Map(current.rows.map((row) => [row.bot_id, row.rating]));
  const before = rows.map((row) => ratingOf.get(row.bot_id) ?? DEFAULT_RATING);
  const after = multiplayerElo(
    rows.map((row, index) => ({ rating: before[index]!, placement: row.placement })),
  );
  for (const [index, row] of rows.entries()) {
    await tx.query(
      'update match_participants set rating_before = $3, rating_after = $4 where match_id = $1 and slot = $2',
      [matchId, row.slot, before[index], after[index]],
    );
    await tx.query(
      `update ratings set rating = $2, games = games + 1, wins = wins + $3, updated_at = now()
       where bot_id = $1`,
      [row.bot_id, after[index], row.placement === 1 ? 1 : 0],
    );
  }
}

/** Recomputes every rating from scratch by replaying rated results in order. */
export async function rebuildRatings(tx: Queryable): Promise<number> {
  await tx.query('update ratings set rating = $1, games = 0, wins = 0, updated_at = now()', [
    DEFAULT_RATING,
  ]);
  const { rows } = await tx.query<{ id: string }>(
    `select id from matches where rated and status = 'completed' order by ended_at asc, id asc`,
  );
  for (const row of rows) await applyRatings(tx, row.id);
  return rows.length;
}

interface MatchRow {
  id: string;
  kind: 'ranked' | 'casual';
  status: 'running' | 'completed' | 'aborted';
  started_at: Date;
  ended_at: Date | null;
  end_tick: number | null;
  winner_slot: number | null;
}

interface ParticipantRow {
  match_id: string;
  slot: number;
  bot_id: string | null;
  bot_name: string;
  bot_version: number | null;
  owner_username: string | null;
  owner_display_name: string | null;
  owner_is_house: boolean | null;
  placement: number | null;
  score: number | null;
  kills: number | null;
  rating_before: number | null;
  rating_after: number | null;
}

async function attachParticipants(db: Queryable, matches: MatchRow[]): Promise<MatchSummary[]> {
  if (matches.length === 0) return [];
  const { rows } = await db.query<ParticipantRow>(
    `select p.match_id, p.slot, p.bot_id, p.bot_name, v.version as bot_version,
            u.username as owner_username, u.display_name as owner_display_name, u.is_house as owner_is_house,
            p.placement, p.score, p.kills, p.rating_before, p.rating_after
     from match_participants p
     left join bot_versions v on v.id = p.bot_version_id
     left join users u on u.id = p.user_id
     where p.match_id = any($1::uuid[])
     order by p.slot`,
    [matches.map((match) => match.id)],
  );
  const byMatch = new Map<string, MatchParticipantSummary[]>();
  for (const row of rows) {
    const list = byMatch.get(row.match_id) ?? [];
    list.push({
      slot: row.slot,
      botId: row.bot_id,
      botName: row.bot_name,
      botVersion: row.bot_version,
      owner: row.owner_username
        ? {
            username: row.owner_username,
            displayName: row.owner_display_name ?? row.owner_username,
            isHouse: row.owner_is_house ?? false,
          }
        : null,
      placement: row.placement,
      score: row.score,
      kills: row.kills,
      ratingBefore: row.rating_before,
      ratingAfter: row.rating_after,
    });
    byMatch.set(row.match_id, list);
  }
  return matches.map((match) => ({
    id: match.id,
    kind: match.kind,
    status: match.status,
    startedAt: iso(match.started_at),
    endedAt: isoOrNull(match.ended_at),
    endTick: match.end_tick,
    winnerSlot: match.winner_slot,
    participants: byMatch.get(match.id) ?? [],
  }));
}

const MATCH_COLUMNS = 'm.id, m.kind, m.status, m.started_at, m.ended_at, m.end_tick, m.winner_slot';

export async function getMatchSummary(db: Queryable, id: string): Promise<MatchSummary | null> {
  const { rows } = await db.query<MatchRow>(
    `select ${MATCH_COLUMNS} from matches m where m.id = $1`,
    [id],
  );
  const [summary] = await attachParticipants(db, rows);
  return summary ?? null;
}

export async function listMatches(
  db: Queryable,
  filter: {
    limit: number;
    offset: number;
    botId?: string;
    username?: string;
    status?: 'running' | 'completed';
  },
): Promise<{ matches: MatchSummary[]; total: number }> {
  const conditions = ['m.status = $1'];
  const params: unknown[] = [filter.status ?? 'completed'];
  if (filter.botId) {
    params.push(filter.botId);
    conditions.push(
      `exists (select 1 from match_participants p where p.match_id = m.id and p.bot_id = $${params.length})`,
    );
  }
  if (filter.username) {
    params.push(filter.username);
    conditions.push(
      `exists (select 1 from match_participants p join users u on u.id = p.user_id
               where p.match_id = m.id and u.username = $${params.length})`,
    );
  }
  const where = conditions.join(' and ');
  const total = await db.query<{ count: number }>(
    `select count(*)::int as count from matches m where ${where}`,
    params,
  );
  const order =
    filter.status === 'running'
      ? 'm.started_at desc'
      : 'm.ended_at desc nulls last, m.started_at desc';
  const { rows } = await db.query<MatchRow>(
    `select ${MATCH_COLUMNS} from matches m where ${where} order by ${order}
     limit $${params.length + 1} offset $${params.length + 2}`,
    [...params, filter.limit, filter.offset],
  );
  return { matches: await attachParticipants(db, rows), total: total.rows[0]?.count ?? 0 };
}

export async function getReplay(db: Queryable, id: string): Promise<ReplayResponse | null> {
  const { rows } = await db.query<{
    engine_version: number;
    seed: number;
    player_count: number;
    settings: ReplayResponse['settings'] | string;
    final_hash: string;
  }>(
    `select engine_version, seed, player_count, settings, final_hash
     from matches where id = $1 and status = 'completed'`,
    [id],
  );
  const match = rows[0];
  if (!match) return null;
  const events = await db.query<{ tick: number; slot: number; intent: string }>(
    'select tick, slot, intent from match_events where match_id = $1 order by seq',
    [id],
  );
  return {
    matchId: id,
    engineVersion: match.engine_version,
    seed: Number(match.seed),
    playerCount: match.player_count,
    settings: typeof match.settings === 'string' ? JSON.parse(match.settings) : match.settings,
    finalHash: match.final_hash,
    intents: events.rows.map((event) => [event.tick, event.slot, event.intent]),
  };
}
