ALTER TABLE game_sessions
  ADD COLUMN IF NOT EXISTS world_state_config JSONB NOT NULL DEFAULT '{"enabled": true}';

CREATE TABLE IF NOT EXISTS world_state_nodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'entity',
  summary TEXT NOT NULL DEFAULT '',
  attributes JSONB NOT NULL DEFAULT '{}',
  times_updated INTEGER NOT NULL DEFAULT 0 CHECK (times_updated >= 0),
  first_seen_headline_id UUID REFERENCES game_session_headlines(id) ON DELETE SET NULL,
  last_seen_headline_id UUID REFERENCES game_session_headlines(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_world_state_nodes_session_name
  ON world_state_nodes(session_id, lower(name));

CREATE INDEX IF NOT EXISTS idx_world_state_nodes_session_updated
  ON world_state_nodes(session_id, times_updated DESC, updated_at DESC);

DROP TRIGGER IF EXISTS update_world_state_nodes_updated_at ON world_state_nodes;
CREATE TRIGGER update_world_state_nodes_updated_at
  BEFORE UPDATE ON world_state_nodes
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS world_state_edges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
  source_node_id UUID NOT NULL REFERENCES world_state_nodes(id) ON DELETE CASCADE,
  target_node_id UUID NOT NULL REFERENCES world_state_nodes(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL DEFAULT 'RELATED_TO',
  summary TEXT NOT NULL DEFAULT '',
  weight DOUBLE PRECISION NOT NULL DEFAULT 1,
  times_updated INTEGER NOT NULL DEFAULT 0 CHECK (times_updated >= 0),
  first_seen_headline_id UUID REFERENCES game_session_headlines(id) ON DELETE SET NULL,
  last_seen_headline_id UUID REFERENCES game_session_headlines(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_world_state_edges_not_self CHECK (source_node_id <> target_node_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_world_state_edges_unique
  ON world_state_edges(session_id, source_node_id, target_node_id, lower(relation_type));

CREATE INDEX IF NOT EXISTS idx_world_state_edges_session
  ON world_state_edges(session_id, source_node_id, target_node_id);

DROP TRIGGER IF EXISTS update_world_state_edges_updated_at ON world_state_edges;
CREATE TRIGGER update_world_state_edges_updated_at
  BEFORE UPDATE ON world_state_edges
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS world_state_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
  headline_id UUID REFERENCES game_session_headlines(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('initial', 'headline', 'manual')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'error')),
  stage TEXT NOT NULL DEFAULT 'queued',
  agent TEXT NOT NULL DEFAULT 'world-state-agent',
  headline_text TEXT,
  input_snapshot JSONB NOT NULL DEFAULT '{}',
  result JSONB NOT NULL DEFAULT '{}',
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_world_state_jobs_session_status
  ON world_state_jobs(session_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_world_state_jobs_queue
  ON world_state_jobs(status, created_at);

DROP TRIGGER IF EXISTS update_world_state_jobs_updated_at ON world_state_jobs;
CREATE TRIGGER update_world_state_jobs_updated_at
  BEFORE UPDATE ON world_state_jobs
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE world_state_nodes IS 'Session-local actor-entity world graph nodes extracted from seed history and submitted headlines.';
COMMENT ON COLUMN world_state_nodes.times_updated IS 'Number of headline/world-model updates that touched this node after creation.';
COMMENT ON TABLE world_state_edges IS 'Directed relationships between world state nodes.';
COMMENT ON TABLE world_state_jobs IS 'Durable queue/status table for asynchronous world-state graph construction and headline update processing.';
