# Operations runbook

## Deploy

Requirements: a Linux host with Docker Compose v2, ports 80 and 443 open, and a DNS
record pointing at the host.

```sh
git clone <repo> /srv/bomber-arena && cd /srv/bomber-arena
cp .env.example .env
# PUBLIC_ORIGIN=https://bomber-arena.com
# SITE_ADDRESS=bomber-arena.com
# REDIRECT_ADDRESSES / REDIRECT_HOSTS=www.bomber-arena.com,<previous-hostname>
# POSTGRES_PASSWORD and RUNNER_TOKEN: openssl rand -hex 32
# DNS: A/AAAA for bomber-arena.com, www, and the previous hostname → this host
docker compose up -d --build
docker compose ps        # all services healthy
```

Caddy obtains and renews TLS certificates for `SITE_ADDRESS` and every hostname in
`REDIRECT_ADDRESSES`, and permanently redirects the latter to the canonical site
(path preserved). The Node server does the same redirect from `REDIRECT_HOSTS`
(useful on Coolify, where Caddy is not in the stack). The server applies database
migrations at startup (guarded by an advisory lock) and seeds the house bots.

### Configuration

The server validates its environment at startup and refuses to boot on invalid
values (in production it also requires `RUNNER_TOKEN` and a PostgreSQL URL).

| Variable                 | Default                 | Notes                                                                                  |
| ------------------------ | ----------------------- | -------------------------------------------------------------------------------------- |
| `PUBLIC_ORIGIN`          | `http://localhost:8080` | Exact browser origin; used for CSRF and socket checks.                                 |
| `REDIRECT_HOSTS`         | _(empty)_               | Extra hostnames that 301 to `PUBLIC_ORIGIN` (www of a real domain is always included). |
| `DATABASE_URL`           | `pglite:./data/pglite`  | `postgres://…` in production.                                                          |
| `RUNNER_URL`             | `http://localhost:8090` | Internal bot runner.                                                                   |
| `RUNNER_TOKEN`           | dev token               | Shared secret, at least 16 characters.                                                 |
| `TRUST_PROXY`            | `false`                 | Compose sets `uniquelocal` (Caddy on the private net).                                 |
| `RANKED_CONCURRENCY`     | `2`                     | Simultaneous ranked matches (each needs runner CPU).                                   |
| `MATCHMAKER_INTERVAL_MS` | `5000`                  |                                                                                        |
| `SESSION_TTL_DAYS`       | `30`                    | Sliding expiry.                                                                        |
| `MAX_BOTS_PER_USER`      | `10`                    |                                                                                        |
| `REGISTRATIONS_PER_HOUR` | `30`                    | Per client IP. Raise it for a classroom behind one NAT.                                |
| `LOG_LEVEL`              | `info`                  |                                                                                        |

Runner: `RUNNER_WORKERS`, `RUNNER_MAX_SESSIONS`, `BOT_MEMORY_MB`, `BOT_CALL_TIMEOUT_MS`
(CPU per synchronous run), `BOT_FETCH` (`on` by default, `off` blocks every bot
request), `BOT_FETCH_TIMEOUT_MS` (5000). `BOT_FETCH_ALLOW_PRIVATE=true` lets bots
reach loopback and private networks for local development; it is ignored when
`NODE_ENV=production`.

Bot network access: bots can call public APIs from your runner's IP address, and the
requests carry the `BomberArenaBot/1.0` user agent. If you receive abuse reports, find
the bot from the match logs, delete or disable it, or set `BOT_FETCH=off` and restart
the runner. Bot request volume is bounded by sessions × 200 requests per match.

Sizing: a ranked match holds up to four sandboxes and needs about 0.25 CPU core in the
runner. Two vCPUs comfortably run `RANKED_CONCURRENCY=2` plus casual play.

## Health and logs

- `GET /healthz` (server and runner): process is up. Used by Docker health checks.
- `GET /readyz` (server, internal only; Caddy hides it): database and runner reachable.
  `docker compose exec server wget -qO- http://127.0.0.1:8080/readyz`
- Logs are JSON lines on stdout (pino for the server, plain JSON for the runner), with
  request ids, match ids, and durations. `docker compose logs -f server bot-runner`.
  Useful messages: `match started`, `match completed`, `match failed`,
  `bot runner unavailable; ranked matchmaking paused`, `ranked bot failed to load`.
- Security events are in the `audit_log` table:
  `select action, count(*) from audit_log where created_at > now() - interval '1 day' group by 1;`

## Backups

`deploy/backup.sh` writes a compressed `pg_dump` to `backups/` and deletes dumps older
than `KEEP_DAYS` (14). Schedule it nightly and copy `backups/` off the host.

```sh
15 3 * * * cd /srv/bomber-arena && deploy/backup.sh >> backups/backup.log 2>&1
```

Restore (test this regularly):

```sh
docker compose stop server
docker compose exec -T postgres pg_restore -U bomber -d bomber --clean --if-exists < backups/<file>.dump
docker compose start server
```

## Upgrades

```sh
git pull
docker compose build
docker compose up -d     # migrations run on server start
```

Running matches are aborted on restart (recorded as `aborted`, unrated); queued bots
stay queued. Replays are tied to `engine_version`: a rules change must bump
`ENGINE_VERSION` in `packages/game-engine/src/constants.ts`, and older replays then
report that they cannot be re-simulated by the new engine.

## Incidents

| Symptom                               | Check                                                                                     |
| ------------------------------------- | ----------------------------------------------------------------------------------------- |
| Saving versions returns 503           | Runner down or token mismatch: `docker compose logs bot-runner`, compare `RUNNER_TOKEN`.  |
| No ranked matches start               | `RANKED_CONCURRENCY` > 0? Queue has bots with a version? Look for matchmaker warnings.    |
| Players get 403 on every action       | `PUBLIC_ORIGIN` does not match the address in the browser.                                |
| Ratings look wrong after a manual fix | `docker compose exec server node apps/server/src/cli/rebuild-ratings.ts`                  |
| A bot abuses CPU                      | It is capped at 100 ms per synchronous run; lower `BOT_CALL_TIMEOUT_MS` or `RUNNER_CPUS`. |
| Account takeover suspected            | Delete the user's sessions: `delete from sessions where user_id = '…';`                   |

## Security checklist before launch

- [ ] `.env` secrets generated, file readable only by the deploy user.
- [ ] Only ports 80/443 reachable; PostgreSQL and the runner have no published ports.
- [ ] Nightly backups copied off host, one restore tested.
- [ ] Assets replaced or licensed (see [assets.md](assets.md)).
- [ ] `docker compose pull && docker compose build --pull` scheduled for base image updates.
