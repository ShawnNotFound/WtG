// Shared headline submission cooldown for human and AI players.
// AI players should behave like fast-thinking players, not bypass rate limits.

const TEST_MODE = process.env.NODE_ENV !== 'test' && process.env.GAME_TEST_MODE === 'true';
export const HEADLINE_COOLDOWN_MS = TEST_MODE ? Math.round(90_000 / 16) : 90_000;

const lastHeadlineSubmission: Map<string, number> = new Map();

function keyFor(sessionId: string, playerId: string): string {
  return `${sessionId}:${playerId}`;
}

export function getHeadlineCooldownMs(): number {
  return HEADLINE_COOLDOWN_MS;
}

export function canSubmitHeadline(sessionId: string, playerId: string): { allowed: boolean; remainingMs: number } {
  const lastSubmission = lastHeadlineSubmission.get(keyFor(sessionId, playerId));
  const now = Date.now();

  if (!lastSubmission) {
    return { allowed: true, remainingMs: 0 };
  }

  const elapsed = now - lastSubmission;
  if (elapsed >= HEADLINE_COOLDOWN_MS) {
    return { allowed: true, remainingMs: 0 };
  }

  return { allowed: false, remainingMs: HEADLINE_COOLDOWN_MS - elapsed };
}

export function recordHeadlineSubmission(sessionId: string, playerId: string): void {
  lastHeadlineSubmission.set(keyFor(sessionId, playerId), Date.now());
}

export function clearSessionRateLimits(sessionId: string): void {
  for (const key of lastHeadlineSubmission.keys()) {
    if (key.startsWith(`${sessionId}:`)) {
      lastHeadlineSubmission.delete(key);
    }
  }
}
