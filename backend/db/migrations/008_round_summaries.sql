-- Migration: Create round_summaries table for AI-generated round recaps
-- This stores narrative summaries generated after each round ends

CREATE TABLE round_summaries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
    round_no INT NOT NULL,
    summary_data JSONB NOT NULL DEFAULT '{}',
    status VARCHAR(20) NOT NULL DEFAULT 'pending',  -- pending|generating|completed|error
    error_message TEXT,
    llm_model VARCHAR(64),
    llm_input_tokens INT,
    llm_output_tokens INT,
    llm_request JSONB,
    llm_response TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMPTZ,
    CONSTRAINT unique_session_round_summary UNIQUE (session_id, round_no),
    CONSTRAINT valid_status CHECK (status IN ('pending', 'generating', 'completed', 'error'))
);

-- Index for efficient lookups by session and round
CREATE INDEX idx_round_summaries_session_round ON round_summaries(session_id, round_no);

-- Comment for documentation
COMMENT ON TABLE round_summaries IS 'Stores AI-generated narrative summaries for each round, displayed during BREAK phase';
COMMENT ON COLUMN round_summaries.status IS 'Generation status: pending (not started), generating (in progress), completed (success), error (failed)';
COMMENT ON COLUMN round_summaries.summary_data IS 'JSON containing narrative, themes, highlightedHeadlines, dominantPlanets, and roundStats';
