-- Add summary_type column to round_summaries to distinguish historical recaps
-- (used during BREAK phases) from narrative final summaries (used at game end).
ALTER TABLE round_summaries
  ADD COLUMN IF NOT EXISTS summary_type VARCHAR(20) NOT NULL DEFAULT 'historical';
