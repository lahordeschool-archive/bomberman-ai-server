import type { LeaderboardEntry } from '@bomberman/protocol';
import type { Queryable } from '../db/database.ts';

/** Only bots with at least one server-completed ranked match appear on the ladder. */
export async function getLeaderboard(
  db: Queryable,
  limit: number,
  offset: number,
): Promise<{ entries: LeaderboardEntry[]; total: number }> {
  const from = `from ratings r
    join bots b on b.id = r.bot_id and b.deleted_at is null
    join users u on u.id = b.owner_id
    where r.games > 0`;
  const total = await db.query<{ count: number }>(`select count(*)::int as count ${from}`);
  const { rows } = await db.query<{
    bot_id: string;
    name: string;
    username: string;
    display_name: string;
    is_house: boolean;
    rating: number;
    games: number;
    wins: number;
  }>(
    `select r.bot_id, b.name, u.username, u.display_name, u.is_house, r.rating, r.games, r.wins
     ${from}
     order by r.rating desc, r.games desc, b.created_at asc
     limit $1 offset $2`,
    [limit, offset],
  );
  return {
    total: total.rows[0]?.count ?? 0,
    entries: rows.map((row, index) => ({
      rank: offset + index + 1,
      botId: row.bot_id,
      botName: row.name,
      owner: { username: row.username, displayName: row.display_name, isHouse: row.is_house },
      rating: row.rating,
      games: row.games,
      wins: row.wins,
    })),
  };
}
