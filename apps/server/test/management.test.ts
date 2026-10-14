import { SAMPLE_BOTS } from '@bomberman/bot-sdk';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/context.ts';
import { ensureSharkeyAdmin } from '../src/store/staff.ts';
import { createTestApp, TestClient } from './helpers.ts';

let app: FastifyInstance;
let context: AppContext;
let admin: TestClient;

beforeAll(async () => {
  ({ app, context } = await createTestApp());
  await ensureSharkeyAdmin(context.db, 'sharkey secure password');
  admin = new TestClient(app);
  const login = await admin.request('POST', '/api/auth/login', {
    username: 'sharkey',
    password: 'sharkey secure password',
  });
  expect(login.status).toBe(200);
});

afterAll(async () => {
  await app.close();
  await context.db.close();
});

describe('management and tournaments', () => {
  it('reserves Sharkey and restricts management APIs', async () => {
    const player = new TestClient(app);
    expect(
      (
        await player.request('POST', '/api/auth/register', {
          username: 'sharkey',
          email: 'sharkey@example.test',
          password: 'another secure password',
        })
      ).status,
    ).toBe(409);
    await player.register('ordinary_player');
    expect((await player.request('GET', '/api/admin')).status).toBe(403);
    const overview = await admin.request('GET', '/api/admin');
    expect(overview.status).toBe(200);
    expect(overview.body.users).toEqual(
      expect.arrayContaining([expect.objectContaining({ username: 'sharkey', role: 'admin' })]),
    );
  });

  it('relocates a pre-existing sharkey player instead of failing startup', async () => {
    const { app: otherApp, context: other } = await createTestApp();
    try {
      // Reproduce prod: a player registered as sharkey before the admin row existed.
      await other.db.query(`delete from users where username = 'sharkey'`);
      await other.db.query(
        `insert into users (username, display_name, password_hash, role)
         values ('sharkey', 'sharkey', '!', 'player')`,
      );
      const result = await ensureSharkeyAdmin(other.db, 'recovery password');
      expect(result.relocatedUsername).toBe('sharkey_legacy');
      const rows = await other.db.query<{ username: string; role: string }>(
        `select username, role from users where username in ('sharkey', 'sharkey_legacy') order by username`,
      );
      expect(rows.rows).toEqual([
        { username: 'sharkey', role: 'admin' },
        { username: 'sharkey_legacy', role: 'player' },
      ]);
    } finally {
      await otherApp.close();
      await other.db.close();
    }
  });

  it('runs registration against the bot current version instead of locking one', async () => {
    const startsAt = new Date(Date.now() + 60_000).toISOString();
    const endsAt = new Date(Date.now() + 3_600_000).toISOString();
    const created = await admin.request('POST', '/api/admin/tournaments', {
      name: 'Iteration Cup',
      slug: 'iteration-cup',
      description: 'Keep improving.',
      startsAt,
      endsAt,
    });
    expect(created.status).toBe(201);

    const player = new TestClient(app);
    await player.register('tourney_player');
    const bot = await player.request('POST', '/api/bots', { name: 'Evolving Bot' });
    const first = await player.request('POST', `/api/bots/${bot.body.id}/versions`, {
      source: SAMPLE_BOTS[0]!.source,
      visibility: 'private',
      label: 'first',
    });
    expect(first.status).toBe(201);
    expect(
      (
        await player.request('POST', '/api/tournaments/iteration-cup/registration', {
          botId: bot.body.id,
        })
      ).status,
    ).toBe(200);

    await player.request('POST', `/api/bots/${bot.body.id}/versions`, {
      source: `${SAMPLE_BOTS[0]!.source}\n// tournament iteration`,
      visibility: 'private',
      label: 'second',
    });
    const detail = await player.request('GET', '/api/tournaments/iteration-cup');
    expect(detail.body.standings[0]).toMatchObject({
      botId: bot.body.id,
      activeVersion: 2,
    });
  });

  it('exposes earned profile achievements', async () => {
    const player = new TestClient(app);
    const user = await player.register('badge_player');
    await context.db.query(
      `insert into user_achievements (user_id, achievement_slug) values ($1, 'first-match')`,
      [user.id],
    );
    const profile = await player.request('GET', '/api/users/badge_player');
    expect(profile.body.achievements).toEqual([
      expect.objectContaining({ slug: 'first-match', title: 'Arena Debut' }),
    ]);
  });
});
