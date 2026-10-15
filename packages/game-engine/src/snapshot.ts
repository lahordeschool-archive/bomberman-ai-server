import type { Direction, ItemType } from './constants.ts';
import { closingWarnings, playerScore } from './engine.ts';
import type { ClosingWarning, FlameKind, GameEvent, GameState, MatchResult } from './types.ts';

export interface SnapshotPlayer {
  id: number;
  x: number;
  y: number;
  /** Interpolated position in cells, for rendering. */
  px: number;
  py: number;
  facing: Direction;
  moving: boolean;
  alive: boolean;
  diedAtTick: number | null;
  bombCapacity: number;
  flameRange: number;
  speed: number;
  kills: number;
  score: number;
}

export interface Snapshot {
  tick: number;
  status: GameState['status'];
  width: number;
  height: number;
  theme: GameState['theme'];
  /** One digit per cell, row-major. */
  grid: string;
  players: SnapshotPlayer[];
  bombs: { id: number; x: number; y: number; ownerId: number; fuse: number }[];
  flames: { x: number; y: number; kind: FlameKind; ownerId: number }[];
  items: { x: number; y: number; type: ItemType }[];
  /** Tiles about to turn into hard walls. */
  closing: ClosingWarning[];
  events: GameEvent[];
  result: MatchResult | null;
}

export function toSnapshot(state: GameState, events: GameEvent[] = state.events): Snapshot {
  return {
    tick: state.tick,
    status: state.status,
    width: state.width,
    height: state.height,
    theme: state.theme,
    grid: state.grid.join(''),
    players: state.players.map((player) => {
      const move = player.move;
      const progress = move ? move.elapsed / move.duration : 0;
      return {
        id: player.id,
        x: player.x,
        y: player.y,
        px: move ? move.fromX + (move.toX - move.fromX) * progress : player.x,
        py: move ? move.fromY + (move.toY - move.fromY) * progress : player.y,
        facing: player.facing,
        moving: move !== null,
        alive: player.alive,
        diedAtTick: player.diedAtTick,
        bombCapacity: player.bombCapacity,
        flameRange: player.flameRange,
        speed: player.speed,
        kills: player.stats.kills,
        score: playerScore(player),
      };
    }),
    bombs: state.bombs.map(({ id, x, y, ownerId, fuse }) => ({ id, x, y, ownerId, fuse })),
    flames: state.flames.map(({ x, y, kind, ownerId }) => ({ x, y, kind, ownerId })),
    items: state.items.filter((item) => !item.hidden).map(({ x, y, type }) => ({ x, y, type })),
    closing: closingWarnings(state),
    events,
    result: state.result,
  };
}

export function parseGrid(grid: string): number[] {
  return Array.from(grid, (char) => Number(char));
}
