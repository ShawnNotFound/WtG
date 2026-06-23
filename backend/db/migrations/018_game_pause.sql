ALTER TABLE game_sessions
  ADD COLUMN is_paused BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN paused_at TIMESTAMPTZ NULL,
  ADD COLUMN pause_remaining_ms INTEGER NULL,
  ADD COLUMN pause_timeline_speed_ratio DOUBLE PRECISION NULL;

COMMENT ON COLUMN game_sessions.is_paused IS 'Whether the game loop is administratively paused without changing the current phase.';
COMMENT ON COLUMN game_sessions.pause_remaining_ms IS 'Remaining real milliseconds in the current timed phase at the moment of pause.';
COMMENT ON COLUMN game_sessions.pause_timeline_speed_ratio IS 'Timeline speed ratio to restore when the paused phase resumes.';
