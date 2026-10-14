import { hashPassword } from '../auth/password.ts';
import type { Queryable } from '../db/database.ts';
import { isUniqueViolation } from '../db/rows.ts';

export type SharkeyBootstrapResult = {
  /** Present when a pre-existing player held the reserved username and was renamed. */
  relocatedUsername?: string;
};

/**
 * Reserves the built-in administrator identity. It remains unable to sign in until
 * SHARKEY_ADMIN_PASSWORD is supplied; the password is only applied to a disabled
 * account, so restarts never overwrite an administrator's changed password.
 *
 * If a player already claimed `sharkey` before the role was reserved, that account is
 * renamed (never promoted) so startup can proceed without bricking the site.
 */
export async function ensureSharkeyAdmin(
  db: Queryable,
  password?: string,
): Promise<SharkeyBootstrapResult> {
  const existing = await db.query<{ id: string; role: string }>(
    `select id, role from users where username = 'sharkey'`,
  );
  let relocatedUsername: string | undefined;
  if (existing.rows[0] && existing.rows[0].role !== 'admin') {
    relocatedUsername = await relocateConflictingUsername(db, existing.rows[0].id);
  }
  const passwordHash = password ? await hashPassword(password) : '!';
  await db.query(
    `insert into users (username, display_name, password_hash, role)
     values ('sharkey', 'Sharkey', $1, 'admin')
     on conflict (username) do update
       set password_hash = case when users.password_hash = '!' then excluded.password_hash else users.password_hash end
     where users.role = 'admin'`,
    [passwordHash],
  );
  return { relocatedUsername };
}

async function relocateConflictingUsername(db: Queryable, userId: string): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = attempt === 0 ? 'sharkey_legacy' : `sharkey_legacy_${attempt}`;
    try {
      const moved = await db.query<{ username: string }>(
        `update users
         set username = $2,
             display_name = case when display_name = 'sharkey' then $2 else display_name end
         where id = $1 and username = 'sharkey' and role <> 'admin'
         returning username`,
        [userId, candidate],
      );
      if (moved.rows[0]) return moved.rows[0].username;
      const current = await db.query<{ username: string }>(
        `select username from users where id = $1`,
        [userId],
      );
      if (current.rows[0] && current.rows[0].username !== 'sharkey') {
        return current.rows[0].username;
      }
    } catch (error) {
      if (isUniqueViolation(error)) continue;
      throw error;
    }
  }
  throw new Error(
    'Cannot bootstrap Sharkey: that username belonged to a player and no free legacy name was available.',
  );
}
