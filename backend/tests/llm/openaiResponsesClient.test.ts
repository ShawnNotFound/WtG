/**
 * Unit tests for the OpenAI Responses API client.
 */

import {
  createOpenAIClient,
  OpenAIError,
} from '../../src/llm/openaiResponsesClient';

describe('OpenAI Responses API Client', () => {
  const mockApiKey = 'test-api-key';

  describe('createOpenAIClient', () => {
    it('should throw if API key is missing', () => {
      expect(() => createOpenAIClient({ apiKey: '' })).toThrow(OpenAIError);
      expect(() => createOpenAIClient({ apiKey: '' })).toThrow('OPENAI_API_KEY is required');
    });

    it('should create client with valid API key', () => {
      const client = createOpenAIClient({ apiKey: mockApiKey });
      expect(client).toBeDefined();
      expect(client.callResponsesApi).toBeInstanceOf(Function);
    });
  });

  describe('callResponsesApi', () => {
    /**
     * Create a mock fetch function that returns a valid Responses API response.
     */
    function createMockFetch(outputText: string, statusCode = 200, usage?: any) {
      return jest.fn().mockResolvedValue({
        ok: statusCode >= 200 && statusCode < 300,
        status: statusCode,
        json: () =>
          Promise.resolve(
            statusCode >= 200 && statusCode < 300
              ? {
                  id: 'resp_123',
                  model: 'gpt-5.2',
                  output: [
                    {
                      type: 'message',
                      content: [
                        {
                          type: 'output_text',
                          text: outputText,
                        },
                      ],
                    },
                  ],
                  usage: usage ?? {
                    input_tokens: 100,
                    output_tokens: 50,
                  },
                }
              : {
                  error: {
                    message: 'API Error',
                    type: 'invalid_request_error',
                  },
                }
          ),
      } as unknown as Response);
    }

    it('should parse valid JSON output from Responses API', async () => {
      const expectedOutput = { key: 'value', number: 42 };
      const mockFetch = createMockFetch(JSON.stringify(expectedOutput));

      const client = createOpenAIClient({
        apiKey: mockApiKey,
        fetchFn: mockFetch,
      });

      const result = await client.callResponsesApi<typeof expectedOutput>({
        input: 'Test prompt',
      });

      expect(result.output).toEqual(expectedOutput);
      expect(result.rawText).toBe(JSON.stringify(expectedOutput));
      expect(result.model).toBe('gpt-5.2');
      expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
    });

    it('should send correct request headers and body', async () => {
      const mockFetch = createMockFetch('{"result": true}');

      const client = createOpenAIClient({
        apiKey: mockApiKey,
        model: 'gpt-4o',
        baseUrl: 'https://custom.api.com',
        fetchFn: mockFetch,
      });

      await client.callResponsesApi({
        input: 'Test prompt',
        instructions: 'Be helpful',
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://custom.api.com/v1/responses',
        expect.objectContaining({
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer test-api-key',
          },
        })
      );

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.model).toBe('gpt-4o');
      expect(callBody.input).toBe('Test prompt');
      expect(callBody.instructions).toBe('Be helpful');
    });

    it('should include JSON schema in request when provided', async () => {
      const mockFetch = createMockFetch('{"result": true}');

      const client = createOpenAIClient({
        apiKey: mockApiKey,
        fetchFn: mockFetch,
      });

      const jsonSchema = {
        name: 'test_schema',
        strict: true,
        schema: {
          type: 'object',
          properties: {
            result: { type: 'boolean' },
          },
        },
      };

      await client.callResponsesApi({
        input: 'Test prompt',
        jsonSchema,
      });

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.text).toEqual({
        format: {
          type: 'json_schema',
          name: 'test_schema',
          strict: true,
          schema: jsonSchema.schema,
        },
      });
    });

    it('should throw NETWORK_ERROR on fetch failure', async () => {
      const mockFetch = jest.fn().mockRejectedValue(new Error('Connection refused'));

      const client = createOpenAIClient({
        apiKey: mockApiKey,
        fetchFn: mockFetch,
      });

      await expect(client.callResponsesApi({ input: 'Test' })).rejects.toThrow(OpenAIError);
      await expect(client.callResponsesApi({ input: 'Test' })).rejects.toMatchObject({
        code: 'NETWORK_ERROR',
      });
    });

    it('should throw API_ERROR on non-200 response', async () => {
      const mockFetch = createMockFetch('', 401);

      const client = createOpenAIClient({
        apiKey: mockApiKey,
        fetchFn: mockFetch,
      });

      await expect(client.callResponsesApi({ input: 'Test' })).rejects.toThrow(OpenAIError);
      await expect(client.callResponsesApi({ input: 'Test' })).rejects.toMatchObject({
        code: 'API_ERROR',
        statusCode: 401,
      });
    });

    it('should throw INVALID_RESPONSE_STRUCTURE for unexpected response format', async () => {
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ unexpected: 'format' }),
      } as unknown as Response);

      const client = createOpenAIClient({
        apiKey: mockApiKey,
        fetchFn: mockFetch,
      });

      await expect(client.callResponsesApi({ input: 'Test' })).rejects.toThrow(OpenAIError);
      await expect(client.callResponsesApi({ input: 'Test' })).rejects.toMatchObject({
        code: 'INVALID_RESPONSE_STRUCTURE',
      });
    });

    it('should throw INVALID_JSON_OUTPUT when output is not valid JSON', async () => {
      const mockFetch = createMockFetch('This is not JSON');

      const client = createOpenAIClient({
        apiKey: mockApiKey,
        fetchFn: mockFetch,
      });

      await expect(client.callResponsesApi({ input: 'Test' })).rejects.toThrow(OpenAIError);
      await expect(client.callResponsesApi({ input: 'Test' })).rejects.toMatchObject({
        code: 'INVALID_JSON_OUTPUT',
      });
    });

    it('should handle complex nested JSON output', async () => {
      const complexOutput = {
        PLAUSIBILITY: { band: 3, label: 'plausible', rationale: 'Test' },
        PLANETS: { top3: [{ id: 'MARS', rank: 1, rationale: 'Test' }] },
        LINKED: [{ headline: 'Test headline', strength: 'STRONG', rationale: 'Test' }],
        HEADLINES: {
          bands: {
            band1: 'Headline 1',
            band2: 'Headline 2',
            band3: 'Headline 3',
            band4: 'Headline 4',
            band5: 'Headline 5',
          },
          randomBand: 3,
          selectedHeadline: 'Headline 3',
          transformationSummary: 'Test summary',
        },
      };

      const mockFetch = createMockFetch(JSON.stringify(complexOutput));

      const client = createOpenAIClient({
        apiKey: mockApiKey,
        fetchFn: mockFetch,
      });

      const result = await client.callResponsesApi<typeof complexOutput>({
        input: 'Test prompt',
      });

      expect(result.output).toEqual(complexOutput);
    });

    it('should use default values for model and baseUrl', async () => {
      const mockFetch = createMockFetch('{"ok": true}');

      const client = createOpenAIClient({
        apiKey: mockApiKey,
        fetchFn: mockFetch,
      });

      await client.callResponsesApi({ input: 'Test' });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.openai.com/v1/responses',
        expect.anything()
      );

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.model).toBe('gpt-5.5');
    });
  });
});

