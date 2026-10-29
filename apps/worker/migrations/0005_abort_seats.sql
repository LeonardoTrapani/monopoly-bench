-- The seat whose own model failed wakes in a row and aborted the game (SPEC.md §6.5). NULL
-- when the abort was not that model's fault: budget, cancel, engine, or an account/provider
-- error such as no credits (402), rate limits (429) or provider outages (5xx).
ALTER TABLE games ADD COLUMN abort_seat TEXT;
