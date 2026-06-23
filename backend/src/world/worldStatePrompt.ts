import { JsonSchemaDefinition } from '../llm/openaiResponsesClient.js';
import { SeedHeadline } from '../game/seedHeadlines.js';

export interface WorldAttribute {
  key: string;
  value: string;
}

export interface WorldNodeDraft {
  name: string;
  type: string;
  summary: string;
  attributes: WorldAttribute[];
}

export interface WorldEdgeDraft {
  source: string;
  target: string;
  relationType: string;
  summary: string;
  weight: number;
}

export interface InitialWorldStateOutput {
  rationale: string;
  nodes: WorldNodeDraft[];
  edges: WorldEdgeDraft[];
}

export interface WorldNodeUpdateDraft {
  name: string;
  type: string;
  summaryDelta: string;
  updatedSummary: string;
  attributes: WorldAttribute[];
  evidence: string;
}

export interface HeadlineWorldStateUpdateOutput {
  needsNewNodes: boolean;
  impactSummary: string;
  newNodes: WorldNodeDraft[];
  directNodeUpdates: WorldNodeUpdateDraft[];
  cascadeNodeUpdates: WorldNodeUpdateDraft[];
  edges: WorldEdgeDraft[];
}

const ATTRIBUTE_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      key: { type: 'string' },
      value: { type: 'string' },
    },
    required: ['key', 'value'],
    additionalProperties: false,
  },
  maxItems: 8,
};

const NODE_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    type: { type: 'string' },
    summary: { type: 'string' },
    attributes: ATTRIBUTE_SCHEMA,
  },
  required: ['name', 'type', 'summary', 'attributes'],
  additionalProperties: false,
};

const EDGE_SCHEMA = {
  type: 'object',
  properties: {
    source: { type: 'string' },
    target: { type: 'string' },
    relationType: { type: 'string' },
    summary: { type: 'string' },
    weight: { type: 'number', minimum: 0, maximum: 5 },
  },
  required: ['source', 'target', 'relationType', 'summary', 'weight'],
  additionalProperties: false,
};

const NODE_UPDATE_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    type: { type: 'string' },
    summaryDelta: { type: 'string' },
    updatedSummary: { type: 'string' },
    attributes: ATTRIBUTE_SCHEMA,
    evidence: { type: 'string' },
  },
  required: ['name', 'type', 'summaryDelta', 'updatedSummary', 'attributes', 'evidence'],
  additionalProperties: false,
};

export const initialWorldStateJsonSchema: JsonSchemaDefinition = {
  name: 'initial_world_state',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      rationale: { type: 'string' },
      nodes: {
        type: 'array',
        items: NODE_SCHEMA,
        minItems: 8,
        maxItems: 24,
      },
      edges: {
        type: 'array',
        items: EDGE_SCHEMA,
        maxItems: 36,
      },
    },
    required: ['rationale', 'nodes', 'edges'],
    additionalProperties: false,
  },
};

export const headlineWorldStateUpdateJsonSchema: JsonSchemaDefinition = {
  name: 'headline_world_state_update',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      needsNewNodes: { type: 'boolean' },
      impactSummary: { type: 'string' },
      newNodes: {
        type: 'array',
        items: NODE_SCHEMA,
        maxItems: 6,
      },
      directNodeUpdates: {
        type: 'array',
        items: NODE_UPDATE_SCHEMA,
        maxItems: 8,
      },
      cascadeNodeUpdates: {
        type: 'array',
        items: NODE_UPDATE_SCHEMA,
        maxItems: 8,
      },
      edges: {
        type: 'array',
        items: EDGE_SCHEMA,
        maxItems: 14,
      },
    },
    required: [
      'needsNewNodes',
      'impactSummary',
      'newNodes',
      'directNodeUpdates',
      'cascadeNodeUpdates',
      'edges',
    ],
    additionalProperties: false,
  },
};

export function buildWorldStateInstructions(): string {
  return `You maintain the world model for Future Headlines, a collaborative AI-futures timeline game.

Represent the world as a directed acyclic graph of actor entities. Nodes should feel like living participants in the world: organizations, governments, companies, agencies, communities, professions, user groups, products/platforms, model families, laboratories, media outlets, social movements, military units, or named systems that can take actions, react, compete, regulate, adopt, protest, deploy, or influence.

Rules:
1. DO NOT create abstract-topic nodes such as "AI governance", "AI safety", "labor market automation", "synthetic media", "misinformation", "regulation", "public trust", "privacy", or "open-source innovation".
2. Convert abstract topics into actor nodes whenever possible. Example: use "US government", "EU regulators", "OpenAI", "Google DeepMind", "Meta", "Computer Science Students", "Hollywood actors", "Military drone contractors", "Hospital systems", "Public school teachers", "ChatGPT users", "Open-source model developers".
3. Products/platforms can be nodes if they behave like persistent actors in the story world. Example: "ChatGPT", "Gemini", "LLaMA", "AlphaCode", "Watson Health".
4. Store abstract pressure, policy, capability, or risk as node summaries, attributes, or edge summaries, not as standalone nodes.
5. A new node is needed only when the headline introduces a meaningfully new actor or actor-like system not covered by existing nodes.
6. Direct updates are actors explicitly changed by the headline.
7. Cascade updates are actors indirectly affected by those direct changes.
8. Keep summaries short and state-like: what is true now about that actor in this game world.
9. Directed edges should explain dependency, causation, regulation, competition, adoption, funding, backlash, or influence between actors.
10. Avoid cycles. If a relationship could point both ways, choose the strongest causal or temporal direction.
11. Return only JSON matching the schema.`;
}

export function buildInitialWorldStatePrompt(seedHeadlines: SeedHeadline[]): string {
  const history = seedHeadlines
    .map((headline) => `- ${headline.inGameYear}-${String(headline.inGameMonth).padStart(2, '0')}: ${headline.text}`)
    .join('\n');

  return `Create the initial actor-entity world-state DAG for this AI futures case from the historical seed headlines.

The graph should capture the major durable actors and actor-like systems already established before players begin. Keep it compact enough for realtime gameplay.

Good node examples for this case: OpenAI, ChatGPT, Google, Google DeepMind, Meta, IBM Watson Health, Francisco Partners, EU regulators, US Army, United Nations, Hollywood actors, AI artists, computer science students, public markets, open-source model developers, military drone contractors, patients using brain implants.

Bad node examples: AI governance, AI safety, synthetic media, labor automation, misinformation, military AI, healthcare AI. Those are topics, not actors; represent them as summaries, attributes, or relationships attached to actor nodes.

=== CASE HISTORY ===
${history}

Return nodes and directed edges. Node names must be stable actor labels that future headlines can update.`;
}

interface ExistingWorldNode {
  name: string;
  type: string;
  summary: string;
  timesUpdated: number;
}

interface ExistingWorldEdge {
  source: string;
  target: string;
  relationType: string;
  summary: string;
}

export interface HeadlineWorldStatePromptInput {
  headline: string;
  storyDirection: string;
  playerNickname: string;
  roundNo: number;
  inGameSubmittedAt: string | null;
  nodes: ExistingWorldNode[];
  edges: ExistingWorldEdge[];
}

export function buildHeadlineWorldStateUpdatePrompt(input: HeadlineWorldStatePromptInput): string {
  const nodes = input.nodes.length > 0
    ? input.nodes
        .map((node) => `- ${node.name} (${node.type}, updates=${node.timesUpdated}): ${node.summary}`)
        .join('\n')
    : 'No existing nodes yet.';

  const edges = input.edges.length > 0
    ? input.edges
        .map((edge) => `- ${edge.source} -> ${edge.target} [${edge.relationType}]: ${edge.summary}`)
        .join('\n')
    : 'No existing edges yet.';

  return `Update the actor-entity world-state DAG for one accepted player headline.

Treat this headline as accepted game-world history. Decide whether it requires new actor nodes, then identify direct actor updates, cascading actor updates, and directed edges.

Do not add topic nodes such as "AI governance", "AI safety", "misinformation", "automation", or "privacy". If the headline mentions an abstract topic, update the concrete actors involved and put the topic in summaries/attributes/edges.

=== ACCEPTED HEADLINE ===
Displayed headline: ${input.headline}
Original player direction: ${input.storyDirection}
Author: ${input.playerNickname}
Round: ${input.roundNo}
In-game date: ${input.inGameSubmittedAt ?? 'unknown'}

=== CURRENT NODES ===
${nodes}

=== CURRENT EDGES ===
${edges}

Return a concise update plan. Reuse existing node names exactly when possible.`;
}
