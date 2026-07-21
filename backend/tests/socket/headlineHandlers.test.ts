/**
 * Tests for headline submission and feed Socket.IO handlers
 */

import { Server, Socket } from 'socket.io';
import pool from '../../src/db/pool';
import { setupLobbyHandlers, clearSessionRateLimits } from '../../src/socket/lobbyHandlers';
import { SEED_HEADLINES } from '../../src/game/seedHeadlines';

// Mock dependencies
jest.mock('../../src/db/pool', () => ({
  __esModule: true,
  default: {
    query: jest.fn(),
    connect: jest.fn(),
  },
}));

jest.mock('../../src/game/gameLoop', () => ({
  gameLoopManager: {
    handleHostStartGame: jest.fn(),
  },
}));

jest.mock('../../src/game/headlineTransformationService', () => ({
  transformHeadline: jest.fn().mockResolvedValue({
    plausibility: { band: 3, label: 'plausible', rationale: 'Test' },
    planets: {
      top3: [
        { id: 'MARS', rank: 1, rationale: 'Test' },
        { id: 'VENUS', rank: 2, rationale: 'Test' },
        { id: 'EARTH', rank: 3, rationale: 'Test' },
      ],
    },
    linked: [
      { headline: 'H1', strength: 'STRONG', rationale: 'Test' },
      { headline: 'H2', strength: 'WEAK', rationale: 'Test' },
      { headline: 'H3', strength: 'STRONG', rationale: 'Test' },
    ],
    allBands: {
      band1: 'Inevitable headline',
      band2: 'Probable headline',
      band3: 'Plausible headline',
      band4: 'Possible headline',
      band5: 'Preposterous headline',
    },
    diceRoll: 50,
    selectedBand: 3,
    selectedHeadline: 'Plausible headline',
    model: 'gpt-5.2',
    usage: { inputTokens: 100, outputTokens: 200 },
    llmRequest: { storyDirection: 'Test', headlinesList: [], planetList: [], instructions: 'Test' },
    llmResponse: '{"test": "response"}',
  }),
}));

jest.mock('../../src/game/planets', () => ({
  getDefaultPlanets: jest.fn().mockReturnValue([
    { id: 'MARS', description: 'Technology' },
    { id: 'VENUS', description: 'Society' },
    { id: 'EARTH', description: 'Environment' },
  ]),
}));

jest.mock('../../src/game/scoringService', () => ({
  applyHeadlineEvaluation: jest.fn().mockResolvedValue({
    breakdown: {
      baseline: 1,
      plausibility: 2,
      selfStory: 0,
      othersStory: 0,
      connectionScore: 9,
      planetBonus: 2,
      total: 14,
    },
    newTotalScore: 14,
    leaderboard: [
      { playerId: 'player-1', nickname: 'Alice', totalScore: 53, rank: 1 },
    ],
  }),
  getPlayerScoreBreakdowns: jest.fn().mockResolvedValue(
    new Map([
      ['player-1', { baseline: 0, plausibility: 0, connection: 0, planetBonus: 0 }],
      ['player-2', { baseline: 0, plausibility: 0, connection: 0, planetBonus: 0 }],
    ])
  ),
}));

describe('Headline Handlers', () => {
  let mockIO: Partial<Server>;
  let mockSocket: Partial<Socket>;
  let submitHandler: any;
  let getFeedHandler: any;

  const createMockSessionData = (overrides: Record<string, any> = {}) => {
    const now = new Date();
    return {
      id: 'session-123',
      join_code: 'ABC123',
      status: 'PLAYING',
      host_player_id: 'player-1',
      phase: 'PLAYING',
      current_round: 2,
      play_minutes: 15,
      break_minutes: 5,
      max_rounds: 3,
      phase_started_at: now,
      phase_ends_at: new Date(now.getTime() + 15 * 60 * 1000),
      in_game_start_at: now,
      timeline_speed_ratio: 60.0,
      server_now: now,
      players: [
        { id: 'player-1', nickname: 'Alice', isHost: true, joinedAt: now.toISOString(), totalScore: 0, planetUsageState: null },
        { id: 'player-2', nickname: 'Bob', isHost: false, joinedAt: now.toISOString(), totalScore: 0, planetUsageState: null },
      ],
      ...overrides,
    };
  };

  beforeEach(() => {
    jest.clearAllMocks();
    clearSessionRateLimits('session-123');

    // Create mock Socket.IO instances
    const handlers: Record<string, any> = {};

    mockSocket = {
      id: 'socket-123',
      data: { playerId: 'player-1', joinCode: 'ABC123' },
      on: jest.fn((event, handler) => {
        handlers[event] = handler;
        return mockSocket as Socket;
      }),
      to: jest.fn().mockReturnThis(),
      emit: jest.fn(),
      join: jest.fn().mockResolvedValue(undefined),
      leave: jest.fn().mockResolvedValue(undefined),
    } as Partial<Socket>;

    const mockToEmit = jest.fn();
    mockIO = {
      on: jest.fn((event, handler) => {
        if (event === 'connection') {
          handler(mockSocket);
        }
        return mockIO as Server;
      }),
      to: jest.fn().mockReturnValue({ emit: mockToEmit }),
      emit: jest.fn(),
    } as Partial<Server>;

    // Setup handlers
    setupLobbyHandlers(mockIO as Server);

    // Extract handlers for testing
    const socketOnCalls = (mockSocket.on as jest.Mock).mock.calls;
    submitHandler = socketOnCalls.find(([event]) => event === 'headline:submit')?.[1];
    getFeedHandler = socketOnCalls.find(([event]) => event === 'headline:get_feed')?.[1];
  });

  describe('headline:submit', () => {
    it('should accept a valid headline during PLAYING phase', async () => {
      const mockSession = createMockSessionData();
      const insertedRow = {
        id: 'headline-1',
        created_at: new Date(),
      };

      (pool.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [mockSession] }) // getSessionState
        .mockResolvedValueOnce({ rows: [] }) // fetch existing headlines for LLM context
        .mockResolvedValueOnce({ rows: [insertedRow] }); // INSERT headline

      const callback = jest.fn();
      await submitHandler({ joinCode: 'ABC123', headline: 'Breaking: AI achieves consciousness!' }, callback);

      expect(callback).toHaveBeenCalledWith({
        success: true,
        headline: expect.objectContaining({
          id: 'headline-1',
          playerId: 'player-1',
          playerNickname: 'Alice',
          roundNo: 2,
          storyDirection: 'Breaking: AI achieves consciousness!',
          text: 'Plausible headline', // From the mocked transformHeadline
          diceRoll: 50,
          selectedBand: 3,
        }),
        cooldownMs: 90000,
      });

      // Verify broadcast was called
      expect(mockIO.to).toHaveBeenCalledWith('session:ABC123');

      // the juror context fetch is windowed to the most recent N headlines (= seed count)
      const fetchCall = (pool.query as jest.Mock).mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('ORDER BY created_at DESC')
      );
      expect(fetchCall).toBeDefined();
      expect(fetchCall![1][1]).toBe(SEED_HEADLINES.length);
    });

    it('should reject when headline is empty', async () => {
      const callback = jest.fn();
      await submitHandler({ joinCode: 'ABC123', headline: '' }, callback);

      expect(callback).toHaveBeenCalledWith({
        success: false,
        error: expect.stringContaining('empty'),
      });
    });

    it('should reject when headline is too long', async () => {
      const longHeadline = 'A'.repeat(300);
      const callback = jest.fn();
      await submitHandler({ joinCode: 'ABC123', headline: longHeadline }, callback);

      expect(callback).toHaveBeenCalledWith({
        success: false,
        error: expect.stringContaining('280'),
      });
    });

    it('should reject when session not found', async () => {
      (pool.query as jest.Mock).mockResolvedValueOnce({ rows: [] });

      const callback = jest.fn();
      await submitHandler({ joinCode: 'ZZZ999', headline: 'Test headline' }, callback);

      expect(callback).toHaveBeenCalledWith({
        success: false,
        error: 'Session not found',
      });
    });

    it('should reject when session phase is not PLAYING', async () => {
      const waitingSession = createMockSessionData({ phase: 'WAITING' });
      (pool.query as jest.Mock).mockResolvedValueOnce({ rows: [waitingSession] });

      const callback = jest.fn();
      await submitHandler({ joinCode: 'ABC123', headline: 'Test headline' }, callback);

      expect(callback).toHaveBeenCalledWith({
        success: false,
        error: expect.stringContaining('playing phase'),
      });
    });

    it('should reject during BREAK phase', async () => {
      const breakSession = createMockSessionData({ phase: 'BREAK' });
      (pool.query as jest.Mock).mockResolvedValueOnce({ rows: [breakSession] });

      const callback = jest.fn();
      await submitHandler({ joinCode: 'ABC123', headline: 'Test headline' }, callback);

      expect(callback).toHaveBeenCalledWith({
        success: false,
        error: expect.stringContaining('playing phase'),
      });
    });

    it('should reject when player is not in session', async () => {
      mockSocket.data = { playerId: 'unknown-player', joinCode: 'ABC123' };
      const mockSession = createMockSessionData();

      (pool.query as jest.Mock).mockResolvedValueOnce({ rows: [mockSession] });

      const callback = jest.fn();
      await submitHandler({ joinCode: 'ABC123', headline: 'Test headline' }, callback);

      expect(callback).toHaveBeenCalledWith({
        success: false,
        error: 'Player not in this session',
      });
    });

    it('should reject when not authenticated', async () => {
      mockSocket.data = {};

      const callback = jest.fn();
      await submitHandler({ joinCode: 'ABC123', headline: 'Test headline' }, callback);

      expect(callback).toHaveBeenCalledWith({
        success: false,
        error: expect.stringContaining('Not authenticated'),
      });
    });

    it('should store in_game_submitted_at when session has inGameNow', async () => {
      const mockSession = createMockSessionData();
      const insertedRow = {
        id: 'headline-1',
        created_at: new Date(),
        in_game_submitted_at: new Date(),
      };

      (pool.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [mockSession] }) // getSessionState
        .mockResolvedValueOnce({ rows: [] }) // fetch existing headlines
        .mockResolvedValueOnce({ rows: [insertedRow] }); // INSERT headline

      const callback = jest.fn();
      await submitHandler({ joinCode: 'ABC123', headline: 'Test headline' }, callback);

      const insertCall = (pool.query as jest.Mock).mock.calls.find(
        (call) => call[0].includes('INSERT INTO game_session_headlines')
      );
      expect(insertCall).toBeDefined();
      // $25 is in_game_submitted_at — should be a non-null string (sessionState.inGameNow)
      const params = insertCall[1];
      expect(params[24]).not.toBeNull();
      expect(typeof params[24]).toBe('string');
    });

    it('headline:new broadcast includes inGameSubmittedAt', async () => {
      const mockSession = createMockSessionData();
      const inGameTime = new Date();
      const insertedRow = {
        id: 'headline-1',
        created_at: new Date(),
        in_game_submitted_at: inGameTime,
      };

      const mockToEmit = jest.fn();
      (mockIO.to as jest.Mock).mockReturnValue({ emit: mockToEmit });

      (pool.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [mockSession] }) // getSessionState
        .mockResolvedValueOnce({ rows: [] }) // fetch existing headlines
        .mockResolvedValueOnce({ rows: [insertedRow] }); // INSERT headline

      const callback = jest.fn();
      await submitHandler({ joinCode: 'ABC123', headline: 'Test headline' }, callback);

      expect(mockToEmit).toHaveBeenCalledWith(
        'headline:new',
        expect.objectContaining({
          inGameSubmittedAt: inGameTime.toISOString(),
        })
      );
    });

    it('inGameSubmittedAt is null when session has no in_game_start_at', async () => {
      const mockSession = createMockSessionData({ in_game_start_at: null });
      const insertedRow = {
        id: 'headline-1',
        created_at: new Date(),
        in_game_submitted_at: null,
      };

      const mockToEmit = jest.fn();
      (mockIO.to as jest.Mock).mockReturnValue({ emit: mockToEmit });

      (pool.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [mockSession] }) // getSessionState
        .mockResolvedValueOnce({ rows: [] }) // fetch existing headlines
        .mockResolvedValueOnce({ rows: [insertedRow] }); // INSERT headline

      const callback = jest.fn();
      await submitHandler({ joinCode: 'ABC123', headline: 'Test headline' }, callback);

      expect(mockToEmit).toHaveBeenCalledWith(
        'headline:new',
        expect.objectContaining({
          inGameSubmittedAt: null,
        })
      );
    });

    it('should enforce rate limiting - reject second submission within 60 seconds', async () => {
      const mockSession = createMockSessionData();
      const insertedRow = {
        id: 'headline-1',
        created_at: new Date(),
      };

      // First submission succeeds
      (pool.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [mockSession] }) // getSessionState
        .mockResolvedValueOnce({ rows: [] }) // fetch existing headlines
        .mockResolvedValueOnce({ rows: [insertedRow] }); // INSERT headline

      const callback1 = jest.fn();
      await submitHandler({ joinCode: 'ABC123', headline: 'First headline' }, callback1);
      expect(callback1).toHaveBeenCalledWith(expect.objectContaining({ success: true }));

      // Reset mocks for second call
      (pool.query as jest.Mock).mockClear();
      const mockSession2 = createMockSessionData();
      (pool.query as jest.Mock).mockResolvedValueOnce({ rows: [mockSession2] });

      // Second submission should be rate limited
      const callback2 = jest.fn();
      await submitHandler({ joinCode: 'ABC123', headline: 'Second headline' }, callback2);

      expect(callback2).toHaveBeenCalledWith({
        success: false,
        error: expect.stringContaining('wait'),
        cooldownMs: expect.any(Number),
      });

      // Verify DB was NOT called for insert on second attempt
      const insertCalls = (pool.query as jest.Mock).mock.calls.filter(
        (call) => call[0].includes('INSERT')
      );
      expect(insertCalls.length).toBe(0);
    });
  });

  describe('headline:get_feed', () => {
    beforeEach(() => {
      // Clear mocks before each get_feed test
      (pool.query as jest.Mock).mockClear();
    });

    it('should return all headlines for a session', async () => {
      const mockSession = createMockSessionData();
      const mockHeadlines = [
        {
          id: 'headline-1',
          session_id: 'session-123',
          player_id: 'player-1',
          player_nickname: 'Alice',
          round_no: 1,
          text: 'First headline',
          created_at: new Date('2025-01-15T10:00:00Z'),
        },
        {
          id: 'headline-2',
          session_id: 'session-123',
          player_id: 'player-2',
          player_nickname: 'Bob',
          round_no: 1,
          text: 'Second headline',
          created_at: new Date('2025-01-15T10:01:00Z'),
        },
      ];

      (pool.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [mockSession] }) // getSessionState
        .mockResolvedValueOnce({ rows: mockHeadlines }); // headlines query

      const callback = jest.fn();
      await getFeedHandler({ joinCode: 'ABC123' }, callback);

      expect(callback).toHaveBeenCalledWith({
        success: true,
        headlines: expect.arrayContaining([
          expect.objectContaining({
            id: 'headline-1',
            playerNickname: 'Alice',
            text: 'First headline',
          }),
          expect.objectContaining({
            id: 'headline-2',
            playerNickname: 'Bob',
            text: 'Second headline',
          }),
        ]),
      });
    });

    it('should filter headlines by round when roundNo is provided', async () => {
      const mockSession = createMockSessionData();
      
      (pool.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [mockSession] }) // getSessionState
        .mockResolvedValueOnce({ rows: [] }); // headlines query

      const callback = jest.fn();
      await getFeedHandler({ joinCode: 'ABC123', roundNo: 2 }, callback);

      // Verify the query included round filter
      const headlineQueryCall = (pool.query as jest.Mock).mock.calls.find(
        (call) => call[0].includes('game_session_headlines')
      );
      expect(headlineQueryCall[0]).toContain('round_no = $2');
      expect(headlineQueryCall[1]).toContain(2);

      expect(callback).toHaveBeenCalledWith({
        success: true,
        headlines: [],
      });
    });

    it('should return error when session not found', async () => {
      (pool.query as jest.Mock).mockResolvedValueOnce({ rows: [] });

      const callback = jest.fn();
      await getFeedHandler({ joinCode: 'ZZZ999' }, callback);

      expect(callback).toHaveBeenCalledWith({
        success: false,
        error: 'Session not found',
      });
    });

    it('should return error when joinCode is missing', async () => {
      const callback = jest.fn();
      await getFeedHandler({}, callback);

      expect(callback).toHaveBeenCalledWith({
        success: false,
        error: 'Missing joinCode',
      });
    });

    it('should return empty array when no headlines exist', async () => {
      const mockSession = createMockSessionData();
      
      (pool.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [mockSession] })
        .mockResolvedValueOnce({ rows: [] });

      const callback = jest.fn();
      await getFeedHandler({ joinCode: 'ABC123' }, callback);

      expect(callback).toHaveBeenCalledWith({
        success: true,
        headlines: [],
      });
    });
  });
});

