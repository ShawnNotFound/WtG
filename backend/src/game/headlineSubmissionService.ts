import { Server } from 'socket.io';
import pool from '../db/pool.js';
import { transformHeadline, LinkedHeadline } from './headlineTransformationService.js';
import { getDefaultPlanets } from './planets.js';
import { HeadlineEntry } from '../llm/jurorPrompt.js';
import { applyHeadlineEvaluation, getPlayerScoreBreakdowns } from './scoringService.js';
import { PlausibilityLevel } from './scoringTypes.js';
import { SEED_HEADLINES } from './seedHeadlines.js';
import { worldStateProcessor } from '../world/worldStateService.js';

const JUROR_HISTORY_WINDOW = SEED_HEADLINES.length;

export interface SubmitPlayerHeadlineInput {
  io: Server;
  sessionId: string;
  joinCode: string;
  playerId: string;
  playerNickname: string;
  currentRound: number;
  storyDirection: string;
  inGameNow: string | null;
}

async function deriveUniqueOtherAuthorCount(
  linkedHeadlines: LinkedHeadline[],
  sessionId: string,
  currentPlayerId: string
): Promise<number> {
  const strongConnections = linkedHeadlines.filter((h) => h.strength === 'STRONG');
  if (strongConnections.length === 0) {
    return 0;
  }

  const headlineTexts = strongConnections.map((h) => h.headline);
  const result = await pool.query(
    `SELECT player_id
     FROM game_session_headlines
     WHERE session_id = $1
       AND COALESCE(selected_headline, headline_text) = ANY($2)`,
    [sessionId, headlineTexts]
  );

  const otherAuthors = new Set<string>();
  for (const row of result.rows) {
    if (row.player_id !== currentPlayerId) {
      otherAuthors.add(row.player_id);
    }
  }

  return Math.min(otherAuthors.size, 3);
}

export async function submitPlayerHeadline(input: SubmitPlayerHeadlineInput) {
  const existingHeadlinesResult = await pool.query(
    `SELECT id, text FROM (
       SELECT id, COALESCE(selected_headline, headline_text) AS text, created_at
       FROM game_session_headlines
       WHERE session_id = $1
       ORDER BY created_at DESC
       LIMIT $2
     ) recent
     ORDER BY created_at ASC`,
    [input.sessionId, JUROR_HISTORY_WINDOW]
  );
  const headlinesList: HeadlineEntry[] = existingHeadlinesResult.rows.map((row) => ({
    id: row.id,
    text: row.text,
  }));

  const transformResult = await transformHeadline({
    sessionId: input.sessionId,
    storyDirection: input.storyDirection,
    headlinesList,
    planetList: getDefaultPlanets(),
  });

  const insertResult = await pool.query(
    `INSERT INTO game_session_headlines (
      session_id, player_id, round_no, headline_text,
      dice_roll, selected_band, selected_headline,
      band1_headline, band2_headline, band3_headline, band4_headline, band5_headline,
      plausibility_level, plausibility_rationale,
      planet_1, planet_2, planet_3,
      linked_headlines, planet_rationales,
      llm_model, llm_input_tokens, llm_output_tokens,
      llm_request, llm_response,
      llm_status, in_game_submitted_at
    ) VALUES (
      $1, $2, $3, $4,
      $5, $6, $7,
      $8, $9, $10, $11, $12,
      $13, $14,
      $15, $16, $17,
      $18, $19,
      $20, $21, $22,
      $23, $24,
      'evaluated', $25
    )
    RETURNING id, created_at, in_game_submitted_at`,
    [
      input.sessionId,
      input.playerId,
      input.currentRound,
      input.storyDirection,
      transformResult.diceRoll,
      transformResult.selectedBand,
      transformResult.selectedHeadline,
      transformResult.allBands.band1,
      transformResult.allBands.band2,
      transformResult.allBands.band3,
      transformResult.allBands.band4,
      transformResult.allBands.band5,
      transformResult.plausibility.band,
      transformResult.plausibility.rationale,
      transformResult.planets.top3[0]?.id,
      transformResult.planets.top3[1]?.id,
      transformResult.planets.top3[2]?.id,
      JSON.stringify(transformResult.linked),
      JSON.stringify(transformResult.planets.top3),
      transformResult.model,
      transformResult.usage?.inputTokens,
      transformResult.usage?.outputTokens,
      JSON.stringify(transformResult.llmRequest),
      transformResult.llmResponse,
      input.inGameNow,
    ]
  );

  const insertedRow = insertResult.rows[0];
  const headlineEvent = {
    id: insertedRow.id,
    sessionId: input.sessionId,
    playerId: input.playerId,
    playerNickname: input.playerNickname,
    roundNo: input.currentRound,
    storyDirection: input.storyDirection,
    text: transformResult.selectedHeadline,
    diceRoll: transformResult.diceRoll,
    selectedBand: transformResult.selectedBand,
    plausibilityBand: transformResult.plausibility.band,
    plausibilityLabel: transformResult.plausibility.label,
    planets: transformResult.planets.top3.map((p) => p.id),
    allBands: transformResult.allBands,
    createdAt: new Date(insertedRow.created_at).toISOString(),
    inGameSubmittedAt: insertedRow.in_game_submitted_at
      ? new Date(insertedRow.in_game_submitted_at).toISOString()
      : null,
  };

  const roomName = `session:${input.joinCode}`;
  input.io.to(roomName).emit('headline:new', headlineEvent);

  worldStateProcessor.enqueueHeadlineUpdate({
    sessionId: input.sessionId,
    headlineId: insertedRow.id,
    headlineText: transformResult.selectedHeadline,
    storyDirection: input.storyDirection,
    playerNickname: input.playerNickname,
    roundNo: input.currentRound,
    inGameSubmittedAt: headlineEvent.inGameSubmittedAt,
  }).catch((error) => {
    console.error(`[WorldState ${input.joinCode}] Headline update enqueue failed:`, error);
  });

  const uniqueOtherAuthors = await deriveUniqueOtherAuthorCount(
    transformResult.linked,
    input.sessionId,
    input.playerId
  );

  const scoringResult = await applyHeadlineEvaluation({
    sessionId: input.sessionId,
    playerId: input.playerId,
    headlineId: insertedRow.id,
    plausibilityLevel: transformResult.plausibility.band as PlausibilityLevel,
    selectedBand: transformResult.selectedBand as PlausibilityLevel,
    uniqueOtherAuthors,
    aiPlanetRankings: transformResult.planets.top3.map((p) => p.id),
    roundNo: input.currentRound,
  });

  const updatedBreakdowns = await getPlayerScoreBreakdowns(input.sessionId);
  input.io.to(roomName).emit('leaderboard:update', {
    leaderboard: scoringResult.leaderboard.map((entry) => ({
      ...entry,
      scoreBreakdown: updatedBreakdowns.get(entry.playerId) ?? {
        baseline: 0,
        plausibility: 0,
        connection: 0,
        planetBonus: 0,
      },
    })),
    lastScoredHeadline: {
      headlineId: insertedRow.id,
      playerId: input.playerId,
      breakdown: scoringResult.breakdown,
      newTotalScore: scoringResult.newTotalScore,
    },
  });

  return headlineEvent;
}
