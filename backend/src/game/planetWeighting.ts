/**
 * DEPRECATED — replaced by planetUsage.ts (band-based global planet usage system).
 *
 * This module implemented the old per-player "priority planet" system: each player
 * had a single priority planet and earned a flat +2 bonus when it appeared in the
 * AI's top-3. It is no longer wired into the scoring path or any socket payload.
 * Retained (unreferenced) for reference and quick rollback; remove in a later cleanup.
 *
 * planet weighting and frequency-based tally logic for the scoring system.
 * implements per-player planet priority tracking with tally-based selection.
 */

import {
  PlanetId,
  ScoringConfig,
  DEFAULT_PLANETS,
  PlanetTallyState,
  LegacyPlanetUsageState,
  LegacyPlanetUsageEntry,
} from './scoringTypes.js';

/**
 * tally weight per planet — higher weight means the tally grows faster,
 * which makes the planet less likely to be selected as priority.
 * abstract/hard-to-target planets get higher weights so they appear
 * as priority less often.
 */
export const PLANET_TALLY_WEIGHTS: Record<string, number> = {
  MERCURY: 2, VENUS: 2, EARTH: 2, MARS: 2,
  JUPITER: 2, SATURN: 2, URANUS: 2,
  NEPTUNE: 3, PLUTO: 3,
};

export type { PlanetTallyState, LegacyPlanetUsageState };

// legacy type alias for backwards compatibility
export type PlanetUsageState = PlanetTallyState;
export type PlanetUsageEntry = LegacyPlanetUsageEntry;

/**
 * create initial planet tally state with all planets at count 0.
 *
 * @param allPlanets - list of planet ids to track
 * @returns initial tally state with zero counts and null priorities
 */
export function initialPlanetTallyState(
  allPlanets: PlanetId[] = DEFAULT_PLANETS
): PlanetTallyState {
  const tally: Record<PlanetId, number> = {};
  for (const planet of allPlanets) {
    tally[planet] = 0;
  }
  return {
    tally,
    previousPriority: null,
    currentPriority: null,
  };
}

/**
 * legacy function alias for backwards compatibility.
 * @deprecated use initialPlanetTallyState instead.
 */
export function initialPlanetUsageState(
  allPlanets: PlanetId[] = DEFAULT_PLANETS
): PlanetTallyState {
  return initialPlanetTallyState(allPlanets);
}

/**
 * check if a state object is in the legacy lru format.
 *
 * @param state - state object to check
 * @returns true if the state is in legacy format
 */
export function isLegacyState(state: unknown): state is LegacyPlanetUsageState {
  if (!state || typeof state !== 'object') {
    return false;
  }

  // legacy state has planet ids as keys with { lastUsedRound } values.
  // new state has { tally, previousPriority, currentPriority }
  const obj = state as Record<string, unknown>;

  // if it has 'tally' key, it's the new format
  if ('tally' in obj) {
    return false;
  }

  // check if any value has lastUsedRound property (legacy format)
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (
      value &&
      typeof value === 'object' &&
      'lastUsedRound' in (value as object)
    ) {
      return true;
    }
  }

  // empty object or unknown format - treat as needing initialization
  return Object.keys(obj).length > 0;
}

/**
 * convert legacy lru state to new tally state.
 * all planets start at count 0 in the new system.
 *
 * @param legacyState - legacy lru state
 * @param allPlanets - list of all planets to include
 * @returns new tally state
 */
export function convertLegacyToTallyState(
  legacyState: LegacyPlanetUsageState,
  allPlanets: PlanetId[] = DEFAULT_PLANETS
): PlanetTallyState {
  const tally: Record<PlanetId, number> = {};

  for (const planet of allPlanets) {
    tally[planet] = 0;
  }

  // also include any planets from the legacy state that might not be in allPlanets
  for (const planet of Object.keys(legacyState)) {
    if (!(planet in tally)) {
      tally[planet] = 0;
    }
  }

  return {
    tally,
    previousPriority: null,
    currentPriority: null,
  };
}

/**
 * migrate state from any format to the new tally format.
 * handles: null, empty, legacy lru, or already-new format.
 *
 * @param rawState - raw state from database
 * @param allPlanets - list of all planets to include
 * @returns valid PlanetTallyState
 */
export function migratePlanetState(
  rawState: unknown,
  allPlanets: PlanetId[] = DEFAULT_PLANETS
): PlanetTallyState {
  // null or undefined - create fresh state
  if (!rawState) {
    return initialPlanetTallyState(allPlanets);
  }

  // empty object - create fresh state
  if (typeof rawState === 'object' && Object.keys(rawState as object).length === 0) {
    return initialPlanetTallyState(allPlanets);
  }

  if (isLegacyState(rawState)) {
    return convertLegacyToTallyState(rawState, allPlanets);
  }

  // assume it's already in the new format
  const state = rawState as PlanetTallyState;

  // ensure all expected planets are in the tally
  const tally = { ...state.tally };
  for (const planet of allPlanets) {
    if (!(planet in tally)) {
      tally[planet] = 0;
    }
  }

  return {
    tally,
    previousPriority: state.previousPriority ?? null,
    currentPriority: state.currentPriority ?? null,
  };
}

/**
 * select a new priority planet from the bottom half of tally counts.
 *
 * algorithm:
 * 1. sort planets by tally count (ascending)
 * 2. take bottom half (rounded up, at least 1)
 * 3. exclude the previous priority planet
 * 4. random selection from remaining candidates
 *
 * @param state - current planet tally state
 * @param allPlanets - list of all planet ids
 * @returns selected priority planet, or null if no planets available
 */
export function selectPriorityPlanet(
  state: PlanetTallyState,
  allPlanets: PlanetId[] = DEFAULT_PLANETS
): PlanetId | null {
  if (allPlanets.length === 0) {
    return null;
  }

  // sort planets by tally count (ascending)
  const sorted = [...allPlanets].sort(
    (a, b) => (state.tally[a] ?? 0) - (state.tally[b] ?? 0)
  );

  // take bottom half (rounded up, at least 1)
  const bottomHalfCount = Math.max(1, Math.ceil(sorted.length / 2));
  const bottomHalf = sorted.slice(0, bottomHalfCount);

  // exclude previous priority
  let candidates = bottomHalf.filter((p) => p !== state.previousPriority);

  // if no candidates after exclusion (edge case), use full bottom half
  if (candidates.length === 0) {
    candidates = [...bottomHalf];
  }

  const randomIndex = Math.floor(Math.random() * candidates.length);
  return candidates[randomIndex];
}

/**
 * legacy function alias for backwards compatibility.
 * returns the current priority planet from state.
 * @deprecated use state.currentPriority directly or selectPriorityPlanet.
 */
export function getPreferredPlanet(state: PlanetTallyState): PlanetId | null {
  return state.currentPriority;
}

/**
 * increment tally counts for all planets in the ai's top-3 rankings.
 *
 * @param state - current planet tally state
 * @param aiTop3 - ai's top-3 planet classifications
 * @returns new state with updated tally counts
 */
export function updatePlanetTally(
  state: PlanetTallyState,
  aiTop3: PlanetId[]
): PlanetTallyState {
  const newTally = { ...state.tally };

  for (const planet of aiTop3.slice(0, 3)) {
    const weight = PLANET_TALLY_WEIGHTS[planet] ?? 1;
    newTally[planet] = (newTally[planet] ?? 0) + weight;
  }

  return {
    ...state,
    tally: newTally,
  };
}

/**
 * legacy function - no longer needed in tally system.
 * @deprecated use updatePlanetTally instead.
 */
export function applyPlanetUsage(
  state: PlanetTallyState,
  _used: PlanetId,
  _roundNo: number
): PlanetTallyState {
  // no-op in new system - tally updates happen via updatePlanetTally
  return state;
}

/**
 * result of planet bonus calculation.
 */
export interface PlanetBonusResult {
  /** bonus points awarded */
  bonus: number;
  /** position of priority planet in ai rankings (1, 2, 3) or null if not in top 3 */
  matchRank: 1 | 2 | 3 | null;
}

/**
 * calculate planet bonus based on whether the player's priority planet
 * appears anywhere in the ai's top-3 classification for the headline.
 *
 * in the new tally system, this is a flat bonus when priority matches.
 *
 * @param priority - player's current priority planet
 * @param aiRankings - ai's top-3 planet classifications for the headline
 * @param config - scoring configuration
 * @returns bonus points and match rank
 */
export function computePlanetBonus(
  priority: PlanetId | null,
  aiRankings: PlanetId[],
  config: ScoringConfig
): PlanetBonusResult {
  // no priority planet means no bonus
  if (priority === null) {
    return { bonus: 0, matchRank: null };
  }

  // check top 3 positions only
  const top3 = aiRankings.slice(0, 3);
  const index = top3.indexOf(priority);

  if (index === -1) {
    // priority planet not in top 3
    return { bonus: 0, matchRank: null };
  }

  // flat bonus for any match in top-3
  const matchRank = (index + 1) as 1 | 2 | 3;
  return {
    bonus: config.planetBonus.match,
    matchRank,
  };
}

/**
 * legacy function - determine which planet to mark as "used".
 * @deprecated no longer needed in tally system.
 */
export function determineUsedPlanet(
  preferred: PlanetId | null,
  aiRankings: PlanetId[],
  matchRank: 1 | 2 | 3 | null,
  _updateOnNoMatch: boolean
): PlanetId | null {
  // in the new system, we don't need this logic.
  // just return the matched planet or ai's top pick for display purposes
  if (matchRank !== null && preferred !== null) {
    return preferred;
  }
  return aiRankings[0] ?? null;
}

/**
 * result of combined planet scoring and state update.
 */
export interface PlanetScoringResult {
  /** bonus points awarded */
  bonus: number;
  /** updated planet tally state */
  updatedState: PlanetTallyState;
  /** position of priority planet in ai rankings, or null */
  matchRank: 1 | 2 | 3 | null;
  /** the planet that was used for scoring (for debugging/display) */
  usedPlanet: PlanetId | null;
}

/**
 * combined function that:
 * 1. checks if current priority planet matches ai's top-3
 * 2. calculates the planet bonus
 * 3. updates tally counts for all ai top-3 planets
 * 4. selects a new priority planet
 *
 * this is the main entry point for planet scoring logic.
 *
 * @param state - current planet tally state
 * @param aiRankings - ai's top planet classifications for the headline
 * @param _roundNo - current round number (unused in tally system)
 * @param config - scoring configuration
 * @returns planet bonus, updated state, and match info
 */
export function applyPlanetScoringAndUsage(
  state: PlanetTallyState,
  aiRankings: PlanetId[],
  _roundNo: number,
  config: ScoringConfig
): PlanetScoringResult {
  // if state has no current priority, select one first
  let currentState = state;
  if (currentState.currentPriority === null) {
    const initialPriority = selectPriorityPlanet(currentState);
    currentState = {
      ...currentState,
      currentPriority: initialPriority,
    };
  }

  // calculate bonus based on current priority
  const { bonus, matchRank } = computePlanetBonus(
    currentState.currentPriority,
    aiRankings,
    config
  );

  // update tally with ai's top-3 planets
  const tallyUpdatedState = updatePlanetTally(currentState, aiRankings);

  // only rotate priority if the planet was hit (appeared in ai's top-3).
  // if missed, keep the same priority so the player has another chance next submission.
  const didHit = matchRank !== null;
  const newPriority = didHit
    ? selectPriorityPlanet(tallyUpdatedState)
    : currentState.currentPriority;

  const finalState: PlanetTallyState = {
    tally: tallyUpdatedState.tally,
    previousPriority: didHit ? currentState.currentPriority : state.previousPriority,
    currentPriority: newPriority,
  };

  return {
    bonus,
    updatedState: finalState,
    matchRank,
    usedPlanet: currentState.currentPriority,
  };
}
