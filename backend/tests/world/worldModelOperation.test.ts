import {
  buildWorldModelOperationInstructions,
  buildWorldModelOperationPrompt,
  worldModelOperationJsonSchema,
} from '../../src/prompts/worldModelOperationPrompt';
import {
  canOperationUpdateExistingPage,
  doesPlannedEntityMatchResolvedPage,
  isConcreteWorldPageCandidate,
  normalizeWorldPageName,
  WORLD_MODEL_OPERATION_LIMITS,
} from '../../src/world/worldModelOperationService';

const structuredSummary = `Description
Aurora Labs is a named research laboratory in the game world.

Changes
Recent Changes
It appeared in accepted timeline evidence.

Medium-Term Changes
It operates an orbital-computing program.

Long-Term Changes
It remains an independent laboratory.`;

describe('world-model operation planning guardrails', () => {
  it('normalizes case, punctuation, and spacing for alias idempotency', () => {
    expect(normalizeWorldPageName('  Open-AI, Inc.  ')).toBe('open ai inc');
    expect(normalizeWorldPageName('ＡＩ Lab')).toBe('ai lab');
  });

  it('accepts a concrete evidenced actor and rejects abstract or unsupported pages', () => {
    expect(
      isConcreteWorldPageCandidate({
        name: 'Aurora Labs',
        type: 'research laboratory',
        summary: structuredSummary,
        evidence: [
          'inferred world-model context needed to answer the entity query',
        ],
      })
    ).toBe(true);

    expect(
      isConcreteWorldPageCandidate({
        name: 'AI governance',
        type: 'topic',
        summary: structuredSummary,
        evidence: ['timeline'],
      })
    ).toBe(false);
    expect(
      isConcreteWorldPageCandidate({
        name: 'Aurora Labs',
        type: 'research laboratory',
        summary: structuredSummary,
        evidence: [],
      })
    ).toBe(false);
  });

  it('keeps established pages read-only for ANSWER operations', () => {
    expect(canOperationUpdateExistingPage('ANSWER')).toBe(false);
    expect(canOperationUpdateExistingPage('CREATE')).toBe(true);
    expect(canOperationUpdateExistingPage('UPDATE')).toBe(true);
    expect(canOperationUpdateExistingPage('INCORPORATE')).toBe(true);
  });

  it('requires a planner ID hint to agree with the page name or an alias', () => {
    const page = {
      name: 'OpenAI, Inc.',
      aliases: ['Open AI', 'OAI'],
    };

    expect(doesPlannedEntityMatchResolvedPage('openai inc', page)).toBe(true);
    expect(doesPlannedEntityMatchResolvedPage('OAI', page)).toBe(true);
    expect(doesPlannedEntityMatchResolvedPage('Apple', page)).toBe(false);
    expect(doesPlannedEntityMatchResolvedPage('', page)).toBe(false);
  });

  it('makes clear that a question is not evidence and requires optimistic revisions', () => {
    const instructions = buildWorldModelOperationInstructions();
    expect(instructions).toContain('NEVER evidence');
    expect(instructions).toContain('expectedRevisionNo');
    expect(instructions).toContain('Never create abstract topic pages');
    expect(instructions).toContain('ANSWER must never UPDATE');

    const prompt = buildWorldModelOperationPrompt({
      operation: 'ANSWER',
      query: 'Did Apple acquire OpenAI?',
      inGameNow: '2030-01-01T00:00:00.000Z',
      catalog: [],
      acceptedTimeline: [],
    });
    expect(prompt).toContain('Did Apple acquire OpenAI?');
    expect(prompt).toContain('Assess coverage first');
  });

  it('requires full-page edit and concurrency fields in the strict schema', () => {
    const entity = (worldModelOperationJsonSchema.schema.properties as any)
      .entities.items;
    expect(entity.required).toEqual(
      expect.arrayContaining([
        'action',
        'expectedRevisionNo',
        'summary',
        'summaryDelta',
        'evidence',
      ])
    );
    expect(WORLD_MODEL_OPERATION_LIMITS.maxQueuedCreationCandidates).toBe(50);
    expect(WORLD_MODEL_OPERATION_LIMITS.createPriorityThreshold).toBe(60);
  });
});
