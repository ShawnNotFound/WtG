import { Request, Response, Router } from 'express';
import { z, ZodError } from 'zod';
import { DEFAULT_AI_PLAYER_CONFIG } from '../ai/aiPlayerService.js';
import { evaluationCoordinator } from '../evaluation/evaluationService.js';
import { aiPlayerConfigSchema, llmConfigSchema } from '../utils/validation.js';

const router = Router();

const evaluationConfigSchema = z.object({
  playMinutes: z.number().int().min(1).max(120).default(8),
  breakMinutes: z.number().int().min(0).max(60).default(3),
  maxRounds: z.number().int().min(1).max(20).default(4),
  timelineSpeedRatio: z.number().min(0).max(100000).default(60),
  worldStateEnabled: z.boolean().default(true),
  summaryConfig: z.object({
    roundSummaries: z.boolean().default(false),
    finalNarrative: z.boolean().default(false),
  }).default({ roundSummaries: false, finalNarrative: false }),
  llmConfig: llmConfigSchema.optional(),
  aiPlayers: z.array(aiPlayerConfigSchema).min(1).max(16).default([
    {
      nickname: 'AI Player 1',
      stylePrompt: DEFAULT_AI_PLAYER_CONFIG.stylePrompt,
      creativity: DEFAULT_AI_PLAYER_CONFIG.creativity,
      submitEverySeconds: DEFAULT_AI_PLAYER_CONFIG.submitEverySeconds,
      provider: DEFAULT_AI_PLAYER_CONFIG.provider,
      model: DEFAULT_AI_PLAYER_CONFIG.model,
    },
    {
      nickname: 'AI Player 2',
      stylePrompt: DEFAULT_AI_PLAYER_CONFIG.stylePrompt,
      creativity: DEFAULT_AI_PLAYER_CONFIG.creativity,
      submitEverySeconds: DEFAULT_AI_PLAYER_CONFIG.submitEverySeconds,
      provider: DEFAULT_AI_PLAYER_CONFIG.provider,
      model: DEFAULT_AI_PLAYER_CONFIG.model,
    },
  ]),
});

const createEvaluationSchema = z.object({
  name: z.string().trim().min(1).max(120).default('Evaluation Batch'),
  runCount: z.number().int().min(1).max(50).default(10),
  concurrency: z.number().int().min(1).max(50).optional(),
  config: evaluationConfigSchema,
});

const uuidSchema = z.string().uuid();

function validationError(res: Response, error: unknown): boolean {
  if (error instanceof ZodError) {
    res.status(400).json({ error: 'Validation failed', details: error.errors });
    return true;
  }
  return false;
}

router.get('/', async (_req: Request, res: Response): Promise<void> => {
  try {
    const batches = await evaluationCoordinator.listBatches();
    res.json({ batches });
  } catch (error) {
    console.error('Evaluation list failed:', error);
    res.status(500).json({ error: 'Failed to list evaluations' });
  }
});

router.post('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const parsed = createEvaluationSchema.parse(req.body);
    const runCount = parsed.runCount;
    const batch = await evaluationCoordinator.createBatch({
      name: parsed.name,
      runCount,
      concurrency: parsed.concurrency ?? runCount,
      config: parsed.config,
    });
    res.status(201).json(batch);
  } catch (error) {
    if (validationError(res, error)) return;
    console.error('Evaluation create failed:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to create evaluation' });
  }
});

router.get('/:batchId', async (req: Request, res: Response): Promise<void> => {
  try {
    const batchId = uuidSchema.parse(req.params.batchId);
    const batch = await evaluationCoordinator.getBatchDetails(batchId);
    if (!batch) {
      res.status(404).json({ error: 'Evaluation batch not found' });
      return;
    }
    res.json(batch);
  } catch (error) {
    if (validationError(res, error)) return;
    console.error('Evaluation detail failed:', error);
    res.status(500).json({ error: 'Failed to load evaluation' });
  }
});

router.get('/:batchId/runs/:runId/prompt', async (req: Request, res: Response): Promise<void> => {
  try {
    const batchId = uuidSchema.parse(req.params.batchId);
    const runId = uuidSchema.parse(req.params.runId);
    const prompt = await evaluationCoordinator.buildPromptForRun(batchId, runId);
    if (!prompt) {
      res.status(404).json({ error: 'Evaluation run not found' });
      return;
    }
    res.json(prompt);
  } catch (error) {
    if (validationError(res, error)) return;
    console.error('Evaluation prompt failed:', error);
    res.status(500).json({ error: 'Failed to build evaluation prompt' });
  }
});

router.put('/:batchId/runs/:runId/judge-result', async (req: Request, res: Response): Promise<void> => {
  try {
    const batchId = uuidSchema.parse(req.params.batchId);
    const runId = uuidSchema.parse(req.params.runId);
    const rawJudgeResult = req.body?.judgeResult ?? req.body;
    const batch = await evaluationCoordinator.saveJudgeResult(batchId, runId, rawJudgeResult);
    if (!batch) {
      res.status(404).json({ error: 'Evaluation run not found' });
      return;
    }
    res.json(batch);
  } catch (error) {
    if (validationError(res, error)) return;
    res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid judge result' });
  }
});

export default router;

