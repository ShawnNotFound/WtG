import { GameLayout } from './GameLayout';
import { Card } from './ui';
import { Headline, RoundSummary as RoundSummaryType, FinalSummary, WorldHelperMessage } from '../hooks/useSocket';
import { useGameTimeProgress } from '../hooks/useGameTimeProgress';

interface JoinLobbyProps {
  title: string;
  joinCode: string;
  players: any[];
  currentPlayerId: string;
  isHost: boolean;
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
  onBack: () => void;
  onSubmitHeadline: (headline: string) => Promise<{ success: boolean; error?: string; cooldownMs?: number }>;
  onAskWorldHelper: (question: string) => Promise<{ success: boolean; error?: string }>;
  onLoadWorldHelperHistory: () => Promise<boolean>;
}

export function JoinLobby({
  title,
  joinCode,
  players,
  currentPlayerId,
  isHost,
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
  onBack,
  onSubmitHeadline,
  onAskWorldHelper,
  onLoadWorldHelperHistory,
}: JoinLobbyProps) {
  const currentPlayer = players.find((p) => p.id === currentPlayerId);
  const planetPanel = currentPlayer?.planetPanel ?? null;
  const myScore = currentPlayer?.totalScore ?? 0;

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

  const lobbyContent = (
    <>
      <div className="text-center space-y-1">
        <h1 className="text-3xl font-bold text-gray-900">{title || 'Waiting for Game'}</h1>
        <p className="text-sm text-gray-500">Waiting for game start</p>
      </div>

      <Card padding="lg" className="text-center space-y-2">
        <div className="flex items-center justify-center gap-2">
          <div className="w-2.5 h-2.5 bg-emerald-400 rounded-full animate-pulse" />
          <span className="text-sm text-gray-600">Connected</span>
        </div>
        <p className="text-xs text-gray-400">
          {isHost
            ? 'You are the host. Start the game when ready!'
            : 'Waiting for the host to start the game...'}
        </p>
      </Card>

      <p className="text-xs text-center text-gray-400">
        More players can join using the invite link.
      </p>
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
