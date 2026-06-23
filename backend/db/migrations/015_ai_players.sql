ALTER TABLE session_players
  ADD COLUMN IF NOT EXISTS is_ai BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS ai_config JSONB NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_session_players_ai
  ON session_players(session_id, is_ai)
  WHERE is_ai = TRUE;
