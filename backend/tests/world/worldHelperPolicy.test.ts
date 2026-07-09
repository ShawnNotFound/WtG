import {
  buildWorldHelperPolicyBoundaryAnswer,
  isWorldHelperPlayAdviceRequest,
} from '../../src/world/worldHelperService';
import { buildAiWorldHelperQuestion } from '../../src/ai/aiPlayerService';
import { WorldHelperPromptContext } from '../../src/prompts/worldHelperPrompt';

function makeContext(question = 'What headline should I write?'): WorldHelperPromptContext {
  return {
    question,
    session: {
      joinCode: 'ABC123',
      phase: 'PLAYING',
      currentRound: 2,
      maxRounds: 4,
      inGameNow: '2030-01-01T00:00:00.000Z',
    },
    leaderboard: [],
    currentPlayer: null,
    planetUsage: [],
    headlines: [],
    entities: [],
    edges: [],
    graphStatus: {
      available: false,
      nodeCount: 0,
      edgeCount: 0,
      runningJobs: 0,
    },
    recentPrivateHistory: [],
  };
}

describe('World Helper gameplay policy', () => {
  it('blocks requests for playable headline ideas and score optimization', () => {
    expect(isWorldHelperPlayAdviceRequest('What headline should I write to maximize score?')).toBe(true);
    expect(isWorldHelperPlayAdviceRequest('Generate a sample headline that connects to three players.')).toBe(true);
    expect(isWorldHelperPlayAdviceRequest('Which planet should I target next?')).toBe(true);
  });

  it('allows informational world-state and rules questions', () => {
    expect(isWorldHelperPlayAdviceRequest('How do connection points work?')).toBe(false);
    expect(isWorldHelperPlayAdviceRequest('How do I score connection points?')).toBe(false);
    expect(isWorldHelperPlayAdviceRequest('What changed around OpenAI in the world graph?')).toBe(false);
    expect(isWorldHelperPlayAdviceRequest('Which timeline headlines mention Google?')).toBe(false);
  });

  it('returns an instruction-level boundary answer without citations', () => {
    const answer = buildWorldHelperPolicyBoundaryAnswer(makeContext());

    expect(answer.answerText).toContain('cannot choose your next play');
    expect(answer.answerText).toContain('instruction-level guidance');
    expect(answer.headlineRefs).toEqual([]);
    expect(answer.entityRefs).toEqual([]);
    expect(answer.edgeRefs).toEqual([]);
    expect(answer.confidence).toBe('high');
  });

  it('keeps AI player helper questions neutral', () => {
    const question = buildAiWorldHelperQuestion({
      nickname: 'AI Player 1',
      config: {
        stylePrompt: '',
        creativity: 1,
        submitEverySeconds: 0,
        helperActivity: 1,
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
      },
      inGameNow: '2030-01-01T00:00:00.000Z',
      currentRound: 2,
      maxRounds: 4,
      planetPanel: [
        { id: 'EARTH', usage: 1, band: 2 },
        { id: 'MARS', usage: 4, band: 0 },
      ],
      headlines: [
        {
          text: 'OpenAI signs a chip audit pact with EU regulators',
          playerNickname: 'Alice',
          roundNo: 1,
          inGameSubmittedAt: '2029-01-01T00:00:00.000Z',
          planets: ['MERCURY', 'JUPITER'],
          totalScore: 8,
        },
      ],
    });

    expect(question).toContain('neutral world-state briefing');
    expect(question).toContain('Boundary: no playable guidance');
    expect(isWorldHelperPlayAdviceRequest(question)).toBe(false);
  });
});
