import { Router, Request, Response } from 'express';
import pool from '../db/pool.js';
import { generateUniqueJoinCode } from '../utils/joinCode.js';
import {
  createSessionSchema,
  joinSessionSchema,
  joinCodeSchema,
  aiPlayerConfigSchema,
} from '../utils/validation.js';
import { ZodError } from 'zod';
import { DEFAULT_PLANETS } from '../game/scoringTypes.js';
import { randomOrdinals } from '../game/planetUsage.js';
import { DEFAULT_AI_PLAYER_CONFIG, normalizeAiPlayerConfig } from '../ai/aiPlayerService.js';
import { normalizeJsonModelSelection } from '../llm/jsonModelClient.js';
import { normalizeModuleLlmConfig } from '../llm/sessionLlmConfig.js';
import { normalizeWorldStateConfig } from '../world/worldStateService.js';

const router = Router();

async function verifyHostWaitingSession(joinCode: string, hostPlayerId: string) {
  const result = await pool.query(
    `SELECT id, host_player_id, status
     FROM game_sessions
     WHERE join_code = $1`,
    [joinCode]
  );

  if (result.rows.length === 0) {
    return { errorStatus: 404, error: 'Session not found' } as const;
  }

  const session = result.rows[0];
  if (session.host_player_id !== hostPlayerId) {
    return { errorStatus: 403, error: 'Only the host can manage AI players' } as const;
  }

  if (session.status !== 'WAITING') {
    return { errorStatus: 400, error: 'AI players can only be changed before the game starts' } as const;
  }

  return { session } as const;
}

/**
 * POST /api/sessions
 * create a new game session with a host player
 */
router.post('/sessions', async (req: Request, res: Response): Promise<void> => {
  try {
    const {
      hostNickname,
      aiPlayers = [],
      llmConfig,
      moduleLlmConfig,
      summaryConfig,
      worldStateConfig,
      playMinutes,
      breakMinutes,
      maxRounds,
      timelineSpeedRatio,
    } = createSessionSchema.parse(req.body);
    const normalizedLlmConfig = normalizeJsonModelSelection(llmConfig);
    const normalizedModuleLlmConfig = normalizeModuleLlmConfig(moduleLlmConfig);
    const normalizedWorldStateConfig = normalizeWorldStateConfig(worldStateConfig);
    const normalizedSummaryConfig = {
      roundSummaries: summaryConfig?.roundSummaries !== false,
      finalNarrative: summaryConfig?.finalNarrative !== false,
    };

    const joinCode = await generateUniqueJoinCode();

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // create session with game configuration
      const sessionResult = await client.query(
        `INSERT INTO game_sessions (
          join_code,
          status,
          play_minutes,
          break_minutes,
          max_rounds,
          timeline_speed_ratio,
          llm_config,
          module_llm_config,
          world_state_config,
          summary_config
        )
         VALUES ($1, 'WAITING', $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id, join_code, status, llm_config, module_llm_config, world_state_config, summary_config, created_at, updated_at`,
        [
          joinCode,
          playMinutes ?? 8,
          breakMinutes ?? 3,
          maxRounds ?? 4,
          timelineSpeedRatio ?? 60.0,
          JSON.stringify(normalizedLlmConfig),
          JSON.stringify(normalizedModuleLlmConfig),
          JSON.stringify(normalizedWorldStateConfig),
          JSON.stringify(normalizedSummaryConfig),
        ]
      );
      const session = sessionResult.rows[0];

      const playerResult = await client.query(
        `INSERT INTO session_players (session_id, nickname, is_host)
         VALUES ($1, $2, true)
         RETURNING id, nickname, is_host, joined_at`,
        [session.id, hostNickname]
      );
      const hostPlayer = playerResult.rows[0];

      // update session with host_player_id
      await client.query(
        `UPDATE game_sessions SET host_player_id = $1 WHERE id = $2`,
        [hostPlayer.id, session.id]
      );

      for (const [index, aiPlayer] of aiPlayers.entries()) {
        const config = normalizeAiPlayerConfig({
          ...DEFAULT_AI_PLAYER_CONFIG,
          stylePrompt: aiPlayer.stylePrompt ?? DEFAULT_AI_PLAYER_CONFIG.stylePrompt,
          creativity: aiPlayer.creativity ?? DEFAULT_AI_PLAYER_CONFIG.creativity,
          submitEverySeconds: aiPlayer.submitEverySeconds ?? DEFAULT_AI_PLAYER_CONFIG.submitEverySeconds,
          provider: aiPlayer.provider ?? DEFAULT_AI_PLAYER_CONFIG.provider,
          model: aiPlayer.model,
        });

        await client.query(
          `INSERT INTO session_players
            (session_id, nickname, is_host, is_ai, ai_config, planet_usage_state)
           VALUES ($1, $2, false, true, $3, $4)`,
          [
            session.id,
            aiPlayer.nickname ?? `AI Player ${index + 1}`,
            JSON.stringify(config),
            JSON.stringify(randomOrdinals(DEFAULT_PLANETS)),
          ]
        );
      }

      await client.query('COMMIT');

      res.status(201).json({
        session: {
          id: session.id,
          joinCode: session.join_code,
          status: session.status,
          llmConfig: session.llm_config,
          moduleLlmConfig: session.module_llm_config,
          worldStateConfig: session.world_state_config,
          summaryConfig: session.summary_config,
          createdAt: session.created_at,
        },
        player: {
          id: hostPlayer.id,
          nickname: hostPlayer.nickname,
          isHost: hostPlayer.is_host,
          joinedAt: hostPlayer.joined_at,
        },
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (error) {
    if (error instanceof ZodError) {
      res.status(400).json({
        error: 'Validation failed',
        details: error.errors,
      });
      return;
    }
    if ((error as any)?.code === '23505') {
      res.status(409).json({ error: 'Nickname already taken' });
      return;
    }
    console.error('Error creating session:', error);
    res.status(500).json({ error: 'Failed to create session' });
  }
});

/**
 * POST /api/sessions/:joinCode/join
 * join an existing session as a player
 */
router.post('/sessions/:joinCode/join', async (req: Request, res: Response): Promise<void> => {
  try {
    const joinCode = joinCodeSchema.parse(req.params.joinCode.toUpperCase());

    const { nickname } = joinSessionSchema.parse(req.body);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // check if session exists
      const sessionResult = await client.query(
        `SELECT id, join_code, status FROM game_sessions WHERE join_code = $1`,
        [joinCode]
      );

      if (sessionResult.rows.length === 0) {
        await client.query('ROLLBACK');
        res.status(404).json({ error: 'Session not found' });
        return;
      }

      const session = sessionResult.rows[0];

      // check if session is in WAITING state
      if (session.status !== 'WAITING') {
        await client.query('ROLLBACK');
        res.status(400).json({
          error: 'Cannot join session',
          message: 'Session has already started or finished',
        });
        return;
      }

      // check if nickname is already taken in this session
      const nicknameCheck = await client.query(
        `SELECT 1 FROM session_players
         WHERE session_id = $1 AND nickname = $2`,
        [session.id, nickname]
      );

      if (nicknameCheck.rows.length > 0) {
        await client.query('ROLLBACK');
        res.status(409).json({
          error: 'Nickname already taken',
          message: 'Please choose a different nickname',
        });
        return;
      }

      const playerResult = await client.query(
        `INSERT INTO session_players (session_id, nickname, is_host)
         VALUES ($1, $2, false)
         RETURNING id, nickname, is_host, joined_at`,
        [session.id, nickname]
      );
      const player = playerResult.rows[0];

      await client.query('COMMIT');

      res.status(201).json({
        session: {
          id: session.id,
          joinCode: session.join_code,
          status: session.status,
        },
        player: {
          id: player.id,
          nickname: player.nickname,
          isHost: player.is_host,
          joinedAt: player.joined_at,
        },
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (error) {
    if (error instanceof ZodError) {
      res.status(400).json({
        error: 'Validation failed',
        details: error.errors,
      });
      return;
    }
    console.error('Error joining session:', error);
    res.status(500).json({ error: 'Failed to join session' });
  }
});

/**
 * POST /api/sessions/:joinCode/rejoin
 * recover an existing player's identity by nickname, regardless of game phase.
 * used when a player loses localStorage (new device/browser).
 */
router.post('/sessions/:joinCode/rejoin', async (req: Request, res: Response): Promise<void> => {
  try {
    const joinCode = joinCodeSchema.parse(req.params.joinCode.toUpperCase());
    const { nickname } = joinSessionSchema.parse(req.body);

    const client = await pool.connect();
    try {
      const result = await client.query(
        `SELECT sp.id, sp.nickname, sp.is_host
         FROM session_players sp
         JOIN game_sessions gs ON gs.id = sp.session_id
         WHERE gs.join_code = $1 AND LOWER(sp.nickname) = LOWER($2)`,
        [joinCode, nickname]
      );

      if (result.rows.length === 0) {
        res.status(404).json({ error: 'Player not found', message: 'No player with that nickname in this session' });
        return;
      }

      const player = result.rows[0];
      res.json({
        player: { id: player.id, nickname: player.nickname, isHost: player.is_host },
      });
    } finally {
      client.release();
    }
  } catch (error) {
    if (error instanceof ZodError) {
      res.status(400).json({ error: 'Validation failed', details: (error as ZodError).errors });
      return;
    }
    console.error('Error rejoining session:', error);
    res.status(500).json({ error: 'Failed to rejoin session' });
  }
});

/**
 * POST /api/sessions/:joinCode/ai-players
 * add a configurable demo AI player before the game starts
 */
router.post('/sessions/:joinCode/ai-players', async (req: Request, res: Response): Promise<void> => {
  try {
    const joinCode = joinCodeSchema.parse(req.params.joinCode.toUpperCase());
    const hostPlayerId = String(req.body.hostPlayerId ?? '');
    const parsed = aiPlayerConfigSchema.parse(req.body);
    const verified = await verifyHostWaitingSession(joinCode, hostPlayerId);

    if ('error' in verified) {
      res.status(Number(verified.errorStatus)).json({ error: verified.error });
      return;
    }

    const countResult = await pool.query(
      `SELECT COUNT(*)::int as count
       FROM session_players
       WHERE session_id = $1 AND is_ai = TRUE`,
      [verified.session.id]
    );
    const nextNumber = (countResult.rows[0]?.count ?? 0) + 1;
    const nickname = parsed.nickname ?? `AI Player ${nextNumber}`;
    const config = normalizeAiPlayerConfig({
      ...DEFAULT_AI_PLAYER_CONFIG,
      stylePrompt: parsed.stylePrompt ?? DEFAULT_AI_PLAYER_CONFIG.stylePrompt,
      creativity: parsed.creativity ?? DEFAULT_AI_PLAYER_CONFIG.creativity,
      submitEverySeconds: parsed.submitEverySeconds ?? DEFAULT_AI_PLAYER_CONFIG.submitEverySeconds,
      provider: parsed.provider ?? DEFAULT_AI_PLAYER_CONFIG.provider,
      model: parsed.model,
    });

    const playerResult = await pool.query(
      `INSERT INTO session_players
        (session_id, nickname, is_host, is_ai, ai_config, planet_usage_state)
       VALUES ($1, $2, false, true, $3, $4)
       RETURNING id, nickname, is_host, is_ai, ai_config, joined_at`,
      [
        verified.session.id,
        nickname,
        JSON.stringify(config),
        JSON.stringify(randomOrdinals(DEFAULT_PLANETS)),
      ]
    );

    const player = playerResult.rows[0];
    res.status(201).json({
      player: {
        id: player.id,
        nickname: player.nickname,
        isHost: player.is_host,
        isAi: player.is_ai,
        aiConfig: player.ai_config,
        joinedAt: player.joined_at,
      },
    });
  } catch (error: any) {
    if (error instanceof ZodError) {
      res.status(400).json({ error: 'Validation failed', details: error.errors });
      return;
    }
    if (error?.code === '23505') {
      res.status(409).json({ error: 'Nickname already taken' });
      return;
    }
    console.error('Error adding AI player:', error);
    res.status(500).json({ error: 'Failed to add AI player' });
  }
});

/**
 * PATCH /api/sessions/:joinCode/ai-players/:playerId
 * update one AI player's nickname/style/creativity before the game starts
 */
router.patch('/sessions/:joinCode/ai-players/:playerId', async (req: Request, res: Response): Promise<void> => {
  try {
    const joinCode = joinCodeSchema.parse(req.params.joinCode.toUpperCase());
    const playerId = String(req.params.playerId);
    const hostPlayerId = String(req.body.hostPlayerId ?? '');
    const parsed = aiPlayerConfigSchema.parse(req.body);
    const verified = await verifyHostWaitingSession(joinCode, hostPlayerId);

    if ('error' in verified) {
      res.status(Number(verified.errorStatus)).json({ error: verified.error });
      return;
    }

    const existing = await pool.query(
      `SELECT nickname, ai_config
       FROM session_players
       WHERE id = $1 AND session_id = $2 AND is_ai = TRUE`,
      [playerId, verified.session.id]
    );
    if (existing.rows.length === 0) {
      res.status(404).json({ error: 'AI player not found' });
      return;
    }

    const currentConfig = normalizeAiPlayerConfig(existing.rows[0].ai_config);
    const nextConfig = normalizeAiPlayerConfig({
      ...currentConfig,
      stylePrompt: parsed.stylePrompt ?? currentConfig.stylePrompt,
      creativity: parsed.creativity ?? currentConfig.creativity,
      submitEverySeconds: parsed.submitEverySeconds ?? currentConfig.submitEverySeconds,
      provider: parsed.provider ?? currentConfig.provider,
      model: parsed.model ?? currentConfig.model,
    });
    const nickname = parsed.nickname ?? existing.rows[0].nickname;

    const result = await pool.query(
      `UPDATE session_players
       SET nickname = $1, ai_config = $2
       WHERE id = $3 AND session_id = $4 AND is_ai = TRUE
       RETURNING id, nickname, is_host, is_ai, ai_config, joined_at`,
      [nickname, JSON.stringify(nextConfig), playerId, verified.session.id]
    );
    const player = result.rows[0];

    res.json({
      player: {
        id: player.id,
        nickname: player.nickname,
        isHost: player.is_host,
        isAi: player.is_ai,
        aiConfig: player.ai_config,
        joinedAt: player.joined_at,
      },
    });
  } catch (error: any) {
    if (error instanceof ZodError) {
      res.status(400).json({ error: 'Validation failed', details: error.errors });
      return;
    }
    if (error?.code === '23505') {
      res.status(409).json({ error: 'Nickname already taken' });
      return;
    }
    console.error('Error updating AI player:', error);
    res.status(500).json({ error: 'Failed to update AI player' });
  }
});

/**
 * DELETE /api/sessions/:joinCode/ai-players/:playerId
 * remove one AI player before the game starts
 */
router.delete('/sessions/:joinCode/ai-players/:playerId', async (req: Request, res: Response): Promise<void> => {
  try {
    const joinCode = joinCodeSchema.parse(req.params.joinCode.toUpperCase());
    const playerId = String(req.params.playerId);
    const hostPlayerId = String(req.body.hostPlayerId ?? req.query.hostPlayerId ?? '');
    const verified = await verifyHostWaitingSession(joinCode, hostPlayerId);

    if ('error' in verified) {
      res.status(Number(verified.errorStatus)).json({ error: verified.error });
      return;
    }

    const result = await pool.query(
      `DELETE FROM session_players
       WHERE id = $1 AND session_id = $2 AND is_ai = TRUE
       RETURNING id`,
      [playerId, verified.session.id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'AI player not found' });
      return;
    }

    res.json({ success: true });
  } catch (error) {
    if (error instanceof ZodError) {
      res.status(400).json({ error: 'Validation failed', details: error.errors });
      return;
    }
    console.error('Error removing AI player:', error);
    res.status(500).json({ error: 'Failed to remove AI player' });
  }
});

/**
 * GET /api/sessions/:joinCode
 * get session details including all players
 */
router.get('/sessions/:joinCode', async (req: Request, res: Response): Promise<void> => {
  try {
    const joinCode = joinCodeSchema.parse(req.params.joinCode.toUpperCase());

    // get session with players
    const result = await pool.query(
      `SELECT 
        s.id,
        s.join_code,
        s.status,
        s.host_player_id,
        s.llm_config,
        s.module_llm_config,
        s.world_state_config,
        s.summary_config,
        s.created_at,
        s.updated_at,
        json_agg(
          json_build_object(
            'id', p.id,
            'nickname', p.nickname,
            'isHost', p.is_host,
            'isAi', p.is_ai,
            'aiConfig', p.ai_config,
            'joinedAt', p.joined_at
          ) ORDER BY p.joined_at
        ) as players
      FROM game_sessions s
      LEFT JOIN session_players p ON s.id = p.session_id
      WHERE s.join_code = $1
      GROUP BY s.id`,
      [joinCode]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const session = result.rows[0];

    res.json({
      id: session.id,
      joinCode: session.join_code,
      status: session.status,
      hostPlayerId: session.host_player_id,
      llmConfig: session.llm_config,
      moduleLlmConfig: session.module_llm_config,
      worldStateConfig: session.world_state_config,
      summaryConfig: session.summary_config,
      createdAt: session.created_at,
      updatedAt: session.updated_at,
      players: session.players.filter((p: any) => p.id !== null), // filter out null players from left join
    });
  } catch (error) {
    if (error instanceof ZodError) {
      res.status(400).json({
        error: 'Invalid join code format',
        details: error.errors,
      });
      return;
    }
    console.error('Error fetching session:', error);
    res.status(500).json({ error: 'Failed to fetch session' });
  }
});

export default router;

