import {
  createTournamentBody,
  idParam,
  type AdminOverview,
  updateRoleBody,
} from '@bomberman/protocol';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.ts';
import { iso } from '../../db/rows.ts';
import { getMatchSummary, listMatches } from '../../store/matches.ts';
import {
  cancelTournament,
  createTournament,
  getTournament,
} from '../../store/tournaments.ts';
import {
  findUserById,
  recordAudit,
  toPublicUser,
  updateUserRole,
  type UserRow,
} from '../../store/users.ts';
import { HttpError, notFound } from '../errors.ts';
import { requireRole } from '../session-plugin.ts';

const tournamentIdParam = z.object({ id: z.uuid() });

export function registerAdminRoutes(app: FastifyInstance, context: AppContext): void {
  const { db } = context;

  app.get('/api/admin', async (request): Promise<AdminOverview> => {
    requireRole(request, 'moderator');
    const [counts, users, audit, live] = await Promise.all([
      db.query<{ users: number; bots: number; live_matches: number; tournaments: number }>(
        `select
          (select count(*)::int from users where not is_house) as users,
          (select count(*)::int from bots where deleted_at is null) as bots,
          (select count(*)::int from matches where status = 'running') as live_matches,
          (select count(*)::int from tournaments) as tournaments`,
      ),
      db.query<UserRow>('select * from users where not is_house order by created_at desc limit 100'),
      db.query<{
        id: string;
        actor: string | null;
        action: string;
        detail: Record<string, unknown> | null;
        created_at: Date;
      }>(
        `select a.id::text, u.username as actor, a.action, a.detail, a.created_at
         from audit_log a left join users u on u.id = a.user_id
         order by a.created_at desc limit 50`,
      ),
      listMatches(db, { status: 'running', limit: 50, offset: 0 }),
    ]);
    const count = counts.rows[0] ?? { users: 0, bots: 0, live_matches: 0, tournaments: 0 };
    return {
      counts: {
        users: count.users,
        bots: count.bots,
        liveMatches: count.live_matches,
        tournaments: count.tournaments,
      },
      users: users.rows.map(toPublicUser),
      audit: audit.rows.map((row) => ({
        id: row.id,
        actor: row.actor,
        action: row.action,
        detail: row.detail,
        createdAt: iso(row.created_at),
      })),
      liveMatches: live.matches,
    };
  });

  app.post('/api/admin/matches/:id/cancel', async (request) => {
    const session = requireRole(request, 'moderator');
    const { id } = idParam.parse(request.params);
    const match = await getMatchSummary(db, id);
    if (!match) throw notFound('That match');
    if (match.status !== 'running' || !(await context.cancelMatch?.(id))) {
      throw new HttpError(409, 'match_not_running', 'That match is no longer running.');
    }
    await recordAudit(db, {
      userId: session.user.id,
      action: 'admin_match_cancelled',
      ip: request.ip,
      detail: { matchId: id },
    });
    return { ok: true };
  });

  app.patch('/api/admin/users/:id/role', async (request) => {
    const session = requireRole(request, 'admin');
    const { id } = idParam.parse(request.params);
    const { role } = updateRoleBody.parse(request.body);
    const user = await findUserById(db, id);
    if (!user || user.is_house) throw notFound('That user');
    if (id === session.user.id && role !== 'admin') {
      throw new HttpError(409, 'self_demote', 'You cannot remove your own admin role.');
    }
    await updateUserRole(db, id, role);
    await recordAudit(db, {
      userId: session.user.id,
      action: 'admin_role_changed',
      ip: request.ip,
      detail: { targetUserId: id, role },
    });
    return toPublicUser({ ...user, role });
  });

  app.post('/api/admin/tournaments', async (request, reply) => {
    const session = requireRole(request, 'admin');
    const body = createTournamentBody.parse(request.body);
    await createTournament(db, { ...body, createdBy: session.user.id });
    await recordAudit(db, {
      userId: session.user.id,
      action: 'admin_tournament_created',
      ip: request.ip,
      detail: { slug: body.slug },
    });
    reply.status(201);
    return getTournament(db, body.slug);
  });

  app.post('/api/admin/tournaments/:id/cancel', async (request, reply) => {
    const session = requireRole(request, 'admin');
    const { id } = tournamentIdParam.parse(request.params);
    await cancelTournament(db, id);
    await recordAudit(db, {
      userId: session.user.id,
      action: 'admin_tournament_cancelled',
      ip: request.ip,
      detail: { tournamentId: id },
    });
    context.nudgeMatchmaker?.();
    return reply.status(204).send();
  });
}
