-- Create enum for session status
CREATE TYPE session_status AS ENUM ('WAITING', 'PLAYING', 'BREAK', 'FINISHED');

-- Create game_sessions table
CREATE TABLE game_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    join_code VARCHAR(8) NOT NULL UNIQUE,
    status session_status NOT NULL DEFAULT 'WAITING',
    host_player_id UUID,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create session_players table
CREATE TABLE session_players (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
    nickname VARCHAR(20) NOT NULL,
    is_host BOOLEAN NOT NULL DEFAULT false,
    joined_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(session_id, nickname)
);

-- Add foreign key for host_player_id after session_players table exists
ALTER TABLE game_sessions
    ADD CONSTRAINT fk_host_player
    FOREIGN KEY (host_player_id)
    REFERENCES session_players(id)
    ON DELETE SET NULL;

-- Create index for faster lookups
CREATE INDEX idx_session_join_code ON game_sessions(join_code);
CREATE INDEX idx_session_players_session_id ON session_players(session_id);

-- Create function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Create trigger for game_sessions
CREATE TRIGGER update_game_sessions_updated_at
    BEFORE UPDATE ON game_sessions
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

