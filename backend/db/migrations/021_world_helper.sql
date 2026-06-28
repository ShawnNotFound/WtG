ALTER TABLE game_sessions
  ADD COLUMN IF NOT EXISTS module_llm_config JSONB NOT NULL DEFAULT '{}';

COMMENT ON COLUMN game_sessions.module_llm_config IS
  'Optional per-module LLM overrides keyed by juror, world, summary, and helper. Falls back to llm_config when omitted.';

CREATE TABLE IF NOT EXISTS world_helper_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
  player_id UUID NOT NULL REFERENCES session_players(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  streamed_text TEXT NOT NULL DEFAULT '',
  answer JSONB NOT NULL DEFAULT '{}',
  cited_headline_ids JSONB NOT NULL DEFAULT '[]',
  cited_node_ids JSONB NOT NULL DEFAULT '[]',
  cited_edge_ids JSONB NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'streaming', 'completed', 'error')),
  model TEXT,
  usage JSONB NOT NULL DEFAULT '{}',
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_world_helper_messages_player
  ON world_helper_messages(session_id, player_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_world_helper_messages_session
  ON world_helper_messages(session_id, created_at DESC);

DROP TRIGGER IF EXISTS update_world_helper_messages_updated_at ON world_helper_messages;
CREATE TRIGGER update_world_helper_messages_updated_at
  BEFORE UPDATE ON world_helper_messages
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE world_helper_messages IS
  'Private per-player world helper Q&A turns. Visible to admins for review.';
