/**
 * Tests for session state helper and Socket.IO handlers
 * Note: getSessionState is not exported, so we test it indirectly through the handlers
 */

import { Server, Socket } from 'socket.io';
import pool from '../../src/db/pool';
import { setupLobbyHandlers } from '../../src/socket/lobbyHandlers';
import { gameLoopManager } from '../../src/game/gameLoop';

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

// Default mock for score breakdowns query (empty results)
const mockBreakdownRows = (playerIds: string[]) =>
  playerIds.map((id) => ({
    player_id: id,
    baseline: 0,
    plausibility: 0,
    connection: 0,
    planet_bonus: 0,
  }));

describe('Lobby Handlers - getSessionState', () => {
  let mockIO: Partial<Server>;
  let mockSocket: Partial<Socket>;
  let getStateHandler: any;
  let startGameHandler: any;

  beforeEach(() => {
    jest.clearAllMocks();

    // Create mock Socket.IO instances
    const handlers: Record<string, any> = {};
    
    mockSocket = {
      id: 'socket-123',
      data: {},
      on: jest.fn((event, handler) => {
        handlers[event] = handler;
        return mockSocket as Socket;
      }),
      to: jest.fn().mockReturnThis(),
      emit: jest.fn(),
      join: jest.fn().mockResolvedValue(undefined),
      leave: jest.fn().mockResolvedValue(undefined),
    } as Partial<Socket>;

    mockIO = {
      on: jest.fn((event, handler) => {
        if (event === 'connection') {
          handler(mockSocket);
        }
        return mockIO as Server;
      }),
      to: jest.fn().mockReturnThis(),
      emit: jest.fn(),
    } as Partial<Server>;

    // Setup handlers
    setupLobbyHandlers(mockIO as Server);

    // Extract handlers for testing
    const socketOnCalls = (mockSocket.on as jest.Mock).mock.calls;
    getStateHandler = socketOnCalls.find(([event]) => event === 'lobby:get_state')?.[1];
    startGameHandler = socketOnCalls.find(([event]) => event === 'lobby:start_game')?.[1];
  });

  describe('getSessionState (via lobby:get_state)', () => {
    it('should return enriched session state with all timing fields', async () => {
      const mockSessionData = {
        id: 'session-123',
        join_code: 'ABC123',
        status: 'PLAYING',
        host_player_id: 'player-1',
        phase: 'PLAYING',
        current_round: 2,
        play_minutes: 15,
        break_minutes: 5,
        max_rounds: 4,
        phase_started_at: new Date('2025-01-15T10:00:00Z'),
        phase_ends_at: new Date('2025-01-15T10:15:00Z'),
        in_game_start_at: new Date('2025-01-15T10:00:00Z'),
        timeline_speed_ratio: 60.0,
        server_now: new Date('2025-01-15T10:05:00Z'),
        players: [
          {
            id: 'player-1',
            nickname: 'Alice',
            isHost: true,
            joinedAt: '2025-01-15T09:55:00Z',
            totalScore: 0,
            planetUsageState: null,
          },
        ],
      };

      (pool.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [mockSessionData] })
        .mockResolvedValueOnce({ rows: mockBreakdownRows(['player-1']) });

      const callback = jest.fn();
      await getStateHandler({ joinCode: 'ABC123' }, callback);

      const result = callback.mock.calls[0][0];
      expect(result.success).toBe(true);
      expect(result.state).toMatchObject({
        id: 'session-123',
        joinCode: 'ABC123',
        phase: 'PLAYING',
        currentRound: 2,
        playMinutes: 15,
        breakMinutes: 5,
        maxRounds: 4,
        phaseStartedAt: '2025-01-15T10:00:00.000Z',
        phaseEndsAt: '2025-01-15T10:15:00.000Z',
        timelineSpeedRatio: 60.0,
      });
      expect(result.state.serverNow).toBeDefined();
      expect(result.state.inGameNow).toBeDefined();
      expect(result.state.players).toHaveLength(1);
      expect(result.state.players[0]).toMatchObject({
        id: 'player-1',
        nickname: 'Alice',
        isHost: true,
        totalScore: 0,
        scoreBreakdown: { baseline: 0, plausibility: 0, connection: 0, planetBonus: 0 },
      });
      expect(result.state.players[0]).toHaveProperty('planetPanel');
      expect(result.state.players[0].planetPanel).toHaveLength(9);
    });

    it('should compute in-game time correctly based on timeline_speed_ratio', async () => {
      const baseTime = new Date('2025-01-15T10:00:00Z');
      const phaseStart = new Date('2025-01-15T10:00:00Z');
      const serverNow = new Date('2025-01-15T10:00:10Z'); // 10 seconds elapsed
      
      // With 60x speed, 10 real seconds = 600 in-game seconds = 10 minutes
      const expectedInGameTime = new Date(baseTime.getTime() + 10 * 60 * 1000);

      const mockSessionData = {
        id: 'session-123',
        join_code: 'ABC123',
        status: 'PLAYING',
        host_player_id: 'player-1',
        phase: 'PLAYING',
        current_round: 1,
        play_minutes: 15,
        break_minutes: 5,
        max_rounds: 4,
        phase_started_at: phaseStart,
        phase_ends_at: new Date('2025-01-15T10:15:00Z'),
        in_game_start_at: baseTime,
        timeline_speed_ratio: 60.0,
        server_now: serverNow,
        players: [{ id: 'player-1', nickname: 'Alice', isHost: true, joinedAt: '2025-01-15T09:55:00Z', totalScore: 0, planetUsageState: null }],
      };

      (pool.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [mockSessionData] })
        .mockResolvedValueOnce({ rows: mockBreakdownRows(['player-1']) });

      const callback = jest.fn();
      await getStateHandler({ joinCode: 'ABC123' }, callback);

      const result = callback.mock.calls[0][0];
      expect(result.success).toBe(true);

      // Check in-game time is approximately correct (within 1 second tolerance)
      const receivedInGameTime = new Date(result.state.inGameNow);
      const timeDiff = Math.abs(receivedInGameTime.getTime() - expectedInGameTime.getTime());
      expect(timeDiff).toBeLessThan(1000); // within 1 second
    });

    it('should handle session with no in_game_start_at (WAITING phase)', async () => {
      const mockSessionData = {
        id: 'session-123',
        join_code: 'ABC123',
        status: 'WAITING',
        host_player_id: 'player-1',
        phase: 'WAITING',
        current_round: 0,
        play_minutes: 15,
        break_minutes: 5,
        max_rounds: 4,
        phase_started_at: null,
        phase_ends_at: null,
        in_game_start_at: null,
        timeline_speed_ratio: 60.0,
        server_now: new Date(),
        players: [{ id: 'player-1', nickname: 'Alice', isHost: true, joinedAt: new Date().toISOString(), totalScore: 0, planetUsageState: null }],
      };

      (pool.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [mockSessionData] })
        .mockResolvedValueOnce({ rows: mockBreakdownRows(['player-1']) });

      const callback = jest.fn();
      await getStateHandler({ joinCode: 'ABC123' }, callback);

      expect(callback).toHaveBeenCalledWith({
        success: true,
        state: expect.objectContaining({
          phase: 'WAITING',
          currentRound: 0,
          phaseStartedAt: null,
          phaseEndsAt: null,
          inGameNow: null,
        }),
      });
    });

    it('should filter out null players from LEFT JOIN', async () => {
      const mockSessionData = {
        id: 'session-123',
        join_code: 'ABC123',
        status: 'WAITING',
        host_player_id: null,
        phase: 'WAITING',
        current_round: 0,
        play_minutes: 15,
        break_minutes: 5,
        max_rounds: 4,
        phase_started_at: null,
        phase_ends_at: null,
        in_game_start_at: null,
        timeline_speed_ratio: 60.0,
        server_now: new Date(),
        players: [
          { id: 'player-1', nickname: 'Alice', isHost: true, joinedAt: new Date().toISOString(), totalScore: 0, planetUsageState: null },
          { id: null, nickname: null, isHost: null, joinedAt: null, totalScore: null, planetUsageState: null }, // NULL from LEFT JOIN
        ],
      };

      (pool.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [mockSessionData] })
        .mockResolvedValueOnce({ rows: mockBreakdownRows(['player-1']) });

      const callback = jest.fn();
      await getStateHandler({ joinCode: 'ABC123' }, callback);

      const result = callback.mock.calls[0][0];
      expect(result.state.players).toHaveLength(1);
      expect(result.state.players[0].id).toBe('player-1');
    });

    it('should return error when session not found', async () => {
      (pool.query as jest.Mock).mockResolvedValueOnce({
        rows: [],
      });

      const callback = jest.fn();
      await getStateHandler({ joinCode: 'NOTFOUND' }, callback);

      expect(callback).toHaveBeenCalledWith({
        success: false,
        error: 'Session not found',
      });
    });

    it('should return error when joinCode is missing', async () => {
      const callback = jest.fn();
      await getStateHandler({}, callback);

      expect(callback).toHaveBeenCalledWith({
        success: false,
        error: 'Missing joinCode',
      });
    });
  });

  describe('lobby:start_game handler', () => {
    beforeEach(() => {
      mockSocket.data = { playerId: 'player-1' };
    });

    it('should successfully start game when host initiates', async () => {
      const mockSessionData = {
        id: 'session-123',
        join_code: 'ABC123',
        status: 'WAITING',
        host_player_id: 'player-1',
        phase: 'WAITING',
        current_round: 0,
        play_minutes: 15,
        break_minutes: 5,
        max_rounds: 4,
        phase_started_at: null,
        phase_ends_at: null,
        in_game_start_at: null,
        timeline_speed_ratio: 60.0,
        server_now: new Date(),
        players: [
          { id: 'player-1', nickname: 'Alice', isHost: true, joinedAt: new Date().toISOString(), totalScore: 0, planetUsageState: null },
          { id: 'player-2', nickname: 'Bob', isHost: false, joinedAt: new Date().toISOString(), totalScore: 0, planetUsageState: null },
        ],
      };

      const updatedSessionData = {
        ...mockSessionData,
        phase: 'PLAYING',
        current_round: 1,
        phase_started_at: new Date(),
        phase_ends_at: new Date(Date.now() + 15 * 60 * 1000),
        in_game_start_at: new Date(),
      };

      // Build ordered mock responses:
      // 1. getSessionState before (session query + breakdowns)
      // 2. UPDATE global planet usage (session)
      // 3. UPDATE planet ordinals for each player (2 players)
      // 4. INSERT Archive player
      // 5. INSERT 36 seed headlines
      // 6. getSessionState after (session query + breakdowns)
      const orderedResponses = [
        { rows: [mockSessionData] }, // getSessionState before - session
        { rows: mockBreakdownRows(['player-1', 'player-2']) }, // getSessionState before - breakdowns
        { rowCount: 1 }, // UPDATE global planet usage
        { rowCount: 1 }, // UPDATE ordinals for player 1
        { rowCount: 1 }, // UPDATE ordinals for player 2
        { rows: [{ id: 'archive-player-id' }] }, // INSERT Archive player
        ...Array(36).fill({ rowCount: 1 }), // 36 seed headline INSERTs
        { rows: [updatedSessionData] }, // getSessionState after - session
        { rows: mockBreakdownRows(['player-1', 'player-2']) }, // getSessionState after - breakdowns
      ];
      let callIdx = 0;
      (pool.query as jest.Mock).mockImplementation(() =>
        Promise.resolve(orderedResponses[callIdx++] ?? { rows: [] })
      );

      (gameLoopManager.handleHostStartGame as jest.Mock).mockResolvedValueOnce(undefined);

      const callback = jest.fn();
      await startGameHandler({ joinCode: 'ABC123' }, callback);

      expect(gameLoopManager.handleHostStartGame).toHaveBeenCalledWith('session-123', 'ABC123', expect.any(String));
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({ success: true })
      );
    });

    it('should reject when non-host tries to start game', async () => {
      mockSocket.data = { playerId: 'player-2' }; // Not the host

      const mockSessionData = {
        id: 'session-123',
        join_code: 'ABC123',
        status: 'WAITING',
        host_player_id: 'player-1', // Different player is host
        phase: 'WAITING',
        current_round: 0,
        play_minutes: 15,
        break_minutes: 5,
        max_rounds: 4,
        phase_started_at: null,
        phase_ends_at: null,
        in_game_start_at: null,
        timeline_speed_ratio: 60.0,
        server_now: new Date(),
        players: [
          { id: 'player-1', nickname: 'Alice', isHost: true, joinedAt: new Date().toISOString(), totalScore: 0, planetUsageState: null },
          { id: 'player-2', nickname: 'Bob', isHost: false, joinedAt: new Date().toISOString(), totalScore: 0, planetUsageState: null },
        ],
      };

      (pool.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [mockSessionData] })
        .mockResolvedValueOnce({ rows: mockBreakdownRows(['player-1', 'player-2']) });

      const callback = jest.fn();
      await startGameHandler({ joinCode: 'ABC123' }, callback);

      expect(callback).toHaveBeenCalledWith({
        success: false,
        error: 'Only the host can start the game',
      });
      expect(gameLoopManager.handleHostStartGame).not.toHaveBeenCalled();
    });

    it('should reject when game already started', async () => {
      const mockSessionData = {
        id: 'session-123',
        join_code: 'ABC123',
        status: 'PLAYING',
        host_player_id: 'player-1',
        phase: 'PLAYING', // Already in PLAYING phase
        current_round: 1,
        play_minutes: 15,
        break_minutes: 5,
        max_rounds: 4,
        phase_started_at: new Date(),
        phase_ends_at: new Date(Date.now() + 15 * 60 * 1000),
        in_game_start_at: new Date(),
        timeline_speed_ratio: 60.0,
        server_now: new Date(),
        players: [{ id: 'player-1', nickname: 'Alice', isHost: true, joinedAt: new Date().toISOString(), totalScore: 0, planetUsageState: null }],
      };

      (pool.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [mockSessionData] })
        .mockResolvedValueOnce({ rows: mockBreakdownRows(['player-1']) });

      const callback = jest.fn();
      await startGameHandler({ joinCode: 'ABC123' }, callback);

      expect(callback).toHaveBeenCalledWith({
        success: false,
        error: 'Game already started (phase: PLAYING)',
      });
      expect(gameLoopManager.handleHostStartGame).not.toHaveBeenCalled();
    });

    it('should reject when joinCode is missing', async () => {
      const callback = jest.fn();
      await startGameHandler({}, callback);

      expect(callback).toHaveBeenCalledWith({
        success: false,
        error: 'Missing required data',
      });
    });

    it('should reject when playerId is missing', async () => {
      mockSocket.data = {}; // No playerId

      const callback = jest.fn();
      await startGameHandler({ joinCode: 'ABC123' }, callback);

      expect(callback).toHaveBeenCalledWith({
        success: false,
        error: 'Missing required data',
      });
    });

    it('should reject when session not found', async () => {
      (pool.query as jest.Mock).mockResolvedValueOnce({ rows: [] });

      const callback = jest.fn();
      await startGameHandler({ joinCode: 'NOTFOUND' }, callback);

      expect(callback).toHaveBeenCalledWith({
        success: false,
        error: 'Session not found',
      });
    });
  });
});

