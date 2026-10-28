# @mb/worker

The monopoly-bench backend on Cloudflare (SPEC.md §7): one Worker with the HTTP API and the
web app's static assets, three SQLite-backed Durable Objects, D1 for statistics, R2 for game
archives. Infrastructure is declared with Alchemy v2 in [`alchemy.run.ts`](./alchemy.run.ts).

**Phase 1 status.** Everything except the rules engine is real. Games run on a placeholder dice
game bound to the engine seam (`src/game/stub-engine.ts`) so runs, bots, LLM wakes, spectators,
D1, R2 and ratings work end to end. Phase 2 swaps in `@mb/engine` (see the checklist below).

## Architecture

```
browser / CLI ──HTTP──▶ Worker (src/worker.ts)
                         ├─ /api/*  → src/api/router.ts (Effect, D1 via @effect/sql-d1)
                         └─ else    → static assets of apps/web/dist (SPA fallback)

POST /api/runs ──▶ RunDO (one per run)          src/runs/run-coordinator.ts
                    expand seeds × rotations, start ≤ concurrency GameDOs, budget, ratings
                         │ start(GameStart)               ▲ gameFinished / charge
                         ▼                                │
                   GameDO (one per game)           src/game/game-host.ts
                    only writer of the game: event log + snapshot + cursors + notes +
                    decision deadlines (alarm) + idempotent call results, in DO SQLite;
                    bots play in-process; spectators on hibernatable WebSockets;
                    D1 progress at turn end; R2 archive at the end
                         │ wake(WakeRequest)              ▲ submit / done / inspect /
                         ▼                                │ activity / wakeFinished
                   PlayerDO (one per LLM seat per game) src/player/player-host.ts
                    stores the request, returns, runs the Pi agent from its alarm
                    (@mb/agent runWake → pi-agent-core → pi-ai → OpenRouter)
```

- **No request stays open while a model thinks.** GameDO's `wake` call returns as soon as
  PlayerDO has stored the request and armed its alarm. Tool calls go back to GameDO over
  Durable Object RPC; the wake ends with `wakeFinished`.
- **Idempotency.** Every tool call carries `(gameId, seat, decisionId, callId)`; GameDO stores
  each result and answers duplicates from storage. A stale `decisionId` is refused with
  `terminal: true`, which ends the wake. Wake requests, wake reports, game starts, game
  outcomes, budget charges (one key per wake) and rating updates are all idempotent.
- **Deadlines.** GameDO applies the engine's default (`TimeoutSeat`) when a wake reports
  without answering, or at `wakeTimeoutMs + 30 s` if no report ever arrives. A PlayerDO
  cut off mid-wake never re-runs the model (it would pay twice); it reports `interrupted`.
- **Budget** (`src/runs/budget.ts`). The budget gates LLM wakes: once `spentUsd ≥ budgetUsd`
  RunDO aborts the running games that have LLM seats and skips queued ones; GameDO aborts
  instead of dispatching the next wake. Bot-only games cost nothing and keep running.
- **Ratings** (`src/ratings/ratings.ts`, `src/db/ratings-store.ts`). OpenSkill Plackett–Luce,
  one table per player count, score `mu − 3σ`, updated by RunDO when a game finishes. Several
  RunDOs may finish games at once, so the update is a D1 batch guarded by a per-table version
  (`rating_tables` + `rating_guard` CHECK) and retried; `rating_history` makes each game
  count once. A competitor holding several seats of a game gets the mean of its seats'
  updates.
- **Prices.** `POST /api/runs` snapshots OpenRouter's public model list
  (`GET https://openrouter.ai/api/v1/models`, no key) into the run, so models newer than
  pi-ai's bundled catalog are priced and a run is charged at stable prices.

### pi-durable: evaluated, not used

`@earendil-works/pi-durable@1.4.0` (`openDurableObjectSqliteStorage(ctx.storage)`) is a full
durable harness with its own generation loop. We use `pi-agent-core`'s `Agent` directly and
persist the session ourselves (`session` table in PlayerDO, `encodeSession`/`decodeSession`
in `@mb/agent`), because:

1. **Benchmark parity.** The same `runWake` (pi-agent-core) runs in PlayerDO and in local
   simulations; pi-durable would give production a different agent loop than `apps/cli`.
2. **Its durability fights our rules.** It retries a model request cut off by a crash; we
   want a crashed wake to time out and take the engine's default, never to pay twice or run
   past its deadline. Our wakes last at most `wakeTimeoutMs`, and sessions are a few rounds.
3. **Stability.** It is marked experimental; 1.2 → 1.3 → 1.4 shipped breaking changes within
   ten days, including a storage migration that cannot be rolled back.
4. **Weight.** ~20k lines plus chord, codemode and Photon WASM, inside every Worker bundle.

## Layout

| Path                        | What                                                               |
| --------------------------- | ------------------------------------------------------------------ |
| `alchemy.run.ts`            | Stack: Worker, DO namespaces, D1 (+ migrations), R2, secrets       |
| `migrations/0001_init.sql`  | D1 schema (SPEC §7.3)                                              |
| `src/worker.ts`             | Entry: `/api/*` → router, else assets; exports the DO classes      |
| `src/api/`                  | Router, bearer auth (constant-time), CORS/JSON helpers             |
| `src/db/`                   | D1 queries (read side), writes, ratings store                      |
| `src/runs/`                 | Run expansion, budget, RunDO logic                                 |
| `src/game/engine.ts`        | **The engine seam** (interfaces GameDO depends on)                 |
| `src/game/stub-engine.ts`   | Phase-1 placeholder binding of the seam                            |
| `src/game/game-host.ts`     | GameDO logic                                                       |
| `src/player/player-host.ts` | PlayerDO logic                                                     |
| `src/do/`                   | Thin `cloudflare:workers` adapters (`GameDO`, `PlayerDO`, `RunDO`) |
| `src/contracts.ts`          | Payloads between the Worker and the DOs, spectator messages        |
| `src/testing/sqlite.ts`     | `node:sqlite` fakes of D1 and DO SQLite for unit tests             |

The hosts (`GameHost`, `PlayerHost`, `RunCoordinator`) take ports (SQL, D1, R2, other DOs,
alarm, clock), so the unit tests run them against `node:sqlite` with the real migrations.

## API

Public, read-only, `Access-Control-Allow-Origin: *`. Bodies are the `@mb/api` schemas.

| Route                                                  | Response                                                                                     |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `GET /api/leaderboard?players=4`                       | `Leaderboard` (default 4; 2–6)                                                               |
| `GET /api/models`                                      | `ModelsResponse` (competitors with games + catalog)                                          |
| `GET /api/models/:id`                                  | `ModelProfile`; the id may be URL-encoded or raw (`a/b:high`)                                |
| `GET /api/runs`, `GET /api/runs/:id`                   | `RunsResponse`, `RunDetail`                                                                  |
| `GET /api/games?status=live\|finished&players=&model=` | `GamesResponse` (`model` also matches `<id>:<reasoning>`)                                    |
| `GET /api/games/:id`                                   | `GameSummary`                                                                                |
| `GET /api/games/:id/events?since=`                     | NDJSON, one engine event per line, `seq > since` (live: GameDO; finished: R2 `events.jsonl`) |
| `GET /api/games/:id/transcripts?seat=`                 | NDJSON `WakeTranscript`s (live: GameDO; finished: R2 `seats/<seat>.jsonl`)                   |
| `GET /api/games/:id/ws`                                | Spectator WebSocket (server → client only)                                                   |

Protected, `Authorization: Bearer <BENCH_API_KEY>`:

| Route                       | Body        | Response                  |
| --------------------------- | ----------- | ------------------------- |
| `POST /api/runs`            | `RunConfig` | `201 CreateRunResponse`   |
| `POST /api/runs/:id/cancel` | –           | `200 { run: RunSummary }` |

Errors are `ErrorResponse` (`{ "error": "…" }`) with 400, 401, 404, 426 or 500.

**Spectator protocol** (`SpectatorMessage` in `src/contracts.ts`, `_tag`-tagged JSON):
`Hello { gameId, status, lastSeq, view }` on connect, then `Events { events }`,
`Activity { activity: SeatActivity }` and `Status { status }`. A client connects, then loads
`/events?since=<what it has>` and applies `Events` whose `seq` it has not seen.

## Local development

No Cloudflare account is needed: `alchemy dev` runs the Worker and the Durable Objects in
workerd with local D1, R2 and SQLite, and keeps Alchemy state in `apps/worker/.alchemy/`.

```sh
bun install
bun --cwd apps/web run build     # optional: without it a placeholder page is served
cd apps/worker && bun run dev    # http://localhost:1337 (next free port if taken)
```

In dev, `BENCH_API_KEY` defaults to `dev-bench-key` and `OPENROUTER_API_KEY` to empty; put
real values in `apps/worker/.env` (or the environment) to override them. Without an
OpenRouter key LLM seats fail fast with "Provider is not configured" (no request is sent)
and GameDO applies the default action, which exercises the whole wake pipeline for free.

```sh
curl -s localhost:1337/api/runs
curl -s -X POST localhost:1337/api/runs -H 'authorization: Bearer dev-bench-key' -d '{
  "name": "local bots", "seeds": 2, "maxRounds": 20, "budgetUsd": 0,
  "players": [{"_tag":"bot","policy":"random"}, {"_tag":"bot","policy":"heuristic"}]}'
curl -s localhost:1337/api/runs/<run id>
curl -s 'localhost:1337/api/leaderboard?players=2'
curl -s 'localhost:1337/api/games/<game id>/events?since=0'
```

Verified locally with `alchemy dev` (2026-10-28): D1 migrations, SPA fallback, a 6-game
bot run (RunDO concurrency, GameDO, D1 summaries, R2 archive, ratings, leaderboard,
head-to-head, profiles), LLM seats without a key (PlayerDO alarm → pi-agent-core with the
OpenRouter provider bundled in the Worker → report → default action), spectator WebSockets
(`Hello`, `Events`, `Activity`) and recovery of a game whose wake report was cut off by a hot
reload (deadline alarm). Code changes hot-reload; a reload interrupts in-flight wakes, which
then time out.

Tests: `bunx vp test` from the repo root (unit tests use `node:sqlite`, no workerd).

## Deploy

1. **Cloudflare credentials** in an Alchemy profile (stored under `~/.alchemy/`, no env vars):
   - interactive (OAuth or token): `bunx alchemy profile edit --add Cloudflare`
   - non-interactive (CI):
     `bunx alchemy profile edit --add Cloudflare --method stored --set apiToken=env:CLOUDFLARE_API_TOKEN --set accountId=<account id>`
   - pick a profile with `--profile <name>` or `ALCHEMY_PROFILE`.
2. **Secrets** in the environment or `apps/worker/.env`: `BENCH_API_KEY` (any long random
   string; the run form and CLI send it as Bearer) and `OPENROUTER_API_KEY`. Both are bound
   as `secret_text`. Deploys fail if either is missing.
3. **Build the web app**: `bun --cwd apps/web run build` (the stack serves `apps/web/dist`;
   without it the placeholder page is deployed and a warning is printed).
4. **Deploy**: `bun --cwd apps/worker deploy` (stage `live_$USER` by default; pass
   `--stage prod` for production). The first deploy with `Cloudflare.state()` bootstraps
   Alchemy's state-store Worker in the account; set `ALCHEMY_STATE=local` to keep state in
   `.alchemy/` instead.
5. **Destroy**: `bun --cwd apps/worker destroy` (add `--stage` as for deploy).

## Phase 2 checklist

1. **Bind the engine.** Implement `EngineBinding<GameState, GameEvent, Command>`
   (`src/game/engine.ts`) with `@mb/engine`: `newGame`, `apply`, `pending`, `playerView`,
   `spectatorView`, `digest`, `visibleTo`, `standings`, `timeoutCommand` (`TimeoutSeat`),
   `abortCommand` (`AbortGame`), and the codec (Effect schemas → JSON). `pending` must give
   each awaited seat its `decisionId`, `frame`, `round`, wake `reasons`, a `sessionKey` shared
   by the rounds of one session, and the legal tool names.
2. **Seat adapter.** `commandFromTool` (tool name + args → engine command), `botCommand`
   (`@mb/bots` policies), `wakeContext` (the agent's view renderer: compact `playerView`, the
   question, open offers and threads), `inspect`, and `records` (offers, auctions and seat
   counters from the event log, for D1 behavior stats).
3. **Swap it in** `src/do/game-do.ts` (replace `stubEngineBinding`) and delete
   `stub-engine.ts`; adapt `game-host.test.ts` to the real engine (bot-only games end to end).
4. **Tool schemas.** Check `@mb/agent`'s hand-written TypeBox parameters
   (`packages/agent/src/tools.ts`) against the engine's command schemas, or derive them
   (`Schema.toJsonSchemaDocument`; pi-ai validates plain JSON Schema too), and align
   `PROPERTY_GROUPS` and deed names with the engine's data.
5. **Game settings.** Pass `maxTableRounds`, offer/message limits and `notesMaxChars` from the
   engine config into `buildSystemPrompt` (GameHost uses SPEC §12 defaults today).
6. **One real low-budget LLM game** before release (SPEC §11), then calibrate `maxRounds`.
