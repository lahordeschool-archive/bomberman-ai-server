# Bomber Arena

A competitive Bomberman platform where nobody holds a controller: players write the
JavaScript `gameLoop` that drives their bomber, test it in the browser, then send it
to a ranked ladder where every match runs sandboxed on the server and can be replayed
and verified by anyone. The game runs at a fixed pace and never waits for a bot: bots
can be asynchronous and call outside HTTP APIs with `fetch`, and an answer that misses
its 240 ms budget simply skips that turn.

## What is in the box

| Path                   | What it is                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------- |
| `packages/game-engine` | Deterministic, server authoritative rules: seeded RNG, fixed 50 ms ticks, replay log, state hash. |
| `packages/bot-sdk`     | The bot contract: observations, action parsing, the shared runtime harness, sample bots.          |
| `packages/protocol`    | Typed HTTP and Socket.IO contracts with zod schemas.                                              |
| `apps/web`             | React + Vite client: editor, Web Worker test arena, Phaser renderer, ladder, replays.             |
| `apps/server`          | Fastify API, Socket.IO, matchmaker, PostgreSQL persistence, ratings.                              |
| `apps/bot-runner`      | Internal service that runs untrusted bot code in QuickJS with memory, CPU, and network limits.    |

Read [docs/architecture.md](docs/architecture.md) for how the pieces fit together and
[docs/bot-sdk.md](docs/bot-sdk.md) for how to write a bot.

## Quick start (development)

Requires Node 24 (see `.nvmrc`). No database server needed: development uses an
embedded PostgreSQL (PGlite) stored in `apps/server/data/`.

```sh
npm install
npm run dev
```

This starts the bot runner on `:8090`, the game server on `:8080`, and Vite on
[http://localhost:5173](http://localhost:5173). Register, create a bot, press
**Run test**, then **Save version** and **Queue for ranked**.

What players can do:

- Write a bot in the browser editor and test it locally against sample bots or their own active version.
- Save versions, reload an older one, and mark a version's source as public.
- Play casual rooms with friends (share a 6 letter code, empty seats go to house bots). Casual results never touch ratings.
- Queue for ranked, watch any live match from the Matches page, and replay finished ones with in-browser verification.
- Browse the leaderboard, player profiles, and bot pages, read public source, and copy it into a new bot.

## Checks

```sh
npm run lint          # ESLint
npm run format:check  # Prettier
npm run typecheck     # TypeScript, server and web projects
npm test              # Vitest: engine, SDK, sandbox, API and realtime integration
npm run build         # Production client bundle
npm run test:e2e      # Playwright: every user workflow on the real stack (run `npm run build` first)
```

Server integration tests use an in-memory PGlite by default; set
`TEST_DATABASE_URL=postgres://…` to run them against a real PostgreSQL (CI does).

## Production

```sh
cp .env.example .env    # set PUBLIC_ORIGIN, SITE_ADDRESS, POSTGRES_PASSWORD, RUNNER_TOKEN
docker compose up -d --build
```

Caddy terminates TLS and is the only published service; PostgreSQL and the bot runner
live on internal networks. See [docs/operations.md](docs/operations.md) for the
runbook: configuration, backups, upgrades, and incident handling.

**Before a public launch, read [docs/assets.md](docs/assets.md):** the bundled sprites
and music are not licensed for public distribution.

## Accounts

Deliberately minimal: a username and a password (Argon2id), opaque session cookies,
CSRF tokens on every state change, and rate limited login. No email, no OAuth.

## License

Code is MIT, see [LICENSE](LICENSE). Game assets are excluded, see
[docs/assets.md](docs/assets.md).
