-- Dense directed connection-strength matrix for experimental world-state retrieval.

CREATE TABLE IF NOT EXISTS world_state_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
  source_node_id UUID NOT NULL REFERENCES world_state_nodes(id) ON DELETE CASCADE,
  target_node_id UUID NOT NULL REFERENCES world_state_nodes(id) ON DELETE CASCADE,
  strength DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (strength >= 0 AND strength <= 1),
  rationale TEXT NOT NULL DEFAULT '',
  times_updated INTEGER NOT NULL DEFAULT 0 CHECK (times_updated >= 0),
  first_seen_headline_id UUID REFERENCES game_session_headlines(id) ON DELETE SET NULL,
  last_seen_headline_id UUID REFERENCES game_session_headlines(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_world_state_connections_not_self CHECK (source_node_id <> target_node_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_world_state_connections_unique_pair
  ON world_state_connections(session_id, source_node_id, target_node_id);

CREATE INDEX IF NOT EXISTS idx_world_state_connections_source_strength
  ON world_state_connections(session_id, source_node_id, strength DESC, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_world_state_connections_target_strength
  ON world_state_connections(session_id, target_node_id, strength DESC, updated_at DESC);

DROP TRIGGER IF EXISTS update_world_state_connections_updated_at ON world_state_connections;
CREATE TRIGGER update_world_state_connections_updated_at
  BEFORE UPDATE ON world_state_connections
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

INSERT INTO world_state_connections (session_id, source_node_id, target_node_id, strength, rationale)
SELECT source.session_id, source.id, target.id, 0, ''
FROM world_state_nodes source
JOIN world_state_nodes target
  ON target.session_id = source.session_id
 AND target.id <> source.id
ON CONFLICT (session_id, source_node_id, target_node_id) DO NOTHING;

INSERT INTO world_state_connections (
  session_id,
  source_node_id,
  target_node_id,
  strength,
  rationale,
  times_updated,
  first_seen_headline_id,
  last_seen_headline_id,
  created_at,
  updated_at
)
WITH legacy_edges AS (
  SELECT
    session_id,
    source_node_id,
    target_node_id,
    MAX(LEAST(1, GREATEST(0, weight / 5.0))) AS strength,
    STRING_AGG(NULLIF(summary, ''), ' | ' ORDER BY updated_at DESC) AS rationale,
    MAX(times_updated) AS times_updated,
    MIN(first_seen_headline_id::text)::uuid AS first_seen_headline_id,
    (ARRAY_AGG(last_seen_headline_id ORDER BY updated_at DESC NULLS LAST))[1] AS last_seen_headline_id,
    MIN(created_at) AS created_at,
    MAX(updated_at) AS updated_at
  FROM world_state_edges
  WHERE source_node_id <> target_node_id
  GROUP BY session_id, source_node_id, target_node_id
)
SELECT
  session_id,
  source_node_id,
  target_node_id,
  strength,
  COALESCE(LEFT(rationale, 4000), ''),
  times_updated,
  first_seen_headline_id,
  last_seen_headline_id,
  created_at,
  updated_at
FROM legacy_edges
ON CONFLICT (session_id, source_node_id, target_node_id) DO UPDATE
SET strength = GREATEST(world_state_connections.strength, EXCLUDED.strength),
    rationale = CASE
      WHEN EXCLUDED.rationale = '' THEN world_state_connections.rationale
      ELSE EXCLUDED.rationale
    END,
    times_updated = GREATEST(world_state_connections.times_updated, EXCLUDED.times_updated),
    first_seen_headline_id = COALESCE(world_state_connections.first_seen_headline_id, EXCLUDED.first_seen_headline_id),
    last_seen_headline_id = COALESCE(EXCLUDED.last_seen_headline_id, world_state_connections.last_seen_headline_id),
    updated_at = CURRENT_TIMESTAMP;

ALTER TABLE game_sessions
  ALTER COLUMN world_state_config SET DEFAULT '{
    "enabled": true,
    "allowCycles": true,
    "maxPropagationDepth": 2,
    "maxNodeReactions": 20,
    "maxEventsPerNode": 2,
    "nodeAgentConcurrency": 4,
    "storeUnaffectedDecisions": true,
    "retrievalStrategy": "hybrid",
    "maxContextNodes": 16,
    "maxNeighborsPerNode": 8,
    "maxCandidateNeighbors": 12,
    "connectionDisplayThreshold": 0.15,
    "propagationRandomMode": "seeded"
  }'::jsonb;

UPDATE game_sessions
SET world_state_config =
  COALESCE(world_state_config, '{}'::jsonb)
  || jsonb_build_object(
    'enabled', COALESCE(world_state_config->'enabled', 'true'::jsonb),
    'allowCycles', COALESCE(world_state_config->'allowCycles', 'true'::jsonb),
    'maxPropagationDepth', COALESCE(world_state_config->'maxPropagationDepth', '2'::jsonb),
    'maxNodeReactions', COALESCE(world_state_config->'maxNodeReactions', '20'::jsonb),
    'maxEventsPerNode', COALESCE(world_state_config->'maxEventsPerNode', '2'::jsonb),
    'nodeAgentConcurrency', COALESCE(world_state_config->'nodeAgentConcurrency', '4'::jsonb),
    'storeUnaffectedDecisions', COALESCE(world_state_config->'storeUnaffectedDecisions', 'true'::jsonb),
    'retrievalStrategy', COALESCE(world_state_config->'retrievalStrategy', '"hybrid"'::jsonb),
    'maxContextNodes', COALESCE(world_state_config->'maxContextNodes', '16'::jsonb),
    'maxNeighborsPerNode', COALESCE(world_state_config->'maxNeighborsPerNode', '8'::jsonb),
    'maxCandidateNeighbors', COALESCE(world_state_config->'maxCandidateNeighbors', '12'::jsonb),
    'connectionDisplayThreshold', COALESCE(world_state_config->'connectionDisplayThreshold', '0.15'::jsonb),
    'propagationRandomMode', COALESCE(world_state_config->'propagationRandomMode', '"seeded"'::jsonb)
  );
