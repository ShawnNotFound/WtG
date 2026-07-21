-- Add game timing and phase management columns to game_sessions
ALTER TABLE game_sessions
    ADD COLUMN play_minutes INT NOT NULL DEFAULT 15,
    ADD COLUMN break_minutes INT NOT NULL DEFAULT 5,
    ADD COLUMN max_rounds INT NOT NULL DEFAULT 4,
    ADD COLUMN current_round INT NOT NULL DEFAULT 0,
    ADD COLUMN phase VARCHAR(16) NOT NULL DEFAULT 'WAITING',
    ADD COLUMN phase_started_at TIMESTAMPTZ NULL,
    ADD COLUMN phase_ends_at TIMESTAMPTZ NULL,
    ADD COLUMN in_game_start_at TIMESTAMPTZ NULL,
    ADD COLUMN timeline_speed_ratio DOUBLE PRECISION NOT NULL DEFAULT 60.0;

-- Create game_session_state_transitions table to track phase changes
CREATE TABLE game_session_state_transitions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
    from_phase VARCHAR(16) NOT NULL,
    to_phase VARCHAR(16) NOT NULL,
    round_no INT NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Create index for efficient transition history queries
CREATE INDEX idx_state_transitions_session_time 
    ON game_session_state_transitions(session_id, occurred_at);

-- Add comment for documentation
COMMENT ON COLUMN game_sessions.phase IS 'Current game phase: WAITING, PLAYING, BREAK, or FINISHED';
COMMENT ON COLUMN game_sessions.timeline_speed_ratio IS 'How much faster in-game time moves vs real time (e.g., 60.0 = 60x speed)';
COMMENT ON TABLE game_session_state_transitions IS 'History of all phase transitions for audit and replay';

