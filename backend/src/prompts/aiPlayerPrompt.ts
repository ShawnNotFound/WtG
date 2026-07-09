import { JsonSchemaDefinition } from '../llm/openaiResponsesClient.js';
import { PlanetPanelEntry } from '../game/scoringTypes.js';

export interface AiVisibleHeadline {
  text: string;
  playerNickname: string;
  roundNo: number;
  inGameSubmittedAt: string | null;
  planets: string[];
  totalScore: number | null;
}

export interface AiPlayerPromptInput {
  nickname: string;
  stylePrompt: string;
  creativity: number;
  inGameNow: string | null;
  currentRound: number;
  maxRounds: number;
  scoringSummary: string;
  planetPanel: PlanetPanelEntry[];
  headlines: AiVisibleHeadline[];
  worldHelperInsights?: AiWorldHelperInsight[];
}

export interface AiWorldHelperInsight {
  question: string;
  answerText: string;
  entityRefs: Array<{
    name: string;
    reason: string;
  }>;
  edgeRefs: Array<{
    sourceName: string;
    targetName: string;
    relationType: string;
    reason: string;
  }>;
}

export interface AiPlayerOutput {
  storyDirection: string;
  rationale: string;
}

export const aiPlayerJsonSchema: JsonSchemaDefinition = {
  name: 'ai_player_story_direction',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      storyDirection: {
        type: 'string',
        description: 'A dated near-future AI story direction, 280 characters or fewer.',
      },
      rationale: {
        type: 'string',
        description: 'Brief private reason this move should score well.',
      },
    },
    required: ['storyDirection', 'rationale'],
    additionalProperties: false,
  },
};

/**
 * Global behavior prompt for demo AI players.
 *
 * Edit this file to change the AI player's overall strategy. Per-player style
 * settings from the lobby are appended separately and should stay narrower.
 */
export function buildAiPlayerInstructions(): string {
  return `You are a demo AI player in Future Headlines, a multiplayer game about near-future AI developments.

Your goal is to score highly while using only the same game information a human player sees:
- the existing public headline timeline
- the public scoring rules
- your real-time visible planet scoring panel
- the current round and in-game date
- optional neutral World Helper context requested through the same helper interface available to players

Play to maximize points, not to be merely interesting:
1. Highest priority: create a story direction that can strongly connect to three distinct other authors' accepted headlines. Three distinct author connections are worth far more than one.
2. Aim for P3 plausible: surprising and consequential, but not too obvious and not absurd.
3. Use the current +2 planet list as a live scoring target. Make one +2 planet the clear primary theme when it fits; otherwise use a +1 planet. Avoid +0 primary planets unless they are necessary for a much stronger three-author connection.
4. Name concrete entities, dates, policies, products, incidents, or institutions so the juror has enough evidence to classify the planet and detect links.
5. Stay within 280 characters.

The World Helper is not allowed to generate playable ideas, sample headlines, or strategy recommendations. Treat helper output only as descriptive world-state context; you must create the story direction yourself from the public game state and neutral context.

Never mention that you are an AI player. Never explain the scoring strategy in the storyDirection. Return only JSON matching the schema.`;
}

export function buildAiPlayerPrompt(input: AiPlayerPromptInput): string {
  const planetsByBand = ([2, 1, 0] as const)
    .map((band) => {
      const planets = input.planetPanel
        .filter((p) => p.band === band)
        .map((p) => `${p.id} (usage ${p.usage})`);
      return `+${band}: ${planets.length > 0 ? planets.join(', ') : 'none'}`;
    })
    .join('\n');

  const planetPanel = input.planetPanel
    .map((p) => `- ${p.id}: +${p.band} if it is the juror's rank-1/primary planet, current usage ${p.usage}`)
    .join('\n');

  const headlines = input.headlines.length > 0
    ? input.headlines
        .map((h, i) => {
          const planetsText = h.planets.length > 0 ? h.planets.join(', ') : 'none';
          const scoreText = h.totalScore === null ? 'pending' : `${h.totalScore} pts`;
          const dateText = h.inGameSubmittedAt ? `; date: ${h.inGameSubmittedAt}` : '';
          return `${i + 1}. [R${h.roundNo}${dateText}] ${h.text} (${h.playerNickname}; planets: ${planetsText}; score: ${scoreText})`;
        })
        .join('\n')
    : 'No accepted headlines yet.';

  const connectionTargets = input.headlines.length > 0
    ? Array.from(
        input.headlines.reduce((byAuthor, h, i) => {
          if (h.playerNickname === input.nickname) {
            return byAuthor;
          }
          const existing = byAuthor.get(h.playerNickname) ?? [];
          existing.push(`${i + 1}. ${h.text}`);
          byAuthor.set(h.playerNickname, existing);
          return byAuthor;
        }, new Map<string, string[]>())
      )
        .map(([author, items]) => `- ${author}: ${items.slice(-3).join(' | ')}`)
        .join('\n') || 'No other-author headlines are available yet.'
    : 'No other-author headlines are available yet.';

  const helperInsights = input.worldHelperInsights && input.worldHelperInsights.length > 0
    ? input.worldHelperInsights
        .map((insight, index) => {
          const entityRefs = insight.entityRefs.length > 0
            ? insight.entityRefs.map((ref) => `- ${ref.name}: ${ref.reason}`).join('\n')
            : 'No cited entities.';
          const edgeRefs = insight.edgeRefs.length > 0
            ? insight.edgeRefs.map((ref) => `- ${ref.sourceName} -> ${ref.targetName} [${ref.relationType}]: ${ref.reason}`).join('\n')
            : 'No cited connections.';
          return `Helper answer ${index + 1}
Question: ${insight.question}
Answer: ${insight.answerText}
Referenced entities:
${entityRefs}
Referenced connections:
${edgeRefs}`;
        })
        .join('\n\n')
    : 'No World Helper research was requested for this turn.';

  return `=== PLAYER ===
${input.nickname}

=== CURRENT GAME STATE ===
Round ${input.currentRound} of ${input.maxRounds}
In-game date: ${input.inGameNow ?? 'not available'}
Creativity setting: ${input.creativity}

=== SCORING RULES ===
${input.scoringSummary}

=== HIGH-VALUE PLANETS RIGHT NOW ===
These are real-time scores from your visible planet panel. The juror's rank-1 planet determines this bonus.
${planetsByBand}

=== FULL PLANET PANEL ===
${planetPanel}

=== CONNECTION TARGETS BY DISTINCT AUTHOR ===
For connection scoring, a strong link to 3 distinct other authors is the major target. Prefer a story that naturally references or extends one headline from three different authors.
${connectionTargets}

=== PUBLIC TIMELINE HEADLINES ===
${headlines}

=== NEUTRAL WORLD HELPER CONTEXT ===
Use this only as descriptive context about selected world-graph entities and connections. Do not copy it as a play recommendation, and do not assume the helper has chosen your idea for you.
${helperInsights}

=== PLAYER STYLE ===
${input.stylePrompt || 'No special style. Be clear, specific, strategic, and concise.'}

Write one story direction now. It should be a dated near-future development, not a polished newspaper headline.`;
}
