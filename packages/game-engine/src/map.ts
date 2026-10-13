import {
  Cell,
  GRID_HEIGHT,
  GRID_WIDTH,
  ITEM_CHANCE,
  ITEM_DRAW_TABLE,
  SAFE_CELLS,
  SOFT_WALL_DENSITY,
} from './constants.ts';
import { nextRandom, randomInt } from './rng.ts';
import type { ItemState } from './types.ts';

export function cellIndex(x: number, y: number, width = GRID_WIDTH): number {
  return y * width + x;
}

export function isInside(x: number, y: number, width = GRID_WIDTH, height = GRID_HEIGHT): boolean {
  return x >= 0 && y >= 0 && x < width && y < height;
}

/** Border cells and every cell with even x and even y are indestructible pillars. */
export function isHardWallCell(x: number, y: number): boolean {
  if (x === 0 || y === 0 || x === GRID_WIDTH - 1 || y === GRID_HEIGHT - 1) return true;
  return x % 2 === 0 && y % 2 === 0;
}

export function generateMap(state: { rng: number }): { grid: number[]; items: ItemState[] } {
  const safe = new Set(SAFE_CELLS.map(({ x, y }) => cellIndex(x, y)));
  const grid: number[] = [];
  for (let y = 0; y < GRID_HEIGHT; y++) {
    for (let x = 0; x < GRID_WIDTH; x++) {
      if (isHardWallCell(x, y)) grid.push(Cell.Hard);
      else if (!safe.has(cellIndex(x, y)) && nextRandom(state) < SOFT_WALL_DENSITY)
        grid.push(Cell.Soft);
      else grid.push(Cell.Floor);
    }
  }

  const items: ItemState[] = [];
  for (let y = 0; y < GRID_HEIGHT; y++) {
    for (let x = 0; x < GRID_WIDTH; x++) {
      if (grid[cellIndex(x, y)] !== Cell.Soft) continue;
      if (nextRandom(state) < ITEM_CHANCE) {
        const type = ITEM_DRAW_TABLE[randomInt(state, ITEM_DRAW_TABLE.length)]!;
        items.push({ x, y, type, hidden: true });
      }
    }
  }
  return { grid, items };
}
