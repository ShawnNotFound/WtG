/**
 * Tests for the band-based global planet usage system (planetUsage.ts).
 */

import {
  initialGlobalUsage,
  migrateGlobalUsage,
  randomOrdinals,
  migratePlayerOrdinals,
  computeBandMembership,
  bandForIndex,
  computePlanetPanel,
  applyGlobalPlanetScoring,
  PlayerOrdinals,
} from '../../src/game/planetUsage';
import { DEFAULT_PLANETS } from '../../src/game/scoringTypes';

// a fixed identity permutation: planets keep their DEFAULT_PLANETS order
const IDENTITY: PlayerOrdinals = {
  ordinals: DEFAULT_PLANETS.reduce(
    (acc, id, i) => ({ ...acc, [id]: i }),
    {} as Record<string, number>
  ),
};

describe('planetUsage', () => {
  describe('initialGlobalUsage', () => {
    it('initializes every planet to 0', () => {
      const usage = initialGlobalUsage();
      expect(Object.keys(usage)).toHaveLength(DEFAULT_PLANETS.length);
      for (const p of DEFAULT_PLANETS) {
        expect(usage[p]).toBe(0);
      }
    });
  });

  describe('migrateGlobalUsage', () => {
    it('fills all planets with 0 for null/empty input', () => {
      expect(migrateGlobalUsage(null)).toEqual(initialGlobalUsage());
      expect(migrateGlobalUsage({})).toEqual(initialGlobalUsage());
    });

    it('overlays numeric values and fills missing planets with 0', () => {
      const usage = migrateGlobalUsage({ MARS: 5, VENUS: 2 });
      expect(usage.MARS).toBe(5);
      expect(usage.VENUS).toBe(2);
      expect(usage.EARTH).toBe(0);
    });
  });

  describe('randomOrdinals', () => {
    it('produces a complete permutation 0..n-1', () => {
      const { ordinals } = randomOrdinals();
      const values = DEFAULT_PLANETS.map((p) => ordinals[p]).sort((a, b) => a - b);
      expect(values).toEqual(DEFAULT_PLANETS.map((_, i) => i));
    });
  });

  describe('migratePlayerOrdinals', () => {
    it('keeps a complete ordinals object as-is', () => {
      expect(migratePlayerOrdinals(IDENTITY)).toEqual(IDENTITY);
    });

    it('generates a fresh permutation for null / legacy state', () => {
      const fromNull = migratePlayerOrdinals(null);
      expect(Object.keys(fromNull.ordinals)).toHaveLength(DEFAULT_PLANETS.length);

      // legacy tally format -> fresh permutation
      const legacy = { tally: { MARS: 3 }, currentPriority: 'MARS' };
      const fromLegacy = migratePlayerOrdinals(legacy);
      const values = DEFAULT_PLANETS.map((p) => fromLegacy.ordinals[p]).sort((a, b) => a - b);
      expect(values).toEqual(DEFAULT_PLANETS.map((_, i) => i));
    });
  });

  describe('bandForIndex', () => {
    it('maps the 9 positions to bands 2/2/2/1/1/1/0/0/0', () => {
      const bands = [0, 1, 2, 3, 4, 5, 6, 7, 8].map(bandForIndex);
      expect(bands).toEqual([2, 2, 2, 1, 1, 1, 0, 0, 0]);
    });
  });

  describe('computeBandMembership', () => {
    it('assigns bands by global usage rank with a canonical tie-break', () => {
      const bands = computeBandMembership(initialGlobalUsage());
      // all-zero usage -> canonical order: first 3 are band 2, next 3 band 1, rest band 0
      expect(bands[DEFAULT_PLANETS[0]]).toBe(2);
      expect(bands[DEFAULT_PLANETS[3]]).toBe(1);
      expect(bands[DEFAULT_PLANETS[6]]).toBe(0);
    });

    it('puts the most-used planet in the bottom band and least-used in the top', () => {
      const usage = DEFAULT_PLANETS.reduce(
        (acc, p) => ({ ...acc, [p]: 5 }),
        {} as Record<string, number>
      );
      usage.MARS = 100; // most used
      usage.PLUTO = 0; // least used
      const bands = computeBandMembership(usage);
      expect(bands.MARS).toBe(0);
      expect(bands.PLUTO).toBe(2);
    });
  });

  describe('computePlanetPanel', () => {
    it('returns 9 rows with correct usage and bands in display order', () => {
      const usage = initialGlobalUsage();
      const panel = computePlanetPanel(usage, IDENTITY);
      expect(panel).toHaveLength(9);
      expect(panel.map((e) => e.band)).toEqual([2, 2, 2, 1, 1, 1, 0, 0, 0]);
      expect(panel[0].id).toBe(DEFAULT_PLANETS[0]);
      expect(panel.every((e) => e.usage === 0)).toBe(true);
    });

    it('keeps band membership identical across players, only shuffling within bands', () => {
      const usage = initialGlobalUsage();
      const reversed: PlayerOrdinals = {
        ordinals: DEFAULT_PLANETS.reduce(
          (acc, p, i) => ({ ...acc, [p]: DEFAULT_PLANETS.length - 1 - i }),
          {} as Record<string, number>
        ),
      };

      const panelA = computePlanetPanel(usage, IDENTITY);
      const panelB = computePlanetPanel(usage, reversed);

      const bandSet = (panel: typeof panelA, band: number) =>
        panel.filter((e) => e.band === band).map((e) => e.id).sort();

      // same planets in each band for both players
      expect(bandSet(panelB, 2)).toEqual(bandSet(panelA, 2));
      expect(bandSet(panelB, 1)).toEqual(bandSet(panelA, 1));
      expect(bandSet(panelB, 0)).toEqual(bandSet(panelA, 0));

      // but within-band order differs (reversed ordinals)
      const within = (panel: typeof panelA, band: number) =>
        panel.filter((e) => e.band === band).map((e) => e.id);
      expect(within(panelB, 2)).not.toEqual(within(panelA, 2));
    });
  });

  describe('applyGlobalPlanetScoring', () => {
    it('awards the primary planet band and increments its usage by 1', () => {
      const usage = initialGlobalUsage();
      // MERCURY is canonical index 0 -> band 2
      const result = applyGlobalPlanetScoring(usage, ['MERCURY', 'VENUS', 'EARTH']);
      expect(result.bonus).toBe(2);
      expect(result.usedPlanet).toBe('MERCURY');
      expect(result.updatedUsage.MERCURY).toBe(1);
      // original map not mutated
      expect(usage.MERCURY).toBe(0);
    });

    it('reads the band from the pre-increment global membership', () => {
      // MARS at canonical index 3 with all-zero usage -> band 1
      const result = applyGlobalPlanetScoring(initialGlobalUsage(), ['MARS']);
      expect(result.bonus).toBe(1);
      expect(result.updatedUsage.MARS).toBe(1);
    });

    it('gives the bottom band 0 for a most-used primary planet', () => {
      // URANUS at canonical index 6 -> band 0
      const result = applyGlobalPlanetScoring(initialGlobalUsage(), ['URANUS']);
      expect(result.bonus).toBe(0);
    });

    it('handles empty rankings with no bonus and no change', () => {
      const usage = initialGlobalUsage();
      const result = applyGlobalPlanetScoring(usage, []);
      expect(result.bonus).toBe(0);
      expect(result.usedPlanet).toBeNull();
      expect(result.updatedUsage).toEqual(usage);
    });
  });
});
