import { Server } from 'socket.io';
import pool from '../db/pool.js';
import { computeInGameNow } from '../game/inGameTime.js';
import { DEFAULT_PLANETS, PlanetPanelEntry } from '../game/scoringTypes.js';
import { computePlanetPanel, migrateGlobalUsage, migratePlayerOrdinals } from '../game/planetUsage.js';
import { submitPlayerHeadline } from '../game/headlineSubmissionService.js';
import { canSubmitHeadline, recordHeadlineSubmission } from '../game/headlineCooldown.js';
import {
  buildAiWorldHelperQuestion,
  generateAiStoryDirection,
  getAiPlayerRows,
  normalizeAiPlayerConfig,
} from './aiPlayerService.js';
import { askWorldHelper, WorldHelperMessage } from '../world/worldHelperService.js';
import { AiWorldHelperInsight } from '../prompts/aiPlayerPrompt.js';

interface SessionRuntime {
  io: Server;
  sessionId: string;
  joinCode: string;
  handle: NodeJS.Timeout;
  lastSubmittedAt: Map<string, number>;
  inFlight: Set<string>;
  transitionHold: boolean;
  idleWaiters: Set<() => void>;
}

export interface AiSessionWorkState {
  known: boolean;
  activeJobs: number;
  transitionHold: boolean;
}

interface SessionSnapshot {
  phase: string;
  isPaused: boolean;
  currentRound: number;
  maxRounds: number;
  inGameNow: string | null;
  planetUsageGlobal: unknown;
}

async function getSessionSnapshot(sessionId: string): Promise<SessionSnapshot | null> {
  const result = await pool.query(
    `SELECT phase, current_round, max_rounds, in_game_start_at, phase_started_at,
            phase_ends_at, timeline_speed_ratio, planet_usage_global, is_paused,
            CURRENT_TIMESTAMP as server_now
     FROM game_sessions
     WHERE id = $1`,
    [sessionId]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0];
  const serverNow = new Date(row.server_now);
  const inGameNow = computeInGameNow(
    row.in_game_start_at,
    row.phase_started_at,
    row.phase_ends_at,
    serverNow,
    row.timeline_speed_ratio
  );

  return {
    phase: row.phase,
    isPaused: row.is_paused === true,
    currentRound: row.current_round,
    maxRounds: row.max_rounds,
    inGameNow: inGameNow ? inGameNow.toISOString() : null,
    planetUsageGlobal: row.planet_usage_global,
  };
}

async function getRecentVisibleHeadlines(sessionId: string) {
  const result = await pool.query(
    `SELECT h.round_no,
            COALESCE(h.selected_headline, h.headline_text) as text,
            h.in_game_submitted_at,
            h.planet_1,
            h.planet_2,
            h.planet_3,
            h.total_headline_score,
            p.nickname as player_nickname
     FROM game_session_headlines h
     JOIN session_players p ON p.id = h.player_id
     WHERE h.session_id = $1
     ORDER BY h.created_at DESC
     LIMIT 36`,
    [sessionId]
  );

  return result.rows.reverse().map((row) => ({
    text: row.text,
    playerNickname: row.player_nickname,
    roundNo: row.round_no,
    inGameSubmittedAt: row.in_game_submitted_at
      ? new Date(row.in_game_submitted_at).toISOString()
      : null,
    planets: [row.planet_1, row.planet_2, row.planet_3].filter(Boolean),
    totalScore: row.total_headline_score ?? null,
  }));
}

async function getPlayerPlanetPanel(sessionId: string, playerId: string, globalUsageRaw: unknown): Promise<PlanetPanelEntry[]> {
  const result = await pool.query(
    `SELECT planet_usage_state
     FROM session_players
     WHERE session_id = $1 AND id = $2`,
    [sessionId, playerId]
  );
  const globalUsage = migrateGlobalUsage(globalUsageRaw, DEFAULT_PLANETS);
  const playerState = result.rows[0]?.planet_usage_state;
  return computePlanetPanel(globalUsage, migratePlayerOrdinals(playerState, DEFAULT_PLANETS), DEFAULT_PLANETS);
}

class AiPlayerManager {
  private sessions = new Map<string, SessionRuntime>();

  startSession(io: Server, sessionId: string, joinCode: string): void {
    if (process.env.NODE_ENV === 'test') {
      return;
    }

    if (this.sessions.has(sessionId)) {
      return;
    }

    const runtime: SessionRuntime = {
      io,
      sessionId,
      joinCode,
      handle: setInterval(() => {
        this.tick(sessionId).catch((error) => {
          console.error(`[AI ${joinCode}] Tick failed:`, error);
        });
      }, 1_000),
      lastSubmittedAt: new Map(),
      inFlight: new Set(),
      transitionHold: false,
      idleWaiters: new Set(),
    };

    this.sessions.set(sessionId, runtime);
    console.log(`[AI ${joinCode}] AI player manager started`);
  }

  stopSession(sessionId: string): void {
    const runtime = this.sessions.get(sessionId);
    if (!runtime) {
      return;
    }
    clearInterval(runtime.handle);
    this.notifyIdle(runtime);
    this.sessions.delete(sessionId);
    console.log(`[AI ${runtime.joinCode}] AI player manager stopped`);
  }

  stopAll(): void {
    for (const sessionId of this.sessions.keys()) {
      this.stopSession(sessionId);
    }
  }

  getSessionWorkState(sessionId: string): AiSessionWorkState {
    const runtime = this.sessions.get(sessionId);
    if (!runtime) {
      return { known: false, activeJobs: 0, transitionHold: false };
    }

    return {
      known: true,
      activeJobs: runtime.inFlight.size,
      transitionHold: runtime.transitionHold,
    };
  }

  holdSessionForTransition(sessionId: string): AiSessionWorkState {
    const runtime = this.sessions.get(sessionId);
    if (!runtime) {
      return { known: false, activeJobs: 0, transitionHold: false };
    }

    runtime.transitionHold = true;
    return this.getSessionWorkState(sessionId);
  }

  releaseSessionTransitionHold(sessionId: string): void {
    const runtime = this.sessions.get(sessionId);
    if (runtime) {
      runtime.transitionHold = false;
    }
  }

  async waitForSessionIdle(sessionId: string): Promise<AiSessionWorkState> {
    const runtime = this.sessions.get(sessionId);
    if (!runtime || runtime.inFlight.size === 0) {
      return this.getSessionWorkState(sessionId);
    }

    await new Promise<void>((resolve) => {
      runtime.idleWaiters.add(resolve);
    });

    return this.getSessionWorkState(sessionId);
  }

  private notifyIdle(runtime: SessionRuntime): void {
    if (runtime.inFlight.size > 0) {
      return;
    }

    for (const resolve of runtime.idleWaiters) {
      resolve();
    }
    runtime.idleWaiters.clear();
  }

  private async tick(sessionId: string): Promise<void> {
    const runtime = this.sessions.get(sessionId);
    if (!runtime) {
      return;
    }

    if (runtime.transitionHold) {
      return;
    }

    const snapshot = await getSessionSnapshot(sessionId);
    if (!snapshot) {
      this.stopSession(sessionId);
      return;
    }

    if (snapshot.phase === 'FINISHED') {
      this.stopSession(sessionId);
      return;
    }

    if (snapshot.isPaused || snapshot.phase !== 'PLAYING') {
      return;
    }

    if (runtime.transitionHold) {
      return;
    }

    const aiPlayers = await getAiPlayerRows(sessionId);
    if (aiPlayers.length === 0) {
      return;
    }

    const visibleHeadlines = await getRecentVisibleHeadlines(sessionId);
    const now = Date.now();

    for (const player of aiPlayers) {
      if (runtime.transitionHold) {
        return;
      }

      const config = normalizeAiPlayerConfig(player.ai_config);
      const last = runtime.lastSubmittedAt.get(player.id) ?? 0;
      const extraIntervalMs = config.submitEverySeconds * 1000;
      const cooldown = canSubmitHeadline(sessionId, player.id);
      const intervalReady = extraIntervalMs === 0 || now - last >= extraIntervalMs;

      if (runtime.inFlight.has(player.id) || !cooldown.allowed || !intervalReady) {
        continue;
      }

      if (runtime.transitionHold) {
        return;
      }

      runtime.inFlight.add(player.id);

      this.submitForPlayer(runtime, {
        id: player.id,
        nickname: player.nickname,
        config,
        snapshot,
        visibleHeadlines,
      }).finally(() => {
        runtime.inFlight.delete(player.id);
        this.notifyIdle(runtime);
      });
    }
  }

  private async submitForPlayer(
    runtime: SessionRuntime,
    input: {
      id: string;
      nickname: string;
      config: ReturnType<typeof normalizeAiPlayerConfig>;
      snapshot: SessionSnapshot;
      visibleHeadlines: Awaited<ReturnType<typeof getRecentVisibleHeadlines>>;
    }
  ): Promise<void> {
    try {
      const planetPanel = await getPlayerPlanetPanel(
        runtime.sessionId,
        input.id,
        input.snapshot.planetUsageGlobal
      );
      const worldHelperInsights = await this.maybeAskWorldHelper(runtime, {
        id: input.id,
        nickname: input.nickname,
        config: input.config,
        snapshot: input.snapshot,
        planetPanel,
        visibleHeadlines: input.visibleHeadlines,
      });

      const generated = await generateAiStoryDirection({
        nickname: input.nickname,
        config: input.config,
        inGameNow: input.snapshot.inGameNow,
        currentRound: input.snapshot.currentRound,
        maxRounds: input.snapshot.maxRounds,
        planetPanel,
        headlines: input.visibleHeadlines,
        worldHelperInsights,
      });

      await submitPlayerHeadline({
        io: runtime.io,
        sessionId: runtime.sessionId,
        joinCode: runtime.joinCode,
        playerId: input.id,
        playerNickname: input.nickname,
        currentRound: input.snapshot.currentRound,
        storyDirection: generated.storyDirection,
        inGameNow: input.snapshot.inGameNow,
      });

      recordHeadlineSubmission(runtime.sessionId, input.id);
      runtime.lastSubmittedAt.set(input.id, Date.now());

      console.log(`[AI ${runtime.joinCode}] ${input.nickname} submitted: ${generated.storyDirection}`);
    } catch (error) {
      console.error(`[AI ${runtime.joinCode}] ${input.nickname} submission failed:`, error);
    }
  }

  private async maybeAskWorldHelper(
    runtime: SessionRuntime,
    input: {
      id: string;
      nickname: string;
      config: ReturnType<typeof normalizeAiPlayerConfig>;
      snapshot: SessionSnapshot;
      planetPanel: PlanetPanelEntry[];
      visibleHeadlines: Awaited<ReturnType<typeof getRecentVisibleHeadlines>>;
    }
  ): Promise<AiWorldHelperInsight[]> {
    const activity = input.config.helperActivity;
    if (activity <= 0 || Math.random() >= activity) {
      return [];
    }

    const question = buildAiWorldHelperQuestion({
      nickname: input.nickname,
      config: input.config,
      inGameNow: input.snapshot.inGameNow,
      currentRound: input.snapshot.currentRound,
      maxRounds: input.snapshot.maxRounds,
      planetPanel: input.planetPanel,
      headlines: input.visibleHeadlines,
    });

    try {
      const message = await askWorldHelper({
        sessionId: runtime.sessionId,
        joinCode: runtime.joinCode,
        playerId: input.id,
        question,
        clientRequestId: `ai-helper-${input.id}-${Date.now()}`,
      });
      const insight = helperMessageToInsight(message);
      return insight ? [insight] : [];
    } catch (error) {
      console.warn(`[AI ${runtime.joinCode}] ${input.nickname} World Helper question failed:`, error);
      return [];
    }
  }
}

export const aiPlayerManager = new AiPlayerManager();

function helperMessageToInsight(message: WorldHelperMessage): AiWorldHelperInsight | null {
  const answerText = message.answer?.answerText || message.streamedText;
  if (!answerText || message.status === 'error') {
    return null;
  }

  return {
    question: message.question,
    answerText,
    entityRefs: (message.answer?.entityRefs ?? []).map((ref) => ({
      name: ref.name,
      reason: ref.reason,
    })),
    edgeRefs: (message.answer?.edgeRefs ?? []).map((ref) => ({
      sourceName: ref.sourceName,
      targetName: ref.targetName,
      relationType: ref.relationType,
      reason: ref.reason,
    })),
  };
}
