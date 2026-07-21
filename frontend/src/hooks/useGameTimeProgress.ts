import { useState, useEffect, useRef } from 'react';

interface UseGameTimeProgressOptions {
  phase: string;
  isPaused?: boolean;
  currentRound: number;
  maxRounds: number;
  playMinutes: number;
  phaseStartedAt: string | null;
  pauseRemainingMs?: number | null;
  serverNow: string;
}

interface UseGameTimeProgressReturn {
  totalGameMins: number;
  currentGameMins: number;
}

/**
 * calculates total game minutes (t) and current elapsed play minutes (m)
 * for the score bar chart formula: bar width = w * (p/h) * (m/t)
 */
export function useGameTimeProgress({
  phase,
  isPaused = false,
  currentRound,
  maxRounds,
  playMinutes,
  phaseStartedAt,
  pauseRemainingMs = null,
  serverNow,
}: UseGameTimeProgressOptions): UseGameTimeProgressReturn {
  const [currentGameMins, setCurrentGameMins] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // snapshot the client-server time offset when we receive servernow
  const offsetRef = useRef(0);

  useEffect(() => {
    offsetRef.current = new Date(serverNow).getTime() - Date.now();
  }, [serverNow]);

  const totalGameMins = playMinutes * maxRounds;

  useEffect(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }

    const compute = () => {
      if (phase === 'WAITING') {
        setCurrentGameMins(0);
        return;
      }

      // completed play time from previous rounds
      let completedPlayMins: number;
      if (phase === 'PLAYING') {
        completedPlayMins = (currentRound - 1) * playMinutes;
      } else if (phase === 'BREAK') {
        completedPlayMins = currentRound * playMinutes;
      } else if (phase === 'FINISHED') {
        completedPlayMins = maxRounds * playMinutes;
      } else {
        completedPlayMins = 0;
      }

      // add current phase elapsed time if currently playing, capped at play duration
      let currentPhasePlayMins = 0;
      if (phase === 'PLAYING' && isPaused && pauseRemainingMs !== null) {
        currentPhasePlayMins = Math.max(0, Math.min(playMinutes, playMinutes - pauseRemainingMs / (60 * 1000)));
      } else if (phase === 'PLAYING' && phaseStartedAt) {
        const phaseStart = new Date(phaseStartedAt).getTime();
        const now = Date.now() + offsetRef.current;
        const elapsedMs = Math.max(0, now - phaseStart);
        const elapsedMins = elapsedMs / (60 * 1000);
        currentPhasePlayMins = Math.min(elapsedMins, playMinutes);
      }

      setCurrentGameMins(completedPlayMins + currentPhasePlayMins);
    };

    compute();

    if (phase === 'PLAYING' && !isPaused) {
      intervalRef.current = setInterval(compute, 1000);
    }

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [phase, isPaused, currentRound, maxRounds, playMinutes, phaseStartedAt, pauseRemainingMs, serverNow]);

  return {
    totalGameMins,
    currentGameMins,
  };
}
