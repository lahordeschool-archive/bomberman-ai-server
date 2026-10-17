import { createHash } from 'node:crypto';
import type { Queryable } from '../db/database.ts';

export type IntegrityWarningKind =
  'source_similarity' | 'win_association' | 'repeated_avoidable_death';

export interface IntegrityWarning {
  id: string;
  kind: IntegrityWarningKind;
  severity: 'medium' | 'high';
  detail: Record<string, unknown>;
  occurrences: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

const SOURCE_SIMILARITY_THRESHOLD = 0.9;
const MIN_SOURCE_SHINGLES = 25;
const MIN_ASSOCIATION_MATCHES = 4;
const ASSOCIATION_RATE_GAP = 0.5;
const RECENT_MATCH_LIMIT = 40;
const REPEATED_DEATH_THRESHOLD = 3;

function sourceTokens(source: string): string[] {
  const tokens: string[] = [];
  const pattern =
    /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[A-Za-z_$][\w$]*|\d+(?:\.\d+)?|===|!==|=>|==|!=|<=|>=|&&|\|\||\+\+|--|[^\s]/g;
  for (const match of source.matchAll(pattern)) {
    const token = match[0]!;
    if (token.startsWith('//') || token.startsWith('/*')) continue;
    tokens.push(/^["'`]/.test(token) ? '<string>' : token);
  }
  return tokens;
}

function shingles(source: string, width = 7): Set<string> {
  const tokens = sourceTokens(source);
  const result = new Set<string>();
  for (let index = 0; index <= tokens.length - width; index++) {
    result.add(tokens.slice(index, index + width).join('\u0000'));
  }
  return result;
}

/** Copy-containment score: 1 means the smaller source is entirely present in the larger one. */
export function sourceSimilarity(left: string, right: string): number {
  const a = shingles(left);
  const b = shingles(right);
  if (a.size < MIN_SOURCE_SHINGLES || b.size < MIN_SOURCE_SHINGLES) return 0;
  let common = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const value of small) if (large.has(value)) common++;
  return common / small.size;
}

async function upsertWarning(
  db: Queryable,
  warning: {
    kind: IntegrityWarningKind;
    fingerprint: string;
    severity: 'medium' | 'high';
    detail: Record<string, unknown>;
  },
): Promise<void> {
  await db.query(
    `insert into integrity_warnings (kind, fingerprint, severity, detail)
     values ($1, $2, $3, $4)
     on conflict (fingerprint) do update
       set severity = excluded.severity, detail = excluded.detail,
           occurrences = integrity_warnings.occurrences + 1, last_seen_at = now()`,
    [warning.kind, warning.fingerprint, warning.severity, JSON.stringify(warning.detail)],
  );
}

function pairFingerprint(kind: IntegrityWarningKind, left: string, right: string): string {
  const pair = [left, right].sort().join(':');
  return `${kind}:${createHash('sha256').update(pair).digest('hex')}`;
}

function directedFingerprint(
  kind: Exclude<IntegrityWarningKind, 'source_similarity'>,
  subject: string,
  counterpart: string,
): string {
  return `${kind}:${createHash('sha256').update(`${subject}:${counterpart}`).digest('hex')}`;
}

/** Compares a submitted version with active versions owned by other accounts. */
export async function inspectSourceSimilarity(
  db: Queryable,
  input: {
    botId: string;
    versionId: string;
    ownerId: string;
    source: string;
  },
): Promise<void> {
  const { rows } = await db.query<{
    bot_id: string;
    version_id: string;
    owner_id: string;
    username: string;
    bot_name: string;
    source: string;
  }>(
    `select b.id as bot_id, v.id as version_id, b.owner_id, u.username, b.name as bot_name, v.source
     from bots b
     join users u on u.id = b.owner_id
     join bot_versions v on v.id = b.active_version_id
     where b.deleted_at is null and not u.is_house and b.owner_id <> $1 and b.id <> $2`,
    [input.ownerId, input.botId],
  );
  for (const candidate of rows) {
    const similarity = sourceSimilarity(input.source, candidate.source);
    if (similarity < SOURCE_SIMILARITY_THRESHOLD) continue;
    await upsertWarning(db, {
      kind: 'source_similarity',
      fingerprint: pairFingerprint('source_similarity', input.botId, candidate.bot_id),
      severity: similarity >= 0.98 ? 'high' : 'medium',
      detail: {
        similarity: Number(similarity.toFixed(3)),
        botIds: [input.botId, candidate.bot_id],
        versionIds: [input.versionId, candidate.version_id],
        otherOwnerId: candidate.owner_id,
        otherUsername: candidate.username,
        otherBotName: candidate.bot_name,
      },
    });
  }
}

interface MatchParticipantRow {
  match_id: string;
  bot_id: string;
  user_id: string;
  username: string;
  bot_name: string;
  placement: number;
}

async function inspectWinAssociations(db: Queryable, matchId: string): Promise<void> {
  const current = await db.query<MatchParticipantRow>(
    `select p.match_id, p.bot_id, p.user_id, u.username, p.bot_name, p.placement
     from match_participants p join users u on u.id = p.user_id
     where p.match_id = $1 and p.kind = 'ranked' and p.bot_id is not null`,
    [matchId],
  );
  for (const subject of current.rows) {
    const history = await db.query<MatchParticipantRow>(
      `select p.match_id, p.bot_id, p.user_id, u.username, p.bot_name, p.placement
       from match_participants p
       join users u on u.id = p.user_id
       where p.match_id in (
         select m.id from matches m join match_participants own on own.match_id = m.id
         where m.status = 'completed' and m.rated and own.bot_id = $1
         order by m.ended_at desc limit $2
       ) and p.bot_id is not null`,
      [subject.bot_id, RECENT_MATCH_LIMIT],
    );
    const matches = new Map<string, MatchParticipantRow[]>();
    for (const row of history.rows) {
      const participants = matches.get(row.match_id) ?? [];
      participants.push(row);
      matches.set(row.match_id, participants);
    }
    const candidates = new Map<string, MatchParticipantRow>();
    for (const participants of matches.values()) {
      for (const row of participants) {
        if (row.user_id !== subject.user_id) candidates.set(row.bot_id, row);
      }
    }
    for (const candidate of candidates.values()) {
      let withCount = 0;
      let withWins = 0;
      let withoutCount = 0;
      let withoutWins = 0;
      for (const participants of matches.values()) {
        const own = participants.find((row) => row.bot_id === subject.bot_id);
        if (!own) continue;
        if (participants.some((row) => row.bot_id === candidate.bot_id)) {
          withCount++;
          if (own.placement === 1) withWins++;
        } else {
          withoutCount++;
          if (own.placement === 1) withoutWins++;
        }
      }
      if (withCount < MIN_ASSOCIATION_MATCHES || withoutCount < MIN_ASSOCIATION_MATCHES) continue;
      const withRate = withWins / withCount;
      const withoutRate = withoutWins / withoutCount;
      if (withRate < 0.75 || withRate - withoutRate < ASSOCIATION_RATE_GAP) continue;
      await upsertWarning(db, {
        kind: 'win_association',
        fingerprint: directedFingerprint('win_association', subject.bot_id, candidate.bot_id),
        severity: withRate - withoutRate >= 0.75 ? 'high' : 'medium',
        detail: {
          subjectBotId: subject.bot_id,
          subjectBotName: subject.bot_name,
          subjectUsername: subject.username,
          associatedBotId: candidate.bot_id,
          associatedBotName: candidate.bot_name,
          associatedUsername: candidate.username,
          with: { matches: withCount, wins: withWins, rate: Number(withRate.toFixed(3)) },
          without: {
            matches: withoutCount,
            wins: withoutWins,
            rate: Number(withoutRate.toFixed(3)),
          },
        },
      });
    }
  }
}

async function inspectRepeatedDeaths(db: Queryable, matchId: string): Promise<void> {
  const pairs = await db.query<{
    victim_bot_id: string;
    victim_name: string;
    victim_username: string;
    killer_bot_id: string;
    killer_name: string;
    killer_username: string;
  }>(
    `select victim.bot_id as victim_bot_id, victim.bot_name as victim_name,
            victim_user.username as victim_username,
            killer.bot_id as killer_bot_id, killer.bot_name as killer_name,
            killer_user.username as killer_username
     from match_participants victim
     join match_participants killer
       on killer.match_id = victim.match_id and killer.slot = victim.killed_by_slot
     join users victim_user on victim_user.id = victim.user_id
     join users killer_user on killer_user.id = killer.user_id
     where victim.match_id = $1 and victim.escape_available
       and victim.bot_id is not null and killer.bot_id is not null
       and victim.user_id <> killer.user_id`,
    [matchId],
  );
  for (const pair of pairs.rows) {
    const history = await db.query<{ match_id: string }>(
      `select victim.match_id
       from match_participants victim
       join matches m on m.id = victim.match_id
       join match_participants killer
         on killer.match_id = victim.match_id and killer.slot = victim.killed_by_slot
       where m.status = 'completed' and m.rated and victim.bot_id = $1
         and killer.bot_id = $2 and victim.escape_available
       order by m.ended_at desc limit 20`,
      [pair.victim_bot_id, pair.killer_bot_id],
    );
    if (history.rows.length < REPEATED_DEATH_THRESHOLD) continue;
    await upsertWarning(db, {
      kind: 'repeated_avoidable_death',
      fingerprint: directedFingerprint(
        'repeated_avoidable_death',
        pair.victim_bot_id,
        pair.killer_bot_id,
      ),
      severity: history.rows.length >= 5 ? 'high' : 'medium',
      detail: {
        victimBotId: pair.victim_bot_id,
        victimBotName: pair.victim_name,
        victimUsername: pair.victim_username,
        killerBotId: pair.killer_bot_id,
        killerBotName: pair.killer_name,
        killerUsername: pair.killer_username,
        avoidableDeaths: history.rows.length,
        matchIds: history.rows.map((row) => row.match_id),
      },
    });
  }
}

export async function inspectCompletedMatch(db: Queryable, matchId: string): Promise<void> {
  await inspectRepeatedDeaths(db, matchId);
  await inspectWinAssociations(db, matchId);
}

export async function listIntegrityWarnings(
  db: Queryable,
  limit = 100,
): Promise<IntegrityWarning[]> {
  const { rows } = await db.query<{
    id: string;
    kind: IntegrityWarningKind;
    severity: 'medium' | 'high';
    detail: Record<string, unknown> | string;
    occurrences: number;
    first_seen_at: Date;
    last_seen_at: Date;
  }>(
    `select id::text, kind, severity, detail, occurrences, first_seen_at, last_seen_at
     from integrity_warnings order by last_seen_at desc limit $1`,
    [limit],
  );
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    severity: row.severity,
    detail: typeof row.detail === 'string' ? JSON.parse(row.detail) : row.detail,
    occurrences: row.occurrences,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  }));
}
