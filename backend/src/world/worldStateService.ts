import { PoolClient } from 'pg';
import pool from '../db/pool.js';
import { createJsonModelClient, getJsonProviderConfig, JsonModelClient } from '../llm/jsonModelClient.js';
import { getSessionLlmSelection } from '../llm/sessionLlmConfig.js';
import { SEED_HEADLINES } from '../game/seedHeadlines.js';
import {
  buildEntityReactionPrompt,
  buildHeadlineWorldStateIntakePrompt,
  buildInitialWorldStatePrompt,
  buildWorldStateInstructions,
  EntityReactionOutput,
  entityReactionJsonSchema,
  ExistingRelatedWorldNode,
  headlineWorldStateIntakeJsonSchema,
  HeadlineWorldStateIntakeOutput,
  InitialWorldStateOutput,
  initialWorldStateJsonSchema,
  WorldAttribute,
  WorldEdgeDraft,
  WorldNodeDraft,
} from './worldStatePrompt.js';

type WorldStateJobKind = 'initial' | 'headline' | 'manual';
type WorldStateJobStatus = 'queued' | 'running' | 'completed' | 'error';
type ReactionStatus = 'affected' | 'unaffected' | 'skipped' | 'error';

const INITIAL_GRAPH_WAIT_INTERVAL_MS = 1000;
const INITIAL_GRAPH_WAIT_TIMEOUT_MS = 10 * 60 * 1000;

export interface WorldStatePropagationConfig {
  enabled: boolean;
  allowCycles: boolean;
  maxPropagationDepth: number;
  maxNodeReactions: number;
  maxEventsPerNode: number;
  nodeAgentConcurrency: number;
  storeUnaffectedDecisions: boolean;
}

export const DEFAULT_WORLD_STATE_CONFIG: WorldStatePropagationConfig = {
  enabled: true,
  allowCycles: true,
  maxPropagationDepth: 2,
  maxNodeReactions: 20,
  maxEventsPerNode: 2,
  nodeAgentConcurrency: 4,
  storeUnaffectedDecisions: true,
};

interface WorldStateJobRow {
  id: string;
  session_id: string;
  headline_id: string | null;
  kind: WorldStateJobKind;
  status?: WorldStateJobStatus;
  headline_text: string | null;
  input_snapshot: Record<string, unknown>;
}

interface HeadlineUpdateJobInput {
  sessionId: string;
  headlineId: string;
  headlineText: string;
  storyDirection: string;
  playerNickname: string;
  roundNo: number;
  inGameSubmittedAt: string | null;
}

interface UpsertCounts {
  nodesCreated: number;
  nodesUpdated: number;
  edgesCreated: number;
  edgesUpdated: number;
  selfEdgesSkipped: number;
  edgesRejected: number;
}

interface AffectedWorldNode {
  id: string;
  name: string;
  depth: 1 | 2 | 3;
  role: 'new' | 'direct' | 'cascade' | 'related';
}

interface HeadlineUpsertResult extends UpsertCounts {
  affectedNodes: AffectedWorldNode[];
}

interface GraphSnapshotNode {
  id: string;
  name: string;
  type: string;
  summary: string;
  timesUpdated: number;
}

interface GraphSnapshotEdge {
  id: string;
  source: string;
  target: string;
  relationType: string;
  summary: string;
}

interface AdminGraphSnapshotNode {
  id: string;
  name: string;
  type: string;
  summary: string;
  attributes: Record<string, unknown>;
  timesUpdated: number;
  updatedAt: string;
}

interface AdminGraphSnapshotEdge {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  sourceName: string;
  targetName: string;
  relationType: string;
  summary: string;
  weight: number;
  timesUpdated: number;
  updatedAt: string;
}

interface NodeRecord extends GraphSnapshotNode {
  attributes?: Record<string, unknown>;
}

interface RelatedNodeRecord extends ExistingRelatedWorldNode {
  id: string;
}

interface PropagationEvent {
  id: string;
  sourceEventId: string;
  sourceNodeId: string | null;
  sourceNodeName: string | null;
  targetNodeId: string;
  targetNodeName: string;
  eventSummary: string;
  evidence: string;
  depth: number;
}

interface PropagationStats {
  decisionsTotal: number;
  affectedCount: number;
  unaffectedCount: number;
  skippedCount: number;
  errorCount: number;
  emittedEventCount: number;
  depthReached: number;
  cappedReason: string | null;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
  models: string[];
}

interface PropagationRunResult extends HeadlineUpsertResult {
  propagationSummary: Omit<PropagationStats, 'usage' | 'models'> & {
    usage: PropagationStats['usage'];
    models: string[];
  };
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function cleanText(value: unknown, fallback = '', maxLength = 1000): string {
  if (typeof value !== 'string') return fallback;
  const cleaned = value.replace(/\s+/g, ' ').trim();
  return cleaned.length > maxLength ? cleaned.slice(0, maxLength) : cleaned;
}

function cleanName(value: unknown): string {
  return cleanText(value, 'Unknown entity', 120);
}

function cleanType(value: unknown): string {
  return cleanText(value, 'entity', 80).toLowerCase();
}

function cleanRelationType(value: unknown): string {
  const cleaned = cleanText(value, 'RELATED_TO', 80)
    .replace(/[^a-zA-Z0-9_ -]/g, '')
    .replace(/\s+/g, '_')
    .toUpperCase();
  return cleaned || 'RELATED_TO';
}

function cleanEventId(value: unknown, fallback: string): string {
  const cleaned = cleanText(value, fallback, 120)
    .replace(/[^a-zA-Z0-9:_-]/g, '_')
    .replace(/_+/g, '_');
  return cleaned || fallback;
}

function attributesToRecord(attributes: WorldAttribute[] | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const attribute of attributes ?? []) {
    const key = cleanText(attribute.key, '', 80);
    const value = cleanText(attribute.value, '', 500);
    if (key && value) {
      result[key] = value;
    }
  }
  return result;
}

function mergeAttributes(current: unknown, patch: Record<string, string>): Record<string, unknown> {
  const currentRecord =
    current && typeof current === 'object' && !Array.isArray(current)
      ? (current as Record<string, unknown>)
      : {};
  return { ...currentRecord, ...patch };
}

function parseNumberConfig(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.round(clampNumber(number, min, max));
}

export function normalizeWorldStateConfig(config: unknown): WorldStatePropagationConfig {
  const source = config && typeof config === 'object'
    ? (config as Partial<WorldStatePropagationConfig>)
    : {};

  return {
    enabled: source.enabled !== false,
    allowCycles: source.allowCycles !== false,
    maxPropagationDepth: parseNumberConfig(
      source.maxPropagationDepth,
      DEFAULT_WORLD_STATE_CONFIG.maxPropagationDepth,
      0,
      8
    ),
    maxNodeReactions: parseNumberConfig(
      source.maxNodeReactions,
      DEFAULT_WORLD_STATE_CONFIG.maxNodeReactions,
      1,
      200
    ),
    maxEventsPerNode: parseNumberConfig(
      source.maxEventsPerNode,
      DEFAULT_WORLD_STATE_CONFIG.maxEventsPerNode,
      1,
      20
    ),
    nodeAgentConcurrency: parseNumberConfig(
      source.nodeAgentConcurrency,
      DEFAULT_WORLD_STATE_CONFIG.nodeAgentConcurrency,
      1,
      16
    ),
    storeUnaffectedDecisions: source.storeUnaffectedDecisions !== false,
  };
}

function isWorldStateEnabled(config: unknown): boolean {
  return normalizeWorldStateConfig(config).enabled;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function emptyCounts(): UpsertCounts {
  return {
    nodesCreated: 0,
    nodesUpdated: 0,
    edgesCreated: 0,
    edgesUpdated: 0,
    selfEdgesSkipped: 0,
    edgesRejected: 0,
  };
}

function mergeCounts(target: UpsertCounts, patch: UpsertCounts): void {
  target.nodesCreated += patch.nodesCreated;
  target.nodesUpdated += patch.nodesUpdated;
  target.edgesCreated += patch.edgesCreated;
  target.edgesUpdated += patch.edgesUpdated;
  target.selfEdgesSkipped += patch.selfEdgesSkipped;
  target.edgesRejected += patch.edgesRejected;
}

function addAffectedNode(
  affectedNodes: AffectedWorldNode[],
  node: AffectedWorldNode
): void {
  const existing = affectedNodes.find((entry) => entry.id === node.id);
  if (!existing) {
    affectedNodes.push(node);
    return;
  }

  if (node.depth < existing.depth) {
    existing.depth = node.depth;
    existing.role = node.role;
  }
}

function highlightDepthForEventDepth(depth: number): 1 | 2 | 3 {
  if (depth <= 0) return 1;
  if (depth === 1) return 2;
  return 3;
}

function affectedNamesFromIntake(output: HeadlineWorldStateIntakeOutput) {
  return {
    direct: [
      ...output.newNodes.map((node) => cleanName(node.name)),
      ...output.directEvents.map((event) => cleanName(event.targetNodeName)),
    ],
    cascade: [],
    related: output.edges.flatMap((edge) => [cleanName(edge.source), cleanName(edge.target)]),
  };
}

function addUsage(stats: PropagationStats, model: string, usage?: { inputTokens: number; outputTokens: number }): void {
  if (!stats.models.includes(model)) {
    stats.models.push(model);
  }
  if (usage) {
    stats.usage.inputTokens += usage.inputTokens ?? 0;
    stats.usage.outputTokens += usage.outputTokens ?? 0;
  }
}

async function getWorldClient(sessionId: string): Promise<JsonModelClient> {
  const selection = await getSessionLlmSelection(sessionId);
  const config = getJsonProviderConfig('WORLD', selection);
  return createJsonModelClient(config);
}

async function getSessionWorldStateConfig(sessionId: string): Promise<WorldStatePropagationConfig | null> {
  const result = await pool.query(
    `SELECT world_state_config FROM game_sessions WHERE id = $1`,
    [sessionId]
  );
  if (!result?.rows?.length) {
    return null;
  }
  return normalizeWorldStateConfig(result.rows[0].world_state_config);
}

async function isSessionWorldStateEnabled(sessionId: string): Promise<boolean> {
  const config = await getSessionWorldStateConfig(sessionId);
  return config ? isWorldStateEnabled(config) : false;
}

async function loadGraphSnapshot(sessionId: string): Promise<{
  nodes: GraphSnapshotNode[];
  edges: GraphSnapshotEdge[];
}> {
  const nodeResult = await pool.query(
    `SELECT id, name, type, summary, times_updated
     FROM world_state_nodes
     WHERE session_id = $1
     ORDER BY times_updated DESC, updated_at DESC
     LIMIT 60`,
    [sessionId]
  );

  const edgeResult = await pool.query(
    `SELECT
       e.id,
       source.name AS source,
       target.name AS target,
       e.relation_type,
       e.summary
     FROM world_state_edges e
     JOIN world_state_nodes source ON source.id = e.source_node_id
     JOIN world_state_nodes target ON target.id = e.target_node_id
     WHERE e.session_id = $1
     ORDER BY e.times_updated DESC, e.updated_at DESC
     LIMIT 100`,
    [sessionId]
  );

  return {
    nodes: nodeResult.rows.map((row) => ({
      id: row.id,
      name: row.name,
      type: row.type,
      summary: row.summary,
      timesUpdated: row.times_updated,
    })),
    edges: edgeResult.rows.map((row) => ({
      id: row.id,
      source: row.source,
      target: row.target,
      relationType: row.relation_type,
      summary: row.summary,
    })),
  };
}

async function loadAdminGraphSnapshot(sessionId: string): Promise<{
  nodes: AdminGraphSnapshotNode[];
  edges: AdminGraphSnapshotEdge[];
}> {
  const [nodesResult, edgesResult] = await Promise.all([
    pool.query(
      `SELECT id, name, type, summary, attributes, times_updated, updated_at
       FROM world_state_nodes
       WHERE session_id = $1
       ORDER BY name ASC`,
      [sessionId]
    ),
    pool.query(
      `SELECT
         e.id,
         e.source_node_id,
         e.target_node_id,
         source.name AS source_name,
         target.name AS target_name,
         e.relation_type,
         e.summary,
         e.weight,
         e.times_updated,
         e.updated_at
       FROM world_state_edges e
       JOIN world_state_nodes source ON source.id = e.source_node_id
       JOIN world_state_nodes target ON target.id = e.target_node_id
       WHERE e.session_id = $1
       ORDER BY source.name ASC, target.name ASC, e.relation_type ASC`,
      [sessionId]
    ),
  ]);

  return {
    nodes: nodesResult.rows.map((row) => ({
      id: row.id,
      name: row.name,
      type: row.type,
      summary: row.summary,
      attributes: row.attributes ?? {},
      timesUpdated: row.times_updated,
      updatedAt: row.updated_at,
    })),
    edges: edgesResult.rows.map((row) => ({
      id: row.id,
      sourceNodeId: row.source_node_id,
      targetNodeId: row.target_node_id,
      sourceName: row.source_name,
      targetName: row.target_name,
      relationType: row.relation_type,
      summary: row.summary,
      weight: row.weight,
      timesUpdated: row.times_updated,
      updatedAt: row.updated_at,
    })),
  };
}

async function loadNodeById(sessionId: string, nodeId: string): Promise<NodeRecord | null> {
  const result = await pool.query(
    `SELECT id, name, type, summary, attributes, times_updated
     FROM world_state_nodes
     WHERE session_id = $1 AND id = $2
     LIMIT 1`,
    [sessionId, nodeId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    summary: row.summary,
    attributes: row.attributes ?? {},
    timesUpdated: row.times_updated,
  };
}

async function loadRelatedNodes(sessionId: string, nodeId: string): Promise<RelatedNodeRecord[]> {
  const result = await pool.query(
    `SELECT
       neighbor.id,
       neighbor.name,
       neighbor.type,
       neighbor.summary,
       neighbor.times_updated,
       CASE WHEN e.source_node_id = $2 THEN 'outgoing' ELSE 'incoming' END AS direction,
       e.relation_type,
       e.summary AS relation_summary
     FROM world_state_edges e
     JOIN world_state_nodes neighbor
       ON neighbor.id = CASE
         WHEN e.source_node_id = $2 THEN e.target_node_id
         ELSE e.source_node_id
       END
     WHERE e.session_id = $1
       AND (e.source_node_id = $2 OR e.target_node_id = $2)
     ORDER BY e.times_updated DESC, neighbor.times_updated DESC, neighbor.name ASC
     LIMIT 40`,
    [sessionId, nodeId]
  );

  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    type: row.type,
    summary: row.summary,
    timesUpdated: row.times_updated,
    direction: row.direction === 'incoming' ? 'incoming' : 'outgoing',
    relationType: row.relation_type,
    relationSummary: row.relation_summary,
  }));
}

async function updateJob(
  jobId: string,
  stage: string,
  patch: {
    status?: WorldStateJobStatus;
    result?: Record<string, unknown>;
    error?: string | null;
    completed?: boolean;
  } = {}
): Promise<void> {
  await pool.query(
    `UPDATE world_state_jobs
     SET stage = $1,
         status = COALESCE($2, status),
         result = CASE WHEN $3::jsonb IS NULL THEN result ELSE result || $3::jsonb END,
         error = $4,
         completed_at = CASE WHEN $5 THEN CURRENT_TIMESTAMP ELSE completed_at END
     WHERE id = $6`,
    [
      stage,
      patch.status ?? null,
      patch.result ? JSON.stringify(patch.result) : null,
      patch.error ?? null,
      patch.completed ?? false,
      jobId,
    ]
  );
}

async function createsDirectedLoop(
  client: PoolClient,
  sessionId: string,
  sourceNodeId: string,
  targetNodeId: string
): Promise<boolean> {
  const result = await client.query(
    `WITH RECURSIVE walk(node_id) AS (
       SELECT target_node_id
       FROM world_state_edges
       WHERE session_id = $1 AND source_node_id = $2
       UNION
       SELECT e.target_node_id
       FROM world_state_edges e
       JOIN walk w ON e.source_node_id = w.node_id
       WHERE e.session_id = $1
     )
     SELECT 1
     FROM walk
     WHERE node_id = $3
     LIMIT 1`,
    [sessionId, targetNodeId, sourceNodeId]
  );
  return result.rows.length > 0;
}

async function upsertNode(
  client: PoolClient,
  sessionId: string,
  draft: Pick<WorldNodeDraft, 'name' | 'type' | 'summary' | 'attributes'>,
  headlineId: string | null,
  increment: number
): Promise<{ id: string; name: string; type: string; summary: string; created: boolean }> {
  const name = cleanName(draft.name);
  const type = cleanType(draft.type);
  const summary = cleanText(draft.summary, '', 1200);
  const attributes = attributesToRecord(draft.attributes);

  const existing = await client.query(
    `SELECT id, attributes, summary
     FROM world_state_nodes
     WHERE session_id = $1 AND lower(name) = lower($2)
     FOR UPDATE`,
    [sessionId, name]
  );

  if (existing.rows.length > 0) {
    const row = existing.rows[0];
    const mergedAttributes = mergeAttributes(row.attributes, attributes);
    await client.query(
      `UPDATE world_state_nodes
       SET name = $1,
           type = $2,
           summary = CASE WHEN $3 = '' THEN summary ELSE $3 END,
           attributes = $4,
           times_updated = times_updated + $5,
           last_seen_headline_id = COALESCE($6, last_seen_headline_id)
       WHERE id = $7`,
      [
        name,
        type,
        summary,
        JSON.stringify(mergedAttributes),
        increment,
        headlineId,
        row.id,
      ]
    );
    return { id: row.id, name, type, summary: summary || row.summary || '', created: false };
  }

  const inserted = await client.query(
    `INSERT INTO world_state_nodes
       (session_id, name, type, summary, attributes, times_updated, first_seen_headline_id, last_seen_headline_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
     RETURNING id`,
    [
      sessionId,
      name,
      type,
      summary,
      JSON.stringify(attributes),
      Math.max(0, increment),
      headlineId,
    ]
  );

  return { id: inserted.rows[0].id, name, type, summary, created: true };
}

async function upsertEdge(
  client: PoolClient,
  sessionId: string,
  draft: WorldEdgeDraft,
  headlineId: string | null,
  increment: number,
  allowCycles = true
): Promise<{ created: boolean; selfEdgeSkipped: boolean; rejected: boolean }> {
  const source = await upsertNode(
    client,
    sessionId,
    {
      name: draft.source,
      type: 'entity',
      summary: '',
      attributes: [],
    },
    headlineId,
    0
  );
  const target = await upsertNode(
    client,
    sessionId,
    {
      name: draft.target,
      type: 'entity',
      summary: '',
      attributes: [],
    },
    headlineId,
    0
  );

  if (source.id === target.id) {
    return { created: false, selfEdgeSkipped: true, rejected: false };
  }

  const relationType = cleanRelationType(draft.relationType);
  const summary = cleanText(draft.summary, '', 1000);
  const weight = clampNumber(draft.weight, 0, 5);

  const existing = await client.query(
    `SELECT id
     FROM world_state_edges
     WHERE session_id = $1
       AND source_node_id = $2
       AND target_node_id = $3
       AND lower(relation_type) = lower($4)
     FOR UPDATE`,
    [sessionId, source.id, target.id, relationType]
  );

  if (existing.rows.length > 0) {
    await client.query(
      `UPDATE world_state_edges
       SET summary = CASE WHEN $1 = '' THEN summary ELSE $1 END,
           weight = $2,
           times_updated = times_updated + $3,
           last_seen_headline_id = COALESCE($4, last_seen_headline_id)
       WHERE id = $5`,
      [summary, weight, increment, headlineId, existing.rows[0].id]
    );
    return { created: false, selfEdgeSkipped: false, rejected: false };
  }

  if (!allowCycles && await createsDirectedLoop(client, sessionId, source.id, target.id)) {
    return { created: false, selfEdgeSkipped: false, rejected: true };
  }

  await client.query(
    `INSERT INTO world_state_edges
       (session_id, source_node_id, target_node_id, relation_type, summary, weight, times_updated, first_seen_headline_id, last_seen_headline_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
    [
      sessionId,
      source.id,
      target.id,
      relationType,
      summary,
      weight,
      Math.max(0, increment),
      headlineId,
    ]
  );

  return { created: true, selfEdgeSkipped: false, rejected: false };
}

async function applyInitialGraph(
  sessionId: string,
  output: InitialWorldStateOutput,
  config: WorldStatePropagationConfig
): Promise<UpsertCounts> {
  const client = await pool.connect();
  const counts = emptyCounts();

  try {
    await client.query('BEGIN');

    for (const node of output.nodes) {
      const result = await upsertNode(client, sessionId, node, null, 0);
      if (result.created) counts.nodesCreated++;
      else counts.nodesUpdated++;
    }

    for (const edge of output.edges) {
      const result = await upsertEdge(client, sessionId, edge, null, 0, config.allowCycles);
      if (result.selfEdgeSkipped) counts.selfEdgesSkipped++;
      else if (result.rejected) counts.edgesRejected++;
      else if (result.created) counts.edgesCreated++;
      else counts.edgesUpdated++;
    }

    await client.query('COMMIT');
    return counts;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function applyHeadlineIntake(
  sessionId: string,
  headlineId: string,
  output: HeadlineWorldStateIntakeOutput,
  config: WorldStatePropagationConfig,
  onStage?: (stage: string) => Promise<void>
): Promise<HeadlineUpsertResult & { directEvents: PropagationEvent[] }> {
  const client = await pool.connect();
  const result: HeadlineUpsertResult & { directEvents: PropagationEvent[] } = {
    ...emptyCounts(),
    affectedNodes: [],
    directEvents: [],
  };

  try {
    await client.query('BEGIN');

    await onStage?.('creating_new_actor_nodes');
    for (const node of output.newNodes) {
      const nodeResult = await upsertNode(client, sessionId, node, headlineId, 1);
      if (nodeResult.created) result.nodesCreated++;
      else result.nodesUpdated++;
      addAffectedNode(result.affectedNodes, {
        id: nodeResult.id,
        name: nodeResult.name,
        depth: 1,
        role: 'new',
      });
    }

    await onStage?.('updating_initial_relationships');
    for (const edge of output.edges) {
      const edgeResult = await upsertEdge(client, sessionId, edge, headlineId, 1, config.allowCycles);
      if (edgeResult.selfEdgeSkipped) result.selfEdgesSkipped++;
      else if (edgeResult.rejected) result.edgesRejected++;
      else if (edgeResult.created) result.edgesCreated++;
      else result.edgesUpdated++;
    }

    for (const [index, event] of output.directEvents.entries()) {
      const eventId = cleanEventId(event.eventId, `direct_${index + 1}`);
      const targetNode = await upsertNode(
        client,
        sessionId,
        {
          name: event.targetNodeName,
          type: 'entity',
          summary: '',
          attributes: [],
        },
        headlineId,
        0
      );

      result.directEvents.push({
        id: eventId,
        sourceEventId: eventId,
        sourceNodeId: null,
        sourceNodeName: null,
        targetNodeId: targetNode.id,
        targetNodeName: targetNode.name,
        eventSummary: cleanText(event.eventSummary, '', 1200),
        evidence: cleanText(event.evidence, '', 1200),
        depth: 0,
      });
    }

    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function applyAffectedReaction(
  sessionId: string,
  headlineId: string,
  node: NodeRecord,
  output: EntityReactionOutput,
  config: WorldStatePropagationConfig
): Promise<HeadlineUpsertResult> {
  const client = await pool.connect();
  const result: HeadlineUpsertResult = {
    ...emptyCounts(),
    affectedNodes: [],
  };

  try {
    await client.query('BEGIN');

    const nodeResult = await upsertNode(
      client,
      sessionId,
      {
        name: node.name,
        type: node.type,
        summary: output.updatedSummary || output.summaryDelta || node.summary,
        attributes: [
          ...output.attributes,
          { key: 'last_delta', value: output.summaryDelta },
          { key: 'last_rationale', value: output.rationale },
        ],
      },
      headlineId,
      1
    );
    if (nodeResult.created) result.nodesCreated++;
    else result.nodesUpdated++;

    for (const edge of output.edges) {
      const edgeResult = await upsertEdge(client, sessionId, edge, headlineId, 1, config.allowCycles);
      if (edgeResult.selfEdgeSkipped) result.selfEdgesSkipped++;
      else if (edgeResult.rejected) result.edgesRejected++;
      else if (edgeResult.created) result.edgesCreated++;
      else result.edgesUpdated++;
    }

    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

interface ReactionTraceInput {
  jobId: string;
  sessionId: string;
  headlineId: string | null;
  event: PropagationEvent;
  status: ReactionStatus;
  nodeName?: string;
  confidence?: number | null;
  rationale?: string | null;
  stateDelta?: string | null;
  updatedSummary?: string | null;
  emittedEvents?: unknown[];
  proposedEdges?: unknown[];
  model?: string | null;
  usage?: unknown;
  error?: string | null;
}

async function insertReactionTrace(input: ReactionTraceInput): Promise<void> {
  await pool.query(
    `INSERT INTO world_state_reactions
       (job_id, session_id, headline_id, node_id, node_name, source_node_id, source_node_name,
        source_event_id, event_id, depth, status, confidence, rationale, state_delta,
        updated_summary, emitted_events, proposed_edges, model, usage, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
    [
      input.jobId,
      input.sessionId,
      input.headlineId,
      input.event.targetNodeId,
      input.nodeName ?? input.event.targetNodeName,
      input.event.sourceNodeId,
      input.event.sourceNodeName,
      input.event.sourceEventId,
      input.event.id,
      input.event.depth,
      input.status,
      input.confidence ?? null,
      input.rationale ?? null,
      input.stateDelta ?? null,
      input.updatedSummary ?? null,
      JSON.stringify(input.emittedEvents ?? []),
      JSON.stringify(input.proposedEdges ?? []),
      input.model ?? null,
      JSON.stringify(input.usage ?? {}),
      input.error ?? null,
    ]
  );
}

export interface PropagationGateResult {
  allowed: boolean;
  reason?: 'max_depth' | 'max_node_reactions' | 'max_events_per_node' | 'duplicate';
}

export class PropagationLimiter {
  private visited = new Set<string>();
  private eventCountsByNode = new Map<string, number>();
  private startedReactions = 0;
  cappedReason: string | null = null;

  constructor(private readonly config: WorldStatePropagationConfig) {}

  tryReserve(event: Pick<PropagationEvent, 'sourceEventId' | 'targetNodeId' | 'depth'>): PropagationGateResult {
    if (event.depth > this.config.maxPropagationDepth) {
      return { allowed: false, reason: 'max_depth' };
    }

    if (this.startedReactions >= this.config.maxNodeReactions) {
      this.cappedReason = this.cappedReason ?? 'max_node_reactions';
      return { allowed: false, reason: 'max_node_reactions' };
    }

    const nodeCount = this.eventCountsByNode.get(event.targetNodeId) ?? 0;
    if (nodeCount >= this.config.maxEventsPerNode) {
      return { allowed: false, reason: 'max_events_per_node' };
    }

    const key = `${event.sourceEventId}:${event.targetNodeId}:${event.depth}`;
    if (this.visited.has(key)) {
      return { allowed: false, reason: 'duplicate' };
    }

    this.visited.add(key);
    this.eventCountsByNode.set(event.targetNodeId, nodeCount + 1);
    this.startedReactions++;
    return { allowed: true };
  }
}

async function runLimited<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex++;
        results[index] = await worker(items[index], index);
      }
    })
  );

  return results;
}

async function generateInitialGraph(sessionId: string) {
  const client = await getWorldClient(sessionId);
  return client.callResponsesApi<InitialWorldStateOutput>({
    input: buildInitialWorldStatePrompt(SEED_HEADLINES),
    instructions: buildWorldStateInstructions(),
    jsonSchema: initialWorldStateJsonSchema,
    temperature: 0.2,
  });
}

async function generateHeadlineIntake(job: WorldStateJobRow) {
  const input = job.input_snapshot as unknown as HeadlineUpdateJobInput;
  const snapshot = await loadGraphSnapshot(job.session_id);
  const client = await getWorldClient(job.session_id);

  return client.callResponsesApi<HeadlineWorldStateIntakeOutput>({
    input: buildHeadlineWorldStateIntakePrompt({
      headline: input.headlineText,
      storyDirection: input.storyDirection,
      playerNickname: input.playerNickname,
      roundNo: input.roundNo,
      inGameSubmittedAt: input.inGameSubmittedAt,
      nodes: snapshot.nodes,
      edges: snapshot.edges,
    }),
    instructions: buildWorldStateInstructions(),
    jsonSchema: headlineWorldStateIntakeJsonSchema,
    temperature: 0.15,
  });
}

async function generateEntityReaction(
  client: JsonModelClient,
  input: HeadlineUpdateJobInput,
  node: NodeRecord,
  event: PropagationEvent,
  relatedNodes: RelatedNodeRecord[],
  config: WorldStatePropagationConfig
) {
  return client.callResponsesApi<EntityReactionOutput>({
    input: buildEntityReactionPrompt({
      headline: input.headlineText,
      storyDirection: input.storyDirection,
      playerNickname: input.playerNickname,
      roundNo: input.roundNo,
      inGameSubmittedAt: input.inGameSubmittedAt,
      node,
      incomingEvent: {
        sourceNodeName: event.sourceNodeName,
        sourceEventId: event.sourceEventId,
        eventSummary: event.eventSummary,
        evidence: event.evidence,
        depth: event.depth,
      },
      relatedNodes,
      maxPropagationDepth: config.maxPropagationDepth,
    }),
    instructions: buildWorldStateInstructions(),
    jsonSchema: entityReactionJsonSchema,
    temperature: 0.1,
  });
}

async function processPropagationEvent(
  job: WorldStateJobRow,
  input: HeadlineUpdateJobInput,
  event: PropagationEvent,
  config: WorldStatePropagationConfig,
  stats: PropagationStats,
  aggregate: HeadlineUpsertResult,
  client: JsonModelClient
): Promise<PropagationEvent[]> {
  const node = await loadNodeById(job.session_id, event.targetNodeId);
  if (!node) {
    stats.errorCount++;
    await insertReactionTrace({
      jobId: job.id,
      sessionId: job.session_id,
      headlineId: job.headline_id,
      event,
      status: 'error',
      error: 'Target node no longer exists',
    });
    return [];
  }

  const relatedNodes = await loadRelatedNodes(job.session_id, node.id);

  try {
    const aiResult = await generateEntityReaction(client, input, node, event, relatedNodes, config);
    addUsage(stats, aiResult.model, aiResult.usage);

    const confidence = clampNumber(Number(aiResult.output.confidence ?? 0), 0, 1);
    const affected = aiResult.output.affected === true;
    stats.decisionsTotal++;
    stats.depthReached = Math.max(stats.depthReached, event.depth);

    if (!affected) {
      stats.unaffectedCount++;
      if (config.storeUnaffectedDecisions) {
        await insertReactionTrace({
          jobId: job.id,
          sessionId: job.session_id,
          headlineId: job.headline_id,
          event,
          status: 'unaffected',
          nodeName: node.name,
          confidence,
          rationale: aiResult.output.rationale,
          stateDelta: aiResult.output.summaryDelta,
          updatedSummary: aiResult.output.updatedSummary || node.summary,
          emittedEvents: aiResult.output.emittedEvents,
          proposedEdges: aiResult.output.edges,
          model: aiResult.model,
          usage: aiResult.usage,
        });
      }
      return [];
    }

    stats.affectedCount++;
    const updateCounts = await applyAffectedReaction(job.session_id, job.headline_id!, node, aiResult.output, config);
    mergeCounts(aggregate, updateCounts);
    addAffectedNode(aggregate.affectedNodes, {
      id: node.id,
      name: node.name,
      depth: highlightDepthForEventDepth(event.depth),
      role: event.depth === 0 ? 'direct' : 'cascade',
    });

    await insertReactionTrace({
      jobId: job.id,
      sessionId: job.session_id,
      headlineId: job.headline_id,
      event,
      status: 'affected',
      nodeName: node.name,
      confidence,
      rationale: aiResult.output.rationale,
      stateDelta: aiResult.output.summaryDelta,
      updatedSummary: aiResult.output.updatedSummary,
      emittedEvents: aiResult.output.emittedEvents,
      proposedEdges: aiResult.output.edges,
      model: aiResult.model,
      usage: aiResult.usage,
    });

    const relatedByName = new Map(
      relatedNodes.map((related) => [related.name.toLowerCase(), related])
    );
    const nextDepth = event.depth + 1;

    if (nextDepth > config.maxPropagationDepth) {
      return [];
    }

    const emitted: PropagationEvent[] = [];
    for (const [index, emittedEvent] of aiResult.output.emittedEvents.entries()) {
      const targetName = cleanName(emittedEvent.targetNodeName);
      const target = relatedByName.get(targetName.toLowerCase());
      if (!target || target.id === node.id) {
        continue;
      }

      stats.emittedEventCount++;
      emitted.push({
        id: cleanEventId(
          `${event.sourceEventId}:${node.id.slice(0, 8)}:${target.id.slice(0, 8)}:${nextDepth}:${index + 1}`,
          `prop_${nextDepth}_${index + 1}`
        ),
        sourceEventId: event.sourceEventId,
        sourceNodeId: node.id,
        sourceNodeName: node.name,
        targetNodeId: target.id,
        targetNodeName: target.name,
        eventSummary: cleanText(emittedEvent.eventSummary, '', 1200),
        evidence: cleanText(emittedEvent.relationshipRationale || aiResult.output.rationale, '', 1200),
        depth: nextDepth,
      });
    }

    return emitted;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stats.errorCount++;
    await insertReactionTrace({
      jobId: job.id,
      sessionId: job.session_id,
      headlineId: job.headline_id,
      event,
      status: 'error',
      nodeName: node.name,
      error: message,
    });
    return [];
  }
}

async function applyPropagation(
  job: WorldStateJobRow,
  directEvents: PropagationEvent[],
  config: WorldStatePropagationConfig,
  intakeCounts: HeadlineUpsertResult,
  onStage?: (stage: string) => Promise<void>
): Promise<PropagationRunResult> {
  const input = job.input_snapshot as unknown as HeadlineUpdateJobInput;
  const aggregate: HeadlineUpsertResult = {
    ...emptyCounts(),
    affectedNodes: [...intakeCounts.affectedNodes],
  };
  mergeCounts(aggregate, intakeCounts);

  const stats: PropagationStats = {
    decisionsTotal: 0,
    affectedCount: 0,
    unaffectedCount: 0,
    skippedCount: 0,
    errorCount: 0,
    emittedEventCount: 0,
    depthReached: 0,
    cappedReason: null,
    usage: { inputTokens: 0, outputTokens: 0 },
    models: [],
  };

  const limiter = new PropagationLimiter(config);
  const client = await getWorldClient(job.session_id);
  let frontier = directEvents;

  while (frontier.length > 0) {
    const depth = Math.min(...frontier.map((event) => event.depth));
    await onStage?.(depth === 0 ? 'entity_agent_direct_wave' : `entity_agent_propagation_wave_${depth}`);

    const runnable: PropagationEvent[] = [];
    for (const event of frontier) {
      const gate = limiter.tryReserve(event);
      if (gate.allowed) {
        runnable.push(event);
        continue;
      }

      stats.skippedCount++;
      if (gate.reason === 'max_node_reactions') {
        stats.cappedReason = stats.cappedReason ?? 'max_node_reactions';
      }
      if (config.storeUnaffectedDecisions) {
        await insertReactionTrace({
          jobId: job.id,
          sessionId: job.session_id,
          headlineId: job.headline_id,
          event,
          status: 'skipped',
          rationale: gate.reason ?? 'skipped',
        });
      }
    }

    if (runnable.length === 0) {
      break;
    }

    const emittedGroups = await runLimited(
      runnable,
      config.nodeAgentConcurrency,
      async (event) => processPropagationEvent(job, input, event, config, stats, aggregate, client)
    );

    frontier = emittedGroups.flat();
    if (limiter.cappedReason) {
      stats.cappedReason = stats.cappedReason ?? limiter.cappedReason;
      await onStage?.('propagation_capped');
      break;
    }
  }

  return {
    ...aggregate,
    propagationSummary: {
      decisionsTotal: stats.decisionsTotal,
      affectedCount: stats.affectedCount,
      unaffectedCount: stats.unaffectedCount,
      skippedCount: stats.skippedCount,
      errorCount: stats.errorCount,
      emittedEventCount: stats.emittedEventCount,
      depthReached: stats.depthReached,
      cappedReason: stats.cappedReason,
      usage: stats.usage,
      models: stats.models,
    },
  };
}

export async function getWorldStateForJoinCode(joinCode: string) {
  const sessionResult = await pool.query(
    `SELECT
       s.id,
       s.join_code,
       s.phase,
       s.current_round,
       s.play_minutes,
       s.break_minutes,
       s.max_rounds,
       s.is_paused,
       s.paused_at,
       s.pause_remaining_ms,
       s.timeline_speed_ratio,
       s.llm_config,
       s.world_state_config,
       json_agg(
         json_build_object(
           'id', p.id,
           'nickname', p.nickname,
           'isAi', p.is_ai,
           'aiConfig', p.ai_config,
           'totalScore', p.total_score
         ) ORDER BY p.joined_at
       ) FILTER (WHERE p.id IS NOT NULL) AS players
     FROM game_sessions s
     LEFT JOIN session_players p ON p.session_id = s.id AND p.is_system = FALSE
     WHERE s.join_code = $1
     GROUP BY s.id`,
    [joinCode]
  );

  if (sessionResult.rows.length === 0) {
    return null;
  }

  const session = sessionResult.rows[0];
  const includeAllJobs = session.phase === 'FINISHED';
  const [nodesResult, edgesResult, jobsResult, queueResult] = await Promise.all([
    pool.query(
      `SELECT id, name, type, summary, attributes, times_updated, created_at, updated_at
       FROM world_state_nodes
       WHERE session_id = $1
       ORDER BY times_updated DESC, updated_at DESC, name ASC`,
      [session.id]
    ),
    pool.query(
      `SELECT
         e.id,
         e.source_node_id,
         e.target_node_id,
         source.name AS source_name,
         target.name AS target_name,
         e.relation_type,
         e.summary,
         e.weight,
         e.times_updated,
         e.updated_at
       FROM world_state_edges e
       JOIN world_state_nodes source ON source.id = e.source_node_id
       JOIN world_state_nodes target ON target.id = e.target_node_id
       WHERE e.session_id = $1
       ORDER BY e.times_updated DESC, e.updated_at DESC`,
      [session.id]
    ),
    pool.query(
      `WITH recent_jobs AS (
         SELECT id
         FROM world_state_jobs
         WHERE session_id = $1
         ORDER BY created_at DESC
         LIMIT 60
       )
       SELECT id, headline_id, kind, status, stage, agent, headline_text, result, error,
              created_at, started_at, completed_at, updated_at
       FROM world_state_jobs
       WHERE session_id = $1
         AND ($2::boolean OR status = 'running' OR id IN (SELECT id FROM recent_jobs))
       ORDER BY
         CASE WHEN $2::boolean THEN created_at END ASC,
         CASE WHEN NOT $2::boolean AND status = 'running' THEN 0 ELSE 1 END,
         created_at DESC`,
      [session.id, includeAllJobs]
    ),
    pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'queued')::int AS queued,
         COUNT(*) FILTER (WHERE status = 'running')::int AS running
       FROM world_state_jobs
       WHERE session_id = $1`,
      [session.id]
    ),
  ]);

  const jobIds = jobsResult.rows.map((row) => row.id);
  const reactionsByJob = new Map<string, unknown[]>();
  if (jobIds.length > 0) {
    const reactionsResult = await pool.query(
      `SELECT
         id,
         job_id,
         headline_id,
         node_id,
         node_name,
         source_node_id,
         source_node_name,
         source_event_id,
         event_id,
         depth,
         status,
         confidence,
         rationale,
         state_delta,
         updated_summary,
         emitted_events,
         proposed_edges,
         model,
         usage,
         error,
         created_at
       FROM world_state_reactions
       WHERE job_id = ANY($1::uuid[])
       ORDER BY depth ASC, created_at ASC`,
      [jobIds]
    );

    for (const row of reactionsResult.rows) {
      const current = reactionsByJob.get(row.job_id) ?? [];
      current.push({
        id: row.id,
        headlineId: row.headline_id,
        nodeId: row.node_id,
        nodeName: row.node_name,
        sourceNodeId: row.source_node_id,
        sourceNodeName: row.source_node_name,
        sourceEventId: row.source_event_id,
        eventId: row.event_id,
        depth: row.depth,
        status: row.status,
        confidence: row.confidence,
        rationale: row.rationale,
        stateDelta: row.state_delta,
        updatedSummary: row.updated_summary,
        emittedEvents: row.emitted_events,
        proposedEdges: row.proposed_edges,
        model: row.model,
        usage: row.usage,
        error: row.error,
        createdAt: row.created_at,
      });
      reactionsByJob.set(row.job_id, current);
    }
  }

  return {
    session: {
      id: session.id,
      joinCode: session.join_code,
      phase: session.phase,
      currentRound: session.current_round,
      playMinutes: session.play_minutes,
      breakMinutes: session.break_minutes,
      maxRounds: session.max_rounds,
      isPaused: session.is_paused === true,
      pausedAt: session.paused_at,
      pauseRemainingMs: session.pause_remaining_ms,
      timelineSpeedRatio: session.timeline_speed_ratio,
      llmConfig: session.llm_config,
      worldStateConfig: normalizeWorldStateConfig(session.world_state_config),
      players: session.players ?? [],
    },
    stats: {
      nodeCount: nodesResult.rowCount,
      edgeCount: edgesResult.rowCount,
      queuedJobs: queueResult.rows[0]?.queued ?? 0,
      runningJobs: queueResult.rows[0]?.running ?? 0,
    },
    nodes: nodesResult.rows.map((row) => ({
      id: row.id,
      name: row.name,
      type: row.type,
      summary: row.summary,
      attributes: row.attributes,
      timesUpdated: row.times_updated,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
    edges: edgesResult.rows.map((row) => ({
      id: row.id,
      sourceNodeId: row.source_node_id,
      targetNodeId: row.target_node_id,
      sourceName: row.source_name,
      targetName: row.target_name,
      relationType: row.relation_type,
      summary: row.summary,
      weight: row.weight,
      timesUpdated: row.times_updated,
      updatedAt: row.updated_at,
    })),
    jobs: jobsResult.rows.map((row) => ({
      id: row.id,
      headlineId: row.headline_id,
      kind: row.kind,
      status: row.status,
      stage: row.stage,
      agent: row.agent,
      headlineText: row.headline_text,
      result: row.result,
      error: row.error,
      reactions: reactionsByJob.get(row.id) ?? [],
      createdAt: row.created_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      updatedAt: row.updated_at,
    })),
  };
}

export class WorldStateProcessor {
  async startQueuedJobs(): Promise<number> {
    const result = await pool.query(
      `UPDATE world_state_jobs
       SET status = 'running',
           stage = CASE
             WHEN kind = 'initial' THEN 'building_initial_actor_graph'
             ELSE 'headline_intake_agent'
           END,
           started_at = COALESCE(started_at, CURRENT_TIMESTAMP)
       WHERE status = 'queued'
       RETURNING id, session_id, headline_id, kind, status, headline_text, input_snapshot`
    );

    for (const job of result.rows as WorldStateJobRow[]) {
      this.startJob(job);
    }

    return result.rowCount ?? 0;
  }

  async enqueueInitialBuild(sessionId: string): Promise<string | null> {
    if (!(await isSessionWorldStateEnabled(sessionId))) {
      return null;
    }

    const existing = await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM world_state_nodes WHERE session_id = $1) AS nodes,
         (SELECT COUNT(*)::int FROM world_state_jobs WHERE session_id = $1 AND kind = 'initial' AND status IN ('running', 'completed')) AS jobs`,
      [sessionId]
    );

    if ((existing.rows[0]?.nodes ?? 0) > 0 || (existing.rows[0]?.jobs ?? 0) > 0) {
      return null;
    }

    const result = await pool.query(
      `INSERT INTO world_state_jobs
         (session_id, kind, status, stage, agent, input_snapshot, started_at)
       VALUES ($1, 'initial', 'running', 'building_initial_actor_graph', 'world-state-builder', $2, CURRENT_TIMESTAMP)
       RETURNING id, session_id, headline_id, kind, headline_text, input_snapshot`,
      [sessionId, JSON.stringify({ seedHeadlineCount: SEED_HEADLINES.length })]
    );

    const job = result.rows[0] as WorldStateJobRow;
    this.startJob(job);
    return job.id;
  }

  async resetAndEnqueueInitialBuild(joinCode: string): Promise<string | null> {
    const sessionResult = await pool.query(
      `SELECT id FROM game_sessions WHERE join_code = $1`,
      [joinCode]
    );
    if (sessionResult.rows.length === 0) {
      return null;
    }

    const sessionId = sessionResult.rows[0].id;
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE world_state_jobs
         SET status = 'error',
             stage = 'cancelled_by_admin',
             error = 'Cancelled by admin rebuild',
             completed_at = CURRENT_TIMESTAMP
         WHERE session_id = $1 AND status IN ('queued', 'running')`,
        [sessionId]
      );
      await client.query(`DELETE FROM world_state_edges WHERE session_id = $1`, [sessionId]);
      await client.query(`DELETE FROM world_state_nodes WHERE session_id = $1`, [sessionId]);
      const inserted = await client.query(
        `INSERT INTO world_state_jobs
           (session_id, kind, status, stage, agent, input_snapshot, started_at)
         VALUES ($1, 'initial', 'running', 'building_initial_actor_graph', 'world-state-builder', $2, CURRENT_TIMESTAMP)
         RETURNING id, session_id, headline_id, kind, headline_text, input_snapshot`,
        [sessionId, JSON.stringify({ seedHeadlineCount: SEED_HEADLINES.length, forced: true })]
      );
      await client.query('COMMIT');
      const job = inserted.rows[0] as WorldStateJobRow;
      this.startJob(job);
      return job.id;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async enqueueHeadlineUpdate(input: HeadlineUpdateJobInput): Promise<string | null> {
    if (!(await isSessionWorldStateEnabled(input.sessionId))) {
      return null;
    }

    const existing = await pool.query(
      `SELECT id, session_id, headline_id, kind, status, headline_text, input_snapshot
       FROM world_state_jobs
       WHERE session_id = $1 AND headline_id = $2 AND kind = 'headline'
       LIMIT 1`,
      [input.sessionId, input.headlineId]
    );
    if (existing.rows.length > 0) {
      const existingJob = existing.rows[0] as WorldStateJobRow;
      if (existingJob.status === 'queued') {
        await pool.query(
          `UPDATE world_state_jobs
           SET status = 'running',
               stage = 'headline_intake_agent',
               started_at = COALESCE(started_at, CURRENT_TIMESTAMP)
           WHERE id = $1`,
          [existingJob.id]
        );
        this.startJob({ ...existingJob, status: 'running' });
      }
      return existingJob.id;
    }

    const result = await pool.query(
      `INSERT INTO world_state_jobs
         (session_id, headline_id, kind, status, stage, agent, headline_text, input_snapshot, started_at)
       VALUES ($1, $2, 'headline', 'running', 'headline_intake_agent', 'world-state-propagator', $3, $4, CURRENT_TIMESTAMP)
       RETURNING id, session_id, headline_id, kind, headline_text, input_snapshot`,
      [
        input.sessionId,
        input.headlineId,
        input.headlineText,
        JSON.stringify(input),
      ]
    );

    const job = result.rows[0] as WorldStateJobRow;
    this.startJob(job);
    return job.id;
  }

  private startJob(job: WorldStateJobRow): void {
    setTimeout(() => {
      this.processJob(job).catch((error) => {
        console.error(`[WorldState] Parallel job ${job.id} failed outside handler:`, error);
      });
    }, 0);
  }

  private async isJobStillRunning(jobId: string): Promise<boolean> {
    const result = await pool.query(
      `SELECT status FROM world_state_jobs WHERE id = $1`,
      [jobId]
    );
    return result.rows[0]?.status === 'running';
  }

  private async ensureInitialGraphReady(job: WorldStateJobRow): Promise<boolean> {
    const startedWaitingAt = Date.now();
    let attemptedInitialEnqueue = false;

    await updateJob(job.id, 'waiting_for_initial_actor_graph');

    while (Date.now() - startedWaitingAt < INITIAL_GRAPH_WAIT_TIMEOUT_MS) {
      if (!(await this.isJobStillRunning(job.id))) {
        return false;
      }

      const result = await pool.query(
        `SELECT
           (SELECT COUNT(*)::int FROM world_state_nodes WHERE session_id = $1) AS node_count,
           (SELECT COUNT(*)::int FROM world_state_jobs WHERE session_id = $1 AND kind = 'initial' AND status IN ('queued', 'running')) AS active_initial_jobs,
           (SELECT COUNT(*)::int FROM world_state_jobs WHERE session_id = $1 AND kind = 'initial' AND status = 'completed') AS completed_initial_jobs,
           (SELECT COUNT(*)::int FROM world_state_jobs WHERE session_id = $1 AND kind = 'initial' AND status = 'error') AS errored_initial_jobs`,
        [job.session_id]
      );

      const row = result.rows[0] ?? {};
      const nodeCount = Number(row.node_count ?? 0);
      const activeInitialJobs = Number(row.active_initial_jobs ?? 0);
      const completedInitialJobs = Number(row.completed_initial_jobs ?? 0);
      const erroredInitialJobs = Number(row.errored_initial_jobs ?? 0);

      if (nodeCount > 0) {
        return true;
      }

      if (activeInitialJobs === 0 && completedInitialJobs === 0 && !attemptedInitialEnqueue) {
        attemptedInitialEnqueue = true;
        await this.enqueueInitialBuild(job.session_id);
      } else if (activeInitialJobs === 0 && completedInitialJobs === 0 && attemptedInitialEnqueue) {
        if (erroredInitialJobs > 0) {
          throw new Error('Initial world-state graph failed before headline update could run');
        }
        throw new Error('Initial world-state graph could not be started before headline update');
      } else if (activeInitialJobs === 0 && completedInitialJobs > 0) {
        throw new Error('Initial world-state graph completed without creating any actor nodes');
      } else if (activeInitialJobs === 0 && erroredInitialJobs > 0 && completedInitialJobs === 0) {
        throw new Error('Initial world-state graph failed before headline update could run');
      }

      await sleep(INITIAL_GRAPH_WAIT_INTERVAL_MS);
    }

    throw new Error('Timed out waiting for initial world-state graph before headline update');
  }

  private async processJob(job: WorldStateJobRow): Promise<void> {
    try {
      if (job.kind === 'initial') {
        await this.processInitialJob(job);
      } else {
        await this.processHeadlineJob(job);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await updateJob(job.id, 'error', {
        status: 'error',
        error: message,
        completed: true,
        result: { failedAt: new Date().toISOString() },
      });
      console.error(`[WorldState] Job ${job.id} failed:`, error);
    }
  }

  private async processInitialJob(job: WorldStateJobRow): Promise<void> {
    await updateJob(job.id, 'building_initial_actor_graph');
    const aiResult = await generateInitialGraph(job.session_id);
    if (!(await this.isJobStillRunning(job.id))) {
      return;
    }

    await updateJob(job.id, 'persisting_initial_graph', {
      result: {
        model: aiResult.model,
        usage: aiResult.usage ?? null,
        rationale: aiResult.output.rationale,
      },
    });
    const config = await getSessionWorldStateConfig(job.session_id) ?? DEFAULT_WORLD_STATE_CONFIG;
    const counts = await applyInitialGraph(job.session_id, aiResult.output, config);
    const graphSnapshot = await loadAdminGraphSnapshot(job.session_id);

    await updateJob(job.id, 'completed', {
      status: 'completed',
      completed: true,
      result: {
        ...counts,
        graphSnapshot,
        graphSnapshotAt: new Date().toISOString(),
      },
    });
  }

  private async processHeadlineJob(job: WorldStateJobRow): Promise<void> {
    if (!job.headline_id) {
      throw new Error('Headline world-state job is missing headline_id');
    }

    const config = await getSessionWorldStateConfig(job.session_id);
    if (!config?.enabled) {
      return;
    }

    const initialGraphReady = await this.ensureInitialGraphReady(job);
    if (!initialGraphReady) {
      return;
    }

    await updateJob(job.id, 'headline_intake_agent');
    const aiResult = await generateHeadlineIntake(job);
    if (!(await this.isJobStillRunning(job.id))) {
      return;
    }

    await updateJob(job.id, 'persisting_intake_plan', {
      result: {
        model: aiResult.model,
        usage: aiResult.usage ?? null,
        needsNewNodes: aiResult.output.needsNewNodes,
        impactSummary: aiResult.output.impactSummary,
        affectedNodeNames: affectedNamesFromIntake(aiResult.output),
      },
    });

    const intakeCounts = await applyHeadlineIntake(
      job.session_id,
      job.headline_id,
      aiResult.output,
      config,
      async (stage) => updateJob(job.id, stage)
    );

    if (!(await this.isJobStillRunning(job.id))) {
      return;
    }

    const propagationResult = await applyPropagation(
      job,
      intakeCounts.directEvents,
      config,
      intakeCounts,
      async (stage) => updateJob(job.id, stage)
    );

    if (!(await this.isJobStillRunning(job.id))) {
      return;
    }

    const graphSnapshot = await loadAdminGraphSnapshot(job.session_id);

    await updateJob(job.id, 'completed', {
      status: 'completed',
      completed: true,
      result: {
        ...propagationResult,
        graphSnapshot,
        graphSnapshotAt: new Date().toISOString(),
      },
    });
  }
}

export const worldStateProcessor = new WorldStateProcessor();
