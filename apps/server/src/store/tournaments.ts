import type {
  TournamentDetail,
  TournamentStanding,
  TournamentSummary,
} from '@bomberman/protocol';
import type { Queryable } from '../db/database.ts';
import { iso } from '../db/rows.ts';

interface TournamentRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  starts_at: Date;
  ends_at: Date;
  cancelled_at: Date | null;
  entrants: number;
}

function stateOf(row: TournamentRow): TournamentSummary['state'] {
  if (row.cancelled_at) return 'cancelled';
  const now = Date.now();
  if (new Date(row.starts_at).getTime() > now) return 'upcoming';
  return new Date(row.ends_at).getTime() > now ? 'active' : 'finished';
}

function summary(row: TournamentRow): TournamentSummary {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    startsAt: iso(row.starts_at),
    endsAt: iso(row.ends_at),
    state: stateOf(row),
    entrants: row.entrants,
  };
}

const SELECT = `select t.*,
  (select count(*)::int from tournament_registrations r where r.tournament_id = t.id) as entrants
  from tournaments t`;

export async function listTournaments(db: Queryable): Promise<TournamentSummary[]> {
  const { rows } = await db.query<TournamentRow>(`${SELECT} order by t.starts_at desc`);
  return rows.map(summary);
}

export async function getTournament(
  db: Queryable,
  slug: string,
): Promise<TournamentDetail | null> {
  const result = await db.query<TournamentRow>(`${SELECT} where t.slug = $1`, [slug]);
  const tournament = result.rows[0];
  if (!tournament) return null;
  const standings = await db.query<{
    bot_id: string;
    bot_name: string;
    username: string;
    display_name: string;
    games: number;
    wins: number;
    points: number;
    active_version: number;
  }>(
    `select r.bot_id, b.name as bot_name, u.username, u.display_name, r.games, r.wins, r.points,
            coalesce(v.version, 0)::int as active_version
     from tournament_registrations r
     join bots b on b.id = r.bot_id
     join users u on u.id = r.user_id
     left join bot_versions v on v.id = b.active_version_id
     where r.tournament_id = $1
     order by r.points desc, r.wins desc, r.games asc, r.registered_at asc`,
    [tournament.id],
  );
  return {
    ...summary(tournament),
    standings: standings.rows.map(
      (row, index): TournamentStanding => ({
        rank: index + 1,
        botId: row.bot_id,
        botName: row.bot_name,
        owner: { username: row.username, displayName: row.display_name },
        games: row.games,
        wins: row.wins,
        points: row.points,
        activeVersion: row.active_version,
      }),
    ),
  };
}

export async function createTournament(
  db: Queryable,
  input: {
    slug: string;
    name: string;
    description: string;
    startsAt: string;
    endsAt: string;
    createdBy: string;
  },
): Promise<void> {
  await db.query(
    `insert into tournaments (slug, name, description, starts_at, ends_at, created_by)
     values ($1, $2, $3, $4, $5, $6)`,
    [input.slug, input.name, input.description, input.startsAt, input.endsAt, input.createdBy],
  );
}

export async function cancelTournament(db: Queryable, id: string): Promise<void> {
  await db.query('update tournaments set cancelled_at = now() where id = $1', [id]);
}

export async function registerForTournament(
  db: Queryable,
  tournamentId: string,
  botId: string,
  userId: string,
): Promise<void> {
  await db.query(
    `insert into tournament_registrations (tournament_id, bot_id, user_id)
     values ($1, $2, $3)
     on conflict (tournament_id, bot_id) do nothing`,
    [tournamentId, botId, userId],
  );
}

export async function unregisterFromTournament(
  db: Queryable,
  tournamentId: string,
  userId: string,
): Promise<void> {
  await db.query(
    `delete from tournament_registrations
     where tournament_id = $1 and user_id = $2
       and exists (select 1 from tournaments where id = $1 and starts_at > now())`,
    [tournamentId, userId],
  );
}

export interface TournamentQueueEntry {
  tournamentId: string;
  botId: string;
  botName: string;
  ownerId: string;
  versionId: string;
  lastMatchedAt: string | null;
}

export async function activeTournamentQueue(
  db: Queryable,
): Promise<TournamentQueueEntry[]> {
  const { rows } = await db.query<{
    tournament_id: string;
    bot_id: string;
    name: string;
    owner_id: string;
    active_version_id: string;
    last_matched_at: Date | null;
  }>(
    `select r.tournament_id, r.bot_id, b.name, b.owner_id, b.active_version_id, r.last_matched_at
     from tournament_registrations r
     join tournaments t on t.id = r.tournament_id
       and t.cancelled_at is null and t.starts_at <= now() and t.ends_at > now()
     join bots b on b.id = r.bot_id and b.deleted_at is null and b.active_version_id is not null
     order by r.games asc, r.last_matched_at asc nulls first, r.registered_at asc`,
  );
  return rows.map((row) => ({
    tournamentId: row.tournament_id,
    botId: row.bot_id,
    botName: row.name,
    ownerId: row.owner_id,
    versionId: row.active_version_id,
    lastMatchedAt: row.last_matched_at ? iso(row.last_matched_at) : null,
  }));
}

export async function markTournamentMatched(
  db: Queryable,
  tournamentId: string,
  botIds: string[],
): Promise<void> {
  await db.query(
    `update tournament_registrations set last_matched_at = now()
     where tournament_id = $1 and bot_id = any($2::uuid[])`,
    [tournamentId, botIds],
  );
}
