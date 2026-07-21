/**
 * Pure scoring helpers for prioritising future-Wikipedia page work.
 *
 * Component scores are normalised to [0, 1]. Aggregate priority scores are
 * returned on a [0, 100] scale so they are easy to sort and display.
 */

export const TEXT_CHANGE_PARAMETERS = {
  tokenSetWeight: 0.8,
  tokenCountWeight: 0.2,
} as const;

export const CHANGE_VELOCITY_PARAMETERS = {
  decayDays: 30,
  ewmaAlpha: 0.35,
} as const;

export const UPDATE_PRIORITY_PARAMETERS = {
  stalenessDecayDays: 30,
  dependencyShockScale: 1,
  consultationsScale: 3,
  weights: {
    staleness: 0.3,
    dependency: 0.3,
    velocity: 0.2,
    consultation: 0.2,
  },
  explicitBoostMaxPoints: 15,
} as const;

export const CREATION_PRIORITY_PARAMETERS = {
  demandScale: 1,
  weights: {
    demand: 0.35,
    confidence: 0.3,
    novelty: 0.2,
    connectionPotential: 0.15,
  },
} as const;

export interface UpdatePriorityInputs {
  /** Canonical storage-oriented name for elapsed days since content changed. */
  staleDays?: number;
  /** Descriptive alias retained for direct callers and reports. */
  daysSinceLastUpdate?: number;
  dependencyShock: number;
  changeVelocity: number;
  consultationsSinceUpdate: number;
  explicitBoost?: number;
}

export interface UpdatePriorityScores {
  staleness: number;
  dependency: number;
  velocity: number;
  consultation: number;
  base: number;
  explicitBoost: number;
  total: number;
}

export interface CreationPriorityInputs {
  /** Canonical storage-oriented count of requests for the candidate. */
  mentionCount?: number;
  /** Short alias retained for direct callers and reports. */
  mentions?: number;
  confidence: number;
  novelty: number;
  connectionPotential: number;
}

export interface CreationPriorityScores {
  demand: number;
  confidence: number;
  novelty: number;
  connectionPotential: number;
  total: number;
}

/** Clamp a numeric value to [0, 1]. Non-finite NaN values become zero. */
export function clamp01(value: number): number {
  if (Number.isNaN(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

function nonnegative(value: number): number {
  if (Number.isNaN(value)) {
    return 0;
  }
  return Math.max(0, value);
}

function clampScore(value: number): number {
  const bounded = Math.min(100, Math.max(0, value));
  if (bounded < 1e-12) {
    return 0;
  }
  if (100 - bounded < 1e-12) {
    return 100;
  }
  return bounded;
}

function tokenise(text: string): string[] {
  return (
    text
      .toLocaleLowerCase('en-US')
      .normalize('NFKC')
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}

/**
 * Estimate semantic-size change without a model call.
 *
 * Eighty percent comes from token-set Jaccard distance and twenty percent from
 * relative token-count change. This makes the result symmetric, deterministic,
 * and sensitive both to replaced concepts and substantial expansion/contraction.
 */
export function computeTextChangeMagnitude(
  before: string,
  after: string
): number {
  const beforeTokens = tokenise(before);
  const afterTokens = tokenise(after);

  if (beforeTokens.length === 0 && afterTokens.length === 0) {
    return 0;
  }

  const beforeSet = new Set(beforeTokens);
  const afterSet = new Set(afterTokens);
  const union = new Set([...beforeSet, ...afterSet]);
  let intersectionSize = 0;
  for (const token of beforeSet) {
    if (afterSet.has(token)) {
      intersectionSize += 1;
    }
  }

  const jaccardDistance =
    union.size === 0 ? 0 : 1 - intersectionSize / union.size;
  const maxTokenCount = Math.max(beforeTokens.length, afterTokens.length);
  const tokenCountChange =
    maxTokenCount === 0
      ? 0
      : Math.abs(beforeTokens.length - afterTokens.length) / maxTokenCount;

  return clamp01(
    TEXT_CHANGE_PARAMETERS.tokenSetWeight * jaccardDistance +
      TEXT_CHANGE_PARAMETERS.tokenCountWeight * tokenCountChange
  );
}

/**
 * Update the page's change velocity.
 *
 * The old velocity first decays exponentially over a 30-day horizon. The new
 * change is then incorporated as an EWMA observation with alpha 0.35.
 */
export function computeChangeVelocity(
  previousVelocity: number,
  changeMagnitude: number,
  elapsedDays: number
): number {
  const decay = Math.exp(
    -nonnegative(elapsedDays) / CHANGE_VELOCITY_PARAMETERS.decayDays
  );
  const decayedPrevious = clamp01(previousVelocity) * decay;
  const alpha = CHANGE_VELOCITY_PARAMETERS.ewmaAlpha;

  return clamp01(
    (1 - alpha) * decayedPrevious + alpha * clamp01(changeMagnitude)
  );
}

/** Compute UPDATE priority and expose every normalised contributing factor. */
export function computeUpdatePriority(
  inputs: UpdatePriorityInputs
): UpdatePriorityScores {
  const staleness = clamp01(
    1 -
      Math.exp(
        -nonnegative(inputs.staleDays ?? inputs.daysSinceLastUpdate ?? 0) /
          UPDATE_PRIORITY_PARAMETERS.stalenessDecayDays
      )
  );
  const dependency = clamp01(
    1 -
      Math.exp(
        -nonnegative(inputs.dependencyShock) /
          UPDATE_PRIORITY_PARAMETERS.dependencyShockScale
      )
  );
  const velocity = clamp01(inputs.changeVelocity);
  const consultation = clamp01(
    1 -
      Math.exp(
        -nonnegative(inputs.consultationsSinceUpdate) /
          UPDATE_PRIORITY_PARAMETERS.consultationsScale
      )
  );

  const weights = UPDATE_PRIORITY_PARAMETERS.weights;
  const base =
    100 *
    (weights.staleness * staleness +
      weights.dependency * dependency +
      weights.velocity * velocity +
      weights.consultation * consultation);
  const explicitBoost =
    clamp01(inputs.explicitBoost ?? 0) *
    UPDATE_PRIORITY_PARAMETERS.explicitBoostMaxPoints;

  return {
    staleness,
    dependency,
    velocity,
    consultation,
    base,
    explicitBoost,
    total: clampScore(base + explicitBoost),
  };
}

/** Compute CREATE-candidate priority and expose every contributing factor. */
export function computeCreationPriority(
  inputs: CreationPriorityInputs
): CreationPriorityScores {
  const demand = clamp01(
    1 -
      Math.exp(
        -nonnegative(inputs.mentionCount ?? inputs.mentions ?? 0) /
          CREATION_PRIORITY_PARAMETERS.demandScale
      )
  );
  const confidence = clamp01(inputs.confidence);
  const novelty = clamp01(inputs.novelty);
  const connectionPotential = clamp01(inputs.connectionPotential);
  const weights = CREATION_PRIORITY_PARAMETERS.weights;

  const total =
    100 *
    (weights.demand * demand +
      weights.confidence * confidence +
      weights.novelty * novelty +
      weights.connectionPotential * connectionPotential);

  return {
    demand,
    confidence,
    novelty,
    connectionPotential,
    total: clampScore(total),
  };
}
