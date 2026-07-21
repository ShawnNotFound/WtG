/**
 * pure scoring functions for headline evaluation.
 * these functions have no side effects and don't access the database.
 */

import {
  PlausibilityLevel,
  StoryConnectionLevel,
  ScoringConfig,
  HeadlineScoringInput,
  HeadlineScoreBreakdown,
  StoryConnectionConfig,
} from './scoringTypes.js';

/**
 * compute baseline score (B) for submitting a headline.
 * every headline gets this just for being submitted.
 *
 * @param config - scoring configuration
 * @returns baseline score (B)
 */
export function computeBaselineScore(config: ScoringConfig): number {
  return config.baselineB;
}

/**
 * compute plausibility score based on ai-assessed level.
 *
 * scoring logic:
 * - exactTarget (A1): level matches targetLevel (default: 3)
 * - nearTarget (A2): level is in nearLevels (default: 2 or 4)
 * - other: any other level (1 or 5)
 *
 * the idea is that level 3 is the "sweet spot" - plausible but creative.
 * levels 1 and 5 are either too implausible or too obvious.
 *
 * @param level - ai-assessed plausibility level (1-5)
 * @param config - scoring configuration
 * @returns plausibility score (A1/A2/other)
 */
export function computePlausibilityScore(
  level: PlausibilityLevel,
  config: ScoringConfig
): number {
  const { plausibilityPoints } = config;

  // check for exact target (A1)
  if (level === plausibilityPoints.targetLevel) {
    return plausibilityPoints.exactTarget;
  }

  // check for near target (A2)
  if (plausibilityPoints.nearLevels.includes(level)) {
    return plausibilityPoints.nearTarget;
  }

  // other levels
  return plausibilityPoints.other;
}

/**
 * compute story connection score from a connection level.
 * used for both self-story (X_L/M/H) and others-story (Y_L/M/H) connections.
 *
 * @deprecated use computeConnectionScore instead for the simplified model.
 * @param level - story connection level (low, medium, high)
 * @param pointsTable - table mapping levels to points
 * @returns story connection score
 */
export function computeStoryConnectionScore(
  level: StoryConnectionLevel,
  pointsTable: StoryConnectionConfig
): number {
  return pointsTable[level];
}

/**
 * compute connection score based on unique other author count.
 *
 * scoring logic (default scale [0, 1, 4, 9]):
 * - 0 unique other authors → 0 pts
 * - 1 unique other author  → 1 pt
 * - 2 unique other authors → 4 pts
 * - 3 unique other authors → 9 pts
 *
 * @param uniqueOtherAuthors - count of unique other authors from STRONG links (0-3)
 * @param config - scoring configuration
 * @returns connection score
 */
export function computeConnectionScore(
  uniqueOtherAuthors: number,
  config: ScoringConfig
): number {
  const idx = Math.min(Math.max(uniqueOtherAuthors, 0), 3);
  return config.connectionPoints.scale[idx] ?? 0;
}

/**
 * compute the complete score breakdown for a headline.
 * this is a pure function that takes all inputs and returns the breakdown.
 *
 * note: the planet bonus is computed separately via planetWeighting.ts
 * and passed in here, because planet bonus depends on player-specific
 * lru state which is handled elsewhere.
 *
 * important: plausibility scoring uses the ai's plausibilityLevel assessment,
 * which reflects how plausible the player's story direction is. the dice roll
 * (selectedBand) only determines which headline variant is displayed, not scoring.
 *
 * connection scoring uses the simplified mutually exclusive model:
 * - OTHERS: +3 pts (connected to another player's headline)
 * - SELF: +1 pt (connected only to own headlines)
 * - NONE: 0 pts (no strong connections)
 *
 * @param input - ai/heuristic evaluation input
 * @param planetBonus - pre-computed planet bonus (from applyPlanetScoringAndUsage)
 * @param config - scoring configuration
 * @returns complete score breakdown with total
 */
export function computeHeadlineScore(
  input: HeadlineScoringInput,
  planetBonus: number,
  config: ScoringConfig
): HeadlineScoreBreakdown {
  const baseline = computeBaselineScore(config);

  // use ai's plausibilityLevel assessment for scoring.
  // level 3 = best (A1), level 2/4 = good (A2), level 1/5 = 0 points
  const plausibility = computePlausibilityScore(
    input.plausibilityLevel,
    config
  );

  // connection scoring based on unique other author count
  const connectionScore = computeConnectionScore(input.uniqueOtherAuthors, config);

  const total = baseline + plausibility + connectionScore + planetBonus;

  return {
    baseline,
    plausibility,
    connectionScore,
    // deprecated fields kept for backwards compatibility
    selfStory: 0,
    othersStory: 0,
    planetBonus,
    total,
  };
}

/**
 * helper to get the label for a plausibility score (for display/debugging).
 *
 * @param level - plausibility level
 * @param config - scoring configuration
 * @returns label like "A1", "A2", or "other"
 */
export function getPlausibilityLabel(
  level: PlausibilityLevel,
  config: ScoringConfig
): string {
  if (level === config.plausibilityPoints.targetLevel) {
    return 'A1';
  }
  if (config.plausibilityPoints.nearLevels.includes(level)) {
    return 'A2';
  }
  return 'other';
}

/**
 * helper to format story connection level as X_L/M/H or Y_L/M/H.
 *
 * @param level - story connection level
 * @param prefix - 'X' for self, 'Y' for others
 * @returns label like "X_M" or "Y_H"
 */
export function getStoryConnectionLabel(
  level: StoryConnectionLevel,
  prefix: 'X' | 'Y'
): string {
  const suffix = level === 'LOW' ? 'L' : level === 'MEDIUM' ? 'M' : 'H';
  return `${prefix}_${suffix}`;
}
