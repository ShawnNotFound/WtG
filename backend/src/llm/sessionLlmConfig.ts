import pool from '../db/pool.js';
import { JsonModelSelection, normalizeJsonModelSelection } from './jsonModelClient.js';

export type LlmModuleName = 'juror' | 'world' | 'summary' | 'helper';

export function normalizeModuleLlmConfig(raw: unknown): Partial<Record<LlmModuleName, JsonModelSelection>> {
  const source = raw && typeof raw === 'object'
    ? raw as Partial<Record<LlmModuleName, unknown>>
    : {};
  const result: Partial<Record<LlmModuleName, JsonModelSelection>> = {};

  for (const moduleName of ['juror', 'world', 'summary', 'helper'] as const) {
    const value = source[moduleName];
    if (value && typeof value === 'object') {
      result[moduleName] = normalizeJsonModelSelection(value);
    }
  }

  return result;
}

export async function getSessionLlmSelection(
  sessionId: string,
  moduleName?: LlmModuleName
): Promise<JsonModelSelection> {
  const result = await pool.query(
    `SELECT llm_config, module_llm_config FROM game_sessions WHERE id = $1`,
    [sessionId]
  );

  const row = result.rows[0] ?? {};
  const shared = normalizeJsonModelSelection(row.llm_config);
  if (!moduleName) {
    return shared;
  }

  const modules = normalizeModuleLlmConfig(row.module_llm_config);
  return modules[moduleName] ?? shared;
}
