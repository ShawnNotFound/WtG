ALTER TABLE game_sessions
  ADD COLUMN IF NOT EXISTS title TEXT NOT NULL DEFAULT 'Future Headlines',
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

UPDATE game_sessions
SET title = 'Future Headlines'
WHERE btrim(title) = '';

CREATE INDEX IF NOT EXISTS idx_game_sessions_archived_at
  ON game_sessions(archived_at);

COMMENT ON COLUMN game_sessions.title IS
  'Human-readable game/session title shown in player and admin UI.';

COMMENT ON COLUMN game_sessions.archived_at IS
  'Set when a session is hidden from normal active session lists and player access.';
