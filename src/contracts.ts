/**
 * SHARED CONTRACTS — every module codes against these types. Do not change a signature here
 * without coordinating; other modules are written in parallel against it.
 *
 * Coordinate system, units and spin sign conventions: see src/physics/constants.ts header.
 * Physics primitives: src/physics/ball.ts (stepWorld, surfaceContact), trajectory.ts
 * (predictIncoming, simulateReturn), spin.ts (spinVector, spinComponents, describeSpin),
 * src/game/playerStroke.ts (player paddle model).
 */
import type { BallState } from './physics/ball';
import type { SpinSpec } from './physics/spin';
import type { IncomingPrediction, ReturnOutcome, ReturnResult, ShotKind } from './physics/trajectory';
import type { PaddleControl, PaddlePose, StrokeType } from './game/playerStroke';
import type { Vec3 } from './physics/vec';

export type { BallState, SpinSpec, IncomingPrediction, ReturnOutcome, ReturnResult, ShotKind, PaddleControl, PaddlePose, StrokeType, Vec3 };

// ───────────────────────────── Opponent shots (src/physics/shotSolver.ts, src/game/shots.ts)

/** Speed category of the opponent's shot. */
export type Pace = 'slow' | 'medium' | 'fast';

/** What the user (custom mode) or the bot asks the opponent to play. */
export interface ShotSpec {
  kind: ShotKind;
  /** spin relative to the ball's direction of travel (rps) — see SpinSpec docs */
  spin: SpinSpec;
  pace: Pace;
  /**
   * Target first bounce on the PLAYER's half, world coords. x in [-0.65, 0.65],
   * z in [0.25, 1.25] (0.25 = short, near the net; 1.25 = deep, near the end line).
   */
  target: { x: number; z: number };
  /** where the opponent strikes from: x position across their end, in [-0.6, 0.6] */
  fromX: number;
}

/** A solved, validated shot ready to play. */
export interface ShotPlan {
  spec: ShotSpec;
  /** ball state the instant it leaves the opponent's paddle */
  launch: BallState;
  /** full deterministic prediction to the player's contact point (valid === true) */
  incoming: IncomingPrediction;
  /** opponent paddle motion consistent with the spin (from opponentSwing.ts) */
  swing: OpponentSwing;
  /** short human name, e.g. "Heavy backspin serve" (preset name, or describeSpin for random) */
  name: string;
}

export interface ShotPreset {
  id: string;
  name: string;
  /** one-sentence explanation of what the shot is and how it is produced */
  description: string;
  spec: ShotSpec;
}

// ───────────────────────────── Opponent swing (src/game/opponentSwing.ts)

/**
 * Opponent paddle motion. Times are relative to contact (t=0 is the instant the ball leaves
 * the opponent's paddle; negative = backswing). Visual only, but it MUST be physically
 * consistent with the launched spin: the face normal and brush (tangential paddle velocity)
 * are derived from the launch spin vector so a viewer can read spin from the swing.
 */
export interface OpponentSwing {
  /**
   * paddle pose at time tRel (seconds) relative to contact. Defined for every tRel: clamped to
   * the ready pose before -leadTime; after the follow-through it eases back to
   * opponentReadyPose (reached ~1.1 s after contact).
   */
  poseAt(tRel: number): PaddlePose;
  /** paddle velocity at contact (m/s) */
  contactVelocity: Vec3;
  /** face normal at contact (points toward the ball / the player's side) */
  contactNormal: Vec3;
  /** unit direction of the brushing motion along the face at contact */
  brushDir: Vec3;
  /** for serves: ball position during the toss, tRel in [-0.9, 0]; for rally shots: the incoming feed */
  preContactBallAt(tRel: number): Vec3;
  /** how long before contact the visible sequence starts (seconds, positive) */
  leadTime: number;
}

// ───────────────────────────── Coaching (src/game/coach.ts)

export interface AngleWindow {
  /** best (most robust) pitch/yaw for the given stroke & strength */
  bestPitch: number;
  bestYaw: number;
  /** contiguous passing pitch range at bestYaw (degrees) */
  pitchMin: number;
  pitchMax: number;
  /** contiguous passing yaw range at bestPitch */
  yawMin: number;
  yawMax: number;
  /**
   * fraction of the whole searched pitch x yaw grid (-70..80 deg x -45..45 deg) that lands in
   * (0..1): how forgiving this ball is. Real balls score ~0.01-0.12 (median ~0.04), because
   * most of that grid is nowhere near a sensible angle.
   */
  forgiveness: number;
}

export interface CoachReport {
  /** outcome of what the player actually did ('miss' = paddle never touched the ball) */
  outcome: ReturnOutcome | 'miss';
  /** ideal angles for the stroke the player used; null if NO angle works with that stroke */
  ideal: AngleWindow | null;
  /** if ideal is null (or much better elsewhere): stroke that works best for this ball */
  suggestedStroke?: StrokeType;
  suggestedWindow?: AngleWindow;
  /** swing strength the suggested window was found at (0..1) */
  suggestedStrength?: number;
  /** player's angle error vs ideal (deg). + means the player was more OPEN / more RIGHT */
  pitchError?: number;
  yawError?: number;
  /** headline, e.g. "Into the net — too closed for this backspin" */
  headline: string;
  /** 1-3 short coaching sentences, generated from simulated outcomes */
  tips: string[];
  /** the ideal return's path (for drawing a ghost trajectory) */
  idealPath?: Vec3[];
}

// ───────────────────────────── Rally engine (src/game/rally.ts)

export type ControlMode = 'realtime' | 'freeze';
export type OpponentMode = 'custom' | 'bot';
/** how much spin-visualisation help is shown in bot mode */
export type AssistLevel = 'full' | 'wind' | 'ball';

export type RallyPhase =
  | 'idle' // waiting for the next ball
  | 'windup' // opponent tossing / swinging; ball attached to pre-contact path
  | 'incoming' // ball in flight toward player
  | 'frozen' // freeze mode: ball paused just before contact, player adjusts angle
  | 'returning' // player hit it; ball flying back
  | 'result'; // outcome decided, showing feedback

export interface RallySnapshot {
  phase: RallyPhase;
  /** current ball state for rendering */
  ball: BallState;
  ballVisible: boolean;
  /** opponent paddle pose for rendering */
  opponentPaddle: PaddlePose;
  /** player paddle pose for rendering */
  playerPaddle: PaddlePose;
  /** time relative to the opponent's contact (s), negative during windup */
  tSinceLaunch: number;
  /** the shot being played (null when idle before the first shot) */
  plan: ShotPlan | null;
  /** set once the player has hit (or missed) */
  result: RallyResult | null;
}

export interface RallyResult {
  /** 'miss' = paddle didn't cover the ball (manual positioning) */
  outcome: ReturnOutcome | 'miss';
  returnResult: ReturnResult | null;
  /** player control at contact */
  control: PaddleControl;
  /** incoming ball state at contact and the state right after the hit */
  contactState: BallState;
  afterHit: BallState | null;
  coach: CoachReport;
  /** the coach report is still being computed (external/async coach); `coach` is provisional */
  coachPending?: boolean;
}

export interface RallyEngineOptions {
  controlMode: ControlMode;
  /** true: paddle auto-positions to the ball, player only controls angle/stroke */
  autoPosition: boolean;
  /** freeze mode: seconds before contact at which the ball pauses */
  freezeLead: number;
}

// ───────────────────────────── Stats (src/game/stats.ts)

export interface StatsBucket {
  attempts: number;
  made: number;
}

export interface StatsSnapshot {
  total: StatsBucket;
  streak: number;
  bestStreak: number;
  /** keyed by spin category: 'topspin' | 'backspin' | 'sidespin' | 'nospin' | 'mixed' ... */
  byCategory: Record<string, StatsBucket>;
  /** last 20 outcomes, newest last */
  recent: (ReturnOutcome | 'miss')[];
}
