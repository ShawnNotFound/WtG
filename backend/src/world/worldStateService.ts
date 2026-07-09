import { PoolClient } from 'pg';
import pool from '../db/pool.js';
import {
  createJsonModelClient,
  getJsonProviderConfig,
  JsonModelClient,
  normalizeJsonModelSelection,
} from '../llm/jsonModelClient.js';
import { getSessionLlmSelection, normalizeModuleLlmConfig } from '../llm/sessionLlmConfig.js';
import { mergeWorldNodeSummary, normalizeWorldNodeSummary } from './worldNodeDetail.js';
import { SEED_HEADLINES } from '../game/seedHeadlines.js';
import {
  buildEntityReactionPrompt,
  buildHeadlineWorldStateIntakePrompt,
  buildInitialWorldStatePrompt,
  buildNodePickerPrompt,
  buildWorldStateInstructions,
  EntityReactionOutput,
  entityReactionJsonSchema,
  ExistingRelatedWorldNode,
  headlineWorldStateIntakeJsonSchema,
  HeadlineWorldStateIntakeOutput,
  InitialWorldStateOutput,
  initialWorldStateJsonSchema,
  NodeCatalogEntry,
  nodePickerJsonSchema,
  NodePickerOutput,
  WorldAttribute,
  WorldConnectionDraft,
  WorldNodeDraft,
} from '../prompts/worldStatePrompt.js';

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
  retrievalStrategy: 'hybrid' | 'weighted' | 'node_picker';
  maxContextNodes: number;
  maxNeighborsPerNode: number;
  maxCandidateNeighbors: number;
  connectionDisplayThreshold: number;
  propagationRandomMode: 'seeded' | 'random' | 'threshold';
}

export const DEFAULT_WORLD_STATE_CONFIG: WorldStatePropagationConfig = {
  enabled: true,
  allowCycles: true,
  maxPropagationDepth: 2,
  maxNodeReactions: 20,
  maxEventsPerNode: 2,
  nodeAgentConcurrency: 4,
  storeUnaffectedDecisions: true,
  retrievalStrategy: 'hybrid',
  maxContextNodes: 16,
  maxNeighborsPerNode: 8,
  maxCandidateNeighbors: 12,
  connectionDisplayThreshold: 0.15,
  propagationRandomMode: 'seeded',
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

interface ContextConnection {
  id: string;
  source: string;
  target: string;
  strength: number;
  rationale: string;
}

interface ConnectionCandidate {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  targetName: string;
  strength: number;
  rationale: string;
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

function cleanEventId(value: unknown, fallback: string): string {
  const cleaned = cleanText(value, fallback, 120)
    .replace(/[^a-zA-Z0-9:_-]/g, '_')
    .replace(/_+/g, '_');
  return cleaned || fallback;
}

export function seededProbability(seed: string): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index++) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0x100000000;
}

export function shouldPropagateByConnection(
  strength: number,
  config: WorldStatePropagationConfig,
  seed: string
): boolean {
  const probability = clampNumber(strength, 0, 1);
  if (probability <= 0) return false;
  if (probability >= 1) return true;
  if (config.propagationRandomMode === 'threshold') return true;
  const roll = config.propagationRandomMode === 'random'
    ? Math.random()
    : seededProbability(seed);
  return roll < probability;
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

function parseFloatConfig(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return clampNumber(number, min, max);
}

function parseRetrievalStrategy(value: unknown): WorldStatePropagationConfig['retrievalStrategy'] {
  if (value === 'weighted' || value === 'node_picker' || value === 'hybrid') {
    return value;
  }
  return DEFAULT_WORLD_STATE_CONFIG.retrievalStrategy;
}

function parsePropagationRandomMode(value: unknown): WorldStatePropagationConfig['propagationRandomMode'] {
  if (value === 'random' || value === 'threshold' || value === 'seeded') {
    return value;
  }
  return DEFAULT_WORLD_STATE_CONFIG.propagationRandomMode;
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
    retrievalStrategy: parseRetrievalStrategy(source.retrievalStrategy),
    maxContextNodes: parseNumberConfig(
      source.maxContextNodes,
      DEFAULT_WORLD_STATE_CONFIG.maxContextNodes,
      4,
      64
    ),
    maxNeighborsPerNode: parseNumberConfig(
      source.maxNeighborsPerNode,
      DEFAULT_WORLD_STATE_CONFIG.maxNeighborsPerNode,
      1,
      32
    ),
    maxCandidateNeighbors: parseNumberConfig(
      source.maxCandidateNeighbors,
      DEFAULT_WORLD_STATE_CONFIG.maxCandidateNeighbors,
      1,
      64
    ),
    connectionDisplayThreshold: parseFloatConfig(
      source.connectionDisplayThreshold,
      DEFAULT_WORLD_STATE_CONFIG.connectionDisplayThreshold,
      0,
      1
    ),
    propagationRandomMode: parsePropagationRandomMode(source.propagationRandomMode),
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
    related: output.connectionUpdates.flatMap((connection) => [
      cleanName(connection.source),
      cleanName(connection.target),
    ]),
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
  const selection = await getSessionLlmSelection(sessionId, 'world');
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

async function loadNodeCatalog(sessionId: string): Promise<NodeCatalogEntry[]> {
  const result = await pool.query(
    `SELECT id, name, type, times_updated
     FROM world_state_nodes
     WHERE session_id = $1
     ORDER BY name ASC`,
    [sessionId]
  );

  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    type: row.type,
    timesUpdated: row.times_updated,
  }));
}

function keywordScore(text: string, query: string): number {
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((token) => token.length >= 3);
  const haystack = text.toLowerCase();
  return tokens.reduce((score, token) => score + (haystack.includes(token) ? 1 : 0), 0);
}

function pickCatalogNodesByKeywords(
  catalog: NodeCatalogEntry[],
  query: string,
  limit: number
): string[] {
  return [...catalog]
    .map((node) => ({
      node,
      score: keywordScore(`${node.name} ${node.type}`, query) + Math.min(node.timesUpdated, 5) * 0.1,
    }))
    .sort((a, b) => b.score - a.score || b.node.timesUpdated - a.node.timesUpdated || a.node.name.localeCompare(b.node.name))
    .filter((entry) => entry.score > 0)
    .slice(0, limit)
    .map((entry) => entry.node.id);
}

async function loadContextSlice(
  sessionId: string,
  selectedNodeIds: string[],
  config: WorldStatePropagationConfig
): Promise<{ nodes: GraphSnapshotNode[]; connections: ContextConnection[] }> {
  const maxContextNodes = config.maxContextNodes;
  const maxConnectionRows = Math.max(maxContextNodes, maxContextNodes * config.maxNeighborsPerNode);
  let anchorIds = [...new Set(selectedNodeIds)].slice(0, maxContextNodes);

  if (anchorIds.length === 0) {
    const fallback = await pool.query(
      `SELECT id
       FROM world_state_nodes
       WHERE session_id = $1
       ORDER BY times_updated DESC, updated_at DESC, name ASC
       LIMIT $2`,
      [sessionId, maxContextNodes]
    );
    anchorIds = fallback.rows.map((row) => row.id);
  }

  if (anchorIds.length === 0) {
    return { nodes: [], connections: [] };
  }

  const neighborhood = await pool.query(
    `SELECT source_node_id, target_node_id
     FROM world_state_connections
     WHERE session_id = $1
       AND (source_node_id = ANY($2::uuid[]) OR target_node_id = ANY($2::uuid[]))
     ORDER BY strength DESC, times_updated DESC, updated_at DESC
     LIMIT $3`,
    [sessionId, anchorIds, maxConnectionRows]
  );

  const nodeIds = new Set(anchorIds);
  for (const row of neighborhood.rows) {
    if (nodeIds.size >= maxContextNodes) break;
    nodeIds.add(row.source_node_id);
    if (nodeIds.size >= maxContextNodes) break;
    nodeIds.add(row.target_node_id);
  }

  const finalIds = [...nodeIds].slice(0, maxContextNodes);
  const [nodesResult, connectionsResult] = await Promise.all([
    pool.query(
      `SELECT id, name, type, summary, times_updated
       FROM world_state_nodes
       WHERE session_id = $1 AND id = ANY($2::uuid[])
       ORDER BY times_updated DESC, updated_at DESC, name ASC`,
      [sessionId, finalIds]
    ),
    pool.query(
      `SELECT
         c.id,
         source.name AS source,
         target.name AS target,
         c.strength,
         c.rationale
       FROM world_state_connections c
       JOIN world_state_nodes source ON source.id = c.source_node_id
       JOIN world_state_nodes target ON target.id = c.target_node_id
       WHERE c.session_id = $1
         AND c.source_node_id = ANY($2::uuid[])
         AND c.target_node_id = ANY($2::uuid[])
         AND (c.strength > 0 OR c.times_updated > 0)
       ORDER BY c.strength DESC, c.times_updated DESC, c.updated_at DESC
       LIMIT $3`,
      [sessionId, finalIds, maxConnectionRows]
    ),
  ]);

  return {
    nodes: nodesResult.rows.map((row) => ({
      id: row.id,
      name: row.name,
      type: row.type,
      summary: row.summary,
      timesUpdated: row.times_updated,
    })),
    connections: connectionsResult.rows.map((row) => ({
      id: row.id,
      source: row.source,
      target: row.target,
      strength: Number(row.strength ?? 0),
      rationale: row.rationale ?? '',
    })),
  };
}

async function loadAdminGraphSnapshot(sessionId: string, config?: WorldStatePropagationConfig): Promise<{
  nodes: AdminGraphSnapshotNode[];
  edges: AdminGraphSnapshotEdge[];
}> {
  const normalizedConfig = config ?? await getSessionWorldStateConfig(sessionId) ?? DEFAULT_WORLD_STATE_CONFIG;
  const threshold = normalizedConfig.connectionDisplayThreshold;
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
         c.id,
         c.source_node_id,
         c.target_node_id,
         source.name AS source_name,
         target.name AS target_name,
         c.strength,
         c.rationale,
         c.times_updated,
         c.updated_at
       FROM world_state_connections c
       JOIN world_state_nodes source ON source.id = c.source_node_id
       JOIN world_state_nodes target ON target.id = c.target_node_id
       WHERE c.session_id = $1
         AND (c.strength >= $2 OR c.times_updated > 0)
       ORDER BY c.strength DESC, source.name ASC, target.name ASC
       LIMIT 600`,
      [sessionId, threshold]
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
      relationType: 'CONNECTION_STRENGTH',
      summary: row.rationale,
      weight: Number(row.strength ?? 0),
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

async function loadRelatedNodes(
  sessionId: string,
  nodeId: string,
  config: WorldStatePropagationConfig
): Promise<RelatedNodeRecord[]> {
  const result = await pool.query(
    `SELECT
       neighbor.id,
       neighbor.name,
       neighbor.type,
       neighbor.summary,
       neighbor.times_updated,
       CASE WHEN c.source_node_id = $2 THEN 'outgoing' ELSE 'incoming' END AS direction,
       c.strength,
       c.rationale
     FROM world_state_connections c
     JOIN world_state_nodes neighbor
       ON neighbor.id = CASE
         WHEN c.source_node_id = $2 THEN c.target_node_id
         ELSE c.source_node_id
       END
     WHERE c.session_id = $1
       AND (c.source_node_id = $2 OR c.target_node_id = $2)
       AND (c.strength > 0 OR c.times_updated > 0)
     ORDER BY c.strength DESC, c.times_updated DESC, neighbor.times_updated DESC, neighbor.name ASC
     LIMIT $3`,
    [sessionId, nodeId, Math.max(1, config.maxNeighborsPerNode * 2)]
  );

  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    type: row.type,
    summary: row.summary,
    timesUpdated: row.times_updated,
    direction: row.direction === 'incoming' ? 'incoming' : 'outgoing',
    connectionStrength: Number(row.strength ?? 0),
    connectionRationale: row.rationale ?? '',
  }));
}

async function loadPropagationCandidates(
  sessionId: string,
  sourceNodeId: string,
  config: WorldStatePropagationConfig
): Promise<ConnectionCandidate[]> {
  const result = await pool.query(
    `SELECT
       c.id,
       c.source_node_id,
       c.target_node_id,
       target.name AS target_name,
       c.strength,
       c.rationale
     FROM world_state_connections c
     JOIN world_state_nodes target ON target.id = c.target_node_id
     WHERE c.session_id = $1
       AND c.source_node_id = $2
       AND c.strength > 0
     ORDER BY c.strength DESC, c.times_updated DESC, c.updated_at DESC
     LIMIT $3`,
    [sessionId, sourceNodeId, config.maxCandidateNeighbors]
  );

  return result.rows.map((row) => ({
    id: row.id,
    sourceNodeId: row.source_node_id,
    targetNodeId: row.target_node_id,
    targetName: row.target_name,
    strength: Number(row.strength ?? 0),
    rationale: row.rationale ?? '',
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

async function upsertNode(
  client: PoolClient,
  sessionId: string,
  draft: Pick<WorldNodeDraft, 'name' | 'type' | 'summary' | 'attributes'>,
  headlineId: string | null,
  increment: number
): Promise<{ id: string; name: string; type: string; summary: string; created: boolean }> {
  const name = cleanName(draft.name);
  const type = cleanType(draft.type);
  const rawSummary = cleanText(draft.summary, '', 5000);
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
    const summary = rawSummary
      ? mergeWorldNodeSummary(row.summary, rawSummary, name)
      : normalizeWorldNodeSummary(row.summary, name);
    await client.query(
      `UPDATE world_state_nodes
       SET name = $1,
           type = $2,
           summary = $3,
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
    return { id: row.id, name, type, summary, created: false };
  }

  const summary = normalizeWorldNodeSummary(rawSummary, name);

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

  const insertedId = inserted.rows[0].id;
  await ensureDenseConnectionsForNode(client, sessionId, insertedId);

  return { id: insertedId, name, type, summary, created: true };
}

async function ensureDenseConnectionsForNode(
  client: PoolClient,
  sessionId: string,
  nodeId: string
): Promise<void> {
  await client.query(
    `INSERT INTO world_state_connections (session_id, source_node_id, target_node_id, strength, rationale)
     SELECT $1, $2, other.id, 0, ''
     FROM world_state_nodes other
     WHERE other.session_id = $1 AND other.id <> $2
     ON CONFLICT (session_id, source_node_id, target_node_id) DO NOTHING`,
    [sessionId, nodeId]
  );

  await client.query(
    `INSERT INTO world_state_connections (session_id, source_node_id, target_node_id, strength, rationale)
     SELECT $1, other.id, $2, 0, ''
     FROM world_state_nodes other
     WHERE other.session_id = $1 AND other.id <> $2
     ON CONFLICT (session_id, source_node_id, target_node_id) DO NOTHING`,
    [sessionId, nodeId]
  );
}

async function ensureDenseConnectionsForSession(client: PoolClient, sessionId: string): Promise<void> {
  await client.query(
    `INSERT INTO world_state_connections (session_id, source_node_id, target_node_id, strength, rationale)
     SELECT source.session_id, source.id, target.id, 0, ''
     FROM world_state_nodes source
     JOIN world_state_nodes target
       ON target.session_id = source.session_id
      AND target.id <> source.id
     WHERE source.session_id = $1
     ON CONFLICT (session_id, source_node_id, target_node_id) DO NOTHING`,
    [sessionId]
  );
}

async function upsertConnectionStrength(
  client: PoolClient,
  sessionId: string,
  draft: WorldConnectionDraft,
  headlineId: string | null,
  increment: number
): Promise<{ created: boolean; selfEdgeSkipped: boolean; rejected: boolean }> {
  const source = await upsertNode(client, sessionId, {
    name: draft.source,
    type: 'entity',
    summary: '',
    attributes: [],
  }, headlineId, 0);
  const target = await upsertNode(client, sessionId, {
    name: draft.target,
    type: 'entity',
    summary: '',
    attributes: [],
  }, headlineId, 0);

  if (source.id === target.id) {
    return { created: false, selfEdgeSkipped: true, rejected: false };
  }

  const strength = clampNumber(Number(draft.strength ?? 0), 0, 1);
  const rationale = cleanText(draft.rationale, '', 1000);

  const existing = await client.query(
    `SELECT id
     FROM world_state_connections
     WHERE session_id = $1
       AND source_node_id = $2
       AND target_node_id = $3
     FOR UPDATE`,
    [sessionId, source.id, target.id]
  );

  if (existing.rows.length > 0) {
    await client.query(
      `UPDATE world_state_connections
       SET strength = $1,
           rationale = CASE WHEN $2 = '' THEN rationale ELSE $2 END,
           times_updated = times_updated + $3,
           last_seen_headline_id = COALESCE($4, last_seen_headline_id)
       WHERE id = $5`,
      [strength, rationale, increment, headlineId, existing.rows[0].id]
    );
    return { created: false, selfEdgeSkipped: false, rejected: false };
  }

  await client.query(
    `INSERT INTO world_state_connections
       (session_id, source_node_id, target_node_id, strength, rationale, times_updated, first_seen_headline_id, last_seen_headline_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
     ON CONFLICT (session_id, source_node_id, target_node_id) DO UPDATE
     SET strength = EXCLUDED.strength,
         rationale = CASE WHEN EXCLUDED.rationale = '' THEN world_state_connections.rationale ELSE EXCLUDED.rationale END,
         times_updated = world_state_connections.times_updated + EXCLUDED.times_updated,
         last_seen_headline_id = COALESCE(EXCLUDED.last_seen_headline_id, world_state_connections.last_seen_headline_id)`,
    [
      sessionId,
      source.id,
      target.id,
      strength,
      rationale,
      Math.max(0, increment),
      headlineId,
    ]
  );

  return { created: true, selfEdgeSkipped: false, rejected: false };
}

async function applyInitialGraph(
  sessionId: string,
  output: InitialWorldStateOutput
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

    await ensureDenseConnectionsForSession(client, sessionId);

    for (const connection of output.connectionUpdates) {
      const result = await upsertConnectionStrength(client, sessionId, connection, null, 0);
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

    await onStage?.('updating_connection_strengths');
    for (const connection of output.connectionUpdates) {
      const connectionResult = await upsertConnectionStrength(client, sessionId, connection, headlineId, 1);
      if (connectionResult.selfEdgeSkipped) result.selfEdgesSkipped++;
      else if (connectionResult.rejected) result.edgesRejected++;
      else if (connectionResult.created) result.edgesCreated++;
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
  output: EntityReactionOutput
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

    for (const connection of output.connectionUpdates) {
      const connectionResult = await upsertConnectionStrength(client, sessionId, connection, headlineId, 1);
      if (connectionResult.selfEdgeSkipped) result.selfEdgesSkipped++;
      else if (connectionResult.rejected) result.edgesRejected++;
      else if (connectionResult.created) result.edgesCreated++;
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

async function generateNodePicker(
  sessionId: string,
  query: string,
  purpose: 'headline_intake' | 'world_helper',
  catalog: NodeCatalogEntry[],
  config: WorldStatePropagationConfig
) {
  const client = await getWorldClient(sessionId);
  return client.callResponsesApi<NodePickerOutput>({
    input: buildNodePickerPrompt({
      purpose,
      query,
      nodeCatalog: catalog,
      maxSelections: Math.min(config.maxContextNodes, 20),
    }),
    instructions: buildWorldStateInstructions(),
    jsonSchema: nodePickerJsonSchema,
    temperature: 0.05,
  });
}

async function selectContextNodeIds(
  sessionId: string,
  query: string,
  catalog: NodeCatalogEntry[],
  config: WorldStatePropagationConfig,
  purpose: 'headline_intake' | 'world_helper'
): Promise<string[]> {
  if (catalog.length === 0) return [];

  const keywordIds = pickCatalogNodesByKeywords(catalog, query, config.maxContextNodes);
  if (config.retrievalStrategy === 'weighted') {
    return keywordIds;
  }

  try {
    const picker = await generateNodePicker(sessionId, query, purpose, catalog, config);
    const catalogIds = new Set(catalog.map((node) => node.id));
    const catalogNames = new Map(catalog.map((node) => [node.name.toLowerCase(), node.id]));
    const pickedIds = picker.output.relevantNodes
      .map((node) => catalogIds.has(node.nodeId) ? node.nodeId : catalogNames.get(cleanName(node.nodeName).toLowerCase()))
      .filter((nodeId): nodeId is string => Boolean(nodeId));
    return [...new Set([...pickedIds, ...keywordIds])].slice(0, config.maxContextNodes);
  } catch (error) {
    console.warn(`[WorldState ${sessionId}] Node picker failed, falling back to keyword context:`, error);
    return keywordIds;
  }
}

export async function loadWorldStateContextForQuery(
  sessionId: string,
  query: string,
  purpose: 'headline_intake' | 'world_helper' = 'world_helper'
): Promise<{ nodes: GraphSnapshotNode[]; connections: ContextConnection[]; config: WorldStatePropagationConfig }> {
  const config = await getSessionWorldStateConfig(sessionId) ?? DEFAULT_WORLD_STATE_CONFIG;
  const nodeCatalog = await loadNodeCatalog(sessionId);
  const selectedNodeIds = await selectContextNodeIds(sessionId, query, nodeCatalog, config, purpose);
  const context = await loadContextSlice(sessionId, selectedNodeIds, config);
  return { ...context, config };
}

async function generateHeadlineIntake(job: WorldStateJobRow, config: WorldStatePropagationConfig) {
  const input = job.input_snapshot as unknown as HeadlineUpdateJobInput;
  const nodeCatalog = await loadNodeCatalog(job.session_id);
  const selectedNodeIds = await selectContextNodeIds(
    job.session_id,
    `${input.headlineText}\n${input.storyDirection}`,
    nodeCatalog,
    config,
    'headline_intake'
  );
  const context = await loadContextSlice(job.session_id, selectedNodeIds, config);
  const client = await getWorldClient(job.session_id);

  return client.callResponsesApi<HeadlineWorldStateIntakeOutput>({
    input: buildHeadlineWorldStateIntakePrompt({
      headline: input.headlineText,
      storyDirection: input.storyDirection,
      playerNickname: input.playerNickname,
      roundNo: input.roundNo,
      inGameSubmittedAt: input.inGameSubmittedAt,
      nodeCatalog,
      contextNodes: context.nodes,
      contextConnections: context.connections,
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

  const relatedNodes = await loadRelatedNodes(job.session_id, node.id, config);

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
          proposedEdges: aiResult.output.connectionUpdates,
          model: aiResult.model,
          usage: aiResult.usage,
        });
      }
      return [];
    }

    stats.affectedCount++;
    const updateCounts = await applyAffectedReaction(job.session_id, job.headline_id!, node, aiResult.output);
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
      proposedEdges: aiResult.output.connectionUpdates,
      model: aiResult.model,
      usage: aiResult.usage,
    });

    const nextDepth = event.depth + 1;

    if (nextDepth > config.maxPropagationDepth) {
      return [];
    }

    const emittedByName = new Map(
      aiResult.output.emittedEvents.map((emittedEvent) => [
        cleanName(emittedEvent.targetNodeName).toLowerCase(),
        emittedEvent,
      ])
    );
    const candidates = await loadPropagationCandidates(job.session_id, node.id, config);
    const emitted: PropagationEvent[] = [];
    for (const [index, candidate] of candidates.entries()) {
      if (candidate.targetNodeId === node.id) {
        continue;
      }

      const seed = [
        job.session_id,
        job.id,
        event.sourceEventId,
        node.id,
        candidate.targetNodeId,
        nextDepth,
      ].join(':');
      if (!shouldPropagateByConnection(candidate.strength, config, seed)) {
        continue;
      }

      const modelEvent = emittedByName.get(candidate.targetName.toLowerCase());
      stats.emittedEventCount++;
      emitted.push({
        id: cleanEventId(
          `${event.sourceEventId}:${node.id.slice(0, 8)}:${candidate.targetNodeId.slice(0, 8)}:${nextDepth}:${index + 1}`,
          `prop_${nextDepth}_${index + 1}`
        ),
        sourceEventId: event.sourceEventId,
        sourceNodeId: node.id,
        sourceNodeName: node.name,
        targetNodeId: candidate.targetNodeId,
        targetNodeName: candidate.targetName,
        eventSummary: cleanText(
          modelEvent?.eventSummary || `${node.name} changed in a way that may affect ${candidate.targetName}.`,
          '',
          1200
        ),
        evidence: cleanText(
          modelEvent?.relationshipRationale || candidate.rationale || aiResult.output.rationale,
          '',
          1200
        ),
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
       s.title,
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
       s.module_llm_config,
       s.world_state_config,
       s.summary_config,
       s.archived_at,
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
  const worldConfig = normalizeWorldStateConfig(session.world_state_config);
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
         c.id,
         c.source_node_id,
         c.target_node_id,
         source.name AS source_name,
         target.name AS target_name,
         c.strength,
         c.rationale,
         c.times_updated,
         c.updated_at
       FROM world_state_connections c
       JOIN world_state_nodes source ON source.id = c.source_node_id
       JOIN world_state_nodes target ON target.id = c.target_node_id
       WHERE c.session_id = $1
         AND (c.strength >= $2 OR c.times_updated > 0)
       ORDER BY c.strength DESC, c.times_updated DESC, c.updated_at DESC
       LIMIT 600`,
      [session.id, worldConfig.connectionDisplayThreshold]
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
      title: session.title,
      joinCode: session.join_code,
      phase: session.phase,
      archivedAt: session.archived_at,
      currentRound: session.current_round,
      playMinutes: session.play_minutes,
      breakMinutes: session.break_minutes,
      maxRounds: session.max_rounds,
      isPaused: session.is_paused === true,
      pausedAt: session.paused_at,
      pauseRemainingMs: session.pause_remaining_ms,
      timelineSpeedRatio: session.timeline_speed_ratio,
      llmConfig: normalizeJsonModelSelection(session.llm_config),
      moduleLlmConfig: normalizeModuleLlmConfig(session.module_llm_config),
      worldStateConfig: worldConfig,
      summaryConfig: session.summary_config ?? {},
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
      relationType: 'CONNECTION_STRENGTH',
      summary: row.rationale,
      weight: Number(row.strength ?? 0),
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
    const counts = await applyInitialGraph(job.session_id, aiResult.output);
    const graphSnapshot = await loadAdminGraphSnapshot(job.session_id, config);

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
    const aiResult = await generateHeadlineIntake(job, config);
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

    const graphSnapshot = await loadAdminGraphSnapshot(job.session_id, config);

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
