import { RoundSummary as RoundSummaryType } from '../hooks/useSocket';
import { Card, SectionTitle, Badge } from './ui';

interface RoundSummaryProps {
  summary: RoundSummaryType;
  roundNo: number;
}

export function RoundSummary({ summary, roundNo }: RoundSummaryProps) {
  // generating state
  if (summary.status === 'generating') {
    return (
      <Card padding="sm">
        <SectionTitle>Period {roundNo} Summary</SectionTitle>
        <div className="flex items-center gap-2 text-sm text-gray-400">
          <div className="animate-spin rounded-full h-4 w-4 border-2 border-gray-200 border-t-indigo-500" />
          <span>Generating...</span>
        </div>
        <div className="mt-3 space-y-2">
          <div className="h-3 bg-gray-100 rounded animate-pulse w-3/4" />
          <div className="h-3 bg-gray-100 rounded animate-pulse w-full" />
          <div className="h-3 bg-gray-100 rounded animate-pulse w-5/6" />
        </div>
      </Card>
    );
  }

  // error state
  if (summary.status === 'error') {
    return (
      <Card padding="sm">
        <SectionTitle>Period {roundNo} Summary</SectionTitle>
        <p className="text-sm text-red-500">Summary unavailable</p>
        {summary.error && <p className="text-xs text-red-400 mt-1">{summary.error}</p>}
      </Card>
    );
  }

  // pending
  if (summary.status === 'pending' || !summary.summary) {
    return (
      <Card padding="sm">
        <SectionTitle>Period {roundNo} Summary</SectionTitle>
        <p className="text-sm text-gray-400">No summary available yet</p>
      </Card>
    );
  }

  const { narrative, themes, highlightedHeadlines, roundStats } = summary.summary;

  return (
    <Card padding="sm" className="h-full">
      <SectionTitle>Period {roundNo} Summary</SectionTitle>
      <div className="max-h-[calc(100dvh-12rem)] overflow-y-auto space-y-3 pr-0.5">
        <div className="flex gap-2 text-xs text-gray-400">
          <span>{roundStats.headlineCount} developments</span>
          <span>&middot;</span>
          <span>{roundStats.playerCount} sources</span>
        </div>

        <p className="text-sm text-gray-600 leading-relaxed whitespace-pre-line">
          {narrative}
        </p>

        {themes.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {themes.map((theme, i) => (
              <Badge key={i} variant="blue">{theme}</Badge>
            ))}
          </div>
        )}

        {highlightedHeadlines.length > 0 && (
          <div className="space-y-2">
            <span className="text-[11px] font-medium text-gray-400 uppercase tracking-wider">Key Developments</span>
            {highlightedHeadlines.map((h, i) => (
              <div key={i} className="pl-3 border-l-2 border-indigo-200">
                <p className="text-sm font-medium text-gray-700">&ldquo;{h.headline}&rdquo;</p>
                <p className="text-xs text-gray-400 mt-0.5">{h.source} &middot; {h.significance}</p>
              </div>
            ))}
          </div>
        )}


      </div>
    </Card>
  );
}
