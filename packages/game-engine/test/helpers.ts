import { Cell, cellIndex, createGame, type GameState, type MatchSettings } from '../src/index.ts';

/** A game with every soft wall and item removed, for precise rule tests. */
export function emptyArena(
  playerCount = 2,
  settings: Partial<MatchSettings> = {},
  engineVersion?: number,
): GameState {
  const state = createGame({ seed: 1, playerCount, settings, engineVersion });
  state.grid = state.grid.map((cell) => (cell === Cell.Soft ? Cell.Floor : cell));
  state.items = [];
  return state;
}

export function setCell(state: GameState, x: number, y: number, value: number): void {
  state.grid[cellIndex(x, y, state.width)] = value;
}

export function stepN(state: GameState, ticks: number, step: (s: GameState) => unknown): void {
  for (let index = 0; index < ticks && state.status === 'running'; index++) step(state);
}
