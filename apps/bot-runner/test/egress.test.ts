import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildObservation, FETCH_LIMITS } from '@bomberman/bot-sdk';
import { createGame } from '@bomberman/game-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_EGRESS, Egress, isPublicAddress } from '../src/egress.ts';
import { QuickJsBot } from '../src/sandbox.ts';

const observation = buildObservation(createGame({ seed: 1, playerCount: 2 }), 0);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let server: Server;
let origin: string;
const open = new Egress({ ...DEFAULT_EGRESS, allowPrivateNetworks: true });
const strict = new Egress(DEFAULT_EGRESS);
const seen: { method?: string; body: string; agent?: string; cookie?: string }[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => {
      seen.push({
        method: request.method,
        body,
        agent: request.headers['user-agent'],
        cookie: request.headers.cookie,
      });
      if (request.url === '/move') {
        response.writeHead(200, { 'content-type': 'application/json', 'x-plan': 'up' });
        response.end(JSON.stringify({ move: 'UP' }));
      } else if (request.url === '/echo') {
        response.writeHead(201, { 'content-type': 'text/plain' });
        response.end(`${request.method} ${body}`);
      } else if (request.url === '/redirect') {
        response.writeHead(302, { location: '/move' });
        response.end();
      } else if (request.url === '/big') {
        response.writeHead(200);
        response.end('x'.repeat(FETCH_LIMITS.maxResponseBytes + 10));
      } else if (request.url === '/slow') {
        setTimeout(() => response.end('late'), 400);
      } else {
        response.writeHead(404);
        response.end('missing');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.close();
  await Promise.all([open.close(), strict.close()]);
});

describe('address policy', () => {
  it.each([
    ['8.8.8.8', true],
    ['1.1.1.1', true],
    ['2606:4700:4700::1111', true],
    ['127.0.0.1', false],
    ['10.20.30.40', false],
    ['172.20.0.5', false],
    ['192.168.1.1', false],
    ['169.254.169.254', false],
    ['100.64.0.1', false],
    ['0.0.0.0', false],
    ['224.0.0.1', false],
    ['::1', false],
    ['::', false],
    ['fd12::1', false],
    ['fe80::1', false],
    ['::ffff:127.0.0.1', false],
    ['::ffff:8.8.8.8', false],
    ['64:ff9b::7f00:1', false],
    ['example.com', false],
  ])('%s is public: %s', (address, expected) => {
    expect(isPublicAddress(address)).toBe(expected);
  });
});

describe('bot fetch', () => {
  it('lets a bot await a request inside its decision budget', async () => {
    const bot = await QuickJsBot.create(
      `async function gameLoop() {
        const response = await fetch('${origin}/move');
        const data = await response.json();
        console.log(response.status, response.ok, response.headers.get('X-Plan'));
        return 'MOVE ' + data.move;
      }`,
      1,
      undefined,
      open,
    );
    const result = await bot.act(observation, 1000);
    expect(result).toMatchObject({ action: 'MOVE UP', error: null, late: false });
    expect(result.logs).toEqual([{ level: 'log', message: '200 true up' }]);
    expect(seen.at(-1)?.agent).toMatch(/BomberArenaBot/);
    bot.dispose();
  });

  it('keeps background requests running between turns', async () => {
    const bot = await QuickJsBot.create(
      `let plan = null;
       let asked = false;
       function gameLoop() {
         if (!asked) {
           asked = true;
           fetch('${origin}/move').then((r) => r.json()).then((data) => { plan = data.move; });
         }
         return plan ? 'MOVE ' + plan : 'NOTHING';
       }`,
      1,
      undefined,
      open,
    );
    expect((await bot.act(observation)).action).toBe('NOTHING');
    await sleep(150);
    expect((await bot.act(observation)).action).toBe('MOVE UP');
    bot.dispose();
  });

  it('sends methods, headers, and bodies, follows redirects, and never sends cookies', async () => {
    const bot = await QuickJsBot.create(
      `async function gameLoop() {
        const posted = await fetch('${origin}/echo', {
          method: 'post',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ hello: 1 }),
        });
        console.log(posted.status, await posted.text());
        const moved = await fetch('${origin}/redirect');
        console.log(moved.redirected, moved.url.endsWith('/move'));
        try { await fetch('${origin}/echo', { headers: { cookie: 'a=b' } }); }
        catch (error) { console.log(error.message); }
        return 'NOTHING';
      }`,
      1,
      undefined,
      open,
    );
    const result = await bot.act(observation, 2000);
    expect(result.logs.map((line) => line.message)).toEqual([
      '201 POST {"hello":1}',
      'true true',
      'Header cookie is not allowed',
    ]);
    bot.dispose();
  });

  it('enforces response size, timeouts, and concurrency limits', async () => {
    const quick = new Egress({ ...DEFAULT_EGRESS, allowPrivateNetworks: true, timeoutMs: 100 });
    const bot = await QuickJsBot.create(
      `async function gameLoop() {
        const report = (promise) => promise.then((r) => r.text()).then(
          (text) => console.log('ok', text.length),
          (error) => console.log(error.message),
        );
        await report(fetch('${origin}/big'));
        await report(fetch('${origin}/slow'));
        const burst = [];
        for (let i = 0; i < ${FETCH_LIMITS.maxConcurrent + 1}; i++) burst.push(report(fetch('${origin}/move')));
        await Promise.all(burst);
        return 'NOTHING';
      }`,
      1,
      undefined,
      quick,
    );
    const messages = (await bot.act(observation, 2000)).logs.map((line) => line.message);
    expect(messages[0]).toMatch(/exceeds 256 KB/);
    expect(messages[1]).toMatch(/timed out after 100 ms/);
    expect(messages.filter((message) => message.startsWith('ok'))).toHaveLength(
      FETCH_LIMITS.maxConcurrent,
    );
    expect(messages).toContain(`Too many requests in flight (max ${FETCH_LIMITS.maxConcurrent})`);
    bot.dispose();
    await quick.close();
  });

  it('refuses private networks, other schemes, and reserved ports by default', async () => {
    const port = new URL(origin).port;
    const bot = await QuickJsBot.create(
      `async function gameLoop() {
        for (const url of [
          '${origin}/move',
          'http://localhost:${port}/move',
          'http://169.254.169.254/latest/meta-data/',
          'http://[::1]:${port}/',
          'file:///etc/passwd',
          'https://example.com:22/',
          'http://user:pass@example.com/',
        ]) {
          try { await fetch(url); console.log('reached', url); }
          catch (error) { console.log(error.message); }
        }
        return 'NOTHING';
      }`,
      1,
      undefined,
      strict,
    );
    const messages = (await bot.act(observation, 3000)).logs.map((line) => line.message);
    expect(messages).toEqual([
      '127.0.0.1 is a private or reserved address',
      'localhost resolves to a private or reserved address',
      '169.254.169.254 is a private or reserved address',
      '::1 is a private or reserved address',
      'Only http and https URLs can be fetched',
      'Port 22 is not allowed',
      'URLs with credentials are not allowed',
    ]);
    bot.dispose();
  });

  it('can be switched off', async () => {
    const off = new Egress({ ...DEFAULT_EGRESS, enabled: false });
    const bot = await QuickJsBot.create(
      `async function gameLoop() {
        try { await fetch('https://example.com'); } catch (error) { console.log(error.message); }
        return 'NOTHING';
      }`,
      1,
      undefined,
      off,
    );
    expect((await bot.act(observation)).logs[0]?.message).toBe(
      'Network access is disabled on this server',
    );
    bot.dispose();
    await off.close();
  });
});
