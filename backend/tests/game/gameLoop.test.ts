import { computeNextPhase, computeRoundSpeedRatio, getBreakConfig } from '../../src/game/gameLoop';

describe('computeNextPhase', () => {
  describe('PLAYING phase transitions', () => {
    it('should transition from PLAYING to BREAK with same round (non-final rounds)', () => {
      const result = computeNextPhase('PLAYING', 1, 4);
      expect(result).toEqual({ phase: 'BREAK', round: 1 });
    });

    it('should work for any non-final round number', () => {
      expect(computeNextPhase('PLAYING', 3, 4)).toEqual({
        phase: 'BREAK',
        round: 3,
      });
    });

    it('should transition from PLAYING to FINISHED on the last round (no final break)', () => {
      const result = computeNextPhase('PLAYING', 4, 4);
      expect(result).toEqual({ phase: 'FINISHED', round: 4 });
    });

    it('should transition from PLAYING to FINISHED for 3-round games on round 3', () => {
      const result = computeNextPhase('PLAYING', 3, 3);
      expect(result).toEqual({ phase: 'FINISHED', round: 3 });
    });

    it('should transition from PLAYING to FINISHED when exceeding max rounds', () => {
      const result = computeNextPhase('PLAYING', 5, 4);
      expect(result).toEqual({ phase: 'FINISHED', round: 5 });
    });
  });

  describe('BREAK phase transitions', () => {
    it('should transition from BREAK to PLAYING with incremented round when not at max', () => {
      const result = computeNextPhase('BREAK', 1, 4);
      expect(result).toEqual({ phase: 'PLAYING', round: 2 });
    });

    it('should transition from BREAK to PLAYING for middle rounds', () => {
      expect(computeNextPhase('BREAK', 2, 4)).toEqual({
        phase: 'PLAYING',
        round: 3,
      });
    });

    it('should transition from BREAK to FINISHED when at max rounds', () => {
      const result = computeNextPhase('BREAK', 4, 4);
      expect(result).toEqual({ phase: 'FINISHED', round: 4 });
    });

    it('should transition from BREAK to FINISHED when exceeding max rounds', () => {
      const result = computeNextPhase('BREAK', 5, 4);
      expect(result).toEqual({ phase: 'FINISHED', round: 5 });
    });
  });

  describe('TUTORIAL phase transitions', () => {
    it('should transition from TUTORIAL to PLAYING round 1', () => {
      const result = computeNextPhase('TUTORIAL', 0, 3);
      expect(result).toEqual({ phase: 'PLAYING', round: 1 });
    });

    it('should transition from TUTORIAL to PLAYING round 1 regardless of max rounds', () => {
      expect(computeNextPhase('TUTORIAL', 0, 1)).toEqual({ phase: 'PLAYING', round: 1 });
      expect(computeNextPhase('TUTORIAL', 0, 10)).toEqual({ phase: 'PLAYING', round: 1 });
    });
  });

  describe('Edge cases', () => {
    it('should transition WAITING to FINISHED (unexpected but safe)', () => {
      const result = computeNextPhase('WAITING', 0, 4);
      expect(result).toEqual({ phase: 'FINISHED', round: 0 });
    });

    it('should transition FINISHED to FINISHED (idempotent)', () => {
      const result = computeNextPhase('FINISHED', 4, 4);
      expect(result).toEqual({ phase: 'FINISHED', round: 4 });
    });
  });

  describe('Different max rounds configurations', () => {
    it('should handle 3 round games', () => {
      expect(computeNextPhase('BREAK', 3, 3)).toEqual({
        phase: 'FINISHED',
        round: 3,
      });
      expect(computeNextPhase('BREAK', 2, 3)).toEqual({
        phase: 'PLAYING',
        round: 3,
      });
    });

    it('should handle single round games', () => {
      expect(computeNextPhase('BREAK', 1, 1)).toEqual({
        phase: 'FINISHED',
        round: 1,
      });
    });
  });
});

describe('computeRoundSpeedRatio', () => {
  const TOTAL_INGAME_MS = 20 * 365.25 * 24 * 60 * 60 * 1000;
  const PLAY_MINUTES = 2;
  const playMs = PLAY_MINUTES * 60_000;
  const TOTAL_WEIGHT = 20; // 2 + 4 + 6 + 8

  it('round 1 uses weight 2/20', () => {
    const expected = ((2 / TOTAL_WEIGHT) * TOTAL_INGAME_MS) / playMs;
    expect(computeRoundSpeedRatio(1, PLAY_MINUTES)).toBeCloseTo(expected, 10);
  });

  it('round 2 uses weight 4/20', () => {
    const expected = ((4 / TOTAL_WEIGHT) * TOTAL_INGAME_MS) / playMs;
    expect(computeRoundSpeedRatio(2, PLAY_MINUTES)).toBeCloseTo(expected, 10);
  });

  it('round 3 uses weight 6/20', () => {
    const expected = ((6 / TOTAL_WEIGHT) * TOTAL_INGAME_MS) / playMs;
    expect(computeRoundSpeedRatio(3, PLAY_MINUTES)).toBeCloseTo(expected, 10);
  });

  it('round 4 uses weight 8/20', () => {
    const expected = ((8 / TOTAL_WEIGHT) * TOTAL_INGAME_MS) / playMs;
    expect(computeRoundSpeedRatio(4, PLAY_MINUTES)).toBeCloseTo(expected, 10);
  });

  it('round 5+ clamps to weight 8 (last weight)', () => {
    expect(computeRoundSpeedRatio(5, PLAY_MINUTES)).toBeCloseTo(
      computeRoundSpeedRatio(4, PLAY_MINUTES),
      10
    );
    expect(computeRoundSpeedRatio(99, PLAY_MINUTES)).toBeCloseTo(
      computeRoundSpeedRatio(4, PLAY_MINUTES),
      10
    );
  });

  it('ratios across 4 rounds sum to cover exactly 20 in-game years per play minute', () => {
    const total =
      computeRoundSpeedRatio(1, PLAY_MINUTES) +
      computeRoundSpeedRatio(2, PLAY_MINUTES) +
      computeRoundSpeedRatio(3, PLAY_MINUTES) +
      computeRoundSpeedRatio(4, PLAY_MINUTES);
    const expected = TOTAL_INGAME_MS / playMs;
    expect(total).toBeCloseTo(expected, 10);
  });

  it('ratio scales inversely with play duration', () => {
    const ratio2min = computeRoundSpeedRatio(1, 2);
    const ratio4min = computeRoundSpeedRatio(1, 4);
    expect(ratio2min).toBeCloseTo(ratio4min * 2, 10);
  });

  it('rounds accelerate: round 1 < round 2 < round 3 < round 4', () => {
    const r1 = computeRoundSpeedRatio(1, PLAY_MINUTES);
    const r2 = computeRoundSpeedRatio(2, PLAY_MINUTES);
    const r3 = computeRoundSpeedRatio(3, PLAY_MINUTES);
    const r4 = computeRoundSpeedRatio(4, PLAY_MINUTES);
    expect(r1).toBeLessThan(r2);
    expect(r2).toBeLessThan(r3);
    expect(r3).toBeLessThan(r4);
  });
});

describe('getBreakConfig', () => {
  it('break after round 1: 3 min, no summary', () => {
    const cfg = getBreakConfig(1);
    expect(cfg.durationMin).toBe(3);
    expect(cfg.generateSummary).toBe(false);
    expect(cfg.summaryFromRound).toBeNull();
  });

  it('break after round 2: 5 min, summary covering rounds 1-2', () => {
    const cfg = getBreakConfig(2);
    expect(cfg.durationMin).toBe(5);
    expect(cfg.generateSummary).toBe(true);
    expect(cfg.summaryFromRound).toBe(1);
  });

  it('break after round 3: 3 min, no summary', () => {
    const cfg = getBreakConfig(3);
    expect(cfg.durationMin).toBe(3);
    expect(cfg.generateSummary).toBe(false);
    expect(cfg.summaryFromRound).toBeNull();
  });

  it('out-of-range rounds default to 3 min no summary', () => {
    expect(getBreakConfig(0).generateSummary).toBe(false);
    expect(getBreakConfig(5).generateSummary).toBe(false);
    expect(getBreakConfig(99).generateSummary).toBe(false);
  });
});

