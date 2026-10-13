import {
  type Direction,
  type GameState,
  type ItemType,
  moveDurationTicks,
  OBSERVATION_INTERVAL_TICKS,
  TICK_MS,
} from '@bomberman/game-engine';

export const SDK_VERSION = 1;

export interface ObservedPlayer {
  id: number;
  x: number;
  y: number;
  alive: boolean;
  facing: Direction;
  /** Direction of the tile move in progress, or null when standing still. */
  moving: Direction | null;
  bombCapacity: number;
  bombsAvailable: number;
  flameRange: number;
  speed: number;
  /** Ticks this player needs to cross one tile. */
  ticksPerTile: number;
}

export interface Observation {
  sdkVersion: number;
  tick: number;
  tickMs: number;
  /** Ticks between two calls to `gameLoop`. */
  decisionIntervalTicks: number;
  maxTicks: number;
  width: number;
  height: number;
  /** `grid[y][x]`: 0 floor, 1 indestructible wall, 2 destructible wall. */
  grid: number[][];
  myId: number;
  me: ObservedPlayer;
  players: ObservedPlayer[];
  bombs: { x: number; y: number; ownerId: number; ticksLeft: number; range: number }[];
  flames: { x: number; y: number; ticksLeft: number }[];
  items: { x: number; y: number; type: ItemType }[];
}

export function buildObservation(state: GameState, playerId: number): Observation {
  const grid: number[][] = [];
  for (let y = 0; y < state.height; y++) {
    grid.push(state.grid.slice(y * state.width, (y + 1) * state.width));
  }
  const players = state.players.map((player): ObservedPlayer => {
    const active = state.bombs.filter((bomb) => bomb.ownerId === player.id).length;
    return {
      id: player.id,
      x: player.x,
      y: player.y,
      alive: player.alive,
      facing: player.facing,
      moving: player.move?.direction ?? null,
      bombCapacity: player.bombCapacity,
      bombsAvailable: Math.max(0, player.bombCapacity - active),
      flameRange: player.flameRange,
      speed: player.speed,
      ticksPerTile: moveDurationTicks(player.speed),
    };
  });
  return {
    sdkVersion: SDK_VERSION,
    tick: state.tick,
    tickMs: TICK_MS,
    decisionIntervalTicks: OBSERVATION_INTERVAL_TICKS,
    maxTicks: state.settings.maxTicks,
    width: state.width,
    height: state.height,
    grid,
    myId: playerId,
    me: players[playerId]!,
    players,
    bombs: state.bombs.map(({ x, y, ownerId, fuse, range }) => ({
      x,
      y,
      ownerId,
      ticksLeft: fuse,
      range,
    })),
    flames: state.flames.map(({ x, y, ticksLeft }) => ({ x, y, ticksLeft })),
    items: state.items.filter((item) => !item.hidden).map(({ x, y, type }) => ({ x, y, type })),
  };
}
