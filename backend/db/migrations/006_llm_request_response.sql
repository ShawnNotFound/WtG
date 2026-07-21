-- Migration: Add LLM request/response logging columns
-- Stores raw request and response JSON for debugging and analysis

ALTER TABLE game_session_headlines
  ADD COLUMN llm_request JSONB,
  ADD COLUMN llm_response JSONB;

COMMENT ON COLUMN game_session_headlines.llm_request IS 'Raw request sent to LLM (story direction, context headlines, planets)';
COMMENT ON COLUMN game_session_headlines.llm_response IS 'Raw response from LLM (full evaluation output)';
