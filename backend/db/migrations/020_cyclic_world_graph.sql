ALTER TABLE game_sessions
  ALTER COLUMN world_state_config SET DEFAULT '{
    "enabled": true,
    "allowCycles": true,
    "maxPropagationDepth": 2,
    "maxNodeReactions": 20,
    "maxEventsPerNode": 2,
    "nodeAgentConcurrency": 4,
    "storeUnaffectedDecisions": true
  }'::jsonb;

UPDATE game_sessions
SET world_state_config = '{
    "enabled": true,
    "allowCycles": true,
    "maxPropagationDepth": 2,
    "maxNodeReactions": 20,
    "maxEventsPerNode": 2,
    "nodeAgentConcurrency": 4,
    "storeUnaffectedDecisions": true
  }'::jsonb || COALESCE(world_state_config, '{}'::jsonb)
WHERE world_state_config IS NULL
   OR NOT (world_state_config ? 'allowCycles')
   OR NOT (world_state_config ? 'maxPropagationDepth')
   OR NOT (world_state_config ? 'maxNodeReactions')
   OR NOT (world_state_config ? 'maxEventsPerNode')
   OR NOT (world_state_config ? 'nodeAgentConcurrency')
   OR NOT (world_state_config ? 'storeUnaffectedDecisions');

CREATE TABLE IF NOT EXISTS world_state_reactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES world_state_jobs(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
  headline_id UUID REFERENCES game_session_headlines(id) ON DELETE SET NULL,
  node_id UUID REFERENCES world_state_nodes(id) ON DELETE SET NULL,
  node_name TEXT NOT NULL,
  source_node_id UUID REFERENCES world_state_nodes(id) ON DELETE SET NULL,
  source_node_name TEXT,
  source_event_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  depth INTEGER NOT NULL CHECK (depth >= 0),
  status TEXT NOT NULL CHECK (status IN ('affected', 'unaffected', 'skipped', 'error')),
  confidence DOUBLE PRECISION,
  rationale TEXT,
  state_delta TEXT,
  updated_summary TEXT,
  emitted_events JSONB NOT NULL DEFAULT '[]',
  proposed_edges JSONB NOT NULL DEFAULT '[]',
  model TEXT,
  usage JSONB NOT NULL DEFAULT '{}',
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_world_state_reactions_job_depth
  ON world_state_reactions(job_id, depth, created_at);

CREATE INDEX IF NOT EXISTS idx_world_state_reactions_session_node
  ON world_state_reactions(session_id, node_id, created_at DESC);

COMMENT ON TABLE world_state_nodes IS 'Session-local cyclic actor-entity world graph nodes extracted from seed history and submitted headlines.';
COMMENT ON TABLE world_state_edges IS 'Directed relationships between world state nodes. Cycles are allowed; self-edges are rejected by constraint.';
COMMENT ON TABLE world_state_reactions IS 'Durable per-node entity-agent decisions created while propagating headline effects through the world graph.';
