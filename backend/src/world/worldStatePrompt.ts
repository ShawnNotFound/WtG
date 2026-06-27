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

export interface DirectNodeEventDraft {
  targetNodeName: string;
  eventId: string;
  eventSummary: string;
  evidence: string;
}

export interface HeadlineWorldStateIntakeOutput {
  needsNewNodes: boolean;
  impactSummary: string;
  newNodes: WorldNodeDraft[];
  directEvents: DirectNodeEventDraft[];
  edges: WorldEdgeDraft[];
}

export interface EmittedNodeEventDraft {
  targetNodeName: string;
  eventSummary: string;
  relationshipRationale: string;
}

export interface EntityReactionOutput {
  affected: boolean;
  confidence: number;
  rationale: string;
  summaryDelta: string;
  updatedSummary: string;
  attributes: WorldAttribute[];
  emittedEvents: EmittedNodeEventDraft[];
  edges: WorldEdgeDraft[];
}

export interface ExistingWorldNode {
  name: string;
  type: string;
  summary: string;
  timesUpdated: number;
}

export interface ExistingWorldEdge {
  source: string;
  target: string;
  relationType: string;
  summary: string;
}

export interface ExistingRelatedWorldNode extends ExistingWorldNode {
  direction: 'outgoing' | 'incoming';
  relationType: string;
  relationSummary: string;
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

const DIRECT_EVENT_SCHEMA = {
  type: 'object',
  properties: {
    targetNodeName: { type: 'string' },
    eventId: { type: 'string' },
    eventSummary: { type: 'string' },
    evidence: { type: 'string' },
  },
  required: ['targetNodeName', 'eventId', 'eventSummary', 'evidence'],
  additionalProperties: false,
};

const EMITTED_EVENT_SCHEMA = {
  type: 'object',
  properties: {
    targetNodeName: { type: 'string' },
    eventSummary: { type: 'string' },
    relationshipRationale: { type: 'string' },
  },
  required: ['targetNodeName', 'eventSummary', 'relationshipRationale'],
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

export const headlineWorldStateIntakeJsonSchema: JsonSchemaDefinition = {
  name: 'headline_world_state_intake',
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
      directEvents: {
        type: 'array',
        items: DIRECT_EVENT_SCHEMA,
        maxItems: 8,
      },
      edges: {
        type: 'array',
        items: EDGE_SCHEMA,
        maxItems: 14,
      },
    },
    required: ['needsNewNodes', 'impactSummary', 'newNodes', 'directEvents', 'edges'],
    additionalProperties: false,
  },
};

export const entityReactionJsonSchema: JsonSchemaDefinition = {
  name: 'entity_reaction',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      affected: { type: 'boolean' },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      rationale: { type: 'string' },
      summaryDelta: { type: 'string' },
      updatedSummary: { type: 'string' },
      attributes: ATTRIBUTE_SCHEMA,
      emittedEvents: {
        type: 'array',
        items: EMITTED_EVENT_SCHEMA,
        maxItems: 8,
      },
      edges: {
        type: 'array',
        items: EDGE_SCHEMA,
        maxItems: 8,
      },
    },
    required: [
      'affected',
      'confidence',
      'rationale',
      'summaryDelta',
      'updatedSummary',
      'attributes',
      'emittedEvents',
      'edges',
    ],
    additionalProperties: false,
  },
};

export function buildWorldStateInstructions(): string {
  return `You maintain the world model for Future Headlines, a collaborative AI-futures timeline game.

Represent the world as a directed cyclic world graph of actor entities. Nodes should feel like living participants in the world: organizations, governments, companies, agencies, communities, professions, user groups, products/platforms, model families, laboratories, media outlets, social movements, military units, or named systems that can take actions, react, compete, regulate, adopt, protest, deploy, or influence.

Rules:
1. DO NOT create abstract-topic nodes such as "AI governance", "AI safety", "labor market automation", "synthetic media", "misinformation", "regulation", "public trust", "privacy", or "open-source innovation".
2. Convert abstract topics into actor nodes whenever possible. Example: use "US government", "EU regulators", "OpenAI", "Google DeepMind", "Meta", "Computer Science Students", "Hollywood actors", "Military drone contractors", "Hospital systems", "Public school teachers", "ChatGPT users", "Open-source model developers".
3. Products/platforms can be nodes if they behave like persistent actors in the story world. Example: "ChatGPT", "Gemini", "LLaMA", "AlphaCode", "Watson Health".
4. Store abstract pressure, policy, capability, or risk as node summaries, attributes, or edge summaries, not as standalone nodes.
5. A new node is needed only when the headline introduces a meaningfully new actor or actor-like system not covered by existing nodes.
6. Directed cycles are allowed when reciprocal influence is real, such as regulator-company, market-supplier, user-platform, or rival-rival feedback.
7. Self-edges are not useful. Do not emit an edge whose source and target are the same actor.
8. Keep summaries short and state-like: what is true now about that actor in this game world.
9. React only when there is a concrete causal, institutional, operational, market, legal, social, or technical reason. Do not create runaway correlation chains.
10. Source nodes may emit events, but receiving nodes decide whether those events affect them.
11. Return only JSON matching the schema.`;
}

export function buildInitialWorldStatePrompt(seedHeadlines: SeedHeadline[]): string {
  const history = seedHeadlines
    .map((headline) => `- ${headline.inGameYear}-${String(headline.inGameMonth).padStart(2, '0')}: ${headline.text}`)
    .join('\n');

  return `Create the initial actor-entity world graph for this AI futures case from the historical seed headlines.

The graph should capture the major durable actors and actor-like systems already established before players begin. Keep it compact enough for realtime gameplay. Directed cycles are allowed when they represent real reciprocal relationships, but self-edges are invalid.

Good node examples for this case: OpenAI, ChatGPT, Google, Google DeepMind, Meta, IBM Watson Health, Francisco Partners, EU regulators, US Army, United Nations, Hollywood actors, AI artists, computer science students, public markets, open-source model developers, military drone contractors, patients using brain implants.

Bad node examples: AI governance, AI safety, synthetic media, labor automation, misinformation, military AI, healthcare AI. Those are topics, not actors; represent them as summaries, attributes, or relationships attached to actor nodes.

=== CASE HISTORY ===
${history}

Return nodes and directed edges. Node names must be stable actor labels that future headlines can update.`;
}

export interface HeadlineWorldStateIntakePromptInput {
  headline: string;
  storyDirection: string;
  playerNickname: string;
  roundNo: number;
  inGameSubmittedAt: string | null;
  nodes: ExistingWorldNode[];
  edges: ExistingWorldEdge[];
}

function formatNodes(nodes: ExistingWorldNode[]): string {
  return nodes.length > 0
    ? nodes
        .map((node) => `- ${node.name} (${node.type}, updates=${node.timesUpdated}): ${node.summary}`)
        .join('\n')
    : 'No existing nodes yet.';
}

function formatEdges(edges: ExistingWorldEdge[]): string {
  return edges.length > 0
    ? edges
        .map((edge) => `- ${edge.source} -> ${edge.target} [${edge.relationType}]: ${edge.summary}`)
        .join('\n')
    : 'No existing edges yet.';
}

export function buildHeadlineWorldStateIntakePrompt(input: HeadlineWorldStateIntakePromptInput): string {
  return `Headline intake stage for the actor-entity world graph.

Treat this headline as accepted game-world history. Your task is limited to:
1. Decide whether meaningfully new actor nodes are needed.
2. Identify the actors directly modified by the headline.
3. Emit direct node events that those actor nodes will evaluate for themselves.
4. Propose obvious direct relationships revealed by the headline.

Do not decide downstream effects. Do not say one actor is changed merely because another actor is changed; the receiving actor's own entity-agent will decide that in the next stage.

Do not add topic nodes such as "AI governance", "AI safety", "misinformation", "automation", or "privacy". If the headline mentions an abstract topic, update the concrete actors involved and put the topic in summaries/attributes/edges.

=== ACCEPTED HEADLINE ===
Displayed headline: ${input.headline}
Original player direction: ${input.storyDirection}
Author: ${input.playerNickname}
Round: ${input.roundNo}
In-game date: ${input.inGameSubmittedAt ?? 'unknown'}

=== CURRENT NODES ===
${formatNodes(input.nodes)}

=== CURRENT EDGES ===
${formatEdges(input.edges)}

Return a concise intake plan. Reuse existing node names exactly when possible. Direct event IDs should be short stable labels such as "direct_1" or "headline_openai_export_rule".`;
}

export interface EntityReactionPromptInput {
  headline: string;
  storyDirection: string;
  playerNickname: string;
  roundNo: number;
  inGameSubmittedAt: string | null;
  node: ExistingWorldNode;
  incomingEvent: {
    sourceNodeName: string | null;
    sourceEventId: string;
    eventSummary: string;
    evidence: string;
    depth: number;
  };
  relatedNodes: ExistingRelatedWorldNode[];
  maxPropagationDepth: number;
}

export function buildEntityReactionPrompt(input: EntityReactionPromptInput): string {
  const related = input.relatedNodes.length > 0
    ? input.relatedNodes
        .map((node) => {
          const direction = node.direction === 'outgoing'
            ? `${input.node.name} -> ${node.name}`
            : `${node.name} -> ${input.node.name}`;
          return `- ${direction} [${node.relationType}]: ${node.relationSummary} | ${node.name} (${node.type}, updates=${node.timesUpdated}): ${node.summary}`;
        })
        .join('\n')
    : 'No related nodes.';

  return `Entity-agent reaction stage for the actor-entity world graph.

You are the agent for this receiving entity:
${input.node.name} (${input.node.type}, updates=${input.node.timesUpdated}): ${input.node.summary}

An event reached this entity. Decide whether this entity is actually affected, and only then update its state. The source node may emit an event, but it cannot force this receiving entity to change.

React only when there is a concrete causal, institutional, operational, market, legal, social, or technical reason. Avoid runaway correlation: do not propagate vague thematic similarity, distant speculation, or "everything affects everything" logic.

If unaffected:
- affected must be false.
- Explain why in rationale.
- Leave summaryDelta empty.
- Return the current summary as updatedSummary.
- Return no emittedEvents unless there is a concrete reason this entity still needs to notify a related node.

If affected:
- affected must be true.
- Provide a concise state delta and updated summary for this entity.
- Emit onward events only to related nodes listed below, and only when that related node should decide for itself whether to react.

=== ACCEPTED HEADLINE CONTEXT ===
Displayed headline: ${input.headline}
Original player direction: ${input.storyDirection}
Author: ${input.playerNickname}
Round: ${input.roundNo}
In-game date: ${input.inGameSubmittedAt ?? 'unknown'}

=== INCOMING EVENT ===
Source node: ${input.incomingEvent.sourceNodeName ?? 'headline intake'}
Source event id: ${input.incomingEvent.sourceEventId}
Depth: ${input.incomingEvent.depth} of max ${input.maxPropagationDepth}
Event: ${input.incomingEvent.eventSummary}
Evidence: ${input.incomingEvent.evidence}

=== RELATED NODES THAT CAN RECEIVE ONWARD EVENTS ===
${related}

Return only this entity's decision and any events it emits to related nodes.`;
}
