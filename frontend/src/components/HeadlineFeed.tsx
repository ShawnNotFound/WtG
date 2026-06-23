import { KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Headline } from '../hooks/useSocket';
import { Card, SectionTitle } from './ui';
import { PLANET_COLORS, PLANET_TAGS } from '../lib/planets';

interface HeadlineFeedProps {
  headlines: Headline[];
  currentPlayerId: string;
}

// typography by plausibility band of the displayed variant: mundane/inevitable
// headlines read small and light; surprising/preposterous ones are large and bold.
const BAND_TEXT: Record<number, string> = {
  1: 'text-xs font-normal text-gray-600',
  2: 'text-sm font-normal text-gray-700',
  3: 'text-sm font-medium text-gray-800',
  4: 'text-base font-semibold text-gray-900',
  5: 'text-lg font-bold text-gray-900',
};

type FilterKind = 'planet' | 'tag' | 'keyword';

interface HeadlineFilter {
  id: string;
  label: string;
  value: string;
  kind: FilterKind;
}

const PLANET_FILTERS: HeadlineFilter[] = Object.keys(PLANET_TAGS).map((planet) => ({
  id: `planet:${planet}`,
  label: planet,
  value: planet,
  kind: 'planet',
}));

const TAG_FILTERS: HeadlineFilter[] = Array.from(
  new Set(Object.values(PLANET_TAGS).flat())
)
  .sort((a, b) => a.localeCompare(b))
  .map((tag) => ({
    id: `tag:${tag.toLowerCase()}`,
    label: tag,
    value: tag.toLowerCase(),
    kind: 'tag',
  }));

const normalizeText = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ');

const filterLabel = (filter: HeadlineFilter) => {
  if (filter.kind === 'planet') return `Planet: ${filter.label}`;
  if (filter.kind === 'tag') return `Tag: ${filter.label}`;
  return `Keyword: ${filter.label}`;
};

const filterChipClass = (kind: FilterKind) => {
  if (kind === 'planet') return 'bg-indigo-50 text-indigo-700 border-indigo-100';
  if (kind === 'tag') return 'bg-emerald-50 text-emerald-700 border-emerald-100';
  return 'bg-gray-100 text-gray-700 border-gray-200';
};

const optionKindLabel = (kind: FilterKind) => {
  if (kind === 'planet') return 'Planet';
  if (kind === 'tag') return 'Tag';
  return 'Keyword';
};

function filterMatchesHeadline(filter: HeadlineFilter, headline: Headline) {
  const headlinePlanets = headline.planets ?? [];
  const primaryPlanet = headlinePlanets[0];
  const primaryPlanetTags = primaryPlanet ? PLANET_TAGS[primaryPlanet] ?? [] : [];

  if (filter.kind === 'planet') {
    return primaryPlanet === filter.value;
  }

  if (filter.kind === 'tag') {
    return primaryPlanetTags.some((tag) => normalizeText(tag) === filter.value);
  }

  const haystack = normalizeText([
    headline.text,
    headline.playerNickname,
    `round ${headline.roundNo}`,
    primaryPlanet ?? '',
    ...primaryPlanetTags,
    headline.inGameSubmittedAt
      ? new Date(headline.inGameSubmittedAt).toLocaleDateString('en-US', {
          month: 'long',
          year: 'numeric',
        })
      : '',
  ].join(' '));

  return haystack.includes(filter.value);
}

export function HeadlineFeed({ headlines, currentPlayerId }: HeadlineFeedProps) {
  const feedRef = useRef<HTMLDivElement>(null);
  // sticks to the bottom until the user manually scrolls up
  const followBottomRef = useRef(true);
  // true while a programmatic scroll is in flight, so the scroll handler ignores it
  const programmaticScrollRef = useRef(false);
  const [showJumpButton, setShowJumpButton] = useState(false);
  const [copied, setCopied] = useState(false);
  const [filters, setFilters] = useState<HeadlineFilter[]>([]);
  const [filterDraft, setFilterDraft] = useState('');
  const [filterFocused, setFilterFocused] = useState(false);
  const [activeSuggestion, setActiveSuggestion] = useState(0);

  // snap to bottom on new headlines, only when the user hasn't scrolled away
  useEffect(() => {
    if (!feedRef.current || !followBottomRef.current) return;
    programmaticScrollRef.current = true;
    feedRef.current.scrollTop = feedRef.current.scrollHeight;
    // release the flag on the next frame, after the scroll event has fired
    requestAnimationFrame(() => {
      programmaticScrollRef.current = false;
    });
  }, [headlines.length]);

  const handleScroll = () => {
    if (!feedRef.current) return;
    if (programmaticScrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = feedRef.current;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    const atBottom = distanceFromBottom < 50;
    followBottomRef.current = atBottom;
    setShowJumpButton(!atBottom);
  };

  const jumpToLatest = () => {
    if (!feedRef.current) return;
    programmaticScrollRef.current = true;
    feedRef.current.scrollTop = feedRef.current.scrollHeight;
    followBottomRef.current = true;
    setShowJumpButton(false);
    requestAnimationFrame(() => {
      programmaticScrollRef.current = false;
    });
  };

  const displayedHeadlines = useMemo(() => {
    if (filters.length === 0) return headlines;
    return headlines.filter((headline) =>
      filters.some((filter) => filterMatchesHeadline(filter, headline))
    );
  }, [filters, headlines]);

  const filterSuggestions = useMemo(() => {
    const query = normalizeText(filterDraft);
    if (!query) return [];

    const selected = new Set(filters.map((filter) => filter.id));
    const options = [...PLANET_FILTERS, ...TAG_FILTERS]
      .filter((option) => !selected.has(option.id))
      .filter((option) => normalizeText(option.label).includes(query))
      .slice(0, 8);

    const exactPreset = options.some((option) => normalizeText(option.label) === query);
    const keywordOption: HeadlineFilter = {
      id: `keyword:${query}`,
      label: filterDraft.trim(),
      value: query,
      kind: 'keyword',
    };

    if (!selected.has(keywordOption.id) && !exactPreset) {
      return [keywordOption, ...options].slice(0, 8);
    }

    return options;
  }, [filterDraft, filters]);

  useEffect(() => {
    setActiveSuggestion(0);
  }, [filterDraft]);

  const addFilter = (filter: HeadlineFilter) => {
    setFilters((prev) => (prev.some((existing) => existing.id === filter.id) ? prev : [...prev, filter]));
    setFilterDraft('');
  };

  const addFilterFromText = () => {
    const query = normalizeText(filterDraft);
    if (!query) return;

    const exactPlanet = PLANET_FILTERS.find((filter) => normalizeText(filter.label) === query);
    if (exactPlanet) {
      addFilter(exactPlanet);
      return;
    }

    const exactTag = TAG_FILTERS.find((filter) => normalizeText(filter.label) === query);
    if (exactTag) {
      addFilter(exactTag);
      return;
    }

    addFilter({
      id: `keyword:${query}`,
      label: filterDraft.trim(),
      value: query,
      kind: 'keyword',
    });
  };

  const removeFilter = (id: string) => {
    setFilters((prev) => prev.filter((filter) => filter.id !== id));
  };

  const handleFilterKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' && filterSuggestions.length > 0) {
      event.preventDefault();
      setActiveSuggestion((current) => (current + 1) % filterSuggestions.length);
      return;
    }

    if (event.key === 'ArrowUp' && filterSuggestions.length > 0) {
      event.preventDefault();
      setActiveSuggestion((current) => (current - 1 + filterSuggestions.length) % filterSuggestions.length);
      return;
    }

    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      if (filterSuggestions[activeSuggestion]) {
        addFilter(filterSuggestions[activeSuggestion]);
      } else {
        addFilterFromText();
      }
      return;
    }

    if (event.key === 'Backspace' && !filterDraft && filters.length > 0) {
      setFilters((prev) => prev.slice(0, -1));
    }
  };

  const handleCopy = async () => {
    const formatted = displayedHeadlines
      .map((h) => {
        const date = h.inGameSubmittedAt
          ? new Date(h.inGameSubmittedAt).toLocaleDateString('en-US', {
              month: 'long',
              year: 'numeric',
            })
          : '';
        return `[${date}] ${h.playerNickname} — ${h.text}`;
      })
      .join('\n');
    try {
      await navigator.clipboard.writeText(formatted);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  if (headlines.length === 0) {
    return (
      <Card className="flex flex-col h-full min-h-0">
        <SectionTitle>Timeline</SectionTitle>
        <div className="flex-1 flex flex-col items-center justify-center text-gray-300 py-12">
          <svg className="h-10 w-10 mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M19 20H5a2 2 0 01-2-2V6a2 2 0 012-2h10a2 2 0 012 2v1m2 13a2 2 0 01-2-2V7m2 13a2 2 0 002-2V9a2 2 0 00-2-2h-2m-4-3H9M7 16h6M7 8h6v4H7V8z"
            />
          </svg>
          <p className="text-sm text-gray-400">No headlines yet</p>
          <p className="text-xs text-gray-300 mt-1">Be the first to submit one!</p>
        </div>
      </Card>
    );
  }

  return (
    <Card className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
          Timeline
        </h3>
        <div className="flex items-center gap-2">
          <button
            onClick={handleCopy}
            disabled={displayedHeadlines.length === 0}
            className="text-[10px] text-gray-400 hover:text-indigo-500 disabled:opacity-30 disabled:hover:text-gray-400 transition-colors flex items-center gap-1"
            title="Copy timeline (dates, authors, headlines)"
          >
            {copied ? (
              <>
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
                Copied
              </>
            ) : (
              <>
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
                Copy
              </>
            )}
          </button>
          <span className="text-xs text-gray-400">
            {filters.length > 0 ? `${displayedHeadlines.length}/${headlines.length}` : displayedHeadlines.length}
          </span>
        </div>
      </div>

      <div className="relative mb-3">
        <div className="flex min-h-[38px] flex-wrap items-center gap-1.5 rounded-lg border border-gray-200 bg-gray-50 px-2 py-1.5 focus-within:ring-2 focus-within:ring-indigo-400">
          {filters.map((filter) => (
            <button
              key={filter.id}
              type="button"
              onClick={() => removeFilter(filter.id)}
              className={`inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-1 text-[11px] font-medium transition-colors hover:bg-white ${filterChipClass(filter.kind)}`}
              title={`Remove ${filterLabel(filter)}`}
            >
              <span className="truncate">{filterLabel(filter)}</span>
              <svg className="h-3 w-3 shrink-0" fill="none" viewBox="0 0 20 20" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 6l8 8M14 6l-8 8" />
              </svg>
            </button>
          ))}
          <input
            type="text"
            value={filterDraft}
            onChange={(event) => setFilterDraft(event.target.value)}
            onKeyDown={handleFilterKeyDown}
            onFocus={() => setFilterFocused(true)}
            onBlur={() => window.setTimeout(() => setFilterFocused(false), 120)}
            placeholder={filters.length > 0 ? 'Add filter...' : 'Filter planets, tags, keywords...'}
            className="min-w-[160px] flex-1 bg-transparent px-1 py-1 text-sm text-gray-700 placeholder:text-gray-400 focus:outline-none"
            aria-label="Filter timeline headlines"
          />
          {filters.length > 0 && (
            <button
              type="button"
              onClick={() => setFilters([])}
              className="shrink-0 rounded-md px-1.5 py-1 text-[11px] font-medium text-gray-400 transition-colors hover:bg-white hover:text-gray-600"
            >
              Clear
            </button>
          )}
        </div>

        {filterFocused && filterSuggestions.length > 0 && (
          <div className="absolute left-0 right-0 top-full z-40 mt-1 max-h-56 overflow-y-auto rounded-lg border border-gray-200 bg-white py-1 text-sm shadow-lg ring-1 ring-black/5">
            {filterSuggestions.map((suggestion, index) => (
              <button
                key={suggestion.id}
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => addFilter(suggestion)}
                className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition-colors ${
                  index === activeSuggestion ? 'bg-indigo-50 text-indigo-700' : 'text-gray-700 hover:bg-gray-50'
                }`}
              >
                <span className="truncate">{suggestion.label}</span>
                <span className="shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-gray-500">
                  {optionKindLabel(suggestion.kind)}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div
        ref={feedRef}
        onScroll={handleScroll}
        className="space-y-2.5 flex-1 overflow-y-auto pr-1 min-h-0"
      >
        {displayedHeadlines.length === 0 && (
          <div className="flex h-full min-h-[180px] flex-col items-center justify-center rounded-lg border border-dashed border-gray-200 bg-gray-50/60 px-4 py-10 text-center">
            <p className="text-sm font-medium text-gray-500">No matching headlines</p>
            <p className="mt-1 text-xs text-gray-400">Try a different planet, tag, or keyword.</p>
            <button
              type="button"
              onClick={() => setFilters([])}
              className="mt-3 rounded-md bg-white px-3 py-1.5 text-xs font-medium text-indigo-600 shadow-sm ring-1 ring-gray-200 transition-colors hover:bg-indigo-50"
            >
              Clear filters
            </button>
          </div>
        )}

        {displayedHeadlines.map((headline) => {
          const isOwn = headline.playerId === currentPlayerId;
          const isArchive = headline.playerNickname === 'Archive';

          const hasScore = headline.totalScore != null;
          const primaryPlanet = headline.planets?.[0];
          const planetColor = !isArchive && primaryPlanet ? PLANET_COLORS[primaryPlanet] : null;

          const planetBorder = planetColor ? `border-l-4 ${planetColor.borderL}` : '';
          const bandText = headline.selectedBand
            ? BAND_TEXT[headline.selectedBand] ?? 'text-sm font-medium text-gray-800'
            : 'text-sm text-gray-800';

          return (
            <div
              key={headline.id}
              className={`group relative px-3 py-2.5 rounded-lg border ${planetBorder} ${
                isArchive
                  ? 'bg-amber-50/40 border-amber-100'
                  : isOwn
                  ? 'bg-indigo-50/60 border-indigo-100'
                  : 'bg-gray-50/60 border-gray-100'
              }`}
            >
              <div className="flex justify-between items-center mb-1">
                <span className={`flex items-center gap-1.5 text-xs font-medium ${isArchive ? 'text-amber-600' : isOwn ? 'text-indigo-600' : 'text-gray-500'}`}>
                  {headline.playerNickname}
                  {isArchive && <span className="text-amber-400">(history)</span>}
                  {!isArchive && isOwn && <span className="text-gray-400">(you)</span>}
                  {planetColor && (
                    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold ${planetColor.bg} ${planetColor.text}`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${planetColor.dot}`} />
                      {primaryPlanet}
                    </span>
                  )}
                </span>
                <span className="text-[11px] font-semibold text-gray-600">
                  R{headline.roundNo} &middot; {headline.inGameSubmittedAt
                    ? new Date(headline.inGameSubmittedAt).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
                    : ''}
                </span>
              </div>
              <p className={`${bandText} leading-relaxed`}>
                &ldquo;{headline.text}&rdquo;
              </p>
              {hasScore && (
                <div className="absolute right-2 bottom-2 hidden group-hover:flex items-center gap-2 px-2 py-1 rounded-md bg-white/95 shadow-sm border border-gray-200 text-[10px] z-10 pointer-events-none">
                  <span className="text-gray-400">+{headline.baselineScore}</span>
                  <span className="text-indigo-500">+{headline.plausibilityScore} plaus</span>
                  <span className="text-emerald-500">+{headline.connectionScore} conn</span>
                  <span className="text-violet-500">+{headline.planetBonusScore} planet</span>
                  <span className="font-semibold text-gray-600 ml-1">= {headline.totalScore}</span>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {showJumpButton && (
        <button
          onClick={jumpToLatest}
          className="mt-2 text-center text-xs text-indigo-500 hover:text-indigo-700 py-1 transition-colors"
        >
          Scroll to latest
        </button>
      )}
    </Card>
  );
}
