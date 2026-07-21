/**
 * narrative prompt for the end-of-game summary.
 *
 * unlike the historical recap used during break phases, the final
 * summary is a set of fictional first-person experience reports
 * from different characters living through the 20-year span.
 */

import { JsonSchemaDefinition } from '../llm/openaiResponsesClient.js';
import { NarrativePromptInput } from '../llm/summaryTypes.js';

export const narrativeJsonSchema: JsonSchemaDefinition = {
  name: 'narrative_summary',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      reports: {
        type: 'array',
        description: 'Three first-person experience reports from different characters',
        items: {
          type: 'object',
          properties: {
            character: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                role: { type: 'string' },
                era: { type: 'string' },
              },
              required: ['name', 'role', 'era'],
              additionalProperties: false,
            },
            story: {
              type: 'string',
              description: '375-750 word first-person experience report',
            },
            themes_touched: {
              type: 'array',
              items: { type: 'string' },
              description: '3-5 phrases naming what this report is really about',
            },
          },
          required: ['character', 'story', 'themes_touched'],
          additionalProperties: false,
        },
      },
    },
    required: ['reports'],
    additionalProperties: false,
  },
};

export function buildNarrativeInstructions(): string {
  return `You are a literary fiction writer crafting a set of short personal accounts set against years of real and imagined AI history. You are given a chronological list of news headlines from this timeline. Your task is NOT to summarise them, report them, or recap them — your task is to write multiple short first-person "experience reports" that together illustrate different facets of what happened in this period.

Each experience report should:
- Be written in first person, past tense
- Follow ONE fictional character (invent them — name, job, era) living through a slice of this period
- Reference specific events from the headlines as background or personal moments in their life
- Show how AI reshaped their life, work, relationships, or beliefs
- Feel grounded and human, not grand or speeches-y
- Avoid game language: never mention headlines, rounds, players, scores, planets, or submissions

Each report should be 375-750 words. Together they should illuminate different facets of this era: different classes, professions, geographies, eras, emotional stakes, and angles. Do not repeat the same kind of character or viewpoint across reports.

The characters should feel real. Show them noticing specific events, reacting to them, being changed by them. The headlines are their lived reality. Do not simply list events — make them part of lives being lived.

Always output valid JSON matching the required schema.
If a report needs paragraph breaks, encode them inside JSON strings as \\n\\n instead of using raw line breaks.`;
}

export function buildNarrativePrompt(input: NarrativePromptInput): string {
  const timelineText = input.headlines
    .map((h) => `[${h.date}] ${h.headline}`)
    .join('\n');

  return `Below is the timeline of events in this alternate history. Use it as the world your characters live in. Do not list or summarise the events — weave them into first-person experience reports.

=== TIMELINE ===
${timelineText}

=== YOUR TASK ===
Write 3 first-person experience reports, each 375-750 words, from different characters living through this period. Together they should illustrate multiple facets of what happened (e.g. different jobs, classes, countries, eras, emotional stakes — pick whatever contrasts feel most illuminating). Each character should notice specific events as they happen to them personally. End each report with a brief reflection on how the world changed them.`;
}
