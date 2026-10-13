import { createHash } from 'node:crypto';
import { SDK_VERSION } from '@bomberman/bot-sdk';
import type {
  BotDetail,
  BotSummary,
  BotVersionDetail,
  BotVersionSummary,
} from '@bomberman/protocol';
import type { Queryable } from '../db/database.ts';
import { iso } from '../db/rows.ts';

export const DEFAULT_RATING = 1200;

interface BotSummaryRow {
  id: string;
  name: string;
  owner_id: string;
  owner_username: string;
  owner_display_name: string;
  owner_is_house: boolean;
  active_version_id: string | null;
  active_version: number | null;
  active_created_at: Date | null;
  rating: number | null;
  games: number | null;
  wins: number | null;
  queued: boolean;
  created_at: Date;
}

export interface BotVersionRow {
  id: string;
  bot_id: string;
  version: number;
  source: string;
  source_hash: string;
  sdk_version: number;
  visibility: 'private' | 'public';
  created_at: Date;
}

const SUMMARY_SELECT = `
  select b.id, b.name, b.owner_id, b.created_at, b.active_version_id,
         u.username as owner_username, u.display_name as owner_display_name, u.is_house as owner_is_house,
         v.version as active_version, v.created_at as active_created_at,
         r.rating, r.games, r.wins,
         exists (select 1 from ranked_queue q where q.bot_id = b.id) as queued
  from bots b
  join users u on u.id = b.owner_id
  left join bot_versions v on v.id = b.active_version_id
  left join ratings r on r.bot_id = b.id`;

function toSummary(row: BotSummaryRow): BotSummary {
  return {
    id: row.id,
    name: row.name,
    owner: {
      username: row.owner_username,
      displayName: row.owner_display_name,
      isHouse: row.owner_is_house,
    },
    activeVersion:
      row.active_version_id && row.active_version !== null && row.active_created_at
        ? {
            id: row.active_version_id,
            version: row.active_version,
            createdAt: iso(row.active_created_at),
          }
        : null,
    rating:
      row.rating === null
        ? null
        : { rating: row.rating, games: row.games ?? 0, wins: row.wins ?? 0 },
    queued: row.queued,
    createdAt: iso(row.created_at),
  };
}

export function toVersionSummary(row: BotVersionRow): BotVersionSummary {
  return {
    id: row.id,
    version: row.version,
    sourceHash: row.source_hash,
    sdkVersion: row.sdk_version,
    visibility: row.visibility,
    createdAt: iso(row.created_at),
  };
}

export function toVersionDetail(row: BotVersionRow, canReadSource: boolean): BotVersionDetail {
  return { ...toVersionSummary(row), source: canReadSource ? row.source : null };
}

export interface BotRecord extends BotSummary {
  ownerId: string;
}

export async function listBotsByOwner(db: Queryable, ownerId: string): Promise<BotSummary[]> {
  const { rows } = await db.query<BotSummaryRow>(
    `${SUMMARY_SELECT} where b.owner_id = $1 and b.deleted_at is null order by b.created_at desc`,
    [ownerId],
  );
  return rows.map(toSummary);
}

export async function countBotsByOwner(db: Queryable, ownerId: string): Promise<number> {
  const { rows } = await db.query<{ count: number }>(
    'select count(*)::int as count from bots where owner_id = $1 and deleted_at is null',
    [ownerId],
  );
  return rows[0]?.count ?? 0;
}

export async function getBot(db: Queryable, id: string): Promise<BotRecord | null> {
  const { rows } = await db.query<BotSummaryRow>(
    `${SUMMARY_SELECT} where b.id = $1 and b.deleted_at is null`,
    [id],
  );
  const row = rows[0];
  return row ? { ...toSummary(row), ownerId: row.owner_id } : null;
}

export async function getBotDetail(
  db: Queryable,
  id: string,
): Promise<(BotDetail & { ownerId: string }) | null> {
  const bot = await getBot(db, id);
  if (!bot) return null;
  const { rows } = await db.query<BotVersionRow>(
    'select * from bot_versions where bot_id = $1 order by version desc',
    [id],
  );
  return { ...bot, versions: rows.map(toVersionSummary) };
}

export async function createBot(db: Queryable, ownerId: string, name: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    'insert into bots (owner_id, name) values ($1, $2) returning id',
    [ownerId, name],
  );
  return rows[0]!.id;
}

export async function renameBot(db: Queryable, id: string, name: string): Promise<void> {
  await db.query('update bots set name = $2, updated_at = now() where id = $1', [id, name]);
}

/** Soft delete: past matches keep pointing at the bot and its versions. */
export async function deleteBot(db: Queryable, id: string): Promise<void> {
  await db.query('update bots set deleted_at = now(), updated_at = now() where id = $1', [id]);
  await db.query('delete from ranked_queue where bot_id = $1', [id]);
}

export function sourceHash(source: string): string {
  return createHash('sha256').update(source).digest('hex');
}

export async function addVersion(
  db: Queryable,
  botId: string,
  source: string,
  visibility: 'private' | 'public',
): Promise<BotVersionRow> {
  await db.query('select id from bots where id = $1 for update', [botId]);
  const { rows } = await db.query<BotVersionRow>(
    `insert into bot_versions (bot_id, version, source, source_hash, sdk_version, visibility)
     values ($1, coalesce((select max(version) from bot_versions where bot_id = $1), 0) + 1, $2, $3, $4, $5)
     returning *`,
    [botId, source, sourceHash(source), SDK_VERSION, visibility],
  );
  const version = rows[0]!;
  await db.query('update bots set active_version_id = $2, updated_at = now() where id = $1', [
    botId,
    version.id,
  ]);
  return version;
}

export async function getVersion(
  db: Queryable,
  botId: string,
  versionId: string,
): Promise<BotVersionRow | null> {
  const { rows } = await db.query<BotVersionRow>(
    'select * from bot_versions where id = $1 and bot_id = $2',
    [versionId, botId],
  );
  return rows[0] ?? null;
}

export async function getVersionSources(
  db: Queryable,
  versionIds: string[],
): Promise<Map<string, string>> {
  const { rows } = await db.query<{ id: string; source: string }>(
    'select id, source from bot_versions where id = any($1::uuid[])',
    [versionIds],
  );
  return new Map(rows.map((row) => [row.id, row.source]));
}

export async function enqueueBot(db: Queryable, botId: string): Promise<void> {
  await db.query('insert into ranked_queue (bot_id) values ($1) on conflict (bot_id) do nothing', [
    botId,
  ]);
  await db.query(
    `insert into ratings (bot_id, rating) values ($1, $2) on conflict (bot_id) do nothing`,
    [botId, DEFAULT_RATING],
  );
}

export async function dequeueBot(db: Queryable, botId: string): Promise<void> {
  await db.query('delete from ranked_queue where bot_id = $1', [botId]);
}

export interface QueueEntry {
  botId: string;
  botName: string;
  ownerId: string;
  versionId: string;
  rating: number;
  enqueuedAt: string;
  lastMatchedAt: string | null;
}

/** Queued bots with a playable version, least recently matched first. */
export async function listQueue(db: Queryable, limit = 100): Promise<QueueEntry[]> {
  const { rows } = await db.query<{
    bot_id: string;
    name: string;
    owner_id: string;
    active_version_id: string;
    rating: number | null;
    enqueued_at: Date;
    last_matched_at: Date | null;
  }>(
    `select q.bot_id, b.name, b.owner_id, b.active_version_id, r.rating, q.enqueued_at, q.last_matched_at
     from ranked_queue q
     join bots b on b.id = q.bot_id and b.deleted_at is null and b.active_version_id is not null
     left join ratings r on r.bot_id = q.bot_id
     order by q.last_matched_at asc nulls first, q.enqueued_at asc
     limit $1`,
    [limit],
  );
  return rows.map((row) => ({
    botId: row.bot_id,
    botName: row.name,
    ownerId: row.owner_id,
    versionId: row.active_version_id,
    rating: row.rating ?? DEFAULT_RATING,
    enqueuedAt: iso(row.enqueued_at),
    lastMatchedAt: row.last_matched_at ? iso(row.last_matched_at) : null,
  }));
}

export async function markMatched(db: Queryable, botIds: string[]): Promise<void> {
  if (botIds.length === 0) return;
  await db.query('update ranked_queue set last_matched_at = now() where bot_id = any($1::uuid[])', [
    botIds,
  ]);
}
