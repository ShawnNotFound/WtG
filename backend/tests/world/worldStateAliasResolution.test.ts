import { PoolClient } from 'pg';
import {
  normalizeWorldNodeLookupName,
  resolveExistingNodeByName,
  upsertNode,
} from '../../src/world/worldStateService';
import { normalizeWorldNodeSummary } from '../../src/world/worldNodeDetail';

function mockClient(query: jest.Mock): PoolClient {
  return { query } as unknown as PoolClient;
}

describe('headline world-state alias resolution', () => {
  it('normalizes punctuation, compatibility width, case, and spacing', () => {
    expect(normalizeWorldNodeLookupName('  Open-AI, Inc.  ')).toBe(
      'open ai inc'
    );
    expect(normalizeWorldNodeLookupName('ＡＩ   Lab')).toBe('ai lab');
  });

  it('resolves normalized aliases and returns the stored canonical name', async () => {
    const query = jest.fn().mockResolvedValue({
      rows: [{ id: 'node-openai', name: 'OpenAI' }],
    });

    const result = await resolveExistingNodeByName(
      mockClient(query),
      'session-1',
      'Open AI'
    );

    expect(result).toEqual({ id: 'node-openai', name: 'OpenAI' });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('FROM world_state_node_aliases alias'),
      ['session-1', 'Open AI', 'open ai']
    );
  });

  it('updates an alias-matched page without replacing its canonical name or inserting a duplicate', async () => {
    const summary = normalizeWorldNodeSummary(
      'OpenAI is a frontier AI laboratory and product company.',
      'OpenAI'
    );
    const query = jest.fn(async (sql: string, _params?: unknown[]) => {
      if (sql.includes('SELECT node.id, node.name, node.type')) {
        return {
          rows: [
            {
              id: 'node-openai',
              name: 'OpenAI',
              type: 'company',
              attributes: {},
              aliases: ['Open AI'],
              summary,
              revision_no: 2,
              change_velocity: 0.2,
              last_content_update_at: new Date().toISOString(),
            },
          ],
        };
      }
      if (sql.includes('SET aliases = COALESCE')) {
        return { rows: [{ aliases: ['Open AI'] }] };
      }
      return { rows: [] };
    });

    const result = await upsertNode(
      mockClient(query),
      'session-1',
      {
        name: 'Open AI',
        type: 'company',
        summary,
        attributes: [],
      },
      'headline-1',
      1
    );

    expect(result).toMatchObject({
      id: 'node-openai',
      name: 'OpenAI',
      created: false,
    });

    const nodeUpdate = query.mock.calls.find(([sql]) =>
      sql.includes('UPDATE world_state_nodes\n       SET name = $1')
    );
    expect(nodeUpdate?.[1]?.[0]).toBe('OpenAI');
    expect(
      query.mock.calls.some(([sql]) =>
        sql.includes('INSERT INTO world_state_nodes\n')
      )
    ).toBe(false);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO world_state_node_aliases'),
      ['session-1', 'node-openai', 'Open AI', 'open ai']
    );
  });
});
