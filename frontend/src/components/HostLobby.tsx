import { useEffect, useState } from 'react';
import { GameLayout } from './GameLayout';
import { Card, Button, DropdownSelect } from './ui';
import { Headline, RoundSummary as RoundSummaryType, FinalSummary, WorldHelperMessage } from '../hooks/useSocket';
import { useGameTimeProgress } from '../hooks/useGameTimeProgress';
import {
  AiProvider,
  defaultModelForProvider,
  modelOptionsForProvider,
  modelOptionsForValue,
} from '../lib/modelOptions';

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

interface HostLobbyProps {
  title: string;
  joinCode: string;
  players: any[];
  currentPlayerId: string;
  phase: string;
  isPaused?: boolean;
  currentRound: number;
  maxRounds: number;
  playMinutes: number;
  phaseStartedAt: string | null;
  phaseEndsAt: string | null;
  pauseRemainingMs?: number | null;
  serverNow: string;
  inGameNow: string | null;
  timelineSpeedRatio: number;
  headlines: Headline[];
  roundSummary: RoundSummaryType | null;
  finalSummary: FinalSummary | null;
  worldHelperMessages: WorldHelperMessage[];
  onStartGame: () => void;
  onBack: () => void;
  onRefreshLobby: () => Promise<boolean>;
  onSubmitHeadline: (headline: string) => Promise<{ success: boolean; error?: string; cooldownMs?: number }>;
  onAskWorldHelper: (question: string) => Promise<{ success: boolean; error?: string }>;
  onLoadWorldHelperHistory: () => Promise<boolean>;
}

interface AiDraft {
  nickname: string;
  stylePrompt: string;
  creativity: number;
  submitEverySeconds: number;
  provider: AiProvider;
  model: string;
}

const defaultAiDraft: AiDraft = {
  nickname: '',
  stylePrompt: 'Strategic, grounded, specific, and slightly provocative.',
  creativity: 1.0,
  submitEverySeconds: 0,
  provider: 'deepseek',
  model: defaultModelForProvider('deepseek'),
};

export function HostLobby({
  title,
  joinCode,
  players,
  currentPlayerId,
  phase,
  isPaused = false,
  currentRound,
  maxRounds,
  playMinutes,
  phaseStartedAt,
  phaseEndsAt,
  pauseRemainingMs = null,
  serverNow,
  inGameNow,
  timelineSpeedRatio,
  headlines,
  roundSummary,
  finalSummary,
  worldHelperMessages,
  onStartGame,
  onBack,
  onRefreshLobby,
  onSubmitHeadline,
  onAskWorldHelper,
  onLoadWorldHelperHistory,
}: HostLobbyProps) {
  const [copied, setCopied] = useState(false);
  const [aiDraft, setAiDraft] = useState<AiDraft>(defaultAiDraft);
  const [aiEdits, setAiEdits] = useState<Record<string, AiDraft>>({});
  const [aiBusy, setAiBusy] = useState<string | null>(null);
  const [aiError, setAiError] = useState('');

  const { totalGameMins, currentGameMins } = useGameTimeProgress({
    phase,
    isPaused,
    currentRound,
    maxRounds,
    playMinutes,
    phaseStartedAt,
    pauseRemainingMs,
    serverNow,
  });

  const currentPlayer = players.find((p) => p.id === currentPlayerId);
  const planetPanel = currentPlayer?.planetPanel ?? null;
  const myScore = currentPlayer?.totalScore ?? 0;

  const inviteLink = `${window.location.origin}/join/${joinCode}`;
  const aiPlayers = players.filter((p) => p.isAi);

  useEffect(() => {
    setAiEdits((prev) => {
      const next: Record<string, AiDraft> = {};
      for (const player of aiPlayers) {
        next[player.id] = prev[player.id] ?? {
          nickname: player.nickname,
          stylePrompt: player.aiConfig?.stylePrompt ?? defaultAiDraft.stylePrompt,
          creativity: player.aiConfig?.creativity ?? defaultAiDraft.creativity,
          submitEverySeconds: player.aiConfig?.submitEverySeconds ?? defaultAiDraft.submitEverySeconds,
          provider: player.aiConfig?.provider ?? defaultAiDraft.provider,
          model: player.aiConfig?.model ?? defaultModelForProvider(player.aiConfig?.provider ?? defaultAiDraft.provider),
        };
      }
      return next;
    });
  }, [players]);

  const copyInviteLink = () => {
    navigator.clipboard.writeText(inviteLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const requestAi = async (
    url: string,
    method: string,
    body?: Record<string, unknown>
  ) => {
    setAiBusy(method);
    setAiError('');
    try {
      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hostPlayerId: currentPlayerId, ...body }),
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(validationMessage(data, 'AI player request failed'));
      }
      await onRefreshLobby();
    } catch (err: any) {
      setAiError(err.message || 'AI player request failed');
    } finally {
      setAiBusy(null);
    }
  };

  const addAiPlayer = async () => {
    await requestAi(`${API_URL}/api/sessions/${joinCode}/ai-players`, 'POST', {
      nickname: aiDraft.nickname.trim() || undefined,
      stylePrompt: aiDraft.stylePrompt,
      creativity: aiDraft.creativity,
      submitEverySeconds: aiDraft.submitEverySeconds,
      provider: aiDraft.provider,
      model: aiDraft.model || defaultModelForProvider(aiDraft.provider),
    });
    setAiDraft((prev) => ({ ...prev, nickname: '' }));
  };

  const updateAiPlayer = async (playerId: string) => {
    const draft = aiEdits[playerId];
    if (!draft) return;
    await requestAi(`${API_URL}/api/sessions/${joinCode}/ai-players/${playerId}`, 'PATCH', {
      ...draft,
      model: draft.model || defaultModelForProvider(draft.provider),
    });
  };

  const removeAiPlayer = async (playerId: string) => {
    await requestAi(`${API_URL}/api/sessions/${joinCode}/ai-players/${playerId}`, 'DELETE');
  };

  const aiConfigContent = phase === 'WAITING' && (
    <Card padding="md" className="space-y-3">
      <div>
        <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">AI Players</h2>
      </div>

      <div className="grid grid-cols-1 gap-2">
        <input
          type="text"
          value={aiDraft.nickname}
          onChange={(e) => setAiDraft((prev) => ({ ...prev, nickname: e.target.value }))}
          placeholder={`AI Player ${aiPlayers.length + 1}`}
          maxLength={20}
          className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg bg-gray-50 focus:outline-none focus:ring-2 focus:ring-indigo-400"
        />
        <textarea
          value={aiDraft.stylePrompt}
          onChange={(e) => setAiDraft((prev) => ({ ...prev, stylePrompt: e.target.value }))}
          maxLength={500}
          rows={2}
          className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg bg-gray-50 focus:outline-none focus:ring-2 focus:ring-indigo-400 resize-none"
        />
        <div className="grid grid-cols-2 gap-2">
          <div className="text-xs text-gray-500">
            <span>Platform</span>
            <DropdownSelect
              value={aiDraft.provider}
              options={PROVIDER_OPTIONS}
              onChange={(value) => {
                const provider = value as AiDraft['provider'];
                setAiDraft((prev) => ({ ...prev, provider, model: defaultModelForProvider(provider) }));
              }}
              ariaLabel="New AI player provider"
              className="mt-1"
              size="sm"
            />
          </div>
          <div className="text-xs text-gray-500">
            <span>Model</span>
            <DropdownSelect
              value={aiDraft.model}
              options={modelOptionsForProvider(aiDraft.provider)}
              onChange={(value) => setAiDraft((prev) => ({ ...prev, model: value }))}
              ariaLabel="New AI player model"
              className="mt-1"
              size="sm"
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <label className="text-xs text-gray-500">
            Creativity
            <input
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={aiDraft.creativity}
              onChange={(e) => setAiDraft((prev) => ({ ...prev, creativity: Number(e.target.value) }))}
              className="mt-1 w-full px-2 py-1.5 text-sm border border-gray-200 rounded-lg bg-gray-50"
            />
          </label>
          <label className="text-xs text-gray-500">
            Extra delay seconds
            <input
              type="number"
              min={0}
              max={600}
              value={aiDraft.submitEverySeconds}
              onChange={(e) => setAiDraft((prev) => ({ ...prev, submitEverySeconds: Number(e.target.value) }))}
              className="mt-1 w-full px-2 py-1.5 text-sm border border-gray-200 rounded-lg bg-gray-50"
            />
          </label>
        </div>
        <Button variant="secondary" size="sm" onClick={addAiPlayer} disabled={aiBusy !== null}>
          Add AI Player
        </Button>
      </div>

      {aiError && <div className="text-xs text-red-600 bg-red-50 px-3 py-2 rounded-lg">{aiError}</div>}

      {aiPlayers.length > 0 && (
        <div className="space-y-2 pt-2 border-t border-gray-100">
          {aiPlayers.map((player) => {
            const draft = aiEdits[player.id];
            if (!draft) return null;
            return (
              <div key={player.id} className="space-y-2 rounded-lg border border-gray-100 p-2">
                <input
                  type="text"
                  value={draft.nickname}
                  onChange={(e) => setAiEdits((prev) => ({
                    ...prev,
                    [player.id]: { ...draft, nickname: e.target.value },
                  }))}
                  maxLength={20}
                  className="w-full px-2 py-1.5 text-sm border border-gray-200 rounded-lg bg-gray-50"
                />
                <textarea
                  value={draft.stylePrompt}
                  onChange={(e) => setAiEdits((prev) => ({
                    ...prev,
                    [player.id]: { ...draft, stylePrompt: e.target.value },
                  }))}
                  maxLength={500}
                  rows={2}
                  className="w-full px-2 py-1.5 text-sm border border-gray-200 rounded-lg bg-gray-50 resize-none"
                />
                <div className="grid grid-cols-2 gap-2">
                  <DropdownSelect
                    value={draft.provider}
                    options={PROVIDER_OPTIONS}
                    onChange={(value) => {
                      const provider = value as AiDraft['provider'];
                      setAiEdits((prev) => ({
                        ...prev,
                        [player.id]: { ...draft, provider, model: defaultModelForProvider(provider) },
                      }));
                    }}
                    ariaLabel={`${draft.nickname || player.nickname} provider`}
                    size="sm"
                    title="Platform"
                  />
                  <DropdownSelect
                    value={draft.model}
                    options={modelOptionsForValue(draft.provider, draft.model)}
                    onChange={(value) => setAiEdits((prev) => ({
                      ...prev,
                      [player.id]: { ...draft, model: value },
                    }))}
                    ariaLabel={`${draft.nickname || player.nickname} model`}
                    size="sm"
                    title="Model"
                  />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="number"
                    min={0}
                    max={1}
                    step={0.05}
                    value={draft.creativity}
                    onChange={(e) => setAiEdits((prev) => ({
                      ...prev,
                      [player.id]: { ...draft, creativity: Number(e.target.value) },
                    }))}
                    className="w-full px-2 py-1.5 text-sm border border-gray-200 rounded-lg bg-gray-50"
                    title="Creativity"
                  />
                  <input
                    type="number"
                    min={0}
                    max={600}
                    value={draft.submitEverySeconds}
                    onChange={(e) => setAiEdits((prev) => ({
                      ...prev,
                      [player.id]: { ...draft, submitEverySeconds: Number(e.target.value) },
                    }))}
                    className="w-full px-2 py-1.5 text-sm border border-gray-200 rounded-lg bg-gray-50"
                    title="Extra delay after normal cooldown"
                  />
                </div>
                <div className="flex gap-2">
                  <Button variant="secondary" size="sm" onClick={() => updateAiPlayer(player.id)} disabled={aiBusy !== null}>
                    Save
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => removeAiPlayer(player.id)} disabled={aiBusy !== null}>
                    Remove
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );

  const lobbyContent = (
    <>
      <div className="text-center space-y-1">
        <h1 className="text-3xl font-bold text-gray-900">{title || 'Game Lobby'}</h1>
        <p className="text-sm text-gray-500">Share the invite link with players</p>
      </div>

      <Card padding="lg" className="text-center space-y-3">
        <p className="text-xs text-gray-400 uppercase tracking-wider">Game Code</p>
        <span className="text-4xl font-mono font-bold text-indigo-600 tracking-widest block">
          {joinCode}
        </span>
        <div className="pt-2 border-t border-gray-100">
          <Button variant="secondary" size="sm" onClick={copyInviteLink}>
            {copied ? 'Link Copied!' : 'Copy Invite Link'}
          </Button>
        </div>
      </Card>

      <Button
        fullWidth
        size="lg"
        onClick={onStartGame}
        disabled={players.length < 2}
      >
        {players.length < 2 ? 'Need 2+ players to start' : 'Start Game'}
      </Button>

      <p className="text-xs text-center text-gray-400">
        Share the invite link so other players can join.
      </p>

      {aiConfigContent}
    </>
  );

  return (
    <GameLayout
      title={title}
      joinCode={joinCode}
      players={players}
      currentPlayerId={currentPlayerId}
      phase={phase}
      isPaused={isPaused}
      currentRound={currentRound}
      maxRounds={maxRounds}
      phaseEndsAt={phaseEndsAt}
      pauseRemainingMs={pauseRemainingMs}
      serverNow={serverNow}
      inGameNow={inGameNow}
      timelineSpeedRatio={timelineSpeedRatio}
      headlines={headlines}
      roundSummary={roundSummary}
      finalSummary={finalSummary}
      planetPanel={planetPanel}
      myScore={myScore}
      totalGameMins={totalGameMins}
      currentGameMins={currentGameMins}
      onSubmitHeadline={onSubmitHeadline}
      worldHelperMessages={worldHelperMessages}
      onAskWorldHelper={onAskWorldHelper}
      onLoadWorldHelperHistory={onLoadWorldHelperHistory}
      onBack={onBack}
      lobbyContent={lobbyContent}
    />
  );
}
