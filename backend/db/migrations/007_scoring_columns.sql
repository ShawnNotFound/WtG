-- Migration: Add scoring columns to session_players and game_session_headlines
-- Enables full scoring system integration

-- Player scoring columns
ALTER TABLE session_players
  ADD COLUMN IF NOT EXISTS total_score INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS planet_usage_state JSONB DEFAULT NULL;

COMMENT ON COLUMN session_players.total_score IS 'Cumulative score for this player';
COMMENT ON COLUMN session_players.planet_usage_state IS 'JSON tracking which planets were used in which rounds';

-- Headline scoring breakdown columns
ALTER TABLE game_session_headlines
  ADD COLUMN IF NOT EXISTS baseline_score INTEGER,
  ADD COLUMN IF NOT EXISTS plausibility_score INTEGER,
  ADD COLUMN IF NOT EXISTS self_story_connection_level VARCHAR(10),
  ADD COLUMN IF NOT EXISTS self_story_score INTEGER,
  ADD COLUMN IF NOT EXISTS others_story_connection_level VARCHAR(10),
  ADD COLUMN IF NOT EXISTS others_story_score INTEGER,
  ADD COLUMN IF NOT EXISTS planet_bonus_score INTEGER,
  ADD COLUMN IF NOT EXISTS total_headline_score INTEGER;

COMMENT ON COLUMN game_session_headlines.baseline_score IS 'Base points for submitting (default 10)';
COMMENT ON COLUMN game_session_headlines.plausibility_score IS 'Points from dice roll band (0/10/20)';
COMMENT ON COLUMN game_session_headlines.self_story_connection_level IS 'Connection to own headlines: LOW/MEDIUM/HIGH';
COMMENT ON COLUMN game_session_headlines.self_story_score IS 'Points from self-story connection';
COMMENT ON COLUMN game_session_headlines.others_story_connection_level IS 'Connection to others headlines: LOW/MEDIUM/HIGH';
COMMENT ON COLUMN game_session_headlines.others_story_score IS 'Points from others-story connection';
COMMENT ON COLUMN game_session_headlines.planet_bonus_score IS 'Bonus points from planet weighting system';
COMMENT ON COLUMN game_session_headlines.total_headline_score IS 'Sum of all scoring components';
