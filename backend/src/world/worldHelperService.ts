import pool from '../db/pool.js';
import {
  createJsonModelClient,
  getJsonProviderConfig,
} from '../llm/jsonModelClient.js';
import { OpenAIError } from '../llm/openaiResponsesClient.js';
import { getSessionLlmSelection } from '../llm/sessionLlmConfig.js';
import { computeInGameNow } from '../game/inGameTime.js';
import { migrateGlobalUsage, migratePlayerOrdinals, computePlanetPanel } from '../game/planetUsage.js';
import { DEFAULT_PLANETS } from '../game/scoringTypes.js';
import {
  buildWorldHelperInstructions,
  buildWorldHelperPrompt,
  WorldHelperAnswer,
  WorldHelperEdgeContext,
  WorldHelperEntityContext,
  WorldHelperHeadlineContext,
  WorldHelperPromptContext,
  worldHelperAnswerJsonSchema,
} from '../prompts/worldHelperPrompt.js';
import { loadWorldStateContextForQuery } from './worldStateService.js';
import {
  updateWorldModelWithHelper,
  WorldModelUpdateResult,
} from './worldModelOperationService.js';

export interface AskWorldHelperParams {
  sessionId: string;
  joinCode: string;
  playerId: string;
  question: string;
  clientRequestId?: string;
  /** AI players use the helper for broad briefings and must not mutate the shared model. */
  allowWorldMutation?: boolean;
}

interface HelperCallbacks {
  onDelta?: (payload: WorldHelperDelta) => void | Promise<void>;
  onComplete?: (payload: WorldHelperComplete) => void | Promise<void>;
  onError?: (payload: WorldHelperError) => void | Promise<void>;
}

export interface WorldHelperDelta {
  messageId: string;
  clientRequestId?: string;
  delta: string;
  text: string;
}

export interface WorldHelperComplete {
  messageId: string;
  clientRequestId?: string;
  message: WorldHelperMessage;
}

export interface WorldHelperError {
  messageId?: string;
  clientRequestId?: string;
  error: string;
}

export interface WorldHelperMessage {
  id: string;
  sessionId: string;
  playerId: string;
  playerNickname?: string;
  question: string;
  streamedText: string;
  answer: WorldHelperAnswer | null;
  citedHeadlineIds: string[];
  citedNodeIds: string[];
  citedEdgeIds: string[];
  status: 'pending' | 'streaming' | 'completed' | 'error';
  model: string | null;
  usage: Record<string, unknown>;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
  worldUpdate: WorldModelUpdateResult | null;
}

function cleanString(value: unknown, fallback = '', maxLength = 2000): string {
  if (typeof value !== 'string') return fallback;
  const cleaned = value.replace(/\s+/g, ' ').trim();
  return cleaned.length > maxLength ? cleaned.slice(0, maxLength) : cleaned;
}

function normalizeTokens(value: string): string[] {
  return Array.from(new Set(
    value
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3)
  )).slice(0, 24);
}

function scoreText(text: string, tokens: string[]): number {
  const haystack = text.toLowerCase();
  return tokens.reduce((score, token) => score + (haystack.includes(token) ? 1 : 0), 0);
}

function sortRelevant<T>(
  items: T[],
  scorer: (item: T) => number,
  recency: (item: T) => number,
  limit: number
): T[] {
  return [...items]
    .map((item) => ({ item, score: scorer(item), recency: recency(item) }))
    .sort((a, b) => (b.score - a.score) || (b.recency - a.recency))
    .slice(0, limit)
    .map((entry) => entry.item);
}

function coerceJsonArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function rowToMessage(row: any): WorldHelperMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    playerId: row.player_id,
    playerNickname: row.player_nickname ?? undefined,
    question: row.question,
    streamedText: row.streamed_text ?? '',
    answer: row.answer && Object.keys(row.answer).length > 0 ? row.answer : null,
    citedHeadlineIds: coerceJsonArray(row.cited_headline_ids),
    citedNodeIds: coerceJsonArray(row.cited_node_ids),
    citedEdgeIds: coerceJsonArray(row.cited_edge_ids),
    status: row.status,
    model: row.model ?? null,
    usage: row.usage ?? {},
    error: row.error ?? null,
    createdAt: new Date(row.created_at).toISOString(),
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
    worldUpdate: row.world_update && Object.keys(row.world_update).length > 0
      ? row.world_update
      : null,
  };
}

function chunkText(text: string): string[] {
  const chunks: string[] = [];
  const sentences = text.match(/[^.!?]+[.!?]+[\])'"`’”]*|\S[\s\S]{0,110}(?=\s|$)/g) ?? [text];
  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (!trimmed) continue;
    if (trimmed.length <= 140) {
      chunks.push(trimmed + (/[.!?]$/.test(trimmed) ? ' ' : ''));
      continue;
    }
    for (let i = 0; i < trimmed.length; i += 120) {
      chunks.push(trimmed.slice(i, i + 120));
    }
  }
  return chunks.length > 0 ? chunks : [text];
}

function normalizePolicyText(value: string): string {
  return value
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isWorldHelperPlayAdviceRequest(question: string): boolean {
  const text = normalizePolicyText(question);
  if (!text) return false;

  const generatedOutputRequest =
    /\b(write|draft|generate|compose|create|make|propose|suggest|give|provide)\b.{0,80}\b(headline|story direction|submission|timeline entry|move|play|idea|ideas|sample|example)\b/.test(text) ||
    /\b(headline|story direction|submission|timeline entry)\b.{0,80}\b(write|draft|generate|compose|create|make|propose|suggest|give|provide)\b/.test(text) ||
    /\b(sample|example)\b.{0,40}\b(headline|story direction|submission|timeline entry)\b/.test(text);

  const moveRecommendationRequest =
    /\b(what|which|who|where|how)\b.{0,80}\b(should|shall|do i|can i|could i)\b.{0,120}\b(submit|write|play|use|pick|choose|target|connect|maximize|win|beat)\b/.test(text) ||
    /\b(what|which)\b.{0,80}\b(planet|author|headline|entity|actor|connection)\b.{0,80}\b(should|shall|do i|can i|could i)\b/.test(text) ||
    /\b(help me|tell me how to|show me how to)\b.{0,80}\b(win|maximize|submit|write|play|choose|target)\b/.test(text);

  const strategyRequest =
    /\b(best|optimal|highest scoring|high scoring|score more|maximize score|max points|most points|winning)\b.{0,100}\b(headline|story direction|submission|move|play|strategy|planet|connection|idea)\b/.test(text) ||
    /\b(strategy|plan|move)\b.{0,80}\b(for my next|next headline|next submission|to win|to score)\b/.test(text) ||
    /\b(maximize score|score more|max points|most points|win the game|beat everyone|highest score|high score)\b/.test(text);

  return generatedOutputRequest || moveRecommendationRequest || strategyRequest;
}

export async function prepareWorldModelForHelperQuestion(
  params: AskWorldHelperParams,
  helperMessageId: string
): Promise<WorldModelUpdateResult | null> {
  if (params.allowWorldMutation === false || isWorldHelperPlayAdviceRequest(params.question)) {
    return null;
  }
  try {
    return await updateWorldModelWithHelper({
      sessionId: params.sessionId,
      query: params.question,
      operation: 'ANSWER',
      helperMessageId,
      source: 'helper',
    });
  } catch (error) {
    console.warn(
      `[WorldHelper ${params.joinCode}] World-model preparation failed; answering from existing context:`,
      error
    );
    return null;
  }
}

export function buildWorldHelperPolicyBoundaryAnswer(context: WorldHelperPromptContext): WorldHelperAnswer {
  const phase = context.session.phase;
  const roundText = context.session.maxRounds > 0
    ? `Round ${context.session.currentRound} of ${context.session.maxRounds}`
    : 'the current session';

  return {
    answerText: [
      'I can explain the world state, rules, planet panel, timeline evidence, and world-graph context, but I cannot choose your next play, optimize your move, draft a story direction, or provide sample headlines.',
      `For ${roundText}${phase ? ` (${phase})` : ''}, use this as instruction-level guidance: review the timeline yourself, identify a causal continuation you believe is plausible, check your visible planet panel, and keep the final submission in your own words.`,
      'Ask me about a specific entity, headline, relationship, planet rule, or scoring mechanic, and I can summarize the relevant evidence without turning it into a recommended submission.',
    ].join(' '),
    headlineRefs: [],
    entityRefs: [],
    edgeRefs: [],
    graphSummary: {
      note: 'Request was limited because World Helper must not generate or recommend playable submissions.',
      entities: [],
      edges: [],
    },
    suggestedQuestions: [
      'What does my current planet panel mean?',
      'How do connection points work?',
      'What has changed around a named entity?',
      'Which timeline headlines mention a named actor?',
    ],
    confidence: 'high',
  };
}

function selectPrivateHistory(
  rows: any[],
  tokens: string[]
): Array<{ question: string; answerText: string }> {
  const compactRows = rows.map((row, index) => {
    const answerText = cleanString(row.answer?.answerText ?? row.streamed_text, '', 700);
    const question = cleanString(row.question, '', 220);
    return {
      index,
      question,
      answerText,
      score: scoreText(`${question} ${answerText}`, tokens),
    };
  });

  const latest = compactRows.slice(0, 3);
  const latestIndexes = new Set(latest.map((row) => row.index));
  const relevant = compactRows
    .filter((row) => !latestIndexes.has(row.index) && row.score > 0)
    .sort((a, b) => (b.score - a.score) || (a.index - b.index))
    .slice(0, 3);

  return [...latest, ...relevant]
    .sort((a, b) => b.index - a.index)
    .map(({ question, answerText }) => ({ question, answerText }));
}

function normalizeHelperAnswer(
  raw: Partial<WorldHelperAnswer>,
  validIds: {
    headlines: Set<string>;
    nodes: Set<string>;
    edges: Set<string>;
  },
  context: WorldHelperPromptContext
): WorldHelperAnswer {
  const graphUnavailableNote = context.graphStatus.available
    ? 'Relevant world graph context was used where available.'
    : 'The world graph is not built yet, so this answer uses timeline and game-state context.';

  const answerText = cleanString(
    raw.answerText,
    context.graphStatus.available
      ? 'I could not generate a reliable answer from the available context.'
      : `${graphUnavailableNote} I could not generate a reliable answer from the available context.`,
    4000
  );

  const headlineRefs = (Array.isArray(raw.headlineRefs) ? raw.headlineRefs : [])
    .filter((ref) => ref && validIds.headlines.has(ref.id))
    .slice(0, 6)
    .map((ref) => ({
      id: ref.id,
      reason: cleanString(ref.reason, 'Relevant timeline evidence.', 300),
    }));

  const entityRefs = (Array.isArray(raw.entityRefs) ? raw.entityRefs : [])
    .filter((ref) => ref && validIds.nodes.has(ref.id))
    .slice(0, 6)
    .map((ref) => ({
      id: ref.id,
      name: cleanString(ref.name, 'Entity', 120),
      reason: cleanString(ref.reason, 'Relevant world graph entity.', 300),
    }));

  const edgeRefs = (Array.isArray(raw.edgeRefs) ? raw.edgeRefs : [])
    .filter((ref) => ref && validIds.edges.has(ref.id))
    .slice(0, 6)
    .map((ref) => ({
      id: ref.id,
      sourceName: cleanString(ref.sourceName, 'Source', 120),
      targetName: cleanString(ref.targetName, 'Target', 120),
      relationType: cleanString(ref.relationType, 'RELATED_TO', 80),
      reason: cleanString(ref.reason, 'Relevant world graph relationship.', 300),
    }));

  const graphSummary = raw.graphSummary && typeof raw.graphSummary === 'object'
    ? raw.graphSummary
    : { note: graphUnavailableNote, entities: [], edges: [] };

  return {
    answerText,
    headlineRefs,
    entityRefs,
    edgeRefs,
    graphSummary: {
      note: cleanString(graphSummary.note, graphUnavailableNote, 600),
      entities: (Array.isArray(graphSummary.entities) ? graphSummary.entities : [])
        .filter((entity) => entity && validIds.nodes.has(entity.id))
        .slice(0, 6)
        .map((entity) => ({
          id: entity.id,
          name: cleanString(entity.name, 'Entity', 120),
          summary: cleanString(entity.summary, '', 500),
        })),
      edges: (Array.isArray(graphSummary.edges) ? graphSummary.edges : [])
        .filter((edge) => edge && validIds.edges.has(edge.id))
        .slice(0, 6)
        .map((edge) => ({
          id: edge.id,
          sourceName: cleanString(edge.sourceName, 'Source', 120),
          targetName: cleanString(edge.targetName, 'Target', 120),
          relationType: cleanString(edge.relationType, 'RELATED_TO', 80),
          summary: cleanString(edge.summary, '', 500),
        })),
    },
    suggestedQuestions: (Array.isArray(raw.suggestedQuestions) ? raw.suggestedQuestions : [])
      .map((question) => cleanString(question, '', 180))
      .filter(Boolean)
      .filter((question) => !isWorldHelperPlayAdviceRequest(question))
      .slice(0, 4),
    confidence: raw.confidence === 'high' || raw.confidence === 'medium' || raw.confidence === 'low'
      ? raw.confidence
      : context.graphStatus.available ? 'medium' : 'low',
  };
}

async function buildHelperContext(
  sessionId: string,
  joinCode: string,
  playerId: string,
  question: string
): Promise<WorldHelperPromptContext> {
  const tokens = normalizeTokens(question);
  const [
    sessionResult,
    playersResult,
    headlinesResult,
    jobsResult,
    historyResult,
  ] = await Promise.all([
    pool.query(
      `SELECT phase, current_round, max_rounds, in_game_start_at, phase_started_at,
              phase_ends_at, timeline_speed_ratio, planet_usage_global,
              CURRENT_TIMESTAMP AS server_now
       FROM game_sessions
       WHERE id = $1`,
      [sessionId]
    ),
    pool.query(
      `SELECT id, nickname, is_ai, total_score, planet_usage_state
       FROM session_players
       WHERE session_id = $1 AND is_system = FALSE
       ORDER BY total_score DESC, joined_at ASC`,
      [sessionId]
    ),
    pool.query(
      `SELECT
         h.id,
         h.round_no,
         h.in_game_submitted_at,
         h.created_at,
         h.planet_1,
         h.planet_2,
         h.planet_3,
         h.total_headline_score,
         COALESCE(h.selected_headline, h.headline_text) AS text,
         p.nickname AS player_nickname
       FROM game_session_headlines h
       JOIN session_players p ON p.id = h.player_id
       WHERE h.session_id = $1
       ORDER BY h.created_at ASC`,
      [sessionId]
    ),
    pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'running')::int AS running_jobs
       FROM world_state_jobs
       WHERE session_id = $1`,
      [sessionId]
    ),
    pool.query(
      `SELECT question, answer, streamed_text, created_at
       FROM world_helper_messages
       WHERE session_id = $1 AND player_id = $2 AND status = 'completed'
       ORDER BY created_at DESC
       LIMIT 12`,
      [sessionId, playerId]
    ),
  ]);

  const session = sessionResult.rows[0];
  const graphContext = await loadWorldStateContextForQuery(sessionId, question, 'world_helper');
  const serverNow = session ? new Date(session.server_now) : new Date();
  const inGameNow = session
    ? computeInGameNow(
        session.in_game_start_at,
        session.phase_started_at,
        session.phase_ends_at,
        serverNow,
        session.timeline_speed_ratio
      )
    : null;

  const globalUsage = migrateGlobalUsage(session?.planet_usage_global, DEFAULT_PLANETS);
  const players = playersResult.rows;
  const currentPlayer = players.find((player) => player.id === playerId);

  const headlineContexts: WorldHelperHeadlineContext[] = headlinesResult.rows.map((row, index) => ({
    id: row.id,
    date: row.in_game_submitted_at
      ? new Date(row.in_game_submitted_at).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
      : null,
    roundNo: row.round_no,
    author: row.player_nickname,
    text: row.text,
    planets: [row.planet_1, row.planet_2, row.planet_3].filter(Boolean),
    score: row.total_headline_score ?? null,
    // index is used only for stable recency below through closure.
    ...(index >= 0 ? {} : {}),
  }));

  const relevantHeadlines = sortRelevant(
    headlineContexts,
    (headline) => scoreText([headline.text, headline.author, ...headline.planets].join(' '), tokens),
    (headline) => headlineContexts.findIndex((entry) => entry.id === headline.id),
    24
  );

  const relevantEntities: WorldHelperEntityContext[] = graphContext.nodes.map((row) => ({
    id: row.id,
    name: row.name,
    type: row.type,
    summary: row.summary,
    timesUpdated: row.timesUpdated,
  }));
  const relevantEntityNames = new Set(relevantEntities.map((entity) => entity.name));

  const edgeContexts: WorldHelperEdgeContext[] = graphContext.connections.map((connection) => ({
    id: connection.id,
    sourceName: connection.source,
    targetName: connection.target,
    relationType: 'CONNECTION_STRENGTH',
    summary: connection.rationale,
    weight: connection.strength,
  }));
  const relevantEdges = sortRelevant(
    edgeContexts,
    (edge) =>
      scoreText([edge.sourceName, edge.targetName, edge.relationType, edge.summary].join(' '), tokens) +
      (relevantEntityNames.has(edge.sourceName) || relevantEntityNames.has(edge.targetName) ? 2 : 0),
    (edge) => Math.round(edge.weight * 10),
    24
  );

  return {
    question,
    session: {
      joinCode,
      phase: session?.phase ?? 'UNKNOWN',
      currentRound: session?.current_round ?? 0,
      maxRounds: session?.max_rounds ?? 0,
      inGameNow: inGameNow ? inGameNow.toISOString() : null,
    },
    leaderboard: players.map((player) => ({
      playerId: player.id,
      nickname: player.nickname,
      totalScore: player.total_score ?? 0,
      isAi: player.is_ai === true,
    })),
    currentPlayer: currentPlayer
      ? {
          playerId: currentPlayer.id,
          nickname: currentPlayer.nickname,
          totalScore: currentPlayer.total_score ?? 0,
          planetPanel: computePlanetPanel(
            globalUsage,
            migratePlayerOrdinals(currentPlayer.planet_usage_state, DEFAULT_PLANETS),
            DEFAULT_PLANETS
          ),
        }
      : null,
    planetUsage: Object.entries(globalUsage)
      .map(([id, usage]) => ({ id, usage }))
      .sort((a, b) => b.usage - a.usage),
    headlines: relevantHeadlines,
    entities: relevantEntities,
    edges: relevantEdges,
    graphStatus: {
      available: relevantEntities.length > 0,
      nodeCount: relevantEntities.length,
      edgeCount: relevantEdges.length,
      runningJobs: jobsResult.rows[0]?.running_jobs ?? 0,
    },
    recentPrivateHistory: selectPrivateHistory(historyResult.rows, tokens),
  };
}

export async function askWorldHelper(
  params: AskWorldHelperParams,
  callbacks: HelperCallbacks = {}
): Promise<WorldHelperMessage> {
  const insertResult = await pool.query(
    `INSERT INTO world_helper_messages (session_id, player_id, question, status)
     VALUES ($1, $2, $3, 'pending')
     RETURNING *`,
    [params.sessionId, params.playerId, params.question]
  );
  const messageId = insertResult.rows[0].id;

  try {
    const isPolicyBoundary = isWorldHelperPlayAdviceRequest(params.question);
    if (!isPolicyBoundary && params.allowWorldMutation !== false) {
      // Gap filling is deliberately best-effort. The operation service records
      // its own durable error/job metadata; an unavailable world editor should
      // not prevent a player from receiving an answer from existing context.
      await prepareWorldModelForHelperQuestion(params, messageId);
    }

    const context = await buildHelperContext(
      params.sessionId,
      params.joinCode,
      params.playerId,
      params.question
    );

    if (isPolicyBoundary) {
      const answer = buildWorldHelperPolicyBoundaryAnswer(context);

      await pool.query(
        `UPDATE world_helper_messages
         SET status = 'streaming', model = $2, usage = $3
         WHERE id = $1`,
        [
          messageId,
          'world-helper-policy',
          JSON.stringify({}),
        ]
      );

      let streamedText = '';
      for (const chunk of chunkText(answer.answerText)) {
        streamedText += chunk;
        await callbacks.onDelta?.({
          messageId,
          clientRequestId: params.clientRequestId,
          delta: chunk,
          text: streamedText,
        });
      }

      const completeResult = await pool.query(
        `UPDATE world_helper_messages
         SET status = 'completed',
             streamed_text = $2,
             answer = $3,
             cited_headline_ids = $4,
             cited_node_ids = $5,
             cited_edge_ids = $6,
             model = $7,
             usage = $8,
             completed_at = CURRENT_TIMESTAMP
         WHERE id = $1
         RETURNING *`,
        [
          messageId,
          streamedText,
          JSON.stringify(answer),
          JSON.stringify([]),
          JSON.stringify([]),
          JSON.stringify([]),
          'world-helper-policy',
          JSON.stringify({}),
        ]
      );

      const message = rowToMessage(completeResult.rows[0]);
      await callbacks.onComplete?.({
        messageId,
        clientRequestId: params.clientRequestId,
        message,
      });
      return message;
    }

    const selection = await getSessionLlmSelection(params.sessionId, 'helper');
    const config = getJsonProviderConfig('HELPER', selection);
    if (!config.apiKey) {
      throw new OpenAIError(
        `${config.provider === 'deepseek' ? 'DEEPSEEK_API_KEY' : 'OPENAI_API_KEY'} environment variable is not set`,
        'MISSING_API_KEY'
      );
    }

    const client = createJsonModelClient(config);
    const result = await client.callResponsesApi<WorldHelperAnswer>({
      instructions: buildWorldHelperInstructions(),
      input: buildWorldHelperPrompt(context),
      jsonSchema: worldHelperAnswerJsonSchema,
      temperature: 0.35,
    });

    const validIds = {
      headlines: new Set(context.headlines.map((headline) => headline.id)),
      nodes: new Set(context.entities.map((entity) => entity.id)),
      edges: new Set(context.edges.map((edge) => edge.id)),
    };
    const answer = normalizeHelperAnswer(result.output, validIds, context);

    await pool.query(
      `UPDATE world_helper_messages
       SET status = 'streaming', model = $2, usage = $3
       WHERE id = $1`,
      [
        messageId,
        result.model,
        JSON.stringify(result.usage ?? {}),
      ]
    );

    let streamedText = '';
    for (const chunk of chunkText(answer.answerText)) {
      streamedText += chunk;
      await callbacks.onDelta?.({
        messageId,
        clientRequestId: params.clientRequestId,
        delta: chunk,
        text: streamedText,
      });
    }

    const completeResult = await pool.query(
      `UPDATE world_helper_messages
       SET status = 'completed',
           streamed_text = $2,
           answer = $3,
           cited_headline_ids = $4,
           cited_node_ids = $5,
           cited_edge_ids = $6,
           model = $7,
           usage = $8,
           completed_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING *`,
      [
        messageId,
        streamedText,
        JSON.stringify(answer),
        JSON.stringify(answer.headlineRefs.map((ref) => ref.id)),
        JSON.stringify(answer.entityRefs.map((ref) => ref.id)),
        JSON.stringify(answer.edgeRefs.map((ref) => ref.id)),
        result.model,
        JSON.stringify(result.usage ?? {}),
      ]
    );

    const message = rowToMessage(completeResult.rows[0]);
    await callbacks.onComplete?.({
      messageId,
      clientRequestId: params.clientRequestId,
      message,
    });
    return message;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'World helper failed';
    const failedResult = await pool.query(
      `UPDATE world_helper_messages
       SET status = 'error',
           error = $2,
           completed_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING *`,
      [messageId, errorMessage]
    );
    await callbacks.onError?.({
      messageId,
      clientRequestId: params.clientRequestId,
      error: errorMessage,
    });
    return rowToMessage(failedResult.rows[0]);
  }
}

export async function getWorldHelperHistory(
  sessionId: string,
  playerId: string
): Promise<WorldHelperMessage[]> {
  const result = await pool.query(
    `SELECT *
     FROM world_helper_messages
     WHERE session_id = $1 AND player_id = $2
     ORDER BY created_at ASC
     LIMIT 200`,
    [sessionId, playerId]
  );
  return result.rows.map(rowToMessage);
}

export async function getWorldHelperAdminHistory(
  sessionId: string,
  playerId?: string
): Promise<WorldHelperMessage[]> {
  const params: unknown[] = [sessionId];
  let filter = '';
  if (playerId) {
    params.push(playerId);
    filter = ` AND m.player_id = $${params.length}`;
  }

  const result = await pool.query(
    `SELECT m.*, p.nickname AS player_nickname
     FROM world_helper_messages m
     JOIN session_players p ON p.id = m.player_id
     WHERE m.session_id = $1${filter}
     ORDER BY m.created_at DESC
     LIMIT 300`,
    params
  );
  return result.rows.map(rowToMessage);
}
