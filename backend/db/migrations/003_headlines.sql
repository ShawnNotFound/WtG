-- Create game_session_headlines table for storing player headline submissions
CREATE TABLE game_session_headlines (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
    player_id UUID NOT NULL REFERENCES session_players(id) ON DELETE CASCADE,
    round_no INT NOT NULL,
    headline_text TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    
    -- Future fields for LLM integration
    llm_status VARCHAR(20) DEFAULT NULL,  -- e.g., 'pending', 'evaluated', 'error'
    llm_score DOUBLE PRECISION DEFAULT NULL
);

-- Index for efficient queries by session and round, ordered by time
CREATE INDEX idx_headlines_session_round_time 
    ON game_session_headlines(session_id, round_no, created_at);

-- Index for querying headlines by player
CREATE INDEX idx_headlines_player 
    ON game_session_headlines(player_id);

-- Add comments for documentation
COMMENT ON TABLE game_session_headlines IS 'Stores all headline submissions from players during game rounds';
COMMENT ON COLUMN game_session_headlines.round_no IS 'The round number when this headline was submitted';
COMMENT ON COLUMN game_session_headlines.llm_status IS 'Status of LLM evaluation: pending, evaluated, or error';
COMMENT ON COLUMN game_session_headlines.llm_score IS 'Score assigned by the LLM juror (0.0 to 1.0 or similar scale)';


