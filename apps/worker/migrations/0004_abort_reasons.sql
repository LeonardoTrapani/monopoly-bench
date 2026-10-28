-- Why a game was aborted (SPEC.md §6.5): budget exhausted, run cancelled, a seat's model
-- failing wakes in a row, or the engine refusing a default. NULL for games that were not.
ALTER TABLE games ADD COLUMN abort_reason TEXT;
