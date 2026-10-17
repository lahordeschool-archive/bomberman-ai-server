import {
  ARENA_SHRINK_INTERVAL_TICKS,
  ARENA_SHRINK_RINGS,
  ARENA_SHRINK_WARNING_TICKS,
  ARENA_THEMES,
  ARENA_WIDTHS,
  BOMB_FUSE_TICKS,
  Cell,
  DEFAULT_MAX_TICKS,
  DIRECTION_DELTAS,
  DIRECTIONS,
  ENGINE_VERSION,
  FLAME_TICKS,
  GRID_HEIGHT,
  GRID_WIDTH,
  MAX_BOMBS,
  MAX_FLAME_RANGE,
  MAX_PLAYERS,
  MAX_SPEED,
  MIN_PLAYERS,
  MIN_SPEED,
  SCORE_WEIGHTS,
  OBSERVATION_INTERVAL_TICKS,
  SUPPORTED_ENGINE_VERSIONS,
  TICK_MS,
  TURN_TICKS_BY_SPEED,
  TURN_TICKS_BY_SPEED_V2,
  type Direction,
  type ItemType,
} from './constants.ts';
import { cellIndex, closingSchedule, generateMap, isInside, spawnPoints } from './map.ts';
import { normalizeSeed, randomInt } from './rng.ts';
import type {
  BombState,
  ClosingTile,
  ClosingWarning,
  FlameKind,
  GameEvent,
  GameState,
  Intent,
  MatchResult,
  MatchSettings,
  PlayerResult,
  PlayerState,
} from './types.ts';

export const DEFAULT_SETTINGS: MatchSettings = {
  bombs: 1,
  flames: 2,
  speed: 1,
  maxTicks: DEFAULT_MAX_TICKS,
};

export interface CreateGameOptions {
  seed: number;
  playerCount: number;
  settings?: Partial<MatchSettings>;
  /** Rules to simulate; only replays of older matches pass an older version. */
  engineVersion?: number;
}

export function normalizeSettings(settings: Partial<MatchSettings> = {}): MatchSettings {
  const merged = { ...DEFAULT_SETTINGS, ...settings };
  return {
    bombs: clampInt(merged.bombs, 1, MAX_BOMBS),
    flames: clampInt(merged.flames, 1, MAX_FLAME_RANGE),
    speed: clampInt(merged.speed, MIN_SPEED, MAX_SPEED),
    maxTicks: clampInt(merged.maxTicks, 20, 20 * 60 * 20),
  };
}

export function createGame({
  seed,
  playerCount,
  settings,
  engineVersion = ENGINE_VERSION,
}: CreateGameOptions): GameState {
  if (!Number.isInteger(playerCount) || playerCount < MIN_PLAYERS || playerCount > MAX_PLAYERS) {
    throw new RangeError(`playerCount must be between ${MIN_PLAYERS} and ${MAX_PLAYERS}`);
  }
  if (!SUPPORTED_ENGINE_VERSIONS.includes(engineVersion)) {
    throw new RangeError(`Engine v${engineVersion} is not supported by this build`);
  }
  const normalized = normalizeSettings(settings);
  const rngState = { rng: normalizeSeed(seed) };
  const variedArena = engineVersion >= 5;
  const width = variedArena ? ARENA_WIDTHS[randomInt(rngState, ARENA_WIDTHS.length)]! : GRID_WIDTH;
  const theme = variedArena
    ? ARENA_THEMES[randomInt(rngState, ARENA_THEMES.length)]!
    : ARENA_THEMES[0];
  const { grid, items } = generateMap(rngState, width, GRID_HEIGHT);
  const spawns = spawnPoints(width, GRID_HEIGHT);
  const players: PlayerState[] = [];
  for (let id = 0; id < playerCount; id++) {
    const spawn = spawns[id]!;
    players.push({
      id,
      x: spawn.x,
      y: spawn.y,
      facing: 'down',
      alive: true,
      bombCapacity: normalized.bombs,
      flameRange: normalized.flames,
      speed: Math.min(normalized.speed, maxSpeed(engineVersion)),
      move: null,
      queuedMove: null,
      queuedBomb: false,
      diedAtTick: null,
      killedBy: null,
      collected: [],
      stats: { kills: 0, bombsPlaced: 0, wallsDestroyed: 0, itemsCollected: 0 },
    });
  }
  return {
    engineVersion,
    seed: normalizeSeed(seed),
    rng: rngState.rng,
    tick: 0,
    settings: normalized,
    width,
    height: GRID_HEIGHT,
    theme,
    grid,
    players,
    bombs: [],
    flames: [],
    items,
    nextBombId: 1,
    status: 'running',
    result: null,
    events: [],
  };
}

export function cloneState(state: GameState): GameState {
  return structuredClone(state);
}

const turnTable = (engineVersion: number) =>
  engineVersion === 2 ? TURN_TICKS_BY_SPEED_V2 : TURN_TICKS_BY_SPEED;

export function maxSpeed(engineVersion: number = ENGINE_VERSION): number {
  return engineVersion === 1 ? MAX_SPEED : turnTable(engineVersion).length - 1;
}

/** Ticks between two decisions of a player with this speed. */
export function turnTicks(speed: number, engineVersion: number = ENGINE_VERSION): number {
  if (engineVersion === 1) return OBSERVATION_INTERVAL_TICKS;
  const table = turnTable(engineVersion);
  return table[clampInt(speed, MIN_SPEED, table.length - 1)]!;
}

/**
 * Ticks needed to cross one tile. Since v2 a move ends one tick before the next turn,
 * so a bot answering within a tick stands on its new tile when asked again, and
 * moving every turn walks at one tile per turn. v1 kept the legacy `300 - 20 * speed` ms.
 */
export function moveDurationTicks(speed: number, engineVersion: number = ENGINE_VERSION): number {
  if (engineVersion === 1) return Math.max(2, Math.round((300 - 20 * speed) / TICK_MS));
  return turnTicks(speed, engineVersion) - 1;
}

/**
 * Applies a decision to a player. Moves are queued and start as soon as the player
 * stands still; `idle` cancels a queued move; bombs are planted on the next step.
 */
export function applyIntent(state: GameState, playerId: number, intent: Intent): boolean {
  const player = state.players[playerId];
  if (!player || !player.alive || state.status !== 'running') return false;
  switch (intent.type) {
    case 'move':
      player.queuedMove = intent.direction;
      return true;
    case 'bomb':
      player.queuedBomb = true;
      return true;
    case 'idle':
      player.queuedMove = null;
      return true;
  }
}

/** Advances the simulation by exactly one tick. Mutates and returns `state`. */
export function step(state: GameState): GameState {
  state.events = [];
  if (state.status !== 'running') return state;
  const events = state.events;

  for (const player of state.players) {
    if (player.alive && player.queuedBomb) {
      player.queuedBomb = false;
      plantBomb(state, player, events);
    }
  }

  for (const player of state.players) {
    if (player.alive) advanceMovement(state, player, events);
  }

  for (const flame of state.flames) flame.ticksLeft--;
  state.flames = state.flames.filter((flame) => flame.ticksLeft > 0);

  for (const bomb of state.bombs) bomb.fuse--;
  const exploding = state.bombs.filter((bomb) => bomb.fuse <= 0).map((bomb) => bomb.id);
  if (exploding.length > 0) detonate(state, exploding, events);

  const flameCells = new Map(
    state.flames.map((flame) => [cellIndex(flame.x, flame.y, state.width), flame]),
  );
  const dying = state.players.filter(
    (player) => player.alive && flameCells.has(cellIndex(player.x, player.y, state.width)),
  );
  for (const player of dying) {
    const flame = flameCells.get(cellIndex(player.x, player.y, state.width))!;
    killPlayer(state, player, flame.ownerId === player.id ? null : flame.ownerId, events);
  }
  for (const player of dying) scatterItems(state, player);

  if (state.engineVersion === 6) shrinkArenaIfDue(state, events);
  else if (state.engineVersion >= 7) closeDueTiles(state, events);

  const alive = state.players.filter((player) => player.alive);
  if (alive.length <= 1) finish(state, 'lastStanding', events);
  else if (state.tick + 1 >= state.settings.maxTicks) finish(state, 'timeout', events);

  state.tick++;
  return state;
}

function killPlayer(
  state: GameState,
  player: PlayerState,
  killedBy: number | null,
  events: GameEvent[],
): void {
  player.alive = false;
  player.move = null;
  player.queuedMove = null;
  player.queuedBomb = false;
  player.diedAtTick = state.tick;
  player.killedBy = killedBy;
  if (killedBy !== null) state.players[killedBy]!.stats.kills++;
  events.push({ type: 'playerDied', playerId: player.id, killedBy });
}

function shrinkArenaIfDue(state: GameState, events: GameEvent[]): void {
  const nextTick = state.tick + 1;
  if (nextTick % ARENA_SHRINK_INTERVAL_TICKS !== 0) return;
  const inset = nextTick / ARENA_SHRINK_INTERVAL_TICKS;
  if (inset < 1 || inset > ARENA_SHRINK_RINGS) return;

  const isClosingCell = (x: number, y: number) =>
    x === inset || x === state.width - 1 - inset || y === inset || y === state.height - 1 - inset;

  for (let y = inset; y < state.height - inset; y++) {
    for (let x = inset; x < state.width - inset; x++) {
      if (isClosingCell(x, y)) state.grid[cellIndex(x, y, state.width)] = Cell.Hard;
    }
  }

  state.bombs = state.bombs.filter((bomb) => !isClosingCell(bomb.x, bomb.y));
  state.flames = state.flames.filter((flame) => !isClosingCell(flame.x, flame.y));
  state.items = state.items.filter((item) => {
    if (!isClosingCell(item.x, item.y)) return true;
    if (!item.hidden) events.push({ type: 'itemDestroyed', x: item.x, y: item.y, item: item.type });
    return false;
  });

  const crushed = state.players.filter(
    (player) => player.alive && isClosingCell(player.x, player.y),
  );
  for (const player of crushed) killPlayer(state, player, null, events);
  for (const player of crushed) scatterItems(state, player);

  for (const player of state.players) {
    if (
      player.alive &&
      player.move &&
      (isClosingCell(player.move.fromX, player.move.fromY) ||
        isClosingCell(player.move.toX, player.move.toY))
    ) {
      player.move = null;
    }
  }
  events.push({ type: 'arenaShrunk', inset });
}

/** Tiles closing within the warning window, soonest first. Empty before engine v7. */
export function closingWarnings(state: GameState): ClosingWarning[] {
  if (state.engineVersion < 7 || state.status !== 'running') return [];
  return closingSchedule(state.width, state.height)
    .filter(
      (tile) =>
        tile.tick > state.tick &&
        tile.tick <= state.tick + ARENA_SHRINK_WARNING_TICKS &&
        tile.tick <= state.settings.maxTicks &&
        state.grid[cellIndex(tile.x, tile.y, state.width)] !== Cell.Hard,
    )
    .map(({ x, y, tick }) => ({ x, y, ticksLeft: tick - state.tick }));
}

function closeDueTiles(state: GameState, events: GameEvent[]): void {
  const nextTick = state.tick + 1;
  for (const tile of closingSchedule(state.width, state.height)) {
    if (tile.tick !== nextTick) continue;
    closeTile(state, tile, events);
    if (tile.ringEnd) events.push({ type: 'arenaShrunk', inset: tile.inset });
  }
}

/**
 * Turns one tile into a hard wall. Whatever lies on it disappears, and a player
 * standing there is pushed to a free neighbour (inward first) or crushed.
 */
function closeTile(state: GameState, tile: ClosingTile, events: GameEvent[]): void {
  const { x, y } = tile;
  const index = cellIndex(x, y, state.width);
  if (state.grid[index] === Cell.Hard) return;
  state.grid[index] = Cell.Hard;
  events.push({ type: 'tileClosed', x, y });

  const here = (entity: { x: number; y: number }) => entity.x === x && entity.y === y;
  state.bombs = state.bombs.filter((bomb) => !here(bomb));
  state.flames = state.flames.filter((flame) => !here(flame));
  state.items = state.items.filter((item) => {
    if (!here(item)) return true;
    if (!item.hidden) events.push({ type: 'itemDestroyed', x, y, item: item.type });
    return false;
  });

  for (const player of state.players) {
    if (!player.alive) continue;
    if (here(player)) {
      player.move = null;
      const target = pushTarget(state, tile);
      if (target) {
        player.x = target.x;
        player.y = target.y;
        events.push({ type: 'playerPushed', playerId: player.id, fromX: x, fromY: y, ...target });
        collectItem(state, player, events);
      } else {
        killPlayer(state, player, null, events);
        scatterItems(state, player);
      }
    } else if (
      player.move &&
      ((player.move.fromX === x && player.move.fromY === y) ||
        (player.move.toX === x && player.move.toY === y))
    ) {
      player.move = null;
    }
  }
}

/** A walkable, flame free neighbour, preferring the arena's inside over the closing ring. */
function pushTarget(state: GameState, tile: ClosingTile): { x: number; y: number } | null {
  const inside = (x: number, y: number) =>
    x > tile.inset &&
    y > tile.inset &&
    x < state.width - 1 - tile.inset &&
    y < state.height - 1 - tile.inset;
  const free = DIRECTIONS.map((direction) => ({
    x: tile.x + DIRECTION_DELTAS[direction].dx,
    y: tile.y + DIRECTION_DELTAS[direction].dy,
  })).filter(
    ({ x, y }) =>
      isWalkable(state, x, y) && !state.flames.some((flame) => flame.x === x && flame.y === y),
  );
  return free.find(({ x, y }) => inside(x, y)) ?? free[0] ?? null;
}

function plantBomb(state: GameState, player: PlayerState, events: GameEvent[]): void {
  const active = state.bombs.filter((bomb) => bomb.ownerId === player.id).length;
  if (active >= player.bombCapacity) return;
  if (state.bombs.some((bomb) => bomb.x === player.x && bomb.y === player.y)) return;
  const bomb: BombState = {
    id: state.nextBombId++,
    ownerId: player.id,
    x: player.x,
    y: player.y,
    fuse: BOMB_FUSE_TICKS,
    range: player.flameRange,
  };
  state.bombs.push(bomb);
  player.stats.bombsPlaced++;
  events.push({ type: 'bombPlaced', bombId: bomb.id, ownerId: player.id, x: bomb.x, y: bomb.y });
}

export function isWalkable(state: GameState, x: number, y: number): boolean {
  if (!isInside(x, y, state.width, state.height)) return false;
  if (state.grid[cellIndex(x, y, state.width)] !== Cell.Floor) return false;
  return !state.bombs.some((bomb) => bomb.x === x && bomb.y === y);
}

function advanceMovement(state: GameState, player: PlayerState, events: GameEvent[]): void {
  if (!player.move && player.queuedMove) {
    const direction: Direction = player.queuedMove;
    player.queuedMove = null;
    player.facing = direction;
    const { dx, dy } = DIRECTION_DELTAS[direction];
    const toX = player.x + dx;
    const toY = player.y + dy;
    if (isWalkable(state, toX, toY)) {
      player.move = {
        direction,
        fromX: player.x,
        fromY: player.y,
        toX,
        toY,
        elapsed: 0,
        duration: moveDurationTicks(player.speed, state.engineVersion),
      };
    }
  }
  const move = player.move;
  if (!move) return;
  move.elapsed++;
  if (move.elapsed * 2 >= move.duration && (player.x !== move.toX || player.y !== move.toY)) {
    player.x = move.toX;
    player.y = move.toY;
    collectItem(state, player, events);
  }
  if (move.elapsed >= move.duration) player.move = null;
}

function collectItem(state: GameState, player: PlayerState, events: GameEvent[]): void {
  const index = state.items.findIndex(
    (item) => !item.hidden && item.x === player.x && item.y === player.y,
  );
  if (index < 0) return;
  const [item] = state.items.splice(index, 1);
  applyItem(player, item!.type, state.engineVersion);
  player.collected.push(item!.type);
  player.stats.itemsCollected++;
  events.push({
    type: 'itemCollected',
    x: item!.x,
    y: item!.y,
    item: item!.type,
    playerId: player.id,
  });
}

function applyItem(player: PlayerState, type: ItemType, engineVersion: number): void {
  switch (type) {
    case 'extraBomb':
      player.bombCapacity = Math.min(MAX_BOMBS, player.bombCapacity + 1);
      break;
    case 'flameUp':
      player.flameRange = Math.min(MAX_FLAME_RANGE, player.flameRange + 1);
      break;
    case 'maxFlame':
      player.flameRange = MAX_FLAME_RANGE;
      break;
    case 'speedUp':
      player.speed = Math.min(maxSpeed(engineVersion), player.speed + 1);
      break;
    case 'speedDown':
      player.speed = Math.max(MIN_SPEED, player.speed - 1);
      break;
  }
}

const ARMS: { direction: Direction; body: FlameKind; end: FlameKind }[] = [
  { direction: 'up', body: 'vertical', end: 'endUp' },
  { direction: 'down', body: 'vertical', end: 'endDown' },
  { direction: 'left', body: 'horizontal', end: 'endLeft' },
  { direction: 'right', body: 'horizontal', end: 'endRight' },
];

function detonate(state: GameState, initial: number[], events: GameEvent[]): void {
  const queue = [...initial];
  const destroyedWalls = new Set<number>();
  while (queue.length > 0) {
    const bombId = queue.shift()!;
    const bombIndex = state.bombs.findIndex((bomb) => bomb.id === bombId);
    if (bombIndex < 0) continue;
    const [bomb] = state.bombs.splice(bombIndex, 1);
    events.push({
      type: 'bombExploded',
      bombId: bomb!.id,
      ownerId: bomb!.ownerId,
      x: bomb!.x,
      y: bomb!.y,
    });
    putFlame(state, bomb!.x, bomb!.y, bomb!.ownerId, 'center');

    for (const arm of ARMS) {
      const { dx, dy } = DIRECTION_DELTAS[arm.direction];
      for (let distance = 1; distance <= bomb!.range; distance++) {
        const x = bomb!.x + dx * distance;
        const y = bomb!.y + dy * distance;
        if (!isInside(x, y, state.width, state.height)) break;
        const index = cellIndex(x, y, state.width);
        const cell = state.grid[index];
        if (cell === Cell.Hard) break;
        if (cell === Cell.Soft || destroyedWalls.has(index)) {
          if (!destroyedWalls.has(index)) {
            destroyedWalls.add(index);
            state.grid[index] = Cell.Floor;
            state.players[bomb!.ownerId]!.stats.wallsDestroyed++;
            events.push({ type: 'wallDestroyed', x, y, by: bomb!.ownerId });
          }
          break;
        }
        const itemIndex = state.items.findIndex(
          (item) => !item.hidden && item.x === x && item.y === y,
        );
        if (itemIndex >= 0) {
          const [item] = state.items.splice(itemIndex, 1);
          events.push({ type: 'itemDestroyed', x, y, item: item!.type });
          break;
        }
        putFlame(state, x, y, bomb!.ownerId, distance === bomb!.range ? arm.end : arm.body);
        const chained = state.bombs.find((other) => other.x === x && other.y === y);
        if (chained && !queue.includes(chained.id)) queue.push(chained.id);
      }
    }
  }
  for (const item of state.items) {
    if (item.hidden && destroyedWalls.has(cellIndex(item.x, item.y, state.width))) {
      item.hidden = false;
    }
  }
}

function putFlame(state: GameState, x: number, y: number, ownerId: number, kind: FlameKind): void {
  const existing = state.flames.find((flame) => flame.x === x && flame.y === y);
  if (existing) {
    existing.ticksLeft = FLAME_TICKS;
    existing.ownerId = ownerId;
    if (existing.kind !== 'center') existing.kind = kind;
    return;
  }
  state.flames.push({ x, y, ownerId, kind, ticksLeft: FLAME_TICKS });
}

/** Legacy behavior: a dead player's power-ups are dropped on random free cells. */
function scatterItems(state: GameState, player: PlayerState): void {
  if (player.collected.length === 0) return;
  const free: { x: number; y: number }[] = [];
  for (let y = 1; y < state.height - 1; y++) {
    for (let x = 1; x < state.width - 1; x++) {
      if (state.grid[cellIndex(x, y, state.width)] !== Cell.Floor) continue;
      if (state.items.some((item) => item.x === x && item.y === y)) continue;
      if (state.bombs.some((bomb) => bomb.x === x && bomb.y === y)) continue;
      if (state.flames.some((flame) => flame.x === x && flame.y === y)) continue;
      if (state.players.some((other) => other.alive && other.x === x && other.y === y)) continue;
      free.push({ x, y });
    }
  }
  for (const type of player.collected) {
    if (free.length === 0) break;
    const [cell] = free.splice(randomInt(state, free.length), 1);
    state.items.push({ x: cell!.x, y: cell!.y, type, hidden: false });
  }
  player.collected = [];
}

export function playerScore(player: PlayerState): number {
  return (
    player.stats.kills * SCORE_WEIGHTS.kill +
    player.stats.wallsDestroyed * SCORE_WEIGHTS.wallDestroyed +
    player.stats.itemsCollected * SCORE_WEIGHTS.itemCollected
  );
}

function rankKey(player: PlayerState, engineVersion: number): number[] {
  const key = player.alive ? [1, playerScore(player)] : [0, player.diedAtTick ?? -1];
  if (engineVersion < 4) return key;
  const { kills, wallsDestroyed, itemsCollected } = player.stats;
  return player.alive
    ? [...key, kills, wallsDestroyed, itemsCollected]
    : [...key, playerScore(player), kills, wallsDestroyed, itemsCollected];
}

/**
 * Survivors rank above the dead; survivors are ordered by score, the dead by how
 * long they survived. From engine v4, ties fall back to kills, walls destroyed, then
 * items collected (the dead first compare scores). Equal keys share a placement
 * (competition ranking: 1, 1, 3), and a shared first place is a draw.
 */
export function computeResult(state: GameState, reason: MatchResult['reason']): MatchResult {
  const rows = state.players.map((player) => ({
    player,
    key: rankKey(player, state.engineVersion),
  }));
  const compare = (a: (typeof rows)[number], b: (typeof rows)[number]) => {
    for (let index = 0; index < a.key.length; index++) {
      const difference = b.key[index]! - a.key[index]!;
      if (difference !== 0) return difference;
    }
    return 0;
  };
  const sorted = [...rows].sort((a, b) => compare(a, b) || a.player.id - b.player.id);
  const placements = new Map<number, number>();
  sorted.forEach((row, index) => {
    const previous = sorted[index - 1];
    placements.set(
      row.player.id,
      previous && compare(previous, row) === 0 ? placements.get(previous.player.id)! : index + 1,
    );
  });
  const players: PlayerResult[] = state.players.map((player) => ({
    playerId: player.id,
    placement: placements.get(player.id)!,
    score: playerScore(player),
    alive: player.alive,
    diedAtTick: player.diedAtTick,
    stats: { ...player.stats },
  }));
  const winners = players.filter((player) => player.placement === 1);
  return {
    winnerId: winners.length === 1 ? winners[0]!.playerId : null,
    reason,
    endTick: state.tick,
    players,
  };
}

function finish(state: GameState, reason: MatchResult['reason'], events: GameEvent[]): void {
  state.status = 'finished';
  state.result = computeResult(state, reason);
  events.push({ type: 'matchEnded', winnerId: state.result.winnerId, reason });
}

function clampInt(value: number, min: number, max: number): number {
  const integer = Number.isFinite(value) ? Math.trunc(value) : min;
  return Math.min(max, Math.max(min, integer));
}
