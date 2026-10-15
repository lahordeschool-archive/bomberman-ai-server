import { purchaseSkinBody } from '@bomberman/protocol';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../context.ts';
import { getSkinStore, purchaseSkin } from '../../store/skins.ts';
import { HttpError } from '../errors.ts';
import { requireUser } from '../session-plugin.ts';

export function registerSkinRoutes(app: FastifyInstance, context: AppContext): void {
  app.get('/api/store', async (request) => {
    const session = requireUser(request);
    return getSkinStore(context.db, session.user.id);
  });

  app.post('/api/store/purchases', async (request, reply) => {
    const session = requireUser(request);
    const { skin } = purchaseSkinBody.parse(request.body);
    const result = await context.db.transaction((tx) => purchaseSkin(tx, session.user.id, skin));
    if (result === 'unknown')
      throw new HttpError(404, 'skin_not_found', 'That skin does not exist.');
    if (result === 'owned') throw new HttpError(409, 'skin_owned', 'You already own that skin.');
    if (result === 'insufficient')
      throw new HttpError(409, 'insufficient_coins', 'You do not have enough coins for that skin.');
    reply.status(201);
    return getSkinStore(context.db, session.user.id);
  });
}
