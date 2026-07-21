-- Future-Wikipedia world model: materialized pages, immutable revisions,
-- consultation pressure, and a bounded queue of proposed page creations.

ALTER TABLE world_state_nodes
  ADD COLUMN IF NOT EXISTS aliases JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS revision_no INTEGER NOT NULL DEFAULT 1 CHECK (revision_no >= 1),
  ADD COLUMN IF NOT EXISTS last_content_update_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN IF NOT EXISTS last_consulted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS consultations_since_update INTEGER NOT NULL DEFAULT 0
    CHECK (consultations_since_update >= 0),
  ADD COLUMN IF NOT EXISTS change_velocity DOUBLE PRECISION NOT NULL DEFAULT 0
    CHECK (change_velocity >= 0 AND change_velocity <= 1),
  ADD COLUMN IF NOT EXISTS last_change_magnitude DOUBLE PRECISION NOT NULL DEFAULT 0
    CHECK (last_change_magnitude >= 0 AND last_change_magnitude <= 1),
  ADD COLUMN IF NOT EXISTS update_priority DOUBLE PRECISION NOT NULL DEFAULT 0
    CHECK (update_priority >= 0 AND update_priority <= 100);

UPDATE world_state_nodes
SET last_content_update_at = updated_at;

CREATE TABLE IF NOT EXISTS world_state_node_aliases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
  node_id UUID NOT NULL REFERENCES world_state_nodes(id) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  normalized_alias TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_world_state_node_alias_nonempty CHECK (length(trim(normalized_alias)) > 0),
  UNIQUE (session_id, normalized_alias)
);

CREATE INDEX IF NOT EXISTS idx_world_state_node_aliases_node
  ON world_state_node_aliases(node_id);

INSERT INTO world_state_node_aliases (session_id, node_id, alias, normalized_alias)
SELECT session_id, id, name, trim(lower(regexp_replace(trim(name), '[^[:alnum:]]+', ' ', 'g')))
FROM world_state_nodes
ON CONFLICT (session_id, normalized_alias) DO NOTHING;

CREATE TABLE IF NOT EXISTS world_state_page_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
  node_id UUID NOT NULL REFERENCES world_state_nodes(id) ON DELETE CASCADE,
  revision_no INTEGER NOT NULL CHECK (revision_no >= 1),
  operation TEXT NOT NULL CHECK (operation IN ('CREATE', 'UPDATE', 'ANSWER', 'INCORPORATE')),
  source_kind TEXT NOT NULL DEFAULT 'system'
    CHECK (source_kind IN ('system', 'seed', 'headline', 'helper', 'admin')),
  source_headline_id UUID REFERENCES game_session_headlines(id) ON DELETE SET NULL,
  source_helper_message_id UUID REFERENCES world_helper_messages(id) ON DELETE SET NULL,
  effective_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  page_name TEXT NOT NULL DEFAULT '',
  page_type TEXT NOT NULL DEFAULT 'entity',
  page_attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  page_aliases JSONB NOT NULL DEFAULT '[]'::jsonb,
  before_summary TEXT NOT NULL DEFAULT '',
  after_summary TEXT NOT NULL DEFAULT '',
  summary_delta TEXT NOT NULL DEFAULT '',
  rationale TEXT NOT NULL DEFAULT '',
  evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
  confidence DOUBLE PRECISION NOT NULL DEFAULT 1 CHECK (confidence >= 0 AND confidence <= 1),
  change_magnitude DOUBLE PRECISION NOT NULL DEFAULT 0
    CHECK (change_magnitude >= 0 AND change_magnitude <= 1),
  model TEXT,
  usage JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (node_id, revision_no)
);

CREATE INDEX IF NOT EXISTS idx_world_state_page_revisions_session_date
  ON world_state_page_revisions(session_id, effective_at DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_world_state_page_revisions_node_date
  ON world_state_page_revisions(node_id, revision_no DESC);

-- Existing rows become revision 1 snapshots; their pre-migration history cannot
-- be reconstructed, so the rationale states that this is a baseline.
INSERT INTO world_state_page_revisions (
  session_id,
  node_id,
  revision_no,
  operation,
  source_kind,
  effective_at,
  page_name,
  page_type,
  page_attributes,
  page_aliases,
  after_summary,
  rationale,
  change_magnitude
)
SELECT
  session_id,
  id,
  1,
  'CREATE',
  'system',
  created_at,
  name,
  type,
  attributes,
  aliases,
  summary,
  'Baseline snapshot created when page revision history was introduced.',
  CASE WHEN summary = '' THEN 0 ELSE 1 END
FROM world_state_nodes
ON CONFLICT (node_id, revision_no) DO NOTHING;

CREATE TABLE IF NOT EXISTS world_state_page_consultations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
  node_id UUID NOT NULL REFERENCES world_state_nodes(id) ON DELETE CASCADE,
  helper_message_id UUID REFERENCES world_helper_messages(id) ON DELETE SET NULL,
  query TEXT NOT NULL,
  relevance DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (relevance >= 0 AND relevance <= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (helper_message_id, node_id)
);

CREATE INDEX IF NOT EXISTS idx_world_state_page_consultations_node
  ON world_state_page_consultations(session_id, node_id, created_at DESC);

CREATE TABLE IF NOT EXISTS world_state_creation_candidates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
  normalized_name TEXT NOT NULL,
  proposed_name TEXT NOT NULL,
  proposed_type TEXT NOT NULL DEFAULT 'entity',
  aliases JSONB NOT NULL DEFAULT '[]'::jsonb,
  proposed_summary TEXT NOT NULL DEFAULT '',
  attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  justification TEXT NOT NULL DEFAULT '',
  evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_query TEXT NOT NULL DEFAULT '',
  source_helper_message_id UUID REFERENCES world_helper_messages(id) ON DELETE SET NULL,
  mention_count INTEGER NOT NULL DEFAULT 1 CHECK (mention_count >= 1),
  confidence DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 1),
  novelty DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (novelty >= 0 AND novelty <= 1),
  connection_potential DOUBLE PRECISION NOT NULL DEFAULT 0
    CHECK (connection_potential >= 0 AND connection_potential <= 1),
  priority_score DOUBLE PRECISION NOT NULL DEFAULT 0
    CHECK (priority_score >= 0 AND priority_score <= 100),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'accepted', 'rejected', 'dropped')),
  accepted_node_id UUID REFERENCES world_state_nodes(id) ON DELETE SET NULL,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (session_id, normalized_name)
);

CREATE INDEX IF NOT EXISTS idx_world_state_creation_candidates_queue
  ON world_state_creation_candidates(session_id, status, priority_score DESC, updated_at ASC);

DROP TRIGGER IF EXISTS update_world_state_creation_candidates_updated_at
  ON world_state_creation_candidates;
CREATE TRIGGER update_world_state_creation_candidates_updated_at
  BEFORE UPDATE ON world_state_creation_candidates
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE world_helper_messages
  ADD COLUMN IF NOT EXISTS world_update JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE world_state_jobs
  ADD COLUMN IF NOT EXISTS source_helper_message_id UUID
    REFERENCES world_helper_messages(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS operation TEXT
    CHECK (operation IS NULL OR operation IN ('CREATE', 'UPDATE', 'ANSWER', 'INCORPORATE'));

ALTER TABLE world_state_jobs
  DROP CONSTRAINT IF EXISTS world_state_jobs_kind_check;
ALTER TABLE world_state_jobs
  ADD CONSTRAINT world_state_jobs_kind_check
  CHECK (kind IN ('initial', 'headline', 'manual', 'helper'));

CREATE INDEX IF NOT EXISTS idx_world_state_jobs_helper_message
  ON world_state_jobs(source_helper_message_id)
  WHERE source_helper_message_id IS NOT NULL;

COMMENT ON TABLE world_state_page_revisions IS
  'Immutable dated revisions for the future-Wikipedia representation of each world-state page.';
COMMENT ON TABLE world_state_creation_candidates IS
  'Bounded, prioritized proposals for concrete actor/entity pages that do not yet exist.';
COMMENT ON TABLE world_state_page_consultations IS
  'Records helper queries that consulted a page and therefore contribute to its update pressure.';
COMMENT ON COLUMN world_state_nodes.update_priority IS
  'Cached 0-100 priority derived from staleness, dependency shock, change velocity, and consultation pressure.';
