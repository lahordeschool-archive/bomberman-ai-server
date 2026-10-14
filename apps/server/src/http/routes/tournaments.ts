import { tournamentRegistrationBody, tournamentSlugParam } from '@bomberman/protocol';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../context.ts';
import { getBot } from '../../store/bots.ts';
import {
  getTournament,
  getUserTournamentBotId,
  listTournaments,
  registerForTournament,
  unregisterFromTournament,
} from '../../store/tournaments.ts';
import { recordAudit } from '../../store/users.ts';
import { forbidden, HttpError, notFound } from '../errors.ts';
import { requireUser } from '../session-plugin.ts';

export function registerTournamentRoutes(app: FastifyInstance, context: AppContext): void {
  const { db } = context;

  app.get('/api/tournaments', async () => ({ tournaments: await listTournaments(db) }));

  app.get('/api/tournaments/:slug', async (request) => {
    const { slug } = tournamentSlugParam.parse(request.params);
    const tournament = await getTournament(db, slug);
    if (!tournament) throw notFound('That tournament');
    return tournament;
  });

  app.post('/api/tournaments/:slug/registration', async (request) => {
    const session = requireUser(request);
    const { slug } = tournamentSlugParam.parse(request.params);
    const { botId } = tournamentRegistrationBody.parse(request.body);
    const [tournament, bot] = await Promise.all([getTournament(db, slug), getBot(db, botId)]);
    if (!tournament) throw notFound('That tournament');
    if (!bot) throw notFound('That bot');
    if (bot.ownerId !== session.user.id) throw forbidden('Only the bot owner can register it.');
    if (!bot.activeVersion) {
      throw new HttpError(409, 'no_version', 'Save a bot version before registering.');
    }
    await db.transaction(async (tx) => {
      const locked = await tx.query<{
        starts_at: Date;
        ends_at: Date;
        cancelled_at: Date | null;
      }>(`select starts_at, ends_at, cancelled_at from tournaments where id = $1 for update`, [
        tournament.id,
      ]);
      const row = locked.rows[0]!;
      const now = Date.now();
      const active =
        new Date(row.starts_at).getTime() <= now && new Date(row.ends_at).getTime() > now;
      if (row.cancelled_at || new Date(row.ends_at).getTime() <= now) {
        throw new HttpError(409, 'tournament_closed', 'Registration is closed.');
      }
      const registeredBotId = await getUserTournamentBotId(tx, tournament.id, session.user.id);
      if (registeredBotId && registeredBotId !== bot.id && active) {
        throw new HttpError(
          409,
          'entry_locked',
          'The participating bot cannot be changed after the tournament starts.',
        );
      }
      if (!active) await unregisterFromTournament(tx, tournament.id, session.user.id);
      await registerForTournament(tx, tournament.id, bot.id, session.user.id);
    });
    await recordAudit(db, {
      userId: session.user.id,
      action: 'tournament_registered',
      ip: request.ip,
      detail: { tournamentId: tournament.id, botId: bot.id },
    });
    context.nudgeMatchmaker?.();
    return getTournament(db, slug);
  });

  app.delete('/api/tournaments/:slug/registration', async (request, reply) => {
    const session = requireUser(request);
    const { slug } = tournamentSlugParam.parse(request.params);
    const tournament = await getTournament(db, slug);
    if (!tournament) throw notFound('That tournament');
    await unregisterFromTournament(db, tournament.id, session.user.id);
    return reply.status(204).send();
  });
}
