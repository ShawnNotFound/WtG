-- Update default round format for new games:
-- 4 rounds, 8 minutes each. Break durations are now controlled by BREAK_SCHEDULE
-- in the game loop code (3min, 5min, 3min) — break_minutes column becomes unused
-- but is kept for backwards compatibility.
ALTER TABLE game_sessions
  ALTER COLUMN play_minutes SET DEFAULT 8,
  ALTER COLUMN max_rounds SET DEFAULT 4;
