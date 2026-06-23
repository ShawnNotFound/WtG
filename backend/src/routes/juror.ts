/**
 * http routes for the juror evaluation api.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { ZodError } from 'zod';
import {
  evaluateJuror,
  JurorValidationError,
} from '../game/jurorService.js';
import { OpenAIError } from '../llm/openaiResponsesClient.js';
import { getJsonProviderConfig } from '../llm/jsonModelClient.js';

const router = Router();

const headlineEntrySchema = z.union([
  z.string().min(1, 'Headline text cannot be empty'),
  z.object({
    id: z.string().optional(),
    text: z.string().min(1, 'Headline text cannot be empty'),
  }),
]);

const planetEntrySchema = z.object({
  id: z.string().min(1, 'Planet ID cannot be empty'),
  description: z.string().min(1, 'Planet description cannot be empty'),
});

const evaluateRequestSchema = z.object({
  storyDirection: z
    .string()
    .min(1, 'storyDirection cannot be empty')
    .max(2000, 'storyDirection cannot exceed 2000 characters'),
  headlinesList: z
    .array(headlineEntrySchema)
    .min(0)
    .max(100, 'headlinesList cannot exceed 100 entries'),
  planetList: z
    .array(planetEntrySchema)
    .min(1, 'planetList must have at least 1 planet')
    .max(20, 'planetList cannot exceed 20 planets'),
});

type EvaluateRequest = z.infer<typeof evaluateRequestSchema>;

/**
 * POST /juror/evaluate
 * evaluate a story direction using the configured juror provider.
 */
router.post('/evaluate', async (req: Request, res: Response): Promise<void> => {
  try {
    let validatedBody: EvaluateRequest;
    try {
      validatedBody = evaluateRequestSchema.parse(req.body);
    } catch (err) {
      if (err instanceof ZodError) {
        res.status(400).json({
          error: 'Validation failed',
          details: err.errors.map((e) => ({
            path: e.path.join('.'),
            message: e.message,
          })),
        });
        return;
      }
      throw err;
    }

    // normalize headlinesList to HeadlineEntry[]
    const headlinesList = validatedBody.headlinesList.map((h) =>
      typeof h === 'string' ? { text: h } : h
    );

    const result = await evaluateJuror({
      storyDirection: validatedBody.storyDirection,
      headlinesList,
      planetList: validatedBody.planetList,
    });

    res.json({
      success: true,
      evaluation: result.evaluation,
      model: result.model,
      usage: result.usage,
    });
  } catch (error) {
    if (error instanceof JurorValidationError) {
      console.error('Juror validation error:', error.message, error.details);
      res.status(502).json({
        error: 'Invalid response from AI model',
        code: error.code,
        message: error.message,
        details: error.details,
      });
      return;
    }

    if (error instanceof OpenAIError) {
      console.error('OpenAI error:', error.message, error.code);
      const statusCode = error.statusCode === 401 ? 401 : 502;
      res.status(statusCode).json({
        error: 'AI service error',
        code: error.code,
        message: error.message,
      });
      return;
    }

    console.error('Unexpected error in juror evaluation:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to evaluate story direction',
    });
  }
});

/**
 * GET /juror/health
 * health check for the juror service.
 */
router.get('/health', (_req: Request, res: Response): void => {
  const config = getJsonProviderConfig('JUROR');
  const hasApiKey = !!config.apiKey;
  res.json({
    status: hasApiKey ? 'ok' : 'missing_api_key',
    provider: config.provider,
    model: config.model,
  });
});

export default router;

