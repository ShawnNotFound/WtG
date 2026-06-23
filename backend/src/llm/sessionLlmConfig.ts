import pool from '../db/pool.js';
import { JsonModelSelection, normalizeJsonModelSelection } from './jsonModelClient.js';

export async function getSessionLlmSelection(sessionId: string): Promise<JsonModelSelection> {
  const result = await pool.query(
    `SELECT llm_config FROM game_sessions WHERE id = $1`,
    [sessionId]
  );

  return normalizeJsonModelSelection(result.rows[0]?.llm_config);
}
