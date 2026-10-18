import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import {
  botSeed,
  type BotController,
  buildObservation,
  extractChat,
  getSampleBot,
  MAX_CHAT_LENGTH,
  runMatch,
} from '@bomberman/bot-sdk';
import { createGame, hashState } from '@bomberman/game-engine';
import { SandboxPool } from '../src/pool.ts';
import { BotLoadError, DEFAULT_LIMITS, QuickJsBot } from '../src/sandbox.ts';
import { createRunnerServer } from '../src/server.ts';
import { createVmController } from '../../../packages/bot-sdk/test/vm-controller.ts';

const observation = buildObservation(createGame({ seed: 1, playerCount: 2 }), 0);

describe('QuickJS sandbox', () => {
  it('runs a bot and returns its raw action and logs', async () => {
    const bot = await QuickJsBot.create(
      'function gameLoop(obs) { console.log("me", obs.me.x); return "MOVE RIGHT"; }',
      1,
    );
    const result = await bot.act(observation);
    expect(result).toMatchObject({ action: 'MOVE RIGHT', error: null, timedOut: false });
    expect(result.logs).toEqual([{ level: 'log', message: 'me 1' }]);
    bot.dispose();
  });

  it('preserves chat fields and long chat strings through the harness', async () => {
    const bot = await QuickJsBot.create(
      `let turn = 0;
       function gameLoop() {
         turn++;
         if (turn === 1) return { type: 'bomb', say: 'x' };
         if (turn === 2) return { type: 'move', direction: 'up', say: 'on my way' };
         if (turn === 3) return { type: 'say', message: 'hello' };
         return 'SAY ' + 'z'.repeat(500);
       }`,
      1,
    );

    const bomb = (await bot.act(observation)).action;
    expect(bomb).toMatchObject({ type: 'bomb', say: 'x' });
    expect(extractChat(bomb)).toBe('x');

    const move = (await bot.act(observation)).action;
    expect(move).toMatchObject({ type: 'move', direction: 'up', say: 'on my way' });
    expect(extractChat(move)).toBe('on my way');

    const say = (await bot.act(observation)).action;
    expect(say).toMatchObject({ type: 'say', message: 'hello' });
    expect(extractChat(say)).toBe('hello');

    const longSay = (await bot.act(observation)).action;
    expect(extractChat(longSay)).toBe('z'.repeat(MAX_CHAT_LENGTH));
    bot.dispose();
  });

  it('rejects code without gameLoop, syntax errors, and oversized sources', async () => {
    await expect(QuickJsBot.create('const a = 1;', 1)).rejects.toThrow(/gameLoop/);
    await expect(QuickJsBot.create('function gameLoop( {', 1)).rejects.toThrow(/SyntaxError/);
    await expect(QuickJsBot.create('x'.repeat(70 * 1024), 1)).rejects.toThrow(/exceeds/);
  });

  it('interrupts infinite loops at load time and during a call', async () => {
    await expect(QuickJsBot.create('while (true) {}', 1)).rejects.toBeInstanceOf(BotLoadError);
    const bot = await QuickJsBot.create(
      'let calls = 0; function gameLoop() { calls++; if (calls === 1) { while (true) {} } return "PLANT BOMB"; }',
      1,
    );
    const started = Date.now();
    const first = await bot.act(observation);
    expect(Date.now() - started).toBeLessThan(DEFAULT_LIMITS.callTimeoutMs * 5);
    expect(first).toMatchObject({ action: null, timedOut: true });
    expect(await bot.act(observation)).toMatchObject({ action: 'PLANT BOMB', timedOut: false });
    bot.dispose();
  });

  it('skips the turn of a bot that does not answer in time, without disabling it', async () => {
    const bot = await QuickJsBot.create(
      'async function gameLoop() { await new Promise(() => {}); }',
      1,
    );
    expect(await bot.act(observation)).toMatchObject({
      action: null,
      timedOut: true,
      late: true,
      error: expect.stringMatching(/turn skipped/),
    });
    for (let turn = 0; turn < DEFAULT_LIMITS.maxConsecutiveFailures + 5; turn++) {
      await bot.act(observation, 2);
    }
    expect((await bot.act(observation, 2)).disabled).toBe(false);
    bot.dispose();
  });

  it('never returns a late answer from an earlier turn as the current decision', async () => {
    const bot = await QuickJsBot.create(
      `let resolveFirst;
       let calls = 0;
       function gameLoop() {
         calls++;
         if (calls === 1) return new Promise((resolve) => { resolveFirst = resolve; });
         resolveFirst('MOVE UP');
         return new Promise(() => {});
       }`,
      1,
    );
    expect((await bot.act(observation, 5)).late).toBe(true);
    expect(await bot.act(observation, 5)).toMatchObject({ action: null, late: true });
    bot.dispose();
  });

  it('supports async bots that resolve through microtasks', async () => {
    const bot = await QuickJsBot.create(
      'async function gameLoop() { await null; await Promise.resolve(); return { type: "bomb" }; }',
      1,
    );
    expect((await bot.act(observation)).action).toEqual({ type: 'bomb', direction: null });
    bot.dispose();
  });

  it('stops memory exhaustion and disables the bot', async () => {
    const bot = await QuickJsBot.create(
      'const hoard = []; function gameLoop() { while (true) hoard.push(new Array(100000).fill(hoard.length)); }',
      1,
      { ...DEFAULT_LIMITS, memoryBytes: 8 * 1024 * 1024, callTimeoutMs: 2000 },
    );
    const result = await bot.act(observation);
    expect(result.action).toBeNull();
    expect(result.disabled).toBe(true);
    expect((await bot.act(observation)).error).toMatch(/disabled/);
    bot.dispose();
  });

  it('exposes no host capabilities', async () => {
    const bot = await QuickJsBot.create(
      `function gameLoop() {
        const probes = [
          typeof process,
          typeof require,
          typeof fetch,
          typeof setTimeout,
          typeof std,
          typeof os,
          typeof Function('return this')().process,
          ({}).constructor.constructor('return typeof process')(),
        ];
        return probes.map((probe) => (probe === 'undefined' ? '.' : probe[0])).join('');
      }`,
      1,
    );
    const result = await bot.act(observation);
    expect(result.error).toBeNull();
    expect(result.action).toBe('........');
    bot.dispose();
  });

  it('is deterministic: seeded randomness and a clock frozen to the tick', async () => {
    const source =
      'function gameLoop(obs) { return String(Math.random()) + "|" + Date.now() + "|" + new Date().getTime(); }';
    const a = await QuickJsBot.create(source, 42);
    const b = await QuickJsBot.create(source, 42);
    const first = (await a.act({ ...observation, tick: 20 })).action;
    expect(first).toBe((await b.act({ ...observation, tick: 20 })).action);
    expect(String(first).endsWith('|1000|1000')).toBe(true);
    a.dispose();
    b.dispose();
  });

  it('produces the same match as the browser harness (runtime parity)', async () => {
    const source = getSampleBot('cautious-bomber')!.source;
    const seed = 77;
    const play = async (factory: (id: number) => Promise<BotController>) => {
      const state = createGame({ seed, playerCount: 2, settings: { maxTicks: 800 } });
      const controllers = await Promise.all([0, 1].map(factory));
      const { intents } = await runMatch({
        state,
        controllers,
        tickMs: 0,
        decisionTimeoutMs: 2000,
      });
      return { hash: hashState(state), intents: intents.length };
    };
    const quick = await play(async (id) => {
      const bot = await QuickJsBot.create(source, botSeed(seed, id), {
        ...DEFAULT_LIMITS,
        callTimeoutMs: 2000,
      });
      return { decide: async (obs) => (await bot.act(obs, 2000)).action };
    });
    const vm = await play(async (id) => createVmController(source, botSeed(seed, id)));
    expect(quick).toEqual(vm);
  });
});

describe('runner HTTP API', () => {
  const token = 'test-token-0123456789';
  let pool: SandboxPool;
  let baseUrl: string;
  let close: () => Promise<void>;

  beforeAll(async () => {
    pool = new SandboxPool(1, DEFAULT_LIMITS, 4);
    const server = createRunnerServer({ pool, token });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = async () => {
      server.close();
      await pool.close();
    };
  });
  afterAll(() => close());

  const call = (path: string, init: RequestInit = {}, auth = true) =>
    fetch(baseUrl + path, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(auth ? { authorization: `Bearer ${token}` } : {}),
      },
    });

  it('requires the shared token except for health checks', async () => {
    expect((await call('/healthz', {}, false)).status).toBe(200);
    const denied = await call('/v1/validate', { method: 'POST', body: '{}' }, false);
    expect(denied.status).toBe(401);
  });

  it('validates sources', async () => {
    const good = await call('/v1/validate', {
      method: 'POST',
      body: JSON.stringify({ source: 'function gameLoop(){ return "MOVE UP" }' }),
    });
    expect(await good.json()).toMatchObject({ ok: true, action: 'MOVE UP' });
    const bad = await call('/v1/validate', {
      method: 'POST',
      body: JSON.stringify({ source: 'function gameLoop(){ throw new Error("nope") }' }),
    });
    expect(await bad.json()).toMatchObject({ ok: false, error: 'Error: nope' });
  });

  it('creates sessions, acts, enforces capacity, and disposes', async () => {
    const created = await call('/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({
        source: 'let n = 0; function gameLoop(){ n++; return "MOVE " + (n % 2 ? "UP" : "DOWN") }',
        seed: 3,
      }),
    });
    expect(created.status).toBe(201);
    const { sessionId } = (await created.json()) as { sessionId: string };
    for (const expected of ['MOVE UP', 'MOVE DOWN']) {
      const acted = await call(`/v1/sessions/${sessionId}/act`, {
        method: 'POST',
        body: JSON.stringify({ observation }),
      });
      expect(await acted.json()).toMatchObject({ action: expected });
    }
    const failing = await call('/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({ source: 'nothing here', seed: 1 }),
    });
    expect(failing.status).toBe(422);
    expect((await call(`/v1/sessions/${sessionId}`, { method: 'DELETE' })).status).toBe(204);
    const gone = await call(`/v1/sessions/${sessionId}/act`, {
      method: 'POST',
      body: JSON.stringify({ observation }),
    });
    expect(gone.status).toBe(404);
  });
});
