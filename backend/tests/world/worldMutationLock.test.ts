import { PoolClient } from 'pg';
import { lockWorldModelSession } from '../../src/world/worldMutationLock';

describe('world-model mutation lock', () => {
  it('uses the shared session-scoped transaction advisory lock', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const client = { query } as unknown as PoolClient;

    await lockWorldModelSession(client, 'session-1');

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('pg_advisory_xact_lock(hashtextextended($1, 0))'),
      ['session-1']
    );
  });
});
