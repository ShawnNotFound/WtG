import { JsonSchemaDefinition } from '../llm/openaiResponsesClient.js';

export type WorldModelOperation =
  | 'CREATE'
  | 'UPDATE'
  | 'ANSWER'
  | 'INCORPORATE';
export type WorldModelPlanAction = 'CREATE' | 'UPDATE' | 'REUSE' | 'IGNORE';

export interface WorldModelPlanEntity {
  action: WorldModelPlanAction;
  existingNodeId: string;
  expectedRevisionNo: number;
  name: string;
  type: string;
  aliases: string[];
  summary: string;
  summaryDelta: string;
  attributes: Array<{ key: string; value: string }>;
  rationale: string;
  evidence: string[];
  confidence: number;
  novelty: number;
  relevance: number;
  connectionPotential: number;
}

export interface WorldModelOperationPlan {
  coverage: 'SUFFICIENT' | 'MISSING' | 'STALE' | 'NOT_WORLD_FACT';
  rationale: string;
  entities: WorldModelPlanEntity[];
  connectionUpdates: Array<{
    source: string;
    target: string;
    strength: number;
    rationale: string;
  }>;
}

export interface WorldModelCatalogPage {
  id: string;
  name: string;
  type: string;
  aliases: string[];
  summary: string;
  revisionNo: number;
  timesUpdated: number;
  lastContentUpdateAt: string;
  updatePriority: number;
}

export interface WorldModelOperationPromptInput {
  operation: WorldModelOperation;
  query: string;
  inGameNow: string | null;
  catalog: WorldModelCatalogPage[];
  acceptedTimeline: Array<{
    id: string;
    date: string | null;
    text: string;
  }>;
}

const ATTRIBUTE_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['key', 'value'],
    properties: {
      key: { type: 'string' },
      value: { type: 'string' },
    },
  },
  maxItems: 8,
};

export const worldModelOperationJsonSchema: JsonSchemaDefinition = {
  name: 'world_model_operation_plan',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['coverage', 'rationale', 'entities', 'connectionUpdates'],
    properties: {
      coverage: {
        type: 'string',
        enum: ['SUFFICIENT', 'MISSING', 'STALE', 'NOT_WORLD_FACT'],
      },
      rationale: { type: 'string' },
      entities: {
        type: 'array',
        maxItems: 6,
        items: {
          type: 'object',
          additionalProperties: false,
          required: [
            'action',
            'existingNodeId',
            'expectedRevisionNo',
            'name',
            'type',
            'aliases',
            'summary',
            'summaryDelta',
            'attributes',
            'rationale',
            'evidence',
            'confidence',
            'novelty',
            'relevance',
            'connectionPotential',
          ],
          properties: {
            action: {
              type: 'string',
              enum: ['CREATE', 'UPDATE', 'REUSE', 'IGNORE'],
            },
            existingNodeId: { type: 'string' },
            expectedRevisionNo: { type: 'integer', minimum: 0 },
            name: { type: 'string' },
            type: { type: 'string' },
            aliases: {
              type: 'array',
              items: { type: 'string' },
              maxItems: 10,
            },
            summary: { type: 'string' },
            summaryDelta: { type: 'string' },
            attributes: ATTRIBUTE_SCHEMA,
            rationale: { type: 'string' },
            evidence: {
              type: 'array',
              items: { type: 'string' },
              maxItems: 8,
            },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            novelty: { type: 'number', minimum: 0, maximum: 1 },
            relevance: { type: 'number', minimum: 0, maximum: 1 },
            connectionPotential: { type: 'number', minimum: 0, maximum: 1 },
          },
        },
      },
      connectionUpdates: {
        type: 'array',
        maxItems: 16,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['source', 'target', 'strength', 'rationale'],
          properties: {
            source: { type: 'string' },
            target: { type: 'string' },
            strength: { type: 'number', minimum: 0, maximum: 1 },
            rationale: { type: 'string' },
          },
        },
      },
    },
  },
};

const PAGE_FORMAT = `Description
One stable paragraph describing the concrete entity and its role in this game world.

Changes
Recent Changes
Immediate, dated, or query-relevant developments.

Medium-Term Changes
Durable capabilities, commitments, relationships, or pressures.

Long-Term Changes
Very stable identity, structural role, or transformation.`;

export function buildWorldModelOperationInstructions(): string {
  return `You are the conservative page editor for Future Headlines' fictional future encyclopedia.

The database contains current materialized pages plus dated revision history. The relationship graph is only an index that helps retrieve and propagate changes; a page remains the authoritative current description of one concrete actor or actor-like system.

Rules:
1. The player's query identifies an information need. It is NEVER evidence that an asserted event happened. For example, "Did Apple acquire OpenAI?" does not establish an acquisition.
2. Accepted timeline entries are established game-world history. Existing page content is established unless it conflicts with newer accepted history.
3. You may cautiously fill an unstated background fact when necessary to create a missing concrete page and make the fictional world coherent. Label such support in evidence as "inferred world-model context" and keep confidence below 0.85.
4. CREATE only a durable, concrete actor or actor-like system: an organization, government, agency, community, profession, product/platform, model family, laboratory, named movement, or named system.
5. Never create abstract topic pages such as governance, safety, misinformation, labor automation, privacy, trust, regulation, or "the economy". Attach those pressures to concrete pages instead.
6. Reuse an existing page by ID/name/alias whenever it covers the same entity. Do not create spelling, acronym, subsidiary, or renamed duplicates. REUSE is read-only; include a new alias only with a justified UPDATE.
7. ANSWER must never UPDATE an existing page; return REUSE even when it looks stale. Existing pages are revised only by accepted-headline processing or explicit UPDATE/INCORPORATE operations, so a player query cannot influence canonical history. Copy the catalog revisionNo into expectedRevisionNo for allowed updates so a stale plan cannot overwrite a newer page.
8. For CREATE and UPDATE, summary must be the complete current page in exactly this structure, and summaryDelta must briefly state only what changed:
${PAGE_FORMAT}
9. REUSE may return the existing summary. IGNORE is for abstract, ambiguous, irrelevant, or unsafe proposed entities.
10. Connection updates are directed strengths from 0 to 1 and require a concrete information-flow, causal, institutional, legal, technical, market, or social relationship. Never emit self-connections.
11. Return only valid JSON matching the schema.`;
}

export function buildWorldModelOperationPrompt(
  input: WorldModelOperationPromptInput
): string {
  const modeGuidance: Record<WorldModelOperation, string> = {
    ANSWER:
      'Ensure the model has enough coverage to answer the player factually. REUSE established pages and CREATE a genuinely missing concrete page when necessary; never UPDATE an existing page.',
    CREATE:
      'Evaluate the requested page creation. Prefer reuse when an equivalent page or alias already exists.',
    UPDATE:
      'Evaluate which existing pages materially need revision for this request. Do not create unless the named entity is genuinely absent and required.',
    INCORPORATE:
      'Treat the supplied steer as accepted external game-world history and revise/create only the directly necessary pages.',
  };

  return `Operation: ${input.operation}
Operation guidance: ${modeGuidance[input.operation]}
In-game now: ${input.inGameNow ?? 'unknown'}

REQUEST OR EXTERNAL STEER
${input.query}

FULL PAGE CATALOG AND CURRENT PAGE CONTENT
${JSON.stringify(input.catalog, null, 2)}

ACCEPTED TIMELINE (oldest to newest)
${JSON.stringify(input.acceptedTimeline, null, 2)}

Assess coverage first. Return SUFFICIENT with REUSE entries when current pages already cover the request; MISSING when concrete pages are absent; STALE when material page revisions are needed; or NOT_WORLD_FACT for rules, scoring, play advice, abstract topics, and questions that do not require world-model mutation.`;
}
