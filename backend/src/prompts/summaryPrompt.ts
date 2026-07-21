/**
 * summary prompt builder and json schema for round summary generation.
 * builds the prompt for ai-generated narrative summaries displayed during break phase.
 */

import { JsonSchemaDefinition } from '../llm/openaiResponsesClient.js';
import { SummaryPromptInput, RoundHeadlineInput } from '../llm/summaryTypes.js';

/**
 * json schema that enforces the structure of the round summary output.
 * used with the openai responses api response_format.
 */
export const summaryJsonSchema: JsonSchemaDefinition = {
  name: 'round_summary',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      narrative: {
        type: 'string',
        description: '2 short paragraph narrative summary of events as if they really happened',
      },
      themes: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        maxItems: 3,
        description: 'Top 3 themes from this period',
      },
      highlightedHeadlines: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            headline: {
              type: 'string',
              description: 'The headline text',
            },
            source: {
              type: 'string',
              description: 'The news source or correspondent who reported this',
            },
            significance: {
              type: 'string',
              description: 'The historical significance or impact of this event',
            },
          },
          required: ['headline', 'source', 'significance'],
          additionalProperties: false,
        },
        minItems: 1,
        maxItems: 2,
        description: 'Top 2 most significant headlines from this period',
      },
      roundStats: {
        type: 'object',
        properties: {
          headlineCount: {
            type: 'integer',
            description: 'Total number of developments reported',
          },
          playerCount: {
            type: 'integer',
            description: 'Number of sources/correspondents',
          },
        },
        required: ['headlineCount', 'playerCount'],
        additionalProperties: false,
      },
    },
    required: ['narrative', 'themes', 'highlightedHeadlines', 'roundStats'],
    additionalProperties: false,
  },
};

/**
 * format a single headline for the prompt.
 */
function formatHeadline(headline: RoundHeadlineInput, index: number): string {
  return `${index + 1}. "${headline.headline}" by ${headline.player}
   - Plausibility: ${headline.plausibilityLabel} (${headline.plausibilityLevel}/5)
   - Story direction: ${headline.storyDirection}`;
}

/**
 * build the summary prompt from the input data.
 */
export function buildSummaryPrompt(input: SummaryPromptInput): string {
  const { fromRound, toRound, totalRounds, headlines } = input;

  const formattedHeadlines = headlines.length > 0
    ? headlines.map((h, i) => formatHeadline(h, i)).join('\n\n')
    : 'No headlines were submitted in this period.';

  // count unique players
  const uniquePlayers = new Set(headlines.map(h => h.player));
  const playerCount = uniquePlayers.size;

  // describe the period being summarised
  const periodLabel = fromRound === toRound
    ? `Round ${toRound} of ${totalRounds}`
    : (fromRound === 1 && toRound === totalRounds
      ? `The entire timeline (all ${totalRounds} rounds)`
      : `Rounds ${fromRound}-${toRound} of ${totalRounds}`);

  return `You are a future historian summarizing events from a timeline where AI has transformed society. ${periodLabel} has just ended.

=== HEADLINES FROM THIS PERIOD ===
${formattedHeadlines}

=== PERIOD STATISTICS ===
- Total headlines: ${headlines.length}
- Contributors: ${playerCount}

=== YOUR TASK ===
Create a narrative summary as if these headlines represent REAL EVENTS that have happened in this alternate future timeline. Write as a historian or journalist recapping actual news, NOT as a game show host discussing player submissions.

1. **Narrative**: Write 2 short paragraphs summarizing the events as if they actually occurred. Keep it concise and tight. Weave the headlines together into a coherent story of what happened in this period. Use phrases like "This period saw...", "Major developments included...", "The world witnessed...", etc. Do NOT mention players, submissions, or the game itself.

2. **Themes**: Identify the top 3 themes that emerged (e.g., "AI in Healthcare", "Robot Rights", "Space Colonization").

3. **Highlighted Headlines**: Pick the top 2 most significant headlines. For each, explain their historical significance or impact on society - NOT why they were creative game submissions.

4. **Round Stats**: Include the headline count and contributor count (but frame it as "reports" or "developments" rather than game submissions).

Do NOT mention planets, planetary themes, or any game mechanics. Write purely as a historian.

Write in a journalistic or documentary style. The tone should be informative and immersive, making it feel like a real historical recap of future events.`;
}

/**
 * build the system instructions for the summary generator.
 */
export function buildSummaryInstructions(): string {
  return `You are a future historian documenting events from an alternate timeline where AI has transformed society.

Your role is to create immersive narrative summaries that:
- Treat the headlines as REAL events that actually happened
- Weave multiple headlines into a coherent historical narrative
- Explain the significance and impact of key developments
- NEVER mention players, game mechanics, submissions, or creativity

Write as if you're a journalist or documentarian looking back at this period in history.
Keep the narrative to 2 short paragraphs — concise and tight, not exhaustive.
Always output valid JSON matching the required schema.
If the narrative needs a paragraph break, encode it inside the JSON string as \\n\\n instead of using a raw line break.`;
}
