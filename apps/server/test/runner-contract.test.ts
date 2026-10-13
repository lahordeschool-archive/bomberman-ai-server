import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildObservation, SAMPLE_BOTS } from '@bomberman/bot-sdk';
import { createGame } from '@bomberman/game-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SandboxPool } from '../../bot-runner/src/pool.ts';
import { DEFAULT_LIMITS } from '../../bot-runner/src/sandbox.ts';
import { createRunnerServer } from '../../bot-runner/src/server.ts';
import { BotRejectedError, RunnerClient, RunnerUnavailableError } from '../src/runner/executor.ts';

const TOKEN = 'contract-test-token-123';
let pool: SandboxPool;
let runner: Server;
let client: RunnerClient;

beforeAll(async () => {
  pool = new SandboxPool(1, DEFAULT_LIMITS, 8);
  runner = createRunnerServer({ pool, token: TOKEN });
  await new Promise<void>((resolve) => runner.listen(0, '127.0.0.1', resolve));
  client = new RunnerClient(`http://127.0.0.1:${(runner.address() as AddressInfo).port}`, TOKEN);
});

afterAll(async () => {
  runner.close();
  await pool.close();
});

describe('server to bot-runner contract', () => {
  it('validates sources in the QuickJS sandbox', async () => {
    expect(await client.healthy()).toBe(true);
    expect(await client.validate(SAMPLE_BOTS[0]!.source)).toEqual({ ok: true });
    const broken = await client.validate('function gameLoop( {');
    expect(broken.ok).toBe(false);
  });

  it('runs a session and returns actions', async () => {
    const session = await client.createSession(`function gameLoop() { return 'PLANT BOMB'; }`, 7);
    const observation = buildObservation(createGame({ seed: 3, playerCount: 2 }), 0);
    expect(await session.decide(observation, new AbortController().signal, 240)).toBe('PLANT BOMB');
    await session.dispose();
  });

  it('surfaces load errors and bot exceptions distinctly', async () => {
    await expect(client.createSession('const nothing = 1;', 1)).rejects.toBeInstanceOf(
      BotRejectedError,
    );
    const session = await client.createSession(
      `function gameLoop() { throw new Error('boom'); }`,
      1,
    );
    const observation = buildObservation(createGame({ seed: 3, playerCount: 2 }), 0);
    await expect(session.decide(observation, new AbortController().signal, 240)).rejects.toThrow(
      /boom/,
    );
    await session.dispose();
  });

  it('passes the decision budget to the runner, which skips the turn on time', async () => {
    const session = await client.createSession(
      'async function gameLoop() { await new Promise(() => {}); }',
      1,
    );
    const observation = buildObservation(createGame({ seed: 3, playerCount: 2 }), 0);
    const started = performance.now();
    await expect(session.decide(observation, new AbortController().signal, 120)).rejects.toThrow(
      /within 100 ms: turn skipped/,
    );
    expect(performance.now() - started).toBeLessThan(400);
    await session.dispose();
  });

  it('refuses callers without the shared token', async () => {
    const intruder = new RunnerClient(
      `http://127.0.0.1:${(runner.address() as AddressInfo).port}`,
      'wrong-token-wrong-token',
    );
    await expect(intruder.validate('function gameLoop() {}')).rejects.toBeInstanceOf(
      RunnerUnavailableError,
    );
  });
});
