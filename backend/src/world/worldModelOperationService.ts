import { PoolClient } from 'pg';
import pool from '../db/pool.js';
import { computeInGameNow } from '../game/inGameTime.js';
import {
  createJsonModelClient,
  getJsonProviderConfig,
} from '../llm/jsonModelClient.js';
import { getSessionLlmSelection } from '../llm/sessionLlmConfig.js';
import {
  buildWorldModelOperationInstructions,
  buildWorldModelOperationPrompt,
  WorldModelCatalogPage,
  WorldModelOperation,
  WorldModelOperationPlan,
  WorldModelPlanEntity,
  worldModelOperationJsonSchema,
} from '../prompts/worldModelOperationPrompt.js';
import { normalizeWorldNodeSummary } from './worldNodeDetail.js';
import { lockWorldModelSession } from './worldMutationLock.js';
import {
  computeChangeVelocity,
  computeCreationPriority,
  computeTextChangeMagnitude,
  computeUpdatePriority,
} from './worldPagePriority.js';

const MAX_CATALOG_PAGES = 120;
const MAX_TIMELINE_ENTRIES = 50;
const MAX_QUEUED_CREATION_CANDIDATES = 50;
const CREATE_CONFIDENCE_THRESHOLD = 0.65;
const CREATE_NOVELTY_THRESHOLD = 0.5;
const CREATE_PRIORITY_THRESHOLD = 60;

const ABSTRACT_PAGE_NAMES = new Set([
  'ai governance',
  'ai safety',
  'automation',
  'economy',
  'misinformation',
  'privacy',
  'public trust',
  'regulation',
  'synthetic media',
]);

export interface UpdateWorldModelParams {
  sessionId: string;
  query: string;
  operation?: WorldModelOperation;
  helperMessageId?: string;
  source?: 'helper' | 'admin';
  /** Simulated game time used by dated page revisions. */
  effectiveAt?: string | null;
}

export interface WorldModelNodeResult {
  id: string;
  name: string;
  revisionNo: number;
}

export interface WorldModelUpdateResult {
  status: 'not_needed' | 'applied' | 'queued' | 'error';
  operation: WorldModelOperation;
  coverage: WorldModelOperationPlan['coverage'] | 'UNKNOWN';
  jobId: string | null;
  rationale: string;
  createdNodes: WorldModelNodeResult[];
  updatedNodes: WorldModelNodeResult[];
  reusedNodes: WorldModelNodeResult[];
  queuedCandidates: Array<{ id: string; name: string; priorityScore: number }>;
  connectionsUpdated: number;
  model: string | null;
  usage: Record<string, unknown>;
  error?: string;
}

interface SessionOperationContext {
  enabled: boolean;
  inGameNow: string | null;
  catalog: WorldModelCatalogPage[];
  acceptedTimeline: Array<{ id: string; date: string | null; text: string }>;
}

interface ResolvedPage {
  id: string;
  name: string;
  type: string;
  summary: string;
  attributes: Record<string, unknown>;
  aliases: string[];
  revisionNo: number;
  changeVelocity: number;
  lastContentUpdateAt: Date;
}

function cleanText(value: unknown, fallback = '', maxLength = 5000): string {
  if (typeof value !== 'string') return fallback;
  const cleaned = value.replace(/\r/g, '').trim();
  return cleaned.length > maxLength ? cleaned.slice(0, maxLength) : cleaned;
}

export function normalizeWorldPageName(value: string): string {
  return cleanText(value, '', 160)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Treat a planner-provided UUID as a hint, never as authority. The planned
 * name must still identify the page by its canonical name or a persisted
 * alias before that page is eligible for mutation.
 */
export function doesPlannedEntityMatchResolvedPage(
  plannedName: string,
  page: { name: string; aliases: string[] }
): boolean {
  const normalizedPlannedName = normalizeWorldPageName(plannedName);
  if (!normalizedPlannedName) return false;
  return [page.name, ...page.aliases].some(
    (candidate) => normalizeWorldPageName(candidate) === normalizedPlannedName
  );
}

/** Player questions may fill missing pages but never rewrite established ones. */
export function canOperationUpdateExistingPage(
  operation: WorldModelOperation
): boolean {
  return operation !== 'ANSWER';
}

function cleanPageName(value: unknown): string {
  return cleanText(value, '', 120).replace(/\s+/g, ' ');
}

function cleanPageType(value: unknown): string {
  return cleanText(value, 'entity', 80).replace(/\s+/g, ' ');
}

function cleanUuid(value: unknown): string {
  const cleaned = cleanText(value, '', 80);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    cleaned
  )
    ? cleaned
    : '';
}

function clamp01(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(1, Math.max(0, number));
}

function uniqueStrings(values: unknown, limit = 10): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const cleaned = cleanPageName(value);
    const normalized = normalizeWorldPageName(cleaned);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(cleaned);
    if (result.length >= limit) break;
  }
  return result;
}

function sanitizeEvidence(values: unknown): string[] {
  return uniqueStrings(values, 8).filter((evidence) => {
    const text = evidence.toLowerCase();
    return (
      !(
        /player('?s)? query/.test(text) &&
        /(indicat|establish|proves|confirms|means)/.test(text)
      ) && !/query (itself )?is evidence/.test(text)
    );
  });
}

function attributesToRecord(value: unknown): Record<string, string> {
  if (!Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const attribute of value.slice(0, 8)) {
    if (!attribute || typeof attribute !== 'object') continue;
    const item = attribute as { key?: unknown; value?: unknown };
    const key = cleanText(item.key, '', 80).replace(/\s+/g, ' ');
    const attributeValue = cleanText(item.value, '', 500).replace(/\s+/g, ' ');
    if (key && attributeValue) result[key] = attributeValue;
  }
  return result;
}

/** Deterministic guardrail layered on top of the planner prompt. */
export function isConcreteWorldPageCandidate(
  entity: Pick<WorldModelPlanEntity, 'name' | 'type' | 'summary' | 'evidence'>
): boolean {
  const normalizedName = normalizeWorldPageName(entity.name);
  const normalizedType = normalizeWorldPageName(entity.type);
  if (normalizedName.length < 2 || ABSTRACT_PAGE_NAMES.has(normalizedName))
    return false;
  if (
    /\b(topic|concept|theme|issue|trend|risk|policy area)\b/.test(
      normalizedType
    )
  )
    return false;
  if (!cleanText(entity.summary, '', 8000)) return false;
  if (
    !Array.isArray(entity.evidence) ||
    entity.evidence.every((item) => !cleanText(item, '', 500))
  )
    return false;
  return true;
}

function normalizePlan(raw: WorldModelOperationPlan): WorldModelOperationPlan {
  const coverage = [
    'SUFFICIENT',
    'MISSING',
    'STALE',
    'NOT_WORLD_FACT',
  ].includes(raw?.coverage)
    ? raw.coverage
    : 'NOT_WORLD_FACT';
  const validActions = new Set(['CREATE', 'UPDATE', 'REUSE', 'IGNORE']);

  const entities = (Array.isArray(raw?.entities) ? raw.entities : [])
    .slice(0, 6)
    .map(
      (entity): WorldModelPlanEntity => ({
        action: validActions.has(entity?.action) ? entity.action : 'IGNORE',
        existingNodeId: cleanUuid(entity?.existingNodeId),
        expectedRevisionNo: Math.max(
          0,
          Math.floor(Number(entity?.expectedRevisionNo) || 0)
        ),
        name: cleanPageName(entity?.name),
        type: cleanPageType(entity?.type),
        aliases: uniqueStrings(entity?.aliases),
        summary: cleanText(entity?.summary, '', 8000),
        summaryDelta: cleanText(entity?.summaryDelta, '', 1200),
        attributes: Object.entries(attributesToRecord(entity?.attributes)).map(
          ([key, value]) => ({ key, value })
        ),
        rationale: cleanText(entity?.rationale, '', 1200),
        evidence: sanitizeEvidence(entity?.evidence),
        confidence: clamp01(entity?.confidence),
        novelty: clamp01(entity?.novelty),
        relevance: clamp01(entity?.relevance),
        connectionPotential: clamp01(entity?.connectionPotential),
      })
    );

  const connectionUpdates = (
    Array.isArray(raw?.connectionUpdates) ? raw.connectionUpdates : []
  )
    .slice(0, 16)
    .map((connection) => ({
      source: cleanPageName(connection?.source),
      target: cleanPageName(connection?.target),
      strength: clamp01(connection?.strength),
      rationale: cleanText(connection?.rationale, '', 1000),
    }))
    .filter(
      (connection) =>
        connection.source &&
        connection.target &&
        normalizeWorldPageName(connection.source) !==
          normalizeWorldPageName(connection.target)
    );

  return {
    coverage: coverage as WorldModelOperationPlan['coverage'],
    rationale: cleanText(raw?.rationale, '', 2000),
    entities,
    connectionUpdates,
  };
}

async function loadOperationContext(
  sessionId: string
): Promise<SessionOperationContext | null> {
  const [sessionResult, catalogResult, timelineResult] = await Promise.all([
    pool.query(
      `SELECT world_state_config, in_game_start_at, phase_started_at, phase_ends_at,
              timeline_speed_ratio, CURRENT_TIMESTAMP AS server_now
       FROM game_sessions
       WHERE id = $1`,
      [sessionId]
    ),
    pool.query(
      `SELECT
         n.id,
         n.name,
         n.type,
         LEFT(n.summary, 1800) AS summary,
         n.revision_no,
         n.times_updated,
         n.last_content_update_at,
         n.update_priority,
         COALESCE(
           json_agg(a.alias ORDER BY a.alias) FILTER (WHERE a.id IS NOT NULL),
           '[]'::json
         ) AS aliases
       FROM world_state_nodes n
       LEFT JOIN world_state_node_aliases a ON a.node_id = n.id
       WHERE n.session_id = $1
       GROUP BY n.id
       ORDER BY n.update_priority DESC, n.updated_at DESC, n.name ASC
       LIMIT $2`,
      [sessionId, MAX_CATALOG_PAGES]
    ),
    pool.query(
      `SELECT id, in_game_submitted_at, created_at,
              COALESCE(selected_headline, headline_text) AS text
       FROM (
         SELECT id, in_game_submitted_at, created_at, selected_headline, headline_text
         FROM game_session_headlines
         WHERE session_id = $1
         ORDER BY created_at DESC
         LIMIT $2
       ) recent
       ORDER BY created_at ASC`,
      [sessionId, MAX_TIMELINE_ENTRIES]
    ),
  ]);

  if (sessionResult.rows.length === 0) return null;
  const session = sessionResult.rows[0];
  const config =
    session.world_state_config && typeof session.world_state_config === 'object'
      ? session.world_state_config
      : {};
  const inGameNow = computeInGameNow(
    session.in_game_start_at,
    session.phase_started_at,
    session.phase_ends_at,
    new Date(session.server_now),
    session.timeline_speed_ratio
  );

  return {
    enabled: config.enabled !== false,
    inGameNow: inGameNow?.toISOString() ?? null,
    catalog: catalogResult.rows.map(
      (row): WorldModelCatalogPage => ({
        id: row.id,
        name: row.name,
        type: row.type,
        aliases: uniqueStrings(row.aliases),
        summary: row.summary,
        revisionNo: row.revision_no,
        timesUpdated: row.times_updated,
        lastContentUpdateAt: new Date(row.last_content_update_at).toISOString(),
        updatePriority: Number(row.update_priority ?? 0),
      })
    ),
    acceptedTimeline: timelineResult.rows.map((row) => ({
      id: row.id,
      date: row.in_game_submitted_at
        ? new Date(row.in_game_submitted_at).toISOString()
        : new Date(row.created_at).toISOString(),
      text: row.text,
    })),
  };
}

async function insertOperationJob(
  params: UpdateWorldModelParams,
  operation: WorldModelOperation
): Promise<string> {
  const result = await pool.query(
    `INSERT INTO world_state_jobs (
       session_id,
       kind,
       status,
       stage,
       agent,
       input_snapshot,
       source_helper_message_id,
       operation,
       started_at
     )
     VALUES ($1, 'helper', 'running', 'helper_gap_analysis', 'world-helper-page-editor', $2, $3, $4, CURRENT_TIMESTAMP)
     RETURNING id`,
    [
      params.sessionId,
      JSON.stringify({
        query: params.query,
        operation,
        source: params.source ?? 'helper',
      }),
      params.helperMessageId ?? null,
      operation,
    ]
  );
  return result.rows[0].id;
}

async function updateOperationJob(
  jobId: string,
  values: {
    stage: string;
    status?: 'running' | 'completed' | 'error';
    result?: Record<string, unknown>;
    error?: string | null;
  }
): Promise<void> {
  await pool.query(
    `UPDATE world_state_jobs
     SET stage = $2,
         status = COALESCE($3, status),
         result = CASE WHEN $4::jsonb IS NULL THEN result ELSE result || $4::jsonb END,
         error = $5,
         completed_at = CASE WHEN $3 IN ('completed', 'error') THEN CURRENT_TIMESTAMP ELSE completed_at END
     WHERE id = $1`,
    [
      jobId,
      values.stage,
      values.status ?? null,
      values.result ? JSON.stringify(values.result) : null,
      values.error ?? null,
    ]
  );
}

async function saveMessageWorldUpdate(
  helperMessageId: string | undefined,
  result: WorldModelUpdateResult
): Promise<void> {
  if (!helperMessageId) return;
  await pool.query(
    `UPDATE world_helper_messages
     SET world_update = $2
     WHERE id = $1`,
    [helperMessageId, JSON.stringify(result)]
  );
}

async function resolvePage(
  client: PoolClient,
  sessionId: string,
  input: { id?: string; name?: string }
): Promise<ResolvedPage | null> {
  const normalizedName = input.name ? normalizeWorldPageName(input.name) : '';
  const nodeId = cleanUuid(input.id);
  const result = await client.query(
    `SELECT
       n.id,
       n.name,
       n.type,
       n.summary,
       n.attributes,
       n.aliases,
       n.revision_no,
       n.change_velocity,
       n.last_content_update_at
     FROM world_state_nodes n
     WHERE n.session_id = $1
       AND $3 <> ''
       AND (
         trim(lower(regexp_replace(trim(n.name), '[^[:alnum:]]+', ' ', 'g'))) = $3
         OR EXISTS (
           SELECT 1
           FROM world_state_node_aliases a
           WHERE a.node_id = n.id AND a.normalized_alias = $3
         )
       )
     ORDER BY CASE WHEN n.id = $2::uuid THEN 0 ELSE 1 END
     LIMIT 1
     FOR UPDATE OF n`,
    [sessionId, nodeId || null, normalizedName]
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  const page: ResolvedPage = {
    id: row.id,
    name: row.name,
    type: row.type,
    summary: row.summary,
    attributes: row.attributes ?? {},
    aliases: uniqueStrings(row.aliases),
    revisionNo: row.revision_no,
    changeVelocity: Number(row.change_velocity ?? 0),
    lastContentUpdateAt: new Date(row.last_content_update_at),
  };
  return doesPlannedEntityMatchResolvedPage(input.name ?? '', page)
    ? page
    : null;
}

async function saveAliases(
  client: PoolClient,
  sessionId: string,
  nodeId: string,
  canonicalName: string,
  aliases: string[]
): Promise<void> {
  const allAliases = uniqueStrings([canonicalName, ...aliases], 12);
  for (const alias of allAliases) {
    const normalized = normalizeWorldPageName(alias);
    if (!normalized) continue;
    await client.query(
      `INSERT INTO world_state_node_aliases (session_id, node_id, alias, normalized_alias)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (session_id, normalized_alias) DO NOTHING`,
      [sessionId, nodeId, alias, normalized]
    );
  }
  await client.query(
    `UPDATE world_state_nodes n
     SET aliases = COALESCE((
       SELECT jsonb_agg(a.alias ORDER BY a.alias)
       FROM world_state_node_aliases a
       WHERE a.node_id = n.id
         AND a.normalized_alias <> $2
     ), '[]'::jsonb)
     WHERE n.id = $1`,
    [nodeId, normalizeWorldPageName(canonicalName)]
  );
}

async function ensureDenseConnectionsForPage(
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

async function raiseDependentPagePriorities(
  client: PoolClient,
  sessionId: string,
  sourceNodeId: string,
  changeMagnitude: number
): Promise<void> {
  await client.query(
    `UPDATE world_state_nodes target
     SET update_priority = LEAST(
       100,
       GREATEST(
         target.update_priority,
         30 * (1 - EXP(-(connection.strength * $3)))
       )
     )
     FROM world_state_connections connection
     WHERE connection.session_id = $1
       AND connection.source_node_id = $2
       AND connection.target_node_id = target.id
       AND connection.strength > 0`,
    [sessionId, sourceNodeId, changeMagnitude]
  );
}

async function createPage(
  client: PoolClient,
  params: UpdateWorldModelParams,
  entity: WorldModelPlanEntity,
  model: string,
  usage: Record<string, unknown>
): Promise<WorldModelNodeResult> {
  const name = cleanPageName(entity.name);
  const type = cleanPageType(entity.type);
  const summary = normalizeWorldNodeSummary(entity.summary, name);
  const attributes = attributesToRecord(entity.attributes);
  const aliases = uniqueStrings(entity.aliases).filter(
    (alias) => normalizeWorldPageName(alias) !== normalizeWorldPageName(name)
  );
  const changeMagnitude = computeTextChangeMagnitude('', summary);
  const result = await client.query(
    `INSERT INTO world_state_nodes (
       session_id,
       name,
       type,
       summary,
       attributes,
       times_updated,
       revision_no,
       last_content_update_at,
       change_velocity,
       last_change_magnitude
     )
     VALUES ($1, $2, $3, $4, $5, 0, 1, CURRENT_TIMESTAMP, $6, $6)
     RETURNING id, name, revision_no`,
    [
      params.sessionId,
      name,
      type,
      summary,
      JSON.stringify(attributes),
      changeMagnitude,
    ]
  );
  const page = result.rows[0];
  await saveAliases(
    client,
    params.sessionId,
    page.id,
    page.name,
    entity.aliases
  );
  await ensureDenseConnectionsForPage(client, params.sessionId, page.id);
  await client.query(
    `INSERT INTO world_state_page_revisions (
       session_id, node_id, revision_no, operation, source_kind,
       source_helper_message_id, effective_at, page_name, page_type,
       page_attributes, page_aliases, after_summary, summary_delta, rationale,
       evidence, confidence, change_magnitude, model, usage
     )
     VALUES ($1, $2, 1, 'CREATE', $3, $4, COALESCE($5::timestamptz, CURRENT_TIMESTAMP),
             $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
    [
      params.sessionId,
      page.id,
      params.source === 'admin' ? 'admin' : 'helper',
      params.helperMessageId ?? null,
      params.effectiveAt ?? null,
      name,
      type,
      JSON.stringify(attributes),
      JSON.stringify(aliases),
      summary,
      entity.summaryDelta || `Created the ${name} page.`,
      entity.rationale,
      JSON.stringify(entity.evidence),
      entity.confidence,
      changeMagnitude,
      model,
      JSON.stringify(usage),
    ]
  );
  return { id: page.id, name: page.name, revisionNo: page.revision_no };
}

async function updatePage(
  client: PoolClient,
  params: UpdateWorldModelParams,
  operation: WorldModelOperation,
  existing: ResolvedPage,
  entity: WorldModelPlanEntity,
  model: string,
  usage: Record<string, unknown>
): Promise<WorldModelNodeResult | null> {
  const nextSummary = normalizeWorldNodeSummary(
    entity.summary || existing.summary,
    existing.name
  );
  const textMagnitude = computeTextChangeMagnitude(
    existing.summary,
    nextSummary
  );
  const aliases = uniqueStrings([entity.name, ...entity.aliases]);
  const attributes = {
    ...existing.attributes,
    ...attributesToRecord(entity.attributes),
  };
  const pageAliases = uniqueStrings([
    ...existing.aliases,
    entity.name,
    ...entity.aliases,
  ]).filter(
    (alias) =>
      normalizeWorldPageName(alias) !== normalizeWorldPageName(existing.name)
  );
  const nextType = cleanPageType(entity.type || existing.type);
  const metadataChanged =
    nextType !== existing.type ||
    JSON.stringify(attributes) !== JSON.stringify(existing.attributes) ||
    JSON.stringify([...pageAliases].sort()) !==
      JSON.stringify([...existing.aliases].sort());
  await saveAliases(
    client,
    params.sessionId,
    existing.id,
    existing.name,
    aliases
  );
  if (textMagnitude < 0.01 && !metadataChanged) return null;

  // Metadata-only edits still carry a small non-zero causal magnitude so they
  // are visible in velocity/dependency accounting.
  const magnitude = Math.max(textMagnitude, metadataChanged ? 0.05 : 0);
  const elapsedDays = Math.max(
    0,
    (Date.now() - existing.lastContentUpdateAt.getTime()) /
      (24 * 60 * 60 * 1000)
  );
  const velocity = computeChangeVelocity(
    existing.changeVelocity,
    magnitude,
    elapsedDays
  );
  const revisionNo = existing.revisionNo + 1;

  await client.query(
    `UPDATE world_state_nodes
     SET type = $2,
         summary = $3,
         attributes = $4,
         times_updated = times_updated + 1,
         revision_no = $5,
         last_content_update_at = CURRENT_TIMESTAMP,
         consultations_since_update = 0,
         change_velocity = $6,
         last_change_magnitude = $7
     WHERE id = $1`,
    [
      existing.id,
      nextType,
      nextSummary,
      JSON.stringify(attributes),
      revisionNo,
      velocity,
      magnitude,
    ]
  );
  await client.query(
    `INSERT INTO world_state_page_revisions (
       session_id, node_id, revision_no, operation, source_kind,
       source_helper_message_id, effective_at, page_name, page_type,
       page_attributes, page_aliases, before_summary, after_summary, summary_delta,
       rationale, evidence, confidence, change_magnitude, model, usage
     )
     VALUES ($1, $2, $3, $4, $5, $6, GREATEST(
               COALESCE($7::timestamptz, CURRENT_TIMESTAMP),
               COALESCE((
                 SELECT MAX(effective_at) FROM world_state_page_revisions WHERE node_id = $2
               ), '-infinity'::timestamptz)
             ),
             $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
    [
      params.sessionId,
      existing.id,
      revisionNo,
      operation === 'CREATE' ? 'UPDATE' : operation,
      params.source === 'admin' ? 'admin' : 'helper',
      params.helperMessageId ?? null,
      params.effectiveAt ?? null,
      existing.name,
      nextType,
      JSON.stringify(attributes),
      JSON.stringify(pageAliases),
      existing.summary,
      nextSummary,
      entity.summaryDelta || entity.rationale,
      entity.rationale,
      JSON.stringify(entity.evidence),
      entity.confidence,
      magnitude,
      model,
      JSON.stringify(usage),
    ]
  );
  await raiseDependentPagePriorities(
    client,
    params.sessionId,
    existing.id,
    magnitude
  );
  return { id: existing.id, name: existing.name, revisionNo };
}

async function upsertCreationCandidate(
  client: PoolClient,
  params: UpdateWorldModelParams,
  entity: WorldModelPlanEntity
): Promise<{
  id: string;
  name: string;
  priorityScore: number;
  confidence: number;
  novelty: number;
}> {
  const normalizedName = normalizeWorldPageName(entity.name);
  const result = await client.query(
    `INSERT INTO world_state_creation_candidates (
       session_id, normalized_name, proposed_name, proposed_type, aliases,
       proposed_summary, attributes, justification, evidence, source_query,
       source_helper_message_id, confidence, novelty, connection_potential
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT (session_id, normalized_name) DO UPDATE
     SET proposed_name = EXCLUDED.proposed_name,
         proposed_type = EXCLUDED.proposed_type,
         aliases = EXCLUDED.aliases,
         proposed_summary = EXCLUDED.proposed_summary,
         attributes = EXCLUDED.attributes,
         justification = EXCLUDED.justification,
         evidence = EXCLUDED.evidence,
         source_query = EXCLUDED.source_query,
         source_helper_message_id = COALESCE(EXCLUDED.source_helper_message_id, world_state_creation_candidates.source_helper_message_id),
         mention_count = world_state_creation_candidates.mention_count + 1,
         confidence = GREATEST(world_state_creation_candidates.confidence, EXCLUDED.confidence),
         novelty = GREATEST(world_state_creation_candidates.novelty, EXCLUDED.novelty),
         connection_potential = GREATEST(world_state_creation_candidates.connection_potential, EXCLUDED.connection_potential),
         status = CASE
           WHEN world_state_creation_candidates.status = 'accepted' THEN 'accepted'
           ELSE 'queued'
         END
     RETURNING id, proposed_name, mention_count, confidence, novelty, connection_potential`,
    [
      params.sessionId,
      normalizedName,
      entity.name,
      entity.type,
      JSON.stringify(entity.aliases),
      entity.summary,
      JSON.stringify(attributesToRecord(entity.attributes)),
      entity.rationale,
      JSON.stringify(entity.evidence),
      params.query,
      params.helperMessageId ?? null,
      entity.confidence,
      entity.novelty,
      entity.connectionPotential,
    ]
  );
  const row = result.rows[0];
  const score = computeCreationPriority({
    mentionCount: row.mention_count,
    confidence: Number(row.confidence),
    novelty: Number(row.novelty),
    connectionPotential: Number(row.connection_potential),
  }).total;
  await client.query(
    `UPDATE world_state_creation_candidates SET priority_score = $2 WHERE id = $1`,
    [row.id, score]
  );
  return {
    id: row.id,
    name: row.proposed_name,
    priorityScore: score,
    confidence: Number(row.confidence),
    novelty: Number(row.novelty),
  };
}

async function markCandidateAccepted(
  client: PoolClient,
  candidateId: string,
  nodeId: string
): Promise<void> {
  await client.query(
    `UPDATE world_state_creation_candidates
     SET status = 'accepted', accepted_node_id = $2, resolved_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [candidateId, nodeId]
  );
}

async function trimCreationQueue(
  client: PoolClient,
  sessionId: string
): Promise<void> {
  await client.query(
    `WITH overflow AS (
       SELECT id
       FROM world_state_creation_candidates
       WHERE session_id = $1 AND status = 'queued'
       ORDER BY priority_score DESC, updated_at ASC
       OFFSET $2
     )
     UPDATE world_state_creation_candidates candidate
     SET status = 'dropped', resolved_at = CURRENT_TIMESTAMP
     FROM overflow
     WHERE candidate.id = overflow.id`,
    [sessionId, MAX_QUEUED_CREATION_CANDIDATES]
  );
}

async function recordConsultation(
  client: PoolClient,
  params: UpdateWorldModelParams,
  nodeId: string,
  relevance: number,
  incrementPressure: boolean
): Promise<void> {
  if (!params.helperMessageId) return;
  const inserted = await client.query(
    `INSERT INTO world_state_page_consultations (
       session_id, node_id, helper_message_id, query, relevance
     )
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (helper_message_id, node_id) DO NOTHING
     RETURNING id`,
    [params.sessionId, nodeId, params.helperMessageId, params.query, relevance]
  );
  if (inserted.rows.length > 0) {
    await client.query(
      `UPDATE world_state_nodes
       SET last_consulted_at = CURRENT_TIMESTAMP,
           consultations_since_update = consultations_since_update + $2
       WHERE id = $1`,
      [nodeId, incrementPressure ? 1 : 0]
    );
  }
}

async function updatePagePriority(
  client: PoolClient,
  sessionId: string,
  nodeId: string,
  explicitBoost: number
): Promise<void> {
  const result = await client.query(
    `SELECT
       n.last_content_update_at,
       n.change_velocity,
       n.consultations_since_update,
       COALESCE((
         SELECT SUM(
           c.strength * latest.change_magnitude *
           EXP(-GREATEST(0, EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - latest.effective_at)) / 86400.0) / 14.0)
         )
         FROM world_state_connections c
         JOIN LATERAL (
           SELECT r.change_magnitude, r.effective_at
           FROM world_state_page_revisions r
           WHERE r.node_id = c.source_node_id
             AND r.effective_at > n.last_content_update_at
           ORDER BY r.revision_no DESC
           LIMIT 1
         ) latest ON TRUE
         WHERE c.session_id = $1 AND c.target_node_id = n.id
       ), 0) AS dependency_shock
     FROM world_state_nodes n
     WHERE n.session_id = $1 AND n.id = $2`,
    [sessionId, nodeId]
  );
  if (result.rows.length === 0) return;
  const row = result.rows[0];
  const staleDays = Math.max(
    0,
    (Date.now() - new Date(row.last_content_update_at).getTime()) /
      (24 * 60 * 60 * 1000)
  );
  const priority = computeUpdatePriority({
    staleDays,
    dependencyShock: Number(row.dependency_shock ?? 0),
    changeVelocity: Number(row.change_velocity ?? 0),
    consultationsSinceUpdate: Number(row.consultations_since_update ?? 0),
    explicitBoost,
  });
  await client.query(
    `UPDATE world_state_nodes SET update_priority = $2 WHERE id = $1`,
    [nodeId, priority.total]
  );
}

async function applyPlan(
  params: UpdateWorldModelParams,
  operation: WorldModelOperation,
  plan: WorldModelOperationPlan,
  jobId: string,
  model: string,
  usage: Record<string, unknown>
): Promise<
  Omit<
    WorldModelUpdateResult,
    | 'status'
    | 'operation'
    | 'coverage'
    | 'jobId'
    | 'rationale'
    | 'model'
    | 'usage'
  >
> {
  const client = await pool.connect();
  const createdNodes: WorldModelNodeResult[] = [];
  const updatedNodes: WorldModelNodeResult[] = [];
  const reusedNodes: WorldModelNodeResult[] = [];
  const queuedCandidates: Array<{
    id: string;
    name: string;
    priorityScore: number;
  }> = [];
  let connectionsUpdated = 0;

  try {
    await client.query('BEGIN');
    await lockWorldModelSession(client, params.sessionId);
    await updateOperationJob(jobId, { stage: 'helper_gap_persisting' });

    const touched = new Map<string, { relevance: number; changed: boolean }>();
    for (const entity of plan.entities) {
      if (!entity.name || entity.action === 'IGNORE') continue;
      let existing = await resolvePage(client, params.sessionId, {
        id: entity.existingNodeId || undefined,
        name: entity.name,
      });

      if (existing) {
        if (entity.action === 'UPDATE') {
          if (!canOperationUpdateExistingPage(operation)) {
            // The query is untrusted input. Accepted-history catch-up is done
            // by headline ingestion, without the player's claim in its prompt.
            const reused = {
              id: existing.id,
              name: existing.name,
              revisionNo: existing.revisionNo,
            };
            reusedNodes.push(reused);
            touched.set(reused.id, {
              relevance: entity.relevance,
              changed: false,
            });
            continue;
          }
          if (
            entity.expectedRevisionNo > 0 &&
            entity.expectedRevisionNo !== existing.revisionNo
          ) {
            // The model planned against an older catalog snapshot. Preserve the
            // newer page instead of replacing it with stale generated content.
            const reused = {
              id: existing.id,
              name: existing.name,
              revisionNo: existing.revisionNo,
            };
            reusedNodes.push(reused);
            touched.set(reused.id, {
              relevance: entity.relevance,
              changed: false,
            });
            continue;
          }
          const updated = await updatePage(
            client,
            params,
            operation,
            existing,
            entity,
            model,
            usage
          );
          if (updated) {
            updatedNodes.push(updated);
            touched.set(updated.id, {
              relevance: entity.relevance,
              changed: true,
            });
          } else {
            const reused = {
              id: existing.id,
              name: existing.name,
              revisionNo: existing.revisionNo,
            };
            reusedNodes.push(reused);
            touched.set(reused.id, {
              relevance: entity.relevance,
              changed: false,
            });
          }
        } else {
          // REUSE is intentionally read-only. Planner-proposed aliases are not
          // trusted unless they are part of a revisioned UPDATE.
          const reused = {
            id: existing.id,
            name: existing.name,
            revisionNo: existing.revisionNo,
          };
          reusedNodes.push(reused);
          touched.set(reused.id, {
            relevance: entity.relevance,
            changed: false,
          });
        }
        continue;
      }

      if (entity.action !== 'CREATE') continue;
      const candidate = await upsertCreationCandidate(client, params, entity);
      const eligible =
        candidate.confidence >= CREATE_CONFIDENCE_THRESHOLD &&
        candidate.novelty >= CREATE_NOVELTY_THRESHOLD &&
        (operation === 'ANSWER' ||
          operation === 'CREATE' ||
          candidate.priorityScore >= CREATE_PRIORITY_THRESHOLD) &&
        isConcreteWorldPageCandidate(entity);
      if (!eligible) {
        queuedCandidates.push({
          id: candidate.id,
          name: candidate.name,
          priorityScore: candidate.priorityScore,
        });
        continue;
      }

      // Resolve again while holding the per-session advisory lock. This is the
      // idempotency check that prevents an alias or case variant being created
      // by two simultaneous helper requests.
      existing = await resolvePage(client, params.sessionId, {
        name: entity.name,
      });
      if (existing) {
        await markCandidateAccepted(client, candidate.id, existing.id);
        const reused = {
          id: existing.id,
          name: existing.name,
          revisionNo: existing.revisionNo,
        };
        reusedNodes.push(reused);
        touched.set(reused.id, { relevance: entity.relevance, changed: false });
        continue;
      }

      const created = await createPage(client, params, entity, model, usage);
      await markCandidateAccepted(client, candidate.id, created.id);
      createdNodes.push(created);
      touched.set(created.id, { relevance: entity.relevance, changed: true });
    }

    for (const connection of plan.connectionUpdates) {
      const source = await resolvePage(client, params.sessionId, {
        name: connection.source,
      });
      const target = await resolvePage(client, params.sessionId, {
        name: connection.target,
      });
      if (!source || !target || source.id === target.id) continue;
      if (
        operation === 'ANSWER' &&
        !createdNodes.some(
          (node) => node.id === source.id || node.id === target.id
        )
      ) {
        // In ANSWER mode, inference may connect a newly filled page, but a
        // player question cannot rewrite relationships between established pages.
        continue;
      }
      await client.query(
        `INSERT INTO world_state_connections (
           session_id, source_node_id, target_node_id, strength, rationale, times_updated
         )
         VALUES ($1, $2, $3, $4, $5, 1)
         ON CONFLICT (session_id, source_node_id, target_node_id) DO UPDATE
         SET strength = EXCLUDED.strength,
             rationale = CASE WHEN EXCLUDED.rationale = '' THEN world_state_connections.rationale ELSE EXCLUDED.rationale END,
             times_updated = world_state_connections.times_updated + 1`,
        [
          params.sessionId,
          source.id,
          target.id,
          connection.strength,
          connection.rationale,
        ]
      );
      connectionsUpdated += 1;
    }

    // If the planner returned only a coverage verdict, still count explicit
    // catalog-name mentions as consultations.
    if (touched.size === 0 && params.helperMessageId) {
      const mentioned = await client.query(
        `SELECT DISTINCT n.id, n.name, n.revision_no
         FROM world_state_nodes n
         LEFT JOIN world_state_node_aliases a ON a.node_id = n.id
         WHERE n.session_id = $1
           AND (
             lower($2) LIKE '%' || lower(n.name) || '%'
             OR (a.alias IS NOT NULL AND lower($2) LIKE '%' || lower(a.alias) || '%')
           )
         LIMIT 12`,
        [params.sessionId, params.query]
      );
      for (const row of mentioned.rows) {
        reusedNodes.push({
          id: row.id,
          name: row.name,
          revisionNo: row.revision_no,
        });
        touched.set(row.id, { relevance: 1, changed: false });
      }
    }

    for (const [nodeId, touch] of touched) {
      await recordConsultation(
        client,
        params,
        nodeId,
        touch.relevance,
        !touch.changed
      );
      await updatePagePriority(
        client,
        params.sessionId,
        nodeId,
        !touch.changed &&
          (operation === 'UPDATE' || operation === 'INCORPORATE')
          ? 1
          : 0
      );
    }

    await trimCreationQueue(client, params.sessionId);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  return {
    createdNodes,
    updatedNodes,
    reusedNodes: Array.from(
      new Map(reusedNodes.map((node) => [node.id, node])).values()
    ),
    queuedCandidates,
    connectionsUpdated,
  };
}

function emptyResult(
  operation: WorldModelOperation,
  patch: Partial<WorldModelUpdateResult> = {}
): WorldModelUpdateResult {
  return {
    status: 'not_needed',
    operation,
    coverage: 'UNKNOWN',
    jobId: null,
    rationale: '',
    createdNodes: [],
    updatedNodes: [],
    reusedNodes: [],
    queuedCandidates: [],
    connectionsUpdated: 0,
    model: null,
    usage: {},
    ...patch,
  };
}

export async function updateWorldModelWithHelper(
  params: UpdateWorldModelParams
): Promise<WorldModelUpdateResult> {
  const operation = params.operation ?? 'ANSWER';
  const query = cleanText(params.query, '', 2000);
  if (!query) {
    return emptyResult(operation, {
      status: 'error',
      error: 'World-model operation query cannot be empty',
    });
  }

  const context = await loadOperationContext(params.sessionId);
  if (!context) {
    return emptyResult(operation, {
      status: 'error',
      error: 'Session not found',
    });
  }
  if (!context.enabled) {
    return emptyResult(operation, {
      rationale: 'World-state modeling is disabled for this session.',
    });
  }

  const jobId = await insertOperationJob({ ...params, query }, operation);
  try {
    const selection = await getSessionLlmSelection(params.sessionId, 'world');
    const config = getJsonProviderConfig('WORLD', selection);
    if (!config.apiKey) {
      throw new Error(
        `${config.provider === 'deepseek' ? 'DEEPSEEK_API_KEY' : 'OPENAI_API_KEY'} environment variable is not set`
      );
    }
    const client = createJsonModelClient(config);
    const generated = await client.callResponsesApi<WorldModelOperationPlan>({
      instructions: buildWorldModelOperationInstructions(),
      input: buildWorldModelOperationPrompt({
        operation,
        query,
        inGameNow: context.inGameNow,
        catalog: context.catalog,
        acceptedTimeline: context.acceptedTimeline,
      }),
      jsonSchema: worldModelOperationJsonSchema,
      temperature: 0.15,
    });
    const plan = normalizePlan(generated.output);
    const usage = (generated.usage ?? {}) as unknown as Record<string, unknown>;
    await updateOperationJob(jobId, {
      stage: 'helper_gap_planned',
      result: {
        plan,
        plannerModel: generated.model,
        plannerUsage: usage,
      },
    });
    const applied = await applyPlan(
      {
        ...params,
        query,
        effectiveAt: params.effectiveAt ?? context.inGameNow,
      },
      operation,
      plan,
      jobId,
      generated.model,
      usage
    );
    const mutationCount =
      applied.createdNodes.length +
      applied.updatedNodes.length +
      applied.connectionsUpdated;
    const result: WorldModelUpdateResult = {
      status:
        mutationCount > 0
          ? 'applied'
          : applied.queuedCandidates.length > 0
            ? 'queued'
            : 'not_needed',
      operation,
      coverage: plan.coverage,
      jobId,
      rationale: plan.rationale,
      ...applied,
      model: generated.model,
      usage,
    };
    await updateOperationJob(jobId, {
      stage: 'helper_gap_complete',
      status: 'completed',
      result: result as unknown as Record<string, unknown>,
    });
    await saveMessageWorldUpdate(params.helperMessageId, result);
    return result;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'World-model update failed';
    const result = emptyResult(operation, {
      status: 'error',
      jobId,
      error: message,
      rationale:
        'Gap filling failed; the helper can still answer from the existing world model.',
    });
    await updateOperationJob(jobId, {
      stage: 'helper_gap_error',
      status: 'error',
      error: message,
      result: result as unknown as Record<string, unknown>,
    });
    await saveMessageWorldUpdate(params.helperMessageId, result);
    return result;
  }
}

export const WORLD_MODEL_OPERATION_LIMITS = {
  maxCatalogPages: MAX_CATALOG_PAGES,
  maxTimelineEntries: MAX_TIMELINE_ENTRIES,
  maxQueuedCreationCandidates: MAX_QUEUED_CREATION_CANDIDATES,
  createConfidenceThreshold: CREATE_CONFIDENCE_THRESHOLD,
  createNoveltyThreshold: CREATE_NOVELTY_THRESHOLD,
  createPriorityThreshold: CREATE_PRIORITY_THRESHOLD,
} as const;
