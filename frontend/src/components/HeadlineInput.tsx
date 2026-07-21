import { useState, useEffect, useRef } from 'react';
import { Button } from './ui';

interface HeadlineInputProps {
  onSubmit: (headline: string) => Promise<{ success: boolean; error?: string; cooldownMs?: number }>;
  disabled?: boolean;
  phase: string;
}

export function HeadlineInput({ onSubmit, disabled = false, phase }: HeadlineInputProps) {
  const [headline, setHeadline] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [cooldownMs, setCooldownMs] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (cooldownMs <= 0) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }

    const startTime = Date.now();
    const startCooldown = cooldownMs;

    intervalRef.current = setInterval(() => {
      const elapsed = Date.now() - startTime;
      const remaining = Math.max(0, startCooldown - elapsed);
      setCooldownMs(remaining);

      if (remaining <= 0 && intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    }, 100);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [cooldownMs > 0]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!headline.trim() || isSubmitting || cooldownMs > 0 || disabled) return;

    setIsSubmitting(true);
    setError(null);

    try {
      const result = await onSubmit(headline.trim());
      if (result.success) {
        setHeadline('');
        if (result.cooldownMs) setCooldownMs(result.cooldownMs);
      } else {
        setError(result.error || 'Failed to submit headline');
        if (result.cooldownMs) setCooldownMs(result.cooldownMs);
      }
    } catch {
      setError('An unexpected error occurred');
    } finally {
      setIsSubmitting(false);
    }
  };

  const formatCooldown = (ms: number): string => `${Math.ceil(ms / 1000)}s`;

  const isPlaying = phase === 'PLAYING';
  const canSubmit = isPlaying && !disabled && !isSubmitting && cooldownMs <= 0 && headline.trim().length > 0;

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 px-4 py-3">
      <form onSubmit={handleSubmit} className="flex items-center gap-3">
        <input
          type="text"
          value={headline}
          onChange={(e) => setHeadline(e.target.value)}
          placeholder={isPlaying ? 'Write a headline from the future...' : 'Headlines during playing phase only'}
          maxLength={280}
          disabled={!isPlaying || disabled || isSubmitting}
          className="flex-1 px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:border-transparent bg-gray-50 disabled:bg-gray-100 disabled:text-gray-400 placeholder:text-gray-400"
        />

        <Button
          type="submit"
          disabled={!canSubmit}
          size="md"
        >
          {isSubmitting ? (
            <svg className="animate-spin h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
          ) : cooldownMs > 0 ? (
            formatCooldown(cooldownMs)
          ) : (
            'Submit'
          )}
        </Button>
      </form>

      <div className="flex items-center justify-between mt-1.5 px-1">
        <span className="text-[11px] text-gray-300">{headline.length}/280</span>
        {cooldownMs > 0 && (
          <span className="text-[11px] text-amber-500">
            Next in {formatCooldown(cooldownMs)}
          </span>
        )}
        {error && (
          <span className="text-[11px] text-red-500">{error}</span>
        )}
      </div>
    </div>
  );
}
