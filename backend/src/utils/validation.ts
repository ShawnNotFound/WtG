import { z } from 'zod';

// nickname validation schema
export const nicknameSchema = z
  .string()
  .min(3, 'Nickname must be at least 3 characters')
  .max(20, 'Nickname must be at most 20 characters')
  .regex(
    /^[a-zA-Z0-9\s-]+$/,
    'Nickname can only contain letters, numbers, spaces, and hyphens'
  )
  .transform((val) => val.trim());

// join code validation schema
export const joinCodeSchema = z
  .string()
  .length(6, 'Join code must be exactly 6 characters')
  .regex(/^[A-Z0-9]+$/, 'Join code must contain only uppercase letters and numbers');

export const sessionTitleSchema = z
  .string()
  .max(80, 'Game title must be at most 80 characters')
  .transform((val) => val.trim())
  .refine((val) => val.length > 0, 'Game title cannot be empty');

export const aiPlayerConfigSchema = z.object({
  nickname: nicknameSchema.optional(),
  stylePrompt: z.string().max(500).optional(),
  creativity: z.number().min(0).max(1).optional(),
  submitEverySeconds: z.number().min(0).max(600).optional(),
  helperActivity: z.number().min(0).max(1).optional(),
  provider: z.enum(['openai', 'deepseek']).optional(),
  model: z.string().min(1).max(80).optional(),
});

export const llmConfigSchema = z.object({
  provider: z.enum(['openai', 'deepseek']).optional(),
  model: z.string().min(1).max(100).optional(),
  baseUrl: z.string().min(1).max(200).optional(),
});

export const moduleLlmConfigSchema = z.object({
  juror: llmConfigSchema.optional(),
  world: llmConfigSchema.optional(),
  summary: llmConfigSchema.optional(),
  helper: llmConfigSchema.optional(),
}).partial();

export const summaryConfigSchema = z.object({
  roundSummaries: z.boolean().optional(),
  finalNarrative: z.boolean().optional(),
}).partial();

export const worldStateConfigSchema = z.object({
  enabled: z.boolean().optional(),
  allowCycles: z.boolean().optional(),
  maxPropagationDepth: z.number().int().min(0).max(8).optional(),
  maxNodeReactions: z.number().int().min(1).max(200).optional(),
  maxEventsPerNode: z.number().int().min(1).max(20).optional(),
  nodeAgentConcurrency: z.number().int().min(1).max(16).optional(),
  storeUnaffectedDecisions: z.boolean().optional(),
  retrievalStrategy: z.enum(['hybrid', 'weighted', 'node_picker']).optional(),
  maxContextNodes: z.number().int().min(4).max(64).optional(),
  maxNeighborsPerNode: z.number().int().min(1).max(32).optional(),
  maxCandidateNeighbors: z.number().int().min(1).max(64).optional(),
  connectionDisplayThreshold: z.number().min(0).max(1).optional(),
  propagationRandomMode: z.enum(['seeded', 'random', 'threshold']).optional(),
}).partial();

// request body schemas
export const createSessionSchema = z.object({
  title: sessionTitleSchema.optional(),
  hostNickname: nicknameSchema,
  aiPlayers: z.array(aiPlayerConfigSchema).max(8).optional(),
  llmConfig: llmConfigSchema.optional(),
  moduleLlmConfig: moduleLlmConfigSchema.optional(),
  summaryConfig: summaryConfigSchema.optional(),
  worldStateConfig: worldStateConfigSchema.optional(),
  playMinutes: z.number().min(0.1).max(120).optional(),
  breakMinutes: z.number().min(0).max(60).optional(),
  maxRounds: z.number().int().min(1).max(20).optional(),
  timelineSpeedRatio: z.number().min(0).max(100000).optional(),
});

export const joinSessionSchema = z.object({
  nickname: nicknameSchema,
});

// headline validation schema
export const headlineSchema = z
  .string()
  .min(1, 'Headline cannot be empty')
  .max(280, 'Headline must be at most 280 characters')
  .transform((val) => val.trim());

export const submitHeadlineSchema = z.object({
  joinCode: joinCodeSchema,
  headline: headlineSchema,
});

export const worldHelperAskSchema = z.object({
  joinCode: joinCodeSchema,
  question: z
    .string()
    .min(1, 'Question cannot be empty')
    .max(1000, 'Question must be at most 1000 characters')
    .transform((val) => val.trim()),
  clientRequestId: z.string().max(120).optional(),
});

export type CreateSessionBody = z.infer<typeof createSessionSchema>;
export type JoinSessionBody = z.infer<typeof joinSessionSchema>;
export type SubmitHeadlineBody = z.infer<typeof submitHeadlineSchema>;
export type AiPlayerConfigBody = z.infer<typeof aiPlayerConfigSchema>;
export type LlmConfigBody = z.infer<typeof llmConfigSchema>;
export type ModuleLlmConfigBody = z.infer<typeof moduleLlmConfigSchema>;
export type WorldHelperAskBody = z.infer<typeof worldHelperAskSchema>;

