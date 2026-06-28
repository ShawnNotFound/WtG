import { useState, useEffect } from 'react';
import { Routes, Route, useNavigate, Navigate } from 'react-router-dom';
import { HostLobby } from './components/HostLobby';
import { JoinLobby } from './components/JoinLobby';
import { JoinByLinkPage } from './pages/JoinByLinkPage';
import { AdminPage } from './pages/AdminPage';
import { AdminSummaryPage } from './pages/AdminSummaryPage';
import { EvaluationPage } from './pages/EvaluationPage';
import { useSocket } from './hooks/useSocket';
import { Card, Button, DropdownSelect } from './components/ui';
import {
  AiProvider,
  baseUrlForProvider,
  defaultModelForProvider,
  modelOptionsForProvider,
} from './lib/modelOptions';

const API_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001';

const PROVIDER_OPTIONS = [
  { label: 'DeepSeek', value: 'deepseek' },
  { label: 'OpenAI', value: 'openai' },
];

const validationMessage = (data: any, fallback: string) => {
  const detailMessages = Array.isArray(data?.details)
    ? data.details
        .map((detail: any) => detail?.message)
        .filter((message: unknown): message is string => typeof message === 'string' && message.length > 0)
    : [];

  return detailMessages[0] ?? data?.message ?? data?.error ?? fallback;
};

interface InitialAiPlayer {
  nickname: string;
  stylePrompt: string;
  creativity: number;
  submitEverySeconds: number;
  provider: AiProvider;
  model: string;
}

interface LlmConfig {
  provider: AiProvider;
  model: string;
  baseUrl: string;
}

type ModuleLlmName = 'juror' | 'world' | 'summary' | 'helper';

interface WorldStateConfig {
  enabled: boolean;
  allowCycles: boolean;
  maxPropagationDepth: number;
  maxNodeReactions: number;
  maxEventsPerNode: number;
  nodeAgentConcurrency: number;
  storeUnaffectedDecisions: boolean;
}

interface SummaryConfig {
  roundSummaries: boolean;
  finalNarrative: boolean;
}

const MODULE_LLM_LABELS: Array<{ key: ModuleLlmName; label: string }> = [
  { key: 'juror', label: 'Juror' },
  { key: 'world', label: 'World Graph' },
  { key: 'summary', label: 'Summaries' },
  { key: 'helper', label: 'World Helper' },
];

const createDefaultLlmConfig = (provider: AiProvider = 'deepseek'): LlmConfig => ({
  provider,
  model: defaultModelForProvider(provider),
  baseUrl: baseUrlForProvider(provider),
});

const createInitialAiPlayer = (index: number): InitialAiPlayer => ({
  nickname: `AI Player ${index + 1}`,
  stylePrompt: 'Strategic, grounded, specific, and slightly provocative.',
  creativity: 1.0,
  submitEverySeconds: 0,
  provider: 'deepseek',
  model: defaultModelForProvider('deepseek'),
});

function App() {
  const navigate = useNavigate();
  const [nickname, setNickname] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [initialized, setInitialized] = useState(false);
  const [llmConfig, setLlmConfig] = useState<LlmConfig>({
    provider: 'deepseek',
    model: defaultModelForProvider('deepseek'),
    baseUrl: baseUrlForProvider('deepseek'),
  });
  const [showAdvancedConfig, setShowAdvancedConfig] = useState(false);
  const [playMinutes, setPlayMinutes] = useState(8);
  const [breakMinutes, setBreakMinutes] = useState(3);
  const [maxRounds, setMaxRounds] = useState(4);
  const [timelineSpeedRatio, setTimelineSpeedRatio] = useState(60);
  const [summaryConfig, setSummaryConfig] = useState<SummaryConfig>({
    roundSummaries: true,
    finalNarrative: true,
  });
  const [worldStateConfig, setWorldStateConfig] = useState<WorldStateConfig>({
    enabled: true,
    allowCycles: true,
    maxPropagationDepth: 2,
    maxNodeReactions: 20,
    maxEventsPerNode: 2,
    nodeAgentConcurrency: 4,
    storeUnaffectedDecisions: true,
  });
  const [moduleLlmConfig, setModuleLlmConfig] = useState<Record<ModuleLlmName, LlmConfig>>({
    juror: createDefaultLlmConfig(),
    world: createDefaultLlmConfig(),
    summary: createDefaultLlmConfig(),
    helper: createDefaultLlmConfig(),
  });
  const [initialAiPlayers, setInitialAiPlayers] = useState<InitialAiPlayer[]>([]);

  const [sessionData, setSessionData] = useState<{
    joinCode: string;
    playerId: string;
    isHost: boolean;
  } | null>(null);

  const {
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
  } = useSocket();

  // load session from localstorage on mount
  useEffect(() => {
    const stored = localStorage.getItem('futureHeadlines_session');
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        // skip auto-rejoin on routes that should not be hijacked by an old lobby session
        const currentPath = window.location.pathname;
        const isJoinPage = currentPath.startsWith('/join/');
        const isAdminPage = currentPath.startsWith('/admin') || currentPath === '/code/admin';
        if (!isJoinPage && !isAdminPage && parsed.joinCode && parsed.playerId) {
          setSessionData(parsed);
          joinLobby(parsed.joinCode, parsed.playerId);
          navigate(`/lobby/${parsed.joinCode}`, { replace: true });
        }
      } catch (err) {
        console.error('Failed to parse stored session:', err);
        localStorage.removeItem('futureHeadlines_session');
      }
    }
    setInitialized(true);
  }, []);

  // persist sessiondata to localstorage
  useEffect(() => {
    if (sessionData) {
      localStorage.setItem('futureHeadlines_session', JSON.stringify(sessionData));
    }
  }, [sessionData]);

  const handleCreateSession = async () => {
    const trimmedNickname = nickname.trim();
    if (!trimmedNickname) {
      setError('Please enter a nickname');
      return;
    }
    if (trimmedNickname.length < 3) {
      setError('Nickname must be at least 3 characters');
      return;
    }

    setLoading(true);
    setError('');

    try {
      const response = await fetch(`${API_URL}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hostNickname: trimmedNickname,
          llmConfig: {
            ...llmConfig,
            model: llmConfig.model || defaultModelForProvider(llmConfig.provider),
            baseUrl: llmConfig.baseUrl.trim() || baseUrlForProvider(llmConfig.provider),
          },
          moduleLlmConfig: Object.fromEntries(
            MODULE_LLM_LABELS.map(({ key }) => {
              const config = moduleLlmConfig[key];
              return [
                key,
                {
                  ...config,
                  model: config.model || defaultModelForProvider(config.provider),
                  baseUrl: config.baseUrl.trim() || baseUrlForProvider(config.provider),
                },
              ];
            })
          ),
          summaryConfig,
          worldStateConfig,
          playMinutes,
          breakMinutes,
          maxRounds,
          timelineSpeedRatio,
          aiPlayers: initialAiPlayers.map((player, index) => ({
            ...player,
            nickname: player.nickname.trim() || `AI Player ${index + 1}`,
            model: player.model || defaultModelForProvider(player.provider),
          })),
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(validationMessage(data, 'Failed to create session'));
      }

      const data = await response.json();
      const newSessionData = {
        joinCode: data.session.joinCode,
        playerId: data.player.id,
        isHost: true,
      };

      setSessionData(newSessionData);

      const joined = await joinLobby(data.session.joinCode, data.player.id);
      if (joined) {
        navigate(`/lobby/${data.session.joinCode}`);
      } else {
        setError('Failed to connect to lobby');
      }
    } catch (err: any) {
      setError(err.message || 'Failed to create session');
    } finally {
      setLoading(false);
    }
  };

  const handleJoinSession = async (joinCode: string, playerNickname: string) => {
    setLoading(true);
    setError('');

    try {
      const code = joinCode.trim().toUpperCase();
      const response = await fetch(`${API_URL}/api/sessions/${code}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nickname: playerNickname.trim() }),
      });

      if (!response.ok) {
        const errData = await response.json();
        // if game already started, try to recover existing player by nickname
        if (response.status === 400 && errData.error === 'Cannot join session') {
          const rejoinResponse = await fetch(`${API_URL}/api/sessions/${code}/rejoin`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nickname: playerNickname.trim() }),
          });
          if (!rejoinResponse.ok) {
            const rejoinData = await rejoinResponse.json();
            throw new Error(validationMessage(rejoinData, 'Game in progress — nickname not found in this session'));
          }
          const rejoinData = await rejoinResponse.json();
          const newSessionData = {
            joinCode: code,
            playerId: rejoinData.player.id,
            isHost: rejoinData.player.isHost,
          };
          setSessionData(newSessionData);
          const joined = await joinLobby(code, rejoinData.player.id);
          if (joined) {
            navigate(`/lobby/${code}`);
          } else {
            setError('Failed to connect to lobby');
          }
          return;
        }
        throw new Error(validationMessage(errData, 'Failed to join session'));
      }

      const data = await response.json();
      const newSessionData = {
        joinCode: data.session.joinCode,
        playerId: data.player.id,
        isHost: false,
      };

      setSessionData(newSessionData);

      const joined = await joinLobby(data.session.joinCode, data.player.id);
      if (joined) {
        navigate(`/lobby/${data.session.joinCode}`);
      } else {
        setError('Failed to connect to lobby');
      }
    } catch (err: any) {
      setError(err.message || 'Failed to join session');
    } finally {
      setLoading(false);
    }
  };

  const handleBack = () => {
    leaveLobby();
    setSessionData(null);
    localStorage.removeItem('futureHeadlines_session');
    navigate('/');
    setNickname('');
    setError('');
  };

  const setAiPlayerCount = (count: number) => {
    const safeCount = Math.max(0, Math.min(8, count));
    setInitialAiPlayers((prev) => {
      if (safeCount <= prev.length) {
        return prev.slice(0, safeCount);
      }
      return [
        ...prev,
        ...Array.from({ length: safeCount - prev.length }, (_, i) => createInitialAiPlayer(prev.length + i)),
      ];
    });
  };

  const updateInitialAiPlayer = (index: number, patch: Partial<InitialAiPlayer>) => {
    setInitialAiPlayers((prev) =>
      prev.map((player, i) => (i === index ? { ...player, ...patch } : player))
    );
  };

  const updateModuleLlmConfig = (moduleName: ModuleLlmName, patch: Partial<LlmConfig>) => {
    setModuleLlmConfig((prev) => ({
      ...prev,
      [moduleName]: {
        ...prev[moduleName],
        ...patch,
      },
    }));
  };

  const updateModuleProvider = (moduleName: ModuleLlmName, provider: AiProvider) => {
    updateModuleLlmConfig(moduleName, {
      provider,
      model: defaultModelForProvider(provider),
      baseUrl: baseUrlForProvider(provider),
    });
  };

  const handleStartGame = async () => {
    if (!sessionData) return;
    const success = await startGame(sessionData.joinCode);
    if (success) console.log('Game started!');
  };

  const handleSubmitHeadline = async (headline: string) => {
    if (!sessionData) return { success: false, error: 'Not connected to a session' };
    return submitHeadline(sessionData.joinCode, headline);
  };

  const handleAskWorldHelper = async (question: string) => {
    if (!sessionData) return { success: false, error: 'Not connected to a session' };
    return askWorldHelper(sessionData.joinCode, question);
  };

  const handleLoadWorldHelperHistory = async () => {
    if (!sessionData) return false;
    return loadWorldHelperHistory(sessionData.joinCode);
  };

  const handleRefreshLobby = async () => {
    if (!sessionData) return false;
    return joinLobby(sessionData.joinCode, sessionData.playerId);
  };

  // load headlines when phase changes to playing
  useEffect(() => {
    if (sessionState?.phase === 'PLAYING' && sessionData?.joinCode) {
      loadHeadlines(sessionData.joinCode);
    }
  }, [sessionState?.phase, sessionData?.joinCode, loadHeadlines]);

  // request round summary on reconnect during break
  useEffect(() => {
    if (sessionState?.phase === 'BREAK' && sessionData?.joinCode && !roundSummary) {
      requestSummary(sessionData.joinCode, sessionState.currentRound);
    }
  }, [sessionState?.phase, sessionState?.currentRound, sessionData?.joinCode, roundSummary, requestSummary]);

  // request final narrative summary on finished and load all headlines for game-end stats
  useEffect(() => {
    if (sessionState?.phase === 'FINISHED' && sessionData?.joinCode) {
      if (!finalSummary) {
        requestFinalSummary(sessionData.joinCode, sessionState.currentRound);
      }
      loadHeadlines(sessionData.joinCode);
    }
  }, [sessionState?.phase, sessionState?.currentRound, sessionData?.joinCode, finalSummary, requestFinalSummary, loadHeadlines]);

  const loadingScreen = (
    <div className="h-[100dvh] overflow-hidden bg-gradient-to-b from-gray-50 to-gray-100/80 flex items-center justify-center">
      <div className="text-center">
        <div className="animate-spin rounded-full h-10 w-10 border-2 border-gray-200 border-t-indigo-500 mx-auto mb-3" />
        <p className="text-sm text-gray-400">Loading...</p>
      </div>
    </div>
  );

  const lobbyElement = !initialized ? (
    loadingScreen
  ) : !sessionData ? (
    <Navigate to="/" replace />
  ) : sessionState ? (
    sessionData.isHost ? (
      <HostLobby
        joinCode={sessionState.joinCode}
        players={sessionState.players}
        currentPlayerId={sessionData.playerId}
        phase={sessionState.phase}
        isPaused={sessionState.isPaused}
        currentRound={sessionState.currentRound}
        maxRounds={sessionState.maxRounds}
        playMinutes={sessionState.playMinutes}
        phaseStartedAt={sessionState.phaseStartedAt}
        phaseEndsAt={sessionState.phaseEndsAt}
        pauseRemainingMs={sessionState.pauseRemainingMs}
        serverNow={sessionState.serverNow}
        inGameNow={sessionState.inGameNow}
        timelineSpeedRatio={sessionState.timelineSpeedRatio}
        headlines={headlines}
        roundSummary={roundSummary}
        finalSummary={finalSummary}
        worldHelperMessages={worldHelperMessages}
        onStartGame={handleStartGame}
        onBack={handleBack}
        onRefreshLobby={handleRefreshLobby}
        onSubmitHeadline={handleSubmitHeadline}
        onAskWorldHelper={handleAskWorldHelper}
        onLoadWorldHelperHistory={handleLoadWorldHelperHistory}
      />
    ) : (
      <JoinLobby
        joinCode={sessionState.joinCode}
        players={sessionState.players}
        currentPlayerId={sessionData.playerId}
        isHost={sessionData.isHost}
        phase={sessionState.phase}
        isPaused={sessionState.isPaused}
        currentRound={sessionState.currentRound}
        maxRounds={sessionState.maxRounds}
        playMinutes={sessionState.playMinutes}
        phaseStartedAt={sessionState.phaseStartedAt}
        phaseEndsAt={sessionState.phaseEndsAt}
        pauseRemainingMs={sessionState.pauseRemainingMs}
        serverNow={sessionState.serverNow}
        inGameNow={sessionState.inGameNow}
        timelineSpeedRatio={sessionState.timelineSpeedRatio}
        headlines={headlines}
        roundSummary={roundSummary}
        finalSummary={finalSummary}
        worldHelperMessages={worldHelperMessages}
        onBack={handleBack}
        onSubmitHeadline={handleSubmitHeadline}
        onAskWorldHelper={handleAskWorldHelper}
        onLoadWorldHelperHistory={handleLoadWorldHelperHistory}
      />
    )
  ) : (
    loadingScreen
  );

  return (
    <Routes>
      <Route path="/admin" element={<AdminPage />} />
      <Route path="/admin/evaluations" element={<EvaluationPage />} />
      <Route path="/admin/summary/:joinCode" element={<AdminSummaryPage />} />
      <Route path="/code/admin" element={<Navigate to="/admin" replace />} />
      <Route path="/" element={
        <div className="h-[100dvh] overflow-y-auto bg-gradient-to-b from-gray-50 to-gray-100/80 p-4 sm:p-6">
          <div className="mx-auto max-w-4xl w-full space-y-6 py-4 sm:py-8">
            <div className="text-center space-y-1">
              <h1 className="text-4xl font-bold text-gray-900">Future Headlines</h1>
              <p className="text-sm text-gray-500">Create a game and invite players with a link</p>
            </div>

            <div className="flex items-center justify-center gap-2">
              <div className={`w-2 h-2 rounded-full ${connected ? 'bg-emerald-400' : 'bg-red-400'}`} />
              <span className="text-xs text-gray-500">{connected ? 'Connected' : 'Disconnected'}</span>
            </div>

            <Card padding="lg" className="space-y-5">
              <div>
                <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1.5">
                  Nickname
                </label>
                <input
                  type="text"
                  value={nickname}
                  onChange={(e) => setNickname(e.target.value)}
                  placeholder="Enter your nickname"
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:border-transparent bg-gray-50"
                  minLength={3}
                  maxLength={20}
                  onKeyDown={(e) => e.key === 'Enter' && !loading && handleCreateSession()}
                />
              </div>

              <div className="space-y-3 border-t border-gray-100 pt-4">
                <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Game AI Model
                </label>
                <div className="grid gap-2 sm:grid-cols-[160px_1fr]">
                  <DropdownSelect
                    value={llmConfig.provider}
                    options={PROVIDER_OPTIONS}
                    onChange={(value) => {
                      const provider = value as AiProvider;
                      setLlmConfig({
                        provider,
                        model: defaultModelForProvider(provider),
                        baseUrl: baseUrlForProvider(provider),
                      });
                    }}
                    ariaLabel="Game AI provider"
                  />
                  <DropdownSelect
                    value={llmConfig.model}
                    options={modelOptionsForProvider(llmConfig.provider)}
                    onChange={(value) => setLlmConfig((prev) => ({ ...prev, model: value }))}
                    ariaLabel="Game AI model"
                  />
                </div>
                <input
                  type="text"
                  value={llmConfig.baseUrl}
                  onChange={(e) => setLlmConfig((prev) => ({ ...prev, baseUrl: e.target.value }))}
                  maxLength={200}
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg bg-gray-50 focus:outline-none focus:ring-2 focus:ring-indigo-400"
                  aria-label="Game AI base URL"
                />
              </div>

              <div className="space-y-3 border-t border-gray-100 pt-4">
                <button
                  type="button"
                  onClick={() => setShowAdvancedConfig((current) => !current)}
                  className="flex w-full items-center justify-between rounded-lg px-1 py-1 text-left"
                >
                  <span className="text-xs font-medium uppercase tracking-wider text-gray-500">
                    Advanced Configuration
                  </span>
                  <svg
                    className={`h-4 w-4 text-gray-400 transition-transform ${showAdvancedConfig ? 'rotate-180' : ''}`}
                    fill="none"
                    viewBox="0 0 20 20"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 7.5 10 12.5 15 7.5" />
                  </svg>
                </button>

                {showAdvancedConfig && (
                  <div className="space-y-4 rounded-lg border border-gray-100 bg-gray-50/60 p-3">
                    <div className="grid gap-2 sm:grid-cols-4">
                      <label className="text-xs text-gray-500">
                        Play minutes
                        <input
                          type="number"
                          min={0.1}
                          max={120}
                          step={0.1}
                          value={playMinutes}
                          onChange={(e) => setPlayMinutes(Number(e.target.value))}
                          className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-sm"
                        />
                      </label>
                      <label className="text-xs text-gray-500">
                        Break minutes
                        <input
                          type="number"
                          min={0}
                          max={60}
                          step={0.1}
                          value={breakMinutes}
                          onChange={(e) => setBreakMinutes(Number(e.target.value))}
                          className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-sm"
                        />
                      </label>
                      <label className="text-xs text-gray-500">
                        Max rounds
                        <input
                          type="number"
                          min={1}
                          max={20}
                          value={maxRounds}
                          onChange={(e) => setMaxRounds(Number(e.target.value))}
                          className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-sm"
                        />
                      </label>
                      <label className="text-xs text-gray-500">
                        Timeline speed
                        <input
                          type="number"
                          min={0}
                          max={100000}
                          value={timelineSpeedRatio}
                          onChange={(e) => setTimelineSpeedRatio(Number(e.target.value))}
                          className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-sm"
                        />
                      </label>
                    </div>

                    <div className="grid gap-3 sm:grid-cols-2">
                      <label className="flex items-center justify-between rounded-lg border border-gray-100 bg-white px-3 py-2 text-sm text-gray-700">
                        World graph enabled
                        <input
                          type="checkbox"
                          checked={worldStateConfig.enabled}
                          onChange={(e) => setWorldStateConfig((prev) => ({ ...prev, enabled: e.target.checked }))}
                          className="h-4 w-4 accent-indigo-600"
                        />
                      </label>
                      <label className="flex items-center justify-between rounded-lg border border-gray-100 bg-white px-3 py-2 text-sm text-gray-700">
                        Allow graph cycles
                        <input
                          type="checkbox"
                          checked={worldStateConfig.allowCycles}
                          onChange={(e) => setWorldStateConfig((prev) => ({ ...prev, allowCycles: e.target.checked }))}
                          className="h-4 w-4 accent-indigo-600"
                        />
                      </label>
                      <label className="flex items-center justify-between rounded-lg border border-gray-100 bg-white px-3 py-2 text-sm text-gray-700">
                        Round summaries
                        <input
                          type="checkbox"
                          checked={summaryConfig.roundSummaries}
                          onChange={(e) => setSummaryConfig((prev) => ({ ...prev, roundSummaries: e.target.checked }))}
                          className="h-4 w-4 accent-indigo-600"
                        />
                      </label>
                      <label className="flex items-center justify-between rounded-lg border border-gray-100 bg-white px-3 py-2 text-sm text-gray-700">
                        Final narrative
                        <input
                          type="checkbox"
                          checked={summaryConfig.finalNarrative}
                          onChange={(e) => setSummaryConfig((prev) => ({ ...prev, finalNarrative: e.target.checked }))}
                          className="h-4 w-4 accent-indigo-600"
                        />
                      </label>
                    </div>

                    <div className="grid gap-2 sm:grid-cols-5">
                      <label className="text-xs text-gray-500">
                        Depth
                        <input
                          type="number"
                          min={0}
                          max={8}
                          value={worldStateConfig.maxPropagationDepth}
                          onChange={(e) => setWorldStateConfig((prev) => ({ ...prev, maxPropagationDepth: Number(e.target.value) }))}
                          className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-sm"
                        />
                      </label>
                      <label className="text-xs text-gray-500">
                        Reactions
                        <input
                          type="number"
                          min={1}
                          max={200}
                          value={worldStateConfig.maxNodeReactions}
                          onChange={(e) => setWorldStateConfig((prev) => ({ ...prev, maxNodeReactions: Number(e.target.value) }))}
                          className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-sm"
                        />
                      </label>
                      <label className="text-xs text-gray-500">
                        Events/node
                        <input
                          type="number"
                          min={1}
                          max={20}
                          value={worldStateConfig.maxEventsPerNode}
                          onChange={(e) => setWorldStateConfig((prev) => ({ ...prev, maxEventsPerNode: Number(e.target.value) }))}
                          className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-sm"
                        />
                      </label>
                      <label className="text-xs text-gray-500">
                        Concurrency
                        <input
                          type="number"
                          min={1}
                          max={16}
                          value={worldStateConfig.nodeAgentConcurrency}
                          onChange={(e) => setWorldStateConfig((prev) => ({ ...prev, nodeAgentConcurrency: Number(e.target.value) }))}
                          className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-sm"
                        />
                      </label>
                      <label className="flex items-end gap-2 pb-1 text-xs text-gray-500">
                        <input
                          type="checkbox"
                          checked={worldStateConfig.storeUnaffectedDecisions}
                          onChange={(e) => setWorldStateConfig((prev) => ({ ...prev, storeUnaffectedDecisions: e.target.checked }))}
                          className="h-4 w-4 accent-indigo-600"
                        />
                        Store unaffected
                      </label>
                    </div>

                    <div className="space-y-2">
                      <p className="text-xs font-medium uppercase tracking-wider text-gray-400">
                        Module LLM Overrides
                      </p>
                      <div className="grid gap-3 sm:grid-cols-2">
                        {MODULE_LLM_LABELS.map(({ key, label }) => {
                          const config = moduleLlmConfig[key];
                          return (
                            <div key={key} className="space-y-2 rounded-lg border border-gray-100 bg-white p-3">
                              <p className="text-xs font-medium text-gray-500">{label}</p>
                              <div className="grid grid-cols-2 gap-2">
                                <DropdownSelect
                                  value={config.provider}
                                  options={PROVIDER_OPTIONS}
                                  onChange={(value) => updateModuleProvider(key, value as AiProvider)}
                                  ariaLabel={`${label} provider`}
                                  size="sm"
                                  menuClassName="z-[70]"
                                />
                                <DropdownSelect
                                  value={config.model}
                                  options={modelOptionsForProvider(config.provider)}
                                  onChange={(value) => updateModuleLlmConfig(key, { model: value })}
                                  ariaLabel={`${label} model`}
                                  size="sm"
                                  menuClassName="z-[70]"
                                />
                              </div>
                              <input
                                type="text"
                                value={config.baseUrl}
                                onChange={(e) => updateModuleLlmConfig(key, { baseUrl: e.target.value })}
                                maxLength={200}
                                className="w-full rounded-lg border border-gray-200 bg-gray-50 px-2 py-1.5 text-sm"
                                aria-label={`${label} base URL`}
                              />
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                )}
              </div>

              <div className="space-y-3 border-t border-gray-100 pt-4">
                <div className="flex items-center justify-between gap-3">
                  <label className="text-xs font-medium text-gray-500 uppercase tracking-wider">
                    AI Players
                  </label>
                  <input
                    type="number"
                    min={0}
                    max={8}
                    value={initialAiPlayers.length}
                    onChange={(e) => setAiPlayerCount(Number(e.target.value))}
                    className="w-20 px-2 py-1.5 text-sm border border-gray-200 rounded-lg bg-gray-50"
                  />
                </div>

                {initialAiPlayers.length > 0 && (
                  <div className="grid gap-3 sm:grid-cols-2">
                    {initialAiPlayers.map((player, index) => (
                      <div key={index} className="space-y-2 rounded-lg border border-gray-100 p-3">
                        <input
                          type="text"
                          value={player.nickname}
                          onChange={(e) => updateInitialAiPlayer(index, { nickname: e.target.value })}
                          maxLength={20}
                          className="w-full px-2 py-1.5 text-sm border border-gray-200 rounded-lg bg-gray-50"
                        />
                        <textarea
                          value={player.stylePrompt}
                          onChange={(e) => updateInitialAiPlayer(index, { stylePrompt: e.target.value })}
                          maxLength={500}
                          rows={2}
                          className="w-full px-2 py-1.5 text-sm border border-gray-200 rounded-lg bg-gray-50 resize-none"
                        />
                        <div className="grid grid-cols-2 gap-2">
                          <DropdownSelect
                            value={player.provider}
                            options={PROVIDER_OPTIONS}
                            onChange={(value) => {
                              const provider = value as AiProvider;
                              updateInitialAiPlayer(index, { provider, model: defaultModelForProvider(provider) });
                            }}
                            ariaLabel={`${player.nickname || `AI Player ${index + 1}`} provider`}
                            size="sm"
                          />
                          <DropdownSelect
                            value={player.model}
                            options={modelOptionsForProvider(player.provider)}
                            onChange={(value) => updateInitialAiPlayer(index, { model: value })}
                            ariaLabel={`${player.nickname || `AI Player ${index + 1}`} model`}
                            size="sm"
                          />
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <label className="text-xs text-gray-500">
                            Creativity
                            <input
                              type="number"
                              min={0}
                              max={1}
                              step={0.05}
                              value={player.creativity}
                              onChange={(e) => updateInitialAiPlayer(index, { creativity: Number(e.target.value) })}
                              className="mt-1 w-full px-2 py-1.5 text-sm border border-gray-200 rounded-lg bg-gray-50"
                            />
                          </label>
                          <label className="text-xs text-gray-500">
                            Extra delay seconds
                            <input
                              type="number"
                              min={0}
                              max={600}
                              value={player.submitEverySeconds}
                              onChange={(e) => updateInitialAiPlayer(index, { submitEverySeconds: Number(e.target.value) })}
                              className="mt-1 w-full px-2 py-1.5 text-sm border border-gray-200 rounded-lg bg-gray-50"
                            />
                          </label>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {error && (
                <div className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg">
                  {error}
                </div>
              )}

              <Button
                fullWidth
                size="lg"
                onClick={handleCreateSession}
                disabled={loading || !connected}
              >
                {loading ? 'Creating...' : 'Create New Game'}
              </Button>
            </Card>

            <p className="text-xs text-center text-gray-400">
              After creating, you'll get an invite link to share with players.
            </p>
          </div>
        </div>
      } />

      <Route path="/join/:joinCode" element={
        <JoinByLinkPage
          connected={connected}
          loading={loading}
          error={error}
          onJoinSession={handleJoinSession}
        />
      } />

      <Route path="/lobby/:joinCode" element={lobbyElement} />

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default App;
