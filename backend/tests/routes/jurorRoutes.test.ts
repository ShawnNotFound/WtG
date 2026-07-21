/**
 * Integration tests for the juror API routes.
 */

import express from 'express';
import request from 'supertest';
import jurorRouter from '../../src/routes/juror';
import * as jurorService from '../../src/game/jurorService';
import { JurorEvaluationOutput } from '../../src/prompts/jurorPrompt';
import { OpenAIError } from '../../src/llm/openaiResponsesClient';

// Mock the juror service
jest.mock('../../src/game/jurorService', () => ({
  ...jest.requireActual('../../src/game/jurorService'),
  evaluateJuror: jest.fn(),
  resetJurorClient: jest.fn(),
}));

describe('Juror Routes', () => {
  let app: express.Express;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/juror', jurorRouter);
    jest.clearAllMocks();
  });

  // Valid evaluation output
  const validEvaluation: JurorEvaluationOutput = {
    PLAUSIBILITY: {
      band: 3,
      label: 'plausible',
      rationale: 'Reasonable prediction',
    },
    PLANETS: {
      top3: [
        { id: 'MARS', rank: 1, rationale: 'Tech related' },
        { id: 'VENUS', rank: 2, rationale: 'Social impact' },
        { id: 'EARTH', rank: 3, rationale: 'Environment' },
      ],
    },
    LINKED: [
      { headline: 'H1', strength: 'STRONG', rationale: 'Test' },
      { headline: 'H2', strength: 'WEAK', rationale: 'Test' },
      { headline: 'H3', strength: 'STRONG', rationale: 'Test' },
    ],
    HEADLINES: {
      bands: {
        band1: 'Inevitable headline',
        band2: 'Probable headline',
        band3: 'Plausible headline',
        band4: 'Possible headline',
        band5: 'Preposterous headline',
      },
    },
  };

  const validRequest = {
    storyDirection: 'AI achieves consciousness',
    headlinesList: ['Previous headline 1', 'Previous headline 2'],
    planetList: [
      { id: 'MARS', description: 'Technology' },
      { id: 'VENUS', description: 'Society' },
      { id: 'EARTH', description: 'Environment' },
    ],
  };

  describe('POST /api/juror/evaluate', () => {
    it('should return 200 with valid evaluation result', async () => {
      (jurorService.evaluateJuror as jest.Mock).mockResolvedValue({
        evaluation: validEvaluation,
        model: 'gpt-5.2',
        usage: { inputTokens: 100, outputTokens: 200 },
      });

      const response = await request(app)
        .post('/api/juror/evaluate')
        .send(validRequest)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.evaluation).toEqual(validEvaluation);
      expect(response.body.model).toBe('gpt-5.2');
      expect(response.body.usage).toEqual({ inputTokens: 100, outputTokens: 200 });
    });

    it('should accept headlinesList as objects with id and text', async () => {
      (jurorService.evaluateJuror as jest.Mock).mockResolvedValue({
        evaluation: validEvaluation,
        model: 'gpt-5.2',
      });

      const requestWithObjects = {
        ...validRequest,
        headlinesList: [
          { id: 'h1', text: 'Previous headline 1' },
          { id: 'h2', text: 'Previous headline 2' },
        ],
      };

      await request(app)
        .post('/api/juror/evaluate')
        .send(requestWithObjects)
        .expect(200);

      expect(jurorService.evaluateJuror).toHaveBeenCalledWith(
        expect.objectContaining({
          headlinesList: [
            { id: 'h1', text: 'Previous headline 1' },
            { id: 'h2', text: 'Previous headline 2' },
          ],
        })
      );
    });

    it('should return 400 if storyDirection is missing', async () => {
      const response = await request(app)
        .post('/api/juror/evaluate')
        .send({
          headlinesList: [],
          planetList: [{ id: 'MARS', description: 'Test' }],
        })
        .expect(400);

      expect(response.body.error).toBe('Validation failed');
      expect(response.body.details).toContainEqual(
        expect.objectContaining({ path: 'storyDirection' })
      );
    });

    it('should return 400 if storyDirection is empty', async () => {
      const response = await request(app)
        .post('/api/juror/evaluate')
        .send({
          storyDirection: '',
          headlinesList: [],
          planetList: [{ id: 'MARS', description: 'Test' }],
        })
        .expect(400);

      expect(response.body.error).toBe('Validation failed');
    });

    it('should return 400 if planetList is empty', async () => {
      const response = await request(app)
        .post('/api/juror/evaluate')
        .send({
          storyDirection: 'Test direction',
          headlinesList: [],
          planetList: [],
        })
        .expect(400);

      expect(response.body.error).toBe('Validation failed');
      expect(response.body.details).toContainEqual(
        expect.objectContaining({ path: 'planetList' })
      );
    });

    it('should return 400 if planet entry is missing description', async () => {
      const response = await request(app)
        .post('/api/juror/evaluate')
        .send({
          storyDirection: 'Test direction',
          headlinesList: [],
          planetList: [{ id: 'MARS' }],
        })
        .expect(400);

      expect(response.body.error).toBe('Validation failed');
    });

    it('should accept empty headlinesList', async () => {
      (jurorService.evaluateJuror as jest.Mock).mockResolvedValue({
        evaluation: validEvaluation,
        model: 'gpt-5.2',
      });

      await request(app)
        .post('/api/juror/evaluate')
        .send({
          storyDirection: 'Test direction',
          headlinesList: [],
          planetList: [{ id: 'MARS', description: 'Test' }],
        })
        .expect(200);
    });

    it('should return 502 on JurorValidationError', async () => {
      (jurorService.evaluateJuror as jest.Mock).mockRejectedValue(
        new jurorService.JurorValidationError(
          'Invalid output',
          'INVALID_LINKED_COUNT',
          { count: 1 }
        )
      );

      const response = await request(app)
        .post('/api/juror/evaluate')
        .send(validRequest)
        .expect(502);

      expect(response.body.error).toBe('Invalid response from AI model');
      expect(response.body.code).toBe('INVALID_LINKED_COUNT');
    });

    it('should return 502 on OpenAIError (non-401)', async () => {
      const error = new OpenAIError('API call failed', 'API_ERROR', 500);
      (jurorService.evaluateJuror as jest.Mock).mockRejectedValue(error);

      const response = await request(app)
        .post('/api/juror/evaluate')
        .send(validRequest)
        .expect(502);

      expect(response.body.error).toBe('AI service error');
      expect(response.body.code).toBe('API_ERROR');
    });

    it('should return 401 on OpenAIError with 401 status', async () => {
      const error = new OpenAIError('Invalid API key', 'API_ERROR', 401);
      (jurorService.evaluateJuror as jest.Mock).mockRejectedValue(error);

      const response = await request(app)
        .post('/api/juror/evaluate')
        .send(validRequest)
        .expect(401);

      expect(response.body.error).toBe('AI service error');
    });

    it('should return 500 on unexpected error', async () => {
      (jurorService.evaluateJuror as jest.Mock).mockRejectedValue(
        new Error('Unexpected error')
      );

      const response = await request(app)
        .post('/api/juror/evaluate')
        .send(validRequest)
        .expect(500);

      expect(response.body.error).toBe('Internal server error');
    });

    it('should normalize string headlines to objects', async () => {
      (jurorService.evaluateJuror as jest.Mock).mockResolvedValue({
        evaluation: validEvaluation,
        model: 'gpt-5.2',
      });

      await request(app)
        .post('/api/juror/evaluate')
        .send(validRequest)
        .expect(200);

      expect(jurorService.evaluateJuror).toHaveBeenCalledWith(
        expect.objectContaining({
          headlinesList: [
            { text: 'Previous headline 1' },
            { text: 'Previous headline 2' },
          ],
        })
      );
    });
  });

  describe('GET /api/juror/health', () => {
    let previousProvider: string | undefined;
    let previousOpenAIKey: string | undefined;
    let previousOpenAIModel: string | undefined;

    beforeEach(() => {
      previousProvider = process.env.LLM_PROVIDER;
      previousOpenAIKey = process.env.OPENAI_API_KEY;
      previousOpenAIModel = process.env.OPENAI_MODEL;
      process.env.LLM_PROVIDER = 'openai';
      delete process.env.OPENAI_MODEL;
    });

    afterEach(() => {
      if (previousProvider === undefined) {
        delete process.env.LLM_PROVIDER;
      } else {
        process.env.LLM_PROVIDER = previousProvider;
      }

      if (previousOpenAIKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousOpenAIKey;
      }

      if (previousOpenAIModel === undefined) {
        delete process.env.OPENAI_MODEL;
      } else {
        process.env.OPENAI_MODEL = previousOpenAIModel;
      }
    });

    it('should return ok status when API key is set', async () => {
      process.env.OPENAI_API_KEY = 'test-key';

      const response = await request(app)
        .get('/api/juror/health')
        .expect(200);

      expect(response.body.status).toBe('ok');
      expect(response.body.model).toBe('gpt-5.5');
    });

    it('should return missing_api_key status when API key is not set', async () => {
      delete process.env.OPENAI_API_KEY;

      const response = await request(app)
        .get('/api/juror/health')
        .expect(200);

      expect(response.body.status).toBe('missing_api_key');
    });

    it('should return custom model when OPENAI_MODEL is set', async () => {
      process.env.OPENAI_API_KEY = 'test-key';
      process.env.OPENAI_MODEL = 'gpt-4o';

      const response = await request(app)
        .get('/api/juror/health')
        .expect(200);

      expect(response.body.model).toBe('gpt-4o');
    });
  });
});

