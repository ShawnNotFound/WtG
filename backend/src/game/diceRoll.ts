/**
 * dice roll module for headline band selection.
 * handles random roll generation and mapping to plausibility bands.
 */

import { HeadlineBands, PlausibilityBand } from '../prompts/jurorPrompt.js';

export interface DiceRollResult {
  /** raw roll value 1-100 */
  roll: number;
  /** mapped band 1-5 */
  band: PlausibilityBand;
}

/**
 * band boundaries for mapping roll to band.
 * target distribution: 10% / 35% / 40% / 12% / 3%
 *
 * roll range is 1-100 (100 values total) so each percent maps cleanly:
 * band 1: 1-10   (10 values, 10%) - inevitable
 * band 2: 11-45  (35 values, 35%) - probable
 * band 3: 46-85  (40 values, 40%) - plausible
 * band 4: 86-97  (12 values, 12%) - possible
 * band 5: 98-100 (3 values,  3%)  - preposterous
 */
const BAND_BOUNDARIES: { min: number; max: number; band: PlausibilityBand }[] = [
  { min: 1, max: 10, band: 1 },
  { min: 11, max: 45, band: 2 },
  { min: 46, max: 85, band: 3 },
  { min: 86, max: 97, band: 4 },
  { min: 98, max: 100, band: 5 },
];

/**
 * map a roll value (1-100) to a plausibility band (1-5).
 *
 * @param roll - roll value between 1 and 100 inclusive
 * @returns the corresponding plausibility band 1-5
 * @throws error if roll is outside valid range
 */
export function mapRollToBand(roll: number): PlausibilityBand {
  if (roll < 1 || roll > 100) {
    throw new Error(`Roll must be between 1 and 100, got ${roll}`);
  }

  for (const boundary of BAND_BOUNDARIES) {
    if (roll >= boundary.min && roll <= boundary.max) {
      return boundary.band;
    }
  }

  // should never reach here if boundaries are correct
  throw new Error(`Failed to map roll ${roll} to band`);
}

/**
 * generate a random dice roll and map it to a band.
 *
 * @returns DiceRollResult with raw roll (1-100) and mapped band (1-5)
 */
export function rollDice(): DiceRollResult {
  // random integer 1-100 inclusive
  const roll = Math.floor(Math.random() * 100) + 1;
  const band = mapRollToBand(roll);

  return { roll, band };
}

/**
 * select a headline from the bands based on the given band number.
 *
 * @param bands - the headline bands object with band1-band5
 * @param band - the band number to select (1-5)
 * @returns the headline text for the selected band
 */
export function selectHeadline(bands: HeadlineBands, band: PlausibilityBand): string {
  const bandKey = `band${band}` as keyof HeadlineBands;
  return bands[bandKey];
}

/**
 * perform a complete dice roll and headline selection.
 *
 * @param bands - the headline bands from llm evaluation
 * @returns object with roll details and selected headline
 */
export function rollAndSelectHeadline(bands: HeadlineBands): {
  roll: number;
  band: PlausibilityBand;
  selectedHeadline: string;
} {
  const { roll, band } = rollDice();
  const selectedHeadline = selectHeadline(bands, band);

  return {
    roll,
    band,
    selectedHeadline,
  };
}
