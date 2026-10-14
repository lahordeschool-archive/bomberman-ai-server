/**
 * v1: every bot plays every 5 ticks and speed only shortens moves.
 * v2: speed sets each player's own turn interval (`TURN_TICKS_BY_SPEED_V2`).
 * v3: same rules at the legacy pace (`TURN_TICKS_BY_SPEED`).
 * v4: v3 plus tiebreakers on equal scores (kills, then walls, then items).
 * v5: v4 plus seeded arena width and scene variations.
 * v6: v5 plus hard-wall arena shrinking after each of the first two minutes.
 */
export const ENGINE_VERSION = 6;
/** Versions `runReplay` can still re-simulate. */
export const SUPPORTED_ENGINE_VERSIONS: readonly number[] = [1, 2, 3, 4, 5, 6];

export const TICK_MS = 50;
export const GRID_WIDTH = 15;
export const GRID_HEIGHT = 13;
/** Odd widths preserve the classic alternating pillar layout. */
export const ARENA_WIDTHS: readonly number[] = [11, 13, 15, 17];
export const ARENA_THEMES = ['grass', 'cave', 'water'] as const;
export type ArenaTheme = (typeof ARENA_THEMES)[number];
export const TILE_SIZE = 16;
export const MAX_PLAYERS = 4;
export const MIN_PLAYERS = 2;

/** Engine v1 turn interval, for every player: an observation every 5 ticks (250 ms). */
export const OBSERVATION_INTERVAL_TICKS = 5;
/**
 * Turn interval per speed level, which is also the time to cross one tile: 400 ms
 * slowed down, 300 ms at the start (the legacy pace), then 250 and 200 ms with
 * roller skates.
 */
export const TURN_TICKS_BY_SPEED: readonly number[] = [8, 6, 5, 4];
/** Engine v2 turn intervals (400, 250, 200, 150 ms), kept for its replays. */
export const TURN_TICKS_BY_SPEED_V2: readonly number[] = [8, 5, 4, 3];
export const BOMB_FUSE_TICKS = 50;
export const FLAME_TICKS = 10;
export const DEFAULT_MAX_TICKS = 3 * 60 * (1000 / TICK_MS);
/** Engine v6 closes one complete outer ring at one and two minutes. */
export const ARENA_SHRINK_INTERVAL_TICKS = 60 * (1000 / TICK_MS);
export const ARENA_SHRINK_RINGS = 2;

export const SOFT_WALL_DENSITY = 0.85;
export const ITEM_CHANCE = 0.2;

export const MAX_BOMBS = 10;
export const MAX_FLAME_RANGE = 10;
/** Speed cap of engine v1; later versions cap at the last turn table level. */
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
