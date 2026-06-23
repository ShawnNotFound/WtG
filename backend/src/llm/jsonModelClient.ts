import {
  createOpenAIClient,
  JsonSchemaDefinition,
  OpenAIError,
  DEFAULT_OPENAI_MODEL,
  ResponsesApiRequest,
  ResponsesApiResult,
} from './openaiResponsesClient.js';

export { DEFAULT_OPENAI_MODEL };

export type JsonModelProvider = 'openai' | 'deepseek';

export interface JsonModelClientConfig {
  provider: JsonModelProvider;
  apiKey: string;
  model: string;
  baseUrl: string;
  fetchFn?: typeof fetch;
}

export interface JsonModelSelection {
  provider: JsonModelProvider;
  model: string;
  baseUrl?: string;
}

export interface JsonModelClient {
  callResponsesApi<T>(request: ResponsesApiRequest): Promise<ResponsesApiResult<T>>;
}

export const DEFAULT_DEEPSEEK_MODEL = 'deepseek-v4-pro';
export const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

function stripJsonCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

function buildDeepSeekUserInput(input: string, jsonSchema?: JsonSchemaDefinition): string {
  if (!jsonSchema) {
    return input;
  }

  return `${input}

Return ONLY a JSON object matching this JSON schema. Do not wrap the JSON in markdown.

=== JSON SCHEMA (${jsonSchema.name}) ===
${JSON.stringify(jsonSchema.schema)}`;
}

function createDeepSeekJsonClient(config: JsonModelClientConfig): JsonModelClient {
  const {
    apiKey,
    model,
    baseUrl = DEFAULT_DEEPSEEK_BASE_URL,
    fetchFn = fetch,
  } = config;

  if (!apiKey) {
    throw new OpenAIError('DeepSeek API key is required', 'MISSING_API_KEY');
  }

  return {
    async callResponsesApi<T>(request: ResponsesApiRequest): Promise<ResponsesApiResult<T>> {
      const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
      const response = await fetchFn(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          temperature: request.temperature,
          response_format: request.jsonSchema ? { type: 'json_object' } : undefined,
          messages: [
            ...(request.instructions ? [{ role: 'system', content: request.instructions }] : []),
            {
              role: 'user',
              content: buildDeepSeekUserInput(request.input, request.jsonSchema),
            },
          ],
        }),
      });

      if (!response.ok) {
        let errorMessage = `DeepSeek API returned ${response.status}`;
        try {
          const errorBody = (await response.json()) as { error?: { message?: string } };
          errorMessage = errorBody.error?.message ?? errorMessage;
        } catch {
          // keep status-only message
        }
        throw new OpenAIError(errorMessage, 'API_ERROR', response.status);
      }

      let responseData: any;
      try {
        responseData = await response.json();
      } catch {
        throw new OpenAIError('Failed to parse DeepSeek response as JSON', 'INVALID_RESPONSE');
      }

      const rawText = responseData.choices?.[0]?.message?.content;
      if (!rawText || typeof rawText !== 'string') {
        throw new OpenAIError('Unexpected DeepSeek response structure: missing message content', 'INVALID_RESPONSE_STRUCTURE');
      }

      let parsedOutput: T;
      const jsonText = stripJsonCodeFence(rawText);
      try {
        parsedOutput = JSON.parse(jsonText) as T;
      } catch {
        throw new OpenAIError(
          `Failed to parse model output as JSON: ${jsonText.substring(0, 200)}...`,
          'INVALID_JSON_OUTPUT'
        );
      }

      return {
        output: parsedOutput,
        rawText: jsonText,
        model: responseData.model ?? model,
        usage: responseData.usage
          ? {
              inputTokens: responseData.usage.prompt_tokens ?? responseData.usage.input_tokens ?? 0,
              outputTokens: responseData.usage.completion_tokens ?? responseData.usage.output_tokens ?? 0,
            }
          : undefined,
      };
    },
  };
}

export function createJsonModelClient(config: JsonModelClientConfig): JsonModelClient {
  if (config.provider === 'deepseek') {
    return createDeepSeekJsonClient(config);
  }

  return createOpenAIClient({
    apiKey: config.apiKey,
    model: config.model,
    baseUrl: config.baseUrl,
    fetchFn: config.fetchFn,
  });
}

export function getDefaultJsonProvider(): JsonModelProvider {
  return process.env.LLM_PROVIDER === 'deepseek' ? 'deepseek' : 'openai';
}

export function defaultModelForProvider(provider: JsonModelProvider): string {
  return provider === 'deepseek'
    ? (process.env.DEEPSEEK_MODEL || DEFAULT_DEEPSEEK_MODEL)
    : (process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL);
}

export function defaultBaseUrlForProvider(provider: JsonModelProvider): string {
  return provider === 'deepseek'
    ? (process.env.DEEPSEEK_BASE_URL || DEFAULT_DEEPSEEK_BASE_URL)
    : (process.env.OPENAI_BASE_URL || 'https://api.openai.com');
}

export function normalizeJsonModelSelection(raw: unknown): JsonModelSelection {
  const source = raw && typeof raw === 'object' ? raw as Partial<JsonModelSelection> : {};
  const provider = source.provider === 'openai' || source.provider === 'deepseek'
    ? source.provider
    : getDefaultJsonProvider();

  const model = typeof source.model === 'string' && source.model.trim()
    ? source.model.trim().slice(0, 100)
    : defaultModelForProvider(provider);

  const baseUrl = typeof source.baseUrl === 'string' && source.baseUrl.trim()
    ? source.baseUrl.trim().replace(/\/+$/, '').slice(0, 200)
    : defaultBaseUrlForProvider(provider);

  return { provider, model, baseUrl };
}

export function getJsonProviderConfig(prefix = 'LLM', override?: Partial<JsonModelSelection>): JsonModelClientConfig {
  const selection = normalizeJsonModelSelection(override ?? {});
  const provider = selection.provider;

  if (provider === 'deepseek') {
    return {
      provider,
      apiKey: process.env[`${prefix}_DEEPSEEK_API_KEY`] || process.env.DEEPSEEK_API_KEY || '',
      model: override?.model || process.env[`${prefix}_DEEPSEEK_MODEL`] || selection.model,
      baseUrl: override?.baseUrl || process.env[`${prefix}_DEEPSEEK_BASE_URL`] || selection.baseUrl || DEFAULT_DEEPSEEK_BASE_URL,
    };
  }

  return {
    provider,
    apiKey: process.env[`${prefix}_OPENAI_API_KEY`] || process.env.OPENAI_API_KEY || '',
    model: override?.model || process.env[`${prefix}_OPENAI_MODEL`] || selection.model,
    baseUrl: override?.baseUrl || process.env[`${prefix}_OPENAI_BASE_URL`] || selection.baseUrl || 'https://api.openai.com',
  };
}
