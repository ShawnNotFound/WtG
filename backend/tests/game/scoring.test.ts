/**
 * Unit tests for pure scoring functions.
 */

import {
  computeBaselineScore,
  computePlausibilityScore,
  computeStoryConnectionScore,
  computeConnectionScore,
  computeHeadlineScore,
  getPlausibilityLabel,
  getStoryConnectionLabel,
} from '../../src/game/scoring';
import {
  DEFAULT_SCORING_CONFIG,
  ScoringConfig,
  PlausibilityLevel,
  HeadlineScoringInput,
} from '../../src/game/scoringTypes';

describe('Scoring Functions', () => {
  describe('computeBaselineScore', () => {
    it('should return the baseline score from config', () => {
      expect(computeBaselineScore(DEFAULT_SCORING_CONFIG)).toBe(1);
    });

    it('should use custom baseline when provided', () => {
      const customConfig: ScoringConfig = {
        ...DEFAULT_SCORING_CONFIG,
        baselineB: 25,
      };
      expect(computeBaselineScore(customConfig)).toBe(25);
    });
  });

  describe('computePlausibilityScore', () => {
    it('should return exactTarget (A1) points for level 3', () => {
      const score = computePlausibilityScore(3, DEFAULT_SCORING_CONFIG);
      expect(score).toBe(DEFAULT_SCORING_CONFIG.plausibilityPoints.exactTarget);
      expect(score).toBe(2);
    });

    it('should return nearTarget (A2) points for level 2', () => {
      const score = computePlausibilityScore(2, DEFAULT_SCORING_CONFIG);
      expect(score).toBe(DEFAULT_SCORING_CONFIG.plausibilityPoints.nearTarget);
      expect(score).toBe(1);
    });

    it('should return nearTarget (A2) points for level 4', () => {
      const score = computePlausibilityScore(4, DEFAULT_SCORING_CONFIG);
      expect(score).toBe(DEFAULT_SCORING_CONFIG.plausibilityPoints.nearTarget);
      expect(score).toBe(1);
    });

    it('should return other points for level 1', () => {
      const score = computePlausibilityScore(1, DEFAULT_SCORING_CONFIG);
      expect(score).toBe(DEFAULT_SCORING_CONFIG.plausibilityPoints.other);
      expect(score).toBe(0);
    });

    it('should return other points for level 5', () => {
      const score = computePlausibilityScore(5, DEFAULT_SCORING_CONFIG);
      expect(score).toBe(DEFAULT_SCORING_CONFIG.plausibilityPoints.other);
      expect(score).toBe(0);
    });

    it('should work with all plausibility levels 1-5', () => {
      const levels: PlausibilityLevel[] = [1, 2, 3, 4, 5];
      const expectedScores = [0, 1, 2, 1, 0];

      levels.forEach((level, index) => {
        expect(computePlausibilityScore(level, DEFAULT_SCORING_CONFIG)).toBe(
          expectedScores[index]
        );
      });
    });

    it('should use custom config correctly', () => {
      const customConfig: ScoringConfig = {
        ...DEFAULT_SCORING_CONFIG,
        plausibilityPoints: {
          exactTarget: 50,
          nearTarget: 25,
          other: 5,
          targetLevel: 4,
          nearLevels: [3, 5],
        },
      };

      expect(computePlausibilityScore(4, customConfig)).toBe(50); // exactTarget
      expect(computePlausibilityScore(3, customConfig)).toBe(25); // nearTarget
      expect(computePlausibilityScore(5, customConfig)).toBe(25); // nearTarget
      expect(computePlausibilityScore(1, customConfig)).toBe(5); // other
      expect(computePlausibilityScore(2, customConfig)).toBe(5); // other
    });
  });

  describe('computeStoryConnectionScore', () => {
    it('should return correct points for LOW connection', () => {
      const score = computeStoryConnectionScore(
        'LOW',
        DEFAULT_SCORING_CONFIG.selfStoryPoints
      );
      expect(score).toBe(5);
    });

    it('should return correct points for MEDIUM connection', () => {
      const score = computeStoryConnectionScore(
        'MEDIUM',
        DEFAULT_SCORING_CONFIG.selfStoryPoints
      );
      expect(score).toBe(10);
    });

    it('should return correct points for HIGH connection', () => {
      const score = computeStoryConnectionScore(
        'HIGH',
        DEFAULT_SCORING_CONFIG.selfStoryPoints
      );
      expect(score).toBe(15);
    });

    it('should work with othersStoryPoints table', () => {
      expect(
        computeStoryConnectionScore('LOW', DEFAULT_SCORING_CONFIG.othersStoryPoints)
      ).toBe(3);
      expect(
        computeStoryConnectionScore('MEDIUM', DEFAULT_SCORING_CONFIG.othersStoryPoints)
      ).toBe(8);
      expect(
        computeStoryConnectionScore('HIGH', DEFAULT_SCORING_CONFIG.othersStoryPoints)
      ).toBe(12);
    });

    it('should work with custom points table', () => {
      const customTable = { LOW: 1, MEDIUM: 5, HIGH: 20 };
      expect(computeStoryConnectionScore('LOW', customTable)).toBe(1);
      expect(computeStoryConnectionScore('MEDIUM', customTable)).toBe(5);
      expect(computeStoryConnectionScore('HIGH', customTable)).toBe(20);
    });
  });

  describe('computeConnectionScore', () => {
    it('should return 0 points for 0 unique other authors', () => {
      expect(computeConnectionScore(0, DEFAULT_SCORING_CONFIG)).toBe(0);
    });

    it('should return 1 point for 1 unique other author', () => {
      expect(computeConnectionScore(1, DEFAULT_SCORING_CONFIG)).toBe(1);
    });

    it('should return 4 points for 2 unique other authors', () => {
      expect(computeConnectionScore(2, DEFAULT_SCORING_CONFIG)).toBe(4);
    });

    it('should return 9 points for 3 unique other authors', () => {
      expect(computeConnectionScore(3, DEFAULT_SCORING_CONFIG)).toBe(9);
    });

    it('should cap at 3 for values above 3', () => {
      expect(computeConnectionScore(4, DEFAULT_SCORING_CONFIG)).toBe(9);
      expect(computeConnectionScore(10, DEFAULT_SCORING_CONFIG)).toBe(9);
    });

    it('should handle negative values as 0', () => {
      expect(computeConnectionScore(-1, DEFAULT_SCORING_CONFIG)).toBe(0);
    });

    it('should work with custom config', () => {
      const customConfig: ScoringConfig = {
        ...DEFAULT_SCORING_CONFIG,
        connectionPoints: {
          scale: [0, 2, 6, 12],
        },
      };
      expect(computeConnectionScore(0, customConfig)).toBe(0);
      expect(computeConnectionScore(1, customConfig)).toBe(2);
      expect(computeConnectionScore(2, customConfig)).toBe(6);
      expect(computeConnectionScore(3, customConfig)).toBe(12);
    });
  });

  describe('computeHeadlineScore', () => {
    const baseInput: HeadlineScoringInput = {
      plausibilityLevel: 3,
      selectedBand: 3,
      uniqueOtherAuthors: 3,
      aiPlanetRankings: ['MARS', 'VENUS', 'EARTH'],
      roundNo: 1,
    };

    it('should compute correct total with 3 unique other authors (max)', () => {
      const planetBonus = 2;
      const breakdown = computeHeadlineScore(
        baseInput,
        planetBonus,
        DEFAULT_SCORING_CONFIG
      );

      expect(breakdown.baseline).toBe(1); // B
      expect(breakdown.plausibility).toBe(2); // A1 (level 3)
      expect(breakdown.connectionScore).toBe(9); // 3 unique others
      expect(breakdown.selfStory).toBe(0); // Deprecated
      expect(breakdown.othersStory).toBe(0); // Deprecated
      expect(breakdown.planetBonus).toBe(2);
      expect(breakdown.total).toBe(1 + 2 + 9 + 2);
      expect(breakdown.total).toBe(14);
    });

    it('should compute correctly with 2 unique other authors', () => {
      const input: HeadlineScoringInput = {
        ...baseInput,
        uniqueOtherAuthors: 2,
      };
      const breakdown = computeHeadlineScore(input, 0, DEFAULT_SCORING_CONFIG);

      expect(breakdown.connectionScore).toBe(4); // 2 unique others
      expect(breakdown.total).toBe(1 + 2 + 4 + 0);
      expect(breakdown.total).toBe(7);
    });

    it('should compute correctly with 1 unique other author', () => {
      const input: HeadlineScoringInput = {
        ...baseInput,
        uniqueOtherAuthors: 1,
      };
      const breakdown = computeHeadlineScore(input, 0, DEFAULT_SCORING_CONFIG);

      expect(breakdown.connectionScore).toBe(1); // 1 unique other
      expect(breakdown.total).toBe(1 + 2 + 1 + 0);
      expect(breakdown.total).toBe(4);
    });

    it('should compute correctly with 0 unique other authors', () => {
      const input: HeadlineScoringInput = {
        ...baseInput,
        uniqueOtherAuthors: 0,
      };
      const breakdown = computeHeadlineScore(input, 0, DEFAULT_SCORING_CONFIG);

      expect(breakdown.connectionScore).toBe(0); // 0 unique others
      expect(breakdown.total).toBe(1 + 2 + 0 + 0);
      expect(breakdown.total).toBe(3);
    });

    it('should compute correctly with zero planet bonus', () => {
      const breakdown = computeHeadlineScore(
        baseInput,
        0,
        DEFAULT_SCORING_CONFIG
      );

      expect(breakdown.planetBonus).toBe(0);
      expect(breakdown.total).toBe(1 + 2 + 9 + 0);
      expect(breakdown.total).toBe(12);
    });

    it('should compute correctly with different plausibility levels (AI assessment)', () => {
      const inputLevel1: HeadlineScoringInput = {
        ...baseInput,
        plausibilityLevel: 1,
      };
      const breakdown1 = computeHeadlineScore(inputLevel1, 0, DEFAULT_SCORING_CONFIG);
      expect(breakdown1.plausibility).toBe(0); // Level 1 = 0 points

      const inputLevel2: HeadlineScoringInput = {
        ...baseInput,
        plausibilityLevel: 2,
      };
      const breakdown2 = computeHeadlineScore(inputLevel2, 0, DEFAULT_SCORING_CONFIG);
      expect(breakdown2.plausibility).toBe(1); // Level 2 = near target

      const inputLevel5: HeadlineScoringInput = {
        ...baseInput,
        plausibilityLevel: 5,
      };
      const breakdown5 = computeHeadlineScore(inputLevel5, 0, DEFAULT_SCORING_CONFIG);
      expect(breakdown5.plausibility).toBe(0); // Level 5 = 0 points
    });

    it('should react to config changes for connection points', () => {
      const customConfig: ScoringConfig = {
        ...DEFAULT_SCORING_CONFIG,
        baselineB: 5,
        connectionPoints: { scale: [0, 2, 6, 12] },
      };

      const breakdown = computeHeadlineScore(baseInput, 10, customConfig);

      expect(breakdown.baseline).toBe(5);
      expect(breakdown.connectionScore).toBe(12); // 3 unique others with custom scale
      expect(breakdown.total).toBe(5 + 2 + 12 + 10);
      expect(breakdown.total).toBe(29);
    });

    it('should scale connection score with unique other author count', () => {
      const scores = [0, 1, 2, 3].map((n) =>
        computeHeadlineScore(
          { ...baseInput, uniqueOtherAuthors: n },
          0,
          DEFAULT_SCORING_CONFIG
        ).connectionScore
      );
      expect(scores).toEqual([0, 1, 4, 9]);
    });
  });

  describe('getPlausibilityLabel', () => {
    it('should return A1 for target level', () => {
      expect(getPlausibilityLabel(3, DEFAULT_SCORING_CONFIG)).toBe('A1');
    });

    it('should return A2 for near levels', () => {
      expect(getPlausibilityLabel(2, DEFAULT_SCORING_CONFIG)).toBe('A2');
      expect(getPlausibilityLabel(4, DEFAULT_SCORING_CONFIG)).toBe('A2');
    });

    it('should return other for remaining levels', () => {
      expect(getPlausibilityLabel(1, DEFAULT_SCORING_CONFIG)).toBe('other');
      expect(getPlausibilityLabel(5, DEFAULT_SCORING_CONFIG)).toBe('other');
    });
  });

  describe('getStoryConnectionLabel', () => {
    it('should format self story labels correctly', () => {
      expect(getStoryConnectionLabel('LOW', 'X')).toBe('X_L');
      expect(getStoryConnectionLabel('MEDIUM', 'X')).toBe('X_M');
      expect(getStoryConnectionLabel('HIGH', 'X')).toBe('X_H');
    });

    it('should format others story labels correctly', () => {
      expect(getStoryConnectionLabel('LOW', 'Y')).toBe('Y_L');
      expect(getStoryConnectionLabel('MEDIUM', 'Y')).toBe('Y_M');
      expect(getStoryConnectionLabel('HIGH', 'Y')).toBe('Y_H');
    });
  });
});
