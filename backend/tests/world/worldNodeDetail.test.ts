import {
  formatWorldNodeSummary,
  mergeWorldNodeSummary,
  normalizeWorldNodeSummary,
  parseWorldNodeSummary,
} from '../../src/world/worldNodeDetail';

describe('world node detail formatting', () => {
  it('wraps legacy summaries into a structured Description and Changes layout', () => {
    const normalized = normalizeWorldNodeSummary('OpenAI builds frontier AI systems.');
    const parsed = parseWorldNodeSummary(normalized);

    expect(parsed.description).toBe('OpenAI builds frontier AI systems.');
    expect(parsed.changes.recent).toBe('None recorded.');
    expect(normalized).toContain('Description');
    expect(normalized).toContain('Recent Changes');
    expect(normalized).toContain('Medium-Term Changes');
    expect(normalized).toContain('Long-Term Changes');
  });

  it('preserves existing descriptions when merging an unstructured update', () => {
    const existing = formatWorldNodeSummary({
      description: 'OpenAI is a frontier AI lab and product operator.',
      changes: {
        recent: 'Earlier partnership with chip auditors.',
        mediumTerm: 'Growing compliance operations.',
        longTerm: 'Central platform actor in AI deployment.',
      },
    });

    const merged = parseWorldNodeSummary(mergeWorldNodeSummary(existing, 'Signed a new EU model audit pact.'));

    expect(merged.description).toBe('OpenAI is a frontier AI lab and product operator.');
    expect(merged.changes.recent).toBe('Signed a new EU model audit pact.');
    expect(merged.changes.mediumTerm).toBe('Growing compliance operations.');
    expect(merged.changes.longTerm).toBe('Central platform actor in AI deployment.');
  });

  it('accepts full structured updates while keeping the prior description stable', () => {
    const existing = formatWorldNodeSummary({
      description: 'ChatGPT is a consumer AI assistant platform.',
      changes: {
        recent: 'Usage rose after a school pilot.',
        mediumTerm: '',
        longTerm: '',
      },
    });
    const incoming = formatWorldNodeSummary({
      description: 'ChatGPT is now described differently.',
      changes: {
        recent: 'New enterprise controls were announced.',
        mediumTerm: 'Schools increasingly treat it as infrastructure.',
        longTerm: '',
      },
    });

    const merged = parseWorldNodeSummary(mergeWorldNodeSummary(existing, incoming));

    expect(merged.description).toBe('ChatGPT is a consumer AI assistant platform.');
    expect(merged.changes.recent).toBe('New enterprise controls were announced.');
    expect(merged.changes.mediumTerm).toBe('Schools increasingly treat it as infrastructure.');
  });
});
