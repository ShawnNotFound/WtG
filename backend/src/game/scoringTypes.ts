/**
 * scoring system types and configuration for the future headlines game.
 * this module defines all types and default configuration for headline scoring.
 */

/**
 * plausibility level assessed by ai (1-5 scale).
 * level 3 is the "sweet spot" for maximum points.
 */
export type PlausibilityLevel = 1 | 2 | 3 | 4 | 5;

/**
 * story connection level (how well a headline connects to previous headlines).
 * @deprecated use ConnectionScoreType instead for the new simplified scoring model.
 */
export type StoryConnectionLevel = 'LOW' | 'MEDIUM' | 'HIGH';

/**
 * connection score type for the old mutually exclusive scoring model.
 * @deprecated use uniqueOtherAuthors (number 0-3) instead.
 * kept for backwards compatibility with existing db rows.
 */
export type ConnectionScoreType = 'OTHERS' | 'SELF' | 'NONE';

/**
 * planet identifier - string type for flexibility.
 */
export type PlanetId = string;

/**
 * planet usage band: scoring tier a planet sits in based on global usage rank.
 * 2 = least-used (top) band, 1 = middle band, 0 = most-used (bottom) band.
 */
export type PlanetBand = 0 | 1 | 2;

/**
 * one row of the player-facing planet usage panel.
 */
export interface PlanetPanelEntry {
  /** planet id */
  id: PlanetId;
  /** global usage count for this planet */
  usage: number;
  /** scoring band (+2 / +1 / +0) */
  band: PlanetBand;
}

/**
 * default list of planets in the game.
 * can be extended or customized per game session.
 */
export const DEFAULT_PLANETS: PlanetId[] = [
  'MERCURY',
  'VENUS',
  'EARTH',
  'MARS',
  'JUPITER',
  'SATURN',
  'URANUS',
  'NEPTUNE',
  'PLUTO',
];

/**
 * configuration for plausibility scoring.
 */
export interface PlausibilityConfig {
  /** points for hitting the exact target level (e.g., level 3) */
  exactTarget: number;
  /** points for near-target levels (e.g., levels 2 and 4) */
  nearTarget: number;
  /** points for other levels (1 and 5) */
  other: number;
  /** the target level that yields maximum points */
  targetLevel: PlausibilityLevel;
  /** levels considered "near" the target */
  nearLevels: PlausibilityLevel[];
}

/**
 * configuration for story connection scoring.
 * @deprecated use ConnectionPointsConfig instead for the new simplified scoring model.
 */
export interface StoryConnectionConfig {
  LOW: number;
  MEDIUM: number;
  HIGH: number;
}

/**
 * configuration for connection scoring based on unique other author count.
 * points scale with how many distinct other players' headlines you connect to.
 */
export interface ConnectionPointsConfig {
  /** points by unique other author count: index = count (0, 1, 2, 3) */
  scale: [number, number, number, number];
}

/**
 * configuration for planet bonus scoring.
 * @deprecated use PlanetBonusConfigV2 for the new tally-based system.
 */
export interface PlanetBonusConfig {
  /** points when preferred planet is #1 in ai ranking */
  P1: number;
  /** points when preferred planet is #2 in ai ranking */
  P2: number;
  /** points when preferred planet is #3 in ai ranking */
  P3: number;
}

/**
 * configuration for planet bonus scoring (simplified tally-based system).
 * flat bonus when priority planet appears anywhere in ai's top-3.
 */
export interface PlanetBonusConfigV2 {
  /** points when priority planet matches anywhere in ai's top-3 */
  match: number;
}

/**
 * frequency-based tally state for planet priority selection.
 * tracks how often each planet appears in a player's headline evaluations.
 */
export interface PlanetTallyState {
  /** count of appearances in ai's top-3 for each planet */
  tally: Record<PlanetId, number>;
  /** last priority planet (excluded from next selection) */
  previousPriority: PlanetId | null;
  /** current priority planet for scoring */
  currentPriority: PlanetId | null;
}

/**
 * legacy lru-based planet usage state.
 * @deprecated use PlanetTallyState instead.
 */
export interface LegacyPlanetUsageEntry {
  /** round number when this planet was last used, or null if never used */
  lastUsedRound: number | null;
}

/**
 * legacy per-player state tracking usage of all planets.
 * @deprecated use PlanetTallyState instead.
 */
export type LegacyPlanetUsageState = Record<PlanetId, LegacyPlanetUsageEntry>;

/**
 * complete scoring configuration.
 */
export interface ScoringConfig {
  /** baseline points for submitting any headline (B) */
  baselineB: number;
  /** plausibility scoring configuration */
  plausibilityPoints: PlausibilityConfig;
  /** @deprecated use connectionPoints instead */
  selfStoryPoints: StoryConnectionConfig;
  /** @deprecated use connectionPoints instead */
  othersStoryPoints: StoryConnectionConfig;
  /** connection scoring (simplified model) */
  connectionPoints: ConnectionPointsConfig;
  /** @deprecated use planetBonus instead (kept for backwards compatibility) */
  planetBonusPoints: PlanetBonusConfig;
  /** planet bonus configuration (flat bonus for tally-based system) */
  planetBonus: PlanetBonusConfigV2;
  /** @deprecated no longer used in tally-based system */
  updatePlanetUsageOnNoMatch: boolean;
}

/**
 * default scoring configuration.
 * these values can be adjusted for game balance.
 */
export const DEFAULT_SCORING_CONFIG: ScoringConfig = {
  // base score for submitting a headline
  baselineB: 1,

  // plausibility scoring (A1 = exact target, A2 = near target)
  plausibilityPoints: {
    exactTarget: 2, // A1: level 3 (sweet spot)
    nearTarget: 1, // A2: levels 2 or 4
    other: 0, // levels 1 or 5 (too implausible or too obvious)
    targetLevel: 3,
    nearLevels: [2, 4],
  },

  // self story connection (X_L/M/H)
  selfStoryPoints: {
    LOW: 5,
    MEDIUM: 10,
    HIGH: 15,
  },

  // others story connection (Y_L/M/H) - deprecated
  othersStoryPoints: {
    LOW: 3,
    MEDIUM: 8,
    HIGH: 12,
  },

  // connection scoring: points by unique other author count (0/1/2/3)
  connectionPoints: {
    scale: [0, 1, 4, 9],
  },

  // planet bonus (P1/P2/P3) - deprecated, kept for backwards compatibility
  planetBonusPoints: {
    P1: 15, // preferred planet is #1 in ai ranking
    P2: 10, // preferred planet is #2 in ai ranking
    P3: 5, // preferred planet is #3 in ai ranking
  },

  // planet bonus (tally-based system) - flat bonus when priority matches
  planetBonus: {
    match: 2, // flat +2 when priority planet is anywhere in ai's top-3
  },

  // @deprecated - no longer used in tally-based system
  updatePlanetUsageOnNoMatch: true,
};

/**
 * input from ai/llm evaluation for a single headline.
 * this is the data structure the ai will provide.
 */
export interface HeadlineScoringInput {
  /** ai-assessed plausibility level (1-5) - stored for reference */
  plausibilityLevel: PlausibilityLevel;
  /** selected band from dice roll (1-5) - used for scoring */
  selectedBand: PlausibilityLevel;
  /** number of unique other authors from STRONG linked headlines (0-3) */
  uniqueOtherAuthors: number;
  /** @deprecated use uniqueOtherAuthors instead */
  connectionType?: ConnectionScoreType;
  /** @deprecated use uniqueOtherAuthors instead */
  selfStoryConnection?: StoryConnectionLevel;
  /** @deprecated use uniqueOtherAuthors instead */
  othersStoryConnection?: StoryConnectionLevel;
  /** ai's top-3 planet classifications for this headline */
  aiPlanetRankings: PlanetId[];
  /** the round number when this headline was submitted */
  roundNo: number;
}

/**
 * breakdown of scores for a single headline.
 */
export interface HeadlineScoreBreakdown {
  /** baseline points (B) */
  baseline: number;
  /** plausibility points (A1/A2/other) */
  plausibility: number;
  /** connection score (0/1/4/9 based on unique other author count 0/1/2/3) */
  connectionScore: number;
  /** @deprecated kept for backwards compatibility, always 0 */
  selfStory: number;
  /** @deprecated kept for backwards compatibility, always 0 */
  othersStory: number;
  /** planet bonus points (P1/P2/P3) */
  planetBonus: number;
  /** total headline score */
  total: number;
}

/**
 * player entry in the leaderboard.
 */
export interface PlayerScoreEntry {
  playerId: string;
  nickname: string;
  totalScore: number;
  rank: number;
  /** this player's ordered planet usage panel (when computed during scoring) */
  planetPanel?: PlanetPanelEntry[];
}

/**
 * full payload for headline evaluation from llm/heuristic.
 */
export interface HeadlineEvaluationPayload extends HeadlineScoringInput {
  sessionId: string;
  playerId: string;
  headlineId: string;
}

/**
 * result of applying a headline evaluation.
 */
export interface HeadlineEvaluationResult {
  breakdown: HeadlineScoreBreakdown;
  newTotalScore: number;
  /** leaderboard entries, each carrying that player's recomputed planet panel */
  leaderboard: PlayerScoreEntry[];
}
