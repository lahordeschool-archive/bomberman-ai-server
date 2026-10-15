export interface SampleBot {
  slug: string;
  name: string;
  description: string;
  source: string;
}

export const STARTER_SOURCE = `/**
 * Your bot. gameLoop is called once per turn with an observation. A turn lasts
 * 300 ms (6 game ticks), 250 or 200 ms with roller skates (speedUp), 400 ms after a
 * speedDown; each turn is one decision and at most one tile.
 *
 *   obs.grid[y][x]   0 floor, 1 indestructible wall, 2 destructible wall
 *   obs.me           { id, x, y, alive, bombsAvailable, flameRange, speed, moving, ... }
 *   obs.players      every player, including you
 *   obs.bombs        { x, y, ownerId, ticksLeft, range }
 *   obs.flames       { x, y, ticksLeft }  standing in a flame kills you
 *   obs.items        { x, y, type }  extraBomb, flameUp, maxFlame, speedUp, speedDown
 *   obs.closing      { x, y, ticksLeft }  tiles turning into walls soon, get off them
 *
 * Return "MOVE UP" | "MOVE DOWN" | "MOVE LEFT" | "MOVE RIGHT" | "PLANT BOMB" | "NOTHING".
 * Globals persist between calls, console.log output shows up in the editor console.
 * Answer before the turn ends or it is skipped; the game never waits. gameLoop may be
 * async and use fetch() to call public HTTP APIs (see the bot SDK docs).
 */

const DIRECTIONS = { UP: [0, -1], DOWN: [0, 1], LEFT: [-1, 0], RIGHT: [1, 0] };

function isFree(obs, x, y) {
  if (obs.grid[y]?.[x] !== 0) return false;
  return !obs.bombs.some((bomb) => bomb.x === x && bomb.y === y);
}

function gameLoop(obs) {
  const { x, y } = obs.me;
  const options = Object.entries(DIRECTIONS).filter(([, [dx, dy]]) => isFree(obs, x + dx, y + dy));
  if (options.length === 0) return 'NOTHING';
  const [name] = options[Math.floor(Math.random() * options.length)];
  return 'MOVE ' + name;
}
`;

const RANDOM_WALKER = `// Wanders randomly and never plants bombs. A good first opponent.
const DIRECTIONS = { UP: [0, -1], DOWN: [0, 1], LEFT: [-1, 0], RIGHT: [1, 0] };
let current = 'UP';

function free(obs, x, y) {
  return obs.grid[y]?.[x] === 0 && !obs.bombs.some((b) => b.x === x && b.y === y);
}

function gameLoop(obs) {
  const { x, y } = obs.me;
  const options = Object.keys(DIRECTIONS).filter((name) => {
    const [dx, dy] = DIRECTIONS[name];
    return free(obs, x + dx, y + dy);
  });
  if (options.length === 0) return 'NOTHING';
  if (!options.includes(current) || Math.random() < 0.25) {
    current = options[Math.floor(Math.random() * options.length)];
  }
  return 'MOVE ' + current;
}
`;

const CAUTIOUS_BOMBER = `// Breaks walls, hunts players, and only plants a bomb when it can escape the blast.
const STEPS = [
  ['UP', 0, -1],
  ['DOWN', 0, 1],
  ['LEFT', -1, 0],
  ['RIGHT', 1, 0],
];
const SAFETY_MARGIN = 4;

function threatMap(obs, extraBomb) {
  const threat = obs.grid.map((row) => row.map(() => Infinity));
  for (const flame of obs.flames) threat[flame.y][flame.x] = 0;
  const bombs = extraBomb ? [...obs.bombs, extraBomb] : obs.bombs;
  for (const bomb of bombs) {
    const mark = (x, y) => {
      threat[y][x] = Math.min(threat[y][x], bomb.ticksLeft);
    };
    mark(bomb.x, bomb.y);
    for (const [, dx, dy] of STEPS) {
      for (let i = 1; i <= bomb.range; i++) {
        const x = bomb.x + dx * i;
        const y = bomb.y + dy * i;
        if (obs.grid[y]?.[x] !== 0) break;
        mark(x, y);
      }
    }
  }
  for (const tile of obs.closing || []) threat[tile.y][tile.x] = 0;
  return threat;
}

function walkable(obs, x, y, bombs) {
  return obs.grid[y]?.[x] === 0 && !bombs.some((b) => b.x === x && b.y === y);
}

/** Breadth first search; returns the first step and distance to the first goal cell. */
function search(obs, threat, goal, bombs) {
  const { x: sx, y: sy } = obs.me;
  const ticksPerTile = obs.me.ticksPerTile;
  const seen = new Set([sx + ',' + sy]);
  const queue = [[sx, sy, null, 0]];
  while (queue.length > 0) {
    const [x, y, first, distance] = queue.shift();
    if (goal(x, y, distance)) return { first, distance };
    for (const [name, dx, dy] of STEPS) {
      const nx = x + dx;
      const ny = y + dy;
      const key = nx + ',' + ny;
      if (seen.has(key) || !walkable(obs, nx, ny, bombs)) continue;
      const arrival = (distance + 1) * ticksPerTile;
      const danger = threat[ny][nx];
      if (danger !== Infinity && danger <= arrival + SAFETY_MARGIN && danger + 10 >= arrival) continue;
      seen.add(key);
      queue.push([nx, ny, first ?? name, distance + 1]);
    }
  }
  return null;
}

function enemyInLine(obs, range) {
  const { x, y } = obs.me;
  return obs.players.some((p) => {
    if (!p.alive || p.id === obs.myId) return false;
    if (p.x !== x && p.y !== y) return false;
    return Math.abs(p.x - x) + Math.abs(p.y - y) <= range;
  });
}

function nextToWall(obs) {
  const { x, y } = obs.me;
  return STEPS.some(([, dx, dy]) => obs.grid[y + dy]?.[x + dx] === 2);
}

function gameLoop(obs) {
  const me = obs.me;
  if (me.moving) return 'NOTHING';
  const threat = threatMap(obs);
  const safe = (x, y) => threat[y][x] === Infinity;

  if (!safe(me.x, me.y)) {
    const escape = search(obs, threat, (x, y) => safe(x, y), obs.bombs);
    return escape && escape.first ? 'MOVE ' + escape.first : 'NOTHING';
  }

  if (me.bombsAvailable > 0 && (nextToWall(obs) || enemyInLine(obs, me.flameRange))) {
    const bomb = { x: me.x, y: me.y, ticksLeft: 50, range: me.flameRange };
    const bombs = [...obs.bombs, bomb];
    const withBomb = threatMap(obs, bomb);
    const escape = search(obs, withBomb, (x, y) => withBomb[y][x] === Infinity, bombs);
    if (escape && escape.distance > 0) return 'PLANT BOMB';
  }

  const goodItem = (x, y) =>
    obs.items.some((item) => item.x === x && item.y === y && item.type !== 'speedDown');
  const nearTarget = (x, y) =>
    STEPS.some(([, dx, dy]) => obs.grid[y + dy]?.[x + dx] === 2) ||
    obs.players.some((p) => p.alive && p.id !== obs.myId && Math.abs(p.x - x) + Math.abs(p.y - y) <= 2);
  const route =
    search(obs, threat, (x, y, d) => d > 0 && goodItem(x, y) && safe(x, y), obs.bombs) ||
    search(obs, threat, (x, y, d) => d > 0 && nearTarget(x, y) && safe(x, y), obs.bombs);
  if (route && route.first) return 'MOVE ' + route.first;
  return 'NOTHING';
}
`;

/** Shared toolkit for the strategy samples: a danger map and a safe breadth first search. */
const TOOLKIT = `const STEPS = [
  ['UP', 0, -1],
  ['DOWN', 0, 1],
  ['LEFT', -1, 0],
  ['RIGHT', 1, 0],
];
const BOMB_FUSE = 50;

/** Cells a bomb's blast reaches, including its own. */
function blast(obs, bomb) {
  const cells = [[bomb.x, bomb.y]];
  for (const [, dx, dy] of STEPS) {
    for (let i = 1; i <= bomb.range; i++) {
      const x = bomb.x + dx * i;
      const y = bomb.y + dy * i;
      if (obs.grid[y]?.[x] !== 0) break;
      cells.push([x, y]);
    }
  }
  return cells;
}

/**
 * Ticks until each cell is hit by a flame (0 = burning now, Infinity = safe).
 * A bomb caught in another blast goes off early, so timers follow chain reactions.
 */
function threatMap(obs, extraBomb) {
  const threat = obs.grid.map((row) => row.map(() => Infinity));
  for (const flame of obs.flames) threat[flame.y][flame.x] = 0;
  const bombs = (extraBomb ? [...obs.bombs, extraBomb] : obs.bombs).map((bomb) => ({
    ...bomb,
    cells: blast(obs, bomb),
    timer: threat[bomb.y][bomb.x] === 0 ? 0 : bomb.ticksLeft,
  }));
  for (let changed = true; changed; ) {
    changed = false;
    for (const a of bombs) {
      for (const b of bombs) {
        if (b.timer < a.timer && b.cells.some(([x, y]) => x === a.x && y === a.y)) {
          a.timer = b.timer;
          changed = true;
        }
      }
    }
  }
  for (const bomb of bombs) {
    for (const [x, y] of bomb.cells) threat[y][x] = Math.min(threat[y][x], bomb.timer);
  }
  // Closing tiles become walls for good: treat them as burning already.
  for (const tile of obs.closing || []) threat[tile.y][tile.x] = 0;
  return threat;
}

/**
 * Every cell you can reach without walking into a flame, in breadth first order:
 * { x, y, first, distance } where first is the move to make now.
 */
function reachable(obs, threat, bombs = obs.bombs, limit = 30) {
  const { x: sx, y: sy, ticksPerTile } = obs.me;
  const cells = [{ x: sx, y: sy, first: null, distance: 0 }];
  const seen = new Set([sx + ',' + sy]);
  for (let i = 0; i < cells.length; i++) {
    const { x, y, first, distance } = cells[i];
    if (distance >= limit) continue;
    for (const [name, dx, dy] of STEPS) {
      const nx = x + dx;
      const ny = y + dy;
      const key = nx + ',' + ny;
      if (seen.has(key) || obs.grid[ny]?.[nx] !== 0) continue;
      if (bombs.some((b) => b.x === nx && b.y === ny)) continue;
      const arrival = (distance + 1) * ticksPerTile;
      const danger = threat[ny][nx];
      if (danger !== Infinity && danger <= arrival + 4 && danger + 10 >= arrival) continue;
      seen.add(key);
      cells.push({ x: nx, y: ny, first: first ?? name, distance: distance + 1 });
    }
  }
  return cells;
}

function move(cell) {
  return cell && cell.first ? 'MOVE ' + cell.first : 'NOTHING';
}

/** The nearest safe cell, or null when there is nowhere to hide. */
function escape(obs, threat) {
  return reachable(obs, threat).find((c) => threat[c.y][c.x] === Infinity) ?? null;
}

/**
 * Planting here is fine only if, once the bomb is down, safe cells stay reachable in
 * time through two different first moves: one blocked corridor must not trap you.
 */
function canBombSafely(obs) {
  const me = obs.me;
  if (me.bombsAvailable === 0) return false;
  const bomb = { x: me.x, y: me.y, ticksLeft: BOMB_FUSE, range: me.flameRange };
  const threat = threatMap(obs, bomb);
  const deadline = Math.min(...blast(obs, bomb).map(([x, y]) => threat[y][x])) - 10;
  const exits = new Set(
    reachable(obs, threat, [...obs.bombs, bomb])
      .filter((c) => c.distance > 0 && threat[c.y][c.x] === Infinity)
      .filter((c) => c.distance * me.ticksPerTile <= deadline)
      .map((c) => c.first),
  );
  return exits.size >= 2 || (exits.size === 1 && enemies(obs).every((p) => distance(p, me) > 3));
}

function touchesWall(obs, x, y) {
  return STEPS.some(([, dx, dy]) => obs.grid[y + dy]?.[x + dx] === 2);
}

function enemies(obs) {
  return obs.players.filter((p) => p.alive && p.id !== obs.myId);
}

function distance(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

/** True when an enemy stands in a straight, unobstructed line within the blast range. */
function enemyInBlast(obs) {
  const me = obs.me;
  return enemies(obs).some((p) => {
    if (p.x !== me.x && p.y !== me.y) return false;
    if (distance(p, me) > me.flameRange) return false;
    const dx = Math.sign(p.x - me.x);
    const dy = Math.sign(p.y - me.y);
    for (let x = me.x + dx, y = me.y + dy; x !== p.x || y !== p.y; x += dx, y += dy) {
      if (obs.grid[y][x] !== 0) return false;
    }
    return true;
  });
}

function goodItemAt(obs, x, y) {
  return obs.items.some((item) => item.x === x && item.y === y && item.type !== 'speedDown');
}`;

const ITEM_HUNTER = `// Item Hunter: grabs every power-up it can reach, digs through walls to find more,
// and only fights when an enemy wanders into its blast.
${TOOLKIT}

function gameLoop(obs) {
  const me = obs.me;
  if (me.moving) return 'NOTHING';
  const threat = threatMap(obs);
  if (threat[me.y][me.x] !== Infinity) return move(escape(obs, threat));

  const cells = reachable(obs, threat).filter((c) => threat[c.y][c.x] === Infinity);
  const item = cells.find((c) => c.distance > 0 && goodItemAt(obs, c.x, c.y));
  if (item) return move(item);

  if ((touchesWall(obs, me.x, me.y) || enemyInBlast(obs)) && canBombSafely(obs)) {
    return 'PLANT BOMB';
  }
  const wall = cells.find((c) => c.distance > 0 && touchesWall(obs, c.x, c.y));
  return move(wall);
}
`;

const HUNTER = `// Hunter: walks straight at the nearest player and bombs the moment it lines up.
// Walls in the way get blown up. Aggressive, but it still checks its escape route.
${TOOLKIT}

function gameLoop(obs) {
  const me = obs.me;
  if (me.moving) return 'NOTHING';
  const threat = threatMap(obs);
  if (threat[me.y][me.x] !== Infinity) return move(escape(obs, threat));

  if (enemyInBlast(obs) && canBombSafely(obs)) return 'PLANT BOMB';

  const targets = enemies(obs);
  if (targets.length === 0) return 'NOTHING';
  const cells = reachable(obs, threat).filter((c) => threat[c.y][c.x] === Infinity);
  const closest = (c) => Math.min(...targets.map((p) => distance(p, c)));

  // Prefer a cell lined up with an enemy, otherwise get as close as possible.
  const lineUp = cells.find(
    (c) => c.distance > 0 && targets.some((p) => (p.x === c.x || p.y === c.y) && distance(p, c) <= me.flameRange),
  );
  if (lineUp) return move(lineUp);
  const best = cells.reduce((a, b) => (closest(b) < closest(a) ? b : a), cells[0]);
  if (best && best.distance > 0 && closest(best) < closest(me)) return move(best);

  // Boxed in: dig toward the enemy.
  if (touchesWall(obs, me.x, me.y) && canBombSafely(obs)) return 'PLANT BOMB';
  const wall = cells
    .filter((c) => c.distance > 0 && touchesWall(obs, c.x, c.y))
    .sort((a, b) => closest(a) - closest(b))[0];
  return move(wall);
}
`;

const SURVIVOR = `// Survivor: plays for time. Keeps its distance from everyone, picks up nearby items,
// and only breaks walls when nobody is around. Hard to kill, rarely wins by kills.
${TOOLKIT}

const PERSONAL_SPACE = 4;

function gameLoop(obs) {
  const me = obs.me;
  if (me.moving) return 'NOTHING';
  const threat = threatMap(obs);
  if (threat[me.y][me.x] !== Infinity) return move(escape(obs, threat));

  const others = enemies(obs);
  const nearest = (c) => (others.length ? Math.min(...others.map((p) => distance(p, c))) : 99);
  const cells = reachable(obs, threat, obs.bombs, 8).filter((c) => threat[c.y][c.x] === Infinity);

  if (nearest(me) < PERSONAL_SPACE) {
    if (enemyInBlast(obs) && canBombSafely(obs)) return 'PLANT BOMB';
    const away = cells.reduce((a, b) => (nearest(b) > nearest(a) ? b : a), cells[0]);
    return move(away);
  }

  const item = cells.find((c) => c.distance > 0 && c.distance <= 4 && goodItemAt(obs, c.x, c.y));
  if (item) return move(item);

  if (touchesWall(obs, me.x, me.y) && nearest(me) > PERSONAL_SPACE + 2 && canBombSafely(obs)) {
    return 'PLANT BOMB';
  }
  const quietWall = cells.find(
    (c) => c.distance > 0 && touchesWall(obs, c.x, c.y) && nearest(c) > PERSONAL_SPACE + 2,
  );
  return move(quietWall);
}
`;

export const SAMPLE_BOTS: readonly SampleBot[] = [
  {
    slug: 'random-walker',
    name: 'Random Walker',
    description: 'Wanders around and never plants bombs.',
    source: RANDOM_WALKER,
  },
  {
    slug: 'cautious-bomber',
    name: 'Cautious Bomber',
    description: 'Breaks walls, chases players, and checks its escape route before bombing.',
    source: CAUTIOUS_BOMBER,
  },
  {
    slug: 'item-hunter',
    name: 'Item Hunter',
    description: 'Collects power-ups first and digs through walls to find more.',
    source: ITEM_HUNTER,
  },
  {
    slug: 'hunter',
    name: 'Hunter',
    description: 'Goes straight for the nearest player and bombs as soon as it lines up.',
    source: HUNTER,
  },
  {
    slug: 'survivor',
    name: 'Survivor',
    description: 'Keeps its distance, avoids fights, and plays for time.',
    source: SURVIVOR,
  },
];

/** Picks `count` sample bots at random (repeats allowed when count exceeds the list). */
export function randomSampleBots(count: number, random: () => number = Math.random): SampleBot[] {
  const pool = [...SAMPLE_BOTS];
  const picks: SampleBot[] = [];
  for (let i = 0; i < count; i++) {
    if (pool.length === 0) pool.push(...SAMPLE_BOTS);
    picks.push(pool.splice(Math.floor(random() * pool.length), 1)[0]!);
  }
  return picks;
}

export function getSampleBot(slug: string): SampleBot | undefined {
  return SAMPLE_BOTS.find((bot) => bot.slug === slug);
}
