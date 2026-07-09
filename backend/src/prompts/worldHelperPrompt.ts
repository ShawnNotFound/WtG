import { JsonSchemaDefinition } from '../llm/openaiResponsesClient.js';

export interface WorldHelperHeadlineContext {
  id: string;
  date: string | null;
  roundNo: number;
  author: string;
  text: string;
  planets: string[];
  score: number | null;
}

export interface WorldHelperEntityContext {
  id: string;
  name: string;
  type: string;
  summary: string;
  timesUpdated: number;
}

export interface WorldHelperEdgeContext {
  id: string;
  sourceName: string;
  targetName: string;
  relationType: string;
  summary: string;
  weight: number;
}

export interface WorldHelperPromptContext {
  question: string;
  session: {
    joinCode: string;
    phase: string;
    currentRound: number;
    maxRounds: number;
    inGameNow: string | null;
  };
  leaderboard: Array<{
    playerId: string;
    nickname: string;
    totalScore: number;
    isAi: boolean;
  }>;
  currentPlayer: {
    playerId: string;
    nickname: string;
    totalScore: number;
    planetPanel: Array<{ id: string; usage: number; band: number }>;
  } | null;
  planetUsage: Array<{ id: string; usage: number }>;
  headlines: WorldHelperHeadlineContext[];
  entities: WorldHelperEntityContext[];
  edges: WorldHelperEdgeContext[];
  graphStatus: {
    available: boolean;
    nodeCount: number;
    edgeCount: number;
    runningJobs: number;
  };
  recentPrivateHistory: Array<{
    question: string;
    answerText: string;
  }>;
}

export interface WorldHelperAnswer {
  answerText: string;
  headlineRefs: Array<{
    id: string;
    reason: string;
  }>;
  entityRefs: Array<{
    id: string;
    name: string;
    reason: string;
  }>;
  edgeRefs: Array<{
    id: string;
    sourceName: string;
    targetName: string;
    relationType: string;
    reason: string;
  }>;
  graphSummary: {
    note: string;
    entities: Array<{
      id: string;
      name: string;
      summary: string;
    }>;
    edges: Array<{
      id: string;
      sourceName: string;
      targetName: string;
      relationType: string;
      summary: string;
    }>;
  };
  suggestedQuestions: string[];
  confidence: 'low' | 'medium' | 'high';
}

export const worldHelperAnswerJsonSchema: JsonSchemaDefinition = {
  name: 'world_helper_answer',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: [
      'answerText',
      'headlineRefs',
      'entityRefs',
      'edgeRefs',
      'graphSummary',
      'suggestedQuestions',
      'confidence',
    ],
    properties: {
      answerText: { type: 'string' },
      headlineRefs: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'reason'],
          properties: {
            id: { type: 'string' },
            reason: { type: 'string' },
          },
        },
      },
      entityRefs: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'name', 'reason'],
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            reason: { type: 'string' },
          },
        },
      },
      edgeRefs: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'sourceName', 'targetName', 'relationType', 'reason'],
          properties: {
            id: { type: 'string' },
            sourceName: { type: 'string' },
            targetName: { type: 'string' },
            relationType: { type: 'string' },
            reason: { type: 'string' },
          },
        },
      },
      graphSummary: {
        type: 'object',
        additionalProperties: false,
        required: ['note', 'entities', 'edges'],
        properties: {
          note: { type: 'string' },
          entities: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'name', 'summary'],
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                summary: { type: 'string' },
              },
            },
          },
          edges: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'sourceName', 'targetName', 'relationType', 'summary'],
              properties: {
                id: { type: 'string' },
                sourceName: { type: 'string' },
                targetName: { type: 'string' },
                relationType: { type: 'string' },
                summary: { type: 'string' },
              },
            },
          },
        },
      },
      suggestedQuestions: {
        type: 'array',
        items: { type: 'string' },
      },
      confidence: {
        type: 'string',
        enum: ['low', 'medium', 'high'],
      },
    },
  },
};

export function buildWorldHelperInstructions(): string {
  return `You are the private World Helper for one player in Future Headlines.

Answer questions about the visible timeline, scoring/planet context, and the hidden backend world graph context provided to you. The player cannot directly see the graph, so summarize only the relevant entities and relationships instead of dumping all graph data.

Rules:
- Use only the supplied context. Do not invent unseen headlines, graph nodes, scores, or player actions.
- If the world graph is unavailable or still being built, say that plainly and answer from timeline/session context.
- Cite only headline, entity, and edge ids that appear in the context.
- Prefer concise answers that help the player understand the world, rules, and evidence.
- You are not a co-author, strategy coach, or move recommender. Do not suggest what the player should submit, which planet to target, which entities to combine, how to maximize score, or any sample headline/story direction.
- If asked for detailed play advice, a sample submission, or headline ideas, briefly refuse that part and offer neutral help instead: explain relevant rules, summarize existing world facts, or list informational questions the player can ask.
- Suggested follow-up questions must be informational, not requests for a recommended move or generated submission.
- Do not reveal private helper chats from other players. The recent history in the prompt is this same player's private history.
- Mention uncertainty when the evidence is weak.
- Return only valid JSON matching the schema.`;
}

export function buildWorldHelperPrompt(context: WorldHelperPromptContext): string {
  return `PLAYER QUESTION
${context.question}

SESSION STATE
${JSON.stringify(context.session, null, 2)}

CURRENT PLAYER
${JSON.stringify(context.currentPlayer, null, 2)}

LEADERBOARD
${JSON.stringify(context.leaderboard, null, 2)}

PLANET USAGE
${JSON.stringify(context.planetUsage, null, 2)}

RECENT/RELEVANT HEADLINES
${JSON.stringify(context.headlines, null, 2)}

WORLD GRAPH STATUS
${JSON.stringify(context.graphStatus, null, 2)}

RELEVANT WORLD GRAPH ENTITIES
${JSON.stringify(context.entities, null, 2)}

RELEVANT WORLD GRAPH EDGES
${JSON.stringify(context.edges, null, 2)}

THIS PLAYER'S COMPACT RECENT/RELEVANT PRIVATE HELPER HISTORY
${JSON.stringify(context.recentPrivateHistory, null, 2)}

Write an answer for the player now. Keep it informational and avoid detailed play advice or generated submission ideas. Include suggested follow-up questions that are useful for understanding the current game state.`;
}
