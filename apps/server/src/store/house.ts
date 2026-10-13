import { SAMPLE_BOTS } from '@bomberman/bot-sdk';
import type { Database } from '../db/database.ts';
import { addVersion, DEFAULT_RATING, sourceHash } from './bots.ts';

export const HOUSE_USERNAME = 'house';

export interface HouseBot {
  slug: string;
  botId: string;
  versionId: string;
  name: string;
  source: string;
}

/**
 * House bots are the public sample bots, owned by a system account that cannot log
 * in. They fill ranked matches when the queue is short and anchor the rating scale.
 */
export async function ensureHouseBots(db: Database): Promise<HouseBot[]> {
  return db.transaction(async (tx) => {
    const user = await tx.query<{ id: string }>(
      `insert into users (username, display_name, password_hash, is_house)
       values ($1, 'House', '!', true)
       on conflict (username) do update set is_house = true
       returning id`,
      [HOUSE_USERNAME],
    );
    const ownerId = user.rows[0]!.id;
    const bots: HouseBot[] = [];
    for (const sample of SAMPLE_BOTS) {
      let bot = (
        await tx.query<{
          id: string;
          active_version_id: string | null;
          source_hash: string | null;
        }>(
          `select b.id, b.active_version_id, v.source_hash
           from bots b left join bot_versions v on v.id = b.active_version_id
           where b.owner_id = $1 and lower(b.name) = lower($2) and b.deleted_at is null`,
          [ownerId, sample.name],
        )
      ).rows[0];
      if (!bot) {
        const created = await tx.query<{ id: string }>(
          'insert into bots (owner_id, name) values ($1, $2) returning id',
          [ownerId, sample.name],
        );
        bot = { id: created.rows[0]!.id, active_version_id: null, source_hash: null };
      }
      let versionId = bot.active_version_id;
      if (!versionId || bot.source_hash !== sourceHash(sample.source)) {
        versionId = (await addVersion(tx, bot.id, sample.source, 'public')).id;
      }
      await tx.query(
        'insert into ratings (bot_id, rating) values ($1, $2) on conflict (bot_id) do nothing',
        [bot.id, DEFAULT_RATING],
      );
      bots.push({
        slug: sample.slug,
        botId: bot.id,
        versionId,
        name: sample.name,
        source: sample.source,
      });
    }
    return bots;
  });
}
