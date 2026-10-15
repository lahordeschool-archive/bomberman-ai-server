import {
  COINS_PER_ELO,
  getSkin,
  isSkinSlug,
  SKINS,
  type SkinSlug,
  type SkinStore,
} from '@bomberman/protocol';
import type { Queryable } from '../db/database.ts';

interface WalletRow {
  balance: number;
  earned: number;
}

export async function getSkinStore(db: Queryable, userId: string): Promise<SkinStore> {
  const [wallet, owned] = await Promise.all([
    db.query<WalletRow>('select balance, earned from user_wallets where user_id = $1', [userId]),
    db.query<{ skin_slug: string }>(
      'select skin_slug from user_skins where user_id = $1 order by purchased_at',
      [userId],
    ),
  ]);
  return {
    balance: wallet.rows[0]?.balance ?? 0,
    earned: wallet.rows[0]?.earned ?? 0,
    owned: owned.rows.map((row) => row.skin_slug).filter(isSkinSlug),
    skins: SKINS,
  };
}

export async function purchaseSkin(
  tx: Queryable,
  userId: string,
  slug: string,
): Promise<'ok' | 'unknown' | 'owned' | 'insufficient'> {
  const skin = getSkin(slug);
  if (!skin) return 'unknown';
  await tx.query(
    'insert into user_wallets (user_id) values ($1) on conflict (user_id) do nothing',
    [userId],
  );
  const wallet = await tx.query<WalletRow>(
    'select balance, earned from user_wallets where user_id = $1 for update',
    [userId],
  );
  const owned = await tx.query('select 1 from user_skins where user_id = $1 and skin_slug = $2', [
    userId,
    slug,
  ]);
  if (owned.rowCount > 0) return 'owned';
  if (wallet.rows[0]!.balance < skin.price) return 'insufficient';
  await tx.query(`insert into user_skins (user_id, skin_slug, price_paid) values ($1, $2, $3)`, [
    userId,
    slug,
    skin.price,
  ]);
  await tx.query(
    'update user_wallets set balance = balance - $2, updated_at = now() where user_id = $1',
    [userId, skin.price],
  );
  return 'ok';
}

export async function ownsSkin(db: Queryable, userId: string, slug: string): Promise<boolean> {
  if (!isSkinSlug(slug)) return false;
  const result = await db.query('select 1 from user_skins where user_id = $1 and skin_slug = $2', [
    userId,
    slug,
  ]);
  return result.rowCount > 0;
}

/** Awards spendable coins once per player and ranked match. */
export async function awardPositiveElo(
  tx: Queryable,
  userId: string,
  matchId: string,
  positiveElo: number,
): Promise<number> {
  const amount = Math.max(0, Math.round(positiveElo * COINS_PER_ELO));
  if (amount === 0) return 0;
  const inserted = await tx.query(
    `insert into currency_awards (user_id, match_id, amount)
     values ($1, $2, $3) on conflict (user_id, match_id) do nothing returning amount`,
    [userId, matchId, amount],
  );
  if (inserted.rowCount === 0) return 0;
  await tx.query(
    `insert into user_wallets (user_id, balance, earned) values ($1, $2, $2)
     on conflict (user_id) do update
       set balance = user_wallets.balance + excluded.balance,
           earned = user_wallets.earned + excluded.earned,
           updated_at = now()`,
    [userId, amount],
  );
  return amount;
}

export async function setBotSkin(
  db: Queryable,
  botId: string,
  skin: SkinSlug | null,
): Promise<void> {
  await db.query('update bots set skin_slug = $2, updated_at = now() where id = $1', [botId, skin]);
}
