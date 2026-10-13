export interface SampleBot {
  slug: string;
  name: string;
  description: string;
  source: string;
}

export const STARTER_SOURCE = `/**
 * Your bot. gameLoop is called every 250 ms (every 5 game ticks) with an observation:
 *
 *   obs.grid[y][x]   0 floor, 1 indestructible wall, 2 destructible wall
 *   obs.me           { id, x, y, alive, bombsAvailable, flameRange, speed, moving, ... }
 *   obs.players      every player, including you
 *   obs.bombs        { x, y, ownerId, ticksLeft, range }
 *   obs.flames       { x, y, ticksLeft }  standing in a flame kills you
 *   obs.items        { x, y, type }  extraBomb, flameUp, maxFlame, speedUp, speedDown
 *
 * Return "MOVE UP" | "MOVE DOWN" | "MOVE LEFT" | "MOVE RIGHT" | "PLANT BOMB" | "NOTHING".
 * Globals persist between calls, console.log output shows up in the editor console.
 * Answer within 240 ms or the turn is skipped; the game never waits. gameLoop may be
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
];

export function getSampleBot(slug: string): SampleBot | undefined {
  return SAMPLE_BOTS.find((bot) => bot.slug === slug);
}
