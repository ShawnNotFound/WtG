import { usePhaseTimer } from '../hooks/usePhaseTimer';
import { Badge } from './ui';

interface GameStatusProps {
  phase: string;
  isPaused?: boolean;
  currentRound: number;
  maxRounds: number;
  phaseEndsAt: string | null;
  pauseRemainingMs?: number | null;
  serverNow: string;
  inGameNow: string | null;
}

export function GameStatus({
  phase,
  isPaused = false,
  currentRound,
  maxRounds,
  phaseEndsAt,
  pauseRemainingMs = null,
  serverNow,
}: GameStatusProps) {
  const { remainingFormatted } = usePhaseTimer({
    phaseEndsAt,
    serverNow,
    isPaused,
    pauseRemainingMs,
  });

  const getPhaseLabel = () => {
    switch (phase) {
      case 'WAITING':
        return { text: 'Waiting', variant: 'default' as const };
      case 'PLAYING':
        return { text: 'Playing', variant: 'green' as const };
      case 'TUTORIAL':
        return { text: 'Tutorial', variant: 'yellow' as const };
      case 'BREAK':
        return { text: 'Break', variant: 'blue' as const };
      case 'FINISHED':
        return { text: 'Finished', variant: 'purple' as const };
      default:
        return { text: phase, variant: 'default' as const };
    }
  };

  const phaseLabel = getPhaseLabel();

  return (
    <div className="flex items-center gap-3 flex-wrap">
      <Badge variant={isPaused ? 'yellow' : phaseLabel.variant}>
        {isPaused ? `Paused ${phaseLabel.text}` : phaseLabel.text}
      </Badge>

      {(phase === 'PLAYING' || phase === 'BREAK') && currentRound > 0 && (
        <>
          <span className="text-xs text-gray-400">
            Round {currentRound}/{maxRounds}
          </span>

          <div className="flex items-center gap-1.5">
            <div className="w-16 bg-gray-100 rounded-full h-1.5">
              <div
                className="bg-indigo-500 h-1.5 rounded-full transition-all duration-300"
                style={{ width: `${(currentRound / maxRounds) * 100}%` }}
              />
            </div>
          </div>
        </>
      )}

      {phase !== 'WAITING' && phase !== 'FINISHED' && (
        <span className="text-sm font-mono font-semibold text-gray-800 ml-auto tabular-nums">
          {remainingFormatted}
        </span>
      )}
    </div>
  );
}
