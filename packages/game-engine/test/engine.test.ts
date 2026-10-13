import { describe, expect, it } from 'vitest';
import {
  applyIntent,
  BOMB_FUSE_TICKS,
  Cell,
  cellIndex,
  createGame,
  FLAME_TICKS,
  MAX_FLAME_RANGE,
  maxSpeed,
  moveDurationTicks,
  OBSERVATION_INTERVAL_TICKS,
  step,
  TURN_TICKS_BY_SPEED,
  toSnapshot,
  turnTicks,
} from '../src/index.ts';
import { emptyArena, setCell, stepN } from './helpers.ts';

describe('movement', () => {
  it('moves one tile using the speed based duration and switches cell halfway', () => {
    const state = emptyArena();
    const duration = moveDurationTicks(state.players[0]!.speed);
    applyIntent(state, 0, { type: 'move', direction: 'right' });
    step(state);
    expect(state.players[0]!.move).not.toBeNull();
    stepN(state, Math.ceil(duration / 2) - 1, step);
    expect(state.players[0]!.x).toBe(2);
    stepN(state, duration, step);
    expect(state.players[0]!.move).toBeNull();
    expect(state.players[0]!).toMatchObject({ x: 2, y: 1, facing: 'right' });
  });

  it('refuses to move into hard walls, soft walls, bombs, and outside the grid', () => {
    const state = emptyArena();
    applyIntent(state, 0, { type: 'move', direction: 'up' });
    step(state);
    expect(state.players[0]!.move).toBeNull();
    expect(state.players[0]!.facing).toBe('up');

    setCell(state, 2, 1, Cell.Soft);
    applyIntent(state, 0, { type: 'move', direction: 'right' });
    step(state);
    expect(state.players[0]!.move).toBeNull();

    setCell(state, 2, 1, Cell.Floor);
    state.bombs.push({ id: 99, ownerId: 1, x: 2, y: 1, fuse: 40, range: 1 });
    applyIntent(state, 0, { type: 'move', direction: 'right' });
    step(state);
    expect(state.players[0]!.move).toBeNull();
  });

  it('lets a player walk off the bomb it just planted', () => {
    const state = emptyArena();
    applyIntent(state, 0, { type: 'bomb' });
    step(state);
    applyIntent(state, 0, { type: 'move', direction: 'right' });
    stepN(state, 10, step);
    expect(state.players[0]!.x).toBe(2);
  });

  it('idle cancels a queued move', () => {
    const state = emptyArena();
    applyIntent(state, 0, { type: 'move', direction: 'right' });
    applyIntent(state, 0, { type: 'idle' });
    step(state);
    expect(state.players[0]!.move).toBeNull();
  });

  it('speed sets the turn interval, and a move ends one tick before the next turn', () => {
    expect([0, 1, 2, 3].map((speed) => turnTicks(speed))).toEqual([...TURN_TICKS_BY_SPEED]);
    expect(turnTicks(1)).toBe(6);
    expect(turnTicks(100)).toBe(4);
    expect([0, 1, 2, 3].map((speed) => turnTicks(speed, 2))).toEqual([8, 5, 4, 3]);
    for (let speed = 0; speed <= maxSpeed(); speed++) {
      expect(moveDurationTicks(speed)).toBe(turnTicks(speed) - 1);
    }
  });

  it('keeps the engine v1 timings for old replays', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map((speed) => moveDurationTicks(speed, 1))).toEqual([
      6, 6, 5, 5, 4, 4, 4,
    ]);
    expect(turnTicks(6, 1)).toBe(OBSERVATION_INTERVAL_TICKS);
    expect(maxSpeed(1)).toBe(6);
  });

  it('a bot answering one tick late is still standing on its new tile at its next turn', () => {
    const state = emptyArena();
    const ticks = turnTicks(state.players[0]!.speed);
    for (let turn = 0; turn < 3; turn++) {
      step(state);
      applyIntent(state, 0, { type: 'move', direction: 'right' });
      stepN(state, ticks - 1, step);
      expect(state.players[0]!).toMatchObject({ x: 2 + turn, move: null });
    }
  });
});

describe('bombs and flames', () => {
  it('respects bomb capacity and one bomb per cell', () => {
    const state = emptyArena(2, { bombs: 1 });
    applyIntent(state, 0, { type: 'bomb' });
    step(state);
    applyIntent(state, 0, { type: 'bomb' });
    step(state);
    expect(state.bombs).toHaveLength(1);
    expect(state.players[0]!.stats.bombsPlaced).toBe(1);
  });

  it('explodes after the fuse, stops at hard walls, and destroys the first soft wall', () => {
    const state = emptyArena(2, { flames: 3 });
    state.players[0]!.x = 1;
    state.players[0]!.y = 3;
    setCell(state, 3, 3, Cell.Soft);
    setCell(state, 4, 3, Cell.Soft);
    state.items.push({ x: 3, y: 3, type: 'flameUp', hidden: true });
    applyIntent(state, 0, { type: 'bomb' });
    step(state);
    state.players[0]!.x = 5;
    state.players[0]!.y = 5;
    stepN(state, BOMB_FUSE_TICKS - 1, step);
    expect(state.bombs).toHaveLength(0);
    const flameCells = state.flames.map((flame) => `${flame.x},${flame.y}`).sort();
    expect(flameCells).toEqual(['1,1', '1,2', '1,3', '1,4', '1,5', '1,6', '2,3'].sort());
    expect(state.grid[cellIndex(3, 3)]).toBe(Cell.Floor);
    expect(state.grid[cellIndex(4, 3)]).toBe(Cell.Soft);
    expect(state.items[0]!.hidden).toBe(false);
    expect(state.players[0]!.stats.wallsDestroyed).toBe(1);
    expect(state.flames.find((flame) => flame.x === 1 && flame.y === 6)!.kind).toBe('endDown');
  });

  it('chains explosions instantly and removes flames after their lifetime', () => {
    const state = emptyArena(2, { flames: 2 });
    state.bombs.push({ id: 50, ownerId: 0, x: 3, y: 1, fuse: 1, range: 2 });
    state.bombs.push({ id: 51, ownerId: 1, x: 5, y: 1, fuse: 40, range: 2 });
    state.players[0]!.x = 1;
    state.players[0]!.y = 9;
    state.players[1]!.x = 13;
    state.players[1]!.y = 9;
    step(state);
    expect(state.bombs).toHaveLength(0);
    expect(state.flames.some((flame) => flame.x === 7 && flame.y === 1)).toBe(true);
    stepN(state, FLAME_TICKS, step);
    expect(state.flames).toHaveLength(0);
  });

  it('kills players in flames, credits the bomb owner, and ends the match', () => {
    const state = emptyArena(2);
    state.players[1]!.x = 3;
    state.players[1]!.y = 1;
    state.bombs.push({ id: 7, ownerId: 0, x: 2, y: 1, fuse: 1, range: 2 });
    state.players[0]!.x = 1;
    state.players[0]!.y = 5;
    step(state);
    expect(state.players[1]!.alive).toBe(false);
    expect(state.players[1]!.killedBy).toBe(0);
    expect(state.players[0]!.stats.kills).toBe(1);
    expect(state.status).toBe('finished');
    expect(state.result!.winnerId).toBe(0);
    expect(state.result!.reason).toBe('lastStanding');
  });

  it('does not credit self kills and records a draw when everyone dies together', () => {
    const state = emptyArena(2);
    state.players[1]!.x = 2;
    state.players[1]!.y = 1;
    state.bombs.push({ id: 7, ownerId: 0, x: 1, y: 1, fuse: 1, range: 2 });
    step(state);
    expect(state.players[0]!.killedBy).toBeNull();
    expect(state.players[0]!.stats.kills).toBe(1);
    expect(state.result!.winnerId).toBeNull();
    expect(state.result!.players.map((player) => player.placement)).toEqual([1, 1]);
  });
});

describe('items', () => {
  it('applies power ups with caps', () => {
    const state = emptyArena();
    state.items.push(
      { x: 2, y: 1, type: 'extraBomb', hidden: false },
      { x: 3, y: 1, type: 'maxFlame', hidden: false },
      { x: 4, y: 1, type: 'speedDown', hidden: false },
    );
    for (let index = 0; index < 3; index++) {
      applyIntent(state, 0, { type: 'move', direction: 'right' });
      stepN(state, 8, step);
    }
    const player = state.players[0]!;
    expect(player.bombCapacity).toBe(2);
    expect(player.flameRange).toBe(MAX_FLAME_RANGE);
    expect(player.speed).toBe(0);
    expect(player.collected).toEqual(['extraBomb', 'maxFlame', 'speedDown']);
    expect(turnTicks(player.speed)).toBeGreaterThan(turnTicks(1));
  });

  it('caps roller skates at the fastest turn interval', () => {
    const state = emptyArena();
    for (let x = 2; x <= 6; x++) state.items.push({ x, y: 1, type: 'speedUp', hidden: false });
    for (let index = 0; index < 5; index++) {
      applyIntent(state, 0, { type: 'move', direction: 'right' });
      stepN(state, 8, step);
    }
    const player = state.players[0]!;
    expect(player.x).toBe(6);
    expect(player.speed).toBe(maxSpeed());
    expect(player.stats.itemsCollected).toBe(5);
  });

  it('scatters a dead player collected items on free cells', () => {
    const state = emptyArena(3);
    state.players[2]!.collected = ['extraBomb', 'speedUp'];
    state.players[2]!.x = 3;
    state.players[2]!.y = 1;
    state.bombs.push({ id: 1, ownerId: 0, x: 3, y: 2, fuse: 1, range: 1 });
    step(state);
    expect(state.players[2]!.alive).toBe(false);
    const visible = state.items.filter((item) => !item.hidden).map((item) => item.type);
    expect(visible.sort()).toEqual(['extraBomb', 'speedUp']);
    for (const item of state.items) {
      expect(state.grid[cellIndex(item.x, item.y)]).toBe(Cell.Floor);
    }
  });
});

describe('timeouts and scoring', () => {
  it('ends at max ticks and ranks survivors by score', () => {
    const state = emptyArena(3, { maxTicks: 30 });
    state.players[1]!.stats.wallsDestroyed = 4;
    state.players[2]!.alive = false;
    state.players[2]!.diedAtTick = 3;
    stepN(state, 40, step);
    expect(state.status).toBe('finished');
    expect(state.tick).toBe(30);
    expect(state.result).toMatchObject({ reason: 'timeout', winnerId: 1, endTick: 29 });
    expect(state.result!.players.map((player) => player.placement)).toEqual([2, 1, 3]);
  });

  it('snapshots expose interpolated positions and only visible items', () => {
    const state = createGame({ seed: 42, playerCount: 4 });
    applyIntent(state, 0, { type: 'move', direction: 'right' });
    step(state);
    step(state);
    const snapshot = toSnapshot(state);
    expect(snapshot.grid).toHaveLength(15 * 13);
    expect(snapshot.players[0]!.px).toBeGreaterThan(1);
    expect(snapshot.players[0]!.px).toBeLessThan(2);
    expect(snapshot.items.length).toBe(state.items.filter((item) => !item.hidden).length);
  });
});
