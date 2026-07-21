import { PoolClient } from 'pg';

/** Serialize page/alias/connection mutations for one game world. */
export async function lockWorldModelSession(
  client: PoolClient,
  sessionId: string
): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
    sessionId,
  ]);
}
