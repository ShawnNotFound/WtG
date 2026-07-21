/**
 * scoring service for headline evaluation.
 * this module handles database operations for scoring and provides
 * the main api for llm/heuristic integration.
 */

import pool from '../db/pool.js';
import {
  HeadlineEvaluationPayload,
  HeadlineEvaluationResult,
  HeadlineScoreBreakdown,
  PlayerScoreEntry,
  ScoringConfig,
  DEFAULT_SCORING_CONFIG,
  DEFAULT_PLANETS,
} from './scoringTypes.js';
import {
  migrateGlobalUsage,
  migratePlayerOrdinals,
  applyGlobalPlanetScoring,
  computePlanetPanel,
} from './planetUsage.js';
import { computeHeadlineScore } from './scoring.js';

/**
 * raw player row from database.
 * note: planet_usage_state now holds the per-player ordinal permutation;
 * coerce it with migratePlayerOrdinals.
 */
interface PlayerRow {
  id: string;
  session_id: string;
  nickname: string;
  total_score: number;
  planet_usage_state: unknown;  // per-player ordinals, use migratePlayerOrdinals
}

/**
 * raw headline row from database.
 */
interface HeadlineRow {
  id: string;
  session_id: string;
  player_id: string;
  round_no: number;
  total_headline_score: number | null;
}

export class ScoringError extends Error {
  constructor(
    message: string,
    public code: string
  ) {
    super(message);
    this.name = 'ScoringError';
  }
}

/**
 * apply an ai/llm headline evaluation and update scores.
 *
 * this function:
 * 1. validates the headline exists and belongs to the player/session
 * 2. loads the player's current score and planet usage state
 * 3. computes the complete score breakdown (including planet bonus)
 * 4. updates the headline with scoring details
 * 5. updates the player's total score and planet usage state
 * 6. returns the breakdown, new total, and full leaderboard
 *
 * @param payload - evaluation payload from ai/llm
 * @param config - scoring configuration (defaults to DEFAULT_SCORING_CONFIG)
 * @returns score breakdown, new total, and leaderboard
 */
export async function applyHeadlineEvaluation(
  payload: HeadlineEvaluationPayload,
  config: ScoringConfig = DEFAULT_SCORING_CONFIG
): Promise<HeadlineEvaluationResult> {
  const {
    sessionId,
    playerId,
    headlineId,
    plausibilityLevel,
    selectedBand,
    uniqueOtherAuthors,
    aiPlanetRankings,
    roundNo,
  } = payload;

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // load and validate player
    const playerResult = await client.query<PlayerRow>(
      `SELECT id, session_id, nickname, total_score, planet_usage_state
       FROM session_players
       WHERE id = $1 AND session_id = $2`,
      [playerId, sessionId]
    );

    if (playerResult.rows.length === 0) {
      throw new ScoringError(
        `Player ${playerId} not found in session ${sessionId}`,
        'PLAYER_NOT_FOUND'
      );
    }

    const player = playerResult.rows[0];

    // load and validate headline
    const headlineResult = await client.query<HeadlineRow>(
      `SELECT id, session_id, player_id, round_no, total_headline_score
       FROM game_session_headlines
       WHERE id = $1`,
      [headlineId]
    );

    if (headlineResult.rows.length === 0) {
      throw new ScoringError(
        `Headline ${headlineId} not found`,
        'HEADLINE_NOT_FOUND'
      );
    }

    const headline = headlineResult.rows[0];

    // validate headline belongs to the correct session and player
    if (headline.session_id !== sessionId) {
      throw new ScoringError(
        `Headline ${headlineId} does not belong to session ${sessionId}`,
        'HEADLINE_SESSION_MISMATCH'
      );
    }

    if (headline.player_id !== playerId) {
      throw new ScoringError(
        `Headline ${headlineId} does not belong to player ${playerId}`,
        'HEADLINE_PLAYER_MISMATCH'
      );
    }

    if (headline.total_headline_score !== null) {
      throw new ScoringError(
        `Headline ${headlineId} has already been scored`,
        'HEADLINE_ALREADY_SCORED'
      );
    }

    // load global planet usage; lock the session row to serialize concurrent submissions
    const usageResult = await client.query<{ planet_usage_global: unknown }>(
      `SELECT planet_usage_global FROM game_sessions WHERE id = $1 FOR UPDATE`,
      [sessionId]
    );
    const globalUsage = migrateGlobalUsage(
      usageResult.rows[0]?.planet_usage_global,
      DEFAULT_PLANETS
    );

    // band-based planet scoring: bonus from the primary planet's global band, +1 to its usage.
    // band membership is global (shared across players), so it does not use this player's ordinals.
    const planetResult = applyGlobalPlanetScoring(globalUsage, aiPlanetRankings, DEFAULT_PLANETS);

    // calculate complete headline score.
    // selectedBand (dice roll result) is used for plausibility scoring
    const breakdown: HeadlineScoreBreakdown = computeHeadlineScore(
      {
        plausibilityLevel,
        selectedBand,
        uniqueOtherAuthors,
        aiPlanetRankings,
        roundNo,
      },
      planetResult.bonus,
      config
    );

    // update headline with scoring breakdown.
    // others_story_connection_level stores unique other author count
    // and others_story_score stores the connection score for backwards compatibility
    const [planet1, planet2, planet3] = aiPlanetRankings.slice(0, 3);

    await client.query(
      `UPDATE game_session_headlines
       SET baseline_score = $1,
           plausibility_level = $2,
           selected_band = $3,
           plausibility_score = $4,
           self_story_connection_level = NULL,
           self_story_score = 0,
           others_story_connection_level = $5,
           others_story_score = $6,
           planet_1 = $7,
           planet_2 = $8,
           planet_3 = $9,
           planet_bonus_score = $10,
           total_headline_score = $11,
           llm_status = 'evaluated'
       WHERE id = $12`,
      [
        breakdown.baseline,
        plausibilityLevel,
        selectedBand,
        breakdown.plausibility,
        String(uniqueOtherAuthors),
        breakdown.connectionScore,
        planet1 ?? null,
        planet2 ?? null,
        planet3 ?? null,
        breakdown.planetBonus,
        breakdown.total,
        headlineId,
      ]
    );

    // update player's total score (ordinals are immutable, so not rewritten here)
    const newTotalScore = player.total_score + breakdown.total;

    await client.query(
      `UPDATE session_players
       SET total_score = $1
       WHERE id = $2`,
      [newTotalScore, playerId]
    );

    // persist the updated global planet usage
    await client.query(
      `UPDATE game_sessions
       SET planet_usage_global = $1
       WHERE id = $2`,
      [JSON.stringify(planetResult.updatedUsage), sessionId]
    );

    // get updated leaderboard, including each player's ordinals so we can
    // recompute their planet panel against the new global usage
    const leaderboardResult = await client.query<{
      id: string;
      nickname: string;
      total_score: number;
      planet_usage_state: unknown;
    }>(
      `SELECT id, nickname, total_score, planet_usage_state
       FROM session_players
       WHERE session_id = $1 AND is_system = FALSE
       ORDER BY total_score DESC, joined_at ASC`,
      [sessionId]
    );

    const leaderboard: PlayerScoreEntry[] = leaderboardResult.rows.map(
      (row, index) => ({
        playerId: row.id,
        nickname: row.nickname,
        totalScore: row.total_score,
        rank: index + 1,
        planetPanel: computePlanetPanel(
          planetResult.updatedUsage,
          migratePlayerOrdinals(row.planet_usage_state, DEFAULT_PLANETS),
          DEFAULT_PLANETS
        ),
      })
    );

    await client.query('COMMIT');

    return {
      breakdown,
      newTotalScore,
      leaderboard,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * get the current leaderboard for a session.
 *
 * @param sessionId - session id
 * @returns array of player scores ordered by rank
 */
export async function getLeaderboard(
  sessionId: string
): Promise<PlayerScoreEntry[]> {
  const result = await pool.query<{
    id: string;
    nickname: string;
    total_score: number;
  }>(
    `SELECT id, nickname, total_score
     FROM session_players
     WHERE session_id = $1 AND is_system = FALSE
     ORDER BY total_score DESC, joined_at ASC`,
    [sessionId]
  );

  return result.rows.map((row, index) => ({
    playerId: row.id,
    nickname: row.nickname,
    totalScore: row.total_score,
    rank: index + 1,
  }));
}

/**
 * get scoring breakdown for a specific headline.
 *
 * @param headlineId - headline id
 * @returns score breakdown or null if not scored yet
 */
export async function getHeadlineScoreBreakdown(
  headlineId: string
): Promise<HeadlineScoreBreakdown | null> {
  const result = await pool.query<{
    baseline_score: number | null;
    plausibility_score: number | null;
    self_story_score: number | null;
    others_story_score: number | null;
    planet_bonus_score: number | null;
    total_headline_score: number | null;
  }>(
    `SELECT baseline_score, plausibility_score, self_story_score,
            others_story_score, planet_bonus_score, total_headline_score
     FROM game_session_headlines
     WHERE id = $1`,
    [headlineId]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0];

  // if not scored yet, return null
  if (row.total_headline_score === null) {
    return null;
  }

  // others_story_score now stores connectionScore in the new model
  return {
    baseline: row.baseline_score ?? 0,
    plausibility: row.plausibility_score ?? 0,
    connectionScore: row.others_story_score ?? 0,
    selfStory: 0, // deprecated, always 0
    othersStory: 0, // deprecated, always 0
    planetBonus: row.planet_bonus_score ?? 0,
    total: row.total_headline_score,
  };
}

/**
 * get aggregated score breakdowns for all players in a session.
 * sums each score component across all headlines per player.
 *
 * @param sessionId - session id
 * @returns map of playerId to score breakdown
 */
export async function getPlayerScoreBreakdowns(
  sessionId: string
): Promise<Map<string, { baseline: number; plausibility: number; connection: number; planetBonus: number }>> {
  const result = await pool.query(
    `SELECT
      sp.id AS player_id,
      COALESCE(SUM(h.baseline_score), 0)::int AS baseline,
      COALESCE(SUM(h.plausibility_score), 0)::int AS plausibility,
      COALESCE(SUM(h.others_story_score), 0)::int AS connection,
      COALESCE(SUM(h.planet_bonus_score), 0)::int AS planet_bonus
    FROM session_players sp
    LEFT JOIN game_session_headlines h ON h.player_id = sp.id
    WHERE sp.session_id = $1 AND sp.is_system = FALSE
    GROUP BY sp.id`,
    [sessionId]
  );

  const map = new Map<string, { baseline: number; plausibility: number; connection: number; planetBonus: number }>();
  for (const row of result.rows) {
    map.set(row.player_id, {
      baseline: row.baseline,
      plausibility: row.plausibility,
      connection: row.connection,
      planetBonus: row.planet_bonus,
    });
  }
  return map;
}
