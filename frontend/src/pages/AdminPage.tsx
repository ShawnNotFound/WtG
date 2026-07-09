import { FormEvent, MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BaseEdge,
  Controls,
  getBezierPath,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useInternalNode,
  useNodesInitialized,
  useReactFlow,
  type Edge as FlowEdge,
  type EdgeProps,
  type InternalNode,
  type Node as FlowNode,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force';
import { Badge, Button, Card, DropdownSelect } from '../components/ui';
import {
  AiProvider,
  baseUrlForProvider,
  defaultModelForProvider,
  modelOptionsForValue,
} from '../lib/modelOptions';
import { useNavigate } from 'react-router-dom';
import type { WorldHelperMessage } from '../hooks/useSocket';

const API_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001';

const PROVIDER_OPTIONS = [
  { label: 'DeepSeek', value: 'deepseek' },
  { label: 'OpenAI', value: 'openai' },
];

interface AdminSessionSummary {
  id: string;
  title: string;
  joinCode: string;
  phase: string;
  isPaused?: boolean;
  currentRound: number;
  playerCount: number;
  archivedAt?: string | null;
  createdAt: string;
}

interface AdminPlayer {
  id: string;
  nickname: string;
  isAi: boolean;
  aiConfig?: {
    stylePrompt?: string;
    creativity?: number;
    submitEverySeconds?: number;
    helperActivity?: number;
    provider?: AiProvider;
    model?: string;
  };
  totalScore?: number;
}

interface WorldNode {
  id: string;
  name: string;
  type: string;
  summary: string;
  attributes: Record<string, unknown>;
  timesUpdated: number;
  updatedAt: string;
}

interface ParsedWorldNodeSummary {
  description: string;
  recentChanges: string;
  mediumTermChanges: string;
  longTermChanges: string;
}

function extractNodeSummarySection(text: string, start: RegExp, end?: RegExp): string {
  const startMatch = start.exec(text);
  if (!startMatch || startMatch.index === undefined) return '';
  const tail = text.slice(startMatch.index + startMatch[0].length);
  if (!end) return tail.trim();
  const endMatch = end.exec(tail);
  return (endMatch && endMatch.index !== undefined ? tail.slice(0, endMatch.index) : tail).trim();
}

function parseWorldNodeSummary(summary: string): ParsedWorldNodeSummary {
  const text = summary.replace(/\r\n/g, '\n').trim();
  const description = extractNodeSummarySection(
    text,
    /^(?:#+\s*)?Description\s*:?\s*$/im,
    /^(?:#+\s*)?(Changes|Recent Changes|Medium[- ]Term Changes|Long[- ]Term Changes)\s*:?\s*$/im
  );

  if (!description) {
    return {
      description: text,
      recentChanges: '',
      mediumTermChanges: '',
      longTermChanges: '',
    };
  }

  return {
    description,
    recentChanges: extractNodeSummarySection(
      text,
      /^(?:#+\s*)?Recent Changes\s*:?\s*$/im,
      /^(?:#+\s*)?(Medium[- ]Term Changes|Long[- ]Term Changes)\s*:?\s*$/im
    ),
    mediumTermChanges: extractNodeSummarySection(
      text,
      /^(?:#+\s*)?Medium[- ]Term Changes\s*:?\s*$/im,
      /^(?:#+\s*)?Long[- ]Term Changes\s*:?\s*$/im
    ),
    longTermChanges: extractNodeSummarySection(text, /^(?:#+\s*)?Long[- ]Term Changes\s*:?\s*$/im),
  };
}

function CompactNodeSummary({ summary }: { summary: string }) {
  const detail = parseWorldNodeSummary(summary);
  return <p className="mt-2 line-clamp-3 text-xs leading-5 text-gray-500">{detail.description || summary}</p>;
}

function WorldNodeDetailBlocks({ summary }: { summary: string }) {
  const detail = parseWorldNodeSummary(summary);
  const changeBlocks = [
    { label: 'Recent Changes', value: detail.recentChanges },
    { label: 'Medium-Term Changes', value: detail.mediumTermChanges },
    { label: 'Long-Term Changes', value: detail.longTermChanges },
  ];

  return (
    <div className="space-y-3">
      <div className="rounded-lg bg-gray-50 p-3">
        <h4 className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">Description</h4>
        <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-gray-600">
          {detail.description || 'No durable description recorded yet.'}
        </p>
      </div>
      <div className="rounded-lg border border-gray-100 p-3">
        <h4 className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">Changes</h4>
        <div className="mt-2 space-y-2">
          {changeBlocks.map((block) => (
            <div key={block.label}>
              <div className="text-xs font-medium text-gray-900">{block.label}</div>
              <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-gray-600">
                {block.value || 'None recorded.'}
              </p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

interface WorldEdge {
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

interface WorldReaction {
  id: string;
  headlineId: string | null;
  nodeId: string | null;
  nodeName: string;
  sourceNodeId: string | null;
  sourceNodeName: string | null;
  sourceEventId: string;
  eventId: string;
  depth: number;
  status: 'affected' | 'unaffected' | 'skipped' | 'error';
  confidence: number | null;
  rationale: string | null;
  stateDelta: string | null;
  updatedSummary: string | null;
  emittedEvents: unknown[];
  proposedEdges: unknown[];
  model: string | null;
  usage: Record<string, unknown>;
  error: string | null;
  createdAt: string;
}

interface WorldJob {
  id: string;
  headlineId: string | null;
  kind: string;
  status: 'queued' | 'running' | 'completed' | 'error';
  stage: string;
  agent: string;
  headlineText: string | null;
  result: Record<string, unknown>;
  reactions?: WorldReaction[];
  error: string | null;
  createdAt: string;
  startedAt?: string | null;
  completedAt?: string | null;
  updatedAt: string;
}

type HighlightDepth = 1 | 2 | 3;

interface AffectedNodeResult {
  id?: string;
  name?: string;
  depth?: number;
  role?: string;
}

interface AffectedNodeNamesResult {
  direct?: string[];
  cascade?: string[];
  related?: string[];
}

interface WorldStateResponse {
  session: {
    id: string;
    title: string;
    joinCode: string;
    phase: string;
    archivedAt?: string | null;
    isPaused?: boolean;
    currentRound: number;
    playMinutes: number;
    breakMinutes: number;
    maxRounds: number;
    pausedAt?: string | null;
    pauseRemainingMs?: number | null;
    timelineSpeedRatio: number;
    llmConfig?: {
      provider?: AiProvider;
      model?: string;
      baseUrl?: string;
    };
    moduleLlmConfig?: Partial<Record<ModuleLlmName, {
      provider?: AiProvider;
      model?: string;
      baseUrl?: string;
    }>>;
    summaryConfig?: {
      roundSummaries?: boolean;
      finalNarrative?: boolean;
    };
    worldStateConfig?: {
      enabled?: boolean;
      allowCycles?: boolean;
      maxPropagationDepth?: number;
      maxNodeReactions?: number;
      maxEventsPerNode?: number;
      nodeAgentConcurrency?: number;
      storeUnaffectedDecisions?: boolean;
      retrievalStrategy?: 'hybrid' | 'weighted' | 'node_picker';
      maxContextNodes?: number;
      maxNeighborsPerNode?: number;
      maxCandidateNeighbors?: number;
      connectionDisplayThreshold?: number;
      propagationRandomMode?: 'seeded' | 'random' | 'threshold';
    };
    players: AdminPlayer[];
  };
  stats: {
    nodeCount: number;
    edgeCount: number;
    queuedJobs: number;
    runningJobs: number;
  };
  nodes: WorldNode[];
  edges: WorldEdge[];
  jobs: WorldJob[];
}

interface JobGraphSnapshot {
  nodes: WorldNode[];
  edges: WorldEdge[];
}

interface AiDraft {
  nickname: string;
  stylePrompt: string;
  creativity: string;
  submitEverySeconds: string;
  helperActivity: string;
  provider: AiProvider;
  model: string;
}

type ModuleLlmName = 'juror' | 'world' | 'summary' | 'helper';

const MODULE_LLM_LABELS: Array<{ key: ModuleLlmName; label: string }> = [
  { key: 'juror', label: 'Juror' },
  { key: 'world', label: 'World Graph' },
  { key: 'summary', label: 'Summaries' },
  { key: 'helper', label: 'World Helper' },
];

const RETRIEVAL_STRATEGY_OPTIONS = [
  { label: 'Hybrid', value: 'hybrid' },
  { label: 'Weighted', value: 'weighted' },
  { label: 'Node picker', value: 'node_picker' },
];

const PROPAGATION_RANDOM_OPTIONS = [
  { label: 'Seeded', value: 'seeded' },
  { label: 'Random', value: 'random' },
  { label: 'Threshold', value: 'threshold' },
];

interface LlmDraft {
  provider: AiProvider;
  model: string;
  baseUrl: string;
}

interface ConfigDraft {
  title: string;
  playMinutes: string;
  breakMinutes: string;
  maxRounds: string;
  timelineSpeedRatio: string;
  worldStateEnabled: boolean;
  allowCycles: boolean;
  maxPropagationDepth: string;
  maxNodeReactions: string;
  maxEventsPerNode: string;
  nodeAgentConcurrency: string;
  storeUnaffectedDecisions: boolean;
  retrievalStrategy: 'hybrid' | 'weighted' | 'node_picker';
  maxContextNodes: string;
  maxNeighborsPerNode: string;
  maxCandidateNeighbors: string;
  connectionDisplayThreshold: string;
  propagationRandomMode: 'seeded' | 'random' | 'threshold';
  roundSummaries: boolean;
  finalNarrative: boolean;
  provider: AiProvider;
  model: string;
  baseUrl: string;
  moduleLlmConfig: Record<ModuleLlmName, LlmDraft>;
  aiPlayers: Record<string, AiDraft>;
}

function normalizeProvider(value: unknown): AiProvider {
  return value === 'openai' ? 'openai' : 'deepseek';
}

function normalizeRetrievalStrategy(value: unknown): ConfigDraft['retrievalStrategy'] {
  return value === 'weighted' || value === 'node_picker' || value === 'hybrid' ? value : 'hybrid';
}

function normalizePropagationRandomMode(value: unknown): ConfigDraft['propagationRandomMode'] {
  return value === 'random' || value === 'threshold' || value === 'seeded' ? value : 'seeded';
}

function draftLlmConfig(raw: unknown, fallback?: LlmDraft): LlmDraft {
  const source = raw && typeof raw === 'object'
    ? raw as Partial<LlmDraft>
    : {};
  const provider = normalizeProvider(source.provider ?? fallback?.provider);
  return {
    provider,
    model: source.model ?? fallback?.model ?? defaultModelForProvider(provider),
    baseUrl: source.baseUrl ?? fallback?.baseUrl ?? baseUrlForProvider(provider),
  };
}

function draftFromState(state: WorldStateResponse): ConfigDraft {
  const provider = normalizeProvider(state.session.llmConfig?.provider);
  const worldStateConfig = state.session.worldStateConfig ?? {};
  const sharedLlm = draftLlmConfig(state.session.llmConfig);
  const moduleLlmConfig = Object.fromEntries(
    MODULE_LLM_LABELS.map(({ key }) => [
      key,
      draftLlmConfig(state.session.moduleLlmConfig?.[key], sharedLlm),
    ])
  ) as Record<ModuleLlmName, LlmDraft>;
  const aiPlayers: Record<string, AiDraft> = {};

  for (const player of state.session.players.filter((p) => p.isAi)) {
    const playerProvider = normalizeProvider(player.aiConfig?.provider);
    aiPlayers[player.id] = {
      nickname: player.nickname,
      stylePrompt: player.aiConfig?.stylePrompt ?? '',
      creativity: String(player.aiConfig?.creativity ?? 1),
      submitEverySeconds: String(player.aiConfig?.submitEverySeconds ?? 0),
      helperActivity: String(player.aiConfig?.helperActivity ?? 0.5),
      provider: playerProvider,
      model: player.aiConfig?.model ?? defaultModelForProvider(playerProvider),
    };
  }

  return {
    title: state.session.title ?? 'Future Headlines',
    playMinutes: String(state.session.playMinutes),
    breakMinutes: String(state.session.breakMinutes),
    maxRounds: String(state.session.maxRounds),
    timelineSpeedRatio: String(state.session.timelineSpeedRatio),
    worldStateEnabled: worldStateConfig.enabled !== false,
    allowCycles: worldStateConfig.allowCycles !== false,
    maxPropagationDepth: String(worldStateConfig.maxPropagationDepth ?? 2),
    maxNodeReactions: String(worldStateConfig.maxNodeReactions ?? 20),
    maxEventsPerNode: String(worldStateConfig.maxEventsPerNode ?? 2),
    nodeAgentConcurrency: String(worldStateConfig.nodeAgentConcurrency ?? 4),
    storeUnaffectedDecisions: worldStateConfig.storeUnaffectedDecisions !== false,
    retrievalStrategy: normalizeRetrievalStrategy(worldStateConfig.retrievalStrategy),
    maxContextNodes: String(worldStateConfig.maxContextNodes ?? 16),
    maxNeighborsPerNode: String(worldStateConfig.maxNeighborsPerNode ?? 8),
    maxCandidateNeighbors: String(worldStateConfig.maxCandidateNeighbors ?? 12),
    connectionDisplayThreshold: String(worldStateConfig.connectionDisplayThreshold ?? 0.15),
    propagationRandomMode: normalizePropagationRandomMode(worldStateConfig.propagationRandomMode),
    roundSummaries: state.session.summaryConfig?.roundSummaries !== false,
    finalNarrative: state.session.summaryConfig?.finalNarrative !== false,
    provider,
    model: state.session.llmConfig?.model ?? defaultModelForProvider(provider),
    baseUrl: state.session.llmConfig?.baseUrl ?? baseUrlForProvider(provider),
    moduleLlmConfig,
    aiPlayers,
  };
}

async function readJson(response: Response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error ?? 'Admin request failed');
  }
  return data;
}

function statusVariant(status: WorldJob['status']) {
  if (status === 'completed') return 'green';
  if (status === 'running') return 'blue';
  if (status === 'error') return 'red';
  return 'yellow';
}

function formatTime(value: string): string {
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function stageLabel(stage: string): string {
  const labels: Record<string, string> = {
    building_initial_actor_graph: 'Building initial actor graph',
    waiting_for_initial_actor_graph: 'Waiting for initial actor graph',
    persisting_initial_graph: 'Persisting initial graph',
    headline_intake_agent: 'Headline intake agent',
    persisting_intake_plan: 'Persisting intake plan',
    creating_new_actor_nodes: 'Creating new actor nodes',
    updating_initial_relationships: 'Updating initial relationships',
    entity_agent_direct_wave: 'Direct entity-agent wave',
    entity_agent_propagation_wave_1: 'Propagation wave 1',
    entity_agent_propagation_wave_2: 'Propagation wave 2',
    entity_agent_propagation_wave_3: 'Propagation wave 3',
    entity_agent_propagation_wave_4: 'Propagation wave 4',
    entity_agent_propagation_wave_5: 'Propagation wave 5',
    entity_agent_propagation_wave_6: 'Propagation wave 6',
    entity_agent_propagation_wave_7: 'Propagation wave 7',
    entity_agent_propagation_wave_8: 'Propagation wave 8',
    propagation_capped: 'Propagation capped',
    checking_new_entity_nodes: 'Checking new entity nodes',
    updating_direct_and_cascade_nodes: 'Planning direct and cascade updates',
    creating_new_entity_nodes: 'Creating new entity nodes',
    updating_direct_entity_nodes: 'Updating directly affected nodes',
    updating_cascade_entity_nodes: 'Updating cascading nodes',
    updating_entity_relationships: 'Updating relationships',
    completed: 'Completed',
    error: 'Error',
  };
  return labels[stage] ?? stage.replace(/_/g, ' ');
}

function coerceDepth(value: unknown): HighlightDepth {
  return value === 1 || value === 2 || value === 3 ? value : 3;
}

function collectNodeHighlights(nodes: WorldNode[], jobs: WorldJob[]): Map<string, HighlightDepth> {
  const highlights = new Map<string, HighlightDepth>();
  const nodesByName = new Map(nodes.map((node) => [node.name.toLowerCase(), node]));

  const add = (nodeId: string | undefined, nodeName: string | undefined, depth: HighlightDepth) => {
    const node = nodeId
      ? nodes.find((candidate) => candidate.id === nodeId)
      : nodeName
        ? nodesByName.get(nodeName.toLowerCase())
        : undefined;
    if (!node) return;
    const current = highlights.get(node.id);
    if (!current || depth < current) {
      highlights.set(node.id, depth);
    }
  };

  for (const job of jobs) {
    const affectedNodes = Array.isArray(job.result?.affectedNodes)
      ? job.result.affectedNodes as AffectedNodeResult[]
      : [];
    for (const node of affectedNodes) {
      add(node.id, node.name, coerceDepth(node.depth));
    }

    const names = job.result?.affectedNodeNames as AffectedNodeNamesResult | undefined;
    for (const name of names?.direct ?? []) add(undefined, name, 1);
    for (const name of names?.cascade ?? []) add(undefined, name, 2);
    for (const name of names?.related ?? []) add(undefined, name, 3);

    for (const reaction of job.reactions ?? []) {
      if (reaction.status === 'affected') {
        add(reaction.nodeId ?? undefined, reaction.nodeName, coerceDepth(reaction.depth + 1));
      }
    }
  }

  return highlights;
}

interface GraphNodeData extends Record<string, unknown> {
  node: WorldNode;
  highlightDepth?: HighlightDepth;
}

type WorldGraphFlowNode = FlowNode<GraphNodeData, 'worldNode'>;
type WorldGraphFlowEdge = FlowEdge<{ edge: WorldEdge }, 'floating'>;

function WorldGraphNode({ data, selected }: NodeProps<WorldGraphFlowNode>) {
  const { node, highlightDepth } = data;
  const highlightClass = highlightDepth === 1
    ? 'border-indigo-300 bg-indigo-50 shadow-indigo-100'
    : highlightDepth === 2
      ? 'border-sky-200 bg-sky-50/80 shadow-sky-50'
      : highlightDepth === 3
        ? 'border-emerald-100 bg-emerald-50/60 shadow-emerald-50'
        : 'border-gray-200 bg-white';

  return (
    <div
      className={`w-[240px] rounded-lg border p-3 shadow-sm transition-colors ${
        selected ? 'ring-2 ring-indigo-400 ring-offset-2' : ''
      } ${highlightClass}`}
    >
      {/* Floating edges attach at the card border, so the handles are hidden anchors only. */}
      <Handle type="target" position={Position.Left} isConnectable={false} className="!h-1 !w-1 !min-h-0 !min-w-0 !border-0 !bg-transparent !opacity-0" />
      <Handle type="source" position={Position.Right} isConnectable={false} className="!h-1 !w-1 !min-h-0 !min-w-0 !border-0 !bg-transparent !opacity-0" />
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-gray-900" title={node.name}>
            {node.name}
          </div>
          <div className="truncate text-[11px] uppercase text-gray-400">{node.type}</div>
        </div>
        <Badge variant={node.timesUpdated > 2 ? 'purple' : 'default'}>{node.timesUpdated}</Badge>
      </div>
      <CompactNodeSummary summary={node.summary} />
    </div>
  );
}

const worldGraphNodeTypes = { worldNode: WorldGraphNode };

// --- Floating edges -------------------------------------------------------
// React Flow's built-in edges attach to fixed handles, which looks broken on an
// organic (force-directed) layout where neighbours sit in any direction. A
// floating edge instead connects to the point where the centre-to-centre line
// crosses each node's border, so arrows always face the right way.

function nodeBox(node: InternalNode<WorldGraphFlowNode>) {
  const width = node.measured.width ?? 240;
  const height = node.measured.height ?? 120;
  const { x, y } = node.internals.positionAbsolute;
  return { cx: x + width / 2, cy: y + height / 2, width, height };
}

// Where the line from `source` centre towards `target` centre meets the source box.
function getBorderPoint(
  source: InternalNode<WorldGraphFlowNode>,
  target: InternalNode<WorldGraphFlowNode>
): { x: number; y: number } {
  const s = nodeBox(source);
  const t = nodeBox(target);
  const dx = t.cx - s.cx;
  const dy = t.cy - s.cy;
  if (dx === 0 && dy === 0) return { x: s.cx, y: s.cy };
  const scale = 1 / Math.max(Math.abs(dx) / (s.width / 2), Math.abs(dy) / (s.height / 2));
  return { x: s.cx + dx * scale, y: s.cy + dy * scale };
}

function getBorderSide(node: InternalNode<WorldGraphFlowNode>, point: { x: number; y: number }): Position {
  const { cx, cy, width, height } = nodeBox(node);
  const dx = point.x - cx;
  const dy = point.y - cy;
  if (Math.abs(dx) / width >= Math.abs(dy) / height) {
    return dx >= 0 ? Position.Right : Position.Left;
  }
  return dy >= 0 ? Position.Bottom : Position.Top;
}

function FloatingWorldEdge({
  id,
  source,
  target,
  markerEnd,
  style,
  interactionWidth,
  label,
  labelStyle,
  labelShowBg,
  labelBgStyle,
  labelBgPadding,
  labelBgBorderRadius,
}: EdgeProps<WorldGraphFlowEdge>) {
  const sourceNode = useInternalNode<WorldGraphFlowNode>(source);
  const targetNode = useInternalNode<WorldGraphFlowNode>(target);
  if (!sourceNode || !targetNode) return null;

  const sourcePoint = getBorderPoint(sourceNode, targetNode);
  const targetPoint = getBorderPoint(targetNode, sourceNode);
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX: sourcePoint.x,
    sourceY: sourcePoint.y,
    sourcePosition: getBorderSide(sourceNode, sourcePoint),
    targetX: targetPoint.x,
    targetY: targetPoint.y,
    targetPosition: getBorderSide(targetNode, targetPoint),
  });

  return (
    <BaseEdge
      id={id}
      path={edgePath}
      markerEnd={markerEnd}
      style={style}
      interactionWidth={interactionWidth ?? 20}
      label={label}
      labelX={labelX}
      labelY={labelY}
      labelStyle={labelStyle}
      labelShowBg={labelShowBg}
      labelBgStyle={labelBgStyle}
      labelBgPadding={labelBgPadding}
      labelBgBorderRadius={labelBgBorderRadius}
    />
  );
}

const worldGraphEdgeTypes = { floating: FloatingWorldEdge };

// --- Force-directed layout ------------------------------------------------
// A topological/layered layout collapses on a cyclic graph (almost no node has
// in-degree 0), so everything stacks into one unreadable column. A force
// simulation spreads the actor-entity graph out in 2D instead and lets clusters
// emerge naturally.

interface ForceSimNode extends SimulationNodeDatum {
  id: string;
}

// Small deterministic PRNG so the simulation seeds the same way every render and
// the layout doesn't jitter between admin-panel polls.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildForceGraphPositions(nodes: WorldNode[], edges: WorldEdge[]): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  if (nodes.length === 0) return positions;

  // Seed nodes deterministically on a ring (sorted by id) so the simulation
  // converges to the same arrangement for a given topology.
  const ordered = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
  const count = ordered.length;
  const ring = Math.max(420, count * 40);
  const simNodes: ForceSimNode[] = ordered.map((node, index) => {
    const angle = (index / count) * Math.PI * 2;
    return { id: node.id, x: Math.cos(angle) * ring, y: Math.sin(angle) * ring };
  });

  const present = new Set(simNodes.map((node) => node.id));
  const simLinks: SimulationLinkDatum<ForceSimNode>[] = edges
    .filter((edge) => present.has(edge.sourceNodeId) && present.has(edge.targetNodeId))
    .map((edge) => ({ source: edge.sourceNodeId, target: edge.targetNodeId }));

  const simulation = forceSimulation<ForceSimNode>(simNodes)
    .randomSource(mulberry32(0x9e3779b9))
    .force(
      'link',
      forceLink<ForceSimNode, SimulationLinkDatum<ForceSimNode>>(simLinks)
        .id((node) => node.id)
        .distance(280)
        .strength(0.25)
    )
    .force('charge', forceManyBody<ForceSimNode>().strength(-2400).distanceMax(2000))
    .force('collide', forceCollide<ForceSimNode>(165))
    .force('x', forceX<ForceSimNode>(0).strength(0.05))
    .force('y', forceY<ForceSimNode>(0).strength(0.07))
    .stop();

  // Run to convergence synchronously — no animation, just final positions.
  const iterations = Math.min(600, Math.max(260, count * 12));
  for (let i = 0; i < iterations; i += 1) simulation.tick();

  simNodes.forEach((node) => {
    positions.set(node.id, { x: node.x ?? 0, y: node.y ?? 0 });
  });
  return positions;
}

function GraphFlowViewport({
  flowNodes,
  flowEdges,
  graphSignature,
  onNodeClick,
  onEdgeClick,
  onPaneClick,
  onRenderFault,
}: {
  flowNodes: WorldGraphFlowNode[];
  flowEdges: WorldGraphFlowEdge[];
  graphSignature: string;
  onNodeClick: (_: MouseEvent, node: WorldGraphFlowNode) => void;
  onEdgeClick: (event: MouseEvent, edge: WorldGraphFlowEdge) => void;
  onPaneClick: () => void;
  onRenderFault: () => void;
}) {
  const reactFlow = useReactFlow<WorldGraphFlowNode, WorldGraphFlowEdge>();
  const nodesInitialized = useNodesInitialized();
  const viewportRef = useRef<HTMLDivElement>(null);
  const latestTopologySignature = useRef('');
  const hasAutoFitOnce = useRef(false);
  const nodesInitializedRef = useRef(false);
  const programmaticMove = useRef(false);
  const lastRecoveryAt = useRef(0);
  const userMovedViewport = useRef(false);
  const missingRenderCount = useRef(0);

  useEffect(() => {
    nodesInitializedRef.current = nodesInitialized;
  }, [nodesInitialized]);

  const fitGraph = useCallback((duration = 220) => {
    if (flowNodes.length === 0) return;
    programmaticMove.current = true;
    window.requestAnimationFrame(() => {
      reactFlow.fitView({
        padding: 0.22,
        duration,
      });
      window.setTimeout(() => {
        programmaticMove.current = false;
      }, duration + 80);
    });
  }, [flowNodes.length, reactFlow]);

  useEffect(() => {
    if (flowNodes.length === 0) return;
    if (latestTopologySignature.current === graphSignature) return;

    latestTopologySignature.current = graphSignature;
    if (userMovedViewport.current && hasAutoFitOnce.current) {
      return;
    }

    const handle = window.setTimeout(() => {
      fitGraph(180);
      hasAutoFitOnce.current = true;
    }, nodesInitializedRef.current ? 80 : 220);

    return () => window.clearTimeout(handle);
  }, [fitGraph, flowNodes.length, graphSignature]);

  useEffect(() => {
    missingRenderCount.current = 0;
  }, [flowNodes.length, graphSignature]);

  useEffect(() => {
    if (flowNodes.length === 0) return;

    const checkRenderedGraph = () => {
      const root = viewportRef.current;
      if (!root) return;

      const flow = root.querySelector('.react-flow') as HTMLElement | null;
      if (!flow || flow.clientWidth === 0 || flow.clientHeight === 0) return;

      const flowRect = flow.getBoundingClientRect();
      const renderedNodes = Array.from(root.querySelectorAll('.react-flow__node')) as HTMLElement[];
      const visibleNodes = renderedNodes.filter((node) => {
        const rect = node.getBoundingClientRect();
        return (
          rect.width > 2 &&
          rect.height > 2 &&
          rect.right > flowRect.left &&
          rect.left < flowRect.right &&
          rect.bottom > flowRect.top &&
          rect.top < flowRect.bottom
        );
      });
      const missingNodes = renderedNodes.length === 0 || visibleNodes.length === 0;

      if (missingNodes) {
        missingRenderCount.current += 1;
        if (missingRenderCount.current < 2) return;

        const now = Date.now();
        if (now - lastRecoveryAt.current < 1200) return;

        lastRecoveryAt.current = now;
        latestTopologySignature.current = '';
        hasAutoFitOnce.current = false;
        userMovedViewport.current = false;
        missingRenderCount.current = 0;
        onRenderFault();
        return;
      }

      missingRenderCount.current = 0;
    };

    const initialCheck = window.setTimeout(checkRenderedGraph, 900);
    const interval = window.setInterval(checkRenderedGraph, 3500);

    return () => {
      window.clearTimeout(initialCheck);
      window.clearInterval(interval);
    };
  }, [flowNodes.length, graphSignature, onRenderFault]);

  return (
    <div ref={viewportRef} className="relative h-[640px] min-h-[520px] min-w-0 overflow-hidden rounded-lg border border-gray-100 bg-gray-50">
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={worldGraphNodeTypes}
        edgeTypes={worldGraphEdgeTypes}
        onNodeClick={onNodeClick}
        onEdgeClick={onEdgeClick}
        onPaneClick={onPaneClick}
        onMoveStart={() => {
          if (!programmaticMove.current) {
            userMovedViewport.current = true;
          }
        }}
        minZoom={0.08}
        maxZoom={1.7}
        panOnScroll
        nodesDraggable
        nodesConnectable={false}
        elementsSelectable
        onlyRenderVisibleElements={false}
      >
        <Background color="#e5e7eb" gap={20} />
        <Controls position="bottom-left" />
      </ReactFlow>

      <button
        type="button"
        onClick={() => {
          userMovedViewport.current = true;
          fitGraph();
        }}
        className="absolute right-3 top-3 z-10 rounded-lg border border-gray-200 bg-white/95 px-3 py-1.5 text-xs font-medium text-gray-600 shadow-sm hover:bg-gray-50"
      >
        Fit Graph
      </button>

    </div>
  );
}

function GraphCanvas({
  nodes,
  edges,
  highlights,
}: {
  nodes: WorldNode[];
  edges: WorldEdge[];
  highlights: Map<string, HighlightDepth>;
}) {
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [graphRecoveryKey, setGraphRecoveryKey] = useState(0);
  const nodeIds = useMemo(() => new Set(nodes.map((node) => node.id)), [nodes]);
  const visibleEdges = useMemo(
    () => edges.filter((edge) => nodeIds.has(edge.sourceNodeId) && nodeIds.has(edge.targetNodeId)),
    [edges, nodeIds]
  );

  useEffect(() => {
    if (selectedNodeId && !nodes.some((node) => node.id === selectedNodeId)) {
      setSelectedNodeId(null);
    }
    if (selectedEdgeId && !visibleEdges.some((edge) => edge.id === selectedEdgeId)) {
      setSelectedEdgeId(null);
    }
  }, [nodes, selectedEdgeId, selectedNodeId, visibleEdges]);

  const graphSignature = useMemo(
    () => [
      nodes.map((node) => node.id).sort().join('|'),
      visibleEdges
        .map((edge) => `${edge.id}:${edge.sourceNodeId}:${edge.targetNodeId}`)
        .sort()
        .join('|'),
    ].join('::'),
    [nodes, visibleEdges]
  );
  // Re-run the force simulation only when the topology changes. The admin panel
  // polls every few seconds and hands us fresh-but-identical arrays; recomputing
  // the layout each time would waste work and risk the graph jumping around.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const positions = useMemo(() => buildForceGraphPositions(nodes, visibleEdges), [graphSignature]);
  const selectedNode = selectedNodeId ? nodes.find((node) => node.id === selectedNodeId) : undefined;
  const selectedEdge = selectedEdgeId ? visibleEdges.find((edge) => edge.id === selectedEdgeId) : undefined;

  const connectedEdges = useMemo(() => {
    if (!selectedNodeId) return [];
    return visibleEdges.filter((edge) => edge.sourceNodeId === selectedNodeId || edge.targetNodeId === selectedNodeId);
  }, [selectedNodeId, visibleEdges]);

  const flowNodes: WorldGraphFlowNode[] = useMemo(
    () => nodes.map((node) => ({
      id: node.id,
      type: 'worldNode',
      position: positions.get(node.id) ?? { x: 0, y: 0 },
      data: {
        node,
        highlightDepth: highlights.get(node.id),
      },
      selected: selectedNodeId === node.id,
    })),
    [highlights, nodes, positions, selectedNodeId]
  );

  const flowEdges: WorldGraphFlowEdge[] = useMemo(
    () => visibleEdges.map((edge) => {
      const touchesSelectedNode = selectedNodeId
        ? edge.sourceNodeId === selectedNodeId || edge.targetNodeId === selectedNodeId
        : false;
      const activeEdge = selectedEdgeId === edge.id;
      const highlightedByJob = highlights.has(edge.sourceNodeId) && highlights.has(edge.targetNodeId);
      const color = activeEdge
        ? '#4338ca'
        : touchesSelectedNode
          ? '#6366f1'
          : highlightedByJob
            ? '#0f766e'
            : '#94a3b8';

      return {
        id: edge.id,
        source: edge.sourceNodeId,
        target: edge.targetNodeId,
        type: 'floating',
        data: { edge },
        label: edge.relationType,
        markerEnd: { type: MarkerType.ArrowClosed, color },
        animated: activeEdge || touchesSelectedNode,
        interactionWidth: 20,
        style: {
          stroke: color,
          strokeWidth: activeEdge ? 3 : touchesSelectedNode || highlightedByJob ? 2.2 : 1.4,
          opacity: activeEdge || touchesSelectedNode ? 0.95 : highlightedByJob ? 0.8 : 0.58,
        },
        labelStyle: {
          fill: activeEdge || touchesSelectedNode ? '#3730a3' : '#64748b',
          fontSize: 11,
          fontWeight: activeEdge || touchesSelectedNode ? 700 : 500,
        },
        labelBgStyle: {
          fill: '#ffffff',
          fillOpacity: 0.86,
        },
        labelBgPadding: [6, 3],
        labelBgBorderRadius: 6,
      };
    }),
    [highlights, selectedEdgeId, selectedNodeId, visibleEdges]
  );

  const handleRenderFault = useCallback(() => {
    setGraphRecoveryKey((key) => key + 1);
  }, []);

  if (nodes.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center rounded-lg border border-dashed border-gray-200 bg-gray-50 text-sm text-gray-400">
        No world-state nodes yet
      </div>
    );
  }

  return (
    <div className="grid min-w-0 gap-3 2xl:grid-cols-[minmax(0,1fr)_320px]">
      <ReactFlowProvider key={graphRecoveryKey}>
        <GraphFlowViewport
          flowNodes={flowNodes}
          flowEdges={flowEdges}
          graphSignature={graphSignature}
          onRenderFault={handleRenderFault}
          onNodeClick={(_: MouseEvent, node: WorldGraphFlowNode) => {
            setSelectedNodeId(node.id);
            setSelectedEdgeId(null);
          }}
          onEdgeClick={(event: MouseEvent, edge: WorldGraphFlowEdge) => {
            event.stopPropagation();
            setSelectedEdgeId(edge.id);
            setSelectedNodeId(null);
          }}
          onPaneClick={() => {
            setSelectedNodeId(null);
            setSelectedEdgeId(null);
          }}
        />
      </ReactFlowProvider>

      <div className="max-h-[640px] overflow-y-auto rounded-lg border border-gray-100 bg-white p-3">
        {selectedNode ? (
          <div className="space-y-3">
            <div>
              <h3 className="text-sm font-semibold text-gray-900">{selectedNode.name}</h3>
              <div className="mt-1 flex flex-wrap gap-2">
                <Badge>{selectedNode.type}</Badge>
                <Badge variant={selectedNode.timesUpdated > 2 ? 'purple' : 'default'}>
                  updated {selectedNode.timesUpdated}
                </Badge>
              </div>
            </div>
            <WorldNodeDetailBlocks summary={selectedNode.summary} />
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-400">Connected edges</h4>
              <div className="mt-2 space-y-2">
                {connectedEdges.length === 0 && (
                  <div className="rounded-lg bg-gray-50 p-2 text-xs text-gray-400">No direct edges</div>
                )}
                {connectedEdges.map((edge) => (
                  <button
                    key={edge.id}
                    type="button"
                    onClick={() => {
                      setSelectedEdgeId(edge.id);
                      setSelectedNodeId(null);
                    }}
                    className="w-full rounded-lg border border-gray-100 bg-gray-50 px-3 py-2 text-left text-xs transition-colors hover:border-indigo-100 hover:bg-indigo-50"
                  >
                    <div className="font-medium text-gray-900">
                      {edge.sourceName} {'->'} {edge.targetName}
                    </div>
                    <div className="mt-1 text-gray-500">{edge.relationType}</div>
                  </button>
                ))}
              </div>
            </div>
            {Object.keys(selectedNode.attributes ?? {}).length > 0 && (
              <pre className="max-h-40 overflow-auto rounded-lg bg-gray-50 p-2 text-xs text-gray-500">
                {JSON.stringify(selectedNode.attributes, null, 2)}
              </pre>
            )}
          </div>
        ) : selectedEdge ? (
          <div className="space-y-3">
            <div>
              <h3 className="text-sm font-semibold text-gray-900">{selectedEdge.relationType}</h3>
              <p className="mt-1 text-xs text-gray-500">
                {selectedEdge.sourceName} {'->'} {selectedEdge.targetName}
              </p>
            </div>
            <p className="text-sm leading-6 text-gray-600">{selectedEdge.summary}</p>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="rounded-lg bg-gray-50 p-2">
                <div className="font-semibold text-gray-900">{selectedEdge.weight}</div>
                <div className="text-gray-400">Weight</div>
              </div>
              <div className="rounded-lg bg-gray-50 p-2">
                <div className="font-semibold text-gray-900">{selectedEdge.timesUpdated}</div>
                <div className="text-gray-400">Updates</div>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex h-full min-h-40 items-center justify-center rounded-lg bg-gray-50 p-4 text-center text-sm text-gray-400">
            Click a node or edge to inspect its state and trace direct relationships.
          </div>
        )}
      </div>
    </div>
  );
}

function resultObject(job: WorldJob | undefined): Record<string, unknown> {
  if (!job || !job.result || typeof job.result !== 'object') return {};
  return job.result;
}

function graphSnapshotFromJob(job: WorldJob | undefined): JobGraphSnapshot | null {
  const result = resultObject(job);
  const snapshot = result.graphSnapshot;
  if (!snapshot || typeof snapshot !== 'object') return null;

  const rawSnapshot = snapshot as { nodes?: unknown; edges?: unknown };
  if (!Array.isArray(rawSnapshot.nodes) || !Array.isArray(rawSnapshot.edges)) return null;

  const nodes = rawSnapshot.nodes
    .filter((node): node is Partial<WorldNode> & { id: string; name: string } => (
      !!node &&
      typeof node === 'object' &&
      typeof (node as { id?: unknown }).id === 'string' &&
      typeof (node as { name?: unknown }).name === 'string'
    ))
    .map((node) => ({
      id: node.id,
      name: node.name,
      type: typeof node.type === 'string' ? node.type : 'entity',
      summary: typeof node.summary === 'string' ? node.summary : '',
      attributes: node.attributes && typeof node.attributes === 'object' && !Array.isArray(node.attributes)
        ? node.attributes
        : {},
      timesUpdated: typeof node.timesUpdated === 'number' ? node.timesUpdated : 0,
      updatedAt: typeof node.updatedAt === 'string' ? node.updatedAt : new Date(0).toISOString(),
    }));

  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = rawSnapshot.edges
    .filter((edge): edge is Partial<WorldEdge> & { id: string; sourceNodeId: string; targetNodeId: string } => (
      !!edge &&
      typeof edge === 'object' &&
      typeof (edge as { id?: unknown }).id === 'string' &&
      typeof (edge as { sourceNodeId?: unknown }).sourceNodeId === 'string' &&
      typeof (edge as { targetNodeId?: unknown }).targetNodeId === 'string' &&
      nodeIds.has((edge as { sourceNodeId: string }).sourceNodeId) &&
      nodeIds.has((edge as { targetNodeId: string }).targetNodeId)
    ))
    .map((edge) => {
      const sourceName = nodes.find((node) => node.id === edge.sourceNodeId)?.name ?? edge.sourceNodeId;
      const targetName = nodes.find((node) => node.id === edge.targetNodeId)?.name ?? edge.targetNodeId;
      return {
        id: edge.id,
        sourceNodeId: edge.sourceNodeId,
        targetNodeId: edge.targetNodeId,
        sourceName: typeof edge.sourceName === 'string' ? edge.sourceName : sourceName,
        targetName: typeof edge.targetName === 'string' ? edge.targetName : targetName,
        relationType: typeof edge.relationType === 'string' ? edge.relationType : 'RELATED_TO',
        summary: typeof edge.summary === 'string' ? edge.summary : '',
        weight: typeof edge.weight === 'number' ? edge.weight : 1,
        timesUpdated: typeof edge.timesUpdated === 'number' ? edge.timesUpdated : 0,
        updatedAt: typeof edge.updatedAt === 'string' ? edge.updatedAt : new Date(0).toISOString(),
      };
    });

  return { nodes, edges };
}

function rawSnapshotSignature(job: WorldJob | undefined): string {
  if (!job) return 'none';

  const result = resultObject(job);
  const snapshot = result.graphSnapshot;
  if (!snapshot || typeof snapshot !== 'object') {
    return `${job.id}:no-snapshot`;
  }

  const rawSnapshot = snapshot as { nodes?: unknown; edges?: unknown };
  if (!Array.isArray(rawSnapshot.nodes) || !Array.isArray(rawSnapshot.edges)) {
    return `${job.id}:invalid-snapshot`;
  }

  const snapshotAt = typeof result.graphSnapshotAt === 'string' ? result.graphSnapshotAt : '';
  const nodeSignature = rawSnapshot.nodes
    .map((node) => {
      if (!node || typeof node !== 'object') return '';
      const rawNode = node as { id?: unknown; updatedAt?: unknown; timesUpdated?: unknown };
      return [
        typeof rawNode.id === 'string' ? rawNode.id : '',
        typeof rawNode.updatedAt === 'string' ? rawNode.updatedAt : '',
        typeof rawNode.timesUpdated === 'number' ? rawNode.timesUpdated : '',
      ].join(':');
    })
    .sort()
    .join('|');
  const edgeSignature = rawSnapshot.edges
    .map((edge) => {
      if (!edge || typeof edge !== 'object') return '';
      const rawEdge = edge as {
        id?: unknown;
        sourceNodeId?: unknown;
        targetNodeId?: unknown;
        updatedAt?: unknown;
        timesUpdated?: unknown;
      };
      return [
        typeof rawEdge.id === 'string' ? rawEdge.id : '',
        typeof rawEdge.sourceNodeId === 'string' ? rawEdge.sourceNodeId : '',
        typeof rawEdge.targetNodeId === 'string' ? rawEdge.targetNodeId : '',
        typeof rawEdge.updatedAt === 'string' ? rawEdge.updatedAt : '',
        typeof rawEdge.timesUpdated === 'number' ? rawEdge.timesUpdated : '',
      ].join(':');
    })
    .sort()
    .join('|');

  return `${job.id}:${snapshotAt}:${nodeSignature}::${edgeSignature}`;
}

function useStableJobSnapshot(job: WorldJob | undefined): JobGraphSnapshot | null {
  const snapshotCache = useRef<{ key: string; snapshot: JobGraphSnapshot | null }>({
    key: '',
    snapshot: null,
  });
  const key = rawSnapshotSignature(job);

  if (snapshotCache.current.key !== key) {
    snapshotCache.current = {
      key,
      snapshot: graphSnapshotFromJob(job),
    };
  }

  return snapshotCache.current.snapshot;
}

function affectedJobLabels(job: WorldJob): string[] {
  const result = resultObject(job);
  const labels = new Set<string>();
  const affectedNodes = Array.isArray(result.affectedNodes)
    ? result.affectedNodes as AffectedNodeResult[]
    : [];

  for (const node of affectedNodes) {
    if (node.name) labels.add(`${node.name}${node.role ? ` (${node.role})` : ''}`);
  }

  const names = result.affectedNodeNames as AffectedNodeNamesResult | undefined;
  for (const name of names?.direct ?? []) labels.add(`${name} (direct)`);
  for (const name of names?.cascade ?? []) labels.add(`${name} (cascade)`);
  for (const name of names?.related ?? []) labels.add(`${name} (related)`);

  return Array.from(labels);
}

function JobDetail({ job }: { job: WorldJob | undefined }) {
  if (!job) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center bg-gray-50 p-4 text-center text-sm text-gray-400">
        Select a running task to inspect its headline, stage, affected nodes, and raw result data.
      </div>
    );
  }

  const affectedLabels = affectedJobLabels(job);
  const result = resultObject(job);
  const graphSnapshot = graphSnapshotFromJob(job);
  const snapshotAt = typeof result.graphSnapshotAt === 'string' ? result.graphSnapshotAt : null;
  const { graphSnapshot: _graphSnapshot, ...displayResult } = result;

  return (
    <div className="h-full min-h-0 space-y-3 overflow-y-auto bg-white p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-sm font-semibold text-gray-900">{job.agent}</div>
          <div className="mt-0.5 text-xs text-gray-400">{job.kind} / {formatTime(job.updatedAt)}</div>
        </div>
        <Badge variant={statusVariant(job.status)}>{job.status}</Badge>
      </div>
      <div className="rounded-lg bg-gray-50 p-3">
        <div className="text-xs font-semibold uppercase tracking-wider text-gray-400">Stage</div>
        <div className="mt-1 text-sm text-gray-800">{stageLabel(job.stage)}</div>
      </div>
      <div className="rounded-lg bg-gray-50 p-3">
        <div className="text-xs font-semibold uppercase tracking-wider text-gray-400">Graph trace</div>
        <div className="mt-1 text-sm text-gray-800">
          {graphSnapshot
            ? `${graphSnapshot.nodes.length} nodes / ${graphSnapshot.edges.length} edges${snapshotAt ? ` at ${formatTime(snapshotAt)}` : ''}`
            : 'No snapshot stored for this job'}
        </div>
      </div>
      {job.headlineText && (
        <div>
          <div className="text-xs font-semibold uppercase tracking-wider text-gray-400">Headline</div>
          <p className="mt-1 text-sm leading-6 text-gray-600">{job.headlineText}</p>
        </div>
      )}
      {affectedLabels.length > 0 && (
        <div>
          <div className="text-xs font-semibold uppercase tracking-wider text-gray-400">Affected nodes</div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {affectedLabels.map((label) => (
              <Badge key={label} variant="blue">{label}</Badge>
            ))}
          </div>
        </div>
      )}
      {(job.reactions?.length ?? 0) > 0 && (
        <div>
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs font-semibold uppercase tracking-wider text-gray-400">Node reactions</div>
            <Badge variant="default">{job.reactions?.length ?? 0}</Badge>
          </div>
          <div className="mt-2 max-h-72 space-y-2 overflow-y-auto pr-1">
            {(job.reactions ?? []).map((reaction) => (
              <div key={reaction.id} className="rounded-lg border border-gray-100 bg-gray-50 p-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0 text-sm font-medium text-gray-900">
                    {reaction.nodeName}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Badge
                      variant={
                        reaction.status === 'affected'
                          ? 'green'
                          : reaction.status === 'error'
                            ? 'red'
                            : reaction.status === 'skipped'
                              ? 'yellow'
                              : 'default'
                      }
                    >
                      {reaction.status}
                    </Badge>
                    <Badge variant="purple">d{reaction.depth}</Badge>
                  </div>
                </div>
                <div className="mt-1 text-xs text-gray-400">
                  {reaction.sourceNodeName ? `${reaction.sourceNodeName} -> ` : 'headline -> '}
                  {reaction.nodeName}
                  {reaction.confidence !== null && reaction.confidence !== undefined
                    ? ` / confidence ${Number(reaction.confidence).toFixed(2)}`
                    : ''}
                </div>
                {reaction.stateDelta && (
                  <p className="mt-2 text-xs leading-5 text-gray-700">{reaction.stateDelta}</p>
                )}
                {reaction.rationale && (
                  <p className="mt-1 text-xs leading-5 text-gray-500">{reaction.rationale}</p>
                )}
                {Array.isArray(reaction.emittedEvents) && reaction.emittedEvents.length > 0 && (
                  <div className="mt-2 text-xs text-gray-400">
                    emitted {reaction.emittedEvents.length} event{reaction.emittedEvents.length === 1 ? '' : 's'}
                  </div>
                )}
                {reaction.error && (
                  <div className="mt-2 rounded bg-red-50 px-2 py-1 text-xs text-red-600">{reaction.error}</div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      {job.error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{job.error}</div>}
      <div>
        <div className="text-xs font-semibold uppercase tracking-wider text-gray-400">Result data</div>
        <pre className="mt-2 max-h-52 overflow-auto rounded-lg bg-gray-950 p-3 text-xs leading-5 text-gray-100">
          {Object.keys(displayResult).length > 0 ? JSON.stringify(displayResult, null, 2) : 'No result data yet.'}
        </pre>
      </div>
    </div>
  );
}

export function AdminPage() {
  const navigate = useNavigate();
  const [passwordInput, setPasswordInput] = useState('');
  const [password, setPassword] = useState(() => localStorage.getItem('futureHeadlines_adminPassword') ?? '');
  const [sessions, setSessions] = useState<AdminSessionSummary[]>([]);
  const [selectedJoinCode, setSelectedJoinCode] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [worldState, setWorldState] = useState<WorldStateResponse | null>(null);
  const [helperMessages, setHelperMessages] = useState<WorldHelperMessage[]>([]);
  const [configDraft, setConfigDraft] = useState<ConfigDraft | null>(null);
  const [draftDirty, setDraftDirty] = useState(false);
  const [showRunningTasks, setShowRunningTasks] = useState(false);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const adminFetch = useCallback(
    async (path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      headers.set('x-admin-password', password);
      if (init.body) headers.set('Content-Type', 'application/json');

      const response = await fetch(`${API_URL}${path}`, { ...init, headers });
      return readJson(response);
    },
    [password]
  );

  const loadSessions = useCallback(async () => {
    if (!password) return;
    const query = showArchived ? '?includeArchived=true' : '';
    const data = await adminFetch(`/api/admin/sessions${query}`);
    setSessions(data.sessions ?? []);
    const selectedStillVisible = data.sessions?.some((session: AdminSessionSummary) => session.joinCode === selectedJoinCode);
    if (selectedJoinCode && !selectedStillVisible) {
      setSelectedJoinCode(data.sessions?.[0]?.joinCode ?? '');
      setWorldState(null);
      setHelperMessages([]);
      setConfigDraft(null);
      setDraftDirty(false);
    } else if (!selectedJoinCode && data.sessions?.[0]?.joinCode) {
      setSelectedJoinCode(data.sessions[0].joinCode);
    }
  }, [adminFetch, password, selectedJoinCode, showArchived]);

  const loadWorldState = useCallback(async () => {
    if (!password || !selectedJoinCode) return;
    const [data, helperData] = await Promise.all([
      adminFetch(`/api/admin/sessions/${selectedJoinCode}/world-state`),
      adminFetch(`/api/admin/sessions/${selectedJoinCode}/world-helper/messages`),
    ]);
    setWorldState(data);
    setHelperMessages(helperData.messages ?? []);
    setError('');
  }, [adminFetch, password, selectedJoinCode]);

  useEffect(() => {
    if (!password) return;
    loadSessions().catch((err: Error) => setError(err.message));
  }, [loadSessions, password]);

  useEffect(() => {
    if (!selectedJoinCode) return;
    loadWorldState().catch((err: Error) => setError(err.message));
  }, [loadWorldState, selectedJoinCode]);

  useEffect(() => {
    if (!password || !selectedJoinCode) return;
    const handle = window.setInterval(() => {
      loadWorldState().catch((err: Error) => setError(err.message));
    }, 2500);
    return () => window.clearInterval(handle);
  }, [loadWorldState, password, selectedJoinCode]);

  useEffect(() => {
    if (!worldState || draftDirty) return;
    setConfigDraft(draftFromState(worldState));
  }, [worldState, draftDirty]);

  useEffect(() => {
    if (!worldState) return;
    const currentStillExists = selectedJobId && worldState.jobs.some((job) => job.id === selectedJobId);
    if (currentStillExists) return;
    const nextJob =
      worldState.jobs.find((job) => job.status === 'running') ??
      (worldState.session.phase === 'FINISHED'
        ? worldState.jobs[worldState.jobs.length - 1]
        : worldState.jobs[0]);
    setSelectedJobId(nextJob?.id ?? null);
  }, [selectedJobId, worldState]);

  const submitLogin = (event: FormEvent) => {
    event.preventDefault();
    const nextPassword = passwordInput.trim();
    localStorage.setItem('futureHeadlines_adminPassword', nextPassword);
    setPassword(nextPassword);
    setPasswordInput('');
    setError('');
  };

  const patchDraft = (patch: Partial<ConfigDraft>) => {
    setConfigDraft((prev) => (prev ? { ...prev, ...patch } : prev));
    setDraftDirty(true);
  };

  const patchAiDraft = (playerId: string, patch: Partial<AiDraft>) => {
    setConfigDraft((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        aiPlayers: {
          ...prev.aiPlayers,
          [playerId]: { ...prev.aiPlayers[playerId], ...patch },
        },
      };
    });
    setDraftDirty(true);
  };

  const patchModuleDraft = (moduleName: ModuleLlmName, patch: Partial<LlmDraft>) => {
    setConfigDraft((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        moduleLlmConfig: {
          ...prev.moduleLlmConfig,
          [moduleName]: {
            ...prev.moduleLlmConfig[moduleName],
            ...patch,
          },
        },
      };
    });
    setDraftDirty(true);
  };

  const saveConfig = async () => {
    if (!configDraft || !selectedJoinCode) return;
    setBusy(true);
    setError('');
    try {
      const data = await adminFetch(`/api/admin/sessions/${selectedJoinCode}/config`, {
        method: 'PATCH',
        body: JSON.stringify({
          title: configDraft.title.trim() || 'Future Headlines',
          playMinutes: Number(configDraft.playMinutes),
          breakMinutes: Number(configDraft.breakMinutes),
          maxRounds: Number(configDraft.maxRounds),
          timelineSpeedRatio: Number(configDraft.timelineSpeedRatio),
          worldStateEnabled: configDraft.worldStateEnabled,
          worldStateConfig: {
            allowCycles: configDraft.allowCycles,
            maxPropagationDepth: Number(configDraft.maxPropagationDepth),
            maxNodeReactions: Number(configDraft.maxNodeReactions),
            maxEventsPerNode: Number(configDraft.maxEventsPerNode),
            nodeAgentConcurrency: Number(configDraft.nodeAgentConcurrency),
            storeUnaffectedDecisions: configDraft.storeUnaffectedDecisions,
            retrievalStrategy: configDraft.retrievalStrategy,
            maxContextNodes: Number(configDraft.maxContextNodes),
            maxNeighborsPerNode: Number(configDraft.maxNeighborsPerNode),
            maxCandidateNeighbors: Number(configDraft.maxCandidateNeighbors),
            connectionDisplayThreshold: Number(configDraft.connectionDisplayThreshold),
            propagationRandomMode: configDraft.propagationRandomMode,
          },
          llmConfig: {
            provider: configDraft.provider,
            model: configDraft.model,
            baseUrl: configDraft.baseUrl,
          },
          moduleLlmConfig: Object.fromEntries(
            MODULE_LLM_LABELS.map(({ key }) => [
              key,
              configDraft.moduleLlmConfig[key],
            ])
          ),
          summaryConfig: {
            roundSummaries: configDraft.roundSummaries,
            finalNarrative: configDraft.finalNarrative,
          },
          aiPlayers: Object.entries(configDraft.aiPlayers).map(([id, draft]) => ({
            id,
            nickname: draft.nickname,
            aiConfig: {
              stylePrompt: draft.stylePrompt,
              creativity: Number(draft.creativity),
              submitEverySeconds: Number(draft.submitEverySeconds),
              helperActivity: Number(draft.helperActivity),
              provider: draft.provider,
              model: draft.model,
            },
          })),
        }),
      });
      setWorldState(data);
      setConfigDraft(draftFromState(data));
      setDraftDirty(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save config');
    } finally {
      setBusy(false);
    }
  };

  const rebuildGraph = async () => {
    if (!selectedJoinCode) return;
    setBusy(true);
    setError('');
    try {
      await adminFetch(`/api/admin/sessions/${selectedJoinCode}/world-state/rebuild`, { method: 'POST' });
      await loadWorldState();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to rebuild graph');
    } finally {
      setBusy(false);
    }
  };

  const togglePause = async () => {
    if (!selectedJoinCode || !worldState) return;
    setBusy(true);
    setError('');
    try {
      const action = worldState.session.isPaused ? 'resume' : 'pause';
      const data = await adminFetch(`/api/admin/sessions/${selectedJoinCode}/${action}`, { method: 'POST' });
      setWorldState(data);
      await loadSessions();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update pause state');
    } finally {
      setBusy(false);
    }
  };

  const toggleArchive = async () => {
    if (!selectedJoinCode || !worldState) return;
    const isArchived = Boolean(worldState.session.archivedAt);
    const action = isArchived ? 'unarchive' : 'archive';
    const title = worldState.session.title || selectedJoinCode;
    const confirmed = window.confirm(
      isArchived
        ? `Unarchive "${title}"?`
        : `Archive "${title}"? Active timers and AI players for this session will stop.`
    );
    if (!confirmed) return;

    setBusy(true);
    setError('');
    try {
      const data = await adminFetch(`/api/admin/sessions/${selectedJoinCode}/${action}`, { method: 'POST' });
      setWorldState(data);
      setConfigDraft(draftFromState(data));
      setDraftDirty(false);
      await loadSessions();
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to ${action} session`);
    } finally {
      setBusy(false);
    }
  };

  const deleteSession = async () => {
    if (!selectedJoinCode || !worldState) return;
    const title = worldState.session.title || selectedJoinCode;
    const confirmed = window.confirm(
      `Delete "${title}" permanently? This removes players, headlines, summaries, world graph data, and helper history.`
    );
    if (!confirmed) return;

    setBusy(true);
    setError('');
    try {
      await adminFetch(`/api/admin/sessions/${selectedJoinCode}`, { method: 'DELETE' });
      setWorldState(null);
      setHelperMessages([]);
      setConfigDraft(null);
      setDraftDirty(false);
      await loadSessions();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete session');
    } finally {
      setBusy(false);
    }
  };

  const isFinishedSession = worldState?.session.phase === 'FINISHED';
  const canPauseSelectedSession = Boolean(
    worldState &&
    worldState.session.phase !== 'WAITING' &&
    worldState.session.phase !== 'FINISHED'
  );
  const runningJobs = worldState?.jobs.filter((job) => job.status === 'running') ?? [];
  const processingJobs = isFinishedSession
    ? worldState?.jobs ?? []
    : runningJobs;
  const showAllProcessingJobs = isFinishedSession || showRunningTasks;
  const visibleProcessingJobs = showAllProcessingJobs ? processingJobs : processingJobs.slice(0, 3);
  const selectedJob = worldState?.jobs.find((job) => job.id === selectedJobId)
    ?? runningJobs[0]
    ?? worldState?.jobs[0];
  const selectedJobSnapshot = useStableJobSnapshot(selectedJob);
  const latestCompletedUpdate = worldState?.jobs.find((job) => job.status === 'completed' && job.kind === 'headline');
  const runningJobSignature = runningJobs
    .map((job) => `${job.id}:${job.status}:${job.stage}:${job.updatedAt}`)
    .join('|');
  const highlightedJobs = [
    ...runningJobs,
    ...(latestCompletedUpdate ? [latestCompletedUpdate] : []),
  ];
  const graphNodes = selectedJobSnapshot?.nodes ?? worldState?.nodes ?? [];
  const graphEdges = selectedJobSnapshot?.edges ?? worldState?.edges ?? [];
  const graphHighlightJobs = selectedJobSnapshot && selectedJob
    ? [selectedJob]
    : highlightedJobs;
  const nodeHighlights = useMemo(
    () => worldState ? collectNodeHighlights(graphNodes, graphHighlightJobs) : new Map<string, 1 | 2 | 3>(),
    [
      Boolean(worldState),
      graphNodes,
      selectedJobSnapshot,
      selectedJob?.id,
      selectedJob?.updatedAt,
      latestCompletedUpdate?.id,
      latestCompletedUpdate?.updatedAt,
      runningJobSignature,
    ]
  );

  if (!password) {
    return (
      <div className="flex h-[100dvh] items-center justify-center overflow-y-auto bg-gradient-to-b from-gray-50 to-gray-100/80 p-6">
        <Card padding="lg" className="w-full max-w-sm space-y-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Admin</h1>
            <p className="text-sm text-gray-500">World-state and game controls</p>
          </div>
          <form onSubmit={submitLogin} className="space-y-3">
            <input
              type="password"
              value={passwordInput}
              onChange={(event) => setPasswordInput(event.target.value)}
              placeholder="Password"
              className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
            />
            <Button fullWidth type="submit">Login</Button>
          </form>
        </Card>
      </div>
    );
  }

  return (
    <div className="h-[100dvh] overflow-y-auto bg-gradient-to-b from-gray-50 to-gray-100/80 p-4 sm:p-6">
      <div className="mx-auto max-w-7xl space-y-4">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">Admin</h1>
            <p className="text-sm text-gray-500">World-state graph, parallel processing, and game parameters</p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={() => navigate('/admin/evaluations')}>
              Evaluation Mode
            </Button>
            <Button
              variant="secondary"
              onClick={() => selectedJoinCode && navigate(`/admin/summary/${selectedJoinCode}`)}
              disabled={!selectedJoinCode}
            >
              Show Summary Page
            </Button>
            {worldState && (
              <Button
                variant={worldState.session.isPaused ? 'secondary' : 'ghost'}
                onClick={togglePause}
                disabled={!selectedJoinCode || !canPauseSelectedSession || busy}
              >
                {worldState.session.isPaused ? 'Resume Game' : 'Pause Game'}
              </Button>
            )}
            {worldState && (
              <Button
                variant="ghost"
                onClick={toggleArchive}
                disabled={!selectedJoinCode || busy}
              >
                {worldState.session.archivedAt ? 'Unarchive Session' : 'Archive Session'}
              </Button>
            )}
            {worldState && (
              <Button
                variant="ghost"
                onClick={deleteSession}
                disabled={!selectedJoinCode || busy}
                className="text-red-600 hover:bg-red-50 hover:text-red-700"
              >
                Delete Session
              </Button>
            )}
            <Button variant="secondary" onClick={() => loadWorldState()} disabled={!selectedJoinCode || busy}>
              Refresh
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                localStorage.removeItem('futureHeadlines_adminPassword');
                setPassword('');
                setWorldState(null);
              }}
            >
              Logout
            </Button>
          </div>
        </header>

        {error && <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-600">{error}</div>}

        <div className="grid min-w-0 gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
          <aside className="min-w-0 lg:sticky lg:top-4 lg:max-h-[calc(100dvh-2rem)]">
            <Card padding="md" className="flex max-h-[calc(100dvh-8rem)] flex-col space-y-3 overflow-hidden">
              <div className="flex items-center justify-between">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-400">Sessions</h2>
                <Button variant="ghost" size="sm" onClick={() => loadSessions()}>Reload</Button>
              </div>
              <label className="flex items-center justify-between rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-500">
                Show archived
                <input
                  type="checkbox"
                  checked={showArchived}
                  onChange={(event) => setShowArchived(event.target.checked)}
                  className="h-4 w-4 accent-indigo-600"
                />
              </label>
              <div data-testid="admin-session-list" className="min-h-0 space-y-2 overflow-y-auto pr-1">
                {sessions.map((session) => (
                  <button
                    key={session.id}
                    type="button"
                    onClick={() => {
                      setSelectedJoinCode(session.joinCode);
                      setDraftDirty(false);
                    }}
                    className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${
                      selectedJoinCode === session.joinCode
                        ? 'border-indigo-200 bg-indigo-50'
                        : 'border-gray-100 bg-gray-50 hover:bg-gray-100'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="min-w-0 truncate text-sm font-semibold text-gray-900">
                        {session.title || 'Future Headlines'}
                      </span>
                      <Badge variant={session.isPaused ? 'yellow' : session.phase === 'PLAYING' ? 'green' : 'default'}>
                        {session.archivedAt ? 'ARCHIVED' : session.isPaused ? 'PAUSED' : session.phase}
                      </Badge>
                    </div>
                    <div className="mt-1 flex items-center justify-between gap-2 text-xs text-gray-500">
                      <span>Round {session.currentRound} / {session.playerCount} players</span>
                      <span className="font-mono text-gray-400">{session.joinCode}</span>
                    </div>
                  </button>
                ))}
                {sessions.length === 0 && (
                  <div className="rounded-lg bg-gray-50 p-3 text-sm text-gray-400">No sessions found</div>
                )}
              </div>
            </Card>
          </aside>

          <main className="min-w-0 space-y-4">
            {worldState && (
              <>
                <Card padding="md" className="flex h-[560px] min-w-0 flex-col gap-3 overflow-hidden" data-testid="admin-processing-panel">
                  <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
                    <div>
                      <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-400">Processing</h2>
                      <p className="mt-1 text-sm text-gray-500">
                        {isFinishedSession
                          ? 'Completed world-state trace history'
                          : 'Live world-state tasks and stage details'}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant={runningJobs.length > 0 ? 'blue' : 'default'}>
                        {runningJobs.length} running
                      </Badge>
                      {isFinishedSession ? (
                        <Badge variant="purple">{processingJobs.length} trace jobs</Badge>
                      ) : (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => setShowRunningTasks((current) => !current)}
                          disabled={processingJobs.length === 0}
                        >
                          {showRunningTasks ? 'Collapse Tasks' : 'Open Running Tasks'}
                        </Button>
                      )}
                    </div>
                  </div>
                  <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_minmax(0,1fr)] gap-3 xl:grid-cols-[minmax(0,1fr)_420px] xl:grid-rows-1">
                    <section data-testid="admin-processing-jobs" className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-gray-100 bg-gray-50/50">
                      <div className="grid shrink-0 gap-2 p-3 sm:grid-cols-3">
                        <div className="rounded-lg bg-white p-3 shadow-sm">
                          <div className="text-2xl font-semibold text-gray-900">{worldState.stats.runningJobs}</div>
                          <div className="text-xs text-gray-400">Running</div>
                        </div>
                        <div className="rounded-lg bg-white p-3 shadow-sm">
                          <div className="text-2xl font-semibold text-gray-900">{worldState.stats.queuedJobs}</div>
                          <div className="text-xs text-gray-400">Queued legacy</div>
                        </div>
                        <div className="rounded-lg bg-white p-3 shadow-sm">
                          <div className="text-2xl font-semibold text-gray-900">{worldState.jobs.length}</div>
                          <div className="text-xs text-gray-400">Loaded jobs</div>
                        </div>
                      </div>
                      {processingJobs.length > 0 ? (
                        <div data-testid="admin-processing-job-list" className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 pb-3">
                          {visibleProcessingJobs.map((job) => {
                            const hasSnapshot = graphSnapshotFromJob(job) !== null;
                            return (
                            <button
                              key={job.id}
                              type="button"
                              onClick={() => setSelectedJobId(job.id)}
                              className={`w-full rounded-lg border p-3 text-left text-sm transition-colors ${
                                selectedJob?.id === job.id
                                  ? 'border-indigo-200 bg-indigo-50'
                                  : 'border-blue-100 bg-blue-50 hover:border-indigo-100 hover:bg-indigo-50'
                              }`}
                            >
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <div className="font-medium text-gray-900">{job.agent}</div>
                                <div className="flex items-center gap-1.5">
                                  {isFinishedSession && (
                                    <Badge variant={hasSnapshot ? 'purple' : 'default'}>
                                      {hasSnapshot ? 'snapshot' : 'no snapshot'}
                                    </Badge>
                                  )}
                                  <Badge variant={statusVariant(job.status)}>{stageLabel(job.stage)}</Badge>
                                </div>
                              </div>
                              {job.headlineText && (
                                <div className="mt-2 line-clamp-2 text-xs text-gray-600">{job.headlineText}</div>
                              )}
                              <div className="mt-2 text-xs text-gray-400">Updated {formatTime(job.updatedAt)}</div>
                            </button>
                          );})}
                          {!showAllProcessingJobs && processingJobs.length > visibleProcessingJobs.length && (
                            <button
                              type="button"
                              onClick={() => setShowRunningTasks(true)}
                              className="w-full rounded-lg border border-dashed border-gray-200 px-3 py-2 text-sm text-gray-500 hover:bg-gray-50"
                            >
                              Show {processingJobs.length - visibleProcessingJobs.length} more {isFinishedSession ? 'jobs' : 'running tasks'}
                            </button>
                          )}
                        </div>
                      ) : (
                        <div className="rounded-lg bg-gray-50 p-3 text-sm text-gray-500">
                          {isFinishedSession ? 'No world-state jobs were recorded' : 'No active world-state job'}
                        </div>
                      )}
                    </section>
                    <section data-testid="admin-processing-detail" className="min-h-0 overflow-hidden rounded-lg border border-gray-100 bg-white">
                      <JobDetail job={selectedJob} />
                    </section>
                  </div>
                </Card>

                <div className="min-w-0">
                  <Card padding="md" className="min-w-0 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-400">World Graph</h2>
                        <p className="mt-1 text-sm text-gray-500">
                          {selectedJobSnapshot && selectedJob
                            ? `Snapshot after ${selectedJob.kind} job at ${formatTime(selectedJob.updatedAt)}`
                            : 'Current world-state graph'}
                        </p>
                        <div className="mt-1 flex gap-2">
                          <Badge variant="blue">{graphNodes.length} nodes</Badge>
                          <Badge variant="purple">{graphEdges.length} edges</Badge>
                          {selectedJobSnapshot && <Badge variant="green">trace view</Badge>}
                        </div>
                      </div>
                      <Button variant="secondary" onClick={rebuildGraph} disabled={busy}>
                        Rebuild Initial Graph
                      </Button>
                    </div>
                    <GraphCanvas nodes={graphNodes} edges={graphEdges} highlights={nodeHighlights} />
                  </Card>
                </div>

                {configDraft && (
                    <Card padding="md" className="max-h-[520px] min-w-0 space-y-3 overflow-y-auto" data-testid="admin-parameters-panel">
                      <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-400">Game Parameters</h2>
                      <label className="block text-xs text-gray-500">
                        Session title
                        <input
                          value={configDraft.title}
                          maxLength={80}
                          onChange={(event) => patchDraft({ title: event.target.value })}
                          className="mt-1 w-full rounded-lg border border-gray-200 bg-gray-50 px-2 py-1.5 text-sm"
                        />
                      </label>
                      <div className="grid grid-cols-2 gap-2">
                        <label className="text-xs text-gray-500">
                          Play minutes
                          <input
                            value={configDraft.playMinutes}
                            onChange={(event) => patchDraft({ playMinutes: event.target.value })}
                            className="mt-1 w-full rounded-lg border border-gray-200 bg-gray-50 px-2 py-1.5 text-sm"
                          />
                        </label>
                        <label className="text-xs text-gray-500">
                          Break minutes
                          <input
                            value={configDraft.breakMinutes}
                            onChange={(event) => patchDraft({ breakMinutes: event.target.value })}
                            className="mt-1 w-full rounded-lg border border-gray-200 bg-gray-50 px-2 py-1.5 text-sm"
                          />
                        </label>
                        <label className="text-xs text-gray-500">
                          Max rounds
                          <input
                            value={configDraft.maxRounds}
                            onChange={(event) => patchDraft({ maxRounds: event.target.value })}
                            className="mt-1 w-full rounded-lg border border-gray-200 bg-gray-50 px-2 py-1.5 text-sm"
                          />
                        </label>
                        <label className="text-xs text-gray-500">
                          Speed ratio
                          <input
                            value={configDraft.timelineSpeedRatio}
                            onChange={(event) => patchDraft({ timelineSpeedRatio: event.target.value })}
                            className="mt-1 w-full rounded-lg border border-gray-200 bg-gray-50 px-2 py-1.5 text-sm"
                          />
                        </label>
                      </div>

                      <label className="flex items-center justify-between rounded-lg bg-gray-50 px-3 py-2 text-sm text-gray-700">
                        World-state tracker
                        <input
                          type="checkbox"
                          checked={configDraft.worldStateEnabled}
                          onChange={(event) => patchDraft({ worldStateEnabled: event.target.checked })}
                          className="h-4 w-4"
                        />
                      </label>

                      <div className="space-y-2 rounded-lg border border-gray-100 p-3">
                        <div className="flex items-center justify-between gap-2">
                          <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400">World Graph Propagation</h3>
                          <label className="flex items-center gap-2 text-xs text-gray-600">
                            Cycles
                            <input
                              type="checkbox"
                              checked={configDraft.allowCycles}
                              onChange={(event) => patchDraft({ allowCycles: event.target.checked })}
                              className="h-4 w-4"
                            />
                          </label>
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <label className="text-xs text-gray-500">
                            Max depth
                            <input
                              value={configDraft.maxPropagationDepth}
                              onChange={(event) => patchDraft({ maxPropagationDepth: event.target.value })}
                              className="mt-1 w-full rounded-lg border border-gray-200 bg-gray-50 px-2 py-1.5 text-sm"
                            />
                          </label>
                          <label className="text-xs text-gray-500">
                            Max reactions
                            <input
                              value={configDraft.maxNodeReactions}
                              onChange={(event) => patchDraft({ maxNodeReactions: event.target.value })}
                              className="mt-1 w-full rounded-lg border border-gray-200 bg-gray-50 px-2 py-1.5 text-sm"
                            />
                          </label>
                          <label className="text-xs text-gray-500">
                            Events per node
                            <input
                              value={configDraft.maxEventsPerNode}
                              onChange={(event) => patchDraft({ maxEventsPerNode: event.target.value })}
                              className="mt-1 w-full rounded-lg border border-gray-200 bg-gray-50 px-2 py-1.5 text-sm"
                            />
                          </label>
                          <label className="text-xs text-gray-500">
                            Agent concurrency
                            <input
                              value={configDraft.nodeAgentConcurrency}
                              onChange={(event) => patchDraft({ nodeAgentConcurrency: event.target.value })}
                              className="mt-1 w-full rounded-lg border border-gray-200 bg-gray-50 px-2 py-1.5 text-sm"
                            />
                          </label>
                        </div>
                        <label className="flex items-center justify-between rounded-lg bg-gray-50 px-3 py-2 text-sm text-gray-700">
                          Store unaffected decisions
                          <input
                            type="checkbox"
                            checked={configDraft.storeUnaffectedDecisions}
                            onChange={(event) => patchDraft({ storeUnaffectedDecisions: event.target.checked })}
                            className="h-4 w-4"
                          />
                        </label>
                        <div className="grid grid-cols-2 gap-2">
                          <label className="text-xs text-gray-500">
                            Retrieval
                            <DropdownSelect
                              value={configDraft.retrievalStrategy}
                              options={RETRIEVAL_STRATEGY_OPTIONS}
                              onChange={(value) => patchDraft({ retrievalStrategy: normalizeRetrievalStrategy(value) })}
                              ariaLabel="Admin world retrieval strategy"
                              size="sm"
                            />
                          </label>
                          <label className="text-xs text-gray-500">
                            Random mode
                            <DropdownSelect
                              value={configDraft.propagationRandomMode}
                              options={PROPAGATION_RANDOM_OPTIONS}
                              onChange={(value) => patchDraft({ propagationRandomMode: normalizePropagationRandomMode(value) })}
                              ariaLabel="Admin propagation random mode"
                              size="sm"
                            />
                          </label>
                          <label className="text-xs text-gray-500">
                            Context nodes
                            <input
                              value={configDraft.maxContextNodes}
                              onChange={(event) => patchDraft({ maxContextNodes: event.target.value })}
                              className="mt-1 w-full rounded-lg border border-gray-200 bg-gray-50 px-2 py-1.5 text-sm"
                            />
                          </label>
                          <label className="text-xs text-gray-500">
                            Neighbors/node
                            <input
                              value={configDraft.maxNeighborsPerNode}
                              onChange={(event) => patchDraft({ maxNeighborsPerNode: event.target.value })}
                              className="mt-1 w-full rounded-lg border border-gray-200 bg-gray-50 px-2 py-1.5 text-sm"
                            />
                          </label>
                          <label className="text-xs text-gray-500">
                            Candidate neighbors
                            <input
                              value={configDraft.maxCandidateNeighbors}
                              onChange={(event) => patchDraft({ maxCandidateNeighbors: event.target.value })}
                              className="mt-1 w-full rounded-lg border border-gray-200 bg-gray-50 px-2 py-1.5 text-sm"
                            />
                          </label>
                          <label className="text-xs text-gray-500">
                            Display threshold
                            <input
                              value={configDraft.connectionDisplayThreshold}
                              onChange={(event) => patchDraft({ connectionDisplayThreshold: event.target.value })}
                              className="mt-1 w-full rounded-lg border border-gray-200 bg-gray-50 px-2 py-1.5 text-sm"
                            />
                          </label>
                        </div>
                      </div>

                      <div className="space-y-2 rounded-lg border border-gray-100 p-3">
                        <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400">Summary Generation</h3>
                        <label className="flex items-center justify-between rounded-lg bg-gray-50 px-3 py-2 text-sm text-gray-700">
                          Round summaries
                          <input
                            type="checkbox"
                            checked={configDraft.roundSummaries}
                            onChange={(event) => patchDraft({ roundSummaries: event.target.checked })}
                            className="h-4 w-4"
                          />
                        </label>
                        <label className="flex items-center justify-between rounded-lg bg-gray-50 px-3 py-2 text-sm text-gray-700">
                          Final narrative
                          <input
                            type="checkbox"
                            checked={configDraft.finalNarrative}
                            onChange={(event) => patchDraft({ finalNarrative: event.target.checked })}
                            className="h-4 w-4"
                          />
                        </label>
                      </div>

                      <div className="space-y-2 rounded-lg border border-gray-100 p-3">
                        <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400">Shared Game LLM</h3>
                        <div className="grid grid-cols-2 gap-2">
                          <DropdownSelect
                            value={configDraft.provider}
                            options={PROVIDER_OPTIONS}
                            onChange={(value) => {
                              const provider = value as AiProvider;
                              patchDraft({
                                provider,
                                model: defaultModelForProvider(provider),
                                baseUrl: baseUrlForProvider(provider),
                              });
                            }}
                            ariaLabel="Admin LLM provider"
                            size="sm"
                          />
                          <DropdownSelect
                            value={configDraft.model}
                            options={modelOptionsForValue(configDraft.provider, configDraft.model)}
                            onChange={(value) => patchDraft({ model: value })}
                            ariaLabel="Admin LLM model"
                            size="sm"
                          />
                        </div>
                        <input
                          value={configDraft.baseUrl}
                          onChange={(event) => patchDraft({ baseUrl: event.target.value })}
                          className="w-full rounded-lg border border-gray-200 bg-gray-50 px-2 py-1.5 text-sm"
                        />
                      </div>

                      <div className="space-y-2 rounded-lg border border-gray-100 p-3">
                        <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400">Module LLM Overrides</h3>
                        {MODULE_LLM_LABELS.map(({ key, label }) => {
                          const draft = configDraft.moduleLlmConfig[key];
                          return (
                            <div key={key} className="space-y-2 rounded-lg bg-gray-50 p-2">
                              <div className="text-xs font-medium text-gray-500">{label}</div>
                              <div className="grid grid-cols-2 gap-2">
                                <DropdownSelect
                                  value={draft.provider}
                                  options={PROVIDER_OPTIONS}
                                  onChange={(value) => {
                                    const provider = value as AiProvider;
                                    patchModuleDraft(key, {
                                      provider,
                                      model: defaultModelForProvider(provider),
                                      baseUrl: baseUrlForProvider(provider),
                                    });
                                  }}
                                  ariaLabel={`${label} provider`}
                                  size="sm"
                                />
                                <DropdownSelect
                                  value={draft.model}
                                  options={modelOptionsForValue(draft.provider, draft.model)}
                                  onChange={(value) => patchModuleDraft(key, { model: value })}
                                  ariaLabel={`${label} model`}
                                  size="sm"
                                />
                              </div>
                              <input
                                value={draft.baseUrl}
                                onChange={(event) => patchModuleDraft(key, { baseUrl: event.target.value })}
                                className="w-full rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-sm"
                                aria-label={`${label} base URL`}
                              />
                            </div>
                          );
                        })}
                      </div>

                      <div className="space-y-2 border-t border-gray-100 pt-3">
                        <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400">AI Agents</h3>
                        {Object.entries(configDraft.aiPlayers).length === 0 && (
                          <div className="rounded-lg bg-gray-50 p-3 text-sm text-gray-400">No AI players in this session</div>
                        )}
                        {Object.entries(configDraft.aiPlayers).map(([playerId, draft]) => (
                          <div key={playerId} className="space-y-2 rounded-lg border border-gray-100 p-2">
                            <input
                              value={draft.nickname}
                              onChange={(event) => patchAiDraft(playerId, { nickname: event.target.value })}
                              className="w-full rounded-lg border border-gray-200 bg-gray-50 px-2 py-1.5 text-sm"
                            />
                            <textarea
                              value={draft.stylePrompt}
                              onChange={(event) => patchAiDraft(playerId, { stylePrompt: event.target.value })}
                              rows={2}
                              className="w-full resize-none rounded-lg border border-gray-200 bg-gray-50 px-2 py-1.5 text-sm"
                            />
                            <div className="grid grid-cols-2 gap-2">
                              <DropdownSelect
                                value={draft.provider}
                                options={PROVIDER_OPTIONS}
                                onChange={(value) => {
                                  const provider = value as AiProvider;
                                  patchAiDraft(playerId, {
                                    provider,
                                    model: defaultModelForProvider(provider),
                                  });
                                }}
                                ariaLabel={`${draft.nickname} provider`}
                                size="sm"
                              />
                              <DropdownSelect
                                value={draft.model}
                                options={modelOptionsForValue(draft.provider, draft.model)}
                                onChange={(value) => patchAiDraft(playerId, { model: value })}
                                ariaLabel={`${draft.nickname} model`}
                                size="sm"
                              />
                            </div>
                            <div className="grid grid-cols-3 gap-2">
                              <input
                                value={draft.creativity}
                                onChange={(event) => patchAiDraft(playerId, { creativity: event.target.value })}
                                className="w-full rounded-lg border border-gray-200 bg-gray-50 px-2 py-1.5 text-sm"
                                title="Creativity"
                              />
                              <input
                                value={draft.submitEverySeconds}
                                onChange={(event) => patchAiDraft(playerId, { submitEverySeconds: event.target.value })}
                                className="w-full rounded-lg border border-gray-200 bg-gray-50 px-2 py-1.5 text-sm"
                                title="Extra delay seconds"
                              />
                              <input
                                value={draft.helperActivity}
                                onChange={(event) => patchAiDraft(playerId, { helperActivity: event.target.value })}
                                className="w-full rounded-lg border border-gray-200 bg-gray-50 px-2 py-1.5 text-sm"
                                title="World Helper activity"
                              />
                            </div>
                          </div>
                        ))}
                      </div>

                      <Button fullWidth onClick={saveConfig} disabled={busy || !draftDirty}>
                        Save Parameters
                      </Button>
                    </Card>
                  )}

                {worldState && (
                  <Card padding="md" className="max-h-[420px] min-w-0 space-y-3 overflow-y-auto" data-testid="admin-helper-history">
                    <div className="flex items-center justify-between gap-2">
                      <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-400">World Helper History</h2>
                      <Badge variant="blue">{helperMessages.length}</Badge>
                    </div>
                    {helperMessages.length === 0 ? (
                      <div className="rounded-lg bg-gray-50 p-3 text-sm text-gray-400">
                        No helper questions have been asked in this session.
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {helperMessages.map((message) => (
                          <div key={message.id} className="rounded-lg border border-gray-100 bg-gray-50/60 p-3">
                            <div className="flex items-center justify-between gap-2">
                              <div className="min-w-0">
                                <div className="truncate text-sm font-semibold text-gray-900">
                                  {message.playerNickname ?? message.playerId}
                                </div>
                                <div className="text-xs text-gray-400">
                                  {new Date(message.createdAt).toLocaleString()} / {message.model ?? 'model pending'}
                                </div>
                              </div>
                              <Badge variant={message.status === 'completed' ? 'green' : message.status === 'error' ? 'red' : 'yellow'}>
                                {message.status}
                              </Badge>
                            </div>
                            <p className="mt-2 text-sm font-medium text-gray-700">{message.question}</p>
                            <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-gray-600">
                              {message.answer?.answerText || message.streamedText || message.error || 'No answer text'}
                            </p>
                            <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-gray-400">
                              <span>{message.citedHeadlineIds.length} headlines</span>
                              <span>{message.citedNodeIds.length} entities</span>
                              <span>{message.citedEdgeIds.length} edges</span>
                              {message.answer?.confidence && <span>{message.answer.confidence} confidence</span>}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </Card>
                )}

                <div className="grid gap-4 xl:grid-cols-2">
                  <Card padding="md" className="space-y-3">
                    <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-400">Nodes</h2>
                    <div className="max-h-[420px] space-y-2 overflow-y-auto pr-1">
                      {worldState.nodes.map((node) => (
                        <div key={node.id} className="rounded-lg border border-gray-100 p-3">
                          <div className="flex items-center justify-between gap-2">
                            <div className="min-w-0">
                              <div className="truncate text-sm font-semibold text-gray-900">{node.name}</div>
                              <div className="text-xs text-gray-400">{node.type} / updated {node.timesUpdated} times / {formatTime(node.updatedAt)}</div>
                            </div>
                            <Badge variant={node.timesUpdated > 2 ? 'purple' : 'default'}>{node.timesUpdated}</Badge>
                          </div>
                          <WorldNodeDetailBlocks summary={node.summary} />
                        </div>
                      ))}
                    </div>
                  </Card>

                  <Card padding="md" className="space-y-3">
                    <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-400">Jobs</h2>
                    <div className="max-h-[420px] space-y-2 overflow-y-auto pr-1">
                      {worldState.jobs.map((job) => (
                        <div key={job.id} className="rounded-lg border border-gray-100 p-3">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="text-sm font-medium text-gray-900">{job.agent}</div>
                            <Badge variant={statusVariant(job.status)}>{job.status}</Badge>
                          </div>
                          <div className="mt-1 text-xs text-gray-400">{job.kind} / {stageLabel(job.stage)} / {formatTime(job.updatedAt)}</div>
                          {job.headlineText && <p className="mt-2 line-clamp-2 text-sm text-gray-600">{job.headlineText}</p>}
                          {job.error && <p className="mt-2 rounded bg-red-50 px-2 py-1 text-xs text-red-600">{job.error}</p>}
                        </div>
                      ))}
                    </div>
                  </Card>
                </div>
              </>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}
