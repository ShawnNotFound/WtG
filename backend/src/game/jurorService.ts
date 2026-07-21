/**
 * juror service for evaluating headlines via a JSON-capable LLM provider.
 * this module orchestrates the model call and validates the response.
 */

import {
  OpenAIError,
} from '../llm/openaiResponsesClient.js';
import {
  createJsonModelClient,
  getJsonProviderConfig,
  JsonModelClient,
} from '../llm/jsonModelClient.js';
import { getSessionLlmSelection } from '../llm/sessionLlmConfig.js';
import {
  buildJurorPrompt,
  buildJurorInstructions,
  jurorJsonSchema,
  JurorPromptInput,
  JurorEvaluationOutput,
  PlausibilityBand,
  BAND_LABELS,
} from '../prompts/jurorPrompt.js';

export interface JurorEvaluationRequest extends JurorPromptInput {
  // inherits storyDirection, headlinesList, planetList
  /** optional session id for per-game LLM provider/model selection */
  sessionId?: string;
}

export interface JurorEvaluationResult {
  /** the validated evaluation output */
  evaluation: JurorEvaluationOutput;
  /** model used for the evaluation */
  model: string;
  /** token usage */
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
  /** raw request sent to llm (for logging) */
  rawRequest: {
    storyDirection: string;
    headlinesList: unknown[];
    planetList: unknown[];
    sessionId?: string;
    instructions: string;
  };
  /** raw response text from llm (for logging) */
  rawResponse: string;
}

export class JurorValidationError extends Error {
  constructor(
    message: string,
    public code: string,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'JurorValidationError';
  }
}

/**
 * validate that the evaluation output meets all invariants.
 */
function validateEvaluationOutput(output: JurorEvaluationOutput): void {
  // validate LINKED has exactly 3 entries
  if (!Array.isArray(output.LINKED) || output.LINKED.length !== 3) {
    throw new JurorValidationError(
      `LINKED must have exactly 3 entries, got ${output.LINKED?.length ?? 0}`,
      'INVALID_LINKED_COUNT',
      { count: output.LINKED?.length }
    );
  }

  // validate PLANETS.top3 has exactly 3 entries
  if (!Array.isArray(output.PLANETS?.top3) || output.PLANETS.top3.length !== 3) {
    throw new JurorValidationError(
      `PLANETS.top3 must have exactly 3 entries, got ${output.PLANETS?.top3?.length ?? 0}`,
      'INVALID_PLANETS_COUNT',
      { count: output.PLANETS?.top3?.length }
    );
  }

  // validate PLAUSIBILITY band matches label
  const plausibilityBand = output.PLAUSIBILITY?.band as PlausibilityBand;
  const expectedLabel = BAND_LABELS[plausibilityBand];
  if (output.PLAUSIBILITY?.label !== expectedLabel) {
    throw new JurorValidationError(
      `PLAUSIBILITY.label does not match band (expected ${expectedLabel} for band ${plausibilityBand})`,
      'PLAUSIBILITY_LABEL_MISMATCH',
      {
        band: plausibilityBand,
        expectedLabel,
        actualLabel: output.PLAUSIBILITY?.label,
      }
    );
  }

  // validate planet ranks are 1, 2, 3
  const ranks = output.PLANETS.top3.map((p) => p.rank).sort();
  if (ranks[0] !== 1 || ranks[1] !== 2 || ranks[2] !== 3) {
    throw new JurorValidationError(
      'PLANETS.top3 must have ranks 1, 2, and 3',
      'INVALID_PLANET_RANKS',
      { ranks: output.PLANETS.top3.map((p) => p.rank) }
    );
  }

  // validate all bands have non-empty headlines
  const bands = output.HEADLINES.bands;
  for (let i = 1; i <= 5; i++) {
    const key = `band${i}` as keyof typeof bands;
    if (!bands[key] || typeof bands[key] !== 'string' || bands[key].trim() === '') {
      throw new JurorValidationError(
        `HEADLINES.bands.${key} must be a non-empty string`,
        'EMPTY_HEADLINE_BAND',
        { band: i }
      );
    }
  }
}

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

  const selection = sessionId ? await getSessionLlmSelection(sessionId, 'juror') : undefined;
  const config = getJsonProviderConfig('JUROR', selection);
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
export function resetJurorClient(): void {
  clientInstance = null;
}

/**
 * set a custom client instance (for testing).
 */
export function setJurorClient(client: JsonModelClient): void {
  clientInstance = client;
}

/**
 * evaluate a story direction using the openai juror.
 *
 * @param request - the evaluation request containing story direction, headlines, and planets
 * @returns the validated evaluation result
 * @throws {OpenAIError} if the api call fails
 * @throws {JurorValidationError} if the response fails invariant validation
 */
export async function evaluateJuror(
  request: JurorEvaluationRequest
): Promise<JurorEvaluationResult> {
  const client = await getClient(request.sessionId);

  const prompt = buildJurorPrompt(request);
  const instructions = buildJurorInstructions();

  const result = await client.callResponsesApi<JurorEvaluationOutput>({
    input: prompt,
    instructions,
    jsonSchema: jurorJsonSchema,
  });

  validateEvaluationOutput(result.output);

  return {
    evaluation: result.output,
    model: result.model,
    usage: result.usage,
    rawRequest: {
      storyDirection: request.storyDirection,
      headlinesList: request.headlinesList,
      planetList: request.planetList,
      sessionId: request.sessionId,
      instructions,
    },
    rawResponse: result.rawText,
  };
}

// re-export types for convenience
export type { JurorEvaluationOutput } from '../prompts/jurorPrompt.js';
