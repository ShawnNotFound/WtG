import {
  AskWorldHelperParams,
  prepareWorldModelForHelperQuestion,
} from '../../src/world/worldHelperService';
import { updateWorldModelWithHelper } from '../../src/world/worldModelOperationService';

jest.mock('../../src/world/worldModelOperationService', () => ({
  updateWorldModelWithHelper: jest.fn(),
}));

function params(
  patch: Partial<AskWorldHelperParams> = {}
): AskWorldHelperParams {
  return {
    sessionId: 'session-1',
    joinCode: 'ABC123',
    playerId: 'player-1',
    question: 'Who is Aurora Labs?',
    ...patch,
  };
}

describe('World Helper automatic page coverage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('runs ANSWER coverage before a factual player question is answered', async () => {
    const update = {
      status: 'not_needed',
      operation: 'ANSWER',
      coverage: 'SUFFICIENT',
    };
    (updateWorldModelWithHelper as jest.Mock).mockResolvedValue(update);

    await expect(
      prepareWorldModelForHelperQuestion(params(), 'message-1')
    ).resolves.toBe(update);
    expect(updateWorldModelWithHelper).toHaveBeenCalledWith({
      sessionId: 'session-1',
      query: 'Who is Aurora Labs?',
      operation: 'ANSWER',
      helperMessageId: 'message-1',
      source: 'helper',
    });
  });

  it('does not let prohibited play-advice prompts mutate the shared world', async () => {
    await expect(
      prepareWorldModelForHelperQuestion(
        params({
          question: 'Write my next headline to maximize score.',
        }),
        'message-2'
      )
    ).resolves.toBeNull();
    expect(updateWorldModelWithHelper).not.toHaveBeenCalled();
  });

  it('keeps broad AI-player briefings read-only', async () => {
    await expect(
      prepareWorldModelForHelperQuestion(
        params({
          allowWorldMutation: false,
        }),
        'message-3'
      )
    ).resolves.toBeNull();
    expect(updateWorldModelWithHelper).not.toHaveBeenCalled();
  });

  it('continues toward an answer when preparation itself throws', async () => {
    const warn = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    (updateWorldModelWithHelper as jest.Mock).mockRejectedValueOnce(
      new Error('temporary planner failure')
    );

    await expect(
      prepareWorldModelForHelperQuestion(params(), 'message-4')
    ).resolves.toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
