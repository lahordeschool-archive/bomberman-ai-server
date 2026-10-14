import { hashPassword } from '../auth/password.ts';
import type { Queryable } from '../db/database.ts';

/**
 * Reserves the built-in administrator identity. It remains unable to sign in until
 * SHARKEY_ADMIN_PASSWORD is supplied; the password is only applied to a disabled
 * account, so restarts never overwrite an administrator's changed password.
 */
export async function ensureSharkeyAdmin(
  db: Queryable,
  password?: string,
): Promise<void> {
  const passwordHash = password ? await hashPassword(password) : '!';
  await db.query(
    `insert into users (username, display_name, password_hash, role)
     values ('sharkey', 'Sharkey', $1, 'admin')
     on conflict (username) do update set role = 'admin',
       password_hash = case when users.password_hash = '!' then excluded.password_hash else users.password_hash end`,
    [passwordHash],
  );
}
