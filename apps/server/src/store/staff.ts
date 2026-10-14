import { hashPassword } from '../auth/password.ts';
import type { Queryable } from '../db/database.ts';

/**
 * Reserves the built-in administrator identity. It remains unable to sign in until
 * SHARKEY_ADMIN_PASSWORD is supplied; the password is only applied to a disabled
 * account, so restarts never overwrite an administrator's changed password.
 */
export async function ensureSharkeyAdmin(db: Queryable, password?: string): Promise<void> {
  const existing = await db.query<{ role: string }>(
    `select role from users where username = 'sharkey'`,
  );
  if (existing.rows[0] && existing.rows[0].role !== 'admin') {
    throw new Error(
      'Cannot bootstrap Sharkey: that username belonged to a player before it was reserved.',
    );
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
}
