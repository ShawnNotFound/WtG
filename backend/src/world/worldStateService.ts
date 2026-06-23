import { PoolClient } from 'pg';
import pool from '../db/pool.js';
import { createJsonModelClient, getJsonProviderConfig } from '../llm/jsonModelClient.js';
import { getSessionLlmSelection } from '../llm/sessionLlmConfig.js';
import { SEED_HEADLINES } from '../game/seedHeadlines.js';
import {
  buildHeadlineWorldStateUpdatePrompt,
  buildInitialWorldStatePrompt,
  buildWorldStateInstructions,
  headlineWorldStateUpdateJsonSchema,
  HeadlineWorldStateUpdateOutput,
  InitialWorldStateOutput,
  initialWorldStateJsonSchema,
  WorldAttribute,
  WorldEdgeDraft,
  WorldNodeDraft,
  WorldNodeUpdateDraft,
} from './worldStatePrompt.js';

type WorldStateJobKind = 'initial' | 'headline' | 'manual';

const INITIAL_GRAPH_WAIT_INTERVAL_MS = 1000;
const INITIAL_GRAPH_WAIT_TIMEOUT_MS = 10 * 60 * 1000;

interface WorldStateJobRow {
  id: string;
  session_id: string;
  headline_id: string | null;
  kind: WorldStateJobKind;
  status?: 'queued' | 'running' | 'completed' | 'error';
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
  edgesSkippedForCycles: number;
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

function isWorldStateEnabled(config: unknown): boolean {
  if (!config || typeof config !== 'object') return true;
  return (config as { enabled?: unknown }).enabled !== false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getWorldClient(sessionId: string) {
  const selection = await getSessionLlmSelection(sessionId);
  const config = getJsonProviderConfig('WORLD', selection);
  return createJsonModelClient(config);
}

async function isSessionWorldStateEnabled(sessionId: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT world_state_config FROM game_sessions WHERE id = $1`,
    [sessionId]
  );
  if (!result?.rows?.length) {
    return false;
  }
  return isWorldStateEnabled(result.rows[0].world_state_config);
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

async function updateJob(
  jobId: string,
  stage: string,
  patch: {
    status?: 'queued' | 'running' | 'completed' | 'error';
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

async function wouldCreateCycle(
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
): Promise<{ id: string; created: boolean }> {
  const name = cleanName(draft.name);
  const type = cleanType(draft.type);
  const summary = cleanText(draft.summary, '', 1200);
  const attributes = attributesToRecord(draft.attributes);

  const existing = await client.query(
    `SELECT id, attributes
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
    return { id: row.id, created: false };
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

  return { id: inserted.rows[0].id, created: true };
}

async function upsertNodeUpdate(
  client: PoolClient,
  sessionId: string,
  draft: WorldNodeUpdateDraft,
  headlineId: string
): Promise<{ id: string; created: boolean }> {
  return upsertNode(
    client,
    sessionId,
    {
      name: draft.name,
      type: draft.type,
      summary: draft.updatedSummary || draft.summaryDelta,
      attributes: [
        ...draft.attributes,
        { key: 'last_evidence', value: draft.evidence },
        { key: 'last_delta', value: draft.summaryDelta },
      ],
    },
    headlineId,
    1
  );
}

async function upsertEdge(
  client: PoolClient,
  sessionId: string,
  draft: WorldEdgeDraft,
  headlineId: string | null,
  increment: number
): Promise<{ created: boolean; skippedForCycle: boolean }> {
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
    return { created: false, skippedForCycle: true };
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
    return { created: false, skippedForCycle: false };
  }

  if (await wouldCreateCycle(client, sessionId, source.id, target.id)) {
    return { created: false, skippedForCycle: true };
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

  return { created: true, skippedForCycle: false };
}

function emptyCounts(): UpsertCounts {
  return {
    nodesCreated: 0,
    nodesUpdated: 0,
    edgesCreated: 0,
    edgesUpdated: 0,
    edgesSkippedForCycles: 0,
  };
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

function affectedNodeNames(output: HeadlineWorldStateUpdateOutput) {
  return {
    direct: [
      ...output.newNodes.map((node) => cleanName(node.name)),
      ...output.directNodeUpdates.map((node) => cleanName(node.name)),
    ],
    cascade: output.cascadeNodeUpdates.map((node) => cleanName(node.name)),
    related: output.edges.flatMap((edge) => [cleanName(edge.source), cleanName(edge.target)]),
  };
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

    for (const edge of output.edges) {
      const result = await upsertEdge(client, sessionId, edge, null, 0);
      if (result.skippedForCycle) counts.edgesSkippedForCycles++;
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

async function applyHeadlineUpdate(
  sessionId: string,
  headlineId: string,
  output: HeadlineWorldStateUpdateOutput,
  onStage?: (stage: string) => Promise<void>
): Promise<HeadlineUpsertResult> {
  const client = await pool.connect();
  const counts: HeadlineUpsertResult = {
    ...emptyCounts(),
    affectedNodes: [],
  };

  try {
    await client.query('BEGIN');

    await onStage?.('creating_new_entity_nodes');
    for (const node of output.newNodes) {
      const result = await upsertNode(client, sessionId, node, headlineId, 1);
      if (result.created) counts.nodesCreated++;
      else counts.nodesUpdated++;
      addAffectedNode(counts.affectedNodes, {
        id: result.id,
        name: cleanName(node.name),
        depth: 1,
        role: 'new',
      });
    }

    await onStage?.('updating_direct_entity_nodes');
    for (const node of output.directNodeUpdates) {
      const result = await upsertNodeUpdate(client, sessionId, node, headlineId);
      if (result.created) counts.nodesCreated++;
      else counts.nodesUpdated++;
      addAffectedNode(counts.affectedNodes, {
        id: result.id,
        name: cleanName(node.name),
        depth: 1,
        role: 'direct',
      });
    }

    await onStage?.('updating_cascade_entity_nodes');
    for (const node of output.cascadeNodeUpdates) {
      const result = await upsertNodeUpdate(client, sessionId, node, headlineId);
      if (result.created) counts.nodesCreated++;
      else counts.nodesUpdated++;
      addAffectedNode(counts.affectedNodes, {
        id: result.id,
        name: cleanName(node.name),
        depth: 2,
        role: 'cascade',
      });
    }

    await onStage?.('updating_entity_relationships');
    for (const edge of output.edges) {
      const result = await upsertEdge(client, sessionId, edge, headlineId, 1);
      if (result.skippedForCycle) counts.edgesSkippedForCycles++;
      else if (result.created) counts.edgesCreated++;
      else counts.edgesUpdated++;

      const sourceResult = await client.query(
        `SELECT id, name FROM world_state_nodes WHERE session_id = $1 AND lower(name) = lower($2) LIMIT 1`,
        [sessionId, cleanName(edge.source)]
      );
      const targetResult = await client.query(
        `SELECT id, name FROM world_state_nodes WHERE session_id = $1 AND lower(name) = lower($2) LIMIT 1`,
        [sessionId, cleanName(edge.target)]
      );
      for (const row of [...sourceResult.rows, ...targetResult.rows]) {
        addAffectedNode(counts.affectedNodes, {
          id: row.id,
          name: row.name,
          depth: 3,
          role: 'related',
        });
      }
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

async function generateInitialGraph(sessionId: string) {
  const client = await getWorldClient(sessionId);
  return client.callResponsesApi<InitialWorldStateOutput>({
    input: buildInitialWorldStatePrompt(SEED_HEADLINES),
    instructions: buildWorldStateInstructions(),
    jsonSchema: initialWorldStateJsonSchema,
    temperature: 0.2,
  });
}

async function generateHeadlineUpdate(job: WorldStateJobRow) {
  const input = job.input_snapshot as unknown as HeadlineUpdateJobInput;
  const snapshot = await loadGraphSnapshot(job.session_id);
  const client = await getWorldClient(job.session_id);

  return client.callResponsesApi<HeadlineWorldStateUpdateOutput>({
    input: buildHeadlineWorldStateUpdatePrompt({
      headline: input.headlineText,
      storyDirection: input.storyDirection,
      playerNickname: input.playerNickname,
      roundNo: input.roundNo,
      inGameSubmittedAt: input.inGameSubmittedAt,
      nodes: snapshot.nodes,
      edges: snapshot.edges,
    }),
    instructions: buildWorldStateInstructions(),
    jsonSchema: headlineWorldStateUpdateJsonSchema,
    temperature: 0.15,
  });
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
      worldStateConfig: session.world_state_config,
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
             ELSE 'checking_new_entity_nodes'
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
               stage = 'checking_new_entity_nodes',
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
       VALUES ($1, $2, 'headline', 'running', 'checking_new_entity_nodes', 'world-state-updater', $3, $4, CURRENT_TIMESTAMP)
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
    const counts = await applyInitialGraph(job.session_id, aiResult.output);
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

    const initialGraphReady = await this.ensureInitialGraphReady(job);
    if (!initialGraphReady) {
      return;
    }

    await updateJob(job.id, 'checking_new_entity_nodes');
    const aiResult = await generateHeadlineUpdate(job);
    if (!(await this.isJobStillRunning(job.id))) {
      return;
    }

    await updateJob(job.id, 'updating_direct_and_cascade_nodes', {
      result: {
        model: aiResult.model,
        usage: aiResult.usage ?? null,
        needsNewNodes: aiResult.output.needsNewNodes,
        impactSummary: aiResult.output.impactSummary,
        affectedNodeNames: affectedNodeNames(aiResult.output),
      },
    });
    const counts = await applyHeadlineUpdate(
      job.session_id,
      job.headline_id,
      aiResult.output,
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
        ...counts,
        graphSnapshot,
        graphSnapshotAt: new Date().toISOString(),
      },
    });
  }
}

export const worldStateProcessor = new WorldStateProcessor();
