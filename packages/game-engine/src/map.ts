import {
  Cell,
  GRID_HEIGHT,
  GRID_WIDTH,
  ITEM_CHANCE,
  ITEM_DRAW_TABLE,
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
export function isHardWallCell(
  x: number,
  y: number,
  width = GRID_WIDTH,
  height = GRID_HEIGHT,
): boolean {
  if (x === 0 || y === 0 || x === width - 1 || y === height - 1) return true;
  return x % 2 === 0 && y % 2 === 0;
}

export function spawnPoints(width = GRID_WIDTH, height = GRID_HEIGHT): { x: number; y: number }[] {
  return [
    { x: 1, y: 1 },
    { x: width - 2, y: 1 },
    { x: 1, y: height - 2 },
    { x: width - 2, y: height - 2 },
  ];
}

export function safeCells(width = GRID_WIDTH, height = GRID_HEIGHT): { x: number; y: number }[] {
  return spawnPoints(width, height).flatMap(({ x, y }) => [
    { x, y },
    { x: x === 1 ? x + 1 : x - 1, y },
    { x, y: y === 1 ? y + 1 : y - 1 },
  ]);
}

export function generateMap(
  state: { rng: number },
  width = GRID_WIDTH,
  height = GRID_HEIGHT,
): { grid: number[]; items: ItemState[] } {
  const safe = new Set(safeCells(width, height).map(({ x, y }) => cellIndex(x, y, width)));
  const grid: number[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (isHardWallCell(x, y, width, height)) grid.push(Cell.Hard);
      else if (!safe.has(cellIndex(x, y, width)) && nextRandom(state) < SOFT_WALL_DENSITY)
        grid.push(Cell.Soft);
      else grid.push(Cell.Floor);
    }
  }

  const items: ItemState[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (grid[cellIndex(x, y, width)] !== Cell.Soft) continue;
      if (nextRandom(state) < ITEM_CHANCE) {
        const type = ITEM_DRAW_TABLE[randomInt(state, ITEM_DRAW_TABLE.length)]!;
        items.push({ x, y, type, hidden: true });
      }
    }
  }
  return { grid, items };
}
