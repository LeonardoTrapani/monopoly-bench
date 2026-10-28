# @mb/worker

The monopoly-bench backend on Cloudflare (SPEC.md §7): one Worker with the HTTP API and the
web app's static assets, three SQLite-backed Durable Objects, D1 for statistics, R2 for game
archives. Infrastructure is declared with Alchemy v2 in [`alchemy.run.ts`](./alchemy.run.ts).

Games are real Monopoly: GameDO plays `@mb/engine` through a narrow seam
(`src/game/engine.ts`), bound in `src/game/engine-binding.ts` to `@mb/engine` (rules),
`@mb/bots` (bot seats) and `@mb/agent` (what LLM seats see and do).

## Architecture

```
browser / CLI ──HTTP──▶ Worker (src/worker.ts)
                         ├─ /api/*  → src/api/router.ts (Effect, D1 via @effect/sql-d1)
                         └─ else    → static assets of apps/web/dist (SPA fallback)

POST /api/runs ──▶ RunDO (one per run)          src/runs/run-coordinator.ts
                    expand seeds × rotations, start ≤ concurrency GameDOs, budget, ratings,
                    who pays (an own-key run's key lives only here, while the run is active)
                         │ start(GameStart)               ▲ gameFinished / charge
                         ▼                                │            ▲ credentials()
                   GameDO (one per game)           src/game/game-host.ts │ (per wake)
                    only writer of the game: event log + snapshot + cursors + notes +
                    decision deadlines (alarm) + idempotent call results, in DO SQLite;
                    bots play in-process; spectators on hibernatable WebSockets;
                    D1 progress at turn end; R2 archive at the end
                         │ wake(WakeRequest)              ▲ submit / done / inspect /
                         ▼                                │ activity / wakeFinished
                   PlayerDO (one per LLM seat per game) src/player/player-host.ts
                    stores the request, returns, runs the Pi agent from its alarm over the
                    seat's whole-game conversation (@mb/agent runWake → pi-agent-core →
                    pi-ai → OpenRouter)
```

- **No request stays open while a model thinks.** GameDO's `wake` call returns as soon as
  PlayerDO has stored the request and armed its alarm. Tool calls go back to GameDO over
  Durable Object RPC; the wake ends with `wakeFinished`.
- **Idempotency.** Every tool call carries `(gameId, seat, decisionId, callId)`; GameDO stores
  each result and answers duplicates from storage. A stale `decisionId` is refused with
  `terminal: true`, which ends the wake. Wake requests, wake reports, game starts, game
  outcomes, budget charges (one key per wake) and rating updates are all idempotent.
- **Deadlines.** GameDO applies the engine's default (`TimeoutSeat`) when a wake reports
  without answering, or at `wakeTimeoutMs + 30 s` if no report ever arrives; that case also
  writes a timed-out `wakes` row (`endReason: "noReport"`, replaced by the real usage if a
  report still comes). A PlayerDO cut off mid-wake never re-runs the model (it would pay
  twice); it reports `interrupted`.
- **Storage.** Every command writes its events in one transaction; the state snapshot is
  written with LLM commands and once per bot batch, and a restarted object folds the events
  after the snapshot (`evolve`). Bots play at most 400 moves per invocation, then the alarm
  continues (CPU limits).
- **Budget** (`src/runs/budget.ts`). The budget gates LLM wakes, whoever pays: once
  `spentUsd ≥ budgetUsd` RunDO aborts the running games and skips queued ones; GameDO aborts
  instead of dispatching the next wake.
- **Ratings** (`src/ratings/ratings.ts`, `src/db/ratings-store.ts`). OpenSkill Plackett–Luce,
  one table per player count, score `mu − 3σ`, updated by RunDO when a game finishes. Several
  RunDOs may finish games at once, so the update is a D1 batch guarded by a per-table version
  (`rating_tables` + `rating_guard` CHECK) and retried; `rating_history` makes each game
  count once. A competitor holding several seats of a game gets the mean of its seats'
  updates. Only games where every seat is an LLM are rated; the leaderboard, head-to-head,
  models list and profiles also skip bots and games with a bot seat (`src/db/queries.ts`).
- **Catalog and prices** (`src/catalog.ts`). `GET /api/catalog` and run creation share one
  snapshot of OpenRouter's public model list (`GET https://openrouter.ai/api/v1/models`, no
  key), cached an hour per isolate; models that support tools become the catalog
  (`@mb/agent` `catalogFromListings`). A new run may seat only catalog models with a fixed
  price, and their listings are snapshotted into the run, so models newer than pi-ai's bundled
  catalog are priced and a run is charged at stable prices. If OpenRouter fails, pi-ai's
  bundled OpenRouter list stands in (`source: "bundled"`, retried after 5 minutes).
- **Own-key runs** (`src/openrouter-key.ts`, RunDO, PlayerDO). With `x-openrouter-key` the
  key is checked with OpenRouter's `GET /api/v1/key` (refused → 401, unreachable → 502,
  `limit_remaining < budgetUsd` → 400), then handed to RunDO, which keeps it in its SQLite
  `funding` table and stores only the SHA-256 of the run's cancel token. Before every wake
  PlayerDO asks RunDO `credentials()` and calls OpenRouter with that key (memory only, for
  that wake); an own-key run never falls back to the server's key, and a run that is no longer
  active (ended, cancelled, deleted) gives no key at all, so a stray wake fails fast. The key
  is deleted when the
  run finishes, is cancelled or is deleted, and scrubbed (`[redacted key]`) from anything a
  provider error could carry into transcripts, conversation rows or logs. `src/own-key.test.ts`
  plays a whole run on fakes and scans D1, R2, every object's storage, API responses,
  spectator messages and logs for the key.
- **Deleting runs** (`DELETE /api/runs/:id`, `src/archive.ts`). RunDO purges itself: it
  empties the GameDO and PlayerDOs of every started game (work still in flight writes nothing
  more), then its own storage. The Worker deletes the run's R2 objects (one listing of
  `games/<runId>-`, a few requests whatever the run's size), its D1 rows, replays the ratings
  of its player count from the remaining finished games, and deletes the `runs` row last, so
  an interrupted deletion can be retried.
- **Memory** (SPEC §6.2). PlayerDO keeps the seat's conversation for the whole game, one
  SQLite row per message, appended after each wake; a compaction (the same model summarizing
  the older part at the fixed 80k-token budget) rewrites it and is counted in `wakes.compactions`.

### pi-durable: evaluated, not used

`@earendil-works/pi-durable@1.4.0` (`openDurableObjectSqliteStorage(ctx.storage)`) is a full
durable harness with its own generation loop. We use `pi-agent-core`'s `Agent` directly and
persist the conversation ourselves (`conversation` table in PlayerDO, one row per message,
`encodeAgentMessage`/`decodeAgentMessage` in `@mb/agent`), because:

1. **Benchmark parity.** The same `runWake` (pi-agent-core) runs in PlayerDO and in local
   simulations; pi-durable would give production a different agent loop than `apps/cli`.
2. **Its durability fights our rules.** It retries a model request cut off by a crash; we
   want a crashed wake to time out and take the engine's default, never to pay twice or run
   past its deadline. Our wakes last at most `wakeTimeoutMs`; a wake cut off leaves the
   conversation as it was before it.
3. **Stability.** It is marked experimental; 1.2 → 1.3 → 1.4 shipped breaking changes within
   ten days, including a storage migration that cannot be rolled back.
4. **Weight.** ~20k lines plus chord, codemode and Photon WASM, inside every Worker bundle.

## Layout

| Path                         | What                                                                |
| ---------------------------- | ------------------------------------------------------------------- |
| `alchemy.run.ts`             | Stack: Worker, DO namespaces, D1 (+ migrations), R2, secrets        |
| `migrations/`                | D1 schema (SPEC §7.3): `0001_init.sql`, `0002_…` (funding, memory)  |
| `src/worker.ts`              | Entry: `/api/*` → router, else assets; exports the DO classes       |
| `src/api/`                   | Router, auth (bearer, cancel tokens), CORS/JSON helpers             |
| `src/catalog.ts`             | Model catalog: OpenRouter list (1 h cache) or pi-ai's bundled list  |
| `src/openrouter-key.ts`      | Own-key check with OpenRouter's `GET /api/v1/key`                   |
| `src/archive.ts`             | Deleting a run's R2 archives                                        |
| `src/db/`                    | D1 queries (read side), writes, ratings store (update and replay)   |
| `src/runs/`                  | Run expansion, budget, RunDO logic (funding, purge)                 |
| `src/game/engine.ts`         | **The engine seam** (interfaces GameDO depends on)                  |
| `src/game/engine-binding.ts` | The seam bound to `@mb/engine`, `@mb/bots`, `@mb/agent`; D1 records |
| `src/game/game-host.ts`      | GameDO logic                                                        |
| `src/player/player-host.ts`  | PlayerDO logic                                                      |
| `src/do/`                    | Thin `cloudflare:workers` adapters (`GameDO`, `PlayerDO`, `RunDO`)  |
| `src/contracts.ts`           | Payloads between the Worker and the DOs, spectator messages         |
| `src/testing/`               | `node:sqlite` fakes of D1 and DO SQLite, an in-memory R2 bucket     |

The hosts (`GameHost`, `PlayerHost`, `RunCoordinator`) take ports (SQL, D1, R2, other DOs,
alarm, clock), so the unit tests run them against `node:sqlite` with the real migrations.

## API

Public, read-only, `Access-Control-Allow-Origin: *`. Bodies are the `@mb/api` schemas.

| Route                                                  | Response                                                                                                                          |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/catalog`                                     | `CatalogResponse`: OpenRouter models with tools, featured first (`source` `openrouter`, or `bundled` when OpenRouter is down)     |
| `GET /api/leaderboard?players=4`                       | `Leaderboard` (default 4; 2–6), LLM competitors in LLM-only games                                                                 |
| `GET /api/models`                                      | `ModelsResponse` (LLM competitors with rated games)                                                                               |
| `GET /api/models/:id`                                  | `ModelProfile`; the id may be URL-encoded or raw (`a/b:high`); 404 for bots                                                       |
| `GET /api/runs`, `GET /api/runs/:id`                   | `RunsResponse`, `RunDetail`                                                                                                       |
| `GET /api/games?status=live\|finished&players=&model=` | `GamesResponse`; `live` = running games, `finished` = finished, aborted or failed; `model` also matches `<id>:<reasoning>`        |
| `GET /api/games/:id`                                   | `GameSummary`                                                                                                                     |
| `GET /api/games/:id/events?since=`                     | NDJSON, one engine event per line, `seq > since` (live: GameDO; finished: R2 `events.jsonl`)                                      |
| `GET /api/games/:id/transcripts?seat=`                 | NDJSON `WakeTranscript`s (live: GameDO; finished: R2 `seats/<seat>.jsonl`)                                                        |
| `GET /api/games/:id/config`                            | The engine `GameConfig` JSON, for `replay(config, events)` (live: GameDO; finished: R2 `config.json`; 404 before the game starts) |
| `GET /api/games/:id/ws`                                | Spectator WebSocket (server → client only)                                                                                        |

Runs (CORS allows `authorization`, `x-openrouter-key`, `x-run-token` and `DELETE`):

| Route                       | Auth                                                                  | Body        | Response                                     |
| --------------------------- | --------------------------------------------------------------------- | ----------- | -------------------------------------------- |
| `POST /api/runs`            | `Authorization: Bearer <BENCH_API_KEY>`, or `x-openrouter-key: <key>` | `RunConfig` | `201 CreateRunResponse { run, cancelToken }` |
| `POST /api/runs/:id/cancel` | bench bearer, or `x-run-token: <cancelToken>`                         | –           | `200 { run, cancelToken: null }`             |
| `DELETE /api/runs/:id`      | bench bearer                                                          | –           | `204`                                        |

- `x-openrouter-key` decides who pays: with it the run is `funding: "ownKey"` (no bench key
  needed) and `cancelToken` is returned once; without it the bench bearer is required and the
  run is `funding: "server"` (`cancelToken: null`).
- `POST /api/runs` checks the body first (`400`: a bot seat — "Public runs seat LLMs only";
  a `RunConfig` schema error; a model not in the catalog, without tool calling, or without a
  fixed price), then an own key (`401` refused by OpenRouter, `502` OpenRouter unreachable,
  `400` `limit_remaining` below `budgetUsd`).

Errors are `ErrorResponse` (`{ "error": "…" }`) with 400, 401, 404, 426, 500 or 502.

**Spectator protocol** (`SpectatorMessage` in `@mb/api`, `_tag`-tagged JSON):
`Hello { gameId, status, lastSeq, view }` on connect, then `Events { events }`,
`Activity { activity: SeatActivity }` and `Status { status }`. A client connects, then loads
`/events?since=<what it has>` and applies `Events` whose `seq` it has not seen.

## Local development

No Cloudflare account is needed: `alchemy dev` runs the Worker and the Durable Objects in
workerd with local D1, R2 and SQLite, and keeps Alchemy state in `apps/worker/.alchemy/`.

```sh
bun install
bun run --cwd apps/web build     # optional: without it a placeholder page is served
cd apps/worker && bun run dev    # http://localhost:1337 (next free port if taken)
```

In dev, `BENCH_API_KEY` defaults to `dev-bench-key` and `OPENROUTER_API_KEY` to empty; put
real values in `apps/worker/.env` (or the environment) to override them. Without an
OpenRouter key LLM seats fail fast with "Provider is not configured" (no request is sent)
and GameDO applies the default action, which exercises the whole wake pipeline for free.
Public runs seat LLMs only; bot games run with `mb sim`.

```sh
curl -s localhost:1337/api/catalog | head -c 600
curl -s -X POST localhost:1337/api/runs -H 'authorization: Bearer dev-bench-key' -d '{
  "name": "local", "seeds": 1, "maxRounds": 10, "budgetUsd": 1,
  "players": [{"_tag":"llm","model":"anthropic/claude-haiku-5.5","label":"Claude Haiku 5.5"},
              {"_tag":"llm","model":"openai/gpt-6.1-sol","label":"GPT-6.1 Sol"}]}'
curl -s localhost:1337/api/runs/<run id>
curl -s 'localhost:1337/api/leaderboard?players=2'
curl -s 'localhost:1337/api/games/<game id>/events?since=0'
curl -s -X DELETE localhost:1337/api/runs/<run id> -H 'authorization: Bearer dev-bench-key'
```

An own-key run (the key is checked with OpenRouter first, so it must be a real key; the
response carries the cancel token once):

```sh
curl -s -X POST localhost:1337/api/runs -H "x-openrouter-key: $MY_OPENROUTER_KEY" -d @run.json
curl -s -X POST localhost:1337/api/runs/<run id>/cancel -H 'x-run-token: <cancel token>'
```

Verified locally with `alchemy dev` (2026-10-28, real engine): D1 migrations, SPA fallback,
a 6-game 3-player bot run of real Monopoly (bankruptcies and turn caps; RunDO concurrency,
D1 summaries with offers/auctions/counters, R2 archive, ratings, leaderboard, head-to-head,
model profiles with behavior stats), `events`/`transcripts` NDJSON, `config` JSON,
`games?status=live` during a 4-player run, a mixed run with an LLM seat and no key (54 wakes:
PlayerDO alarm → pi-agent-core with the OpenRouter provider bundled in the Worker → report →
default move; transcripts carry the real wake messages), and spectator WebSockets (`Hello`,
`Events`, `Activity`, `Status`). Code changes hot-reload; a reload interrupts in-flight wakes,
which then time out. The catalog, own-key runs, run deletion and whole-game memory (added
later the same day) are covered by unit tests on fakes and have not been run under
`alchemy dev` yet.

Tests: `bunx vp test` from the repo root (unit tests use `node:sqlite`, no workerd).

## Deploy

1. **Cloudflare credentials** in an Alchemy profile (stored under `~/.alchemy/`, no env vars):
   - interactive (OAuth or token): `bunx alchemy profile edit --add Cloudflare`
   - non-interactive (CI):
     `bunx alchemy profile edit --add Cloudflare --method stored --set apiToken=env:CLOUDFLARE_API_TOKEN --set accountId=<account id>`
   - pick a profile with `--profile <name>` or `ALCHEMY_PROFILE`.
2. **Secrets** in the environment or `apps/worker/.env`: `BENCH_API_KEY` (any long random
   string; the run form and CLI send it as Bearer) and `OPENROUTER_API_KEY` (pays for
   server-funded runs; own-key runs use the creator's key). Both are bound as `secret_text`.
   Deploys fail if either is missing. The D1 migrations (`migrations/`) apply on deploy.
3. **Build the web app**: `bun run --cwd apps/web build` (the stack serves `apps/web/dist`;
   without it the placeholder page is deployed and a warning is printed).
4. **Deploy**: `bun run --cwd apps/worker deploy` (stage `live_$USER` by default; pass
   `--stage prod` for production). The first deploy with `Cloudflare.state()` bootstraps
   Alchemy's state-store Worker in the account; set `ALCHEMY_STATE=local` to keep state in
   `.alchemy/` instead.
5. **Destroy**: `bun run --cwd apps/worker destroy` (add `--stage` as for deploy).

## Playing LLMs locally (CLI)

`mb sim` runs the same harness in-process (`@mb/agent` `runWake`, tool calls applied to the
game as they come), reading `OPENROUTER_API_KEY` from the environment:

```sh
OPENROUTER_API_KEY=… bun run sim -- --seats heuristic,llm:anthropic/claude-haiku-5.5 \
  --max-rounds 10 --budget-usd 0.50 --seed 1
```

It prints every wake, the standings with per-seat wakes, tool calls, invalid actions,
timeouts, tokens and cost, and writes `out/<gameId>.{config.json,events.jsonl,transcripts.jsonl}`.
`--budget-usd` is a hard stop: no wake starts once it is spent and the game is aborted. Each
LLM seat keeps its whole-game conversation in memory, compacted like in PlayerDO.
`mb run create <config.json>` / `mb run status <id>` drive a deployed bench (`BENCH_URL`, and
`BENCH_API_KEY` to create); `mb run create <config.json> --openrouter-key-env VAR` creates an
own-key run paid with the OpenRouter key in `$VAR` and prints its cancel token.

## What the models see

The system prompt is built from the game's `RulesConfig` (`buildSystemPrompt`) and the wake
message from the pending `DecisionRequest`, the seat's `PlayerView`, the digest since its last
wake, the session's offers and threads, and its notes (`renderWakeMessage`). A rendered
example is checked in at `packages/agent/src/__snapshots__/wake-message.txt` (a file
snapshot test). Tool parameters mirror the engine commands (a test compares fields and
literals); deeds are accepted by printed name, slug (`boardwalk`) or board position, and every
refusal carries the engine's `IllegalCommand` reason.

Every wake message is appended to the seat's whole-game conversation (SPEC §6.2), so a model
remembers the whole game; when the conversation would pass 80 000 tokens (or 60% of a smaller
context window), the same model summarizes everything but its last 6 wakes with a fixed
instruction (`COMPACTION_PROMPT` in `@mb/agent`). The transcript of that wake starts with a
`[memory]` line and the summary; its usage and cost are in the wake's.

## Before release

- One real low-budget LLM game (SPEC §11), e.g. the `mb sim` command above, then a small
  deployed run.
