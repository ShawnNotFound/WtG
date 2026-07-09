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

export interface WorldConnectionDraft {
  source: string;
  target: string;
  strength: number;
  rationale: string;
}

export interface InitialWorldStateOutput {
  rationale: string;
  nodes: WorldNodeDraft[];
  connectionUpdates: WorldConnectionDraft[];
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
  connectionUpdates: WorldConnectionDraft[];
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
  connectionUpdates: WorldConnectionDraft[];
}

export interface NodeCatalogEntry {
  id: string;
  name: string;
  type: string;
  timesUpdated: number;
}

export interface ExistingWorldNode {
  id?: string;
  name: string;
  type: string;
  summary: string;
  timesUpdated: number;
}

export interface ExistingWorldConnection {
  id?: string;
  source: string;
  target: string;
  strength: number;
  rationale: string;
}

export interface ExistingRelatedWorldNode extends ExistingWorldNode {
  direction: 'outgoing' | 'incoming';
  connectionStrength: number;
  connectionRationale: string;
}

export interface NodePickerOutput {
  rationale: string;
  confidence: number;
  relevantNodes: Array<{
    nodeId: string;
    nodeName: string;
    rationale: string;
  }>;
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

const CONNECTION_UPDATE_SCHEMA = {
  type: 'object',
  properties: {
    source: { type: 'string' },
    target: { type: 'string' },
    strength: { type: 'number', minimum: 0, maximum: 1 },
    rationale: { type: 'string' },
  },
  required: ['source', 'target', 'strength', 'rationale'],
  additionalProperties: false,
};

const NODE_DETAIL_FORMAT = `Description
One stable paragraph describing what this entity is in the game world. This should rarely change.

Changes
Recent Changes
Concrete immediate changes from the newest relevant event. This can change frequently.

Medium-Term Changes
Durable patterns, commitments, capabilities, relationships, or pressures that survived beyond a single event. Change this less often.

Long-Term Changes
Very stable identity, structural role, strategic position, or long-running transformation. Change this only when the entity has fundamentally evolved.`;

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
      connectionUpdates: {
        type: 'array',
        items: CONNECTION_UPDATE_SCHEMA,
        maxItems: 80,
      },
    },
    required: ['rationale', 'nodes', 'connectionUpdates'],
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
      connectionUpdates: {
        type: 'array',
        items: CONNECTION_UPDATE_SCHEMA,
        maxItems: 24,
      },
    },
    required: ['needsNewNodes', 'impactSummary', 'newNodes', 'directEvents', 'connectionUpdates'],
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
      connectionUpdates: {
        type: 'array',
        items: CONNECTION_UPDATE_SCHEMA,
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
      'connectionUpdates',
    ],
    additionalProperties: false,
  },
};

export const nodePickerJsonSchema: JsonSchemaDefinition = {
  name: 'world_node_picker',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      rationale: { type: 'string' },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      relevantNodes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            nodeId: { type: 'string' },
            nodeName: { type: 'string' },
            rationale: { type: 'string' },
          },
          required: ['nodeId', 'nodeName', 'rationale'],
          additionalProperties: false,
        },
        maxItems: 20,
      },
    },
    required: ['rationale', 'confidence', 'relevantNodes'],
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
7. Self-connections are not useful. Do not emit a connection update whose source and target are the same actor.
8. Every node summary must use this exact structured detail format:
${NODE_DETAIL_FORMAT}
9. Preserve the Description block unless the entity's identity or durable role truly changed. Put most new event-specific information in Recent Changes. Promote only persistent patterns into Medium-Term Changes or Long-Term Changes.
10. React only when there is a concrete causal, institutional, operational, market, legal, social, or technical reason. Do not create runaway correlation chains.
11. Source nodes may emit events, but receiving nodes decide whether those events affect them.
12. Connection strength is a directed 0 to 1 value: 0 means no known practical connection; 1 means the target is almost certain to receive important changes from the source.
13. Return only JSON matching the schema.`;
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

Return nodes and directed connection-strength updates. Node names must be stable actor labels that future headlines can update.`;
}

export interface HeadlineWorldStateIntakePromptInput {
  headline: string;
  storyDirection: string;
  playerNickname: string;
  roundNo: number;
  inGameSubmittedAt: string | null;
  nodeCatalog: NodeCatalogEntry[];
  contextNodes: ExistingWorldNode[];
  contextConnections: ExistingWorldConnection[];
}

function formatNodeCatalog(nodes: NodeCatalogEntry[]): string {
  return nodes.length > 0
    ? nodes
        .map((node) => `- ${node.id}: ${node.name} (${node.type}, updates=${node.timesUpdated})`)
        .join('\n')
    : 'No existing nodes yet.';
}

function indentBlock(value: string): string {
  return value
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}

function formatNodes(nodes: ExistingWorldNode[]): string {
  return nodes.length > 0
    ? nodes
        .map((node) => `- ${node.name} (${node.type}, updates=${node.timesUpdated})\n${indentBlock(node.summary)}`)
        .join('\n')
    : 'No existing nodes yet.';
}

function formatConnections(connections: ExistingWorldConnection[]): string {
  return connections.length > 0
    ? connections
        .map((connection) => `- ${connection.source} -> ${connection.target} strength=${connection.strength.toFixed(2)}: ${connection.rationale}`)
        .join('\n')
    : 'No selected connections yet.';
}

export function buildNodePickerPrompt(input: {
  purpose: 'headline_intake' | 'world_helper';
  query: string;
  nodeCatalog: NodeCatalogEntry[];
  maxSelections: number;
}): string {
  return `Select the existing actor nodes that are most relevant for a bounded world-state context slice.

You receive only the node catalog, not full state. Pick nodes directly involved in the query or likely needed as anchors for weighted-neighborhood retrieval. Prefer concrete actor nodes over vague topical matches. Return at most ${input.maxSelections} nodes.

Purpose: ${input.purpose}

=== QUERY ===
${input.query}

=== NODE CATALOG ===
${formatNodeCatalog(input.nodeCatalog)}

Return only existing node IDs/names from the catalog.`;
}

export function buildHeadlineWorldStateIntakePrompt(input: HeadlineWorldStateIntakePromptInput): string {
  return `Headline intake stage for the actor-entity world graph.

Treat this headline as accepted game-world history. Your task is limited to:
1. Decide whether meaningfully new actor nodes are needed.
2. Identify the actors directly modified by the headline.
3. Emit direct node events that those actor nodes will evaluate for themselves.
4. Propose direct connection-strength updates revealed by the headline.

Do not decide downstream effects. Do not say one actor is changed merely because another actor is changed; the receiving actor's own entity-agent will decide that in the next stage.

Do not add topic nodes such as "AI governance", "AI safety", "misinformation", "automation", or "privacy". If the headline mentions an abstract topic, update the concrete actors involved and put the topic in summaries, attributes, or connection rationales.

For any new node summary, use the structured node detail format exactly:
${NODE_DETAIL_FORMAT}

=== ACCEPTED HEADLINE ===
Displayed headline: ${input.headline}
Original player direction: ${input.storyDirection}
Author: ${input.playerNickname}
Round: ${input.roundNo}
In-game date: ${input.inGameSubmittedAt ?? 'unknown'}

=== NODE CATALOG (names only; use exact names when reusing nodes) ===
${formatNodeCatalog(input.nodeCatalog)}

=== SELECTED NODE STATE CONTEXT ===
${formatNodes(input.contextNodes)}

=== SELECTED CONNECTION CONTEXT ===
${formatConnections(input.contextConnections)}

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
          return `- ${direction} strength=${node.connectionStrength.toFixed(2)}: ${node.connectionRationale}
  ${node.name} (${node.type}, updates=${node.timesUpdated})
${indentBlock(node.summary)}`;
        })
        .join('\n')
    : 'No related nodes.';

  return `Entity-agent reaction stage for the actor-entity world graph.

You are the agent for this receiving entity:
${input.node.name} (${input.node.type}, updates=${input.node.timesUpdated})
${indentBlock(input.node.summary)}

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
- updatedSummary must be the full structured node detail, not only the delta.
- Keep Description stable unless the entity's identity or durable role truly changed.
- Put the newest event-specific facts in Recent Changes.
- Change Medium-Term Changes only for durable patterns, capabilities, commitments, or relationships.
- Change Long-Term Changes only for stable structural transformations.
- Emit onward events only to related nodes listed below, and only when that related node should decide for itself whether to react.
- Propose connection-strength updates only when this event concretely changes how strongly one actor should receive information or pressure from another actor.

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
