import {
  createBotBody,
  equipSkinBody,
  idParam,
  isSkinSlug,
  type RankedStatus,
  submitVersionBody,
  updateBotBody,
  versionParam,
} from '@bomberman/protocol';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from '../../context.ts';
import { isUniqueViolation } from '../../db/rows.ts';
import {
  addVersion,
  countBotsByOwner,
  createBot,
  deleteBot,
  dequeueBot,
  enqueueBot,
  getBot,
  getBotDetail,
  getVersion,
  listBotsByOwner,
  listQueue,
  renameBot,
  toVersionDetail,
} from '../../store/bots.ts';
import { listMatches } from '../../store/matches.ts';
import { recordAudit } from '../../store/users.ts';
import { ownsSkin, setBotSkin } from '../../store/skins.ts';
import { forbidden, HttpError, notFound } from '../errors.ts';
import { requireUser } from '../session-plugin.ts';

const nameTaken = () => new HttpError(409, 'name_taken', 'You already have a bot with that name.');

export async function rankedStatus(context: AppContext): Promise<RankedStatus> {
  const [queue, live] = await Promise.all([
    listQueue(context.db, 100),
    listMatches(context.db, { status: 'running', limit: 20, offset: 0 }),
  ]);
  return {
    queue: queue.map((entry) => ({
      botId: entry.botId,
      botName: entry.botName,
      enqueuedAt: entry.enqueuedAt,
    })),
    queueLength: queue.length,
    liveMatches: live.matches.filter((match) => match.kind === 'ranked'),
  };
}

export function registerBotRoutes(app: FastifyInstance, context: AppContext): void {
  const { db } = context;

  async function ownedBot(request: FastifyRequest) {
    const session = requireUser(request);
    const { id } = idParam.parse(request.params);
    const bot = await getBot(db, id);
    if (!bot) throw notFound('That bot');
    if (bot.ownerId !== session.user.id) throw forbidden('Only the owner can change this bot.');
    return { session, bot };
  }

  app.get('/api/bots', async (request) => {
    const session = requireUser(request);
    return { bots: await listBotsByOwner(db, session.user.id) };
  });

  app.post('/api/bots', async (request, reply) => {
    const session = requireUser(request);
    const { name } = createBotBody.parse(request.body);
    if ((await countBotsByOwner(db, session.user.id)) >= context.config.maxBotsPerUser) {
      throw new HttpError(
        409,
        'bot_limit',
        `You can have up to ${context.config.maxBotsPerUser} bots.`,
      );
    }
    let id: string;
    try {
      id = await createBot(db, session.user.id, name);
    } catch (error) {
      if (isUniqueViolation(error)) throw nameTaken();
      throw error;
    }
    reply.status(201);
    return getBotDetail(db, id);
  });

  app.get('/api/bots/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    const bot = await getBotDetail(db, id);
    if (!bot) throw notFound('That bot');
    const { ownerId: _ownerId, ...detail } = bot;
    return detail;
  });

  app.patch('/api/bots/:id', async (request) => {
    const { bot } = await ownedBot(request);
    const { name } = updateBotBody.parse(request.body);
    try {
      await renameBot(db, bot.id, name);
    } catch (error) {
      if (isUniqueViolation(error)) throw nameTaken();
      throw error;
    }
    const { ownerId: _ownerId, ...detail } = (await getBotDetail(db, bot.id))!;
    return detail;
  });

  app.put('/api/bots/:id/skin', async (request) => {
    const { session, bot } = await ownedBot(request);
    const { skin } = equipSkinBody.parse(request.body);
    if (skin !== null && (!isSkinSlug(skin) || !(await ownsSkin(db, session.user.id, skin)))) {
      throw new HttpError(403, 'skin_not_owned', 'Buy this skin before equipping it.');
    }
    await setBotSkin(db, bot.id, skin);
    const { ownerId: _ownerId, ...detail } = (await getBotDetail(db, bot.id))!;
    return detail;
  });

  app.delete('/api/bots/:id', async (request, reply) => {
    const { session, bot } = await ownedBot(request);
    await db.transaction((tx) => deleteBot(tx, bot.id));
    await recordAudit(db, {
      userId: session.user.id,
      action: 'bot_deleted',
      ip: request.ip,
      detail: { botId: bot.id },
    });
    return reply.status(204).send();
  });

  app.get('/api/bots/:id/versions/:versionId', async (request) => {
    const { id, versionId } = versionParam.parse(request.params);
    const bot = await getBot(db, id);
    if (!bot) throw notFound('That bot');
    const version = await getVersion(db, id, versionId);
    if (!version) throw notFound('That version');
    const isOwner = request.session?.user.id === bot.ownerId;
    return toVersionDetail(version, isOwner || version.visibility === 'public');
  });

  app.post(
    '/api/bots/:id/versions',
    {
      bodyLimit: 128 * 1024,
      config: { rateLimit: { max: 30, timeWindow: '1 hour' } },
    },
    async (request, reply) => {
      const { session, bot } = await ownedBot(request);
      const { source, visibility, label, ranked } = submitVersionBody.parse(request.body);
      const validation = await context.executor.validate(source);
      if (!validation.ok) {
        throw new HttpError(
          422,
          'bot_invalid',
          `The sandbox rejected this version: ${validation.error}`,
        );
      }
      const version = await db.transaction(async (tx) => {
        const saved = await addVersion(tx, bot.id, source, visibility, label);
        if (ranked) await enqueueBot(tx, bot.id);
        return saved;
      });
      if (ranked) context.nudgeMatchmaker?.();
      await recordAudit(db, {
        userId: session.user.id,
        action: 'bot_version_submitted',
        ip: request.ip,
        detail: { botId: bot.id, version: version.version, sourceHash: version.source_hash },
      });
      reply.status(201);
      return toVersionDetail(version, true);
    },
  );

  app.post('/api/bots/:id/ranked', async (request) => {
    const { bot } = await ownedBot(request);
    if (!bot.activeVersion) {
      throw new HttpError(
        409,
        'no_version',
        'Save a version of this bot before joining the ranked queue.',
      );
    }
    await enqueueBot(db, bot.id);
    context.nudgeMatchmaker?.();
    return rankedStatus(context);
  });

  app.delete('/api/bots/:id/ranked', async (request) => {
    const { bot } = await ownedBot(request);
    await dequeueBot(db, bot.id);
    return rankedStatus(context);
  });

  app.get('/api/ranked/status', () => rankedStatus(context));
}
