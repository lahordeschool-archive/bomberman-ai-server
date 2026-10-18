import { SAMPLE_BOTS } from '@bomberman/bot-sdk';
import { createGame, hashState, runReplay, step } from '@bomberman/game-engine';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/context.ts';
import { DECISIVE_ELO_K, multiplayerElo } from '../src/ratings/elo.ts';
import { completeMatch, insertMatch, rebuildRatings } from '../src/store/matches.ts';
import { awardPositiveElo } from '../src/store/skins.ts';
import { createTestApp, TestClient } from './helpers.ts';

let app: FastifyInstance;
let context: AppContext;

beforeAll(async () => {
  ({ app, context } = await createTestApp());
});

afterAll(async () => {
  await app.close();
  await context.db.close();
});

describe('auth', () => {
  it('registers, reads the session, logs out, and logs back in', async () => {
    const client = new TestClient(app);
    const anonymous = await client.request('GET', '/api/auth/session');
    expect(anonymous.body).toEqual({ user: null, csrfToken: null });

    const user = await client.register('Ada_Lovelace');
    expect(user.username).toBe('ada_lovelace');
    expect(user.email).toBe('ada_lovelace@example.test');
    expect(client.cookie).toMatch(/^bomber_session=/);

    const session = await client.request('GET', '/api/auth/session');
    expect(session.body.user.username).toBe('ada_lovelace');
    expect(session.body.user.email).toBe('ada_lovelace@example.test');
    expect(session.body.csrfToken).toBe(client.csrf);

    expect((await client.request('POST', '/api/auth/logout')).status).toBe(204);
    expect((await client.request('GET', '/api/auth/session')).body.user).toBeNull();

    const login = await client.request('POST', '/api/auth/login', {
      username: 'ADA_lovelace',
      password: 'correct horse battery',
    });
    expect(login.status).toBe(200);
    expect(login.body.user.username).toBe('ada_lovelace');
  });

  it('stores Argon2id hashes and never returns them', async () => {
    const client = new TestClient(app);
    const response = await client.request('POST', '/api/auth/register', {
      username: 'hash_check',
      email: 'hash_check@example.test',
      password: 'a long enough password',
    });
    expect(JSON.stringify(response.body)).not.toContain('argon2');
    const { rows } = await context.db.query<{ password_hash: string }>(
      `select password_hash from users where username = 'hash_check'`,
    );
    expect(rows[0]!.password_hash).toMatch(/^\$argon2id\$/);
  });

  it('gives the same generic error for unknown users and wrong passwords', async () => {
    const client = new TestClient(app);
    await client.register('grace');
    await client.request('POST', '/api/auth/logout');
    const wrong = await client.request('POST', '/api/auth/login', {
      username: 'grace',
      password: 'nope nope',
    });
    const unknown = await client.request('POST', '/api/auth/login', {
      username: 'nobody',
      password: 'nope nope',
    });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.message).toBe(unknown.body.message);
  });

  it('rejects duplicate and reserved usernames, duplicate emails, and weak passwords', async () => {
    const client = new TestClient(app);
    await client.register('linus');
    const again = await new TestClient(app).request('POST', '/api/auth/register', {
      username: 'LINUS',
      email: 'linus2@example.test',
      password: 'whatever password',
    });
    expect(again.status).toBe(409);
    const emailTaken = await new TestClient(app).request('POST', '/api/auth/register', {
      username: 'linus_alt',
      email: 'LINUS@example.test',
      password: 'whatever password',
    });
    expect(emailTaken.status).toBe(409);
    expect(emailTaken.body.error).toBe('email_taken');
    const house = await new TestClient(app).request('POST', '/api/auth/register', {
      username: 'house',
      email: 'house@example.test',
      password: 'whatever password',
    });
    expect(house.status).toBe(409);
    const weak = await new TestClient(app).request('POST', '/api/auth/register', {
      username: 'weakling',
      email: 'weakling@example.test',
      password: 'short',
    });
    expect(weak.status).toBe(400);
    expect(weak.body.issues[0].path).toBe('password');
    const missingEmail = await new TestClient(app).request('POST', '/api/auth/register', {
      username: 'no_email',
      password: 'whatever password',
    });
    expect(missingEmail.status).toBe(400);
  });

  it('cannot log in as the house account', async () => {
    const response = await new TestClient(app).request('POST', '/api/auth/login', {
      username: 'house',
      password: '!',
    });
    expect(response.status).toBe(401);
  });

  it('requires the CSRF token for signed in mutations and rejects foreign origins', async () => {
    const client = new TestClient(app);
    await client.register('csrf_victim');
    const token = client.csrf;
    client.csrf = null;
    const missing = await client.request('POST', '/api/bots', { name: 'Sneaky' });
    expect(missing.status).toBe(403);
    client.csrf = token;
    const foreign = await client.request(
      'POST',
      '/api/bots',
      { name: 'Sneaky' },
      { origin: 'https://evil.test' },
    );
    expect(foreign.status).toBe(403);
    const ok = await client.request(
      'POST',
      '/api/bots',
      { name: 'Fine' },
      { origin: 'http://localhost:8080' },
    );
    expect(ok.status).toBe(201);
  });

  it('changes the password and revokes other sessions', async () => {
    const first = new TestClient(app);
    await first.register('rotator', 'first password!');
    const second = new TestClient(app);
    await second.request('POST', '/api/auth/login', {
      username: 'rotator',
      password: 'first password!',
    });

    const bad = await first.request('POST', '/api/auth/password', {
      currentPassword: 'wrong password',
      newPassword: 'second password!',
    });
    expect(bad.status).toBe(400);
    const changed = await first.request('POST', '/api/auth/password', {
      currentPassword: 'first password!',
      newPassword: 'second password!',
    });
    expect(changed.status).toBe(200);
    expect((await first.request('GET', '/api/auth/session')).body.user.username).toBe('rotator');
    expect((await second.request('GET', '/api/auth/session')).body.user).toBeNull();
  });

  it('rate limits repeated failed logins', async () => {
    const client = new TestClient(app);
    let last = 0;
    for (let attempt = 0; attempt < 12; attempt++) {
      last = (
        await client.request('POST', '/api/auth/login', {
          username: 'target',
          password: 'guess guess',
        })
      ).status;
    }
    expect(last).toBe(429);
  });

  it('writes audit records', async () => {
    const { rows } = await context.db.query<{ action: string }>(
      'select distinct action from audit_log',
    );
    expect(rows.map((row) => row.action)).toEqual(
      expect.arrayContaining(['register', 'login', 'login_failed', 'logout', 'password_changed']),
    );
  });
});

describe('bots and versions', () => {
  it('creates a bot, validates versions in the sandbox, and keeps versions immutable', async () => {
    const owner = new TestClient(app);
    await owner.register('builder');
    const created = await owner.request('POST', '/api/bots', { name: 'Blaster' });
    expect(created.status).toBe(201);
    const botId = created.body.id as string;

    const broken = await owner.request('POST', `/api/bots/${botId}/versions`, {
      source: 'function nope( {',
    });
    expect(broken.status).toBe(422);
    const missing = await owner.request('POST', `/api/bots/${botId}/versions`, {
      source: 'const x = 1;',
    });
    expect(missing.status).toBe(422);

    const source = SAMPLE_BOTS[0]!.source;
    const v1 = await owner.request('POST', `/api/bots/${botId}/versions`, { source });
    expect(v1.status).toBe(201);
    expect(v1.body).toMatchObject({
      version: 1,
      label: null,
      visibility: 'private',
      sdkVersion: 1,
      source,
    });
    expect(v1.body.sourceHash).toMatch(/^[0-9a-f]{64}$/);
    const v2 = await owner.request('POST', `/api/bots/${botId}/versions`, {
      source,
      visibility: 'public',
      label: '  Aggressive opener  ',
    });
    expect(v2.body).toMatchObject({ version: 2, label: 'Aggressive opener' });

    const detail = await owner.request('GET', `/api/bots/${botId}`);
    expect(detail.body.activeVersion).toMatchObject({ version: 2, label: 'Aggressive opener' });
    expect(detail.body.versions.map((version: { version: number }) => version.version)).toEqual([
      2, 1,
    ]);
    expect(detail.body).not.toHaveProperty('ownerId');

    await expect(
      context.db.query(`update bot_versions set source = 'x' where bot_id = $1`, [botId]),
    ).rejects.toThrow(/immutable/);

    const stranger = new TestClient(app);
    await stranger.register('stranger');
    const privateVersion = await stranger.request(
      'GET',
      `/api/bots/${botId}/versions/${v1.body.id}`,
    );
    expect(privateVersion.body.source).toBeNull();
    const publicVersion = await stranger.request(
      'GET',
      `/api/bots/${botId}/versions/${v2.body.id}`,
    );
    expect(publicVersion.body.source).toBe(source);
    expect(
      (await stranger.request('PATCH', `/api/bots/${botId}`, { name: 'Mine now' })).status,
    ).toBe(403);
    expect((await stranger.request('POST', `/api/bots/${botId}/ranked`)).status).toBe(403);
  });

  it('enforces unique names per owner and soft deletes bots', async () => {
    const owner = new TestClient(app);
    await owner.register('namer');
    const first = await owner.request('POST', '/api/bots', { name: 'Twin' });
    expect((await owner.request('POST', '/api/bots', { name: 'twin' })).status).toBe(409);
    expect((await owner.request('DELETE', `/api/bots/${first.body.id}`)).status).toBe(204);
    expect((await owner.request('GET', `/api/bots/${first.body.id}`)).status).toBe(404);
    expect((await owner.request('POST', '/api/bots', { name: 'Twin' })).status).toBe(201);
  });

  it('joins and leaves the ranked queue only with a saved version', async () => {
    const owner = new TestClient(app);
    await owner.register('queuer');
    const bot = await owner.request('POST', '/api/bots', { name: 'Queued' });
    const early = await owner.request('POST', `/api/bots/${bot.body.id}/ranked`);
    expect(early.status).toBe(409);
    await owner.request('POST', `/api/bots/${bot.body.id}/versions`, {
      source: SAMPLE_BOTS[1]!.source,
    });
    const joined = await owner.request('POST', `/api/bots/${bot.body.id}/ranked`);
    expect(joined.status).toBe(200);
    expect(joined.body.queue.map((entry: { botId: string }) => entry.botId)).toContain(bot.body.id);
    expect((await owner.request('GET', '/api/bots')).body.bots[0].queued).toBe(true);
    const left = await owner.request('DELETE', `/api/bots/${bot.body.id}/ranked`);
    expect(left.body.queue.map((entry: { botId: string }) => entry.botId)).not.toContain(
      bot.body.id,
    );
    await owner.request('POST', `/api/bots/${bot.body.id}/versions`, {
      source: SAMPLE_BOTS[1]!.source,
      ranked: true,
    });
    expect((await owner.request('GET', '/api/bots')).body.bots[0].queued).toBe(true);
    await owner.request('DELETE', `/api/bots/${bot.body.id}/ranked`);
  });

  it('keeps the deployment smoke account out of ranked play and the leaderboard', async () => {
    const smoke = new TestClient(app);
    const user = await smoke.register('deploycheck');
    const bot = await smoke.request('POST', '/api/bots', { name: 'Deploy Check' });
    const saved = await smoke.request('POST', `/api/bots/${bot.body.id}/versions`, {
      source: SAMPLE_BOTS[0]!.source,
      label: 'v1 deploy check',
    });
    expect(saved.status).toBe(201);

    const joined = await smoke.request('POST', `/api/bots/${bot.body.id}/ranked`);
    expect(joined.status).toBe(403);
    expect(joined.body.error).toBe('ranked_disabled');
    const submittedAndRanked = await smoke.request('POST', `/api/bots/${bot.body.id}/versions`, {
      source: SAMPLE_BOTS[1]!.source,
      ranked: true,
    });
    expect(submittedAndRanked.status).toBe(403);

    const account = await context.db.query<{ ranked_eligible: boolean }>(
      'select ranked_eligible from users where id = $1',
      [user.id],
    );
    expect(account.rows[0]?.ranked_eligible).toBe(false);

    // Stale/manual queue rows are ignored as a second line of defense.
    await context.db.query('insert into ranked_queue (bot_id) values ($1)', [bot.body.id]);
    await context.db.query(
      'insert into ratings (bot_id, games) values ($1, 10) on conflict (bot_id) do update set games = 10',
      [bot.body.id],
    );
    const status = await smoke.request('GET', '/api/ranked/status');
    expect(status.body.queue.map((entry: { botId: string }) => entry.botId)).not.toContain(
      bot.body.id,
    );
    const leaderboard = await smoke.request('GET', '/api/leaderboard?limit=100');
    expect(leaderboard.body.entries.map((entry: { botId: string }) => entry.botId)).not.toContain(
      bot.body.id,
    );
  });

  it('lists a public profile', async () => {
    const profile = await new TestClient(app).request('GET', '/api/users/House');
    expect(profile.status).toBe(200);
    expect(profile.body.bots.map((bot: { name: string }) => bot.name).sort()).toEqual(
      SAMPLE_BOTS.map((sample) => sample.name).sort(),
    );
  });

  it('earns ranked coins, purchases skins, and equips them per bot', async () => {
    const player = new TestClient(app);
    const user = await player.register('skin_collector');
    const bot = await player.request('POST', '/api/bots', { name: 'Well Dressed' });
    const initial = await player.request('GET', '/api/store');
    expect(initial.body.balance).toBe(0);
    expect(initial.body.skins).toHaveLength(11);
    expect(initial.body.skins.map((skin: { price: number }) => skin.price)).toEqual(
      [...initial.body.skins]
        .map((skin: { price: number }) => skin.price)
        .sort((a: number, b: number) => a - b),
    );
    expect((await player.request('POST', '/api/store/purchases', { skin: 'ember' })).status).toBe(
      409,
    );

    const matchId = await insertMatch(context.db, {
      kind: 'ranked',
      engineVersion: 1,
      sdkVersion: 1,
      seed: 8,
      settings: { bombs: 1, flames: 2, speed: 1, maxTicks: 100 },
      participants: [],
    });
    await context.db.transaction(async (tx) => {
      expect(await awardPositiveElo(tx, user.id, matchId, 40)).toBe(200);
      expect(await awardPositiveElo(tx, user.id, matchId, 40)).toBe(0);
    });

    const bought = await player.request('POST', '/api/store/purchases', { skin: 'ember' });
    expect(bought.status).toBe(201);
    expect(bought.body).toMatchObject({ balance: 50, earned: 200, owned: ['ember'] });
    const equipped = await player.request('PUT', `/api/bots/${bot.body.id}/skin`, {
      skin: 'ember',
    });
    expect(equipped).toMatchObject({ status: 200, body: { skin: 'ember' } });

    const stranger = new TestClient(app);
    await stranger.register('skin_stranger');
    const strangerBot = await stranger.request('POST', '/api/bots', { name: 'Plain' });
    expect(
      (
        await stranger.request('PUT', `/api/bots/${strangerBot.body.id}/skin`, {
          skin: 'ember',
        })
      ).status,
    ).toBe(403);
  });
});

describe('matches, replays, and ratings', () => {
  it('stores a completed ranked match atomically and serves a verifiable replay', async () => {
    const [a, b] = context.house;
    const seed = 4242;
    const state = createGame({ seed, playerCount: 2 });
    const intents = [
      { tick: 0, playerId: 0, intent: { type: 'bomb' as const } },
      { tick: 0, playerId: 1, intent: { type: 'move' as const, direction: 'down' as const } },
    ];
    const matchId = await insertMatch(context.db, {
      kind: 'ranked',
      engineVersion: state.engineVersion,
      sdkVersion: 1,
      seed,
      settings: state.settings,
      participants: [a!, b!].map((bot, slot) => ({
        slot,
        kind: 'house' as const,
        botId: bot.botId,
        botVersionId: bot.versionId,
        userId: null,
        botName: bot.name,
      })),
    });
    const live = await new TestClient(app).request('GET', '/api/matches/live');
    expect(live.body.matches.map((match: { id: string }) => match.id)).toContain(matchId);

    const final = runReplay({
      engineVersion: state.engineVersion,
      seed,
      playerCount: 2,
      settings: state.settings,
      intents,
    });
    await context.db.transaction((tx) =>
      completeMatch(tx, matchId, { result: final.result!, intents, finalHash: hashState(final) }),
    );

    const summary = (await new TestClient(app).request('GET', `/api/matches/${matchId}`)).body;
    expect(summary.status).toBe('completed');
    expect(summary.participants).toHaveLength(2);
    expect(summary.participants[0].ratingBefore).toBe(1200);
    expect(
      summary.participants.every((p: { ratingAfter: number | null }) => p.ratingAfter !== null),
    ).toBe(true);

    const replay = (await new TestClient(app).request('GET', `/api/matches/${matchId}/replay`))
      .body;
    expect(replay.intents).toEqual([
      [0, 0, 'b'],
      [0, 1, 'd'],
    ]);
    const replayed = runReplay({
      engineVersion: replay.engineVersion,
      seed: replay.seed,
      playerCount: replay.playerCount,
      settings: replay.settings,
      intents: replay.intents.map(([tick, playerId, code]: [number, number, string]) => ({
        tick,
        playerId,
        intent: code === 'b' ? { type: 'bomb' } : { type: 'move', direction: 'down' },
      })),
    });
    expect(hashState(replayed)).toBe(replay.finalHash);

    const leaderboard = (await new TestClient(app).request('GET', '/api/leaderboard')).body;
    expect(leaderboard.total).toBeGreaterThanOrEqual(2);
    expect(leaderboard.entries[0].rank).toBe(1);

    const newcomer = new TestClient(app);
    await newcomer.register('ladder_newcomer');
    const fresh = await newcomer.request('POST', '/api/bots', { name: 'Fresh Face' });
    await newcomer.request('POST', `/api/bots/${fresh.body.id}/versions`, {
      source: SAMPLE_BOTS[0]!.source,
    });
    const onLadder = async () =>
      (await new TestClient(app).request('GET', '/api/leaderboard?limit=100')).body.entries as {
        botId: string;
        games: number;
      }[];
    expect((await onLadder()).some((entry) => entry.botId === fresh.body.id)).toBe(false);
    await newcomer.request('POST', `/api/bots/${fresh.body.id}/ranked`);
    const queued = await onLadder();
    expect(queued.at(-1)).toMatchObject({ botId: fresh.body.id, games: 0 });
    expect(queued.slice(0, -1).every((entry) => entry.games > 0)).toBe(true);
    await newcomer.request('DELETE', `/api/bots/${fresh.body.id}/ranked`);
    expect((await onLadder()).some((entry) => entry.botId === fresh.body.id)).toBe(false);

    const listed = (await new TestClient(app).request('GET', `/api/matches?botId=${a!.botId}`))
      .body;
    expect(listed.matches.map((match: { id: string }) => match.id)).toContain(matchId);

    const before = await context.db.query<{ bot_id: string; rating: number; games: number }>(
      'select bot_id, rating, games from ratings order by bot_id',
    );
    await context.db.transaction((tx) => rebuildRatings(tx));
    const after = await context.db.query(
      'select bot_id, rating, games from ratings order by bot_id',
    );
    expect(after.rows).toEqual(before.rows);
  });

  it('never completes a match twice', async () => {
    const state = createGame({ seed: 1, playerCount: 2 });
    while (state.status === 'running') step(state);
    const id = await insertMatch(context.db, {
      kind: 'casual',
      engineVersion: 1,
      sdkVersion: 1,
      seed: 1,
      settings: state.settings,
      participants: [0, 1].map((slot) => ({
        slot,
        kind: 'browser' as const,
        botId: null,
        botVersionId: null,
        userId: null,
        botName: `Bot ${slot}`,
      })),
    });
    const outcome = { result: state.result!, intents: [], finalHash: hashState(state) };
    await context.db.transaction((tx) => completeMatch(tx, id, outcome));
    await expect(context.db.transaction((tx) => completeMatch(tx, id, outcome))).rejects.toThrow(
      /not running/,
    );
  });
});

describe('multiplayer elo', () => {
  it('is zero sum for equal ratings and rewards upsets more', () => {
    const even = multiplayerElo([
      { rating: 1200, placement: 1 },
      { rating: 1200, placement: 2 },
      { rating: 1200, placement: 3 },
      { rating: 1200, placement: 4 },
    ]);
    expect(even.reduce((sum, value) => sum + value, 0)).toBeCloseTo(4800);
    expect(even[0]).toBeGreaterThan(even[1]!);
    const upset = multiplayerElo([
      { rating: 1000, placement: 1 },
      { rating: 1400, placement: 2 },
    ]);
    const expected = multiplayerElo([
      { rating: 1400, placement: 1 },
      { rating: 1000, placement: 2 },
    ]);
    expect(upset[0]! - 1000).toBeGreaterThan(expected[0]! - 1400);
    const tie = multiplayerElo([
      { rating: 1200, placement: 1 },
      { rating: 1200, placement: 1 },
    ]);
    expect(tie).toEqual([1200, 1200]);
  });

  it('moves ratings further for a decisive result', () => {
    const entrants = [
      { rating: 1200, placement: 1 },
      { rating: 1200, placement: 2 },
    ];
    const timeout = multiplayerElo(entrants);
    const decisive = multiplayerElo(entrants, DECISIVE_ELO_K);
    expect(decisive[0]! - 1200).toBeGreaterThan(timeout[0]! - 1200);
    expect(1200 - decisive[1]!).toBeGreaterThan(1200 - timeout[1]!);
  });
});
