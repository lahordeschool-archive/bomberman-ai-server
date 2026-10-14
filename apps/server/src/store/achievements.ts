import type { Achievement } from '@bomberman/protocol';
import type { Queryable } from '../db/database.ts';
import { iso } from '../db/rows.ts';

export async function awardMatchAchievements(
  db: Queryable,
  userIds: string[],
): Promise<void> {
  for (const userId of new Set(userIds)) {
    const { rows } = await db.query<{ games: number; wins: number; kills: number }>(
      `select count(*)::int as games,
              count(*) filter (where p.placement = 1)::int as wins,
              coalesce(sum(p.kills), 0)::int as kills
       from match_participants p
       join matches m on m.id = p.match_id
       where p.user_id = $1 and m.status = 'completed' and m.kind in ('ranked', 'tournament')`,
      [userId],
    );
    const stats = rows[0] ?? { games: 0, wins: 0, kills: 0 };
    const earned = [
      stats.games >= 1 && 'first-match',
      stats.wins >= 1 && 'first-win',
      stats.games >= 25 && 'veteran',
      stats.kills >= 25 && 'demolition-expert',
    ].filter((slug): slug is string => Boolean(slug));
    if (earned.length) {
      await db.query(
        `insert into user_achievements (user_id, achievement_slug)
         select $1, unnest($2::text[]) on conflict do nothing`,
        [userId, earned],
      );
    }
  }
}

export async function listUserAchievements(
  db: Queryable,
  userId: string,
): Promise<Achievement[]> {
  const { rows } = await db.query<{
    slug: string;
    title: string;
    description: string;
    icon: string;
    earned_at: Date;
  }>(
    `select a.slug, a.title, a.description, a.icon, ua.earned_at
     from user_achievements ua join achievements a on a.slug = ua.achievement_slug
     where ua.user_id = $1 order by a.sort_order, ua.earned_at`,
    [userId],
  );
  return rows.map((row) => ({
    slug: row.slug,
    title: row.title,
    description: row.description,
    icon: row.icon,
    earnedAt: iso(row.earned_at),
  }));
}
