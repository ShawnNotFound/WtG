import React, { useCallback, useState } from 'react';
import { GameStatus } from './GameStatus';
import { PersonalScore } from './PersonalScore';
import { ScoreBarChart } from './ScoreBarChart';
import { HeadlineFeed } from './HeadlineFeed';
import { HeadlineInput } from './HeadlineInput';
import { PlanetUsagePanel } from './PlanetUsagePanel';
import { InGameDate } from './InGameDate';
import { RoundSummary } from './RoundSummary';
import { ScoreCard } from './ScoreCard';
import { GameEnd } from './GameEnd';
import { PlayerList } from './PlayerList';
import { WorldHelperDrawer } from './WorldHelperDrawer';
import { Button } from './ui';
import {
  Headline,
  RoundSummary as RoundSummaryType,
  FinalSummary,
  PlanetPanelEntry,
  WorldHelperMessage,
} from '../hooks/useSocket';
import { useInGameNow } from '../hooks/useInGameNow';

interface GameLayoutProps {
  title: string;
  joinCode: string;
  players: any[];
  currentPlayerId: string;
  phase: string;
  isPaused?: boolean;
  currentRound: number;
  maxRounds: number;
  phaseEndsAt: string | null;
  pauseRemainingMs?: number | null;
  serverNow: string;
  inGameNow: string | null;
  timelineSpeedRatio: number;
  headlines: Headline[];
  roundSummary: RoundSummaryType | null;
  finalSummary: FinalSummary | null;
  planetPanel: PlanetPanelEntry[] | null;
  myScore: number;
  totalGameMins: number;
  currentGameMins: number;
  onSubmitHeadline: (headline: string) => Promise<{ success: boolean; error?: string; cooldownMs?: number }>;
  worldHelperMessages: WorldHelperMessage[];
  onAskWorldHelper: (question: string) => Promise<{ success: boolean; error?: string }>;
  onLoadWorldHelperHistory: () => Promise<boolean>;
  onBack: () => void;
  /* lobby-specific slot */
  lobbyContent?: React.ReactNode;
}

export function GameLayout({
  title,
  joinCode,
  players,
  currentPlayerId,
  phase,
  isPaused = false,
  currentRound,
  maxRounds,
  phaseEndsAt,
  pauseRemainingMs = null,
  serverNow,
  inGameNow,
  timelineSpeedRatio,
  headlines,
  roundSummary,
  finalSummary,
  planetPanel,
  myScore,
  totalGameMins,
  currentGameMins,
  onSubmitHeadline,
  worldHelperMessages,
  onAskWorldHelper,
  onLoadWorldHelperHistory,
  onBack,
  lobbyContent,
}: GameLayoutProps) {
  const [helperOpen, setHelperOpen] = useState(false);
  const [focusHeadlineId, setFocusHeadlineId] = useState<string | null>(null);
  const [focusSignal, setFocusSignal] = useState(0);
  const isWaiting = phase === 'WAITING';
  const isFinished = phase === 'FINISHED';
  const inGame = !isWaiting && !isFinished;

  const focusHeadline = useCallback((headlineId: string) => {
    setFocusHeadlineId(headlineId);
    setFocusSignal((current) => current + 1);
  }, []);

  const derivedInGameNow = useInGameNow({
    inGameNow,
    serverNow,
    phaseEndsAt,
    timelineSpeedRatio,
    enabled: phase === 'PLAYING' && !isPaused,
  });

  return (
    <div className="h-[100dvh] overflow-hidden flex flex-col bg-gradient-to-b from-gray-50 to-gray-100/80">
      <header className="shrink-0 z-20 bg-white/80 backdrop-blur border-b border-gray-100">
        <div className="max-w-7xl mx-auto px-4 py-2 flex items-center justify-between gap-4">
          {/* left: session title + leave */}
          <div className="flex items-center gap-3">
            <button
              onClick={onBack}
              className="text-gray-400 hover:text-gray-600 transition-colors"
              title="Leave"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <div className="min-w-0">
              <div className="max-w-[180px] truncate text-sm font-semibold text-gray-900 sm:max-w-[260px]">
                {title || 'Future Headlines'}
              </div>
              <div className="font-mono text-[11px] text-gray-400">{joinCode}</div>
            </div>
          </div>

          {/* center: game status */}
          {inGame && (
            <div className="flex-1 flex justify-center">
              <GameStatus
                phase={phase}
                isPaused={isPaused}
                currentRound={currentRound}
                maxRounds={maxRounds}
                phaseEndsAt={phaseEndsAt}
                pauseRemainingMs={pauseRemainingMs}
                serverNow={serverNow}
                inGameNow={inGameNow}
              />
            </div>
          )}

          {/* right: helper + personal score */}
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setHelperOpen(true)}
              className="gap-1.5"
              title="Open world helper"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 20 20" stroke="currentColor" strokeWidth={1.8}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 5.5A2.5 2.5 0 016.5 3h7A2.5 2.5 0 0116 5.5v5A2.5 2.5 0 0113.5 13H9l-3.5 3v-3A2.5 2.5 0 014 10.5v-5z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M7 7h6M7 10h3" />
              </svg>
              <span className="hidden sm:inline">World</span>
            </Button>
            {inGame && <PersonalScore score={myScore} />}
          </div>
        </div>
      </header>

      {isWaiting && (
        <main className="flex-1 min-h-0 overflow-y-auto">
          <div className="max-w-2xl mx-auto px-4 py-8 space-y-6">
            {lobbyContent}
            <PlayerList players={players} currentPlayerId={currentPlayerId} />
            <div className="flex justify-center">
              <button
                onClick={onBack}
                className="text-sm text-gray-400 hover:text-gray-600 transition-colors"
              >
                Leave lobby
              </button>
            </div>
          </div>
        </main>
      )}

      {isFinished && (
        <GameEnd
          title={title}
          joinCode={joinCode}
          players={players}
          headlines={headlines}
          currentPlayerId={currentPlayerId}
          maxRounds={maxRounds}
          totalGameMins={totalGameMins}
          currentGameMins={currentGameMins}
          finalSummary={finalSummary}
          focusHeadlineId={focusHeadlineId}
          focusSignal={focusSignal}
          onBack={onBack}
        />
      )}

      {inGame && (
        <main className="flex-1 min-h-0 overflow-hidden">
          {/* desktop layout */}
          <div className="hidden lg:grid lg:grid-cols-[240px_1fr_320px] gap-4 h-full max-w-7xl mx-auto px-4 py-4">
            <aside className="min-h-0 flex flex-col pr-1">
              <div className="flex-1 min-h-0 overflow-y-auto">
                <ScoreBarChart
                  players={players}
                  currentPlayerId={currentPlayerId}
                  totalGameMins={totalGameMins}
                  currentGameMins={currentGameMins}
                  phase={phase}
                />
              </div>
              <div className="shrink-0 pt-3 pb-[env(safe-area-inset-bottom)] space-y-2">
                <InGameDate inGameNow={derivedInGameNow} />
                <ScoreCard phase={phase} />
              </div>
            </aside>

            <section className="flex flex-col min-h-0">
              <div className="flex-1 min-h-0 overflow-hidden">
                <HeadlineFeed
                  headlines={headlines}
                  currentPlayerId={currentPlayerId}
                  focusHeadlineId={focusHeadlineId}
                  focusSignal={focusSignal}
                />
              </div>
              {phase === 'TUTORIAL' && (
                <div className="shrink-0 pt-3 text-center text-sm text-gray-400">
                  Watch the timeline build up — submissions open soon...
                </div>
              )}
              {phase === 'PLAYING' && (
                <div className="shrink-0 pt-3 pb-[env(safe-area-inset-bottom)]">
                  <HeadlineInput onSubmit={onSubmitHeadline} phase={phase} disabled={isPaused} />
                </div>
              )}
            </section>

            <aside className="min-h-0 flex flex-col pl-1">
              {phase === 'BREAK' && roundSummary ? (
                <RoundSummary summary={roundSummary} roundNo={currentRound} />
              ) : (
                <PlanetUsagePanel panel={planetPanel} />
              )}
            </aside>
          </div>

          {/* mobile layout */}
          <div className="lg:hidden flex flex-col h-full">
            <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-4">
              <InGameDate inGameNow={derivedInGameNow} />
              {phase !== 'BREAK' && <PlanetUsagePanel panel={planetPanel} />}
              <HeadlineFeed
                headlines={headlines}
                currentPlayerId={currentPlayerId}
                focusHeadlineId={focusHeadlineId}
                focusSignal={focusSignal}
              />
              <ScoreBarChart
                players={players}
                currentPlayerId={currentPlayerId}
                totalGameMins={totalGameMins}
                currentGameMins={currentGameMins}
                phase={phase}
              />
              {phase === 'BREAK' && roundSummary && (
                <RoundSummary summary={roundSummary} roundNo={currentRound} />
              )}
            </div>
            {phase === 'TUTORIAL' && (
              <div className="text-center py-3 text-sm text-gray-400">
                Watch the timeline build up — submissions open soon...
              </div>
            )}
            {phase === 'PLAYING' && (
              <div className="shrink-0 px-4 pb-[env(safe-area-inset-bottom)] pb-3 pt-2 border-t border-gray-100 bg-white/80 backdrop-blur">
                <HeadlineInput
                  onSubmit={onSubmitHeadline}
                  phase={phase}
                  disabled={isPaused}
                />
              </div>
            )}
          </div>
        </main>
      )}

      <WorldHelperDrawer
        open={helperOpen}
        joinCode={joinCode}
        messages={worldHelperMessages}
        headlines={headlines}
        onClose={() => setHelperOpen(false)}
        onAsk={onAskWorldHelper}
        onLoadHistory={onLoadWorldHelperHistory}
        onFocusHeadline={focusHeadline}
      />
    </div>
  );
}
