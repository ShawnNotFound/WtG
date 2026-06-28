import { useState, useEffect, useRef } from 'react';

interface UseInGameNowOptions {
  /** last ingamenow snapshot from the server (iso string). */
  inGameNow: string | null;
  /** server timestamp that accompanied the snapshot (iso string). */
  serverNow: string;
  /** real-world phase end timestamp. Used to stop local ticking while phase transition waits on backend work. */
  phaseEndsAt?: string | null;
  /** how many in-game seconds per real-world second. */
  timelineSpeedRatio: number;
  /** only tick while true (e.g. during playing/break). */
  enabled?: boolean;
}

/**
 * derives a ticking in-game timestamp from the last server snapshot,
 * updating every minute so the "current period" card stays fresh
 * without requiring extra socket emissions.
 */
export function useInGameNow({
  inGameNow,
  serverNow,
  phaseEndsAt = null,
  timelineSpeedRatio,
  enabled = true,
}: UseInGameNowOptions): string | null {
  const [derived, setDerived] = useState<string | null>(inGameNow);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // snapshot the moment we received the server values
  const snapshotRef = useRef({
    clientTime: Date.now(),
    serverTime: new Date(serverNow).getTime(),
    inGameTime: inGameNow ? new Date(inGameNow).getTime() : 0,
  });

  // re-snapshot whenever the server sends new values, then immediately recompute
  useEffect(() => {
    snapshotRef.current = {
      clientTime: Date.now(),
      serverTime: new Date(serverNow).getTime(),
      inGameTime: inGameNow ? new Date(inGameNow).getTime() : 0,
    };
    if (inGameNow) {
      setDerived(inGameNow);
    } else {
      setDerived(null);
    }
  }, [inGameNow, serverNow]);

  useEffect(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }

    if (!enabled || !inGameNow) {
      return;
    }

    const compute = () => {
      const snap = snapshotRef.current;
      if (snap.inGameTime === 0) return;

      // scale real elapsed by timelinespeedratio to get in-game elapsed
      let realElapsedMs = Date.now() - snap.clientTime;
      if (phaseEndsAt) {
        const phaseEndMs = new Date(phaseEndsAt).getTime();
        const maxElapsedMs = phaseEndMs - snap.serverTime;
        if (Number.isFinite(maxElapsedMs)) {
          realElapsedMs = Math.min(realElapsedMs, Math.max(0, maxElapsedMs));
        }
      }
      const inGameElapsedMs = realElapsedMs * timelineSpeedRatio;
      const newInGameTime = snap.inGameTime + inGameElapsedMs;

      setDerived(new Date(newInGameTime).toISOString());
    };

    // compute immediately, then every 5 seconds
    compute();
    intervalRef.current = setInterval(compute, 5_000);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [enabled, inGameNow, phaseEndsAt, timelineSpeedRatio]);

  return derived;
}
