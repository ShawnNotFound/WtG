/**
 * summary service for generating ai-powered round recaps.
 * generates narrative summaries displayed during break phase.
 */

import pool from '../db/pool.js';
import {
  OpenAIError,
  ResponsesApiRequest,
  ResponsesApiResult,
} from '../llm/openaiResponsesClient.js';
import {
  createJsonModelClient,
  getJsonProviderConfig,
  JsonModelClient,
} from '../llm/jsonModelClient.js';
import { getSessionLlmSelection } from '../llm/sessionLlmConfig.js';
import {
  buildSummaryPrompt,
  buildSummaryInstructions,
  summaryJsonSchema,
} from '../llm/summaryPrompt.js';
import {
  buildNarrativePrompt,
  buildNarrativeInstructions,
  narrativeJsonSchema,
} from '../llm/narrativePrompt.js';
import {
  GenerateSummaryParams,
  GenerateNarrativeParams,
  SummaryResult,
  NarrativeResult,
  RoundSummaryOutput,
  NarrativeSummaryOutput,
  RoundHeadlineInput,
  SummaryStatus,
} from '../llm/summaryTypes.js';

const PLAUSIBILITY_LABELS: Record<number, string> = {
  1: 'inevitable',
  2: 'probable',
  3: 'plausible',
  4: 'possible',
  5: 'preposterous',
};

/** singleton client instance */
let clientInstance: JsonModelClient | null = null;

/**
 * get or create the LLM client.
 * uses environment variables for configuration.
 */
async function getClient(sessionId?: string): Promise<JsonModelClient> {
  if (clientInstance) {
    return clientInstance;
  }

  const selection = sessionId ? await getSessionLlmSelection(sessionId, 'summary') : undefined;
  const config = getJsonProviderConfig('SUMMARY', selection);
  if (!config.apiKey) {
    throw new OpenAIError(
      `${config.provider === 'deepseek' ? 'DEEPSEEK_API_KEY' : 'OPENAI_API_KEY'} environment variable is not set`,
      'MISSING_API_KEY'
    );
  }

  if (!sessionId) {
    clientInstance = createJsonModelClient(config);
    return clientInstance;
  }

  return createJsonModelClient(config);
}

/**
 * reset the client instance (for testing).
 */
export function resetSummaryClient(): void {
  clientInstance = null;
}

/**
 * set a custom client instance (for testing).
 */
export function setSummaryClient(client: JsonModelClient): void {
  clientInstance = client;
}

async function callSummaryJson<T>(
  client: JsonModelClient,
  request: ResponsesApiRequest
): Promise<ResponsesApiResult<T>> {
  try {
    return await client.callResponsesApi<T>(request);
  } catch (error) {
    if (!(error instanceof OpenAIError) || error.code !== 'INVALID_JSON_OUTPUT' || !request.jsonSchema) {
      throw error;
    }

    return client.callResponsesApi<T>({
      ...request,
      instructions: `${request.instructions ?? ''}

CRITICAL JSON RECOVERY: Your previous response was not valid JSON. Return one complete JSON object only. Escape all paragraph breaks inside string values as \\n\\n. Do not use markdown, comments, trailing commas, ellipses, or text outside the JSON object.`,
      input: `${request.input}

The previous model response for this task failed JSON parsing. Regenerate the same requested summary as a complete, valid JSON object matching the schema.`,
      temperature: 0,
    });
  }
}

/**
 * fetch all headlines for a range of rounds (inclusive).
 */
async function fetchHeadlinesInRange(
  sessionId: string,
  fromRound: number,
  toRound: number
): Promise<RoundHeadlineInput[]> {
  const result = await pool.query(
    `SELECT
      h.id,
      COALESCE(h.selected_headline, h.headline_text) as headline,
      h.headline_text as story_direction,
      h.plausibility_level,
      h.planet_1,
      h.planet_2,
      h.planet_3,
      p.nickname as player
    FROM game_session_headlines h
    JOIN session_players p ON h.player_id = p.id
    WHERE h.session_id = $1 AND h.round_no BETWEEN $2 AND $3
      AND p.is_system = FALSE
    ORDER BY h.created_at ASC`,
    [sessionId, fromRound, toRound]
  );

  return result.rows.map((row) => ({
    headline: row.headline || row.story_direction,
    player: row.player,
    plausibilityLevel: row.plausibility_level || 3,
    plausibilityLabel: PLAUSIBILITY_LABELS[row.plausibility_level] || 'plausible',
    planets: [row.planet_1, row.planet_2, row.planet_3].filter(Boolean),
    storyDirection: row.story_direction,
  }));
}

/**
 * create or update a summary record with 'generating' status.
 */
async function markSummaryGenerating(
  sessionId: string,
  roundNo: number,
  summaryType: 'historical' | 'narrative' = 'historical'
): Promise<string> {
  const result = await pool.query(
    `INSERT INTO round_summaries (session_id, round_no, status, summary_data, summary_type)
     VALUES ($1, $2, 'generating', '{}', $3)
     ON CONFLICT (session_id, round_no)
     DO UPDATE SET status = 'generating', error_message = NULL, summary_type = $3
     RETURNING id`,
    [sessionId, roundNo, summaryType]
  );
  return result.rows[0].id;
}

/**
 * update a summary record with completed data.
 */
async function markSummaryCompleted(
  summaryId: string,
  summaryData: RoundSummaryOutput | NarrativeSummaryOutput,
  model: string,
  inputTokens: number | undefined,
  outputTokens: number | undefined,
  llmRequest: Record<string, unknown>,
  llmResponse: string
): Promise<void> {
  await pool.query(
    `UPDATE round_summaries
     SET status = 'completed',
         summary_data = $2,
         llm_model = $3,
         llm_input_tokens = $4,
         llm_output_tokens = $5,
         llm_request = $6,
         llm_response = $7,
         completed_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [
      summaryId,
      JSON.stringify(summaryData),
      model,
      inputTokens ?? null,
      outputTokens ?? null,
      JSON.stringify(llmRequest),
      llmResponse,
    ]
  );
}

/**
 * update a summary record with error status.
 */
async function markSummaryError(summaryId: string, errorMessage: string): Promise<void> {
  await pool.query(
    `UPDATE round_summaries
     SET status = 'error',
         error_message = $2,
         completed_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [summaryId, errorMessage]
  );
}

/**
 * generate a round summary using ai.
 *
 * @param params - session id, round number, and max rounds
 * @returns the generated summary with metadata
 * @throws {OpenAIError} if the api call fails
 */
export async function generateRoundSummary(
  params: GenerateSummaryParams
): Promise<SummaryResult> {
  const { sessionId, fromRound, toRound, maxRounds } = params;

  // store the summary keyed by toRound (the most recent round in the range)
  const summaryId = await markSummaryGenerating(sessionId, toRound);

  try {
    const headlines = await fetchHeadlinesInRange(sessionId, fromRound, toRound);

    const prompt = buildSummaryPrompt({
      fromRound,
      toRound,
      totalRounds: maxRounds,
      headlines,
    });
    const instructions = buildSummaryInstructions();

    const client = await getClient(sessionId);
    const result = await callSummaryJson<RoundSummaryOutput>(client, {
      input: prompt,
      instructions,
      jsonSchema: summaryJsonSchema,
    });

    await markSummaryCompleted(
      summaryId,
      result.output,
      result.model,
      result.usage?.inputTokens,
      result.usage?.outputTokens,
      { prompt, instructions },
      result.rawText
    );

    return {
      summary: result.output,
      model: result.model,
      usage: result.usage,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await markSummaryError(summaryId, errorMessage);
    throw error;
  }
}

/**
 * fetch all headlines from a session in chronological order, formatted
 * as `[YYYY-MM] headline` for the narrative prompt.
 */
async function fetchAllHeadlinesForNarrative(
  sessionId: string
): Promise<Array<{ date: string; headline: string }>> {
  const result = await pool.query(
    `SELECT
      to_char(h.in_game_submitted_at, 'YYYY-MM') as date,
      COALESCE(h.selected_headline, h.headline_text) as headline
    FROM game_session_headlines h
    JOIN session_players p ON h.player_id = p.id
    WHERE h.session_id = $1 AND h.in_game_submitted_at IS NOT NULL
      AND p.is_system = FALSE
    ORDER BY h.in_game_submitted_at ASC`,
    [sessionId]
  );
  return result.rows.map((row) => ({
    date: row.date,
    headline: row.headline,
  }));
}

/**
 * generate the final game-end narrative summary.
 *
 * unlike the historical recap used during break, this generates a set
 * of fictional first-person experience reports from different characters
 * living through the timeline.
 *
 * stored in `round_summaries` with `summary_type = 'narrative'`, keyed
 * by `round_no = maxRounds`.
 */
export async function generateFinalNarrativeSummary(
  params: GenerateNarrativeParams
): Promise<NarrativeResult> {
  const { sessionId, maxRounds } = params;

  // store keyed by maxRounds with summary_type = 'narrative'
  const summaryId = await markSummaryGenerating(sessionId, maxRounds, 'narrative');

  try {
    const headlines = await fetchAllHeadlinesForNarrative(sessionId);

    const prompt = buildNarrativePrompt({ headlines });
    const instructions = buildNarrativeInstructions();

    const client = await getClient(sessionId);
    const result = await callSummaryJson<NarrativeSummaryOutput>(client, {
      input: prompt,
      instructions,
      jsonSchema: narrativeJsonSchema,
    });

    await markSummaryCompleted(
      summaryId,
      result.output,
      result.model,
      result.usage?.inputTokens,
      result.usage?.outputTokens,
      { prompt, instructions },
      result.rawText
    );

    return {
      summary: result.output,
      model: result.model,
      usage: result.usage,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await markSummaryError(summaryId, errorMessage);
    throw error;
  }
}

/**
 * get an existing round summary from the database.
 *
 * @param sessionId - the session id
 * @param roundNo - the round number
 * @returns the summary data and status, or null if not found
 */
export async function getRoundSummary(
  sessionId: string,
  roundNo: number
): Promise<{
  status: SummaryStatus;
  summaryType: 'historical' | 'narrative';
  summary: RoundSummaryOutput | NarrativeSummaryOutput | null;
  error: string | null;
} | null> {
  const result = await pool.query(
    `SELECT status, summary_data, summary_type, error_message
     FROM round_summaries
     WHERE session_id = $1 AND round_no = $2`,
    [sessionId, roundNo]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0];
  return {
    status: row.status as SummaryStatus,
    summaryType: (row.summary_type as 'historical' | 'narrative') ?? 'historical',
    summary: row.status === 'completed' ? row.summary_data : null,
    error: row.error_message,
  };
}

/**
 * get session id from join code.
 *
 * @param joinCode - the session join code
 * @returns the session id or null if not found
 */
export async function getSessionIdFromJoinCode(joinCode: string): Promise<string | null> {
  const result = await pool.query(
    `SELECT id FROM game_sessions WHERE join_code = $1 AND archived_at IS NULL`,
    [joinCode]
  );

  return result.rows.length > 0 ? result.rows[0].id : null;
}
