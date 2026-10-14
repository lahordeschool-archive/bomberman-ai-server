import type { GameState } from './types.ts';

/** FNV-1a over the canonical JSON of the simulation-relevant state. */
export function hashState(state: GameState): string {
  const canonical = JSON.stringify({
    v: state.engineVersion,
    seed: state.seed,
    rng: state.rng,
    tick: state.tick,
    width: state.width,
    height: state.height,
    theme: state.theme,
    grid: state.grid,
    players: state.players,
    bombs: state.bombs,
    flames: state.flames,
    items: state.items,
    status: state.status,
    result: state.result,
  });
  let hash = 0x811c9dc5;
  for (let index = 0; index < canonical.length; index++) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
