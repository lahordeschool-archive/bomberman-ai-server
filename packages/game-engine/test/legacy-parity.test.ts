import { describe, expect, it } from 'vitest';
import {
  Cell,
  cellIndex,
  createGame,
  DEFAULT_SETTINGS,
  GRID_HEIGHT,
  GRID_WIDTH,
  ITEM_DRAW_TABLE,
  isHardWallCell,
  SAFE_CELLS,
  SPAWN_POINTS,
} from '../src/index.ts';

/** Rules captured from the legacy `main.js` and `game.js` (see docs/legacy-protocol.md). */
describe('legacy rule parity', () => {
  it('keeps the 15 x 13 pillar layout of the legacy empty stage', () => {
    const legacyRow = (y: number) =>
      y === 0 || y === 12
        ? Array(15).fill(1)
        : y % 2 === 1
          ? [1, ...Array(13).fill(0), 1]
          : [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1];
    for (let y = 0; y < GRID_HEIGHT; y++) {
      for (let x = 0; x < GRID_WIDTH; x++) {
        expect(isHardWallCell(x, y) ? 1 : 0).toBe(legacyRow(y)[x]);
      }
    }
  });

  it('never puts soft walls on spawn cells and their inward neighbours', () => {
    for (let seed = 0; seed < 50; seed++) {
      const state = createGame({ seed, playerCount: 4, engineVersion: 4 });
      for (const { x, y } of SAFE_CELLS) expect(state.grid[cellIndex(x, y)]).toBe(Cell.Floor);
    }
  });

  it('uses the legacy spawn corners and lobby defaults', () => {
    expect(SPAWN_POINTS.map(({ x, y }) => [x * 16 + 8, y * 16 + 8])).toEqual([
      [24, 24],
      [216, 24],
      [24, 184],
      [216, 184],
    ]);
    expect(DEFAULT_SETTINGS).toMatchObject({ bombs: 1, flames: 2, speed: 1 });
  });

  it('fills about 85% of free cells with soft walls and hides items in about 20%', () => {
    let free = 0;
    let soft = 0;
    let items = 0;
    for (let seed = 0; seed < 200; seed++) {
      const state = createGame({ seed, playerCount: 2, engineVersion: 4 });
      state.grid.forEach((cell, index) => {
        const x = index % GRID_WIDTH;
        const y = Math.floor(index / GRID_WIDTH);
        if (isHardWallCell(x, y) || SAFE_CELLS.some((c) => c.x === x && c.y === y)) return;
        free++;
        if (cell === Cell.Soft) soft++;
      });
      items += state.items.length;
      for (const item of state.items) {
        expect(item.hidden).toBe(true);
        expect(state.grid[cellIndex(item.x, item.y)]).toBe(Cell.Soft);
      }
    }
    expect(soft / free).toBeGreaterThan(0.82);
    expect(soft / free).toBeLessThan(0.88);
    expect(items / soft).toBeGreaterThan(0.17);
    expect(items / soft).toBeLessThan(0.23);
  });

  it('draws items from the legacy weighted table', () => {
    const counts = Object.groupBy(ITEM_DRAW_TABLE, (item) => item);
    expect(counts.extraBomb).toHaveLength(8);
    expect(counts.flameUp).toHaveLength(7);
    expect(counts.maxFlame).toHaveLength(1);
    expect(counts.speedUp).toHaveLength(7);
    expect(counts.speedDown).toHaveLength(3);
  });

  it('generates the same map for the same seed and different maps for different seeds', () => {
    const a = createGame({ seed: 123, playerCount: 4, engineVersion: 4 });
    const b = createGame({ seed: 123, playerCount: 4, engineVersion: 4 });
    const c = createGame({ seed: 124, playerCount: 4, engineVersion: 4 });
    expect(a.grid).toEqual(b.grid);
    expect(a.items).toEqual(b.items);
    expect(a.grid).not.toEqual(c.grid);
  });
});
