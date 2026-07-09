/**
 * juror prompt builder and json schema for the openai responses api.
 * this module builds the prompt for headline evaluation and defines the expected output structure.
 */

import { JsonSchemaDefinition } from '../llm/openaiResponsesClient.js';

export interface HeadlineEntry {
  id?: string;
  text: string;
}

export interface PlanetEntry {
  id: string;
  description: string;
}

export interface JurorPromptInput {
  storyDirection: string;
  headlinesList: HeadlineEntry[] | string[];
  planetList: PlanetEntry[];
}

export type PlausibilityBand = 1 | 2 | 3 | 4 | 5;
export type PlausibilityLabel =
  | 'inevitable'
  | 'probable'
  | 'plausible'
  | 'possible'
  | 'preposterous';
export type LinkStrength = 'STRONG' | 'WEAK';

export interface PlausibilityResult {
  band: PlausibilityBand;
  label: PlausibilityLabel;
  rationale: string;
}

export interface PlanetRanking {
  id: string;
  rank: 1 | 2 | 3;
  rationale: string;
}

export interface PlanetsResult {
  top3: PlanetRanking[];
}

export interface LinkedHeadline {
  headline: string;
  strength: LinkStrength;
  rationale: string;
}

export interface HeadlineBands {
  band1: string;
  band2: string;
  band3: string;
  band4: string;
  band5: string;
}

export interface HeadlinesResult {
  bands: HeadlineBands;
}

export interface JurorEvaluationOutput {
  PLAUSIBILITY: PlausibilityResult;
  PLANETS: PlanetsResult;
  LINKED: LinkedHeadline[];
  HEADLINES: HeadlinesResult;
}

export const BAND_LABELS: Record<PlausibilityBand, PlausibilityLabel> = {
  1: 'inevitable',
  2: 'probable',
  3: 'plausible',
  4: 'possible',
  5: 'preposterous',
};

/**
 * json schema that enforces the structure of the juror evaluation output.
 * used with the openai responses api response_format.
 */
export const jurorJsonSchema: JsonSchemaDefinition = {
  name: 'juror_evaluation',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      PLAUSIBILITY: {
        type: 'object',
        properties: {
          band: {
            type: 'integer',
            enum: [1, 2, 3, 4, 5],
            description:
              'Plausibility band: 1=inevitable, 2=probable, 3=plausible, 4=possible, 5=preposterous',
          },
          label: {
            type: 'string',
            enum: ['inevitable', 'probable', 'plausible', 'possible', 'preposterous'],
          },
          rationale: {
            type: 'string',
            description: 'Brief explanation of why this band was chosen',
          },
        },
        required: ['band', 'label', 'rationale'],
        additionalProperties: false,
      },
      PLANETS: {
        type: 'object',
        properties: {
          top3: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Planet ID from the provided list' },
                rank: { type: 'integer', enum: [1, 2, 3] },
                rationale: { type: 'string' },
              },
              required: ['id', 'rank', 'rationale'],
              additionalProperties: false,
            },
            minItems: 3,
            maxItems: 3,
          },
        },
        required: ['top3'],
        additionalProperties: false,
      },
      LINKED: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            headline: {
              type: 'string',
              description: 'The text of the linked headline from headlines_list',
            },
            strength: { type: 'string', enum: ['STRONG', 'WEAK'] },
            rationale: { type: 'string' },
          },
          required: ['headline', 'strength', 'rationale'],
          additionalProperties: false,
        },
        minItems: 3,
        maxItems: 3,
      },
      HEADLINES: {
        type: 'object',
        properties: {
          bands: {
            type: 'object',
            properties: {
              band1: { type: 'string', description: 'Headline for band 1 (inevitable)' },
              band2: { type: 'string', description: 'Headline for band 2 (probable)' },
              band3: { type: 'string', description: 'Headline for band 3 (plausible)' },
              band4: { type: 'string', description: 'Headline for band 4 (possible)' },
              band5: { type: 'string', description: 'Headline for band 5 (preposterous)' },
            },
            required: ['band1', 'band2', 'band3', 'band4', 'band5'],
            additionalProperties: false,
          },
        },
        required: ['bands'],
        additionalProperties: false,
      },
    },
    required: ['PLAUSIBILITY', 'PLANETS', 'LINKED', 'HEADLINES'],
    additionalProperties: false,
  },
};

/**
 * build the juror prompt from the input data.
 */
export function buildJurorPrompt(input: JurorPromptInput): string {
  const { storyDirection, headlinesList, planetList } = input;

  // format headlines list
  const formattedHeadlines = headlinesList
    .map((h, i) => {
      const text = typeof h === 'string' ? h : h.text;
      const id = typeof h === 'string' ? `headline_${i + 1}` : h.id ?? `headline_${i + 1}`;
      return `- [${id}] ${text}`;
    })
    .join('\n');

  // format planet list
  const formattedPlanets = planetList
    .map((p) => `- ${p.id}: ${p.description}`)
    .join('\n');

  return `You are an assistant for a collaborative story-telling game about the near future of AI developments and their impacts, told through a sequence of dated headlines.

You will be provided with:
1. a story_direction containing a dated proposed development
2. a headlines_list containing previously accepted timeline headlines
3. a planet_list containing planet names and descriptions

Your job is to analyze the story direction and return a JSON object that the game can parse.

There are two important concepts:

1. Plausibility levels
We consider five levels of plausibility of future developments, taking into account the date of the story direction, what has already happened in the timeline, and the likely pace of AI progress, scientific development, deployment, regulation, and social change. The levels are:
- P1 = inevitable
- P2 = probable
- P3 = plausible
- P4 = possible
- P5 = preposterous

2. Planetary alignments
You must classify which three planets from the provided planet_list best match the current story direction, based on the planet descriptions.

=== PLANET LIST ===
${formattedPlanets}

=== HEADLINES LIST (Timeline so far) ===
${formattedHeadlines}

=== STORY DIRECTION (New headline to evaluate) ===
${storyDirection}

=== YOUR TASKS ===

Task 1 — Plausibility classification
Classify the provided story_direction into exactly one plausibility band: P1, P2, P3, P4, or P5.
Use a strict, objective epistemic scale:
- P1 inevitable: overwhelmingly expected by that date; would be more surprising not to happen
- P2 probable: more likely than not by that date
- P3 plausible: credible and well within the range of realistic outcomes by that date
- P4 possible: not the baseline expectation, but still a serious possibility
- P5 preposterous: would require extremely surprising breakthroughs, cascades, or consequences by that date

When choosing the plausibility level, explicitly take into account:
- the date in the story direction
- the likely timeline of AI development
- the likely pace of adoption, regulation, and social response
- whether the claim is about capability, deployment, impact, or public interpretation
- the previously accepted headlines in headlines_list

Task 2 — Planet classification
Considering the planet_list and the description of each planet, identify the three planets that this story direction most closely associates with. Rank them 1 to 3 and give a brief rationale for each.

Task 3 — Link headlines
Reviewing the headlines_list, identify the three headlines that link most closely to the current story direction.
For each linked headline, state:
- the headline text
- whether the connection is STRONG or WEAK
- a brief rationale for the connection

Task 4 — Generate five headline variations
Generate five newspaper-style headline variations inspired by the provided story_direction:
- one headline for P1
- one headline for P2
- one headline for P3
- one headline for P4
- one headline for P5

These five headlines must represent different realizations of the same core story direction, varying in:
- pace of progress
- scale of impact
- degree of verification
- degree of institutional acceptance
- novelty of capability or use
- how surprising the development is

Important headline rules:
- Write in newspaper-headline style. If necessary use a second sentence for clarity.
- Keep them vivid, specific, and readable
- They should feel like plausible headlines from the relevant future date
- Do not make all five headlines simple paraphrases
- The five headlines should become progressively more surprising from P1 to P5
- You do not need to stick too tightly to the exact wording of the story direction; use it as inspiration, especially for P4 and P5
- However, all five headlines should still clearly relate to the same underlying story direction
- Avoid quotation marks unless they add real value
- Do not include explanatory text inside the headline strings

If helpful to you, please discuss your reasoning before you complete these tasks, but end your output with a JSON structure with all the required elements using these keys: PLAUSIBILITY, PLANETS, LINKED, HEADLINES.`;
}

/**
 * build the system instructions for the juror.
 */
export function buildJurorInstructions(): string {
  return `You are a game juror evaluating story directions for a collaborative AI futures game. You must:
1. Be objective and consistent in plausibility assessments, accounting for the date and existing timeline context
2. Rank planet alignments based on thematic fit with the story direction
3. Generate five headline variations that become progressively more surprising from P1 to P5
4. You may discuss your reasoning before outputting JSON, but always end with valid JSON`;
}

