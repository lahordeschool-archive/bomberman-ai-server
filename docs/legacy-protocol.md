# Legacy protocol and rules (captured before the rewrite)

This document records the behavior of the original workshop build (`main.js` +
`public/` in this repository, and `your-ai-goes-here.js` in the
`bomberman-ai` client repository) as of commit `085f147`. The new engine keeps
these rules unless a deviation is listed at the end. The rule parity tests in
`packages/game-engine/test/legacy-parity.test.ts` pin the preserved behavior.

## Transport

- Express 4 + Socket.IO 2 on `0.0.0.0:8080`, no authentication, all state in memory.
- Static routes: `/public`, `/test`, and the entire `/node_modules` tree.
- The AI client was opened through `file://` with browser web security disabled
  and connected to a hard-coded `SERVER_URL`.

## Socket.IO events

### Lobby

| Client emits                        | Payload                          | Server effect                                                                                                                                                                                                                              |
| ----------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `load-rooms`                        | none                             | joins `' lobby '`, replies `list-of-rooms` with every room                                                                                                                                                                                 |
| `create-room`                       | `{ roomName }`                   | creates `{ userList: [], gameStarted: false, readyPlayers: 0, stage: 1 }` if absent, replies `enter-room`                                                                                                                                  |
| `login`                             | `{ roomName, nickname, avatar }` | joins the room if it exists, is not full (4), and the nickname is free; first user becomes host; emits `user_logged`, `user_list`, `load_dashboard`, `get-color`; errors `room-not-exists`, `room-full`, `nickname-exists`, `room-in-game` |
| `send_message`                      | text                             | broadcasts `message` `{ nickname, message, avatar }` (rendered as raw HTML by the client)                                                                                                                                                  |
| `player-ready` / `player-not-ready` | user index (trusted)             | updates status, broadcasts `set-player-ready` / `set-player-not-ready`                                                                                                                                                                     |
| `send-input-values`                 | `{ id, value }`                  | rebroadcast as `get-input-values` (any client can overwrite inputs)                                                                                                                                                                        |
| `update-stage`                      | stage                            | rebroadcast as `update-stage-carousel`                                                                                                                                                                                                     |
| `color-claimed` / `color-released`  | color                            | updates user color, broadcasts `remove-color` / `release-color` and `user_list`                                                                                                                                                            |
| `request_user_list`                 | none                             | replies `user_list`                                                                                                                                                                                                                        |

### Match

| Client emits              | Payload                           | Server effect                                                                                                                            |
| ------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `start-game`              | `{ b, f, s, players }`            | no host check; generates walls and items, broadcasts `load-game` with `stage` and `items`, starts a 5 minute timer                       |
| `user-ready`              | player id                         | counts loaded clients, broadcasts `all-users-ready` when all loaded                                                                      |
| `move-player`             | `{ player_id, x, y, animation }`  | rebroadcast as `move-enemy` (client authoritative)                                                                                       |
| `stop-player`             | id                                | rebroadcast as `stop-enemy`                                                                                                              |
| `placed-bomb`             | `{ x, y, player_id, flames_len }` | counts bombs per player, rebroadcast as `place-enemy-bomb`                                                                               |
| `dead-items`              | `{ stage, items, id }`            | scatters the dead player's items to random free cells, broadcasts `kill-player`, `replace-items`, and `end-game` when one player remains |
| `user-exits` / disconnect | none                              | broadcasts `kill-player`, may broadcast `end-game`                                                                                       |
| `close-game`              | none                              | broadcasts `exit-game` (sent by every client on `end-game`)                                                                              |

## Game rules

- Grid of 15 x 13 cells of 16 px; border and every even/even cell are hard walls.
- Spawns: cells (1,1), (13,1), (1,11), (13,11); the spawn and its two inward
  neighbours are always kept free.
- Every other free cell becomes a soft wall with probability 0.85.
- Each soft wall hides an item with probability 0.20, drawn from
  `[0 x8, 1 x7, 3, 9 x7, 23 x3]` (0 extra bomb, 1 flame up, 3 max flame,
  9 speed up, 23 speed down).
- Lobby defaults: 1 bomb, flame range 2, speed 1.
- Movement is tile based: one tile takes `300 - 20 * speed` ms. Hard walls,
  soft walls, and bombs block movement.
- A bomb is placed on the player's tile if the tile is empty and the player has
  fewer active bombs than its capacity. It explodes after its ticking animation
  (about 2.7 s), or immediately when touched by a flame.
- Flames extend `range` tiles in each direction, stop before hard walls, and
  stop on (and destroy) the first soft wall or item they reach. Flames last about
  0.5 s and kill any player they touch.
- Item caps: 10 bombs, speed between 0 and 6; max flame sets range to 13.
- A dead player's collected items are scattered on random free cells.
- The last player alive wins. After 5 minutes, the player with the most bombs
  placed wins, otherwise a random survivor.

## AI contract

- `async function gameLoop(data)` was called every 250 ms (the docs said 500 ms).
- `data` contained pixel coordinates: `players`, `myPlayer`, `walls`, `bombs`,
  `stage`, and `map` sizes.
- The return value `"MOVE UP|DOWN|LEFT|RIGHT"` or `"PLANT BOMB"` was translated
  into synthetic DOM mouse events on the on-screen controls.

## Deliberate deviations in the new engine

- The server simulates every rule; clients only send intents.
- Ticks are fixed at 50 ms; movement duration is rounded to whole ticks.
- Bomb fuse is 50 ticks (2.5 s) and flames last 10 ticks (0.5 s).
- Flame range is capped at 10 (max flame sets it to the cap).
- Matches last 3 minutes. At timeout, survivors are ranked by score instead of
  bombs placed or randomness; equal scores fall back to kills, walls, then items,
  and players equal on all of them stay tied.
- The bot observation is grid based (`docs/bot-sdk.md`), not pixel based.
- Lobby chat, colours, and stage selection are removed.
