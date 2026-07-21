import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Headline, WorldHelperMessage } from '../hooks/useSocket';
import { Badge, Button } from './ui';

interface WorldHelperDrawerProps {
  open: boolean;
  joinCode: string;
  messages: WorldHelperMessage[];
  headlines: Headline[];
  onClose: () => void;
  onAsk: (question: string) => Promise<{ success: boolean; error?: string }>;
  onLoadHistory: () => Promise<boolean>;
  onFocusHeadline: (headlineId: string) => void;
}

const DEFAULT_SUGGESTIONS = [
  'What is the most important tension in the world right now?',
  'How does my current planet panel work?',
  'Which entities changed the most recently?',
];

function confidenceVariant(confidence?: string) {
  if (confidence === 'high') return 'green';
  if (confidence === 'medium') return 'blue';
  return 'yellow';
}

function shortId(id: string) {
  return id.slice(0, 8);
}

export function WorldHelperDrawer({
  open,
  joinCode,
  messages,
  headlines,
  onClose,
  onAsk,
  onLoadHistory,
  onFocusHeadline,
}: WorldHelperDrawerProps) {
  const [question, setQuestion] = useState('');
  const [error, setError] = useState('');
  const bodyRef = useRef<HTMLDivElement>(null);
  const loadedRef = useRef(false);

  useEffect(() => {
    if (!open || loadedRef.current) return;
    loadedRef.current = true;
    onLoadHistory();
  }, [open, onLoadHistory]);

  useEffect(() => {
    if (!open || !bodyRef.current) return;
    bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [open, messages.length, messages[messages.length - 1]?.streamedText]);

  const headlineById = useMemo(
    () => new Map(headlines.map((headline) => [headline.id, headline])),
    [headlines]
  );

  const latestSuggestions = useMemo(() => {
    const newest = [...messages]
      .reverse()
      .flatMap((message) => message.answer?.suggestedQuestions ?? [])
      .filter(Boolean);
    return (newest.length > 0 ? newest : DEFAULT_SUGGESTIONS).slice(0, 4);
  }, [messages]);

  const handleSubmit = async (event?: FormEvent) => {
    event?.preventDefault();
    const trimmed = question.trim();
    if (!trimmed) return;
    setQuestion('');
    setError('');
    const result = await onAsk(trimmed);
    if (!result.success) {
      setError(result.error ?? 'World helper failed');
    }
  };

  const panelContent = (
    <div className="flex h-full min-h-0 flex-col bg-white">
      <div className="flex shrink-0 items-center justify-between border-b border-gray-100 px-4 py-3">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-gray-900">World Helper</h2>
            <Badge variant="purple" className="text-[10px]">{joinCode}</Badge>
          </div>
          <p className="mt-0.5 text-xs text-gray-400">Private to you, visible to admins</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg p-2 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
          aria-label="Close world helper"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 20 20" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 5l10 10M15 5L5 15" />
          </svg>
        </button>
      </div>

      <div ref={bodyRef} className="flex-1 min-h-0 space-y-4 overflow-y-auto px-4 py-4">
        {messages.length === 0 && (
          <div className="rounded-lg border border-dashed border-gray-200 bg-gray-50 p-4 text-sm text-gray-500">
            Ask about the timeline, planet rules, score context, or the hidden world graph.
          </div>
        )}

        {messages.map((message) => {
          const answerText = message.answer?.answerText || message.streamedText;
          return (
            <div key={message.id} className="space-y-2">
              <div className="ml-auto max-w-[88%] rounded-lg bg-indigo-600 px-3 py-2 text-sm text-white">
                {message.question}
              </div>

              <div className="max-w-[94%] rounded-lg border border-gray-100 bg-gray-50 px-3 py-2">
                {message.status === 'error' ? (
                  <p className="text-sm text-red-600">{message.error ?? 'World helper failed'}</p>
                ) : (
                  <p className="whitespace-pre-wrap text-sm leading-relaxed text-gray-800">
                    {answerText || 'Thinking...'}
                  </p>
                )}

                {message.status === 'streaming' && (
                  <div className="mt-2 flex items-center gap-2 text-[11px] text-gray-400">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-indigo-400" />
                    Streaming answer
                  </div>
                )}

                {message.answer && (
                  <div className="mt-3 space-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={confidenceVariant(message.answer.confidence)}>
                        {message.answer.confidence} confidence
                      </Badge>
                      {message.model && (
                        <span className="text-[11px] text-gray-400">{message.model}</span>
                      )}
                    </div>

                    {message.worldUpdate?.status === 'applied' &&
                      (message.worldUpdate.createdNodes.length > 0 || message.worldUpdate.updatedNodes.length > 0) && (
                        <p className="rounded-lg border border-purple-100 bg-purple-50 px-3 py-2 text-xs text-purple-800">
                          World model filled this question&apos;s gap: {[
                            ...message.worldUpdate.createdNodes.map((node) => `created ${node.name}`),
                            ...message.worldUpdate.updatedNodes.map((node) => `updated ${node.name}`),
                          ].join(', ')}.
                        </p>
                      )}

                    {message.answer.headlineRefs.length > 0 && (
                      <div className="space-y-1.5">
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Headlines</p>
                        {message.answer.headlineRefs.map((ref) => {
                          const headline = headlineById.get(ref.id);
                          return (
                            <button
                              key={ref.id}
                              type="button"
                              onClick={() => onFocusHeadline(ref.id)}
                              className="w-full rounded-lg border border-gray-100 bg-white px-3 py-2 text-left transition-colors hover:border-indigo-200 hover:bg-indigo-50"
                            >
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-xs font-medium text-indigo-600">Jump to {shortId(ref.id)}</span>
                                <span className="text-[10px] text-gray-400">{headline?.playerNickname}</span>
                              </div>
                              <p className="mt-1 line-clamp-2 text-xs text-gray-700">
                                {headline?.text ?? ref.reason}
                              </p>
                              <p className="mt-1 text-[11px] text-gray-400">{ref.reason}</p>
                            </button>
                          );
                        })}
                      </div>
                    )}

                    {(message.answer.entityRefs.length > 0 || message.answer.edgeRefs.length > 0) && (
                      <div className="space-y-1.5">
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">World Graph</p>
                        {message.answer.entityRefs.map((ref) => (
                          <div key={ref.id} className="rounded-lg border border-emerald-100 bg-emerald-50/60 px-3 py-2">
                            <p className="text-xs font-semibold text-emerald-700">{ref.name}</p>
                            <p className="mt-1 text-xs text-emerald-900/80">{ref.reason}</p>
                          </div>
                        ))}
                        {message.answer.edgeRefs.map((ref) => (
                          <div key={ref.id} className="rounded-lg border border-blue-100 bg-blue-50/60 px-3 py-2">
                            <p className="text-xs font-semibold text-blue-700">
                              {ref.sourceName} &rarr; {ref.targetName}
                            </p>
                            <p className="mt-0.5 text-[11px] uppercase tracking-wide text-blue-500">{ref.relationType}</p>
                            <p className="mt-1 text-xs text-blue-900/80">{ref.reason}</p>
                          </div>
                        ))}
                        {message.answer.graphSummary.note && (
                          <p className="rounded-lg bg-white px-3 py-2 text-xs text-gray-500">
                            {message.answer.graphSummary.note}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="shrink-0 border-t border-gray-100 px-4 py-3">
        {latestSuggestions.length > 0 && (
          <div className="mb-3 flex gap-2 overflow-x-auto pb-1">
            {latestSuggestions.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                onClick={() => setQuestion(suggestion)}
                className="shrink-0 rounded-full border border-gray-200 bg-gray-50 px-3 py-1.5 text-xs text-gray-600 transition-colors hover:border-indigo-200 hover:bg-indigo-50 hover:text-indigo-700"
              >
                {suggestion}
              </button>
            ))}
          </div>
        )}

        {error && <p className="mb-2 text-xs text-red-600">{error}</p>}
        <form onSubmit={handleSubmit} className="flex items-end gap-2">
          <textarea
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            rows={2}
            maxLength={1000}
            placeholder="Ask about the world..."
            className="min-h-[44px] flex-1 resize-none rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-indigo-400"
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                handleSubmit();
              }
            }}
          />
          <Button type="submit" size="md" disabled={!question.trim()}>
            Send
          </Button>
        </form>
      </div>
    </div>
  );

  return (
    <div className={`fixed inset-0 z-40 ${open ? 'pointer-events-auto' : 'pointer-events-none'}`}>
      <div
        className={`absolute inset-0 bg-gray-900/20 transition-opacity ${open ? 'opacity-100' : 'opacity-0'}`}
        onClick={onClose}
      />
      <aside
        className={`absolute right-0 top-0 hidden h-full w-[420px] max-w-[92vw] overflow-hidden border-l border-gray-200 shadow-2xl transition-transform lg:block ${
          open ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        {panelContent}
      </aside>
      <aside
        className={`absolute inset-x-0 bottom-0 max-h-[84dvh] overflow-hidden rounded-t-2xl border-t border-gray-200 shadow-2xl transition-transform lg:hidden ${
          open ? 'translate-y-0' : 'translate-y-full'
        }`}
      >
        {panelContent}
      </aside>
    </div>
  );
}
