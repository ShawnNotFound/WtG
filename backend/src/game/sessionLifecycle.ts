import { Server } from 'socket.io';
import pool from '../db/pool.js';
import { aiPlayerManager } from '../ai/aiPlayerManager.js';
import { worldStateProcessor } from '../world/worldStateService.js';
import { gameLoopManager } from './gameLoop.js';
import { initialGlobalUsage, randomOrdinals } from './planetUsage.js';
import { DEFAULT_PLANETS } from './scoringTypes.js';

export async function startGameSessionRuntime(
  io: Server,
  sessionId: string,
  joinCode: string,
  playerIds?: string[]
): Promise<void> {
  await pool.query(
    `UPDATE game_sessions
     SET planet_usage_global = $1
     WHERE id = $2 AND (planet_usage_global = '{}' OR planet_usage_global IS NULL)`,
    [JSON.stringify(initialGlobalUsage(DEFAULT_PLANETS)), sessionId]
  );

  let resolvedPlayerIds = playerIds;
  if (!resolvedPlayerIds) {
    const playerResult = await pool.query(
      `SELECT id
       FROM session_players
       WHERE session_id = $1 AND is_system = FALSE
       ORDER BY joined_at ASC`,
      [sessionId]
    );
    resolvedPlayerIds = playerResult.rows.map((player) => player.id);
  }

  for (const playerId of resolvedPlayerIds) {
    await pool.query(
      `UPDATE session_players
       SET planet_usage_state = $1
       WHERE id = $2 AND (planet_usage_state = '{}' OR planet_usage_state IS NULL)`,
      [JSON.stringify(randomOrdinals(DEFAULT_PLANETS)), playerId]
    );
  }

  const archiveResult = await pool.query(
    `INSERT INTO session_players (session_id, nickname, is_host, is_system, planet_usage_state)
     VALUES ($1, 'Archive', false, true, '{}')
     RETURNING id`,
    [sessionId]
  );
  const archivePlayerId = archiveResult.rows[0].id;

  await gameLoopManager.handleHostStartGame(sessionId, joinCode, archivePlayerId);
  aiPlayerManager.startSession(io, sessionId, joinCode);
  worldStateProcessor.enqueueInitialBuild(sessionId).catch((error) => {
    console.error(`[WorldState ${joinCode}] Initial graph enqueue failed:`, error);
  });
}

export async function restoreGameSessionRuntime(
  io: Server,
  sessionId: string,
  joinCode: string
): Promise<void> {
  const loop = await gameLoopManager.ensureLoopForSession(sessionId, joinCode);
  const state = loop.getState();

  if (state.phase !== 'WAITING' && state.phase !== 'FINISHED') {
    await loop.resumeGame();
    aiPlayerManager.startSession(io, sessionId, joinCode);
  }
}
