# Writing a bot

Your bot is plain JavaScript that defines one function:

```js
function gameLoop(obs) {
  return 'PLANT BOMB';
}
```

It is called once per turn, every 300 ms of game time at the starting speed (every
6 ticks of 50 ms; roller skates make turns come faster), with an observation of the
arena, and returns one action. Top level variables persist between calls, so
you can keep memory across turns.

## Actions

Return any of these (case insensitive), or the equivalent object:

| String                                                    | Object                              |
| --------------------------------------------------------- | ----------------------------------- |
| `"MOVE UP"`, `"MOVE DOWN"`, `"MOVE LEFT"`, `"MOVE RIGHT"` | `{ type: 'move', direction: 'up' }` |
| `"PLANT BOMB"` (or `"BOMB"`)                              | `{ type: 'bomb' }`                  |
| `"NOTHING"`, `null`, anything else                        | `{ type: 'idle' }`                  |
| `"SAY gg"` (or `"CHAT gg"`): stays idle and chats         | `{ type: 'say', message: 'gg' }`    |

### Talking in the chat

Spectators watching a live match on Bomber Arena TV see a chat next to the arena,
and your bot can post there too. Chat does nothing in the game: it is just for fun.

- `"SAY <text>"` or `{ type: 'say', message: '<text>' }` posts a line and plays the
  turn as `NOTHING`.
- Add a `say` field to any other action to move or bomb and chat in the same turn:
  `{ type: 'bomb', say: 'fire in the hole' }`.
- Each bot may post **one line per second**; extra lines are dropped silently, so a
  bot that chats on every turn shows up about every third turn. Lines are trimmed
  and cut at 200 characters.

A move crosses one tile in `obs.me.ticksPerTile` ticks, one tick less than your turn,
so a bot that answers quickly is standing on its new tile when its next turn comes.
A move requested while one is in progress is queued.

## Speed and power ups

Your speed sets how often you play. Each turn is one decision and at most one tile:

| `speed` | How you get there       | Turn (`obs.decisionIntervalTicks`) | Answer within |
| ------- | ----------------------- | ---------------------------------- | ------------- |
| 0       | picked up a `speedDown` | 8 ticks (400 ms)                   | 240 ms        |
| 1       | starting speed          | 6 ticks (300 ms)                   | 240 ms        |
| 2       | one `speedUp`           | 5 ticks (250 ms)                   | 240 ms        |
| 3 (max) | two or more `speedUp`   | 4 ticks (200 ms)                   | 190 ms        |

You need no code for it: `gameLoop` is just called more (or less) often. A faster
player outruns blasts and reaches items first, and gets less time per answer.

| Item        | Effect                                                          |
| ----------- | --------------------------------------------------------------- |
| `extraBomb` | +1 bomb on the board at a time (max 10)                         |
| `flameUp`   | +1 blast range (max 10)                                         |
| `maxFlame`  | blast range jumps to 10: rare, and your bombs now cross the map |
| `speedUp`   | roller skates: +1 speed, up to 3                                |
| `speedDown` | -1 speed, down to 0: you play every 400 ms instead of 300 ms    |

Every pickup scores 10 points, even when you are already at the cap. Your current
values are in `obs.me` (`bombCapacity`, `bombsAvailable`, `flameRange`, `speed`,
`ticksPerTile`), and the same fields describe your opponents in `obs.players`.

## Timing: the game never waits

The game runs at a fixed 50 ms per tick, whatever the bots do. On each of your turns
`gameLoop` receives a fresh observation and must answer before the turn ends (240 ms
at the starting speed, see above):

- Your action is applied on the tick it arrives, so a fast answer acts sooner.
- An answer that is not ready when the next observation comes is dropped, and your
  player skips that turn (it keeps finishing its current move). A late answer is
  never applied to a later turn.
- `gameLoop` may be `async` or return a promise. Only the wall-clock time until it
  settles counts against that budget; waiting on a request costs no CPU budget.

Promises you start keep running after `gameLoop` returns, so slow work belongs in
the background: start it, return something sensible right away, and use the result
on a later turn.

```js
let plan = null;
let pending = false;

function gameLoop(obs) {
  if (!pending) {
    pending = true;
    fetch('https://my-planner.example.com/plan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tick: obs.tick, me: obs.me, bombs: obs.bombs }),
    })
      .then((response) => response.json())
      .then((data) => (plan = data.move))
      .catch((error) => console.warn(error.message))
      .finally(() => (pending = false));
  }
  return plan ? 'MOVE ' + plan : 'NOTHING';
}
```

## Network access

Bots can call any public HTTP or HTTPS API with `fetch(url, { method, headers, body })`.
The response has `ok`, `status`, `statusText`, `url`, `redirected`, `headers.get()`,
`text()`, and `json()`.

- URLs must be absolute (`https://…`). Bodies are strings: use `JSON.stringify`.
  Responses are read as text, so binary downloads are not supported.
- Ranked matches run your bot on the server, which refuses loopback, private,
  link-local, and other reserved addresses, and ports below 1024 other than 80 and 443. Your requests identify themselves with the `BomberArenaBot/1.0` user agent.
- In **Run test** and casual rooms your bot runs in your browser, so the API must
  allow cross-origin requests (CORS). Requests never carry your cookies. Ranked
  matches are not affected by CORS. A few embedded browsers never start Web Workers;
  there your bot runs in the same QuickJS sandbox as ranked play, but `fetch` is
  unavailable. Use a regular browser to test network calls.
- There is no secret storage. Anything in your source is stored on the server, and
  public versions can be read by anyone, so do not put API keys or passwords in a bot.
- An API you call sees the game state you send it. Matches are recorded as replays,
  but the outside service is not: a replay shows what your bot did, not why.

## Observation (`sdkVersion: 1`)

```ts
interface Observation {
  sdkVersion: 1;
  tick: number; // current tick, starts at 0
  tickMs: 50;
  decisionIntervalTicks: number; // ticks until your next turn: 8, 6, 5 or 4 by speed
  maxTicks: number; // the match ends on timeout at this tick
  width: 15;
  height: 13;
  grid: number[][]; // grid[y][x]: 0 floor, 1 indestructible wall, 2 destructible wall
  myId: number;
  me: Player;
  players: Player[]; // everyone, including you, indexed by id
  bombs: { x; y; ownerId; ticksLeft; range }[];
  flames: { x; y; ticksLeft }[]; // standing in a flame kills you
  items: { x; y; type }[]; // visible power ups
}

interface Player {
  id: number;
  x: number;
  y: number; // the tile the player counts as standing on
  alive: boolean;
  facing: 'up' | 'down' | 'left' | 'right';
  moving: 'up' | 'down' | 'left' | 'right' | null;
  bombCapacity: number;
  bombsAvailable: number;
  flameRange: number;
  speed: number; // 0 to 3, see "Speed and power ups"
  ticksPerTile: number;
}
```

Item types: `extraBomb`, `flameUp`, `maxFlame`, `speedUp`, `speedDown` (see
"Speed and power ups").

## Rules worth knowing

- Bombs explode after 50 ticks (2.5 s); flames last 10 ticks. Explosions chain.
- Flames stop at indestructible walls, and stop on (and destroy) destructible walls
  and items.
- A player switches tiles halfway through a move, so `x`/`y` may jump before the
  animation ends.
- When a player dies, the power ups they collected are scattered on free tiles.
- At 1:00 and 2:00, the indestructible outer walls advance inward by one complete
  ring. Players caught in the closing ring die, and covered bombs and items disappear.
- A match ends when one bot (or none) is left, or after `maxTicks` (3 minutes).
  Survivors rank above the dead and are ordered by score
  (kill 100, wall 5, item 10); the dead are ordered by survival time, then score.
  Equal scores fall back to kills, then walls destroyed, then items collected. Only
  players equal on all of these share a place, and a shared first place is a draw.

## Limits

| Limit                | Value                                                |
| -------------------- | ---------------------------------------------------- |
| Source size          | 64 KB                                                |
| Time per decision    | 240 ms wall clock, less when fast (late = dropped)   |
| CPU per run          | 100 ms for each stretch of synchronous code          |
| Load time            | 1 s                                                  |
| Memory               | 32 MB                                                |
| Requests             | 4 at a time, 200 per match, 5 s timeout each         |
| Request / response   | 64 KB body / 256 KB response, 3 redirects            |
| Console output       | 20 lines per read, 300 characters per line           |
| Consecutive failures | 20 crashes or CPU overruns, then the bot is disabled |

Skipped turns are not failures: a bot waiting on a slow API is never disabled for it.

`Math.random()` is seeded per match and `Date.now()` returns game time. Replays store
the actions your bot actually took, so they stay exact even when a bot depends on an
outside service or on timing. There is no storage, `setTimeout`, `require`, or DOM
access.

## Workflow

1. **Run test** plays a local match in your browser against sample bots or your
   saved version, with your `console.log` output in the console panel.
2. **Save version** stores an immutable copy after validating it in the server
   sandbox. Public versions let others read the source.
3. **Queue for ranked** keeps your active version in the matchmaking pool until you
   leave the queue. Every ranked match is replayable and verifiable.

The sample bots live in `packages/bot-sdk/src/samples.ts`. Load any of them from the
**Templates** dropdown above the editor to start from a working strategy:

| Bot             | Strategy                                                               |
| --------------- | ---------------------------------------------------------------------- |
| Random Walker   | Wanders and never bombs. The easy opponent.                            |
| Cautious Bomber | Breaks walls, chases players, checks its escape route before bombing.  |
| Item Hunter     | Collects power-ups first, digs through walls to find more.             |
| Hunter          | Goes straight for the nearest player and bombs as soon as it lines up. |
| Survivor        | Keeps its distance, avoids fights, plays for time.                     |

Item Hunter, Hunter, and Survivor share a small toolkit worth copying: a threat map
that follows chain reactions, a breadth first search that avoids flames by arrival
time, and `canBombSafely`, which only plants when two escape routes stay open.

The same bots are the house bots: they fill empty seats in ranked matches and casual
rooms, drawn at random for each match, and they are the default (random) opponents
in local tests.
