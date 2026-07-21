-- Add headline transformation columns to game_session_headlines
-- Stores dice roll results, all 5 headline variants, and linked headlines

ALTER TABLE game_session_headlines
    -- Dice roll and selection
    ADD COLUMN dice_roll INT CHECK (dice_roll >= 0 AND dice_roll <= 100),
    ADD COLUMN selected_band INT CHECK (selected_band >= 1 AND selected_band <= 5),
    ADD COLUMN selected_headline TEXT,

    -- All 5 headline variants (for research and display)
    ADD COLUMN band1_headline TEXT,  -- inevitable
    ADD COLUMN band2_headline TEXT,  -- probable
    ADD COLUMN band3_headline TEXT,  -- plausible
    ADD COLUMN band4_headline TEXT,  -- possible
    ADD COLUMN band5_headline TEXT,  -- preposterous

    -- Plausibility assessment from LLM (plausibility_level already added in 004_scoring.sql)
    ADD COLUMN plausibility_rationale TEXT,

    -- Linked headlines (stored as JSONB for flexibility)
    -- Format: [{"headline": "...", "strength": "STRONG"|"WEAK", "rationale": "..."}]
    ADD COLUMN linked_headlines JSONB DEFAULT '[]',

    -- Planet rationales (stored as JSONB)
    -- Format: [{"id": "MARS", "rank": 1, "rationale": "..."}]
    ADD COLUMN planet_rationales JSONB DEFAULT '[]',

    -- LLM metadata
    ADD COLUMN llm_model VARCHAR(64),
    ADD COLUMN llm_input_tokens INT,
    ADD COLUMN llm_output_tokens INT;

-- Add comments for documentation
COMMENT ON COLUMN game_session_headlines.dice_roll IS 'Raw dice roll value (0-100)';
COMMENT ON COLUMN game_session_headlines.selected_band IS 'Band selected by dice roll (1-5): 1=inevitable, 2=probable, 3=plausible, 4=possible, 5=preposterous';
COMMENT ON COLUMN game_session_headlines.selected_headline IS 'Final headline text after dice roll selection';
COMMENT ON COLUMN game_session_headlines.band1_headline IS 'Headline variant for band 1 (inevitable)';
COMMENT ON COLUMN game_session_headlines.band2_headline IS 'Headline variant for band 2 (probable)';
COMMENT ON COLUMN game_session_headlines.band3_headline IS 'Headline variant for band 3 (plausible)';
COMMENT ON COLUMN game_session_headlines.band4_headline IS 'Headline variant for band 4 (possible)';
COMMENT ON COLUMN game_session_headlines.band5_headline IS 'Headline variant for band 5 (preposterous)';
COMMENT ON COLUMN game_session_headlines.plausibility_level IS 'LLM plausibility band assessment (1-5)';
COMMENT ON COLUMN game_session_headlines.plausibility_rationale IS 'LLM rationale for plausibility classification';
COMMENT ON COLUMN game_session_headlines.planet_1 IS 'Top ranked planet classification';
COMMENT ON COLUMN game_session_headlines.planet_2 IS 'Second ranked planet classification';
COMMENT ON COLUMN game_session_headlines.planet_3 IS 'Third ranked planet classification';
COMMENT ON COLUMN game_session_headlines.linked_headlines IS 'JSON array of top 3 linked headlines with strength and rationale';
COMMENT ON COLUMN game_session_headlines.planet_rationales IS 'JSON array of top 3 planet alignments with rationale';
COMMENT ON COLUMN game_session_headlines.llm_model IS 'OpenAI model used for evaluation';
COMMENT ON COLUMN game_session_headlines.llm_input_tokens IS 'Input tokens used by LLM call';
COMMENT ON COLUMN game_session_headlines.llm_output_tokens IS 'Output tokens used by LLM call';
