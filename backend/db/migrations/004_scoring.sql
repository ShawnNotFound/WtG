-- Add scoring-related columns to session_players
ALTER TABLE session_players
    ADD COLUMN total_score INT NOT NULL DEFAULT 0,
    ADD COLUMN planet_usage_state JSONB NOT NULL DEFAULT '{}';

-- Index for leaderboard queries (session players ordered by score)
CREATE INDEX idx_session_players_leaderboard 
    ON session_players(session_id, total_score DESC);

-- Add scoring breakdown columns to game_session_headlines
ALTER TABLE game_session_headlines
    ADD COLUMN baseline_score INT,
    ADD COLUMN plausibility_level INT,
    ADD COLUMN plausibility_score INT,
    ADD COLUMN self_story_connection_level VARCHAR(8),
    ADD COLUMN self_story_score INT,
    ADD COLUMN others_story_connection_level VARCHAR(8),
    ADD COLUMN others_story_score INT,
    ADD COLUMN planet_1 VARCHAR(32),
    ADD COLUMN planet_2 VARCHAR(32),
    ADD COLUMN planet_3 VARCHAR(32),
    ADD COLUMN planet_bonus_score INT,
    ADD COLUMN total_headline_score INT;

-- Add comments for documentation
COMMENT ON COLUMN session_players.total_score IS 'Running total score for this player in this session';
COMMENT ON COLUMN session_players.planet_usage_state IS 'JSON object tracking per-planet LRU state: { "PLANET_ID": { "lastUsedRound": N }, ... }';

COMMENT ON COLUMN game_session_headlines.baseline_score IS 'Base points awarded for submitting a headline (B)';
COMMENT ON COLUMN game_session_headlines.plausibility_level IS 'AI-assessed plausibility level (1-5)';
COMMENT ON COLUMN game_session_headlines.plausibility_score IS 'Points from plausibility assessment (A1/A2)';
COMMENT ON COLUMN game_session_headlines.self_story_connection_level IS 'Degree of story connection to player own headlines: LOW, MEDIUM, HIGH';
COMMENT ON COLUMN game_session_headlines.self_story_score IS 'Points from self story connection (X_L/X_M/X_H)';
COMMENT ON COLUMN game_session_headlines.others_story_connection_level IS 'Degree of story connection to other players headlines: LOW, MEDIUM, HIGH';
COMMENT ON COLUMN game_session_headlines.others_story_score IS 'Points from others story connection (Y_L/Y_M/Y_H)';
COMMENT ON COLUMN game_session_headlines.planet_1 IS 'AI top-1 planet classification for this headline';
COMMENT ON COLUMN game_session_headlines.planet_2 IS 'AI top-2 planet classification for this headline';
COMMENT ON COLUMN game_session_headlines.planet_3 IS 'AI top-3 planet classification for this headline';
COMMENT ON COLUMN game_session_headlines.planet_bonus_score IS 'Points from planet bonus (P1/P2/P3)';
COMMENT ON COLUMN game_session_headlines.total_headline_score IS 'Total points for this headline (sum of all components)';


