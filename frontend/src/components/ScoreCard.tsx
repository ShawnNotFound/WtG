import { Card, SectionTitle } from './ui';

interface ScoreCardProps {
  phase: string;
}

export function ScoreCard({ phase }: ScoreCardProps) {
  if (phase !== 'PLAYING' && phase !== 'BREAK') {
    return null;
  }

  return (
    <Card padding="sm">
      <SectionTitle>Scoring</SectionTitle>
      <div className="space-y-1 text-[10px]">
        <div className="flex justify-between">
          <span className="text-gray-500">Baseline</span>
          <span className="text-gray-600 font-semibold">+1</span>
        </div>
        <div className="flex justify-between">
          <span className="text-indigo-500">Plausibility (sweet spot)</span>
          <span className="text-indigo-600 font-semibold">+2</span>
        </div>
        <div className="flex justify-between">
          <span className="text-indigo-400">Plausibility (near)</span>
          <span className="text-indigo-500 font-semibold">+1</span>
        </div>
        <div className="border-t border-gray-100 my-1" />
        <div className="flex justify-between">
          <span className="text-emerald-500">3 unique authors</span>
          <span className="text-emerald-600 font-semibold">+9</span>
        </div>
        <div className="flex justify-between">
          <span className="text-emerald-400">2 unique authors</span>
          <span className="text-emerald-500 font-semibold">+4</span>
        </div>
        <div className="flex justify-between">
          <span className="text-emerald-400">1 unique author</span>
          <span className="text-emerald-500 font-semibold">+1</span>
        </div>
        <div className="border-t border-gray-100 my-1" />
        <div className="flex justify-between">
          <span className="text-violet-500">Planet — least used (top 3)</span>
          <span className="text-violet-600 font-semibold">+2</span>
        </div>
        <div className="flex justify-between">
          <span className="text-violet-400">Planet — middle 3</span>
          <span className="text-violet-500 font-semibold">+1</span>
        </div>
      </div>
    </Card>
  );
}
