import {
  ARENA_SHRINK_INTERVAL_TICKS,
  ARENA_SHRINK_RINGS,
  ARENA_SHRINK_TILE_TICKS,
  Cell,
  GRID_HEIGHT,
  GRID_WIDTH,
  ITEM_CHANCE,
  ITEM_DRAW_TABLE,
  SOFT_WALL_DENSITY,
} from './constants.ts';
import { nextRandom, randomInt } from './rng.ts';
import type { ClosingTile, ItemState } from './types.ts';

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

/** The cells of the ring `inset` tiles in from the border, clockwise from its top left. */
export function ringCells(inset: number, width = GRID_WIDTH, height = GRID_HEIGHT) {
  const left = inset;
  const right = width - 1 - inset;
  const top = inset;
  const bottom = height - 1 - inset;
  const cells: { x: number; y: number }[] = [];
  for (let x = left; x <= right; x++) cells.push({ x, y: top });
  for (let y = top + 1; y <= bottom; y++) cells.push({ x: right, y });
  for (let x = right - 1; x >= left; x--) cells.push({ x, y: bottom });
  for (let y = bottom - 1; y > top; y--) cells.push({ x: left, y });
  return cells;
}

const schedules = new Map<string, readonly ClosingTile[]>();

/**
 * Engine v7 closing order: ring `n` starts closing at `n` minutes, one tile every
 * `ARENA_SHRINK_TILE_TICKS`. `tick` is the state tick right after the tile closes.
 */
export function closingSchedule(width = GRID_WIDTH, height = GRID_HEIGHT): readonly ClosingTile[] {
  const key = `${width}x${height}`;
  let schedule = schedules.get(key);
  if (!schedule) {
    schedule = Array.from({ length: ARENA_SHRINK_RINGS }, (_, ring) => {
      const inset = ring + 1;
      const cells = ringCells(inset, width, height);
      return cells.map(({ x, y }, order) => ({
        x,
        y,
        inset,
        tick: inset * ARENA_SHRINK_INTERVAL_TICKS + order * ARENA_SHRINK_TILE_TICKS,
        ringEnd: order === cells.length - 1,
      }));
    }).flat();
    schedules.set(key, schedule);
  }
  return schedule;
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
