import { ENGINE_VERSION, SUPPORTED_ENGINE_VERSIONS } from './constants.ts';
import { applyIntent, createGame, step } from './engine.ts';
import type { GameState, MatchSettings, RecordedIntent } from './types.ts';

export interface ReplayData {
  engineVersion: number;
  seed: number;
  playerCount: number;
  settings: MatchSettings;
  intents: RecordedIntent[];
}

/**
 * Re-simulates a match from its seed and accepted intents. Intents recorded for tick
 * `t` are applied, in recorded order, right before step `t`, exactly like the live loop.
 */
export function runReplay(data: ReplayData, onTick?: (state: GameState) => void): GameState {
  if (!SUPPORTED_ENGINE_VERSIONS.includes(data.engineVersion)) {
    throw new Error(
      `Replay was recorded with engine v${data.engineVersion}, this build runs v${ENGINE_VERSION}`,
    );
  }
  const state = createGame({
    seed: data.seed,
    playerCount: data.playerCount,
    settings: data.settings,
    engineVersion: data.engineVersion,
  });
  let cursor = 0;
  const intents = [...data.intents].sort((a, b) => a.tick - b.tick);
  while (state.status === 'running') {
    while (cursor < intents.length && intents[cursor]!.tick === state.tick) {
      const { playerId, intent } = intents[cursor]!;
      applyIntent(state, playerId, intent);
      cursor++;
    }
    step(state);
    onTick?.(state);
  }
  return state;
}
