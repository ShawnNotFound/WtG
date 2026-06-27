ALTER TABLE game_sessions
  ADD COLUMN IF NOT EXISTS summary_config JSONB NOT NULL DEFAULT '{"roundSummaries": true, "finalNarrative": true}';

COMMENT ON COLUMN game_sessions.summary_config IS
  'Controls optional generated summaries for this session. Evaluation runs disable these by default to reduce extra LLM calls.';

CREATE TABLE IF NOT EXISTS evaluation_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'error')),
  run_count INTEGER NOT NULL CHECK (run_count > 0),
  concurrency INTEGER NOT NULL CHECK (concurrency > 0),
  config JSONB NOT NULL DEFAULT '{}',
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMPTZ
);

DROP TRIGGER IF EXISTS update_evaluation_batches_updated_at ON evaluation_batches;
CREATE TRIGGER update_evaluation_batches_updated_at
  BEFORE UPDATE ON evaluation_batches
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS evaluation_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id UUID NOT NULL REFERENCES evaluation_batches(id) ON DELETE CASCADE,
  run_index INTEGER NOT NULL CHECK (run_index > 0),
  session_id UUID REFERENCES game_sessions(id) ON DELETE SET NULL,
  join_code VARCHAR(8),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'starting', 'running', 'ready_for_judge', 'judged', 'error')),
  judge_result JSONB,
  overall_score DOUBLE PRECISION CHECK (overall_score IS NULL OR (overall_score >= 0 AND overall_score <= 100)),
  dimension_scores JSONB,
  confidence TEXT CHECK (confidence IS NULL OR confidence IN ('low', 'medium', 'high')),
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TIMESTAMPTZ,
  ready_at TIMESTAMPTZ,
  judged_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_evaluation_runs_batch_index
  ON evaluation_runs(batch_id, run_index);

CREATE INDEX IF NOT EXISTS idx_evaluation_runs_batch_status
  ON evaluation_runs(batch_id, status, run_index);

CREATE INDEX IF NOT EXISTS idx_evaluation_runs_session
  ON evaluation_runs(session_id);

DROP TRIGGER IF EXISTS update_evaluation_runs_updated_at ON evaluation_runs;
CREATE TRIGGER update_evaluation_runs_updated_at
  BEFORE UPDATE ON evaluation_runs
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

