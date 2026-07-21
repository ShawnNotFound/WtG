/**
 * headline transformation service.
 * orchestrates the full flow: llm evaluation -> dice roll -> headline selection.
 */

import {
  HeadlineEntry,
  PlanetEntry,
  PlausibilityBand,
  PlausibilityResult,
  PlanetsResult,
  LinkedHeadline,
  HeadlineBands,
} from '../prompts/jurorPrompt.js';
import { evaluateJuror, JurorEvaluationResult } from './jurorService.js';
import { rollDice, selectHeadline } from './diceRoll.js';

export interface TransformationInput {
  /** session id for per-game juror provider/model selection */
  sessionId?: string;
  /** the player's story direction / headline concept */
  storyDirection: string;
  /** existing headlines in the timeline */
  headlinesList: HeadlineEntry[] | string[];
  /** available planets for classification */
  planetList: PlanetEntry[];
}

export interface TransformationResult {
  // from llm evaluation
  /** plausibility assessment of the story direction */
  plausibility: PlausibilityResult;
  /** top 3 planet alignments */
  planets: PlanetsResult;
  /** top 3 linked headlines with connection strength */
  linked: LinkedHeadline[];
  /** all 5 headline variants (one per band) */
  allBands: HeadlineBands;

  // from backend dice roll
  /** raw dice roll value (0-100) */
  diceRoll: number;
  /** the band selected by dice roll (1-5) */
  selectedBand: PlausibilityBand;
  /** the final headline text after dice selection */
  selectedHeadline: string;

  // metadata
  /** model used for llm evaluation */
  model: string;
  /** token usage from llm call */
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };

  // raw llm data for logging
  /** raw request sent to llm */
  llmRequest: Record<string, unknown>;
  /** raw response from llm */
  llmResponse: string;
}

/**
 * transform a story direction into a final headline.
 *
 * flow:
 * 1. call llm juror to evaluate story direction and generate 5 headline variants
 * 2. roll dice (0-100) and map to band (1-5)
 * 3. select the headline from the rolled band
 * 4. return combined result with all data for storage
 *
 * @param input - story direction, existing headlines, and planet list
 * @returns complete transformation result including llm evaluation and dice roll
 */
export async function transformHeadline(
  input: TransformationInput
): Promise<TransformationResult> {
  // call llm juror for evaluation and headline generation
  const jurorResult: JurorEvaluationResult = await evaluateJuror({
    sessionId: input.sessionId,
    storyDirection: input.storyDirection,
    headlinesList: input.headlinesList,
    planetList: input.planetList,
  });

  const evaluation = jurorResult.evaluation;

  const { roll, band } = rollDice();

  const selectedHeadline = selectHeadline(evaluation.HEADLINES.bands, band);

  return {
    plausibility: evaluation.PLAUSIBILITY,
    planets: evaluation.PLANETS,
    linked: evaluation.LINKED,
    allBands: evaluation.HEADLINES.bands,

    diceRoll: roll,
    selectedBand: band,
    selectedHeadline,

    model: jurorResult.model,
    usage: jurorResult.usage,

    llmRequest: jurorResult.rawRequest,
    llmResponse: jurorResult.rawResponse,
  };
}

/**
 * transform a story direction with a predetermined dice roll.
 * useful for testing or when dice roll is provided externally.
 *
 * @param input - story direction, existing headlines, and planet list
 * @param predeterminedRoll - the dice roll value to use (0-100)
 * @returns complete transformation result
 */
export async function transformHeadlineWithRoll(
  input: TransformationInput,
  predeterminedRoll: number
): Promise<TransformationResult> {
  if (predeterminedRoll < 0 || predeterminedRoll > 100) {
    throw new Error(`Roll must be between 0 and 100, got ${predeterminedRoll}`);
  }

  const { mapRollToBand } = await import('./diceRoll.js');

  const jurorResult: JurorEvaluationResult = await evaluateJuror({
    sessionId: input.sessionId,
    storyDirection: input.storyDirection,
    headlinesList: input.headlinesList,
    planetList: input.planetList,
  });

  const evaluation = jurorResult.evaluation;

  const band = mapRollToBand(predeterminedRoll);

  const selectedHeadline = selectHeadline(evaluation.HEADLINES.bands, band);

  return {
    plausibility: evaluation.PLAUSIBILITY,
    planets: evaluation.PLANETS,
    linked: evaluation.LINKED,
    allBands: evaluation.HEADLINES.bands,

    diceRoll: predeterminedRoll,
    selectedBand: band,
    selectedHeadline,

    model: jurorResult.model,
    usage: jurorResult.usage,

    llmRequest: jurorResult.rawRequest,
    llmResponse: jurorResult.rawResponse,
  };
}

// re-export types for convenience
export type {
  HeadlineEntry,
  PlanetEntry,
  PlausibilityBand,
  PlausibilityResult,
  PlanetsResult,
  LinkedHeadline,
  HeadlineBands,
} from '../prompts/jurorPrompt.js';
