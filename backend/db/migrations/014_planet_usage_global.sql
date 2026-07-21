-- Global per-session planet usage counter for the band-based planet scoring system.
-- Replaces the per-player "priority planet" system: planets are ranked by global usage
-- (least-used at top) and split into three bands awarding +2 / +1 / +0.
ALTER TABLE game_sessions
    ADD COLUMN IF NOT EXISTS planet_usage_global JSONB NOT NULL DEFAULT '{}';

COMMENT ON COLUMN game_sessions.planet_usage_global IS
    'Global per-session planet usage counts: { "EARTH": N, "MARS": N, ... }. Drives band-based planet scoring.';

-- The per-player planet_usage_state column is repurposed: it now stores each player's
-- stable random tie-break permutation, generated once at game start, used to order the
-- usage-ranked planet list (so players do not all rush the same planet).
COMMENT ON COLUMN session_players.planet_usage_state IS
    'Per-player random tie-break permutation for the planet usage panel: { "ordinals": { "EARTH": 0..8, ... } }';
