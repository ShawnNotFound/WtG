import {
  CHANGE_VELOCITY_PARAMETERS,
  CREATION_PRIORITY_PARAMETERS,
  UPDATE_PRIORITY_PARAMETERS,
  clamp01,
  computeChangeVelocity,
  computeCreationPriority,
  computeTextChangeMagnitude,
  computeUpdatePriority,
} from '../../src/world/worldPagePriority';

describe('world page priority scoring', () => {
  describe('clamp01', () => {
    it('preserves boundaries and clamps values outside them', () => {
      expect(clamp01(-2)).toBe(0);
      expect(clamp01(0)).toBe(0);
      expect(clamp01(0.4)).toBe(0.4);
      expect(clamp01(1)).toBe(1);
      expect(clamp01(3)).toBe(1);
      expect(clamp01(Number.NaN)).toBe(0);
    });
  });

  describe('computeTextChangeMagnitude', () => {
    it('returns zero for identical or equivalently normalised text', () => {
      expect(computeTextChangeMagnitude('Mars has a colony.', 'Mars has a colony.')).toBe(0);
      expect(computeTextChangeMagnitude('  MARS has a colony! ', 'mars has a colony')).toBe(0);
      expect(computeTextChangeMagnitude('', '')).toBe(0);
    });

    it('returns one when content replaces an empty page', () => {
      expect(computeTextChangeMagnitude('', 'A newly documented entity')).toBe(1);
      expect(computeTextChangeMagnitude('A newly documented entity', '')).toBe(1);
    });

    it('rates disjoint text highly and partial edits below total replacement', () => {
      const disjoint = computeTextChangeMagnitude('alpha beta', 'gamma delta');
      const partial = computeTextChangeMagnitude('alpha beta', 'alpha gamma');

      expect(disjoint).toBeGreaterThanOrEqual(0.8);
      expect(partial).toBeGreaterThan(0);
      expect(partial).toBeLessThan(disjoint);
      expect(computeTextChangeMagnitude('alpha beta', 'alpha beta gamma')).toBe(
        computeTextChangeMagnitude('alpha beta gamma', 'alpha beta'),
      );
    });
  });

  describe('computeChangeVelocity', () => {
    it('applies the documented EWMA at zero elapsed time', () => {
      const expected = ((1 - CHANGE_VELOCITY_PARAMETERS.ewmaAlpha) * 0.8)
        + (CHANGE_VELOCITY_PARAMETERS.ewmaAlpha * 0.2);

      expect(computeChangeVelocity(0.8, 0.2, 0)).toBeCloseTo(expected, 12);
    });

    it('decays the prior velocity exponentially over thirty days', () => {
      const immediate = computeChangeVelocity(1, 0, 0);
      const afterThirtyDays = computeChangeVelocity(1, 0, 30);

      expect(immediate).toBeCloseTo(0.65, 12);
      expect(afterThirtyDays).toBeCloseTo(0.65 * Math.exp(-1), 12);
      expect(afterThirtyDays).toBeLessThan(immediate);
    });

    it('remains bounded for invalid and extreme inputs', () => {
      expect(computeChangeVelocity(-10, -10, -10)).toBe(0);
      expect(computeChangeVelocity(10, 10, 0)).toBe(1);
      expect(computeChangeVelocity(Number.NaN, Number.NaN, Number.NaN)).toBe(0);
    });
  });

  describe('computeUpdatePriority', () => {
    const zeroInputs = {
      daysSinceLastUpdate: 0,
      dependencyShock: 0,
      changeVelocity: 0,
      consultationsSinceUpdate: 0,
    };

    it('has exact zero and saturated boundaries', () => {
      expect(computeUpdatePriority(zeroInputs).total).toBe(0);

      const saturated = computeUpdatePriority({
        daysSinceLastUpdate: Number.POSITIVE_INFINITY,
        dependencyShock: Number.POSITIVE_INFINITY,
        changeVelocity: 1,
        consultationsSinceUpdate: Number.POSITIVE_INFINITY,
        explicitBoost: 1,
      });
      expect(saturated.staleness).toBe(1);
      expect(saturated.dependency).toBe(1);
      expect(saturated.velocity).toBe(1);
      expect(saturated.consultation).toBe(1);
      expect(saturated.base).toBe(100);
      expect(saturated.total).toBe(100);
    });

    it('uses the declared weights and a maximum fifteen-point explicit boost', () => {
      expect(computeUpdatePriority({
        ...zeroInputs,
        daysSinceLastUpdate: Number.POSITIVE_INFINITY,
      }).base).toBe(100 * UPDATE_PRIORITY_PARAMETERS.weights.staleness);
      expect(computeUpdatePriority({
        ...zeroInputs,
        dependencyShock: Number.POSITIVE_INFINITY,
      }).base).toBe(100 * UPDATE_PRIORITY_PARAMETERS.weights.dependency);
      expect(computeUpdatePriority({ ...zeroInputs, changeVelocity: 1 }).base).toBe(
        100 * UPDATE_PRIORITY_PARAMETERS.weights.velocity,
      );
      expect(computeUpdatePriority({
        ...zeroInputs,
        consultationsSinceUpdate: Number.POSITIVE_INFINITY,
      }).base).toBe(100 * UPDATE_PRIORITY_PARAMETERS.weights.consultation);
      expect(computeUpdatePriority({ ...zeroInputs, explicitBoost: 1 })).toMatchObject({
        base: 0,
        explicitBoost: 15,
        total: 15,
      });
    });

    it('increases monotonically with every input factor', () => {
      const low = computeUpdatePriority({
        daysSinceLastUpdate: 1,
        dependencyShock: 0.1,
        changeVelocity: 0.1,
        consultationsSinceUpdate: 1,
        explicitBoost: 0.1,
      });
      const high = computeUpdatePriority({
        daysSinceLastUpdate: 20,
        dependencyShock: 1,
        changeVelocity: 0.8,
        consultationsSinceUpdate: 5,
        explicitBoost: 0.8,
      });

      expect(high.staleness).toBeGreaterThan(low.staleness);
      expect(high.dependency).toBeGreaterThan(low.dependency);
      expect(high.velocity).toBeGreaterThan(low.velocity);
      expect(high.consultation).toBeGreaterThan(low.consultation);
      expect(high.total).toBeGreaterThan(low.total);
    });
  });

  describe('computeCreationPriority', () => {
    it('has exact zero and saturated boundaries', () => {
      expect(computeCreationPriority({
        mentions: 0,
        confidence: 0,
        novelty: 0,
        connectionPotential: 0,
      }).total).toBe(0);

      expect(computeCreationPriority({
        mentions: Number.POSITIVE_INFINITY,
        confidence: 1,
        novelty: 1,
        connectionPotential: 1,
      })).toMatchObject({
        demand: 1,
        confidence: 1,
        novelty: 1,
        connectionPotential: 1,
        total: 100,
      });
    });

    it('uses the declared creation weights', () => {
      const zero = {
        mentions: 0,
        confidence: 0,
        novelty: 0,
        connectionPotential: 0,
      };

      expect(computeCreationPriority({
        ...zero,
        mentions: Number.POSITIVE_INFINITY,
      }).total).toBe(100 * CREATION_PRIORITY_PARAMETERS.weights.demand);
      expect(computeCreationPriority({ ...zero, confidence: 1 }).total).toBe(
        100 * CREATION_PRIORITY_PARAMETERS.weights.confidence,
      );
      expect(computeCreationPriority({ ...zero, novelty: 1 }).total).toBe(
        100 * CREATION_PRIORITY_PARAMETERS.weights.novelty,
      );
      expect(computeCreationPriority({ ...zero, connectionPotential: 1 }).total).toBe(
        100 * CREATION_PRIORITY_PARAMETERS.weights.connectionPotential,
      );
    });

    it('increases monotonically with demand and quality signals', () => {
      const low = computeCreationPriority({
        mentions: 1,
        confidence: 0.2,
        novelty: 0.2,
        connectionPotential: 0.2,
      });
      const high = computeCreationPriority({
        mentions: 3,
        confidence: 0.8,
        novelty: 0.8,
        connectionPotential: 0.8,
      });

      expect(high.demand).toBeGreaterThan(low.demand);
      expect(high.total).toBeGreaterThan(low.total);
    });
  });
});
