-- monopoly-bench D1 schema (SPEC.md §7.3). Applied by Alchemy on deploy and in `alchemy dev`.
-- Timestamps are ISO-8601 UTC strings. Money is US dollars (REAL).

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  name TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'finished', 'cancelled', 'failed')),
  players_count INTEGER NOT NULL,
  -- RunConfig and its SeatSpec[] as JSON (encoded with the @mb/api schemas).
  config_json TEXT NOT NULL,
  seats_json TEXT NOT NULL,
  games_total INTEGER NOT NULL,
  spent_usd REAL NOT NULL DEFAULT 0,
  budget_usd REAL NOT NULL
);

CREATE INDEX runs_created ON runs (created_at DESC);

CREATE TABLE games (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs (id),
  game_index INTEGER NOT NULL,
  seed_index INTEGER NOT NULL,
  rotation INTEGER NOT NULL,
  seed TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'finished', 'aborted', 'failed')),
  players_count INTEGER NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  turn INTEGER NOT NULL DEFAULT 0,
  round INTEGER NOT NULL DEFAULT 0,
  end_reason TEXT CHECK (end_reason IN ('lastPlayerStanding', 'turnCap', 'aborted')),
  winner_seat TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX games_run ON games (run_id, game_index);

CREATE INDEX games_status ON games (status, players_count);

-- One row per seat of a game. Usage columns (cost, wakes, invalid actions, timeouts) are
-- aggregated from `wakes` at read time, so retried wake writes never double count.
CREATE TABLE seats (
  game_id TEXT NOT NULL REFERENCES games (id),
  seat TEXT NOT NULL,
  competitor_id TEXT NOT NULL,
  label TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('llm', 'bot')),
  spec_json TEXT NOT NULL,
  final_rank INTEGER,
  net_worth REAL,
  cash REAL,
  bankrupt_at_turn INTEGER,
  -- Behavior counters from the engine's records (SPEC §9 model pages).
  properties_bought INTEGER NOT NULL DEFAULT 0,
  houses_built INTEGER NOT NULL DEFAULT 0,
  hotels_built INTEGER NOT NULL DEFAULT 0,
  mortgages INTEGER NOT NULL DEFAULT 0,
  jail_turns INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (game_id, seat)
);

CREATE INDEX seats_competitor ON seats (competitor_id, game_id);

-- One row per wake of an LLM seat (SPEC §7.3).
CREATE TABLE wakes (
  game_id TEXT NOT NULL REFERENCES games (id),
  seat TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  competitor_id TEXT NOT NULL,
  turn INTEGER NOT NULL,
  kind TEXT NOT NULL,
  round INTEGER NOT NULL,
  reasons_json TEXT NOT NULL,
  started_at TEXT NOT NULL,
  latency_ms INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  reasoning_tokens INTEGER NOT NULL,
  cost_usd REAL NOT NULL,
  tool_calls INTEGER NOT NULL,
  invalid_actions INTEGER NOT NULL,
  timed_out INTEGER NOT NULL CHECK (timed_out IN (0, 1)),
  end_reason TEXT NOT NULL,
  PRIMARY KEY (game_id, seat, decision_id)
);

CREATE INDEX wakes_competitor ON wakes (competitor_id);

CREATE TABLE offers (
  game_id TEXT NOT NULL REFERENCES games (id),
  offer_id TEXT NOT NULL,
  turn INTEGER NOT NULL,
  round INTEGER NOT NULL,
  from_seat TEXT NOT NULL,
  from_competitor TEXT NOT NULL,
  -- NULL for an open offer.
  to_seat TEXT,
  to_competitor TEXT,
  give_json TEXT NOT NULL,
  get_json TEXT NOT NULL,
  reply_to TEXT,
  comment TEXT,
  status TEXT NOT NULL CHECK (status IN ('open', 'accepted', 'rejected', 'withdrawn', 'expired', 'invalidated')),
  accepted_by_seat TEXT,
  accepted_by_competitor TEXT,
  PRIMARY KEY (game_id, offer_id)
);

CREATE INDEX offers_from ON offers (from_competitor);

CREATE INDEX offers_to ON offers (to_competitor);

CREATE INDEX offers_accepted_by ON offers (accepted_by_competitor);

CREATE TABLE auctions (
  game_id TEXT NOT NULL REFERENCES games (id),
  auction_id TEXT NOT NULL,
  turn INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('property', 'building')),
  property TEXT NOT NULL,
  list_price REAL NOT NULL,
  winner_seat TEXT,
  winner_competitor TEXT,
  price REAL,
  bids INTEGER NOT NULL,
  PRIMARY KEY (game_id, auction_id)
);

CREATE INDEX auctions_winner ON auctions (winner_competitor);

-- One rating table per player count (SPEC §8): OpenSkill Plackett-Luce, score = mu - 3 sigma.
CREATE TABLE ratings (
  competitor_id TEXT NOT NULL,
  players_count INTEGER NOT NULL,
  label TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('llm', 'bot')),
  mu REAL NOT NULL,
  sigma REAL NOT NULL,
  score REAL NOT NULL,
  games INTEGER NOT NULL,
  wins INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (competitor_id, players_count)
);

CREATE TABLE rating_history (
  competitor_id TEXT NOT NULL,
  players_count INTEGER NOT NULL,
  game_id TEXT NOT NULL,
  at TEXT NOT NULL,
  mu REAL NOT NULL,
  sigma REAL NOT NULL,
  score REAL NOT NULL,
  PRIMARY KEY (game_id, competitor_id)
);

CREATE INDEX rating_history_competitor ON rating_history (competitor_id, players_count, at);

-- Optimistic concurrency for rating updates. Several RunDOs may finish games at once; each
-- update bumps the version of its player-count table inside one D1 batch and the guard row
-- fails the whole batch (CHECK) when the version moved since it was read. See
-- apps/worker/src/db/ratings-store.ts.
CREATE TABLE rating_tables (
  players_count INTEGER PRIMARY KEY,
  version INTEGER NOT NULL,
  updated_at TEXT
);

CREATE TABLE rating_guard (
  ok INTEGER NOT NULL CHECK (ok = 1)
);
