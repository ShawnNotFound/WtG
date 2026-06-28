import { Server, Socket } from 'socket.io';
import pool from '../db/pool.js';
import { joinCodeSchema, submitHeadlineSchema, worldHelperAskSchema } from '../utils/validation.js';
import { ZodError } from 'zod';
import { transformHeadline, LinkedHeadline } from '../game/headlineTransformationService.js';
import { getDefaultPlanets } from '../game/planets.js';
import { HeadlineEntry } from '../llm/jurorPrompt.js';
import { applyHeadlineEvaluation, getPlayerScoreBreakdowns } from '../game/scoringService.js';
import { PlausibilityLevel, DEFAULT_PLANETS, PlanetPanelEntry } from '../game/scoringTypes.js';
import {
  migrateGlobalUsage,
  migratePlayerOrdinals,
  computePlanetPanel,
} from '../game/planetUsage.js';
import { getRoundSummary, getSessionIdFromJoinCode } from '../game/summaryService.js';
import { computeInGameNow } from '../game/inGameTime.js';
import { SEED_HEADLINES } from '../game/seedHeadlines.js';
import { worldStateProcessor } from '../world/worldStateService.js';
import { startGameSessionRuntime } from '../game/sessionLifecycle.js';
import {
  canSubmitHeadline,
  recordHeadlineSubmission,
  getHeadlineCooldownMs,
  clearSessionRateLimits,
} from '../game/headlineCooldown.js';
import {
  askWorldHelper,
  getWorldHelperHistory,
} from '../world/worldHelperService.js';

export { clearSessionRateLimits };

// the juror only sees the most recent N headlines (rolling window) when judging
// plausibility, linking connections, and drafting variations. N = the number of
// archive/seed headlines, so old context drops off as the timeline grows.
const JUROR_HISTORY_WINDOW = SEED_HEADLINES.length;

/**
 * count unique other authors from STRONG linked headlines using db lookup.
 *
 * looks at only strong connections, finds who wrote each linked headline,
 * and counts how many distinct other players (not the submitter) are represented.
 *
 * @param linkedHeadlines - array of linked headlines from llm
 * @param sessionId - session id to query db for headline owners
 * @param currentPlayerId - the player who submitted the headline
 * @returns number of unique other authors (0-3)
 */
async function deriveUniqueOtherAuthorCount(
  linkedHeadlines: LinkedHeadline[],
  sessionId: string,
  currentPlayerId: string
): Promise<number> {
  // filter to STRONG connections only
  const strongConnections = linkedHeadlines.filter((h) => h.strength === 'STRONG');

  if (strongConnections.length === 0) {
    return 0;
  }

  const headlineTexts = strongConnections.map((h) => h.headline);

  try {
    // query db to find the player_id for each linked headline
    const result = await pool.query(
      `SELECT player_id, COALESCE(selected_headline, headline_text) as text
       FROM game_session_headlines
       WHERE session_id = $1
         AND COALESCE(selected_headline, headline_text) = ANY($2)`,
      [sessionId, headlineTexts]
    );

    // collect unique other player ids
    const otherAuthors = new Set<string>();
    for (const row of result.rows) {
      if (row.player_id !== currentPlayerId) {
        otherAuthors.add(row.player_id);
      }
    }

    return Math.min(otherAuthors.size, 3);
  } catch (error) {
    console.error('Error querying headline owners for connection scoring:', error);
    return 0;
  }
}

interface JoinLobbyData {
  joinCode: string;
  playerId: string;
}

interface SessionState {
  id: string;
  title: string;
  joinCode: string;
  status: string;
  hostPlayerId: string | null;
  llmConfig?: {
    provider?: 'openai' | 'deepseek';
    model?: string;
    baseUrl?: string;
  };
  moduleLlmConfig?: Record<string, unknown>;
  worldStateConfig?: Record<string, unknown>;
  summaryConfig?: Record<string, unknown>;
  phase: string;
  isPaused: boolean;
  currentRound: number;
  playMinutes: number;
  breakMinutes: number;
  maxRounds: number;
  phaseStartedAt: string | null;
  phaseEndsAt: string | null;
  pausedAt: string | null;
  pauseRemainingMs: number | null;
  serverNow: string;
  inGameNow: string | null;
  timelineSpeedRatio: number;
  players: Array<{
    id: string;
    nickname: string;
    isHost: boolean;
    isAi?: boolean;
    aiConfig?: {
      stylePrompt?: string;
      creativity?: number;
      submitEverySeconds?: number;
      provider?: 'openai' | 'deepseek';
      model?: string;
    };
    joinedAt: string;
    totalScore?: number;
    planetPanel?: PlanetPanelEntry[];
    scoreBreakdown?: {
      baseline: number;
      plausibility: number;
      connection: number;
      planetBonus: number;
    };
  }>;
}

/**
 * fetch current session state from database including game timing
 */
async function getSessionState(joinCode: string): Promise<SessionState | null> {
  try {
    const result = await pool.query(
      `SELECT
        s.id,
        s.title,
        s.join_code,
        s.status,
        s.host_player_id,
        s.llm_config,
        s.module_llm_config,
        s.world_state_config,
        s.summary_config,
        s.phase,
        s.is_paused,
        s.current_round,
        s.play_minutes,
        s.break_minutes,
        s.max_rounds,
        s.phase_started_at,
        s.phase_ends_at,
        s.paused_at,
        s.pause_remaining_ms,
        s.in_game_start_at,
        s.timeline_speed_ratio,
        s.archived_at,
        s.planet_usage_global,
        CURRENT_TIMESTAMP as server_now,
        json_agg(
          json_build_object(
            'id', p.id,
            'nickname', p.nickname,
            'isHost', p.is_host,
            'isAi', p.is_ai,
            'aiConfig', p.ai_config,
            'joinedAt', p.joined_at,
            'totalScore', p.total_score,
            'planetUsageState', p.planet_usage_state
          ) ORDER BY p.joined_at
        ) as players
      FROM game_sessions s
      LEFT JOIN session_players p ON s.id = p.session_id AND p.is_system = FALSE
      WHERE s.join_code = $1
      GROUP BY s.id`,
      [joinCode]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const session = result.rows[0];
    if (session.archived_at) {
      return null;
    }

    const serverNow = new Date(session.server_now);

    // compute in-game time
    const inGameNow = computeInGameNow(
      session.in_game_start_at,
      session.phase_started_at,
      session.phase_ends_at,
      serverNow,
      session.timeline_speed_ratio
    );

    const breakdowns = await getPlayerScoreBreakdowns(session.id);
    const globalUsage = migrateGlobalUsage(session.planet_usage_global, DEFAULT_PLANETS);

    // build each player's usage-ranked planet panel
    const processedPlayers = session.players
      .filter((p: any) => p.id !== null)
      .map((p: any) => {
        const bd = breakdowns.get(p.id);
        return {
          id: p.id,
          nickname: p.nickname,
          isHost: p.isHost,
          isAi: p.isAi,
          aiConfig: p.aiConfig,
          joinedAt: p.joinedAt,
          totalScore: p.totalScore ?? 0,
          planetPanel: computePlanetPanel(
            globalUsage,
            migratePlayerOrdinals(p.planetUsageState, DEFAULT_PLANETS),
            DEFAULT_PLANETS
          ),
          scoreBreakdown: bd ?? { baseline: 0, plausibility: 0, connection: 0, planetBonus: 0 },
        };
      });

    return {
      id: session.id,
      title: session.title,
      joinCode: session.join_code,
      status: session.status,
      hostPlayerId: session.host_player_id,
      llmConfig: session.llm_config,
      moduleLlmConfig: session.module_llm_config ?? {},
      worldStateConfig: session.world_state_config ?? {},
      summaryConfig: session.summary_config ?? {},
      phase: session.phase,
      isPaused: session.is_paused === true,
      currentRound: session.current_round,
      playMinutes: session.play_minutes,
      breakMinutes: session.break_minutes,
      maxRounds: session.max_rounds,
      phaseStartedAt: session.phase_started_at
        ? new Date(session.phase_started_at).toISOString()
        : null,
      phaseEndsAt: session.phase_ends_at
        ? new Date(session.phase_ends_at).toISOString()
        : null,
      pausedAt: session.paused_at
        ? new Date(session.paused_at).toISOString()
        : null,
      pauseRemainingMs: session.pause_remaining_ms ?? null,
      serverNow: serverNow.toISOString(),
      inGameNow: inGameNow ? inGameNow.toISOString() : null,
      timelineSpeedRatio: session.timeline_speed_ratio,
      players: processedPlayers,
    };
  } catch (error) {
    console.error('Error fetching session state:', error);
    return null;
  }
}

/**
 * get room name for a session
 */
function getRoomName(joinCode: string): string {
  return `session:${joinCode}`;
}

/**
 * setup socket.io event handlers for lobby functionality
 */
export function setupLobbyHandlers(io: Server): void {
  io.on('connection', (socket: Socket) => {
    console.log(`Client connected: ${socket.id}`);

    /**
     * join lobby room.
     * client should emit this after successfully creating or joining a session
     */
    socket.on('lobby:join', async (data: JoinLobbyData, callback) => {
      try {
        const { joinCode, playerId } = data;

        if (!joinCode || !playerId) {
          callback?.({
            success: false,
            error: 'Missing joinCode or playerId',
          });
          return;
        }

        const sessionState = await getSessionState(joinCode);
        if (!sessionState) {
          callback?.({
            success: false,
            error: 'Session not found',
          });
          return;
        }

        // verify player belongs to this session
        const playerInSession = sessionState.players.some(
          (p) => p.id === playerId
        );
        if (!playerInSession) {
          callback?.({
            success: false,
            error: 'Player not in this session',
          });
          return;
        }

        const roomName = getRoomName(joinCode);
        await socket.join(roomName);

        // store session info in socket data for later use
        socket.data.joinCode = joinCode;
        socket.data.playerId = playerId;

        console.log(
          `Player ${playerId} joined lobby ${joinCode} (socket: ${socket.id})`
        );

        callback?.({
          success: true,
          state: sessionState,
        });

        // broadcast to others in the room that someone joined
        socket.to(roomName).emit('lobby:player_joined', {
          playerId,
          player: sessionState.players.find((p) => p.id === playerId),
        });
      } catch (error) {
        console.error('Error in lobby:join:', error);
        callback?.({
          success: false,
          error: 'Failed to join lobby',
        });
      }
    });

    /**
     * request current session state
     */
    socket.on('lobby:get_state', async (data: { joinCode: string }, callback) => {
      try {
        const { joinCode } = data;

        if (!joinCode) {
          callback?.({
            success: false,
            error: 'Missing joinCode',
          });
          return;
        }

        const sessionState = await getSessionState(joinCode);
        if (!sessionState) {
          callback?.({
            success: false,
            error: 'Session not found',
          });
          return;
        }

        callback?.({
          success: true,
          state: sessionState,
        });
      } catch (error) {
        console.error('Error in lobby:get_state:', error);
        callback?.({
          success: false,
          error: 'Failed to get session state',
        });
      }
    });

    /**
     * host starts the game
     */
    socket.on('lobby:start_game', async (data: { joinCode: string }, callback) => {
      try {
        const { joinCode } = data;
        const { playerId } = socket.data;

        if (!joinCode || !playerId) {
          callback?.({
            success: false,
            error: 'Missing required data',
          });
          return;
        }

        // verify the player is the host
        const sessionState = await getSessionState(joinCode);
        if (!sessionState) {
          callback?.({
            success: false,
            error: 'Session not found',
          });
          return;
        }

        if (sessionState.hostPlayerId !== playerId) {
          callback?.({
            success: false,
            error: 'Only the host can start the game',
          });
          return;
        }

        if (sessionState.phase !== 'WAITING') {
          callback?.({
            success: false,
            error: `Game already started (phase: ${sessionState.phase})`,
          });
          return;
        }

        await startGameSessionRuntime(
          io,
          sessionState.id,
          joinCode,
          sessionState.players.map((player) => player.id)
        );

        const updatedState = await getSessionState(joinCode);

        callback?.({
          success: true,
          state: updatedState,
        });

        console.log(`Game started for session ${joinCode}`);
      } catch (error) {
        console.error('Error in lobby:start_game:', error);
        callback?.({
          success: false,
          error: 'Failed to start game',
        });
      }
    });

    /**
     * handle disconnection
     */
    socket.on('disconnect', () => {
      const { joinCode, playerId } = socket.data;
      console.log(
        `Client disconnected: ${socket.id}${joinCode ? ` (session: ${joinCode}, player: ${playerId})` : ''}`
      );

      // note: we don't remove players from the database on disconnect.
      // they can reconnect and rejoin the same lobby.
      // could emit a "player offline" event here if needed
    });

    /**
     * handle explicit leave
     */
    socket.on('lobby:leave', async () => {
      const { joinCode } = socket.data;
      if (joinCode) {
        const roomName = getRoomName(joinCode);
        await socket.leave(roomName);
        socket.data.joinCode = undefined;
        socket.data.playerId = undefined;
        console.log(`Socket ${socket.id} left lobby ${joinCode}`);
      }
    });

    socket.on('world_helper:get_history', async (data: { joinCode: string }, callback) => {
      try {
        const playerId = socket.data.playerId;
        if (!playerId) {
          callback?.({ success: false, error: 'Not authenticated - please join a lobby first' });
          return;
        }

        const joinCode = joinCodeSchema.parse(String(data?.joinCode ?? '').toUpperCase());
        const sessionState = await getSessionState(joinCode);
        if (!sessionState) {
          callback?.({ success: false, error: 'Session not found' });
          return;
        }

        const player = sessionState.players.find((entry) => entry.id === playerId);
        if (!player) {
          callback?.({ success: false, error: 'Player not in this session' });
          return;
        }

        const messages = await getWorldHelperHistory(sessionState.id, playerId);
        callback?.({ success: true, messages });
      } catch (error) {
        if (error instanceof ZodError) {
          callback?.({ success: false, error: error.errors[0]?.message || 'Invalid input' });
          return;
        }
        console.error('Error in world_helper:get_history:', error);
        callback?.({ success: false, error: 'Failed to load helper history' });
      }
    });

    socket.on('world_helper:ask', async (data: { joinCode: string; question: string; clientRequestId?: string }, callback) => {
      try {
        const playerId = socket.data.playerId;
        if (!playerId) {
          callback?.({ success: false, error: 'Not authenticated - please join a lobby first' });
          return;
        }

        let validatedData;
        try {
          validatedData = worldHelperAskSchema.parse({
            ...data,
            joinCode: String(data?.joinCode ?? '').toUpperCase(),
          });
        } catch (err) {
          if (err instanceof ZodError) {
            callback?.({ success: false, error: err.errors[0]?.message || 'Invalid input' });
            return;
          }
          throw err;
        }

        const sessionState = await getSessionState(validatedData.joinCode);
        if (!sessionState) {
          callback?.({ success: false, error: 'Session not found' });
          return;
        }

        const player = sessionState.players.find((entry) => entry.id === playerId);
        if (!player) {
          callback?.({ success: false, error: 'Player not in this session' });
          return;
        }

        callback?.({ success: true });

        askWorldHelper(
          {
            sessionId: sessionState.id,
            joinCode: validatedData.joinCode,
            playerId,
            question: validatedData.question,
            clientRequestId: validatedData.clientRequestId,
          },
          {
            onDelta: (payload) => {
              socket.emit('world_helper:delta', payload);
            },
            onComplete: (payload) => {
              socket.emit('world_helper:complete', payload);
            },
            onError: (payload) => {
              socket.emit('world_helper:error', payload);
            },
          }
        ).catch((error) => {
          console.error(`[WorldHelper ${validatedData.joinCode}] Unhandled helper error:`, error);
          socket.emit('world_helper:error', {
            clientRequestId: validatedData.clientRequestId,
            error: 'World helper failed',
          });
        });
      } catch (error) {
        console.error('Error in world_helper:ask:', error);
        callback?.({ success: false, error: 'Failed to ask world helper' });
      }
    });

    /**
     * submit a headline (story direction).
     * flow: validate -> fetch context -> llm evaluation -> dice roll -> store -> broadcast
     */
    socket.on('headline:submit', async (data: { joinCode: string; headline: string }, callback) => {
      try {
        const { playerId } = socket.data;

        if (!playerId) {
          callback?.({
            success: false,
            error: 'Not authenticated - please join a lobby first',
          });
          return;
        }

        let validatedData;
        try {
          validatedData = submitHeadlineSchema.parse(data);
        } catch (err) {
          if (err instanceof ZodError) {
            callback?.({
              success: false,
              error: err.errors[0]?.message || 'Invalid input',
            });
            return;
          }
          throw err;
        }

        const { joinCode, headline: storyDirection } = validatedData;

        const sessionState = await getSessionState(joinCode);
        if (!sessionState) {
          callback?.({
            success: false,
            error: 'Session not found',
          });
          return;
        }

        // verify player belongs to this session
        const player = sessionState.players.find((p) => p.id === playerId);
        if (!player) {
          callback?.({
            success: false,
            error: 'Player not in this session',
          });
          return;
        }

        // only allow during PLAYING phase
        if (sessionState.phase !== 'PLAYING') {
          callback?.({
            success: false,
            error: `Headlines can only be submitted during the playing phase (current: ${sessionState.phase})`,
          });
          return;
        }

        if (sessionState.isPaused) {
          callback?.({
            success: false,
            error: 'The game is paused by the admin. Submissions will reopen when the game resumes.',
          });
          return;
        }

        // check rate limit
        const rateLimitCheck = canSubmitHeadline(sessionState.id, playerId);
        if (!rateLimitCheck.allowed) {
          const remainingSecs = Math.ceil(rateLimitCheck.remainingMs / 1000);
          callback?.({
            success: false,
            error: `Please wait ${remainingSecs} seconds before submitting another headline`,
            cooldownMs: rateLimitCheck.remainingMs,
          });
          return;
        }

        // fetch the most recent N headlines for juror context (rolling window),
        // then restore chronological order so the prompt reads oldest -> newest
        const existingHeadlinesResult = await pool.query(
          `SELECT id, text FROM (
             SELECT id, COALESCE(selected_headline, headline_text) AS text, created_at
             FROM game_session_headlines
             WHERE session_id = $1
             ORDER BY created_at DESC
             LIMIT $2
           ) recent
           ORDER BY created_at ASC`,
          [sessionState.id, JUROR_HISTORY_WINDOW]
        );
        const headlinesList: HeadlineEntry[] = existingHeadlinesResult.rows.map((row) => ({
          id: row.id,
          text: row.text,
        }));

        const planetList = getDefaultPlanets();

        // call transformation service (llm evaluation + dice roll)
        const transformResult = await transformHeadline({
          sessionId: sessionState.id,
          storyDirection,
          headlinesList,
          planetList,
        });

        // insert headline with all transformation data
        const insertResult = await pool.query(
          `INSERT INTO game_session_headlines (
            session_id, player_id, round_no, headline_text,
            dice_roll, selected_band, selected_headline,
            band1_headline, band2_headline, band3_headline, band4_headline, band5_headline,
            plausibility_level, plausibility_rationale,
            planet_1, planet_2, planet_3,
            linked_headlines, planet_rationales,
            llm_model, llm_input_tokens, llm_output_tokens,
            llm_request, llm_response,
            llm_status, in_game_submitted_at
          ) VALUES (
            $1, $2, $3, $4,
            $5, $6, $7,
            $8, $9, $10, $11, $12,
            $13, $14,
            $15, $16, $17,
            $18, $19,
            $20, $21, $22,
            $23, $24,
            'evaluated', $25
          )
          RETURNING id, created_at, in_game_submitted_at`,
          [
            sessionState.id,
            playerId,
            sessionState.currentRound,
            storyDirection,
            transformResult.diceRoll,
            transformResult.selectedBand,
            transformResult.selectedHeadline,
            transformResult.allBands.band1,
            transformResult.allBands.band2,
            transformResult.allBands.band3,
            transformResult.allBands.band4,
            transformResult.allBands.band5,
            transformResult.plausibility.band,
            transformResult.plausibility.rationale,
            transformResult.planets.top3[0]?.id,
            transformResult.planets.top3[1]?.id,
            transformResult.planets.top3[2]?.id,
            JSON.stringify(transformResult.linked),
            JSON.stringify(transformResult.planets.top3),
            transformResult.model,
            transformResult.usage?.inputTokens,
            transformResult.usage?.outputTokens,
            JSON.stringify(transformResult.llmRequest),
            transformResult.llmResponse,
            sessionState.inGameNow,
          ]
        );

        const insertedRow = insertResult.rows[0];

        recordHeadlineSubmission(sessionState.id, playerId);

        // build headline event payload
        const headlineEvent = {
          id: insertedRow.id,
          sessionId: sessionState.id,
          playerId,
          playerNickname: player.nickname,
          roundNo: sessionState.currentRound,
          storyDirection,
          text: transformResult.selectedHeadline,
          diceRoll: transformResult.diceRoll,
          selectedBand: transformResult.selectedBand,
          plausibilityBand: transformResult.plausibility.band,
          plausibilityLabel: transformResult.plausibility.label,
          planets: transformResult.planets.top3.map((p) => p.id),
          allBands: transformResult.allBands,
          createdAt: new Date(insertedRow.created_at).toISOString(),
          inGameSubmittedAt: insertedRow.in_game_submitted_at
            ? new Date(insertedRow.in_game_submitted_at).toISOString()
            : null,
        };

        // broadcast to all players in the session
        const roomName = getRoomName(joinCode);
        io.to(roomName).emit('headline:new', headlineEvent);

        callback?.({
          success: true,
          headline: headlineEvent,
          cooldownMs: getHeadlineCooldownMs(),
        });

        worldStateProcessor.enqueueHeadlineUpdate({
          sessionId: sessionState.id,
          headlineId: insertedRow.id,
          headlineText: transformResult.selectedHeadline,
          storyDirection,
          playerNickname: player.nickname,
          roundNo: sessionState.currentRound,
          inGameSubmittedAt: headlineEvent.inGameSubmittedAt,
        }).catch((error) => {
          console.error(`[WorldState ${joinCode}] Headline update enqueue failed:`, error);
        });

        console.log(
          `Headline submitted by ${player.nickname} in session ${joinCode} ` +
          `(round ${sessionState.currentRound}, dice: ${transformResult.diceRoll}, selected band: ${transformResult.selectedBand}, ` +
          `plausibility: ${transformResult.plausibility.band} (${transformResult.plausibility.label}))\n` +
          `  Band 1 (inevitable): ${transformResult.allBands.band1}\n` +
          `  Band 2 (probable):   ${transformResult.allBands.band2}\n` +
          `  Band 3 (plausible):  ${transformResult.allBands.band3}\n` +
          `  Band 4 (possible):   ${transformResult.allBands.band4}\n` +
          `  Band 5 (prepost.):   ${transformResult.allBands.band5}\n` +
          `  >> Selected:         ${transformResult.selectedHeadline}`
        );

        // apply scoring asynchronously (don't block the response)
        try {
          const uniqueOtherAuthors = await deriveUniqueOtherAuthorCount(
            transformResult.linked,
            sessionState.id,
            playerId
          );

          const scoringResult = await applyHeadlineEvaluation({
            sessionId: sessionState.id,
            playerId,
            headlineId: insertedRow.id,
            plausibilityLevel: transformResult.plausibility.band as PlausibilityLevel,
            selectedBand: transformResult.selectedBand as PlausibilityLevel,
            uniqueOtherAuthors,
            aiPlanetRankings: transformResult.planets.top3.map((p) => p.id),
            roundNo: sessionState.currentRound,
          });

          const updatedBreakdowns = await getPlayerScoreBreakdowns(sessionState.id);

          // broadcast updated leaderboard with breakdowns
          io.to(roomName).emit('leaderboard:update', {
            leaderboard: scoringResult.leaderboard.map((entry) => ({
              ...entry,
              scoreBreakdown: updatedBreakdowns.get(entry.playerId) ?? {
                baseline: 0, plausibility: 0, connection: 0, planetBonus: 0,
              },
            })),
            lastScoredHeadline: {
              headlineId: insertedRow.id,
              playerId,
              breakdown: scoringResult.breakdown,
              newTotalScore: scoringResult.newTotalScore,
            },
          });

          console.log(
            `Scoring for ${player.nickname}: ` +
            `baseline=${scoringResult.breakdown.baseline} + ` +
            `plausibility=${scoringResult.breakdown.plausibility} (band ${transformResult.plausibility.band}) + ` +
            `connection=${scoringResult.breakdown.connectionScore} (${uniqueOtherAuthors} unique others) + ` +
            `planet=${scoringResult.breakdown.planetBonus} ` +
            `= +${scoringResult.breakdown.total} pts (total: ${scoringResult.newTotalScore})`
          );
        } catch (scoringError) {
          console.error('Error applying scoring:', scoringError);
          // don't fail the headline submission if scoring fails
        }
      } catch (error) {
        console.error('Error in headline:submit:', error);
        callback?.({
          success: false,
          error: 'Failed to submit headline',
        });
      }
    });

    /**
     * get headlines for a session (feed loading)
     */
    socket.on('headline:get_feed', async (data: { joinCode: string; roundNo?: number }, callback) => {
      try {
        const { joinCode, roundNo } = data;

        if (!joinCode) {
          callback?.({
            success: false,
            error: 'Missing joinCode',
          });
          return;
        }

        // verify session exists
        const sessionState = await getSessionState(joinCode);
        if (!sessionState) {
          callback?.({
            success: false,
            error: 'Session not found',
          });
          return;
        }

        // build query - optionally filter by round
        let query = `
          SELECT
            h.id,
            h.session_id,
            h.player_id,
            p.nickname as player_nickname,
            h.round_no,
            h.headline_text as story_direction,
            COALESCE(h.selected_headline, h.headline_text) as text,
            h.dice_roll,
            h.selected_band,
            h.plausibility_level,
            h.planet_1,
            h.planet_2,
            h.planet_3,
            h.band1_headline,
            h.band2_headline,
            h.band3_headline,
            h.band4_headline,
            h.band5_headline,
            h.baseline_score,
            h.plausibility_score,
            h.others_story_score,
            h.planet_bonus_score,
            h.total_headline_score,
            h.created_at,
            h.in_game_submitted_at
          FROM game_session_headlines h
          JOIN session_players p ON h.player_id = p.id
          WHERE h.session_id = $1
        `;
        const params: any[] = [sessionState.id];

        if (roundNo !== undefined) {
          query += ` AND h.round_no = $2`;
          params.push(roundNo);
        }

        query += ` ORDER BY h.created_at ASC`;

        const result = await pool.query(query, params);

        const headlines = result.rows.map((row) => ({
          id: row.id,
          sessionId: row.session_id,
          playerId: row.player_id,
          playerNickname: row.player_nickname,
          roundNo: row.round_no,
          storyDirection: row.story_direction,
          text: row.text,
          diceRoll: row.dice_roll,
          selectedBand: row.selected_band,
          plausibilityBand: row.plausibility_level,
          planets: [row.planet_1, row.planet_2, row.planet_3].filter(Boolean),
          allBands: row.band1_headline ? {
            band1: row.band1_headline,
            band2: row.band2_headline,
            band3: row.band3_headline,
            band4: row.band4_headline,
            band5: row.band5_headline,
          } : null,
          baselineScore: row.baseline_score ?? null,
          plausibilityScore: row.plausibility_score ?? null,
          connectionScore: row.others_story_score ?? null,
          planetBonusScore: row.planet_bonus_score ?? null,
          totalScore: row.total_headline_score ?? null,
          createdAt: new Date(row.created_at).toISOString(),
          inGameSubmittedAt: row.in_game_submitted_at
            ? new Date(row.in_game_submitted_at).toISOString()
            : null,
        }));

        callback?.({
          success: true,
          headlines,
        });
      } catch (error) {
        console.error('Error in headline:get_feed:', error);
        callback?.({
          success: false,
          error: 'Failed to get headlines',
        });
      }
    });

    /**
     * get round summary (for reconnecting clients)
     */
    socket.on('round:get_summary', async (data: { joinCode: string; roundNo: number }, callback) => {
      try {
        const { joinCode, roundNo } = data;

        if (!joinCode || roundNo === undefined) {
          callback?.({
            success: false,
            error: 'Missing joinCode or roundNo',
          });
          return;
        }

        const sessionId = await getSessionIdFromJoinCode(joinCode);
        if (!sessionId) {
          callback?.({
            success: false,
            error: 'Session not found',
          });
          return;
        }

        const summaryData = await getRoundSummary(sessionId, roundNo);

        if (!summaryData) {
          callback?.({
            success: true,
            status: 'pending',
            summary: null,
            error: null,
          });
          return;
        }

        callback?.({
          success: true,
          status: summaryData.status,
          summaryType: summaryData.summaryType,
          summary: summaryData.summary,
          error: summaryData.error,
        });
      } catch (error) {
        console.error('Error in round:get_summary:', error);
        callback?.({
          success: false,
          error: 'Failed to get round summary',
        });
      }
    });
  });

  console.log('✅ Lobby Socket.IO handlers initialized');
}

