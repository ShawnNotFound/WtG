import { parseJudgeResult } from '../../src/evaluation/evaluationService';
import { buildGameplayJudgePrompt } from '../../src/prompts/gameplayJudgePrompt';

const validJudgeJson = {
  overall_score: 82,
  grade_band: 'Strong gameplay',
  dimension_scores: {
    world_coherence: 17,
    interconnection: 12,
    plausibility: 13,
    actor_worldbuilding: 10,
    breadth_balance: 9,
    narrative_arc: 8,
    originality: 6,
    headline_craft: 7,
  },
  top_strengths: ['Strong callbacks'],
  top_weaknesses: ['Some vague actors'],
  system_recommendations: ['Reward concrete actors more'],
  confidence: 'high',
};

describe('evaluation judge parsing', () => {
  it('parses the required compact judge JSON', () => {
    const parsed = parseJudgeResult(validJudgeJson);

    expect(parsed.overall_score).toBe(82);
    expect(parsed.dimension_scores.world_coherence).toBe(17);
    expect(parsed.confidence).toBe('high');
    expect(parsed.system_recommendations).toEqual(['Reward concrete actors more']);
  });

  it('extracts JSON from a fenced model response', () => {
    const parsed = parseJudgeResult(`Here is the result:\n\n\`\`\`json\n${JSON.stringify(validJudgeJson)}\n\`\`\``);

    expect(parsed.overall_score).toBe(82);
  });

  it('rejects missing dimension scores', () => {
    expect(() => parseJudgeResult({ ...validJudgeJson, dimension_scores: {} })).toThrow(
      'dimension_scores.world_coherence must be numeric'
    );
  });
});

describe('gameplay judge prompt', () => {
  it('includes the timeline and required machine-readable JSON schema', () => {
    const prompt = buildGameplayJudgePrompt('[May 2028] AI Player 1 - OpenAI launches a civic model');

    expect(prompt).toContain('[May 2028] AI Player 1 - OpenAI launches a civic model');
    expect(prompt).toContain('"overall_score": number');
    expect(prompt).toContain('"dimension_scores"');
  });
});
