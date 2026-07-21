import { Card, SectionTitle } from './ui';
import { PlanetPanelEntry } from '../hooks/useSocket';
import { PLANET_TAGS, PLANET_COLORS } from '../lib/planets';

interface PlanetUsagePanelProps {
  panel: PlanetPanelEntry[] | null;
}

const BAND_META: Record<number, { points: string; label: string; pill: string }> = {
  2: { points: '+2', label: 'least used', pill: 'bg-emerald-100 text-emerald-700' },
  1: { points: '+1', label: '', pill: 'bg-amber-100 text-amber-700' },
  0: { points: '+0', label: 'most used', pill: 'bg-gray-100 text-gray-500' },
};

/**
 * usage-ranked planet panel: all planets least-used (top) to most-used (bottom),
 * split into three scoring bands (+2 / +1 / +0). each row shows the planet name,
 * its keywords, and its global usage count.
 */
export function PlanetUsagePanel({ panel }: PlanetUsagePanelProps) {
  if (!panel || panel.length === 0) {
    return null;
  }

  return (
    <Card padding="sm" className="flex-1 flex flex-col min-h-0">
      <SectionTitle>Planet Usage</SectionTitle>
      <div className="space-y-1 overflow-y-auto min-h-0">
        {panel.map((entry, i) => {
          const color = PLANET_COLORS[entry.id];
          const tags = PLANET_TAGS[entry.id] ?? [];
          const band = BAND_META[entry.band] ?? BAND_META[0];
          // band-group header before the first planet of each band
          const showHeader = i === 0 || panel[i - 1].band !== entry.band;

          return (
            <div key={entry.id}>
              {showHeader && (
                <div className="flex items-center gap-1.5 pt-2 pb-0.5 first:pt-0">
                  <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${band.pill}`}>
                    {band.points}
                  </span>
                  {band.label && (
                    <span className="text-[10px] text-gray-400 uppercase tracking-wider">
                      {band.label}
                    </span>
                  )}
                </div>
              )}
              <div className={`rounded-md border border-gray-100 px-2 py-1.5 ${color?.bg ?? ''}`}>
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className={`w-2 h-2 rounded-full shrink-0 ${color?.dot ?? 'bg-gray-300'}`} />
                    <span className={`text-xs font-semibold ${color?.text ?? 'text-gray-700'}`}>
                      {entry.id}
                    </span>
                  </div>
                  <span className="text-[10px] text-gray-400 shrink-0">used {entry.usage}</span>
                </div>
                {tags.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1">
                    {tags.map((tag) => (
                      <span
                        key={tag}
                        className="text-[10px] px-1 py-0.5 rounded bg-white/70 text-gray-500"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
