interface PersonalScoreProps {
  score: number;
}

export function PersonalScore({ score }: PersonalScoreProps) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-gray-400 uppercase tracking-wide">Score</span>
      <span className="text-lg font-bold text-indigo-600 tabular-nums">{score}</span>
    </div>
  );
}
