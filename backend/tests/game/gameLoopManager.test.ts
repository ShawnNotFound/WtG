import { gameLoopManager } from '../../src/game/gameLoop';
import pool from '../../src/db/pool';

// Mock the database pool
jest.mock('../../src/db/pool', () => ({
  __esModule: true,
  default: {
    query: jest.fn(),
    connect: jest.fn(),
  },
}));

// Mock Socket.IO
const mockEmit = jest.fn();
const mockTo = jest.fn().mockReturnValue({ emit: mockEmit });
const mockIO = { to: mockTo } as any;

describe('GameLoopManager', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    gameLoopManager.stopAll();
    gameLoopManager.setSocketIO(mockIO);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('ensureLoopForSession', () => {
    it('should create a new loop instance for a session', async () => {
      const mockSessionRow = {
        id: 'session-123',
        join_code: 'ABC123',
        play_minutes: 15,
        break_minutes: 5,
        max_rounds: 4,
        timeline_speed_ratio: 60.0,
      };

      const mockStateRow = {
        phase: 'WAITING',
        current_round: 0,
        phase_started_at: null,
        phase_ends_at: null,
        in_game_start_at: null,
        play_minutes: 15,
        break_minutes: 5,
        max_rounds: 4,
        timeline_speed_ratio: 60.0,
      };

      (pool.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [mockSessionRow] }) // Config query
        .mockResolvedValueOnce({ rows: [mockStateRow] }); // loadFromDatabase query

      const loop = await gameLoopManager.ensureLoopForSession(
        'session-123',
        'ABC123'
      );

      expect(loop).toBeDefined();
      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining('SELECT id, join_code'),
        ['session-123']
      );
    });

    it('should return existing loop instance on subsequent calls', async () => {
      const mockSessionRow = {
        id: 'session-123',
        join_code: 'ABC123',
        play_minutes: 15,
        break_minutes: 5,
        max_rounds: 4,
        timeline_speed_ratio: 60.0,
      };

      const mockStateRow = {
        phase: 'WAITING',
        current_round: 0,
        phase_started_at: null,
        phase_ends_at: null,
        in_game_start_at: null,
        play_minutes: 15,
        break_minutes: 5,
        max_rounds: 4,
        timeline_speed_ratio: 60.0,
      };

      (pool.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [mockSessionRow] }) // Config query
        .mockResolvedValueOnce({ rows: [mockStateRow] }); // loadFromDatabase query

      const loop1 = await gameLoopManager.ensureLoopForSession(
        'session-123',
        'ABC123'
      );
      const loop2 = await gameLoopManager.ensureLoopForSession(
        'session-123',
        'ABC123'
      );

      expect(loop1).toBe(loop2);
      // Query should only be called twice (once for config, once for load, not again for loop2)
      expect(pool.query).toHaveBeenCalledTimes(2);
    });

    it('should throw error when session not found in database', async () => {
      (pool.query as jest.Mock).mockResolvedValueOnce({
        rows: [],
      });

      await expect(
        gameLoopManager.ensureLoopForSession('nonexistent', 'XYZ999')
      ).rejects.toThrow('Session nonexistent not found');
    });
  });

  describe('handleHostStartGame', () => {
    it('should start the game for a session', async () => {
      const mockSessionRow = {
        id: 'session-123',
        join_code: 'ABC123',
        play_minutes: 0.01, // 0.6 seconds for testing
        break_minutes: 0.01,
        max_rounds: 2,
        timeline_speed_ratio: 60.0,
      };

      const mockStateRow = {
        phase: 'WAITING',
        current_round: 0,
        phase_started_at: null,
        phase_ends_at: null,
        in_game_start_at: null,
        play_minutes: 0.01,
        break_minutes: 0.01,
        max_rounds: 2,
        timeline_speed_ratio: 60.0,
      };

      const mockClient = {
        query: jest.fn()
          .mockResolvedValueOnce({ rows: [] }) // BEGIN
          .mockResolvedValueOnce({ rows: [] }) // UPDATE game_sessions
          .mockResolvedValueOnce({ rows: [] }) // INSERT state_transitions
          .mockResolvedValueOnce({ rows: [] }), // COMMIT
        release: jest.fn(),
      };

      const mockBroadcastResult = {
        rows: [{
          id: 'session-123',
          join_code: 'ABC123',
          status: 'PLAYING',
          host_player_id: 'player-1',
          phase: 'PLAYING',
          current_round: 1,
          play_minutes: 0.01,
          break_minutes: 0.01,
          max_rounds: 2,
          phase_started_at: new Date().toISOString(),
          phase_ends_at: new Date(Date.now() + 600).toISOString(),
          in_game_start_at: new Date().toISOString(),
          timeline_speed_ratio: 60.0,
          server_now: new Date().toISOString(),
          players: [{ id: 'player-1', nickname: 'Alice', isHost: true, joinedAt: new Date().toISOString(), totalScore: 0, planetUsageState: null }],
        }],
      };

      (pool.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [mockSessionRow] }) // ensureLoopForSession
        .mockResolvedValueOnce({ rows: [mockStateRow] }) // loadFromDatabase
        .mockResolvedValueOnce(mockBroadcastResult) // broadcastGameState - session query
        .mockResolvedValueOnce({ rows: [{ player_id: 'player-1', baseline: 0, plausibility: 0, connection: 0, planet_bonus: 0 }] }); // broadcastGameState - breakdowns query

      (pool.connect as jest.Mock).mockResolvedValue(mockClient);

      await gameLoopManager.handleHostStartGame('session-123', 'ABC123');

      // Verify DB updates were called
      expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE game_sessions'),
        expect.arrayContaining(['TUTORIAL', 0, 'session-123'])
      );
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO game_session_state_transitions'),
        expect.arrayContaining(['session-123', 'WAITING', 'TUTORIAL', 0])
      );
      expect(mockClient.query).toHaveBeenCalledWith('COMMIT');

      // Verify Socket.IO broadcast
      expect(mockTo).toHaveBeenCalledWith('session:ABC123');
      expect(mockEmit).toHaveBeenCalledWith('game:state', expect.objectContaining({
        phase: 'PLAYING',
        currentRound: 1,
      }));
    });
  });

  describe('stopLoop', () => {
    it('should stop and remove a loop', async () => {
      const mockSessionRow = {
        id: 'session-123',
        join_code: 'ABC123',
        play_minutes: 15,
        break_minutes: 5,
        max_rounds: 4,
        timeline_speed_ratio: 60.0,
      };

      const mockStateRow = {
        phase: 'WAITING',
        current_round: 0,
        phase_started_at: null,
        phase_ends_at: null,
        in_game_start_at: null,
        play_minutes: 15,
        break_minutes: 5,
        max_rounds: 4,
        timeline_speed_ratio: 60.0,
      };

      (pool.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [mockSessionRow] })
        .mockResolvedValueOnce({ rows: [mockStateRow] });

      await gameLoopManager.ensureLoopForSession('session-123', 'ABC123');
      
      gameLoopManager.stopLoop('session-123');

      // After stopping, next call should create a new instance
      (pool.query as jest.Mock).mockClear();
      (pool.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [mockSessionRow] })
        .mockResolvedValueOnce({ rows: [mockStateRow] });

      await gameLoopManager.ensureLoopForSession('session-123', 'ABC123');
      
      // Should query DB again (new instance - config + load)
      expect(pool.query).toHaveBeenCalledTimes(2);
    });
  });

  describe('stopAll', () => {
    it('should stop all active loops', async () => {
      const mockSession1 = {
        id: 'session-1',
        join_code: 'AAA111',
        play_minutes: 15,
        break_minutes: 5,
        max_rounds: 4,
        timeline_speed_ratio: 60.0,
      };

      const mockSession2 = {
        id: 'session-2',
        join_code: 'BBB222',
        play_minutes: 15,
        break_minutes: 5,
        max_rounds: 4,
        timeline_speed_ratio: 60.0,
      };

      const mockStateRow = {
        phase: 'WAITING',
        current_round: 0,
        phase_started_at: null,
        phase_ends_at: null,
        in_game_start_at: null,
        play_minutes: 15,
        break_minutes: 5,
        max_rounds: 4,
        timeline_speed_ratio: 60.0,
      };

      (pool.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [mockSession1] }) // Config 1
        .mockResolvedValueOnce({ rows: [mockStateRow] }) // Load 1
        .mockResolvedValueOnce({ rows: [mockSession2] }) // Config 2
        .mockResolvedValueOnce({ rows: [mockStateRow] }); // Load 2

      await gameLoopManager.ensureLoopForSession('session-1', 'AAA111');
      await gameLoopManager.ensureLoopForSession('session-2', 'BBB222');

      gameLoopManager.stopAll();

      // After stopAll, should create new instances
      (pool.query as jest.Mock).mockClear();
      (pool.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [mockSession1] }) // Config 1
        .mockResolvedValueOnce({ rows: [mockStateRow] }) // Load 1
        .mockResolvedValueOnce({ rows: [mockSession2] }) // Config 2
        .mockResolvedValueOnce({ rows: [mockStateRow] }); // Load 2

      await gameLoopManager.ensureLoopForSession('session-1', 'AAA111');
      await gameLoopManager.ensureLoopForSession('session-2', 'BBB222');

      // Should query DB again for both (new instances - config + load for each)
      expect(pool.query).toHaveBeenCalledTimes(4);
    });
  });
});

