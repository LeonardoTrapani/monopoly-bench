-- Own-key runs (SPEC.md §7.2) and whole-game memory (SPEC.md §6.2).

-- Who pays for a run's model calls: the server's OpenRouter key or the creator's own key.
ALTER TABLE runs ADD COLUMN funding TEXT NOT NULL DEFAULT 'server' CHECK (funding IN ('server', 'ownKey'));

-- Conversation compactions that ran before the wake's first request (their cost is in cost_usd).
ALTER TABLE wakes ADD COLUMN compactions INTEGER NOT NULL DEFAULT 0;

-- Rating replays (DELETE /api/runs/:id) read the finished games of one player count in order.
CREATE INDEX games_rated ON games (players_count, status, finished_at);
