/**
 * compute the current in-game timeline date from phase timing.
 *
 * the in-game clock advances at `timelineSpeedRatio` × real time (the ratio is
 * large during PLAYING — it compresses a ~20-year span into a few real minutes).
 * real elapsed time is clamped to the phase window so a stale or overrun phase
 * (e.g. a session left in PLAYING after a server restart, with a long-past
 * phase_started_at) cannot overflow the JS Date range and produce an Invalid
 * Date — which previously threw `RangeError: Invalid time value` on toISOString().
 */
export function computeInGameNow(
  inGameStartAt: Date | string | null,
  phaseStartedAt: Date | string | null,
  phaseEndsAt: Date | string | null,
  serverNow: Date,
  timelineSpeedRatio: number
): Date | null {
  if (!inGameStartAt || !phaseStartedAt) {
    return null;
  }

  const inGameStart = new Date(inGameStartAt);
  const phaseStart = new Date(phaseStartedAt);
  if (isNaN(inGameStart.getTime()) || isNaN(phaseStart.getTime())) {
    return null;
  }

  let realElapsed = serverNow.getTime() - phaseStart.getTime();

  // clamp to [0, phase duration]: in-game time should not advance past the
  // phase's scheduled end, and a long-stale phase must not overflow the range.
  if (phaseEndsAt) {
    const phaseDuration = new Date(phaseEndsAt).getTime() - phaseStart.getTime();
    if (Number.isFinite(phaseDuration) && phaseDuration > 0) {
      realElapsed = Math.min(Math.max(realElapsed, 0), phaseDuration);
    } else {
      realElapsed = Math.max(realElapsed, 0);
    }
  } else {
    realElapsed = Math.max(realElapsed, 0);
  }

  const ratio = Number.isFinite(timelineSpeedRatio) ? timelineSpeedRatio : 0;
  const candidate = new Date(inGameStart.getTime() + realElapsed * ratio);
  return isNaN(candidate.getTime()) ? inGameStart : candidate;
}
