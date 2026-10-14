import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  applyIntent,
  createGame,
  DIRECTIONS,
  ENGINE_VERSION,
  hashState,
  type Intent,
  OBSERVATION_INTERVAL_TICKS,
  type RecordedIntent,
  runReplay,
  step,
} from '../src/index.ts';

const intentArbitrary: fc.Arbitrary<Intent> = fc.oneof(
  fc.constantFrom(...DIRECTIONS).map((direction) => ({ type: 'move', direction }) as Intent),
  fc.constant<Intent>({ type: 'bomb' }),
  fc.constant<Intent>({ type: 'idle' }),
);

function simulateLive(
  seed: number,
  playerCount: number,
  decisions: Intent[][],
  maxTicks: number,
  engineVersion = ENGINE_VERSION,
) {
  const state = createGame({ seed, playerCount, settings: { maxTicks }, engineVersion });
  const log: RecordedIntent[] = [];
  let decision = 0;
  while (state.status === 'running') {
    if (state.tick % OBSERVATION_INTERVAL_TICKS === 0) {
      const round = decisions[decision++ % decisions.length] ?? [];
      for (let playerId = 0; playerId < playerCount; playerId++) {
        const intent = round[playerId];
        if (intent && applyIntent(state, playerId, intent)) {
          log.push({ tick: state.tick, playerId, intent });
        }
      }
    }
    step(state);
  }
  return { state, log };
}

describe('deterministic replay', () => {
  it('re-simulating the accepted intents reproduces the exact final state', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 0xffffffff }),
        fc.integer({ min: 2, max: 4 }),
        fc.array(fc.array(intentArbitrary, { minLength: 4, maxLength: 4 }), {
          minLength: 1,
          maxLength: 40,
        }),
        (seed, playerCount, decisions) => {
          const { state, log } = simulateLive(seed, playerCount, decisions, 600);
          const replayed = runReplay({
            engineVersion: ENGINE_VERSION,
            seed,
            playerCount,
            settings: state.settings,
            intents: log,
          });
          expect(hashState(replayed)).toBe(hashState(state));
          expect(replayed.result).toEqual(state.result);
        },
      ),
      { numRuns: 60 },
    );
  });

  it('detects tampered intent logs through the state hash', () => {
    const decisions: Intent[][] = [
      [
        { type: 'move', direction: 'right' },
        { type: 'move', direction: 'left' },
      ],
      [{ type: 'bomb' }, { type: 'move', direction: 'down' }],
      [{ type: 'move', direction: 'down' }, { type: 'bomb' }],
    ];
    const { state, log } = simulateLive(7, 2, decisions, 400);
    const tampered = log.map((entry, index) =>
      index === 1 ? { ...entry, intent: { type: 'idle' } as Intent } : entry,
    );
    const replayed = runReplay({
      engineVersion: ENGINE_VERSION,
      seed: 7,
      playerCount: 2,
      settings: state.settings,
      intents: tampered,
    });
    expect(hashState(replayed)).not.toBe(hashState(state));
  });

  it.each([1, 2, 3, 4, 5])(
    'still re-simulates matches recorded with engine v%i under its rules',
    (version) => {
      const decisions: Intent[][] = [
        [
          { type: 'move', direction: 'right' },
          { type: 'move', direction: 'left' },
        ],
        [{ type: 'move', direction: 'right' }, { type: 'bomb' }],
        [{ type: 'bomb' }, { type: 'move', direction: 'down' }],
      ];
      const live = simulateLive(11, 2, decisions, 400, version);
      const replay = {
        engineVersion: version,
        seed: 11,
        playerCount: 2,
        settings: live.state.settings,
        intents: live.log,
      };
      const replayed = runReplay(replay);
      expect(replayed.engineVersion).toBe(version);
      expect(hashState(replayed)).toBe(hashState(live.state));
    },
  );

  it('rejects replays recorded by another engine version', () => {
    expect(() =>
      runReplay({
        engineVersion: ENGINE_VERSION + 1,
        seed: 1,
        playerCount: 2,
        settings: createGame({ seed: 1, playerCount: 2 }).settings,
        intents: [],
      }),
    ).toThrow(/engine/);
  });
});
