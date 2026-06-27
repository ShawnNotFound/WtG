/**
 * openai responses api client wrapper.
 * uses fetch (injectable for testing) to call the responses api with json schema enforcement.
 */

import { getDefaultFetch } from './proxyFetch.js';

/**
 * configuration for the openai client.
 */
export interface OpenAIClientConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  /** inject a custom fetch for testing */
  fetchFn?: typeof fetch;
}

/**
 * json schema object for response_format.
 */
export interface JsonSchemaDefinition {
  name: string;
  strict?: boolean;
  schema: Record<string, unknown>;
}

/**
 * request options for a responses api call.
 */
export interface ResponsesApiRequest {
  /** the input prompt/messages */
  input: string;
  /** json schema to enforce on the output */
  jsonSchema?: JsonSchemaDefinition;
  /** optional instructions (system message) */
  instructions?: string;
  /** optional sampling temperature */
  temperature?: number;
}

/**
 * parsed result from the responses api.
 */
export interface ResponsesApiResult<T> {
  /** the parsed json output */
  output: T;
  /** raw text before parsing (for debugging) */
  rawText: string;
  /** model used */
  model: string;
  /** usage stats */
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

export class OpenAIError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode?: number
  ) {
    super(message);
    this.name = 'OpenAIError';
  }
}

export const DEFAULT_OPENAI_MODEL = 'gpt-5.5';
const DEFAULT_BASE_URL = 'https://api.openai.com';

/**
 * create an openai responses api client.
 */
export function createOpenAIClient(config: OpenAIClientConfig) {
  const {
    apiKey,
    model = DEFAULT_OPENAI_MODEL,
    baseUrl = DEFAULT_BASE_URL,
    fetchFn,
  } = config;

  if (!apiKey) {
    throw new OpenAIError('OPENAI_API_KEY is required', 'MISSING_API_KEY');
  }

  const effectiveFetch = fetchFn ?? getDefaultFetch();

  /**
   * call the responses api and return parsed json.
   */
  async function callResponsesApi<T>(
    request: ResponsesApiRequest
  ): Promise<ResponsesApiResult<T>> {
    const url = `${baseUrl.replace(/\/+$/, '')}/v1/responses`;

    const body: Record<string, unknown> = {
      model,
      input: request.input,
    };

    if (request.instructions) {
      body.instructions = request.instructions;
    }

    if (request.temperature !== undefined) {
      body.temperature = request.temperature;
    }

    if (request.jsonSchema) {
      body.text = {
        format: {
          type: 'json_schema',
          name: request.jsonSchema.name,
          strict: request.jsonSchema.strict ?? true,
          schema: request.jsonSchema.schema,
        },
      };
    }

    let response: Response;
    try {
      response = await effectiveFetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new OpenAIError(
        `Network error calling OpenAI: ${err instanceof Error ? err.message : String(err)}`,
        'NETWORK_ERROR'
      );
    }

    if (!response.ok) {
      let errorMessage = `OpenAI API returned ${response.status}`;
      try {
        const errorBody = (await response.json()) as {
          error?: { message?: string };
        };
        if (errorBody?.error?.message) {
          errorMessage = errorBody.error.message;
        }
      } catch {
        // ignore json parse errors for error response
      }
      throw new OpenAIError(
        `${errorMessage} (model: ${model}, endpoint: ${url})`,
        'API_ERROR',
        response.status
      );
    }

    let responseData: any;
    try {
      responseData = await response.json();
    } catch (err) {
      throw new OpenAIError(
        'Failed to parse OpenAI response as JSON',
        'INVALID_RESPONSE'
      );
    }

    // extract the output text from the responses api structure.
    // the responses api returns: { output: [{ type: "message", content: [{ type: "output_text", text: "..." }] }] }
    let rawText: string;
    try {
      const outputItems = responseData.output;
      if (!Array.isArray(outputItems) || outputItems.length === 0) {
        throw new Error('No output items');
      }

      const messageOutput = outputItems.find(
        (item: any) => item.type === 'message'
      );
      if (!messageOutput) {
        throw new Error('No message output found');
      }

      const textContent = messageOutput.content?.find(
        (c: any) => c.type === 'output_text'
      );
      if (!textContent?.text) {
        throw new Error('No text content found');
      }

      rawText = textContent.text;
    } catch (err) {
      throw new OpenAIError(
        `Unexpected Responses API structure: ${err instanceof Error ? err.message : String(err)}`,
        'INVALID_RESPONSE_STRUCTURE'
      );
    }

    // parse the text as json
    let parsedOutput: T;
    try {
      parsedOutput = JSON.parse(rawText);
    } catch (err) {
      throw new OpenAIError(
        `Failed to parse model output as JSON: ${rawText.substring(0, 200)}...`,
        'INVALID_JSON_OUTPUT'
      );
    }

    // extract usage if available
    let usage: { inputTokens: number; outputTokens: number } | undefined;
    if (responseData.usage) {
      usage = {
        inputTokens: responseData.usage.input_tokens ?? 0,
        outputTokens: responseData.usage.output_tokens ?? 0,
      };
    }

    return {
      output: parsedOutput,
      rawText,
      model: responseData.model ?? model,
      usage,
    };
  }

  return {
    callResponsesApi,
  };
}

/**
 * type for the client returned by createOpenAIClient.
 */
export type OpenAIClient = ReturnType<typeof createOpenAIClient>;

