import { useEffect, useRef, useState, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';

const SOCKET_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001';

export interface ScoreBreakdown {
  baseline: number;
  plausibility: number;
  connection: number;
  planetBonus: number;
}

/** one row of a player's usage-ranked planet panel */
export interface PlanetPanelEntry {
  id: string;
  usage: number;
  band: 0 | 1 | 2;
}

export interface Player {
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
  scoreBreakdown?: ScoreBreakdown;
}

interface SessionState {
  id: string;
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
  players: Player[];
}

export interface Headline {
  id: string;
  sessionId: string;
  playerId: string;
  playerNickname: string;
  roundNo: number;
  text: string;
  /** dice-rolled band of the displayed headline variant (1-5); drives typography */
  selectedBand?: number | null;
  /** ai-assessed plausibility band (1-5) */
  plausibilityBand?: number | null;
  createdAt: string;
  inGameSubmittedAt: string | null;
  baselineScore?: number | null;
  plausibilityScore?: number | null;
  connectionScore?: number | null;
  planetBonusScore?: number | null;
  totalScore?: number | null;
  planets?: string[];
}

export interface HighlightedHeadline {
  headline: string;
  source: string;
  significance: string;
}

export interface RoundSummaryOutput {
  narrative: string;
  themes: string[];
  highlightedHeadlines: HighlightedHeadline[];
  dominantPlanets?: string[];
  roundStats: {
    headlineCount: number;
    playerCount: number;
  };
}

export interface RoundSummary {
  roundNo: number;
  status: 'pending' | 'generating' | 'completed' | 'error';
  summary: RoundSummaryOutput | null;
  error: string | null;
}

export interface NarrativeReport {
  character: {
    name: string;
    role: string;
    era: string;
  };
  story: string;
  themes_touched: string[];
}

export interface NarrativeSummaryOutput {
  reports: NarrativeReport[];
}

export interface FinalSummary {
  status: 'pending' | 'generating' | 'completed' | 'error';
  summary: NarrativeSummaryOutput | null;
  error: string | null;
}

export interface WorldHelperAnswer {
  answerText: string;
  headlineRefs: Array<{ id: string; reason: string }>;
  entityRefs: Array<{ id: string; name: string; reason: string }>;
  edgeRefs: Array<{
    id: string;
    sourceName: string;
    targetName: string;
    relationType: string;
    reason: string;
  }>;
  graphSummary: {
    note: string;
    entities: Array<{ id: string; name: string; summary: string }>;
    edges: Array<{
      id: string;
      sourceName: string;
      targetName: string;
      relationType: string;
      summary: string;
    }>;
  };
  suggestedQuestions: string[];
  confidence: 'low' | 'medium' | 'high';
}

export interface WorldHelperMessage {
  id: string;
  sessionId: string;
  playerId: string;
  playerNickname?: string;
  question: string;
  streamedText: string;
  answer: WorldHelperAnswer | null;
  citedHeadlineIds: string[];
  citedNodeIds: string[];
  citedEdgeIds: string[];
  status: 'pending' | 'streaming' | 'completed' | 'error';
  model: string | null;
  usage: Record<string, unknown>;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

interface SubmitHeadlineResult {
  success: boolean;
  headline?: Headline;
  error?: string;
  cooldownMs?: number;
}

interface WorldHelperAskResult {
  success: boolean;
  error?: string;
}

interface UseSocketReturn {
  socket: Socket | null;
  connected: boolean;
  sessionState: SessionState | null;
  headlines: Headline[];
  roundSummary: RoundSummary | null;
  finalSummary: FinalSummary | null;
  worldHelperMessages: WorldHelperMessage[];
  joinLobby: (joinCode: string, playerId: string) => Promise<boolean>;
  leaveLobby: () => void;
  startGame: (joinCode: string) => Promise<boolean>;
  submitHeadline: (joinCode: string, headline: string) => Promise<SubmitHeadlineResult>;
  loadHeadlines: (joinCode: string, roundNo?: number) => Promise<boolean>;
  requestSummary: (joinCode: string, roundNo: number) => Promise<boolean>;
  requestFinalSummary: (joinCode: string, roundNo: number) => Promise<boolean>;
  loadWorldHelperHistory: (joinCode: string) => Promise<boolean>;
  askWorldHelper: (joinCode: string, question: string) => Promise<WorldHelperAskResult>;
}

export function useSocket(): UseSocketReturn {
  const socketRef = useRef<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [sessionState, setSessionState] = useState<SessionState | null>(null);
  const [headlines, setHeadlines] = useState<Headline[]>([]);
  const [roundSummary, setRoundSummary] = useState<RoundSummary | null>(null);
  const [finalSummary, setFinalSummary] = useState<FinalSummary | null>(null);
  const [worldHelperMessages, setWorldHelperMessages] = useState<WorldHelperMessage[]>([]);
  const rejoinRef = useRef<{ joinCode: string; playerId: string } | null>(null);

  useEffect(() => {
    // initialize socket connection
    const socket = io(SOCKET_URL, {
      autoConnect: true,
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: 5,
    });

    socketRef.current = socket;

    socket.on('connect', () => {
      console.log('Socket connected:', socket.id);
      setConnected(true);
      if (rejoinRef.current) {
        const { joinCode, playerId } = rejoinRef.current;
        socket.emit(
          'lobby:join',
          { joinCode, playerId },
          (response: { success: boolean; state?: SessionState; error?: string }) => {
            if (response.success && response.state) {
              setSessionState(response.state);
              socket.emit('headline:get_feed', { joinCode }, (feedRes: { headlines?: Headline[] }) => {
                if (feedRes.headlines) setHeadlines(feedRes.headlines);
              });
            }
          }
        );
      }
    });

    socket.on('disconnect', (reason) => {
      console.log('Socket disconnected:', reason);
      setConnected(false);
    });

    socket.on('connect_error', (error) => {
      console.error('Socket connection error:', error);
      setConnected(false);
    });

    // listen for lobby events
    socket.on('lobby:player_joined', (data: { playerId: string; player: Player }) => {
      console.log('Player joined:', data.player);
      setSessionState((prev) => {
        if (!prev) return prev;
        // add player if not already in the list
        if (!prev.players.some((p) => p.id === data.playerId)) {
          return {
            ...prev,
            players: [...prev.players, data.player],
          };
        }
        return prev;
      });
    });

    socket.on('lobby:game_started', (data: { state: SessionState }) => {
      console.log('Game started:', data.state);
      setSessionState(data.state);
    });

    // game state updates (phase transitions, etc.)
    socket.on('game:state', (state: SessionState) => {
      console.log('Game state updated:', state);
      setSessionState(state);
      // clear round summary only when returning to playing — keep it for break and finished
      if (state.phase === 'PLAYING' || state.phase === 'TUTORIAL' || state.phase === 'WAITING') {
        setRoundSummary(null);
      }
    });

    // round summary updates
    socket.on('round:summary', (data: { roundNo: number; status: string; summary?: RoundSummaryOutput; error?: string }) => {
      console.log('Round summary update:', data);
      setRoundSummary({
        roundNo: data.roundNo,
        status: data.status as RoundSummary['status'],
        summary: data.summary ?? null,
        error: data.error ?? null,
      });
    });

    // final narrative summary updates (game-end page)
    socket.on('game:final_summary', (data: { roundNo: number; status: string; summary?: NarrativeSummaryOutput; error?: string }) => {
      console.log('Final summary update:', data);
      setFinalSummary({
        status: data.status as FinalSummary['status'],
        summary: data.summary ?? null,
        error: data.error ?? null,
      });
    });

    // new headlines
    socket.on('headline:new', (headline: Headline) => {
      console.log('New headline:', headline);
      setHeadlines((prev) => {
        if (prev.some((h) => h.id === headline.id)) {
          return prev;
        }
        return [...prev, headline];
      });
    });

    // leaderboard updates (real-time score changes)
    socket.on('leaderboard:update', (data: {
      leaderboard: { playerId: string; totalScore: number; scoreBreakdown?: ScoreBreakdown; planetPanel?: PlanetPanelEntry[] }[];
      lastScoredHeadline?: {
        headlineId?: string;
        playerId: string;
        breakdown?: { baseline: number; plausibility: number; connectionScore: number; planetBonus: number; total: number };
      };
    }) => {
      console.log('Leaderboard updated:', data);
      setSessionState((prev) => {
        if (!prev) return prev;
        const updatedPlayers = prev.players.map((p) => {
          const entry = data.leaderboard.find((e) => e.playerId === p.id);
          if (!entry) return p;
          return {
            ...p,
            totalScore: entry.totalScore,
            scoreBreakdown: entry.scoreBreakdown ?? p.scoreBreakdown,
            // a usage change re-ranks every player's panel
            planetPanel: entry.planetPanel ?? p.planetPanel,
          };
        });
        return { ...prev, players: updatedPlayers };
      });

      // patch headline with its score breakdown
      if (data.lastScoredHeadline?.headlineId && data.lastScoredHeadline.breakdown) {
        const { headlineId, breakdown } = data.lastScoredHeadline;
        setHeadlines((prev) =>
          prev.map((h) =>
            h.id === headlineId
              ? {
                  ...h,
                  baselineScore: breakdown.baseline,
                  plausibilityScore: breakdown.plausibility,
                  connectionScore: breakdown.connectionScore,
                  planetBonusScore: breakdown.planetBonus,
                  totalScore: breakdown.total,
                }
              : h
          )
        );
      }
    });

    const upsertHelperMessage = (
      matcher: (message: WorldHelperMessage) => boolean,
      patch: Partial<WorldHelperMessage>
    ) => {
      setWorldHelperMessages((prev) => {
        const index = prev.findIndex(matcher);
        if (index === -1) return prev;
        const next = [...prev];
        next[index] = { ...next[index], ...patch };
        return next;
      });
    };

    socket.on('world_helper:delta', (payload: {
      messageId: string;
      clientRequestId?: string;
      delta: string;
      text: string;
    }) => {
      const pendingId = payload.clientRequestId ? `pending:${payload.clientRequestId}` : '';
      upsertHelperMessage(
        (message) => message.id === payload.messageId || message.id === pendingId,
        {
          id: payload.messageId,
          streamedText: payload.text,
          status: 'streaming',
          error: null,
        }
      );
    });

    socket.on('world_helper:complete', (payload: {
      messageId: string;
      clientRequestId?: string;
      message: WorldHelperMessage;
    }) => {
      const pendingId = payload.clientRequestId ? `pending:${payload.clientRequestId}` : '';
      setWorldHelperMessages((prev) => {
        const index = prev.findIndex((message) => message.id === payload.messageId || message.id === pendingId);
        if (index === -1) return [...prev, payload.message];
        const next = [...prev];
        next[index] = payload.message;
        return next;
      });
    });

    socket.on('world_helper:error', (payload: {
      messageId?: string;
      clientRequestId?: string;
      error: string;
    }) => {
      const pendingId = payload.clientRequestId ? `pending:${payload.clientRequestId}` : '';
      upsertHelperMessage(
        (message) => Boolean(payload.messageId && message.id === payload.messageId) || message.id === pendingId,
        {
          id: payload.messageId ?? pendingId,
          status: 'error',
          error: payload.error,
        }
      );
    });

    return () => {
      socket.disconnect();
    };
  }, []);

  const joinLobby = async (joinCode: string, playerId: string): Promise<boolean> => {
    return new Promise((resolve) => {
      if (!socketRef.current) {
        resolve(false);
        return;
      }

      socketRef.current.emit(
        'lobby:join',
        { joinCode, playerId },
        (response: { success: boolean; state?: SessionState; error?: string }) => {
          if (response.success && response.state) {
            setSessionState(response.state);
            rejoinRef.current = { joinCode, playerId };
            resolve(true);
          } else {
            console.error('Failed to join lobby:', response.error);
            resolve(false);
          }
        }
      );
    });
  };

  const leaveLobby = useCallback(() => {
    rejoinRef.current = null;
    if (socketRef.current) {
      socketRef.current.emit('lobby:leave');
      setSessionState(null);
      setHeadlines([]);
      setRoundSummary(null);
      setFinalSummary(null);
      setWorldHelperMessages([]);
    }
  }, []);

  const startGame = useCallback(async (joinCode: string): Promise<boolean> => {
    return new Promise((resolve) => {
      if (!socketRef.current) {
        resolve(false);
        return;
      }

      socketRef.current.emit(
        'lobby:start_game',
        { joinCode },
        (response: { success: boolean; state?: SessionState; error?: string }) => {
          if (response.success) {
            console.log('Game started successfully');
            resolve(true);
          } else {
            console.error('Failed to start game:', response.error);
            alert(response.error || 'Failed to start game');
            resolve(false);
          }
        }
      );
    });
  }, []);

  const submitHeadline = useCallback(async (joinCode: string, headline: string): Promise<SubmitHeadlineResult> => {
    return new Promise((resolve) => {
      if (!socketRef.current) {
        resolve({ success: false, error: 'Not connected' });
        return;
      }

      socketRef.current.emit(
        'headline:submit',
        { joinCode, headline },
        (response: SubmitHeadlineResult) => {
          if (response.success) {
            console.log('Headline submitted:', response.headline);
          } else {
            console.error('Failed to submit headline:', response.error);
          }
          resolve(response);
        }
      );
    });
  }, []);

  const loadHeadlines = useCallback(async (joinCode: string, roundNo?: number): Promise<boolean> => {
    return new Promise((resolve) => {
      if (!socketRef.current) {
        resolve(false);
        return;
      }

      socketRef.current.emit(
        'headline:get_feed',
        { joinCode, roundNo },
        (response: { success: boolean; headlines?: Headline[]; error?: string }) => {
          if (response.success && response.headlines) {
            setHeadlines(response.headlines);
            resolve(true);
          } else {
            console.error('Failed to load headlines:', response.error);
            resolve(false);
          }
        }
      );
    });
  }, []);

  const requestSummary = useCallback(async (joinCode: string, roundNo: number): Promise<boolean> => {
    return new Promise((resolve) => {
      if (!socketRef.current) {
        resolve(false);
        return;
      }

      socketRef.current.emit(
        'round:get_summary',
        { joinCode, roundNo },
        (response: { success: boolean; status?: string; summaryType?: string; summary?: RoundSummaryOutput; error?: string }) => {
          if (response.success) {
            // only set as roundsummary if it's a historical recap, not narrative
            if (response.summaryType !== 'narrative') {
              setRoundSummary({
                roundNo,
                status: (response.status ?? 'pending') as RoundSummary['status'],
                summary: response.summary ?? null,
                error: response.error ?? null,
              });
            }
            resolve(true);
          } else {
            console.error('Failed to get round summary:', response.error);
            resolve(false);
          }
        }
      );
    });
  }, []);

  const requestFinalSummary = useCallback(async (joinCode: string, roundNo: number): Promise<boolean> => {
    return new Promise((resolve) => {
      if (!socketRef.current) {
        resolve(false);
        return;
      }

      socketRef.current.emit(
        'round:get_summary',
        { joinCode, roundNo },
        (response: { success: boolean; status?: string; summaryType?: string; summary?: NarrativeSummaryOutput; error?: string }) => {
          if (response.success && response.summaryType === 'narrative') {
            setFinalSummary({
              status: (response.status ?? 'pending') as FinalSummary['status'],
              summary: response.summary ?? null,
              error: response.error ?? null,
            });
            resolve(true);
          } else {
            // not a narrative summary or failed
            resolve(false);
          }
        }
      );
    });
  }, []);

  const loadWorldHelperHistory = useCallback(async (joinCode: string): Promise<boolean> => {
    return new Promise((resolve) => {
      if (!socketRef.current) {
        resolve(false);
        return;
      }

      socketRef.current.emit(
        'world_helper:get_history',
        { joinCode },
        (response: { success: boolean; messages?: WorldHelperMessage[]; error?: string }) => {
          if (response.success && response.messages) {
            setWorldHelperMessages(response.messages);
            resolve(true);
          } else {
            console.error('Failed to load world helper history:', response.error);
            resolve(false);
          }
        }
      );
    });
  }, []);

  const askWorldHelper = useCallback(async (joinCode: string, question: string): Promise<WorldHelperAskResult> => {
    return new Promise((resolve) => {
      if (!socketRef.current) {
        resolve({ success: false, error: 'Not connected' });
        return;
      }

      const trimmedQuestion = question.trim();
      if (!trimmedQuestion) {
        resolve({ success: false, error: 'Question cannot be empty' });
        return;
      }

      const clientRequestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const now = new Date().toISOString();
      setWorldHelperMessages((prev) => [
        ...prev,
        {
          id: `pending:${clientRequestId}`,
          sessionId: sessionState?.id ?? '',
          playerId: rejoinRef.current?.playerId ?? '',
          question: trimmedQuestion,
          streamedText: '',
          answer: null,
          citedHeadlineIds: [],
          citedNodeIds: [],
          citedEdgeIds: [],
          status: 'streaming',
          model: null,
          usage: {},
          error: null,
          createdAt: now,
          completedAt: null,
        },
      ]);

      socketRef.current.emit(
        'world_helper:ask',
        { joinCode, question: trimmedQuestion, clientRequestId },
        (response: WorldHelperAskResult) => {
          if (!response.success) {
            setWorldHelperMessages((prev) =>
              prev.map((message) =>
                message.id === `pending:${clientRequestId}`
                  ? { ...message, status: 'error', error: response.error ?? 'World helper failed' }
                  : message
              )
            );
          }
          resolve(response);
        }
      );
    });
  }, [sessionState?.id]);

  return {
    socket: socketRef.current,
    connected,
    sessionState,
    headlines,
    roundSummary,
    finalSummary,
    worldHelperMessages,
    joinLobby,
    leaveLobby,
    startGame,
    submitHeadline,
    loadHeadlines,
    requestSummary,
    requestFinalSummary,
    loadWorldHelperHistory,
    askWorldHelper,
  };
}

