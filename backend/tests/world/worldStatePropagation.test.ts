import {
  DEFAULT_WORLD_STATE_CONFIG,
  normalizeWorldStateConfig,
  PropagationLimiter,
} from '../../src/world/worldStateService';
import {
  buildEntityReactionPrompt,
  buildHeadlineWorldStateIntakePrompt,
  buildWorldStateInstructions,
  entityReactionJsonSchema,
  headlineWorldStateIntakeJsonSchema,
} from '../../src/world/worldStatePrompt';

describe('world-state propagation config', () => {
  it('defaults to cyclic graph propagation with bounded reactions', () => {
    expect(normalizeWorldStateConfig(undefined)).toEqual(DEFAULT_WORLD_STATE_CONFIG);
  });

  it('normalizes invalid numeric limits into safe bounds', () => {
    expect(normalizeWorldStateConfig({
      enabled: true,
      maxPropagationDepth: 99,
      maxNodeReactions: 999,
      maxEventsPerNode: 0,
      nodeAgentConcurrency: -1,
    })).toEqual({
      ...DEFAULT_WORLD_STATE_CONFIG,
      maxPropagationDepth: 8,
      maxNodeReactions: 200,
      maxEventsPerNode: 1,
      nodeAgentConcurrency: 1,
    });
  });
});

describe('PropagationLimiter', () => {
  const config = {
    ...DEFAULT_WORLD_STATE_CONFIG,
    maxPropagationDepth: 2,
    maxNodeReactions: 3,
    maxEventsPerNode: 2,
  };

  it('allows cyclic A -> B -> A events until operational depth caps stop them', () => {
    const limiter = new PropagationLimiter(config);

    expect(limiter.tryReserve({ sourceEventId: 'root', targetNodeId: 'A', depth: 0 })).toEqual({ allowed: true });
    expect(limiter.tryReserve({ sourceEventId: 'root', targetNodeId: 'B', depth: 1 })).toEqual({ allowed: true });
    expect(limiter.tryReserve({ sourceEventId: 'root', targetNodeId: 'A', depth: 2 })).toEqual({ allowed: true });
    expect(limiter.tryReserve({ sourceEventId: 'root', targetNodeId: 'B', depth: 3 })).toEqual({
      allowed: false,
      reason: 'max_depth',
    });
  });

  it('blocks duplicate source-event target-depth decisions', () => {
    const limiter = new PropagationLimiter(config);

    expect(limiter.tryReserve({ sourceEventId: 'root', targetNodeId: 'A', depth: 1 })).toEqual({ allowed: true });
    expect(limiter.tryReserve({ sourceEventId: 'root', targetNodeId: 'A', depth: 1 })).toEqual({
      allowed: false,
      reason: 'duplicate',
    });
  });

  it('caps repeated events per node and total reactions', () => {
    const limiter = new PropagationLimiter(config);

    expect(limiter.tryReserve({ sourceEventId: 'one', targetNodeId: 'A', depth: 0 })).toEqual({ allowed: true });
    expect(limiter.tryReserve({ sourceEventId: 'two', targetNodeId: 'A', depth: 1 })).toEqual({ allowed: true });
    expect(limiter.tryReserve({ sourceEventId: 'three', targetNodeId: 'A', depth: 2 })).toEqual({
      allowed: false,
      reason: 'max_events_per_node',
    });

    expect(limiter.tryReserve({ sourceEventId: 'one', targetNodeId: 'B', depth: 0 })).toEqual({ allowed: true });
    expect(limiter.tryReserve({ sourceEventId: 'two', targetNodeId: 'B', depth: 1 })).toEqual({
      allowed: false,
      reason: 'max_node_reactions',
    });
  });
});

describe('world-state prompts and schemas', () => {
  it('uses world graph terminology and allows cycles while rejecting self-edges', () => {
    const instructions = buildWorldStateInstructions();

    expect(instructions).toContain('directed cyclic world graph');
    expect(instructions).toContain('Directed cycles are allowed');
    expect(instructions).toContain('Self-edges are not useful');
    expect(instructions).not.toContain('directed acyclic graph');
  });

  it('splits headline intake from receiving entity reaction decisions', () => {
    const intakePrompt = buildHeadlineWorldStateIntakePrompt({
      headline: 'OpenAI launches a new treaty office after EU regulators tighten audit rules',
      storyDirection: 'OpenAI reacts to new EU oversight',
      playerNickname: 'tester',
      roundNo: 1,
      inGameSubmittedAt: null,
      nodes: [
        { name: 'OpenAI', type: 'company', summary: 'Builds frontier models.', timesUpdated: 1 },
        { name: 'EU regulators', type: 'government', summary: 'Regulates AI deployments.', timesUpdated: 1 },
      ],
      edges: [
        { source: 'EU regulators', target: 'OpenAI', relationType: 'REGULATES', summary: 'Sets compliance rules.' },
      ],
    });
    const reactionPrompt = buildEntityReactionPrompt({
      headline: 'OpenAI launches a new treaty office after EU regulators tighten audit rules',
      storyDirection: 'OpenAI reacts to new EU oversight',
      playerNickname: 'tester',
      roundNo: 1,
      inGameSubmittedAt: null,
      node: { name: 'OpenAI', type: 'company', summary: 'Builds frontier models.', timesUpdated: 1 },
      incomingEvent: {
        sourceNodeName: 'EU regulators',
        sourceEventId: 'root',
        eventSummary: 'EU regulators tightened audit rules.',
        evidence: 'Headline explicitly says audit rules tightened.',
        depth: 1,
      },
      relatedNodes: [
        {
          name: 'EU regulators',
          type: 'government',
          summary: 'Regulates AI deployments.',
          timesUpdated: 1,
          direction: 'incoming',
          relationType: 'REGULATES',
          relationSummary: 'Sets compliance rules.',
        },
      ],
      maxPropagationDepth: 2,
    });

    expect(intakePrompt).toContain('Do not decide downstream effects');
    expect(reactionPrompt).toContain('receiving entity');
    expect(reactionPrompt).toContain('cannot force this receiving entity to change');
    expect(headlineWorldStateIntakeJsonSchema.name).toBe('headline_world_state_intake');
    expect(entityReactionJsonSchema.name).toBe('entity_reaction');
  });
});
