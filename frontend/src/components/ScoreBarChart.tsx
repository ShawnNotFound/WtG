import { ScoreBreakdown } from '../hooks/useSocket';
import { Card, SectionTitle } from './ui';

interface Player {
  id: string;
  nickname: string;
  totalScore?: number;
  scoreBreakdown?: ScoreBreakdown;
}

interface ScoreBarChartProps {
  players: Player[];
  currentPlayerId?: string;
  totalGameMins: number;
  currentGameMins: number;
  phase: string;
}

const SEGMENTS = [
  { key: 'baseline' as const, label: 'Baseline', color: 'bg-gray-400' },
  { key: 'plausibility' as const, label: 'Plausibility', color: 'bg-indigo-500' },
  { key: 'connection' as const, label: 'Connection', color: 'bg-emerald-500' },
  { key: 'planetBonus' as const, label: 'Planet', color: 'bg-amber-400' },
];

export function ScoreBarChart({
  players,
  currentPlayerId,
  totalGameMins,
  currentGameMins,
  phase,
}: ScoreBarChartProps) {
  if (phase !== 'PLAYING' && phase !== 'BREAK') {
    return null;
  }

  const highestScore = Math.max(1, ...players.map((p) => p.totalScore ?? 0));
  const safeTotal = Math.max(1, totalGameMins);

  const sorted = [...players]
    .filter((p) => p.id)
    .sort((a, b) => (b.totalScore ?? 0) - (a.totalScore ?? 0));

  return (
    <Card padding="sm" className="max-h-[60dvh] overflow-hidden flex flex-col">
      <div className="shrink-0">
        <SectionTitle>Leaderboard</SectionTitle>
      </div>

      <div className="space-y-2 flex-1 min-h-0 overflow-y-auto">
        {sorted.map((player, index) => {
          const total = player.totalScore ?? 0;
          const bd = player.scoreBreakdown ?? { baseline: 0, plausibility: 0, connection: 0, planetBonus: 0 };
          const barPercent = Math.min(
            100,
            (total / highestScore) * (currentGameMins / safeTotal) * 100
          );
          const isCurrentPlayer = player.id === currentPlayerId;

          return (
            <div
              key={player.id}
              className={`rounded-lg px-2 py-1.5 ${isCurrentPlayer ? 'bg-indigo-50' : ''}`}
            >
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs font-bold text-gray-400 w-4">{index + 1}</span>
                  <span
                    className={`text-xs font-medium truncate max-w-[120px] ${
                      isCurrentPlayer ? 'text-indigo-700' : 'text-gray-700'
                    }`}
                  >
                    {player.nickname}
                    {isCurrentPlayer && (
                      <span className="text-gray-400 ml-1">(You)</span>
                    )}
                  </span>
                </div>
                <span className="text-xs font-semibold text-gray-600 ml-2 shrink-0 tabular-nums">
                  {total} pts
                </span>
              </div>

              <div className="h-2.5 w-full rounded-full bg-gray-100 overflow-hidden">
                <div
                  className="h-full flex transition-all duration-500 ease-out rounded-full"
                  style={{ width: `${barPercent}%` }}
                >
                  {SEGMENTS.map((seg) => {
                    const segValue = bd[seg.key];
                    if (segValue <= 0 || total <= 0) return null;
                    const segPercent = (segValue / total) * 100;
                    return (
                      <div
                        key={seg.key}
                        className={`h-full ${seg.color} first:rounded-l-full last:rounded-r-full transition-all duration-500 ease-out`}
                        style={{ width: `${segPercent}%` }}
                        title={`${seg.label}: ${segValue}`}
                      />
                    );
                  })}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="shrink-0 border-t border-gray-100 mt-2 pt-2 flex flex-wrap gap-x-3 gap-y-1">
        {SEGMENTS.map((seg) => (
          <div key={seg.key} className="flex items-center gap-1">
            <div className={`w-2 h-2 rounded-full ${seg.color}`} />
            <span className="text-[10px] text-gray-400">{seg.label}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}
