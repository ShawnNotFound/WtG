/**
 * Unit tests for dice roll functions.
 */

import {
  mapRollToBand,
  rollDice,
  selectHeadline,
  rollAndSelectHeadline,
} from '../../src/game/diceRoll';
import { HeadlineBands } from '../../src/prompts/jurorPrompt';

describe('Dice Roll Functions', () => {
  describe('mapRollToBand', () => {
    // Target distribution: 10/35/40/12/3
    // Band 1: 1-10 (10%), Band 2: 11-45 (35%), Band 3: 46-85 (40%), Band 4: 86-97 (12%), Band 5: 98-100 (3%)

    describe('Band 1 (inevitable): 1-10', () => {
      it('should map 1 to band 1', () => {
        expect(mapRollToBand(1)).toBe(1);
      });

      it('should map 5 to band 1', () => {
        expect(mapRollToBand(5)).toBe(1);
      });

      it('should map 10 to band 1', () => {
        expect(mapRollToBand(10)).toBe(1);
      });
    });

    describe('Band 2 (probable): 11-45', () => {
      it('should map 11 to band 2', () => {
        expect(mapRollToBand(11)).toBe(2);
      });

      it('should map 27 to band 2', () => {
        expect(mapRollToBand(27)).toBe(2);
      });

      it('should map 45 to band 2', () => {
        expect(mapRollToBand(45)).toBe(2);
      });
    });

    describe('Band 3 (plausible): 46-85', () => {
      it('should map 46 to band 3', () => {
        expect(mapRollToBand(46)).toBe(3);
      });

      it('should map 65 to band 3', () => {
        expect(mapRollToBand(65)).toBe(3);
      });

      it('should map 85 to band 3', () => {
        expect(mapRollToBand(85)).toBe(3);
      });
    });

    describe('Band 4 (possible): 86-97', () => {
      it('should map 86 to band 4', () => {
        expect(mapRollToBand(86)).toBe(4);
      });

      it('should map 90 to band 4', () => {
        expect(mapRollToBand(90)).toBe(4);
      });

      it('should map 97 to band 4', () => {
        expect(mapRollToBand(97)).toBe(4);
      });
    });

    describe('Band 5 (preposterous): 98-100', () => {
      it('should map 98 to band 5', () => {
        expect(mapRollToBand(98)).toBe(5);
      });

      it('should map 99 to band 5', () => {
        expect(mapRollToBand(99)).toBe(5);
      });

      it('should map 100 to band 5', () => {
        expect(mapRollToBand(100)).toBe(5);
      });
    });

    describe('Boundary conditions', () => {
      it('should correctly map all boundary values', () => {
        // Band boundaries: 1-10, 11-45, 46-85, 86-97, 98-100
        expect(mapRollToBand(1)).toBe(1);
        expect(mapRollToBand(10)).toBe(1);
        expect(mapRollToBand(11)).toBe(2);
        expect(mapRollToBand(45)).toBe(2);
        expect(mapRollToBand(46)).toBe(3);
        expect(mapRollToBand(85)).toBe(3);
        expect(mapRollToBand(86)).toBe(4);
        expect(mapRollToBand(97)).toBe(4);
        expect(mapRollToBand(98)).toBe(5);
        expect(mapRollToBand(100)).toBe(5);
      });
    });

    describe('Error handling', () => {
      it('should throw for zero', () => {
        expect(() => mapRollToBand(0)).toThrow('Roll must be between 1 and 100');
      });

      it('should throw for negative values', () => {
        expect(() => mapRollToBand(-1)).toThrow('Roll must be between 1 and 100');
      });

      it('should throw for values over 100', () => {
        expect(() => mapRollToBand(101)).toThrow('Roll must be between 1 and 100');
      });

      it('should throw for large values', () => {
        expect(() => mapRollToBand(1000)).toThrow('Roll must be between 1 and 100');
      });
    });
  });

  describe('rollDice', () => {
    it('should return a roll between 1 and 100', () => {
      // Run multiple times to test randomness
      for (let i = 0; i < 100; i++) {
        const result = rollDice();
        expect(result.roll).toBeGreaterThanOrEqual(1);
        expect(result.roll).toBeLessThanOrEqual(100);
      }
    });

    it('should return an integer roll', () => {
      for (let i = 0; i < 50; i++) {
        const result = rollDice();
        expect(Number.isInteger(result.roll)).toBe(true);
      }
    });

    it('should return a band between 1 and 5', () => {
      for (let i = 0; i < 100; i++) {
        const result = rollDice();
        expect(result.band).toBeGreaterThanOrEqual(1);
        expect(result.band).toBeLessThanOrEqual(5);
      }
    });

    it('should return consistent roll-to-band mapping', () => {
      for (let i = 0; i < 50; i++) {
        const result = rollDice();
        // Verify the band matches what mapRollToBand would return
        expect(result.band).toBe(mapRollToBand(result.roll));
      }
    });
  });

  describe('selectHeadline', () => {
    const testBands: HeadlineBands = {
      band1: 'AI System Achieves Human-Level Performance',
      band2: 'AI System Shows Strong Progress Toward Human-Level Tasks',
      band3: 'Researchers Report AI Advances in Complex Problem Solving',
      band4: 'New AI Approach May Lead to Breakthroughs in Reasoning',
      band5: 'Revolutionary AI Claims to Surpass All Human Intelligence',
    };

    it('should select band1 headline for band 1', () => {
      expect(selectHeadline(testBands, 1)).toBe(testBands.band1);
    });

    it('should select band2 headline for band 2', () => {
      expect(selectHeadline(testBands, 2)).toBe(testBands.band2);
    });

    it('should select band3 headline for band 3', () => {
      expect(selectHeadline(testBands, 3)).toBe(testBands.band3);
    });

    it('should select band4 headline for band 4', () => {
      expect(selectHeadline(testBands, 4)).toBe(testBands.band4);
    });

    it('should select band5 headline for band 5', () => {
      expect(selectHeadline(testBands, 5)).toBe(testBands.band5);
    });

    it('should work with all bands in sequence', () => {
      const bands = [1, 2, 3, 4, 5] as const;
      const expectedHeadlines = [
        testBands.band1,
        testBands.band2,
        testBands.band3,
        testBands.band4,
        testBands.band5,
      ];

      bands.forEach((band, index) => {
        expect(selectHeadline(testBands, band)).toBe(expectedHeadlines[index]);
      });
    });
  });

  describe('rollAndSelectHeadline', () => {
    const testBands: HeadlineBands = {
      band1: 'Inevitable Headline',
      band2: 'Probable Headline',
      band3: 'Plausible Headline',
      band4: 'Possible Headline',
      band5: 'Preposterous Headline',
    };

    it('should return roll, band, and selectedHeadline', () => {
      const result = rollAndSelectHeadline(testBands);

      expect(result).toHaveProperty('roll');
      expect(result).toHaveProperty('band');
      expect(result).toHaveProperty('selectedHeadline');
    });

    it('should return valid roll range', () => {
      for (let i = 0; i < 50; i++) {
        const result = rollAndSelectHeadline(testBands);
        expect(result.roll).toBeGreaterThanOrEqual(0);
        expect(result.roll).toBeLessThanOrEqual(100);
      }
    });

    it('should return valid band', () => {
      for (let i = 0; i < 50; i++) {
        const result = rollAndSelectHeadline(testBands);
        expect(result.band).toBeGreaterThanOrEqual(1);
        expect(result.band).toBeLessThanOrEqual(5);
      }
    });

    it('should select headline matching the rolled band', () => {
      for (let i = 0; i < 50; i++) {
        const result = rollAndSelectHeadline(testBands);
        const expectedHeadline = selectHeadline(testBands, result.band);
        expect(result.selectedHeadline).toBe(expectedHeadline);
      }
    });

    it('should have consistent mapping between roll and band', () => {
      for (let i = 0; i < 50; i++) {
        const result = rollAndSelectHeadline(testBands);
        expect(result.band).toBe(mapRollToBand(result.roll));
      }
    });
  });

  describe('Statistical distribution (sanity check)', () => {
    it('should produce all bands over many rolls', () => {
      const bandCounts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };

      // Roll 500 times
      for (let i = 0; i < 500; i++) {
        const result = rollDice();
        bandCounts[result.band]++;
      }

      // Each band should appear at least once (very likely with 500 rolls)
      expect(bandCounts[1]).toBeGreaterThan(0);
      expect(bandCounts[2]).toBeGreaterThan(0);
      expect(bandCounts[3]).toBeGreaterThan(0);
      expect(bandCounts[4]).toBeGreaterThan(0);
      expect(bandCounts[5]).toBeGreaterThan(0);
    });
  });
});
