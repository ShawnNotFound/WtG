import { NextFunction, Request, Response, Router } from 'express';
import { z, ZodError } from 'zod';
import pool from '../db/pool.js';
import { normalizeAiPlayerConfig } from '../ai/aiPlayerService.js';
import { aiPlayerManager } from '../ai/aiPlayerManager.js';
import { gameLoopManager } from '../game/gameLoop.js';
import { getPlayerScoreBreakdowns } from '../game/scoringService.js';
import { normalizeJsonModelSelection } from '../llm/jsonModelClient.js';
import { normalizeModuleLlmConfig } from '../llm/sessionLlmConfig.js';
import {
  aiPlayerConfigSchema,
  joinCodeSchema,
  llmConfigSchema,
  moduleLlmConfigSchema,
  nicknameSchema,
  sessionTitleSchema,
  summaryConfigSchema,
  worldStateConfigSchema,
} from '../utils/validation.js';
import { getWorldStateForJoinCode, worldStateProcessor } from '../world/worldStateService.js';
import { getWorldHelperAdminHistory } from '../world/worldHelperService.js';
import { normalizeWorldNodeSummary } from '../world/worldNodeDetail.js';
import { updateWorldModelWithHelper } from '../world/worldModelOperationService.js';
import { computeChangeVelocity, computeTextChangeMagnitude } from '../world/worldPagePriority.js';
import { lockWorldModelSession } from '../world/worldMutationLock.js';
import evaluationsRouter from './evaluations.js';

const router = Router();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'password';

const adminConfigSchema = z.object({
  title: sessionTitleSchema.optional(),
  playMinutes: z.number().min(0.1).max(120).optional(),
  breakMinutes: z.number().min(0).max(60).optional(),
  maxRounds: z.number().int().min(1).max(20).optional(),
  timelineSpeedRatio: z.number().min(0).max(100000).optional(),
  worldStateEnabled: z.boolean().optional(),
  worldStateConfig: worldStateConfigSchema.optional(),
  summaryConfig: summaryConfigSchema.optional(),
  llmConfig: llmConfigSchema.optional(),
  moduleLlmConfig: moduleLlmConfigSchema.optional(),
  aiPlayers: z
    .array(
      z.object({
        id: z.string().uuid(),
        nickname: nicknameSchema.optional(),
        aiConfig: aiPlayerConfigSchema.optional(),
      })
    )
    .max(16)
    .optional(),
});

const nodePatchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  type: z.string().min(1).max(80).optional(),
  summary: z.string().max(1200).optional(),
  attributes: z.record(z.unknown()).optional(),
  timesUpdated: z.number().int().min(0).optional(),
});

const worldModelOperationSchema = z.object({
  operation: z.enum(['CREATE', 'UPDATE', 'ANSWER', 'INCORPORATE']).default('UPDATE'),
  query: z
    .string()
    .min(1, 'Query or steer cannot be empty')
    .max(2000, 'Query or steer must be at most 2000 characters')
    .transform((value) => value.trim()),
  effectiveAt: z.string().datetime({ offset: true }).optional(),
});

function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const password =
    req.header('x-admin-password') ??
    (typeof req.query.password === 'string' ? req.query.password : undefined) ??
    (typeof req.body?.password === 'string' ? req.body.password : undefined);

  if (password !== ADMIN_PASSWORD) {
    res.status(401).json({ error: 'Admin password required' });
    return;
  }

  next();
}

function validationError(res: Response, error: unknown): boolean {
  if (error instanceof ZodError) {
    res.status(400).json({ error: 'Validation failed', details: error.errors });
    return true;
  }
  return false;
}

router.use(requireAdmin);
router.use('/evaluations', evaluationsRouter);

router.get('/sessions', async (req: Request, res: Response): Promise<void> => {
  try {
    const includeArchived = req.query.includeArchived === 'true';
    const result = await pool.query(
      `SELECT
         s.id,
         s.title,
         s.join_code,
         s.phase,
         s.is_paused,
         s.current_round,
         s.archived_at,
         s.created_at,
         COUNT(p.id)::int AS player_count
       FROM game_sessions s
       LEFT JOIN session_players p ON p.session_id = s.id AND p.is_system = FALSE
       WHERE ($1::boolean OR s.archived_at IS NULL)
       GROUP BY s.id
       ORDER BY
         CASE WHEN s.archived_at IS NULL THEN 0 ELSE 1 END,
         s.created_at DESC
       LIMIT 80`,
      [includeArchived]
    );

    res.json({
      sessions: result.rows.map((row) => ({
        id: row.id,
        title: row.title,
        joinCode: row.join_code,
        phase: row.phase,
        isPaused: row.is_paused === true,
        currentRound: row.current_round,
        playerCount: row.player_count,
        archivedAt: row.archived_at,
        createdAt: row.created_at,
      })),
    });
  } catch (error) {
    console.error('Admin sessions failed:', error);
    res.status(500).json({ error: 'Failed to list sessions' });
  }
});

async function getSessionForAdminAction(joinCode: string) {
  const result = await pool.query(
    `SELECT id, title, join_code, phase, archived_at
     FROM game_sessions
     WHERE join_code = $1`,
    [joinCode]
  );
  return result.rows[0] ?? null;
}

router.post('/sessions/:joinCode/archive', async (req: Request, res: Response): Promise<void> => {
  try {
    const joinCode = joinCodeSchema.parse(req.params.joinCode.toUpperCase());
    const session = await getSessionForAdminAction(joinCode);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    gameLoopManager.stopLoop(session.id);
    aiPlayerManager.stopSession(session.id);
    await pool.query(
      `UPDATE game_sessions
       SET archived_at = COALESCE(archived_at, CURRENT_TIMESTAMP),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [session.id]
    );

    const state = await getWorldStateForJoinCode(joinCode);
    res.json(state);
  } catch (error) {
    if (validationError(res, error)) return;
    console.error('Admin archive failed:', error);
    res.status(500).json({ error: 'Failed to archive session' });
  }
});

router.post('/sessions/:joinCode/unarchive', async (req: Request, res: Response): Promise<void> => {
  try {
    const joinCode = joinCodeSchema.parse(req.params.joinCode.toUpperCase());
    const session = await getSessionForAdminAction(joinCode);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    await pool.query(
      `UPDATE game_sessions
       SET archived_at = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [session.id]
    );

    const state = await getWorldStateForJoinCode(joinCode);
    res.json(state);
  } catch (error) {
    if (validationError(res, error)) return;
    console.error('Admin unarchive failed:', error);
    res.status(500).json({ error: 'Failed to unarchive session' });
  }
});

router.delete('/sessions/:joinCode', async (req: Request, res: Response): Promise<void> => {
  try {
    const joinCode = joinCodeSchema.parse(req.params.joinCode.toUpperCase());
    const session = await getSessionForAdminAction(joinCode);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    gameLoopManager.stopLoop(session.id);
    aiPlayerManager.stopSession(session.id);
    await pool.query(`UPDATE game_sessions SET host_player_id = NULL WHERE id = $1`, [session.id]);
    await pool.query(`DELETE FROM game_sessions WHERE id = $1`, [session.id]);
    res.json({ success: true, deletedJoinCode: joinCode });
  } catch (error) {
    if (validationError(res, error)) return;
    console.error('Admin delete failed:', error);
    res.status(500).json({ error: 'Failed to delete session' });
  }
});

router.post('/sessions/:joinCode/pause', async (req: Request, res: Response): Promise<void> => {
  try {
    const joinCode = joinCodeSchema.parse(req.params.joinCode.toUpperCase());
    const session = await getSessionForAdminAction(joinCode);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    await gameLoopManager.pauseSession(session.id, session.join_code);
    const state = await getWorldStateForJoinCode(joinCode);
    res.json(state);
  } catch (error) {
    if (validationError(res, error)) return;
    console.error('Admin pause failed:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to pause game' });
  }
});

router.post('/sessions/:joinCode/resume', async (req: Request, res: Response): Promise<void> => {
  try {
    const joinCode = joinCodeSchema.parse(req.params.joinCode.toUpperCase());
    const session = await getSessionForAdminAction(joinCode);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    await gameLoopManager.resumeSession(session.id, session.join_code);
    const state = await getWorldStateForJoinCode(joinCode);
    res.json(state);
  } catch (error) {
    if (validationError(res, error)) return;
    console.error('Admin resume failed:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to resume game' });
  }
});

router.get('/sessions/:joinCode/world-state', async (req: Request, res: Response): Promise<void> => {
  try {
    const joinCode = joinCodeSchema.parse(req.params.joinCode.toUpperCase());
    const state = await getWorldStateForJoinCode(joinCode);
    if (!state) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    res.json(state);
  } catch (error) {
    if (validationError(res, error)) return;
    console.error('Admin world-state fetch failed:', error);
    res.status(500).json({ error: 'Failed to fetch world state' });
  }
});

router.get('/sessions/:joinCode/world-helper/messages', async (req: Request, res: Response): Promise<void> => {
  try {
    const joinCode = joinCodeSchema.parse(req.params.joinCode.toUpperCase());
    const playerId = typeof req.query.playerId === 'string' && req.query.playerId
      ? z.string().uuid().parse(req.query.playerId)
      : undefined;

    const sessionResult = await pool.query(
      `SELECT id FROM game_sessions WHERE join_code = $1`,
      [joinCode]
    );
    if (sessionResult.rows.length === 0) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const messages = await getWorldHelperAdminHistory(sessionResult.rows[0].id, playerId);
    res.json({ messages });
  } catch (error) {
    if (validationError(res, error)) return;
    console.error('Admin world helper history fetch failed:', error);
    res.status(500).json({ error: 'Failed to fetch world helper history' });
  }
});

router.get('/sessions/:joinCode/summary', async (req: Request, res: Response): Promise<void> => {
  try {
    const joinCode = joinCodeSchema.parse(req.params.joinCode.toUpperCase());
    const sessionResult = await pool.query(
      `SELECT id, title, join_code, phase, current_round, max_rounds, play_minutes, created_at
       FROM game_sessions
       WHERE join_code = $1`,
      [joinCode]
    );

    if (sessionResult.rows.length === 0) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const session = sessionResult.rows[0];
    const scoreBreakdowns = await getPlayerScoreBreakdowns(session.id);

    const playersResult = await pool.query(
      `SELECT id, nickname, is_host, is_ai, ai_config, joined_at, total_score
       FROM session_players
       WHERE session_id = $1 AND is_system = FALSE
       ORDER BY total_score DESC, joined_at ASC`,
      [session.id]
    );

    const headlinesResult = await pool.query(
      `SELECT
         h.id,
         h.session_id,
         h.player_id,
         p.nickname as player_nickname,
         h.round_no,
         h.headline_text as story_direction,
         COALESCE(h.selected_headline, h.headline_text) as text,
         h.dice_roll,
         h.selected_band,
         h.plausibility_level,
         h.planet_1,
         h.planet_2,
         h.planet_3,
         h.band1_headline,
         h.band2_headline,
         h.band3_headline,
         h.band4_headline,
         h.band5_headline,
         h.baseline_score,
         h.plausibility_score,
         h.others_story_score,
         h.planet_bonus_score,
         h.total_headline_score,
         h.created_at,
         h.in_game_submitted_at
       FROM game_session_headlines h
       JOIN session_players p ON h.player_id = p.id
       WHERE h.session_id = $1
       ORDER BY h.created_at ASC`,
      [session.id]
    );

    const summaryResult = await pool.query(
      `SELECT status, summary_data, error_message
       FROM round_summaries
       WHERE session_id = $1
         AND round_no = $2
         AND summary_type = 'narrative'
       LIMIT 1`,
      [session.id, session.max_rounds]
    );
    const summaryRow = summaryResult.rows[0];

    res.json({
      session: {
        id: session.id,
        title: session.title,
        joinCode: session.join_code,
        phase: session.phase,
        currentRound: session.current_round,
        maxRounds: session.max_rounds,
        playMinutes: Number(session.play_minutes),
        createdAt: session.created_at,
      },
      players: playersResult.rows.map((row) => ({
        id: row.id,
        nickname: row.nickname,
        isHost: row.is_host === true,
        isAi: row.is_ai === true,
        aiConfig: row.ai_config ?? undefined,
        joinedAt: new Date(row.joined_at).toISOString(),
        totalScore: row.total_score ?? 0,
        scoreBreakdown: scoreBreakdowns.get(row.id) ?? {
          baseline: 0,
          plausibility: 0,
          connection: 0,
          planetBonus: 0,
        },
      })),
      headlines: headlinesResult.rows.map((row) => ({
        id: row.id,
        sessionId: row.session_id,
        playerId: row.player_id,
        playerNickname: row.player_nickname,
        roundNo: row.round_no,
        storyDirection: row.story_direction,
        text: row.text,
        diceRoll: row.dice_roll,
        selectedBand: row.selected_band,
        plausibilityBand: row.plausibility_level,
        planets: [row.planet_1, row.planet_2, row.planet_3].filter(Boolean),
        allBands: row.band1_headline ? {
          band1: row.band1_headline,
          band2: row.band2_headline,
          band3: row.band3_headline,
          band4: row.band4_headline,
          band5: row.band5_headline,
        } : null,
        baselineScore: row.baseline_score ?? null,
        plausibilityScore: row.plausibility_score ?? null,
        connectionScore: row.others_story_score ?? null,
        planetBonusScore: row.planet_bonus_score ?? null,
        totalScore: row.total_headline_score ?? null,
        createdAt: new Date(row.created_at).toISOString(),
        inGameSubmittedAt: row.in_game_submitted_at
          ? new Date(row.in_game_submitted_at).toISOString()
          : null,
      })),
      finalSummary: summaryRow
        ? {
            status: summaryRow.status,
            summary: summaryRow.status === 'completed' ? summaryRow.summary_data : null,
            error: summaryRow.error_message,
          }
        : {
            status: 'error',
            summary: null,
            error: 'No final summary has been generated for this session.',
          },
    });
  } catch (error) {
    if (validationError(res, error)) return;
    console.error('Admin summary fetch failed:', error);
    res.status(500).json({ error: 'Failed to fetch game summary' });
  }
});

router.post('/sessions/:joinCode/world-state/rebuild', async (req: Request, res: Response): Promise<void> => {
  try {
    const joinCode = joinCodeSchema.parse(req.params.joinCode.toUpperCase());
    const jobId = await worldStateProcessor.resetAndEnqueueInitialBuild(joinCode);
    if (!jobId) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    res.status(202).json({ jobId });
  } catch (error) {
    if (validationError(res, error)) return;
    console.error('Admin world-state rebuild failed:', error);
    res.status(500).json({ error: 'Failed to rebuild world state' });
  }
});

/**
 * Explicit future-Wikipedia operation. Player questions use the same service
 * automatically through Socket.IO, but manual shared-world mutations remain
 * admin-only because player IDs are not authentication tokens in this app.
 */
router.post('/sessions/:joinCode/world-state/helper-update', async (req: Request, res: Response): Promise<void> => {
  try {
    const joinCode = joinCodeSchema.parse(req.params.joinCode.toUpperCase());
    const parsed = worldModelOperationSchema.parse(req.body);
    const session = await getSessionForAdminAction(joinCode);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const result = await updateWorldModelWithHelper({
      sessionId: session.id,
      query: parsed.query,
      operation: parsed.operation,
      source: 'admin',
      effectiveAt: parsed.effectiveAt,
    });
    if (result.status === 'error') {
      res.status(502).json(result);
      return;
    }
    res.json(result);
  } catch (error) {
    if (validationError(res, error)) return;
    console.error('Admin world-model helper update failed:', error);
    res.status(500).json({ error: 'Failed to update world model' });
  }
});

router.get('/sessions/:joinCode/world-state/pages/:nodeId/revisions', async (req: Request, res: Response): Promise<void> => {
  try {
    const joinCode = joinCodeSchema.parse(req.params.joinCode.toUpperCase());
    const nodeId = z.string().uuid().parse(req.params.nodeId);
    const result = await pool.query(
      `SELECT
         r.id,
         r.node_id,
         n.name AS node_name,
         r.revision_no,
         r.operation,
         r.source_kind,
         r.source_headline_id,
         r.source_helper_message_id,
         r.effective_at,
         r.page_name,
         r.page_type,
         r.page_attributes,
         r.page_aliases,
         r.before_summary,
         r.after_summary,
         r.summary_delta,
         r.rationale,
         r.evidence,
         r.confidence,
         r.change_magnitude,
         r.model,
         r.usage,
         r.created_at
       FROM world_state_page_revisions r
       JOIN world_state_nodes n ON n.id = r.node_id
       JOIN game_sessions s ON s.id = r.session_id
       WHERE s.join_code = $1 AND r.node_id = $2
       ORDER BY r.revision_no ASC`,
      [joinCode, nodeId]
    );
    if (result.rows.length === 0) {
      const node = await pool.query(
        `SELECT 1
         FROM world_state_nodes n
         JOIN game_sessions s ON s.id = n.session_id
         WHERE s.join_code = $1 AND n.id = $2`,
        [joinCode, nodeId]
      );
      if (node.rows.length === 0) {
        res.status(404).json({ error: 'Page not found' });
        return;
      }
    }
    res.json({ revisions: result.rows });
  } catch (error) {
    if (validationError(res, error)) return;
    console.error('Admin world page revisions fetch failed:', error);
    res.status(500).json({ error: 'Failed to fetch page revisions' });
  }
});

router.get('/sessions/:joinCode/world-state/pages-as-of', async (req: Request, res: Response): Promise<void> => {
  try {
    const joinCode = joinCodeSchema.parse(req.params.joinCode.toUpperCase());
    const at = req.query.at === undefined
      ? new Date().toISOString()
      : z.string().datetime({ offset: true }).parse(req.query.at);
    const session = await getSessionForAdminAction(joinCode);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    const result = await pool.query(
      `SELECT DISTINCT ON (r.node_id)
         r.node_id,
         r.page_name,
         r.page_type,
         r.page_attributes,
         r.page_aliases,
         r.after_summary,
         r.revision_no,
         r.operation,
         r.effective_at,
         r.confidence,
         r.rationale,
         r.evidence
       FROM world_state_page_revisions r
       WHERE r.session_id = $1 AND r.effective_at <= $2::timestamptz
       ORDER BY r.node_id, r.effective_at DESC, r.revision_no DESC`,
      [session.id, at]
    );
    res.json({
      sessionId: session.id,
      joinCode,
      asOf: new Date(at).toISOString(),
      pages: result.rows.map((row) => ({
        id: row.node_id,
        name: row.page_name,
        type: row.page_type,
        attributes: row.page_attributes,
        aliases: row.page_aliases,
        summary: row.after_summary,
        revisionNo: row.revision_no,
        operation: row.operation,
        effectiveAt: row.effective_at,
        confidence: Number(row.confidence ?? 0),
        rationale: row.rationale,
        evidence: row.evidence,
      })),
    });
  } catch (error) {
    if (validationError(res, error)) return;
    console.error('Admin world pages as-of fetch failed:', error);
    res.status(500).json({ error: 'Failed to fetch world pages as of date' });
  }
});

router.patch('/sessions/:joinCode/config', async (req: Request, res: Response): Promise<void> => {
  try {
    const joinCode = joinCodeSchema.parse(req.params.joinCode.toUpperCase());
    const parsed = adminConfigSchema.parse(req.body);

    const sessionResult = await pool.query(
      `SELECT id, world_state_config, summary_config
       FROM game_sessions
       WHERE join_code = $1`,
      [joinCode]
    );

    if (sessionResult.rows.length === 0) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const session = sessionResult.rows[0];
    const updates: string[] = [];
    const values: unknown[] = [];

    const addUpdate = (sql: string, value: unknown) => {
      values.push(value);
      updates.push(`${sql} = $${values.length}`);
    };

    if (parsed.title !== undefined) addUpdate('title', parsed.title);
    if (parsed.playMinutes !== undefined) addUpdate('play_minutes', parsed.playMinutes);
    if (parsed.breakMinutes !== undefined) addUpdate('break_minutes', parsed.breakMinutes);
    if (parsed.maxRounds !== undefined) addUpdate('max_rounds', parsed.maxRounds);
    if (parsed.timelineSpeedRatio !== undefined) addUpdate('timeline_speed_ratio', parsed.timelineSpeedRatio);
    if (parsed.llmConfig !== undefined) {
      addUpdate('llm_config', JSON.stringify(normalizeJsonModelSelection(parsed.llmConfig)));
    }
    if (parsed.moduleLlmConfig !== undefined) {
      addUpdate('module_llm_config', JSON.stringify(normalizeModuleLlmConfig(parsed.moduleLlmConfig)));
    }
    if (parsed.summaryConfig !== undefined) {
      const existingSummaryConfig =
        session.summary_config && typeof session.summary_config === 'object'
          ? session.summary_config
          : {};
      addUpdate('summary_config', JSON.stringify({
        ...existingSummaryConfig,
        ...parsed.summaryConfig,
      }));
    }
    if (parsed.worldStateEnabled !== undefined || parsed.worldStateConfig !== undefined) {
      const existingWorldConfig =
        session.world_state_config && typeof session.world_state_config === 'object'
          ? session.world_state_config
          : {};
      const nextWorldConfig = {
        ...existingWorldConfig,
        ...(parsed.worldStateConfig ?? {}),
        ...(parsed.worldStateEnabled !== undefined ? { enabled: parsed.worldStateEnabled } : {}),
      };
      addUpdate(
        'world_state_config',
        JSON.stringify(nextWorldConfig)
      );
    }

    if (updates.length > 0) {
      values.push(session.id);
      await pool.query(
        `UPDATE game_sessions
         SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP
         WHERE id = $${values.length}`,
        values
      );
    }

    for (const aiPlayer of parsed.aiPlayers ?? []) {
      const existing = await pool.query(
        `SELECT nickname, ai_config
         FROM session_players
         WHERE id = $1 AND session_id = $2 AND is_ai = TRUE`,
        [aiPlayer.id, session.id]
      );
      if (existing.rows.length === 0) continue;

      const nextConfig = aiPlayer.aiConfig
        ? normalizeAiPlayerConfig({
            ...normalizeAiPlayerConfig(existing.rows[0].ai_config),
            ...aiPlayer.aiConfig,
          })
        : normalizeAiPlayerConfig(existing.rows[0].ai_config);

      await pool.query(
        `UPDATE session_players
         SET nickname = $1,
             ai_config = $2
         WHERE id = $3 AND session_id = $4 AND is_ai = TRUE`,
        [
          aiPlayer.nickname ?? existing.rows[0].nickname,
          JSON.stringify(nextConfig),
          aiPlayer.id,
          session.id,
        ]
      );
    }

    const state = await getWorldStateForJoinCode(joinCode);
    res.json(state);
  } catch (error) {
    if (validationError(res, error)) return;
    console.error('Admin config update failed:', error);
    res.status(500).json({ error: 'Failed to update config' });
  }
});

router.patch('/sessions/:joinCode/world-state/nodes/:nodeId', async (req: Request, res: Response): Promise<void> => {
  try {
    const joinCode = joinCodeSchema.parse(req.params.joinCode.toUpperCase());
    const nodeId = z.string().uuid().parse(req.params.nodeId);
    const parsed = nodePatchSchema.parse(req.body);

    const sessionResult = await pool.query(
      `SELECT id FROM game_sessions WHERE join_code = $1`,
      [joinCode]
    );
    if (sessionResult.rows.length === 0) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const updates: string[] = [];
    const values: unknown[] = [];
    const addUpdate = (sql: string, value: unknown) => {
      values.push(value);
      updates.push(`${sql} = $${values.length}`);
    };

    if (parsed.name !== undefined) addUpdate('name', parsed.name.trim());
    if (parsed.type !== undefined) addUpdate('type', parsed.type.trim());
    if (parsed.summary !== undefined) addUpdate('summary', normalizeWorldNodeSummary(parsed.summary.trim()));
    if (parsed.attributes !== undefined) addUpdate('attributes', JSON.stringify(parsed.attributes));
    if (parsed.timesUpdated !== undefined) addUpdate('times_updated', parsed.timesUpdated);

    if (updates.length === 0) {
      res.status(400).json({ error: 'No node changes provided' });
      return;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await lockWorldModelSession(client, sessionResult.rows[0].id);
      const beforeResult = await client.query(
        `SELECT id, name, type, summary, attributes, aliases, revision_no,
                change_velocity, last_content_update_at
         FROM world_state_nodes
         WHERE id = $1 AND session_id = $2
         FOR UPDATE`,
        [nodeId, sessionResult.rows[0].id]
      );
      if (beforeResult.rows.length === 0) {
        await client.query('ROLLBACK');
        res.status(404).json({ error: 'Node not found' });
        return;
      }
      const before = beforeResult.rows[0];
      const nextSummary = parsed.summary !== undefined
        ? normalizeWorldNodeSummary(parsed.summary.trim(), parsed.name?.trim() || before.name)
        : before.summary;
      const textMagnitude = computeTextChangeMagnitude(before.summary, nextSummary);
      const metadataChanged = Object.keys(parsed).some((key) => key !== 'summary');
      const magnitude = Math.max(textMagnitude, metadataChanged ? 0.05 : 0);
      const elapsedDays = Math.max(
        0,
        (Date.now() - new Date(before.last_content_update_at).getTime()) / (24 * 60 * 60 * 1000)
      );
      const velocity = computeChangeVelocity(Number(before.change_velocity ?? 0), magnitude, elapsedDays);

      values.push(magnitude, velocity, nodeId, sessionResult.rows[0].id);
      const result = await client.query(
        `UPDATE world_state_nodes
         SET ${updates.join(', ')},
             revision_no = revision_no + 1,
             last_content_update_at = CURRENT_TIMESTAMP,
             consultations_since_update = 0,
             last_change_magnitude = $${values.length - 3},
             change_velocity = $${values.length - 2}
         WHERE id = $${values.length - 1} AND session_id = $${values.length}
         RETURNING id, name, type, summary, attributes, aliases, revision_no`,
        values
      );

      const after = result.rows[0];
      if (after.name !== before.name) {
        for (const alias of [before.name, after.name]) {
          await client.query(
            `INSERT INTO world_state_node_aliases (session_id, node_id, alias, normalized_alias)
             VALUES ($1, $2, $3, trim(lower(regexp_replace(trim($3), '[^[:alnum:]]+', ' ', 'g'))))
             ON CONFLICT (session_id, normalized_alias) DO NOTHING`,
            [sessionResult.rows[0].id, nodeId, alias]
          );
        }
        const aliasesResult = await client.query(
          `UPDATE world_state_nodes n
           SET aliases = COALESCE((
             SELECT jsonb_agg(a.alias ORDER BY a.alias)
             FROM world_state_node_aliases a
             WHERE a.node_id = n.id
               AND a.normalized_alias <> trim(lower(regexp_replace(trim(n.name), '[^[:alnum:]]+', ' ', 'g')))
           ), '[]'::jsonb)
           WHERE n.id = $1
           RETURNING aliases`,
          [nodeId]
        );
        after.aliases = aliasesResult.rows[0]?.aliases ?? after.aliases;
      }
      await client.query(
        `INSERT INTO world_state_page_revisions (
           session_id, node_id, revision_no, operation, source_kind,
           effective_at, page_name, page_type, page_attributes, page_aliases,
           before_summary, after_summary, summary_delta, rationale,
           evidence, confidence, change_magnitude
         )
         VALUES (
           $1, $2, $3, 'UPDATE', 'admin',
           GREATEST(
             CURRENT_TIMESTAMP,
             COALESCE((
               SELECT MAX(effective_at) FROM world_state_page_revisions WHERE node_id = $2
             ), '-infinity'::timestamptz)
           ),
           $4, $5, $6, $7, $8, $9, $10, $11, '[]'::jsonb, 1, $12
         )`,
        [
          sessionResult.rows[0].id,
          nodeId,
          after.revision_no,
          after.name,
          after.type,
          JSON.stringify(after.attributes ?? {}),
          JSON.stringify(after.aliases ?? []),
          before.summary,
          after.summary,
          `Admin changed page fields: ${Object.keys(parsed).join(', ')}.`,
          'Direct admin page edit.',
          magnitude,
        ]
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    const state = await getWorldStateForJoinCode(joinCode);
    res.json(state);
  } catch (error) {
    if (validationError(res, error)) return;
    console.error('Admin node update failed:', error);
    res.status(500).json({ error: 'Failed to update node' });
  }
});

export default router;
