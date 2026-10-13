import { idParam, matchListQuery, normalizeUsername, paginationQuery } from '@bomberman/protocol';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.ts';
import { listBotsByOwner } from '../../store/bots.ts';
import { getLeaderboard } from '../../store/leaderboard.ts';
import { getMatchSummary, getReplay, listMatches } from '../../store/matches.ts';
import { findUserByUsername, toPublicUser } from '../../store/users.ts';
import { notFound } from '../errors.ts';

const usernameParam = z.object({ username: z.string().max(64).transform(normalizeUsername) });

export function registerPublicRoutes(app: FastifyInstance, context: AppContext): void {
  const { db } = context;

  app.get('/api/leaderboard', async (request) => {
    const { limit, offset } = paginationQuery.parse(request.query);
    return getLeaderboard(db, limit, offset);
  });

  app.get('/api/matches', async (request) => {
    const query = matchListQuery.parse(request.query);
    return listMatches(db, { ...query, status: 'completed' });
  });

  app.get('/api/matches/live', async () => {
    const { matches } = await listMatches(db, { status: 'running', limit: 50, offset: 0 });
    return { matches };
  });

  app.get('/api/matches/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    const match = await getMatchSummary(db, id);
    if (!match) throw notFound('That match');
    return match;
  });

  app.get('/api/matches/:id/replay', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const replay = await getReplay(db, id);
    if (!replay) throw notFound('That replay');
    void reply.header('cache-control', 'public, max-age=86400, immutable');
    return replay;
  });

  app.get('/api/users/:username', async (request) => {
    const { username } = usernameParam.parse(request.params);
    const user = await findUserByUsername(db, username);
    if (!user) throw notFound('That player');
    return { user: toPublicUser(user), bots: await listBotsByOwner(db, user.id) };
  });
}
