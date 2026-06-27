import pool from '../db/pool.js';
import { createJsonModelClient, DEFAULT_DEEPSEEK_MODEL, DEFAULT_OPENAI_MODEL } from '../llm/jsonModelClient.js';
import { DEFAULT_SCORING_CONFIG, PlanetPanelEntry } from '../game/scoringTypes.js';
import {
  AiPlayerOutput,
  AiVisibleHeadline,
  buildAiPlayerInstructions,
  buildAiPlayerPrompt,
  aiPlayerJsonSchema,
} from './aiPlayerPrompt.js';

export interface AiPlayerConfig {
  stylePrompt: string;
  creativity: number;
  submitEverySeconds: number;
  provider: 'openai' | 'deepseek';
  model: string;
}

function configuredAiPlayerProvider(): AiPlayerConfig['provider'] {
  const rawProvider = process.env.GAME_TEST_MODE === 'true'
    ? (process.env.AI_PLAYER_TEST_PROVIDER || process.env.AI_PLAYER_PROVIDER)
    : process.env.AI_PLAYER_PROVIDER;

  return rawProvider === 'openai' ? 'openai' : 'deepseek';
}

const DEFAULT_AI_PLAYER_PROVIDER = configuredAiPlayerProvider();

export const DEFAULT_AI_PLAYER_CONFIG: AiPlayerConfig = {
  stylePrompt: 'Strategic, grounded, specific, and slightly provocative.',
  creativity: 1.0,
  submitEverySeconds: 0,
  provider: DEFAULT_AI_PLAYER_PROVIDER,
  model: defaultModelForProvider(DEFAULT_AI_PLAYER_PROVIDER),
};

interface GenerateAiStoryDirectionInput {
  nickname: string;
  config: AiPlayerConfig;
  inGameNow: string | null;
  currentRound: number;
  maxRounds: number;
  planetPanel: PlanetPanelEntry[];
  headlines: AiVisibleHeadline[];
}

export function normalizeAiPlayerConfig(raw: unknown): AiPlayerConfig {
  const source = raw && typeof raw === 'object' ? raw as Partial<AiPlayerConfig> : {};
  const creativity = typeof source.creativity === 'number' && Number.isFinite(source.creativity)
    ? Math.min(1, Math.max(0, source.creativity))
    : DEFAULT_AI_PLAYER_CONFIG.creativity;
  const submitEverySeconds = typeof source.submitEverySeconds === 'number' && Number.isFinite(source.submitEverySeconds)
    ? Math.min(600, Math.max(0, Math.round(source.submitEverySeconds)))
    : DEFAULT_AI_PLAYER_CONFIG.submitEverySeconds;

  const provider = source.provider === 'deepseek' || source.provider === 'openai'
    ? source.provider
    : DEFAULT_AI_PLAYER_CONFIG.provider;

  return {
    stylePrompt: typeof source.stylePrompt === 'string'
      ? source.stylePrompt.trim().slice(0, 500)
      : DEFAULT_AI_PLAYER_CONFIG.stylePrompt,
    creativity,
    submitEverySeconds,
    provider,
    model: typeof source.model === 'string' && source.model.trim()
      ? source.model.trim().slice(0, 80)
      : defaultModelForProvider(provider),
  };
}

function defaultModelForProvider(provider: AiPlayerConfig['provider']): string {
  if (provider === 'deepseek') {
    return process.env.GAME_TEST_MODE === 'true'
      ? (
          process.env.AI_PLAYER_TEST_DEEPSEEK_MODEL ||
          process.env.AI_PLAYER_TEST_MODEL ||
          process.env.AI_PLAYER_DEEPSEEK_MODEL ||
          DEFAULT_DEEPSEEK_MODEL
        )
      : (process.env.AI_PLAYER_DEEPSEEK_MODEL || process.env.DEEPSEEK_MODEL || DEFAULT_DEEPSEEK_MODEL);
  }

  return process.env.GAME_TEST_MODE === 'true'
    ? (process.env.AI_PLAYER_TEST_OPENAI_MODEL || process.env.AI_PLAYER_OPENAI_MODEL || process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL)
    : (process.env.AI_PLAYER_OPENAI_MODEL || process.env.AI_PLAYER_MODEL || process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL);
}

export function scoringSummary(): string {
  const cfg = DEFAULT_SCORING_CONFIG;
  const maxConnection = cfg.connectionPoints.scale[3];
  const maxPlanet = 2;
  const maxHeadlineScore = cfg.baselineB + cfg.plausibilityPoints.exactTarget + maxConnection + maxPlanet;
  return [
    `Every accepted story direction earns +${cfg.baselineB}.`,
    `Plausibility: P${cfg.plausibilityPoints.targetLevel} earns +${cfg.plausibilityPoints.exactTarget}; P${cfg.plausibilityPoints.nearLevels.join('/P')} earns +${cfg.plausibilityPoints.nearTarget}; P1/P5 earn +${cfg.plausibilityPoints.other}.`,
    `Connections are the biggest lever: distinct other authors score ${cfg.connectionPoints.scale.join('/')} points for 0/1/2/3 authors, so 3 distinct strong links are worth +${maxConnection}.`,
    'Planet bonus is real-time and based on the juror-selected rank-1/primary planet: +2 for the current least-used band, +1 for the middle band, +0 for the most-used band.',
    `Best target pattern: accepted headline + P3 plausibility + 3 distinct other-author connections + a +2 primary planet = up to ${maxHeadlineScore} points.`,
  ].join('\n');
}

export async function generateAiStoryDirection(input: GenerateAiStoryDirectionInput): Promise<AiPlayerOutput> {
  if (input.config.provider === 'deepseek') {
    return generateWithDeepSeek(input);
  }

  const isTestMode = process.env.GAME_TEST_MODE === 'true';
  const apiKey = isTestMode
    ? (process.env.AI_PLAYER_TEST_OPENAI_API_KEY || process.env.AI_PLAYER_OPENAI_API_KEY || process.env.OPENAI_API_KEY)
    : (process.env.AI_PLAYER_OPENAI_API_KEY || process.env.OPENAI_API_KEY);
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY or AI_PLAYER_OPENAI_API_KEY is required for OpenAI AI players');
  }

  const client = createJsonModelClient({
    provider: 'openai',
    apiKey,
    model: input.config.model || defaultModelForProvider('openai'),
    baseUrl: isTestMode
      ? (process.env.AI_PLAYER_TEST_OPENAI_BASE_URL || process.env.AI_PLAYER_OPENAI_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.openai.com')
      : (process.env.AI_PLAYER_OPENAI_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.openai.com'),
  });

  const prompt = buildAiPlayerPrompt({
    nickname: input.nickname,
    stylePrompt: input.config.stylePrompt,
    creativity: input.config.creativity,
    inGameNow: input.inGameNow,
    currentRound: input.currentRound,
    maxRounds: input.maxRounds,
    scoringSummary: scoringSummary(),
    planetPanel: input.planetPanel,
    headlines: input.headlines,
  });

  const result = await client.callResponsesApi<AiPlayerOutput>({
    instructions: buildAiPlayerInstructions(),
    input: prompt,
    jsonSchema: aiPlayerJsonSchema,
    temperature: input.config.creativity,
  });

  return {
    storyDirection: result.output.storyDirection.trim().slice(0, 280),
    rationale: result.output.rationale,
  };
}

async function generateWithDeepSeek(input: GenerateAiStoryDirectionInput): Promise<AiPlayerOutput> {
  const isTestMode = process.env.GAME_TEST_MODE === 'true';
  const apiKey = isTestMode
    ? (process.env.AI_PLAYER_TEST_DEEPSEEK_API_KEY || process.env.AI_PLAYER_TEST_API_KEY || process.env.AI_PLAYER_DEEPSEEK_API_KEY || process.env.DEEPSEEK_API_KEY)
    : (process.env.AI_PLAYER_DEEPSEEK_API_KEY || process.env.DEEPSEEK_API_KEY);
  if (!apiKey) {
    throw new Error('DEEPSEEK_API_KEY or AI_PLAYER_DEEPSEEK_API_KEY is required for DeepSeek AI players');
  }

  const prompt = buildAiPlayerPrompt({
    nickname: input.nickname,
    stylePrompt: input.config.stylePrompt,
    creativity: input.config.creativity,
    inGameNow: input.inGameNow,
    currentRound: input.currentRound,
    maxRounds: input.maxRounds,
    scoringSummary: scoringSummary(),
    planetPanel: input.planetPanel,
    headlines: input.headlines,
  });

  const client = createJsonModelClient({
    provider: 'deepseek',
    apiKey,
    model: input.config.model || defaultModelForProvider('deepseek'),
    baseUrl: isTestMode
      ? (process.env.AI_PLAYER_TEST_DEEPSEEK_BASE_URL || process.env.AI_PLAYER_TEST_BASE_URL || process.env.AI_PLAYER_DEEPSEEK_BASE_URL || process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com')
      : (process.env.AI_PLAYER_DEEPSEEK_BASE_URL || process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com'),
  });

  const result = await client.callResponsesApi<AiPlayerOutput>({
    instructions: buildAiPlayerInstructions(),
    input: prompt,
    jsonSchema: aiPlayerJsonSchema,
    temperature: input.config.creativity,
  });

  const output = result.output;

  return {
    storyDirection: String(output.storyDirection ?? '').trim().slice(0, 280),
    rationale: String(output.rationale ?? ''),
  };
}

export async function getAiPlayerRows(sessionId: string) {
  const result = await pool.query(
    `SELECT id, nickname, ai_config
     FROM session_players
     WHERE session_id = $1 AND is_ai = TRUE AND is_system = FALSE
     ORDER BY joined_at ASC`,
    [sessionId]
  );
  return result.rows;
}
