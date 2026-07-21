/**
 * types for round summary generation.
 * defines the structure for ai-generated narrative summaries displayed during break phase.
 */

/**
 * a highlighted headline from the round with context about its significance.
 */
export interface HighlightedHeadline {
  headline: string;
  source: string;
  significance: string;
}

/**
 * round statistics for context.
 */
export interface RoundStats {
  headlineCount: number;
  playerCount: number;
}

/**
 * full summary output structure from the llm.
 */
export interface RoundSummaryOutput {
  /** 2-3 paragraph engaging narrative recap */
  narrative: string;
  /** top 3 themes from the round (max) */
  themes: string[];
  /** top 2 standout headlines with context */
  highlightedHeadlines: HighlightedHeadline[];
  /** top 3 planets this round */
  dominantPlanets: string[];
  /** round statistics */
  roundStats: RoundStats;
}

/**
 * a single headline with metadata for the summary prompt.
 */
export interface RoundHeadlineInput {
  headline: string;
  player: string;
  plausibilityLevel: number;
  plausibilityLabel: string;
  planets: string[];
  storyDirection: string;
}

/**
 * full input for building the summary prompt.
 * can cover a single round (fromRound === toRound) or a range.
 */
export interface SummaryPromptInput {
  fromRound: number;
  toRound: number;
  totalRounds: number;
  headlines: RoundHeadlineInput[];
}

/**
 * parameters for generating a round summary.
 * can cover a single round (fromRound === toRound) or a range (e.g. rounds 1-2).
 */
export interface GenerateSummaryParams {
  sessionId: string;
  fromRound: number;
  toRound: number;
  maxRounds: number;
}

/**
 * result from summary generation.
 */
export interface SummaryResult {
  summary: RoundSummaryOutput;
  model: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

/**
 * status of a round summary in the database.
 */
export type SummaryStatus = 'pending' | 'generating' | 'completed' | 'error';

/**
 * a single first-person experience report from a fictional character.
 */
export interface NarrativeReport {
  character: {
    name: string;
    role: string;
    era: string;
  };
  story: string;
  themes_touched: string[];
}

/**
 * full output of the narrative final summary — multiple reports
 * illustrating different facets of the timeline.
 */
export interface NarrativeSummaryOutput {
  reports: NarrativeReport[];
}

/**
 * input for the narrative prompt builder.
 */
export interface NarrativePromptInput {
  headlines: Array<{ date: string; headline: string }>;
}

/**
 * parameters for generating a final narrative summary.
 */
export interface GenerateNarrativeParams {
  sessionId: string;
  maxRounds: number;
}

/**
 * result from narrative summary generation.
 */
export interface NarrativeResult {
  summary: NarrativeSummaryOutput;
  model: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

/**
 * database row for round_summaries table.
 */
export interface RoundSummaryRow {
  id: string;
  session_id: string;
  round_no: number;
  summary_data: RoundSummaryOutput;
  status: SummaryStatus;
  error_message: string | null;
  llm_model: string | null;
  llm_input_tokens: number | null;
  llm_output_tokens: number | null;
  created_at: Date;
  completed_at: Date | null;
}
