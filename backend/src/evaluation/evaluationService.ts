import pool from '../db/pool.js';
import { PoolClient } from 'pg';
import { DEFAULT_AI_PLAYER_CONFIG, normalizeAiPlayerConfig } from '../ai/aiPlayerService.js';
import { gameLoopManager } from '../game/gameLoop.js';
import { restoreGameSessionRuntime, startGameSessionRuntime } from '../game/sessionLifecycle.js';
import { randomOrdinals } from '../game/planetUsage.js';
import { DEFAULT_PLANETS } from '../game/scoringTypes.js';
import { generateUniqueJoinCode } from '../utils/joinCode.js';
import { normalizeJsonModelSelection } from '../llm/jsonModelClient.js';
import { buildGameplayJudgePrompt } from '../prompts/gameplayJudgePrompt.js';

const MONITOR_INTERVAL_MS = 2_500;

export interface EvaluationAiPlayerConfig {
  nickname?: string;
  stylePrompt?: string;
  creativity?: number;
  submitEverySeconds?: number;
  helperActivity?: number;
  provider?: 'openai' | 'deepseek';
  model?: string;
}

export interface EvaluationBatchConfig {
  playMinutes: number;
  breakMinutes: number;
  maxRounds: number;
  timelineSpeedRatio: number;
  worldStateEnabled: boolean;
  summaryConfig: {
    roundSummaries: boolean;
    finalNarrative: boolean;
  };
  llmConfig?: {
    provider?: 'openai' | 'deepseek';
    model?: string;
    baseUrl?: string;
  };
  aiPlayers: EvaluationAiPlayerConfig[];
}

export interface CreateEvaluationBatchInput {
  name: string;
  runCount: number;
  concurrency: number;
  config: EvaluationBatchConfig;
}

interface EvaluationRunRow {
  id: string;
  batch_id: string;
  run_index: number;
  session_id: string | null;
  join_code: string | null;
  status: string;
  judge_result: unknown;
  overall_score: number | null;
  dimension_scores: Record<string, number> | null;
  confidence: string | null;
  error: string | null;
  created_at: Date;
  updated_at: Date;
  started_at: Date | null;
  ready_at: Date | null;
  judged_at: Date | null;
  phase?: string | null;
  current_round?: number | null;
  max_rounds?: number | null;
}

export interface ParsedJudgeResult {
  overall_score: number;
  grade_band: string;
  dimension_scores: Record<string, number>;
  top_strengths: string[];
  top_weaknesses: string[];
  system_recommendations: string[];
  confidence: 'low' | 'medium' | 'high';
}

const DIMENSION_KEYS = [
  'world_coherence',
  'interconnection',
  'plausibility',
  'actor_worldbuilding',
  'breadth_balance',
  'narrative_arc',
  'originality',
  'headline_craft',
];

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function stddev(values: number[]): number | null {
  if (values.length === 0) return null;
  const avg = mean(values) ?? 0;
  const variance = values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function roundMetric(value: number | null): number | null {
  return value === null ? null : Math.round(value * 100) / 100;
}

function normalizeArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item ?? '').trim())
    .filter(Boolean)
    .slice(0, 20);
}

function extractJsonObject(input: string): unknown {
  const trimmed = input.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) {
      return JSON.parse(fenced[1].trim());
    }

    const first = trimmed.indexOf('{');
    const last = trimmed.lastIndexOf('}');
    if (first >= 0 && last > first) {
      return JSON.parse(trimmed.slice(first, last + 1));
    }
    throw new Error('Judge result is not valid JSON');
  }
}

export function parseJudgeResult(input: unknown): ParsedJudgeResult {
  const raw = typeof input === 'string' ? extractJsonObject(input) : input;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Judge result must be a JSON object');
  }

  const record = raw as Record<string, unknown>;
  const overall = Number(record.overall_score);
  if (!Number.isFinite(overall)) {
    throw new Error('Judge result must include numeric overall_score');
  }

  const dimensionRaw = record.dimension_scores;
  if (!dimensionRaw || typeof dimensionRaw !== 'object' || Array.isArray(dimensionRaw)) {
    throw new Error('Judge result must include dimension_scores');
  }

  const dimensionRecord = dimensionRaw as Record<string, unknown>;
  const dimensionScores: Record<string, number> = {};
  for (const key of DIMENSION_KEYS) {
    const value = Number(dimensionRecord[key]);
    if (!Number.isFinite(value)) {
      throw new Error(`dimension_scores.${key} must be numeric`);
    }
    dimensionScores[key] = clamp(value, 0, 100);
  }

  const confidence = String(record.confidence ?? '').toLowerCase();
  if (!['low', 'medium', 'high'].includes(confidence)) {
    throw new Error('confidence must be low, medium, or high');
  }

  return {
    overall_score: clamp(overall, 0, 100),
    grade_band: String(record.grade_band ?? '').trim(),
    dimension_scores: dimensionScores,
    top_strengths: normalizeArray(record.top_strengths),
    top_weaknesses: normalizeArray(record.top_weaknesses),
    system_recommendations: normalizeArray(record.system_recommendations),
    confidence: confidence as ParsedJudgeResult['confidence'],
  };
}

function countStrings(items: string[]): Array<{ text: string; count: number }> {
  const counts = new Map<string, number>();
  for (const item of items) {
    counts.set(item, (counts.get(item) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([text, count]) => ({ text, count }))
    .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text))
    .slice(0, 12);
}

function formatIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return new Date(value).toISOString();
}

function normalizeBatchConfig(config: EvaluationBatchConfig): EvaluationBatchConfig {
  return {
    playMinutes: Math.max(1, Math.round(config.playMinutes)),
    breakMinutes: Math.max(0, Math.round(config.breakMinutes)),
    maxRounds: clamp(Math.round(config.maxRounds), 1, 20),
    timelineSpeedRatio: Math.max(0, Number(config.timelineSpeedRatio) || 60),
    worldStateEnabled: config.worldStateEnabled !== false,
    summaryConfig: {
      roundSummaries: config.summaryConfig?.roundSummaries === true,
      finalNarrative: config.summaryConfig?.finalNarrative === true,
    },
    llmConfig: normalizeJsonModelSelection(config.llmConfig),
    aiPlayers: config.aiPlayers.map((player, index) => ({
      ...player,
      nickname: player.nickname?.trim() || `AI Player ${index + 1}`,
    })),
  };
}

async function createEvaluationSession(
  client: PoolClient,
  config: EvaluationBatchConfig,
  runIndex: number
) {
  const joinCode = await generateUniqueJoinCode();
  const normalizedLlmConfig = normalizeJsonModelSelection(config.llmConfig);

  const sessionResult = await client.query(
    `INSERT INTO game_sessions (
       title,
       join_code,
       status,
       play_minutes,
       break_minutes,
       max_rounds,
       timeline_speed_ratio,
       llm_config,
       world_state_config,
       summary_config
     )
     VALUES ($1, $2, 'WAITING', $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, join_code`,
    [
      `Evaluation Run ${runIndex}`,
      joinCode,
      config.playMinutes,
      config.breakMinutes,
      config.maxRounds,
      config.timelineSpeedRatio,
      JSON.stringify(normalizedLlmConfig),
      JSON.stringify({ enabled: config.worldStateEnabled }),
      JSON.stringify(config.summaryConfig),
    ]
  );
  const session = sessionResult.rows[0];

  const hostResult = await client.query(
    `INSERT INTO session_players (session_id, nickname, is_host, planet_usage_state)
     VALUES ($1, $2, true, $3)
     RETURNING id`,
    [
      session.id,
      `Eval Host ${runIndex}`,
      JSON.stringify(randomOrdinals(DEFAULT_PLANETS)),
    ]
  );

  await client.query(
    `UPDATE game_sessions SET host_player_id = $1 WHERE id = $2`,
    [hostResult.rows[0].id, session.id]
  );

  for (const [index, aiPlayer] of config.aiPlayers.entries()) {
    const aiConfig = normalizeAiPlayerConfig({
      ...DEFAULT_AI_PLAYER_CONFIG,
      stylePrompt: aiPlayer.stylePrompt ?? DEFAULT_AI_PLAYER_CONFIG.stylePrompt,
      creativity: aiPlayer.creativity ?? DEFAULT_AI_PLAYER_CONFIG.creativity,
      submitEverySeconds: aiPlayer.submitEverySeconds ?? DEFAULT_AI_PLAYER_CONFIG.submitEverySeconds,
      helperActivity: aiPlayer.helperActivity ?? DEFAULT_AI_PLAYER_CONFIG.helperActivity,
      provider: aiPlayer.provider ?? DEFAULT_AI_PLAYER_CONFIG.provider,
      model: aiPlayer.model,
    });

    await client.query(
      `INSERT INTO session_players
         (session_id, nickname, is_host, is_ai, ai_config, planet_usage_state)
       VALUES ($1, $2, false, true, $3, $4)`,
      [
        session.id,
        aiPlayer.nickname || `AI Player ${index + 1}`,
        JSON.stringify(aiConfig),
        JSON.stringify(randomOrdinals(DEFAULT_PLANETS)),
      ]
    );
  }

  return { sessionId: session.id as string, joinCode: session.join_code as string };
}

async function areSessionBackgroundJobsIdle(sessionId: string): Promise<boolean> {
  const worldJobs = await pool.query(
    `SELECT COUNT(*)::int AS count
     FROM world_state_jobs
     WHERE session_id = $1 AND status IN ('queued', 'running')`,
    [sessionId]
  );
  if ((worldJobs.rows[0]?.count ?? 0) > 0) return false;

  const summaryJobs = await pool.query(
    `SELECT COUNT(*)::int AS count
     FROM round_summaries
     WHERE session_id = $1 AND status IN ('pending', 'generating')`,
    [sessionId]
  );
  return (summaryJobs.rows[0]?.count ?? 0) === 0;
}

async function fetchRunForStart(runId: string): Promise<EvaluationRunRow | null> {
  const result = await pool.query(
    `UPDATE evaluation_runs
     SET status = 'starting',
         started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
         error = NULL
     WHERE id = $1 AND status = 'pending'
     RETURNING *`,
    [runId]
  );
  return result.rows[0] ?? null;
}

class EvaluationCoordinator {
  private monitorHandles = new Map<string, NodeJS.Timeout>();

  async createBatch(input: CreateEvaluationBatchInput) {
    const runCount = clamp(Math.round(input.runCount), 1, 50);
    const concurrency = clamp(Math.round(input.concurrency), 1, runCount);
    const config = normalizeBatchConfig(input.config);
    const client = await pool.connect();
    let batchId = '';

    try {
      await client.query('BEGIN');

      const batchResult = await client.query(
        `INSERT INTO evaluation_batches (name, run_count, concurrency, config)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [input.name.trim() || `Evaluation ${new Date().toLocaleString()}`, runCount, concurrency, JSON.stringify(config)]
      );
      batchId = batchResult.rows[0].id;

      for (let index = 1; index <= runCount; index++) {
        const session = await createEvaluationSession(client, config, index);
        await client.query(
          `INSERT INTO evaluation_runs (batch_id, run_index, session_id, join_code, status)
           VALUES ($1, $2, $3, $4, 'pending')`,
          [batchId, index, session.sessionId, session.joinCode]
        );
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    this.ensureMonitor(batchId);
    await this.launchPendingRuns(batchId);
    return this.getBatchDetails(batchId);
  }

  async resumeActiveBatches(): Promise<number> {
    const result = await pool.query(
      `SELECT DISTINCT b.id
       FROM evaluation_batches b
       JOIN evaluation_runs r ON r.batch_id = b.id
       LEFT JOIN game_sessions s ON s.id = r.session_id
       WHERE b.status = 'running'
          OR r.status IN ('pending', 'starting', 'running')
          OR (s.phase IS NOT NULL AND s.phase NOT IN ('WAITING', 'FINISHED') AND r.status NOT IN ('judged', 'error'))`
    );

    for (const row of result.rows) {
      this.ensureMonitor(row.id);
      await this.rehydrateBatch(row.id);
      await this.launchPendingRuns(row.id);
    }

    return result.rowCount ?? 0;
  }

  async refreshBatch(batchId: string): Promise<void> {
    await this.monitorBatch(batchId);
  }

  async getBatchDetails(batchId: string) {
    await this.monitorBatch(batchId);

    const batchResult = await pool.query(
      `SELECT id, name, status, run_count, concurrency, config, error, created_at, updated_at, completed_at
       FROM evaluation_batches
       WHERE id = $1`,
      [batchId]
    );
    const batch = batchResult.rows[0];
    if (!batch) return null;

    const runsResult = await pool.query(
      `SELECT r.*,
              s.phase,
              s.current_round,
              s.max_rounds
       FROM evaluation_runs r
       LEFT JOIN game_sessions s ON s.id = r.session_id
       WHERE r.batch_id = $1
       ORDER BY r.run_index ASC`,
      [batchId]
    );
    const runs = runsResult.rows as EvaluationRunRow[];
    const sessionIds = runs.map((run) => run.session_id).filter(Boolean) as string[];

    const headlineCounts = new Map<string, { all: number; player: number }>();
    const playersBySession = new Map<string, Array<{ nickname: string; isAi: boolean; totalScore: number }>>();

    if (sessionIds.length > 0) {
      const headlineResult = await pool.query(
        `SELECT h.session_id,
                COUNT(*)::int AS all_count,
                COUNT(*) FILTER (WHERE p.is_system = FALSE)::int AS player_count
         FROM game_session_headlines h
         JOIN session_players p ON p.id = h.player_id
         WHERE h.session_id = ANY($1)
         GROUP BY h.session_id`,
        [sessionIds]
      );
      for (const row of headlineResult.rows) {
        headlineCounts.set(row.session_id, {
          all: row.all_count,
          player: row.player_count,
        });
      }

      const playersResult = await pool.query(
        `SELECT session_id, nickname, is_ai, total_score
         FROM session_players
         WHERE session_id = ANY($1) AND is_system = FALSE
         ORDER BY joined_at ASC`,
        [sessionIds]
      );
      for (const row of playersResult.rows) {
        const list = playersBySession.get(row.session_id) ?? [];
        list.push({
          nickname: row.nickname,
          isAi: row.is_ai === true,
          totalScore: Number(row.total_score ?? 0),
        });
        playersBySession.set(row.session_id, list);
      }
    }

    const serializedRuns = runs.map((run) => ({
      id: run.id,
      runIndex: run.run_index,
      sessionId: run.session_id,
      joinCode: run.join_code,
      status: run.status,
      phase: run.phase ?? null,
      currentRound: run.current_round ?? null,
      maxRounds: run.max_rounds ?? null,
      headlineCount: run.session_id ? headlineCounts.get(run.session_id)?.all ?? 0 : 0,
      playerHeadlineCount: run.session_id ? headlineCounts.get(run.session_id)?.player ?? 0 : 0,
      players: run.session_id ? playersBySession.get(run.session_id) ?? [] : [],
      judgeResult: run.judge_result,
      overallScore: run.overall_score,
      dimensionScores: run.dimension_scores,
      confidence: run.confidence,
      error: run.error,
      createdAt: formatIso(run.created_at),
      updatedAt: formatIso(run.updated_at),
      startedAt: formatIso(run.started_at),
      readyAt: formatIso(run.ready_at),
      judgedAt: formatIso(run.judged_at),
    }));

    return {
      batch: {
        id: batch.id,
        name: batch.name,
        status: batch.status,
        runCount: batch.run_count,
        concurrency: batch.concurrency,
        config: batch.config,
        error: batch.error,
        createdAt: formatIso(batch.created_at),
        updatedAt: formatIso(batch.updated_at),
        completedAt: formatIso(batch.completed_at),
      },
      runs: serializedRuns,
      aggregate: this.computeAggregate(serializedRuns),
    };
  }

  async listBatches() {
    const result = await pool.query(
      `SELECT b.id,
              b.name,
              b.status,
              b.run_count,
              b.concurrency,
              b.created_at,
              b.updated_at,
              b.completed_at,
              COUNT(r.id)::int AS total_runs,
              COUNT(r.id) FILTER (WHERE r.status = 'judged')::int AS judged_runs,
              COUNT(r.id) FILTER (WHERE r.status = 'ready_for_judge')::int AS ready_runs,
              AVG(r.overall_score) FILTER (WHERE r.overall_score IS NOT NULL)::float AS average_score
       FROM evaluation_batches b
       LEFT JOIN evaluation_runs r ON r.batch_id = b.id
       GROUP BY b.id
       ORDER BY b.created_at DESC
       LIMIT 50`
    );

    return result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      status: row.status,
      runCount: row.run_count,
      concurrency: row.concurrency,
      totalRuns: row.total_runs,
      judgedRuns: row.judged_runs,
      readyRuns: row.ready_runs,
      averageScore: row.average_score === null ? null : roundMetric(Number(row.average_score)),
      createdAt: formatIso(row.created_at),
      updatedAt: formatIso(row.updated_at),
      completedAt: formatIso(row.completed_at),
    }));
  }

  async buildPromptForRun(batchId: string, runId: string) {
    const runResult = await pool.query(
      `SELECT r.id, r.session_id, r.join_code
       FROM evaluation_runs r
       WHERE r.batch_id = $1 AND r.id = $2`,
      [batchId, runId]
    );
    const run = runResult.rows[0];
    if (!run?.session_id) return null;

    const timeline = await this.buildTimeline(run.session_id);
    return {
      runId,
      joinCode: run.join_code,
      timeline,
      prompt: buildGameplayJudgePrompt(timeline),
    };
  }

  async saveJudgeResult(batchId: string, runId: string, rawJudgeResult: unknown) {
    const parsed = parseJudgeResult(rawJudgeResult);
    const result = await pool.query(
      `UPDATE evaluation_runs
       SET status = 'judged',
           judge_result = $1,
           overall_score = $2,
           dimension_scores = $3,
           confidence = $4,
           judged_at = CURRENT_TIMESTAMP,
           error = NULL
       WHERE batch_id = $5 AND id = $6
       RETURNING id`,
      [
        JSON.stringify(parsed),
        parsed.overall_score,
        JSON.stringify(parsed.dimension_scores),
        parsed.confidence,
        batchId,
        runId,
      ]
    );
    if (result.rows.length === 0) return null;
    await this.updateBatchCompletion(batchId);
    return this.getBatchDetails(batchId);
  }

  private ensureMonitor(batchId: string): void {
    if (this.monitorHandles.has(batchId)) return;

    const handle = setInterval(() => {
      this.monitorBatch(batchId).catch((error) => {
        console.error(`[Evaluation ${batchId}] monitor failed:`, error);
      });
    }, MONITOR_INTERVAL_MS);
    this.monitorHandles.set(batchId, handle);
  }

  private stopMonitor(batchId: string): void {
    const handle = this.monitorHandles.get(batchId);
    if (!handle) return;
    clearInterval(handle);
    this.monitorHandles.delete(batchId);
  }

  private async rehydrateBatch(batchId: string): Promise<void> {
    const result = await pool.query(
      `SELECT r.session_id, r.join_code, s.phase
       FROM evaluation_runs r
       JOIN game_sessions s ON s.id = r.session_id
       WHERE r.batch_id = $1
         AND r.status IN ('starting', 'running')
         AND s.phase NOT IN ('WAITING', 'FINISHED')`,
      [batchId]
    );
    const io = gameLoopManager.getSocketIO();
    for (const row of result.rows) {
      await restoreGameSessionRuntime(io, row.session_id, row.join_code);
    }
  }

  private async launchPendingRuns(batchId: string): Promise<void> {
    const batchResult = await pool.query(
      `SELECT concurrency FROM evaluation_batches WHERE id = $1 AND status = 'running'`,
      [batchId]
    );
    const batch = batchResult.rows[0];
    if (!batch) return;

    const countsResult = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status IN ('starting', 'running'))::int AS active_count
       FROM evaluation_runs
       WHERE batch_id = $1`,
      [batchId]
    );
    const activeCount = countsResult.rows[0]?.active_count ?? 0;
    const slots = Math.max(0, Number(batch.concurrency) - activeCount);
    if (slots === 0) return;

    const pendingResult = await pool.query(
      `SELECT id
       FROM evaluation_runs
       WHERE batch_id = $1 AND status = 'pending'
       ORDER BY run_index ASC
       LIMIT $2`,
      [batchId, slots]
    );

    await Promise.all(pendingResult.rows.map((row) => this.startRun(row.id)));
  }

  private async startRun(runId: string): Promise<void> {
    const run = await fetchRunForStart(runId);
    if (!run?.session_id || !run.join_code) return;

    try {
      const phaseResult = await pool.query(
        `SELECT phase FROM game_sessions WHERE id = $1`,
        [run.session_id]
      );
      const phase = phaseResult.rows[0]?.phase;
      const io = gameLoopManager.getSocketIO();

      if (phase === 'WAITING') {
        await startGameSessionRuntime(io, run.session_id, run.join_code);
      } else {
        await restoreGameSessionRuntime(io, run.session_id, run.join_code);
      }

      await pool.query(
        `UPDATE evaluation_runs
         SET status = 'running', error = NULL
         WHERE id = $1`,
        [runId]
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await pool.query(
        `UPDATE evaluation_runs
         SET status = 'error',
             error = $1
         WHERE id = $2`,
        [message, runId]
      );
    }
  }

  private async monitorBatch(batchId: string): Promise<void> {
    const result = await pool.query(
      `SELECT r.id, r.session_id, r.join_code, r.status, s.phase
       FROM evaluation_runs r
       LEFT JOIN game_sessions s ON s.id = r.session_id
       WHERE r.batch_id = $1
       ORDER BY r.run_index ASC`,
      [batchId]
    );

    for (const run of result.rows) {
      if (!['starting', 'running'].includes(run.status)) continue;
      if (!run.session_id) {
        await pool.query(
          `UPDATE evaluation_runs SET status = 'error', error = 'Missing session' WHERE id = $1`,
          [run.id]
        );
        continue;
      }

      if (run.phase === 'FINISHED') {
        if (await areSessionBackgroundJobsIdle(run.session_id)) {
          await pool.query(
            `UPDATE evaluation_runs
             SET status = 'ready_for_judge',
                 ready_at = COALESCE(ready_at, CURRENT_TIMESTAMP),
                 error = NULL
             WHERE id = $1 AND status IN ('starting', 'running')`,
            [run.id]
          );
        }
      } else if (run.phase && run.phase !== 'WAITING') {
        const io = gameLoopManager.getSocketIO();
        await restoreGameSessionRuntime(io, run.session_id, run.join_code);
      }
    }

    await this.launchPendingRuns(batchId);
    await this.updateBatchCompletion(batchId);
  }

  private async updateBatchCompletion(batchId: string): Promise<void> {
    const result = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status IN ('pending', 'starting', 'running'))::int AS active_count,
         COUNT(*) FILTER (WHERE status = 'error')::int AS error_count
       FROM evaluation_runs
       WHERE batch_id = $1`,
      [batchId]
    );
    const activeCount = result.rows[0]?.active_count ?? 0;
    const errorCount = result.rows[0]?.error_count ?? 0;
    if (activeCount > 0) {
      await pool.query(
        `UPDATE evaluation_batches
         SET status = 'running',
             completed_at = NULL
         WHERE id = $1`,
        [batchId]
      );
      return;
    }

    await pool.query(
      `UPDATE evaluation_batches
       SET status = $1,
           completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP)
       WHERE id = $2`,
      [errorCount > 0 ? 'error' : 'completed', batchId]
    );
    this.stopMonitor(batchId);
  }

  private async buildTimeline(sessionId: string): Promise<string> {
    const result = await pool.query(
      `SELECT COALESCE(h.selected_headline, h.headline_text) AS text,
              h.in_game_submitted_at,
              h.created_at,
              p.nickname AS player_nickname
       FROM game_session_headlines h
       JOIN session_players p ON p.id = h.player_id
       WHERE h.session_id = $1
       ORDER BY COALESCE(h.in_game_submitted_at, h.created_at), h.created_at`,
      [sessionId]
    );

    const formatter = new Intl.DateTimeFormat('en-US', {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    });

    return result.rows
      .map((row) => {
        const date = row.in_game_submitted_at
          ? formatter.format(new Date(row.in_game_submitted_at))
          : formatter.format(new Date(row.created_at));
        return `[${date}] ${row.player_nickname} - ${row.text}`;
      })
      .join('\n');
  }

  private computeAggregate(runs: Array<{
    status: string;
    overallScore: number | null;
    dimensionScores: Record<string, number> | null;
    confidence: string | null;
    headlineCount: number;
    playerHeadlineCount: number;
    players: Array<{ nickname: string; isAi: boolean; totalScore: number }>;
    judgeResult: unknown;
  }>) {
    const judgedRuns = runs.filter((run) => run.status === 'judged' && run.overallScore !== null);
    const scores = judgedRuns.map((run) => Number(run.overallScore));
    const dimensionMeans: Record<string, number | null> = {};

    for (const key of DIMENSION_KEYS) {
      dimensionMeans[key] = roundMetric(mean(
        judgedRuns
          .map((run) => run.dimensionScores?.[key])
          .filter((value): value is number => typeof value === 'number')
      ));
    }

    const confidenceCounts = { low: 0, medium: 0, high: 0 };
    for (const run of judgedRuns) {
      if (run.confidence === 'low' || run.confidence === 'medium' || run.confidence === 'high') {
        confidenceCounts[run.confidence] += 1;
      }
    }

    const scoreByName = new Map<string, number[]>();
    for (const run of runs) {
      for (const player of run.players.filter((p) => p.isAi)) {
        const values = scoreByName.get(player.nickname) ?? [];
        values.push(player.totalScore);
        scoreByName.set(player.nickname, values);
      }
    }

    const aiScoreAverages = [...scoreByName.entries()].map(([nickname, values]) => ({
      nickname,
      runCount: values.length,
      meanTotalScore: roundMetric(mean(values)),
      maxTotalScore: values.length ? Math.max(...values) : null,
    }));

    const judgeObjects = judgedRuns
      .map((run) => run.judgeResult)
      .filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value));

    return {
      totalRuns: runs.length,
      judgedRuns: judgedRuns.length,
      readyRuns: runs.filter((run) => run.status === 'ready_for_judge').length,
      runningRuns: runs.filter((run) => ['pending', 'starting', 'running'].includes(run.status)).length,
      score: {
        mean: roundMetric(mean(scores)),
        median: roundMetric(median(scores)),
        stddev: roundMetric(stddev(scores)),
        min: scores.length ? Math.min(...scores) : null,
        max: scores.length ? Math.max(...scores) : null,
      },
      dimensionMeans,
      confidenceCounts,
      headlineCounts: {
        meanAll: roundMetric(mean(runs.map((run) => run.headlineCount))),
        meanPlayer: roundMetric(mean(runs.map((run) => run.playerHeadlineCount))),
      },
      aiScoreAverages,
      topWeaknesses: countStrings(judgeObjects.flatMap((result) => normalizeArray(result.top_weaknesses))),
      topRecommendations: countStrings(judgeObjects.flatMap((result) => normalizeArray(result.system_recommendations))),
      topStrengths: countStrings(judgeObjects.flatMap((result) => normalizeArray(result.top_strengths))),
    };
  }
}

export const evaluationCoordinator = new EvaluationCoordinator();
