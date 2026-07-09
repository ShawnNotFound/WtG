/**
 * Unit tests for the juror service.
 */

import {
  evaluateJuror,
  setJurorClient,
  resetJurorClient,
  JurorValidationError,
} from '../../src/game/jurorService';
import { JurorEvaluationOutput } from '../../src/prompts/jurorPrompt';
import { OpenAIClient } from '../../src/llm/openaiResponsesClient';

describe('Juror Service', () => {
  // Valid mock evaluation output
  const createValidOutput = (overrides: Partial<JurorEvaluationOutput> = {}): JurorEvaluationOutput => ({
    PLAUSIBILITY: {
      band: 3,
      label: 'plausible',
      rationale: 'This is a reasonable prediction',
    },
    PLANETS: {
      top3: [
        { id: 'MARS', rank: 1, rationale: 'Mars related' },
        { id: 'VENUS', rank: 2, rationale: 'Venus related' },
        { id: 'EARTH', rank: 3, rationale: 'Earth related' },
      ],
    },
    LINKED: [
      { headline: 'Previous headline 1', strength: 'STRONG', rationale: 'Connects strongly' },
      { headline: 'Previous headline 2', strength: 'WEAK', rationale: 'Connects weakly' },
      { headline: 'Previous headline 3', strength: 'STRONG', rationale: 'Another connection' },
    ],
    HEADLINES: {
      bands: {
        band1: 'AI CONFIRMED: Inevitable headline',
        band2: 'AI LIKELY: Probable headline',
        band3: 'AI COULD: Plausible headline',
        band4: 'AI MIGHT: Possible headline',
        band5: 'AI CLAIMS: Preposterous headline',
      },
    },
    ...overrides,
  });

  const mockRequest = {
    storyDirection: 'AI achieves general intelligence',
    headlinesList: [
      { id: 'h1', text: 'Previous headline 1' },
      { id: 'h2', text: 'Previous headline 2' },
    ],
    planetList: [
      { id: 'MARS', description: 'Technology and innovation' },
      { id: 'VENUS', description: 'Social impact' },
      { id: 'EARTH', description: 'Environment' },
    ],
  };

  beforeEach(() => {
    resetJurorClient();
    // Set OPENAI_API_KEY for tests
    process.env.OPENAI_API_KEY = 'test-key';
  });

  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
  });

  describe('evaluateJuror', () => {
    it('should return valid evaluation result', async () => {
      const validOutput = createValidOutput();
      const mockClient: OpenAIClient = {
        callResponsesApi: jest.fn().mockResolvedValue({
          output: validOutput,
          rawText: JSON.stringify(validOutput),
          model: 'gpt-5.2',
          usage: { inputTokens: 100, outputTokens: 200 },
        }),
      };
      setJurorClient(mockClient);

      const result = await evaluateJuror(mockRequest);

      expect(result.evaluation).toEqual(validOutput);
      expect(result.model).toBe('gpt-5.2');
      expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 200 });
      expect(result.rawRequest).toBeDefined();
      expect(result.rawRequest.storyDirection).toBe(mockRequest.storyDirection);
      expect(result.rawResponse).toBe(JSON.stringify(validOutput));
    });

    it('should throw JurorValidationError if LINKED has wrong count', async () => {
      const invalidOutput = createValidOutput({
        LINKED: [
          { headline: 'Only one', strength: 'STRONG', rationale: 'Test' },
        ],
      });
      const mockClient: OpenAIClient = {
        callResponsesApi: jest.fn().mockResolvedValue({
          output: invalidOutput,
          rawText: JSON.stringify(invalidOutput),
          model: 'gpt-5.2',
        }),
      };
      setJurorClient(mockClient);

      await expect(evaluateJuror(mockRequest)).rejects.toThrow(JurorValidationError);
      await expect(evaluateJuror(mockRequest)).rejects.toMatchObject({
        code: 'INVALID_LINKED_COUNT',
      });
    });

    it('should throw JurorValidationError if PLANETS.top3 has wrong count', async () => {
      const invalidOutput = createValidOutput({
        PLANETS: {
          top3: [
            { id: 'MARS', rank: 1, rationale: 'Only one' },
          ],
        },
      });
      const mockClient: OpenAIClient = {
        callResponsesApi: jest.fn().mockResolvedValue({
          output: invalidOutput,
          rawText: JSON.stringify(invalidOutput),
          model: 'gpt-5.2',
        }),
      };
      setJurorClient(mockClient);

      await expect(evaluateJuror(mockRequest)).rejects.toThrow(JurorValidationError);
      await expect(evaluateJuror(mockRequest)).rejects.toMatchObject({
        code: 'INVALID_PLANETS_COUNT',
      });
    });

    // Note: randomBand and selectedHeadline validation tests removed
    // These are now handled by backend dice roll, not LLM output

    it('should throw JurorValidationError if PLAUSIBILITY label does not match band', async () => {
      const invalidOutput = createValidOutput({
        PLAUSIBILITY: {
          band: 3,
          label: 'inevitable', // Wrong! Should be 'plausible' for band 3
          rationale: 'Test',
        },
      });

      const mockClient: OpenAIClient = {
        callResponsesApi: jest.fn().mockResolvedValue({
          output: invalidOutput,
          rawText: JSON.stringify(invalidOutput),
          model: 'gpt-5.2',
        }),
      };
      setJurorClient(mockClient);

      await expect(evaluateJuror(mockRequest)).rejects.toThrow(JurorValidationError);
      await expect(evaluateJuror(mockRequest)).rejects.toMatchObject({
        code: 'PLAUSIBILITY_LABEL_MISMATCH',
      });
    });

    it('should throw JurorValidationError if planet ranks are not 1, 2, 3', async () => {
      const invalidOutput = createValidOutput({
        PLANETS: {
          top3: [
            { id: 'MARS', rank: 1, rationale: 'Test' },
            { id: 'VENUS', rank: 1, rationale: 'Test' }, // Duplicate rank!
            { id: 'EARTH', rank: 3, rationale: 'Test' },
          ],
        },
      });

      const mockClient: OpenAIClient = {
        callResponsesApi: jest.fn().mockResolvedValue({
          output: invalidOutput,
          rawText: JSON.stringify(invalidOutput),
          model: 'gpt-5.2',
        }),
      };
      setJurorClient(mockClient);

      await expect(evaluateJuror(mockRequest)).rejects.toThrow(JurorValidationError);
      await expect(evaluateJuror(mockRequest)).rejects.toMatchObject({
        code: 'INVALID_PLANET_RANKS',
      });
    });

    it('should throw JurorValidationError if a headline band is empty', async () => {
      const invalidOutput = createValidOutput();
      invalidOutput.HEADLINES.bands.band4 = '';

      const mockClient: OpenAIClient = {
        callResponsesApi: jest.fn().mockResolvedValue({
          output: invalidOutput,
          rawText: JSON.stringify(invalidOutput),
          model: 'gpt-5.2',
        }),
      };
      setJurorClient(mockClient);

      await expect(evaluateJuror(mockRequest)).rejects.toThrow(JurorValidationError);
      await expect(evaluateJuror(mockRequest)).rejects.toMatchObject({
        code: 'EMPTY_HEADLINE_BAND',
      });
    });

    it('should validate all band/label combinations correctly', async () => {
      const bandLabelPairs: Array<[1 | 2 | 3 | 4 | 5, string]> = [
        [1, 'inevitable'],
        [2, 'probable'],
        [3, 'plausible'],
        [4, 'possible'],
        [5, 'preposterous'],
      ];

      for (const [band, label] of bandLabelPairs) {
        const validOutput = createValidOutput({
          PLAUSIBILITY: { band, label: label as any, rationale: 'Test' },
          HEADLINES: {
            bands: {
              band1: 'Band 1 headline',
              band2: 'Band 2 headline',
              band3: 'Band 3 headline',
              band4: 'Band 4 headline',
              band5: 'Band 5 headline',
            },
          },
        });

        const mockClient: OpenAIClient = {
          callResponsesApi: jest.fn().mockResolvedValue({
            output: validOutput,
            rawText: JSON.stringify(validOutput),
            model: 'gpt-5.2',
          }),
        };
        setJurorClient(mockClient);

        const result = await evaluateJuror(mockRequest);
        expect(result.evaluation.PLAUSIBILITY.band).toBe(band);
        expect(result.evaluation.PLAUSIBILITY.label).toBe(label);
      }
    });

    it('should pass through OpenAI errors', async () => {
      const mockClient: OpenAIClient = {
        callResponsesApi: jest.fn().mockRejectedValue(
          Object.assign(new Error('API Error'), { code: 'API_ERROR', statusCode: 500 })
        ),
      };
      setJurorClient(mockClient);

      await expect(evaluateJuror(mockRequest)).rejects.toThrow('API Error');
    });
  });
});

