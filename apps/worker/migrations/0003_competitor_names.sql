-- Leaderboard names (SPEC.md §8): the catalog name of each competitor, written by the server
-- when a run is created. Seat labels are free text chosen per run and name a seat only in its
-- own games, so a custom label never renames a model on the leaderboard.
CREATE TABLE competitors (
  competitor_id TEXT PRIMARY KEY,
  name TEXT NOT NULL
);
