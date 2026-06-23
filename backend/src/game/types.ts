/**
 * game phase types and interfaces for the future headlines game
 */

export type GamePhase = 'WAITING' | 'TUTORIAL' | 'PLAYING' | 'BREAK' | 'FINISHED';

/**
 * configuration for a game session (from db)
 */
export interface GameSessionConfig {
  sessionId: string;
  joinCode: string;
  playMinutes: number;
  breakMinutes: number;
  maxRounds: number;
  timelineSpeedRatio: number;
}

/**
 * current runtime state of a game session
 */
export interface GameSessionRuntimeState extends GameSessionConfig {
  phase: GamePhase;
  currentRound: number;
  phaseStartedAt: Date | null;
  phaseEndsAt: Date | null;
  inGameStartAt: Date | null;
  isPaused: boolean;
  pausedAt: Date | null;
  pauseRemainingMs: number | null;
  pauseTimelineSpeedRatio: number | null;
}

/**
 * phase transition event data
 */
export interface PhaseTransition {
  sessionId: string;
  fromPhase: GamePhase;
  toPhase: GamePhase;
  roundNo: number;
}

/**
 * computed game state for broadcasting to clients
 */
export interface GameStateSnapshot {
  phase: GamePhase;
  currentRound: number;
  playMinutes: number;
  breakMinutes: number;
  maxRounds: number;
  phaseStartedAt: string | null;
  phaseEndsAt: string | null;
  isPaused: boolean;
  pausedAt: string | null;
  pauseRemainingMs: number | null;
  serverNow: string;
  inGameNow: string | null;
  timelineSpeedRatio: number;
}
