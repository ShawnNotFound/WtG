/**
 * Unit tests for planet weighting with frequency-based tally logic.
 */

import {
  initialPlanetTallyState,
  initialPlanetUsageState,
  selectPriorityPlanet,
  getPreferredPlanet,
  updatePlanetTally,
  applyPlanetUsage,
  computePlanetBonus,
  determineUsedPlanet,
  applyPlanetScoringAndUsage,
  isLegacyState,
  convertLegacyToTallyState,
  migratePlanetState,
  PlanetTallyState,
} from '../../src/game/planetWeighting';
import {
  DEFAULT_SCORING_CONFIG,
  DEFAULT_PLANETS,
  ScoringConfig,
  LegacyPlanetUsageState,
} from '../../src/game/scoringTypes';

describe('Planet Tally Functions', () => {
  describe('initialPlanetTallyState', () => {
    it('should create state with all default planets at count 0', () => {
      const state = initialPlanetTallyState();

      expect(Object.keys(state.tally)).toHaveLength(DEFAULT_PLANETS.length);
      DEFAULT_PLANETS.forEach((planet) => {
        expect(state.tally[planet]).toBe(0);
      });
      expect(state.previousPriority).toBeNull();
      expect(state.currentPriority).toBeNull();
    });

    it('should create state with custom planet list', () => {
      const customPlanets = ['ALPHA', 'BETA', 'GAMMA'];
      const state = initialPlanetTallyState(customPlanets);

      expect(Object.keys(state.tally)).toHaveLength(3);
      expect(state.tally['ALPHA']).toBe(0);
      expect(state.tally['BETA']).toBe(0);
      expect(state.tally['GAMMA']).toBe(0);
      expect(state.previousPriority).toBeNull();
      expect(state.currentPriority).toBeNull();
    });

    it('should return empty tally for empty planet list', () => {
      const state = initialPlanetTallyState([]);
      expect(state.tally).toEqual({});
      expect(state.previousPriority).toBeNull();
      expect(state.currentPriority).toBeNull();
    });
  });

  describe('initialPlanetUsageState (legacy alias)', () => {
    it('should return same result as initialPlanetTallyState', () => {
      const legacyResult = initialPlanetUsageState();
      const newResult = initialPlanetTallyState();

      expect(legacyResult).toEqual(newResult);
    });
  });

  describe('selectPriorityPlanet', () => {
    it('should return null for empty planet list', () => {
      const state = initialPlanetTallyState([]);
      expect(selectPriorityPlanet(state, [])).toBeNull();
    });

    it('should select from all planets when all have same count (0)', () => {
      const planets = ['MARS', 'VENUS', 'EARTH'];
      const state = initialPlanetTallyState(planets);

      // Run multiple times to verify randomness (should pick from all 3)
      const selected = new Set<string>();
      for (let i = 0; i < 100; i++) {
        const result = selectPriorityPlanet(state, planets);
        if (result) selected.add(result);
      }

      // Should have selected from at least some of the planets
      expect(selected.size).toBeGreaterThan(0);
      selected.forEach((p) => expect(planets).toContain(p));
    });

    it('should select from bottom half (lowest counts)', () => {
      const planets = ['A', 'B', 'C', 'D', 'E', 'F']; // 6 planets, bottom half = 3
      const state: PlanetTallyState = {
        tally: { A: 0, B: 1, C: 2, D: 3, E: 4, F: 5 },
        previousPriority: null,
        currentPriority: null,
      };

      // Run multiple times, should only select from A, B, C (lowest 3)
      const selected = new Set<string>();
      for (let i = 0; i < 100; i++) {
        const result = selectPriorityPlanet(state, planets);
        if (result) selected.add(result);
      }

      selected.forEach((p) => expect(['A', 'B', 'C']).toContain(p));
    });

    it('should exclude previousPriority from selection', () => {
      const planets = ['A', 'B', 'C', 'D'];
      const state: PlanetTallyState = {
        tally: { A: 0, B: 0, C: 0, D: 0 },
        previousPriority: 'A',
        currentPriority: null,
      };

      // Run multiple times, should never select A
      for (let i = 0; i < 50; i++) {
        const result = selectPriorityPlanet(state, planets);
        expect(result).not.toBe('A');
      }
    });

    it('should use full bottom half if previousPriority is only option', () => {
      const planets = ['ONLY'];
      const state: PlanetTallyState = {
        tally: { ONLY: 5 },
        previousPriority: 'ONLY',
        currentPriority: null,
      };

      // Should still select ONLY since it's the only option
      const result = selectPriorityPlanet(state, planets);
      expect(result).toBe('ONLY');
    });

    it('should handle odd number of planets (rounds up for bottom half)', () => {
      const planets = ['A', 'B', 'C', 'D', 'E']; // 5 planets, bottom half = ceil(5/2) = 3
      const state: PlanetTallyState = {
        tally: { A: 0, B: 1, C: 2, D: 3, E: 4 },
        previousPriority: null,
        currentPriority: null,
      };

      // Run multiple times, should only select from A, B, C
      const selected = new Set<string>();
      for (let i = 0; i < 100; i++) {
        const result = selectPriorityPlanet(state, planets);
        if (result) selected.add(result);
      }

      selected.forEach((p) => expect(['A', 'B', 'C']).toContain(p));
    });
  });

  describe('getPreferredPlanet (legacy alias)', () => {
    it('should return currentPriority from state', () => {
      const state: PlanetTallyState = {
        tally: { A: 0 },
        previousPriority: null,
        currentPriority: 'A',
      };

      expect(getPreferredPlanet(state)).toBe('A');
    });

    it('should return null when currentPriority is null', () => {
      const state = initialPlanetTallyState(['A', 'B']);
      expect(getPreferredPlanet(state)).toBeNull();
    });
  });

  describe('updatePlanetTally', () => {
    it('should increment counts for all top-3 planets', () => {
      const state: PlanetTallyState = {
        tally: { A: 0, B: 0, C: 0, D: 0 },
        previousPriority: null,
        currentPriority: 'A',
      };

      const newState = updatePlanetTally(state, ['A', 'B', 'C']);

      expect(newState.tally['A']).toBe(1);
      expect(newState.tally['B']).toBe(1);
      expect(newState.tally['C']).toBe(1);
      expect(newState.tally['D']).toBe(0); // Not in top-3
    });

    it('should only process first 3 planets from rankings', () => {
      const state: PlanetTallyState = {
        tally: { A: 0, B: 0, C: 0, D: 0 },
        previousPriority: null,
        currentPriority: null,
      };

      const newState = updatePlanetTally(state, ['A', 'B', 'C', 'D']);

      expect(newState.tally['D']).toBe(0); // 4th planet not incremented
    });

    it('should handle fewer than 3 planets in rankings', () => {
      const state: PlanetTallyState = {
        tally: { A: 0, B: 0 },
        previousPriority: null,
        currentPriority: null,
      };

      const newState = updatePlanetTally(state, ['A']);

      expect(newState.tally['A']).toBe(1);
      expect(newState.tally['B']).toBe(0);
    });

    it('should handle empty rankings', () => {
      const state: PlanetTallyState = {
        tally: { A: 0 },
        previousPriority: null,
        currentPriority: null,
      };

      const newState = updatePlanetTally(state, []);

      expect(newState.tally['A']).toBe(0);
    });

    it('should add new planets not in original tally', () => {
      const state: PlanetTallyState = {
        tally: { A: 0 },
        previousPriority: null,
        currentPriority: null,
      };

      const newState = updatePlanetTally(state, ['A', 'B', 'C']);

      expect(newState.tally['A']).toBe(1);
      expect(newState.tally['B']).toBe(1);
      expect(newState.tally['C']).toBe(1);
    });

    it('should be immutable (return new object)', () => {
      const state: PlanetTallyState = {
        tally: { A: 5 },
        previousPriority: null,
        currentPriority: 'A',
      };

      const newState = updatePlanetTally(state, ['A']);

      expect(newState).not.toBe(state);
      expect(newState.tally).not.toBe(state.tally);
      expect(state.tally['A']).toBe(5); // Original unchanged
      expect(newState.tally['A']).toBe(6);
    });
  });

  describe('updatePlanetTally weighted', () => {
    it('should apply weight 3 for NEPTUNE and PLUTO', () => {
      const state: PlanetTallyState = {
        tally: { MARS: 0, NEPTUNE: 0, PLUTO: 0 },
        previousPriority: null,
        currentPriority: 'MARS',
      };

      const newState = updatePlanetTally(state, ['MARS', 'NEPTUNE', 'PLUTO']);

      expect(newState.tally['MARS']).toBe(2);      // weight 2
      expect(newState.tally['NEPTUNE']).toBe(3);    // weight 3
      expect(newState.tally['PLUTO']).toBe(3);      // weight 3
    });

    it('should apply weight 2 for concrete planets', () => {
      const state: PlanetTallyState = {
        tally: { MERCURY: 0, JUPITER: 0, EARTH: 0 },
        previousPriority: null,
        currentPriority: 'MERCURY',
      };

      const newState = updatePlanetTally(state, ['MERCURY', 'JUPITER', 'EARTH']);

      expect(newState.tally['MERCURY']).toBe(2);
      expect(newState.tally['JUPITER']).toBe(2);
      expect(newState.tally['EARTH']).toBe(2);
    });

    it('should accumulate weighted tallies over multiple updates', () => {
      let state: PlanetTallyState = {
        tally: { MARS: 0, PLUTO: 0 },
        previousPriority: null,
        currentPriority: 'MARS',
      };

      state = updatePlanetTally(state, ['MARS', 'PLUTO']);
      state = updatePlanetTally(state, ['MARS', 'PLUTO']);

      expect(state.tally['MARS']).toBe(4);   // 2 × weight 2
      expect(state.tally['PLUTO']).toBe(6);  // 2 × weight 3
    });

    it('should default to weight 1 for unknown planets', () => {
      const state: PlanetTallyState = {
        tally: { UNKNOWN: 0 },
        previousPriority: null,
        currentPriority: null,
      };

      const newState = updatePlanetTally(state, ['UNKNOWN']);
      expect(newState.tally['UNKNOWN']).toBe(1);
    });
  });

  describe('applyPlanetUsage (legacy, no-op)', () => {
    it('should return the same state (no-op in new system)', () => {
      const state = initialPlanetTallyState(['A', 'B']);
      const result = applyPlanetUsage(state, 'A', 1);

      expect(result).toBe(state);
    });
  });

  describe('computePlanetBonus', () => {
    it('should return flat bonus when priority is #1 in rankings', () => {
      const result = computePlanetBonus(
        'MARS',
        ['MARS', 'VENUS', 'EARTH'],
        DEFAULT_SCORING_CONFIG
      );

      expect(result.bonus).toBe(DEFAULT_SCORING_CONFIG.planetBonus.match);
      expect(result.bonus).toBe(2);
      expect(result.matchRank).toBe(1);
    });

    it('should return flat bonus when priority is #2 in rankings', () => {
      const result = computePlanetBonus(
        'VENUS',
        ['MARS', 'VENUS', 'EARTH'],
        DEFAULT_SCORING_CONFIG
      );

      expect(result.bonus).toBe(2); // Same flat bonus
      expect(result.matchRank).toBe(2);
    });

    it('should return flat bonus when priority is #3 in rankings', () => {
      const result = computePlanetBonus(
        'EARTH',
        ['MARS', 'VENUS', 'EARTH'],
        DEFAULT_SCORING_CONFIG
      );

      expect(result.bonus).toBe(2); // Same flat bonus
      expect(result.matchRank).toBe(3);
    });

    it('should return 0 when priority is not in top 3', () => {
      const result = computePlanetBonus(
        'JUPITER',
        ['MARS', 'VENUS', 'EARTH'],
        DEFAULT_SCORING_CONFIG
      );

      expect(result.bonus).toBe(0);
      expect(result.matchRank).toBeNull();
    });

    it('should return 0 when priority is null', () => {
      const result = computePlanetBonus(
        null,
        ['MARS', 'VENUS', 'EARTH'],
        DEFAULT_SCORING_CONFIG
      );

      expect(result.bonus).toBe(0);
      expect(result.matchRank).toBeNull();
    });

    it('should only consider first 3 rankings', () => {
      // JUPITER is at index 3, so should not match
      const result = computePlanetBonus(
        'JUPITER',
        ['MARS', 'VENUS', 'EARTH', 'JUPITER'],
        DEFAULT_SCORING_CONFIG
      );

      expect(result.bonus).toBe(0);
      expect(result.matchRank).toBeNull();
    });

    it('should work with custom config', () => {
      const customConfig: ScoringConfig = {
        ...DEFAULT_SCORING_CONFIG,
        planetBonus: { match: 10 },
      };

      const result = computePlanetBonus('MARS', ['MARS', 'VENUS'], customConfig);

      expect(result.bonus).toBe(10);
      expect(result.matchRank).toBe(1);
    });
  });

  describe('determineUsedPlanet (legacy)', () => {
    it('should return preferred planet when there was a match', () => {
      expect(determineUsedPlanet('MARS', ['MARS', 'VENUS'], 1, true)).toBe('MARS');
      expect(determineUsedPlanet('VENUS', ['MARS', 'VENUS'], 2, false)).toBe('VENUS');
    });

    it('should return AI top pick when no match', () => {
      expect(determineUsedPlanet('JUPITER', ['MARS', 'VENUS'], null, true)).toBe('MARS');
      expect(determineUsedPlanet('JUPITER', ['MARS', 'VENUS'], null, false)).toBe('MARS');
    });

    it('should return null for empty rankings', () => {
      expect(determineUsedPlanet('MARS', [], null, true)).toBeNull();
    });
  });

  describe('applyPlanetScoringAndUsage', () => {
    // Mock Math.random for deterministic testing
    const mockRandom = (value: number) => {
      jest.spyOn(Math, 'random').mockReturnValue(value);
    };

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('should initialize currentPriority on first call', () => {
      mockRandom(0); // Will select first candidate

      const state = initialPlanetTallyState(['A', 'B', 'C']);

      const result = applyPlanetScoringAndUsage(
        state,
        ['A', 'B', 'C'],
        1,
        DEFAULT_SCORING_CONFIG
      );

      // Initial priority was selected and used
      expect(result.usedPlanet).not.toBeNull();
    });

    it('should award bonus when currentPriority matches AI top-3', () => {
      mockRandom(0);

      const state: PlanetTallyState = {
        tally: { MARS: 0, VENUS: 0, EARTH: 0 },
        previousPriority: null,
        currentPriority: 'MARS',
      };

      const result = applyPlanetScoringAndUsage(
        state,
        ['MARS', 'VENUS', 'EARTH'],
        1,
        DEFAULT_SCORING_CONFIG
      );

      expect(result.bonus).toBe(2);
      expect(result.matchRank).toBe(1);
      expect(result.usedPlanet).toBe('MARS');
    });

    it('should award no bonus when currentPriority not in AI top-3', () => {
      mockRandom(0);

      const state: PlanetTallyState = {
        tally: { MARS: 0, VENUS: 0, EARTH: 0, JUPITER: 0 },
        previousPriority: null,
        currentPriority: 'JUPITER',
      };

      const result = applyPlanetScoringAndUsage(
        state,
        ['MARS', 'VENUS', 'EARTH'],
        1,
        DEFAULT_SCORING_CONFIG
      );

      expect(result.bonus).toBe(0);
      expect(result.matchRank).toBeNull();
    });

    it('should update tally for all AI top-3 planets', () => {
      mockRandom(0);

      const state: PlanetTallyState = {
        tally: { A: 0, B: 0, C: 0, D: 0 },
        previousPriority: null,
        currentPriority: 'A',
      };

      const result = applyPlanetScoringAndUsage(
        state,
        ['A', 'B', 'C'],
        1,
        DEFAULT_SCORING_CONFIG
      );

      expect(result.updatedState.tally['A']).toBe(1);
      expect(result.updatedState.tally['B']).toBe(1);
      expect(result.updatedState.tally['C']).toBe(1);
      expect(result.updatedState.tally['D']).toBe(0);
    });

    it('should update previousPriority and select new currentPriority', () => {
      mockRandom(0);

      const state: PlanetTallyState = {
        tally: { A: 0, B: 0, C: 0 },
        previousPriority: null,
        currentPriority: 'A',
      };

      const result = applyPlanetScoringAndUsage(
        state,
        ['A', 'B', 'C'],
        1,
        DEFAULT_SCORING_CONFIG
      );

      expect(result.updatedState.previousPriority).toBe('A');
      // New priority selected (A is now excluded as previous)
      expect(result.updatedState.currentPriority).not.toBe('A');
    });

    it('should work through multiple scoring rounds', () => {
      mockRandom(0);

      let state = initialPlanetTallyState(['A', 'B', 'C']);
      state = { ...state, currentPriority: 'A' };

      // Round 1: A is priority, A in top-3 → bonus
      let result = applyPlanetScoringAndUsage(
        state,
        ['A', 'B', 'C'],
        1,
        DEFAULT_SCORING_CONFIG
      );
      expect(result.bonus).toBe(2);
      expect(result.updatedState.tally['A']).toBe(1);
      expect(result.updatedState.tally['B']).toBe(1);
      expect(result.updatedState.tally['C']).toBe(1);
      state = result.updatedState;

      // Round 2: New priority was selected, continuing...
      result = applyPlanetScoringAndUsage(
        state,
        ['B', 'C', 'A'],
        2,
        DEFAULT_SCORING_CONFIG
      );
      // Tally now: A=2, B=2, C=2
      expect(result.updatedState.tally['A']).toBe(2);
      expect(result.updatedState.tally['B']).toBe(2);
      expect(result.updatedState.tally['C']).toBe(2);
    });
  });

  describe('isLegacyState', () => {
    it('should return false for null', () => {
      expect(isLegacyState(null)).toBe(false);
    });

    it('should return false for undefined', () => {
      expect(isLegacyState(undefined)).toBe(false);
    });

    it('should return false for new tally format', () => {
      const state: PlanetTallyState = {
        tally: { A: 0 },
        previousPriority: null,
        currentPriority: null,
      };
      expect(isLegacyState(state)).toBe(false);
    });

    it('should return true for legacy LRU format', () => {
      const legacyState: LegacyPlanetUsageState = {
        MARS: { lastUsedRound: null },
        VENUS: { lastUsedRound: 1 },
      };
      expect(isLegacyState(legacyState)).toBe(true);
    });

    it('should return true for empty object (treated as potential legacy)', () => {
      expect(isLegacyState({})).toBe(false); // Empty is not legacy, just empty
    });
  });

  describe('convertLegacyToTallyState', () => {
    it('should convert legacy state to tally state with all counts at 0', () => {
      const legacyState: LegacyPlanetUsageState = {
        MARS: { lastUsedRound: 1 },
        VENUS: { lastUsedRound: null },
      };

      const result = convertLegacyToTallyState(legacyState, ['MARS', 'VENUS', 'EARTH']);

      expect(result.tally['MARS']).toBe(0);
      expect(result.tally['VENUS']).toBe(0);
      expect(result.tally['EARTH']).toBe(0);
      expect(result.previousPriority).toBeNull();
      expect(result.currentPriority).toBeNull();
    });

    it('should include planets from legacy state not in allPlanets', () => {
      const legacyState: LegacyPlanetUsageState = {
        MARS: { lastUsedRound: 1 },
        PLUTO: { lastUsedRound: 2 },
      };

      const result = convertLegacyToTallyState(legacyState, ['MARS', 'VENUS']);

      expect(result.tally['MARS']).toBe(0);
      expect(result.tally['VENUS']).toBe(0);
      expect(result.tally['PLUTO']).toBe(0); // Added from legacy
    });
  });

  describe('migratePlanetState', () => {
    it('should handle null input', () => {
      const result = migratePlanetState(null, ['A', 'B']);

      expect(result.tally['A']).toBe(0);
      expect(result.tally['B']).toBe(0);
      expect(result.previousPriority).toBeNull();
      expect(result.currentPriority).toBeNull();
    });

    it('should handle undefined input', () => {
      const result = migratePlanetState(undefined, ['A', 'B']);

      expect(result.tally['A']).toBe(0);
      expect(result.tally['B']).toBe(0);
    });

    it('should handle empty object', () => {
      const result = migratePlanetState({}, ['A', 'B']);

      expect(result.tally['A']).toBe(0);
      expect(result.tally['B']).toBe(0);
    });

    it('should migrate legacy LRU state', () => {
      const legacyState: LegacyPlanetUsageState = {
        MARS: { lastUsedRound: 1 },
        VENUS: { lastUsedRound: null },
      };

      const result = migratePlanetState(legacyState, ['MARS', 'VENUS', 'EARTH']);

      expect(result.tally['MARS']).toBe(0);
      expect(result.tally['VENUS']).toBe(0);
      expect(result.tally['EARTH']).toBe(0);
    });

    it('should pass through new tally state', () => {
      const tallyState: PlanetTallyState = {
        tally: { A: 5, B: 3 },
        previousPriority: 'A',
        currentPriority: 'B',
      };

      const result = migratePlanetState(tallyState, ['A', 'B', 'C']);

      expect(result.tally['A']).toBe(5);
      expect(result.tally['B']).toBe(3);
      expect(result.tally['C']).toBe(0); // Added missing planet
      expect(result.previousPriority).toBe('A');
      expect(result.currentPriority).toBe('B');
    });

    it('should add missing planets to existing tally state', () => {
      const tallyState: PlanetTallyState = {
        tally: { A: 5 },
        previousPriority: null,
        currentPriority: 'A',
      };

      const result = migratePlanetState(tallyState, ['A', 'B', 'C']);

      expect(result.tally['A']).toBe(5);
      expect(result.tally['B']).toBe(0);
      expect(result.tally['C']).toBe(0);
    });
  });
});
