import type { PublicUser, UserRole } from '@bomberman/protocol';
import type { Queryable } from '../db/database.ts';
import { iso } from '../db/rows.ts';

export const DEPLOY_CHECK_USERNAME = 'deploycheck';

export interface UserRow {
  id: string;
  username: string;
  display_name: string;
  email: string | null;
  password_hash: string;
  is_house: boolean;
  ranked_eligible: boolean;
  role: UserRole;
  created_at: Date;
}

export function toPublicUser(row: UserRow, options?: { includeEmail?: boolean }): PublicUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    ...(options?.includeEmail ? { email: row.email } : {}),
    createdAt: iso(row.created_at),
    role: row.role,
  };
}

export async function createUser(
  db: Queryable,
  input: {
    username: string;
    displayName: string;
    email: string;
    passwordHash: string;
    isHouse?: boolean;
    rankedEligible?: boolean;
  },
): Promise<UserRow> {
  const { rows } = await db.query<UserRow>(
    `insert into users
       (username, display_name, email, password_hash, is_house, ranked_eligible)
     values ($1, $2, $3, $4, $5, $6) returning *`,
    [
      input.username,
      input.displayName,
      input.email,
      input.passwordHash,
      input.isHouse ?? false,
      input.rankedEligible ?? true,
    ],
  );
  return rows[0]!;
}

export async function findUserByUsername(db: Queryable, username: string): Promise<UserRow | null> {
  const { rows } = await db.query<UserRow>('select * from users where username = $1', [username]);
  return rows[0] ?? null;
}

export async function findUserById(db: Queryable, id: string): Promise<UserRow | null> {
  const { rows } = await db.query<UserRow>('select * from users where id = $1', [id]);
  return rows[0] ?? null;
}

export async function updatePasswordHash(
  db: Queryable,
  userId: string,
  passwordHash: string,
): Promise<void> {
  await db.query('update users set password_hash = $2, password_changed_at = now() where id = $1', [
    userId,
    passwordHash,
  ]);
}

export async function updateUserRole(db: Queryable, userId: string, role: UserRole): Promise<void> {
  await db.query('update users set role = $2 where id = $1 and not is_house', [userId, role]);
}

export async function recordAudit(
  db: Queryable,
  entry: {
    userId: string | null;
    action: string;
    ip?: string | null;
    detail?: Record<string, unknown>;
  },
): Promise<void> {
  await db.query('insert into audit_log (user_id, action, ip, detail) values ($1, $2, $3, $4)', [
    entry.userId,
    entry.action,
    entry.ip ?? null,
    entry.detail ? JSON.stringify(entry.detail) : null,
  ]);
}
