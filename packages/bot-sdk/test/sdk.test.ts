import { describe, expect, it } from 'vitest';
import { createGame, hashState, runReplay, step } from '@bomberman/game-engine';
import {
  botSeed,
  buildObservation,
  getSampleBot,
  parseAction,
  runMatch,
  SAMPLE_BOTS,
  STARTER_SOURCE,
} from '../src/index.ts';
import { createVmController } from './vm-controller.ts';

describe('parseAction', () => {
  it.each([
    ['MOVE UP', { type: 'move', direction: 'up' }],
    ['  move   left ', { type: 'move', direction: 'left' }],
    ['PLANT BOMB', { type: 'bomb' }],
    ['bomb', { type: 'bomb' }],
    ['right', { type: 'move', direction: 'right' }],
    ['NOTHING', { type: 'idle' }],
    ['MOVE diagonal', { type: 'idle' }],
    [
      { type: 'move', direction: 'DOWN' },
      { type: 'move', direction: 'down' },
    ],
    [{ type: 'bomb' }, { type: 'bomb' }],
    [{ type: 'teleport' }, { type: 'idle' }],
    [42, { type: 'idle' }],
    [null, { type: 'idle' }],
  ])('parses %j', (raw, expected) => {
    expect(parseAction(raw)).toEqual(expected);
  });
});

describe('observation', () => {
  it('exposes a grid indexed by [y][x] and per player bomb availability', () => {
    const state = createGame({ seed: 3, playerCount: 3 });
    state.bombs.push({ id: 1, ownerId: 0, x: 1, y: 1, fuse: 20, range: 2 });
    const observation = buildObservation(state, 0);
    expect(observation.grid).toHaveLength(13);
    expect(observation.grid[0]).toHaveLength(15);
    expect(observation.grid[2]![2]).toBe(1);
    expect(observation.me).toMatchObject({ id: 0, x: 1, y: 1, bombsAvailable: 0 });
    expect(observation.players).toHaveLength(3);
    expect(observation.bombs[0]).toEqual({ x: 1, y: 1, ownerId: 0, ticksLeft: 20, range: 2 });
    expect(observation.items.every((item) => typeof item.type === 'string')).toBe(true);
  });
});

describe('harness', () => {
  it('seeds Math.random, freezes the clock, captures logs, and supports async bots', async () => {
    const source = `
      const seen = [];
      async function gameLoop(obs) {
        console.log('tick', obs.tick, Date.now());
        seen.push(Math.random());
        return { type: 'move', direction: 'down' };
      }
    `;
    const a = createVmController(source, 99);
    const b = createVmController(source, 99);
    const observation = buildObservation(createGame({ seed: 1, playerCount: 2 }), 0);
    const signal = new AbortController().signal;
    expect(await a.decide({ ...observation, tick: 10 }, signal, 240)).toEqual({
      type: 'move',
      direction: 'down',
    });
    expect(a.last!.logs).toEqual([{ level: 'log', message: 'tick 10 500' }]);
    await b.decide({ ...observation, tick: 10 }, signal, 240);
    const randomA = createVmController(`function gameLoop(){ return String(Math.random()) }`, 5);
    const randomB = createVmController(`function gameLoop(){ return String(Math.random()) }`, 5);
    expect(await randomA.decide(observation, signal, 240)).toBe(
      await randomB.decide(observation, signal, 240),
    );
  });

  it('reports thrown errors and missing gameLoop', async () => {
    const observation = buildObservation(createGame({ seed: 1, playerCount: 2 }), 0);
    const signal = new AbortController().signal;
    await expect(
      createVmController('function gameLoop(){ throw new TypeError("boom") }', 1).decide(
        observation,
        signal,
        240,
      ),
    ).rejects.toThrow('TypeError: boom');
    await expect(
      createVmController('const x = 1;', 1).decide(observation, signal, 240),
    ).rejects.toThrow(/gameLoop is not defined/);
  });

  it('resolves lexical gameLoop declarations', async () => {
    const controller = createVmController('const gameLoop = () => "PLANT BOMB";', 1);
    const observation = buildObservation(createGame({ seed: 1, playerCount: 2 }), 0);
    expect(await controller.decide(observation, new AbortController().signal, 240)).toBe(
      'PLANT BOMB',
    );
  });
});

describe('sample bots and match loop', () => {
  it('runs every sample bot and the starter without errors', async () => {
    for (const source of [STARTER_SOURCE, ...SAMPLE_BOTS.map((bot) => bot.source)]) {
      const state = createGame({ seed: 11, playerCount: 2, settings: { maxTicks: 400 } });
      const errors: unknown[] = [];
      await runMatch({
        state,
        controllers: [createVmController(source, 1), createVmController(source, 2)],
        tickMs: 0,
        decisionTimeoutMs: 1000,
        onDecisionError: (_, error) => errors.push(error),
      });
      expect(errors).toEqual([]);
      expect(state.status).toBe('finished');
    }
  });

  it('records an intent log that replays to the same final state', async () => {
    const bomber = getSampleBot('cautious-bomber')!.source;
    const walker = getSampleBot('random-walker')!.source;
    const seed = 2024;
    const state = createGame({ seed, playerCount: 4, settings: { maxTicks: 1200 } });
    const sources = [bomber, walker, bomber, walker];
    const { intents } = await runMatch({
      state,
      controllers: sources.map((source, id) => createVmController(source, botSeed(seed, id))),
      tickMs: 0,
      decisionTimeoutMs: 1000,
    });
    expect(intents.length).toBeGreaterThan(20);
    const replayed = runReplay({
      engineVersion: state.engineVersion,
      seed,
      playerCount: 4,
      settings: state.settings,
      intents,
    });
    expect(hashState(replayed)).toBe(hashState(state));
  });

  it('the cautious bomber survives its own bombs and usually beats random walkers', async () => {
    let bomberWins = 0;
    let bomberSelfKills = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const state = createGame({ seed, playerCount: 2, settings: { maxTicks: 2400 } });
      await runMatch({
        state,
        controllers: [
          createVmController(getSampleBot('cautious-bomber')!.source, seed),
          createVmController(getSampleBot('random-walker')!.source, seed + 100),
        ],
        tickMs: 0,
        decisionTimeoutMs: 1000,
      });
      if (state.result!.winnerId === 0) bomberWins++;
      if (!state.players[0]!.alive && state.players[0]!.killedBy === null) bomberSelfKills++;
    }
    expect(bomberSelfKills).toBeLessThanOrEqual(1);
    expect(bomberWins).toBeGreaterThanOrEqual(4);
  });

  it('never waits for a silent bot in real time and keeps the replay exact', async () => {
    const seed = 5;
    const state = createGame({ seed, playerCount: 2, settings: { maxTicks: 100 } });
    const silent = { decide: () => new Promise<never>(() => {}) };
    const timeouts: number[] = [];
    const started = performance.now();
    const { intents } = await runMatch({
      state,
      controllers: [silent, createVmController(getSampleBot('random-walker')!.source, 9)],
      tickMs: 5,
      decisionTimeoutMs: 20,
      onDecisionError: (id) => timeouts.push(id),
    });
    expect(performance.now() - started).toBeLessThan(100 * 5 + 400);
    expect(timeouts.length).toBeGreaterThanOrEqual(15);
    expect(timeouts.every((id) => id === 0)).toBe(true);
    expect(intents.some((intent) => intent.playerId === 1)).toBe(true);
    const replayed = runReplay({
      engineVersion: state.engineVersion,
      seed,
      playerCount: 2,
      settings: state.settings,
      intents,
    });
    expect(hashState(replayed)).toBe(hashState(state));
  });

  it('applies a decision on the tick it arrives, within the decision interval', async () => {
    const state = createGame({ seed: 1, playerCount: 2, settings: { maxTicks: 20 } });
    const delayed = {
      decide: () => new Promise((resolve) => setTimeout(() => resolve('MOVE DOWN'), 8)),
    };
    const { intents } = await runMatch({
      state,
      controllers: [delayed, null],
      tickMs: 10,
      decisionTimeoutMs: 200,
    });
    expect(intents).toHaveLength(4);
    for (const intent of intents) {
      expect(intent.tick % 5).toBeGreaterThan(0);
    }
  });

  it('drops late decisions and stops when aborted', async () => {
    const state = createGame({ seed: 1, playerCount: 2, settings: { maxTicks: 50 } });
    const slow = {
      decide: () => new Promise((resolve) => setTimeout(() => resolve('MOVE DOWN'), 50)),
    };
    const timeouts: number[] = [];
    await runMatch({
      state,
      controllers: [slow, null],
      tickMs: 0,
      decisionTimeoutMs: 5,
      onDecisionError: (id) => timeouts.push(id),
    });
    expect(timeouts.length).toBeGreaterThan(0);
    expect(state.players[0]!.y).toBe(1);

    const abort = new AbortController();
    const running = runMatch({
      state: createGame({ seed: 1, playerCount: 2 }),
      controllers: [null, null],
      tickMs: 5,
      decisionTimeoutMs: 5,
      signal: abort.signal,
    });
    abort.abort();
    await expect(running).rejects.toThrow();
    step(state);
  });
});
