/**
 * planet usage panel logic (band-based global scoring system).
 *
 * replaces the per-player "priority planet" system in planetWeighting.ts.
 *
 * concept:
 * - each session keeps a GLOBAL usage counter per planet (incremented when a
 *   headline is classified to that planet).
 * - each player has a stable random ordinal permutation of the planets, generated
 *   once at game start, used only to break ties when ordering by usage. this gives
 *   every player a different list so they don't all rush the same planet.
 * - a player's displayed order = sort planets by (globalUsage asc, playerOrdinal asc).
 *   the least-used planets are at the top.
 * - the order is split into three bands: top 3 -> +2, middle 3 -> +1, bottom 3 -> +0.
 * - a submitted headline earns the band its primary planet sits in (in that player's
 *   own order), and increments that planet's global usage by 1.
 */

import { PlanetId, DEFAULT_PLANETS, PlanetBand, PlanetPanelEntry } from './scoringTypes.js';

/** global per-session usage counts, keyed by planet id. */
export type GlobalUsage = Record<PlanetId, number>;

/** per-player stable random tie-break permutation: planet id -> ordinal 0..n-1. */
export interface PlayerOrdinals {
  ordinals: Record<PlanetId, number>;
}

/** result of applying band-based planet scoring for one headline. */
export interface GlobalPlanetScoringResult {
  /** band points awarded (0 | 1 | 2) */
  bonus: PlanetBand;
  /** global usage after incrementing the used planet */
  updatedUsage: GlobalUsage;
  /** the planet that scored / incremented usage, or null */
  usedPlanet: PlanetId | null;
}

/**
 * create an all-zero global usage map.
 */
export function initialGlobalUsage(planets: PlanetId[] = DEFAULT_PLANETS): GlobalUsage {
  const usage: GlobalUsage = {};
  for (const p of planets) {
    usage[p] = 0;
  }
  return usage;
}

/**
 * coerce raw db json into a valid global usage map.
 * handles null / empty / partial by filling missing planet keys with 0.
 */
export function migrateGlobalUsage(
  raw: unknown,
  planets: PlanetId[] = DEFAULT_PLANETS
): GlobalUsage {
  const usage = initialGlobalUsage(planets);
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    for (const p of planets) {
      const v = obj[p];
      if (typeof v === 'number' && Number.isFinite(v)) {
        usage[p] = v;
      }
    }
  }
  return usage;
}

/**
 * generate a fresh random ordinal permutation of the planets (Fisher-Yates).
 * each planet gets a unique ordinal in 0..n-1.
 */
export function randomOrdinals(planets: PlanetId[] = DEFAULT_PLANETS): PlayerOrdinals {
  const slots = planets.map((_, i) => i);
  for (let i = slots.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [slots[i], slots[j]] = [slots[j], slots[i]];
  }
  const ordinals: Record<PlanetId, number> = {};
  planets.forEach((p, i) => {
    ordinals[p] = slots[i];
  });
  return { ordinals };
}

/**
 * coerce raw db json into valid per-player ordinals.
 * a complete `{ ordinals: { ... } }` is used as-is; anything else (null, empty,
 * partial, or the legacy tally format) gets a fresh random permutation.
 * this is also the rejoin / mid-game backfill path.
 */
export function migratePlayerOrdinals(
  raw: unknown,
  planets: PlanetId[] = DEFAULT_PLANETS
): PlayerOrdinals {
  if (raw && typeof raw === 'object' && 'ordinals' in (raw as object)) {
    const rawOrd = (raw as { ordinals?: unknown }).ordinals;
    if (rawOrd && typeof rawOrd === 'object') {
      const src = rawOrd as Record<string, unknown>;
      const allPresent = planets.every((p) => typeof src[p] === 'number');
      if (allPresent) {
        const ordinals: Record<PlanetId, number> = {};
        for (const p of planets) {
          ordinals[p] = src[p] as number;
        }
        return { ordinals };
      }
    }
  }
  return randomOrdinals(planets);
}

/**
 * map a position in the global ranking to its band: 0-2 -> +2, 3-5 -> +1, 6+ -> +0.
 */
export function bandForIndex(index: number): PlanetBand {
  if (index < 3) {
    return 2;
  }
  if (index < 6) {
    return 1;
  }
  return 0;
}

/**
 * global band membership for all planets — identical for every player in the
 * session. planets are ranked by global usage (least-used first); ties are
 * broken by a fixed canonical order so the band assignment is shared by all
 * players. the least-used three are band +2, the next three +1, the rest +0.
 */
export function computeBandMembership(
  usage: GlobalUsage,
  planets: PlanetId[] = DEFAULT_PLANETS
): Record<PlanetId, PlanetBand> {
  const order = [...planets].sort((a, b) => {
    const ua = usage[a] ?? 0;
    const ub = usage[b] ?? 0;
    if (ua !== ub) {
      return ua - ub;
    }
    // fixed canonical tie-break, shared across all players
    return planets.indexOf(a) - planets.indexOf(b);
  });
  const bands: Record<PlanetId, PlanetBand> = {};
  order.forEach((id, index) => {
    bands[id] = bandForIndex(index);
  });
  return bands;
}

/**
 * build the player-facing planet panel.
 *
 * band membership is GLOBAL — the same planets sit in each band for every
 * player. only the order WITHIN each band is shuffled per player using their
 * stable random ordinals. bands are emitted top (+2) to bottom (+0).
 */
export function computePlanetPanel(
  usage: GlobalUsage,
  ordinals: PlayerOrdinals,
  planets: PlanetId[] = DEFAULT_PLANETS
): PlanetPanelEntry[] {
  const bands = computeBandMembership(usage, planets);
  const result: PlanetPanelEntry[] = [];
  for (const band of [2, 1, 0] as PlanetBand[]) {
    const group = planets
      .filter((id) => bands[id] === band)
      .sort((a, b) => (ordinals.ordinals[a] ?? 0) - (ordinals.ordinals[b] ?? 0));
    for (const id of group) {
      result.push({ id, usage: usage[id] ?? 0, band });
    }
  }
  return result;
}

/**
 * apply band-based planet scoring for a submitted headline.
 *
 * the primary (rank-1) planet drives both the band bonus and the usage increment.
 * band membership is global, so the bonus is the same for every player and does not
 * depend on the player's ordinals; it is read from the pre-increment global bands.
 *
 * NOTE (single decision point): to score / increment all of the ai's top-3 planets
 * instead of just the primary, iterate `aiRankings.slice(0, 3)` here — increment each
 * one's usage and take the best (highest) band among them as the bonus.
 */
export function applyGlobalPlanetScoring(
  usage: GlobalUsage,
  aiRankings: PlanetId[],
  planets: PlanetId[] = DEFAULT_PLANETS
): GlobalPlanetScoringResult {
  const primary = aiRankings[0] ?? null;
  if (primary === null) {
    return { bonus: 0, updatedUsage: { ...usage }, usedPlanet: null };
  }

  const bands = computeBandMembership(usage, planets);
  const bonus: PlanetBand = bands[primary] ?? 0;

  const updatedUsage: GlobalUsage = {
    ...usage,
    [primary]: (usage[primary] ?? 0) + 1,
  };

  return { bonus, updatedUsage, usedPlanet: primary };
}
