import type { Direction, ItemType } from './constants.ts';

export interface MatchSettings {
  /** Initial bomb capacity per player. */
  bombs: number;
  /** Initial flame range per player. */
  flames: number;
  /** Initial speed level per player. */
  speed: number;
  /** Ticks before the match is decided by timeout. */
  maxTicks: number;
}

export type Intent = { type: 'move'; direction: Direction } | { type: 'bomb' } | { type: 'idle' };

export interface PlayerStats {
  kills: number;
  bombsPlaced: number;
  wallsDestroyed: number;
  itemsCollected: number;
}

export interface PlayerMove {
  direction: Direction;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  elapsed: number;
  duration: number;
}

export interface PlayerState {
  id: number;
  /** Logical cell. Switches to the destination halfway through a move. */
  x: number;
  y: number;
  facing: Direction;
  alive: boolean;
  bombCapacity: number;
  flameRange: number;
  speed: number;
  move: PlayerMove | null;
  queuedMove: Direction | null;
  queuedBomb: boolean;
  diedAtTick: number | null;
  killedBy: number | null;
  collected: ItemType[];
  stats: PlayerStats;
}

export interface BombState {
  id: number;
  ownerId: number;
  x: number;
  y: number;
  fuse: number;
  range: number;
}

export type FlameKind =
  'center' | 'horizontal' | 'vertical' | 'endUp' | 'endDown' | 'endLeft' | 'endRight';

export interface FlameState {
  x: number;
  y: number;
  ownerId: number;
  kind: FlameKind;
  ticksLeft: number;
}

export interface ItemState {
  x: number;
  y: number;
  type: ItemType;
  /** Items start hidden under soft walls and are revealed when the wall is destroyed. */
  hidden: boolean;
}

export type GameEvent =
  | { type: 'bombPlaced'; bombId: number; ownerId: number; x: number; y: number }
  | { type: 'bombExploded'; bombId: number; ownerId: number; x: number; y: number }
  | { type: 'wallDestroyed'; x: number; y: number; by: number }
  | { type: 'itemCollected'; x: number; y: number; item: ItemType; playerId: number }
  | { type: 'itemDestroyed'; x: number; y: number; item: ItemType }
  | { type: 'playerDied'; playerId: number; killedBy: number | null }
  | { type: 'matchEnded'; winnerId: number | null; reason: 'lastStanding' | 'timeout' };

export interface PlayerResult {
  playerId: number;
  placement: number;
  score: number;
  alive: boolean;
  diedAtTick: number | null;
  stats: PlayerStats;
}

export interface MatchResult {
  winnerId: number | null;
  reason: 'lastStanding' | 'timeout';
  endTick: number;
  players: PlayerResult[];
}

export interface GameState {
  engineVersion: number;
  seed: number;
  rng: number;
  tick: number;
  settings: MatchSettings;
  width: number;
  height: number;
  /** Row-major cell values, index = y * width + x. */
  grid: number[];
  players: PlayerState[];
  bombs: BombState[];
  flames: FlameState[];
  items: ItemState[];
  nextBombId: number;
  status: 'running' | 'finished';
  result: MatchResult | null;
  /** Events emitted by the most recent step. */
  events: GameEvent[];
}

export interface RecordedIntent {
  tick: number;
  playerId: number;
  intent: Intent;
}
