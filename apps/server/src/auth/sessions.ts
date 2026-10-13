import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Queryable } from '../db/database.ts';
import type { UserRow } from '../store/users.ts';

export interface SessionRecord {
  tokenHash: string;
  csrfToken: string;
  expiresAt: Date;
  user: UserRow;
}

const REFRESH_AFTER_MS = 60 * 60 * 1000;

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const left = createHash('sha256').update(a).digest();
  const right = createHash('sha256').update(b).digest();
  return timingSafeEqual(left, right);
}

/**
 * Opaque random session tokens: the cookie holds the token, the database only its
 * SHA-256, so a database leak does not leak usable sessions.
 */
export async function createSession(
  db: Queryable,
  userId: string,
  ttlMs: number,
  meta: { ip?: string; userAgent?: string } = {},
): Promise<{ token: string; csrfToken: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const csrfToken = randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + ttlMs);
  await db.query(
    `insert into sessions (token_hash, user_id, csrf_token, expires_at, ip, user_agent)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      hashToken(token),
      userId,
      csrfToken,
      expiresAt,
      meta.ip ?? null,
      meta.userAgent?.slice(0, 200) ?? null,
    ],
  );
  return { token, csrfToken, expiresAt };
}

interface SessionJoinRow extends UserRow {
  token_hash: string;
  csrf_token: string;
  expires_at: Date;
  last_seen_at: Date;
}

export async function findSession(
  db: Queryable,
  token: string,
  ttlMs: number,
): Promise<SessionRecord | null> {
  const tokenHash = hashToken(token);
  const { rows } = await db.query<SessionJoinRow>(
    `select u.*, s.token_hash, s.csrf_token, s.expires_at, s.last_seen_at
     from sessions s join users u on u.id = s.user_id
     where s.token_hash = $1 and s.expires_at > now()`,
    [tokenHash],
  );
  const row = rows[0];
  if (!row) return null;
  let expiresAt = new Date(row.expires_at);
  if (Date.now() - new Date(row.last_seen_at).getTime() > REFRESH_AFTER_MS) {
    expiresAt = new Date(Date.now() + ttlMs);
    await db.query(
      'update sessions set last_seen_at = now(), expires_at = $2 where token_hash = $1',
      [tokenHash, expiresAt],
    );
  }
  return { tokenHash, csrfToken: row.csrf_token, expiresAt, user: row };
}

export async function deleteSession(db: Queryable, tokenHash: string): Promise<void> {
  await db.query('delete from sessions where token_hash = $1', [tokenHash]);
}

export async function deleteUserSessions(db: Queryable, userId: string): Promise<void> {
  await db.query('delete from sessions where user_id = $1', [userId]);
}

export async function purgeExpiredSessions(db: Queryable): Promise<number> {
  const { rowCount } = await db.query('delete from sessions where expires_at <= now()');
  return rowCount;
}
