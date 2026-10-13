export const ENGINE_VERSION = 1;

export const TICK_MS = 50;
export const GRID_WIDTH = 15;
export const GRID_HEIGHT = 13;
export const TILE_SIZE = 16;
export const MAX_PLAYERS = 4;
export const MIN_PLAYERS = 2;

/** Bots receive an observation every 5 ticks (250 ms), like the legacy client. */
export const OBSERVATION_INTERVAL_TICKS = 5;
export const BOMB_FUSE_TICKS = 50;
export const FLAME_TICKS = 10;
export const DEFAULT_MAX_TICKS = 3 * 60 * (1000 / TICK_MS);

export const SOFT_WALL_DENSITY = 0.85;
export const ITEM_CHANCE = 0.2;

export const MAX_BOMBS = 10;
export const MAX_FLAME_RANGE = 10;
export const MAX_SPEED = 6;
export const MIN_SPEED = 0;

export const Cell = {
  Floor: 0,
  Hard: 1,
  Soft: 2,
} as const;
export type CellValue = (typeof Cell)[keyof typeof Cell];

export const DIRECTIONS = ['up', 'down', 'left', 'right'] as const;
export type Direction = (typeof DIRECTIONS)[number];

export const DIRECTION_DELTAS: Record<Direction, { dx: number; dy: number }> = {
  up: { dx: 0, dy: -1 },
  down: { dx: 0, dy: 1 },
  left: { dx: -1, dy: 0 },
  right: { dx: 1, dy: 0 },
};

export const ITEM_TYPES = ['extraBomb', 'flameUp', 'maxFlame', 'speedUp', 'speedDown'] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

/** Sprite frame of each item in `snes_items.png`, which is also the legacy item id. */
export const ITEM_SPRITE_FRAMES: Record<ItemType, number> = {
  extraBomb: 0,
  flameUp: 1,
  maxFlame: 3,
  speedUp: 9,
  speedDown: 23,
};

/** Weighted draw table of the legacy server (`items_list`). */
export const ITEM_DRAW_TABLE: readonly ItemType[] = [
  ...Array<ItemType>(8).fill('extraBomb'),
  ...Array<ItemType>(7).fill('flameUp'),
  'maxFlame',
  ...Array<ItemType>(7).fill('speedUp'),
  ...Array<ItemType>(3).fill('speedDown'),
];

export const SPAWN_POINTS: readonly { x: number; y: number }[] = [
  { x: 1, y: 1 },
  { x: 13, y: 1 },
  { x: 1, y: 11 },
  { x: 13, y: 11 },
];

/** Cells kept free of soft walls so every player can move and escape its first bomb. */
export const SAFE_CELLS: readonly { x: number; y: number }[] = [
  { x: 1, y: 1 },
  { x: 2, y: 1 },
  { x: 1, y: 2 },
  { x: 13, y: 1 },
  { x: 12, y: 1 },
  { x: 13, y: 2 },
  { x: 1, y: 11 },
  { x: 2, y: 11 },
  { x: 1, y: 10 },
  { x: 13, y: 11 },
  { x: 12, y: 11 },
  { x: 13, y: 10 },
];

export const PLAYER_COLORS = ['white', 'black', 'blue', 'red'] as const;
export type PlayerColor = (typeof PLAYER_COLORS)[number];

export const SCORE_WEIGHTS = {
  kill: 100,
  wallDestroyed: 5,
  itemCollected: 10,
} as const;
