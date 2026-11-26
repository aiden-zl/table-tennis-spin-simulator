/**
 * Rally engine — pure TypeScript (no three.js, no DOM) so it runs headless in tests.
 *
 * Timeline of one ball (t = seconds relative to the opponent's contact / launch):
 *   start(plan)          -> phase 'windup', t = -swing.leadTime ('windup' event on next update)
 *   t reaches 0          -> 'launch' event, phase 'incoming'
 *   incoming             -> ball = plan.incoming.states[step] (exact replay, step = SIM_DT ticks)
 *   freeze mode          -> at step = contactIndex - round(freezeLead / SIM_DT): phase 'frozen',
 *                           nothing advances until resume()
 *   step == contactIndex -> 'contact' event (RallyResult), phase 'returning'
 *   returning            -> ball stepped with stepWorld at SIM_DT from afterHit (bit-identical to
 *                           simulateReturn); RESULT_DELAY after the outcome -> 'result' event
 *
 * All transitions are step-indexed, so results are independent of the caller's frame dt.
 */
import type {
  ControlMode,
  CoachReport,
  PaddleControl,
  PaddlePose,
  RallyEngineOptions,
  RallyPhase,
  RallyResult,
  RallySnapshot,
  ShotPlan,
} from '../contracts';
import { BallState, WorldEvent, cloneBall, stepWorld } from '../physics/ball';
import {
  BALL_RADIUS,
  PADDLE_HALF_HEIGHT,
  PADDLE_HALF_WIDTH,
  FLOOR_Y,
  SIM_DT,
  TABLE_HALF_LENGTH,
  TABLE_Y,
} from '../physics/constants';
import { simulateReturn } from '../physics/trajectory';
import { Vec3, addScaled, clone, lerp, normalize, v3 } from '../physics/vec';
import { analyzeReturn } from './coach';
import { opponentReadyPose } from './opponentSwing';
import { bladeUp, controlNormal, hitWithPaddle, paddleMeetsBall, playerPaddlePose } from './playerStroke';

export type RallyEvent =
  | { type: 'windup' }
  | { type: 'launch' }
  | { type: 'bounce'; side: 'player' | 'opponent'; p: Vec3 }
  | { type: 'net'; p: Vec3 }
  | { type: 'frozen' }
  | { type: 'contact'; result: RallyResult }
  | { type: 'floor'; p: Vec3 }
  | { type: 'result'; result: RallyResult };

/** maximum simulated seconds consumed per update() call */
export const MAX_UPDATE_DT = 0.1;
/** delay between the return's outcome (bounce / net / floor) and the 'result' phase */
export const RESULT_DELAY = 0.7;
/** after a miss: time from contact until 'result' */
export const MISS_RESULT_DELAY = 0.8;
/** hard cap on post-contact ball simulation (s) */
const MAX_POST_CONTACT = 6;
/** player's ready position (paddle centre) */
export const PLAYER_READY_POS: Vec3 = v3(0.15, TABLE_Y + 0.22, TABLE_HALF_LENGTH + 0.35);
/** playerPaddlePose's backswing duration (start of the visible stroke) */
const BACKSWING = 0.18;
/** seconds of windup over which the opponent paddle eases in from its previous pose */
const OPP_BLEND_TIME = 0.3;

export const DEFAULT_CONTROL: PaddleControl = {
  pitchDeg: 0,
  yawDeg: 0,
  stroke: 'block',
  strength: 0.5,
  x: 0,
  y: TABLE_Y + 0.2,
};

const EPS = 1e-9;
const clamp = (x: number, a: number, b: number) => Math.min(Math.max(x, a), b);
const smooth = (u: number) => {
  const c = clamp(u, 0, 1);
  return c * c * (3 - 2 * c);
};
const copyControl = (c: PaddleControl): PaddleControl => ({ ...c });

/** true if the ball centre lies inside the blade ellipse (enlarged by the ball radius). */
export function paddleCovers(control: PaddleControl, ballPos: Vec3): boolean {
  const ax = PADDLE_HALF_WIDTH + BALL_RADIUS;
  const ay = PADDLE_HALF_HEIGHT + BALL_RADIUS;
  const dx = (ballPos.x - control.x) / ax;
  const dy = (ballPos.y - control.y) / ay;
  return dx * dx + dy * dy <= 1;
}

const PROVISIONAL_HEADLINE: Record<RallyResult['outcome'], string> = {
  in: 'In! Good return',
  net: 'Into the net',
  long: 'Long — past the end line',
  wide: 'Wide — off the side',
  'own-side': 'Hit your own side',
  short: "Didn't reach the net",
  miss: 'Missed the ball',
};

function fallbackReport(outcome: RallyResult['outcome']): CoachReport {
  return {
    outcome,
    ideal: null,
    headline: PROVISIONAL_HEADLINE[outcome],
    tips: [],
  };
}

export class RallyEngine {
  private opts: RallyEngineOptions;
  private control: PaddleControl = copyControl(DEFAULT_CONTROL);

  private plan: ShotPlan | null = null;
  private phase: RallyPhase = 'idle';
  /** options latched at start() */
  private mode: ControlMode = 'realtime';
  private freezeStep = -1;
  private resumed = false;

  /** windup: continuous time (negative) */
  private windupT = 0;
  /** opponent paddle pose last rendered, and the pose a new ball's windup blends in from */
  private lastOppPose: PaddlePose | null = null;
  /** the current result's coach report is final (provided or computed) */
  private coachDone = false;
  private externalCoach = false;
  private oppBlendFrom: PaddlePose | null = null;
  private lastPlayerPose: PaddlePose | null = null;
  private playerBlendFrom: PaddlePose | null = null;
  /** steps since launch (incoming: index into states; returning: contactIndex + post steps) */
  private step = 0;
  private acc = 0;
  private evPtr = 0;

  private ball: BallState = { p: v3(), v: v3(), w: v3() };
  private ballVisible = false;
  private ballAtRest = false;

  private result: RallyResult | null = null;
  /** post-contact step (counted from contact) at which 'result' fires */
  private resultStep = 0;
  private postStep = 0;
  private pending: RallyEvent[] = [];

  constructor(opts: RallyEngineOptions) {
    this.opts = { ...opts };
    this.mode = opts.controlMode;
    this.ball.p = clone(opponentReadyPose(0).pos);
  }

  getOptions(): RallyEngineOptions {
    return { ...this.opts };
  }

  /** controlMode / freezeLead apply from the next ball; autoPosition applies immediately. */
  setOptions(opts: Partial<RallyEngineOptions>): void {
    this.opts = { ...this.opts, ...opts };
  }

  setControl(control: PaddleControl): void {
    this.control = copyControl(control);
  }

  getControl(): PaddleControl {
    return copyControl(this.control);
  }

  get currentPhase(): RallyPhase {
    return this.phase;
  }

  /** begin a new ball (windup -> incoming -> ...) */
  start(plan: ShotPlan): void {
    this.plan = plan;
    this.oppBlendFrom = this.lastOppPose;
    this.playerBlendFrom = this.lastPlayerPose;
    this.mode = this.opts.controlMode;
    const ci = plan.incoming.contactIndex;
    this.freezeStep =
      this.mode === 'freeze' ? clamp(ci - Math.round(Math.max(this.opts.freezeLead, 0) / SIM_DT), 0, ci) : -1;
    this.resumed = false;
    this.windupT = -Math.max(plan.swing.leadTime, 0);
    this.step = 0;
    this.acc = 0;
    this.evPtr = 0;
    this.result = null;
    this.coachDone = false;
    this.resultStep = 0;
    this.postStep = 0;
    this.ballAtRest = false;
    this.phase = 'windup';
    this.ball = { p: clone(plan.swing.preContactBallAt(clamp(this.windupT, -plan.swing.leadTime, 0))), v: v3(), w: v3() };
    this.ballVisible = true;
    this.pending = [{ type: 'windup' }];
  }

  /** advance by `simDt` SIMULATED seconds (caller applies slow-mo and frame clamping) */
  update(simDt: number): RallyEvent[] {
    const out = this.pending;
    this.pending = [];
    let remaining = Number.isFinite(simDt) ? clamp(simDt, 0, MAX_UPDATE_DT) : 0;
    const plan = this.plan;
    if (!plan) return out;

    // loop until the time is consumed or the engine is waiting (frozen / result reached)
    for (let guard = 0; guard < 8; guard++) {
      if (this.phase === 'windup') {
        this.windupT += remaining;
        remaining = 0;
        if (this.windupT >= -EPS) {
          remaining = Math.max(this.windupT, 0);
          this.windupT = 0;
          this.phase = 'incoming';
          this.step = 0;
          this.acc = 0;
          this.ball = cloneBall(plan.incoming.states[0]);
          out.push({ type: 'launch' });
          // a freeze point at launch
          if (this.checkFreeze(out)) return out;
          continue;
        }
        this.ball = { p: clone(plan.swing.preContactBallAt(clamp(this.windupT, -plan.swing.leadTime, 0))), v: v3(), w: v3() };
        return out;
      }

      if (this.phase === 'incoming') {
        this.acc += remaining;
        remaining = 0;
        const inc = plan.incoming;
        while (this.acc >= SIM_DT - EPS && this.step < inc.contactIndex) {
          this.acc -= SIM_DT;
          this.step++;
          this.ball = cloneBall(inc.states[this.step]);
          this.emitIncomingEvents(out);
          if (this.checkFreeze(out)) return out;
        }
        if (this.step >= inc.contactIndex) {
          remaining = Math.max(this.acc, 0);
          this.acc = 0;
          this.doContact(out);
          continue;
        }
        return out;
      }

      if (this.phase === 'returning' || this.phase === 'result') {
        this.acc += remaining;
        remaining = 0;
        while (this.acc >= SIM_DT - EPS) {
          this.acc -= SIM_DT;
          this.stepPost(out);
          if (this.phase === 'returning' && this.postStep >= this.resultStep) {
            this.phase = 'result';
            this.acc = 0; // snapshot at 'result' is identical whatever the dt pattern
            this.finishCoaching();
            out.push({ type: 'result', result: this.result! });
            return out;
          }
        }
        return out;
      }

      // idle / frozen: nothing advances
      return out;
    }
    return out;
  }

  /** freeze mode: continue from the frozen pre-contact moment */
  resume(): void {
    if (this.phase !== 'frozen') return;
    this.resumed = true;
    this.phase = 'incoming';
    this.acc = 0;
  }

  snapshot(): RallySnapshot {
    const plan = this.plan;
    const t = this.tSinceLaunch();
    let opponentPaddle: PaddlePose;
    if (!plan || this.phase === 'idle') {
      opponentPaddle = opponentReadyPose(plan ? plan.spec.fromX : 0);
    } else {
      opponentPaddle = plan.swing.poseAt(t); // poseAt clamps to its own [-leadTime, ...] range
      // the previous ball may have left the paddle elsewhere (other strike x, mid-recovery):
      // ease from there during the first part of the windup instead of jumping
      const from = this.oppBlendFrom;
      if (from && this.phase === 'windup') {
        const u = smooth((t + plan.swing.leadTime) / OPP_BLEND_TIME);
        if (u < 1) {
          const normal = normalize(lerp(from.normal, opponentPaddle.normal, u));
          opponentPaddle = {
            pos: lerp(from.pos, opponentPaddle.pos, u),
            normal,
            up: bladeUp(normal, normalize(lerp(from.up, opponentPaddle.up, u))),
          };
        }
      }
    }
    this.lastOppPose = opponentPaddle;
    return {
      phase: this.phase,
      ball: cloneBall(this.ball),
      ballVisible: this.ballVisible,
      opponentPaddle,
      playerPaddle: (this.lastPlayerPose = this.playerPose(t)),
      tSinceLaunch: t,
      plan,
      result: this.result,
    };
  }

  /** back to idle (no ball) */
  reset(): void {
    this.plan = null;
    this.phase = 'idle';
    this.result = null;
    this.pending = [];
    this.step = 0;
    this.acc = 0;
    this.windupT = 0;
    this.postStep = 0;
    this.ballVisible = false;
    this.ball = { p: clone(opponentReadyPose(0).pos), v: v3(), w: v3() };
  }

  // ─────────────────────────── internals

  private tSinceLaunch(): number {
    if (!this.plan || this.phase === 'idle') return 0;
    if (this.phase === 'windup') return this.windupT;
    if (this.phase === 'incoming' || this.phase === 'frozen') return this.step * SIM_DT + this.acc;
    return this.plan.incoming.contactTime + this.postStep * SIM_DT + this.acc;
  }

  private checkFreeze(out: RallyEvent[]): boolean {
    if (this.mode !== 'freeze' || this.resumed || this.freezeStep < 0) return false;
    if (this.step >= this.freezeStep && this.phase === 'incoming') {
      this.phase = 'frozen';
      this.acc = 0;
      out.push({ type: 'frozen' });
      return true;
    }
    return false;
  }

  private emitIncomingEvents(out: RallyEvent[]): void {
    const evs = this.plan!.incoming.events;
    const now = this.step * SIM_DT + EPS;
    while (this.evPtr < evs.length && evs[this.evPtr].t <= now) {
      this.pushWorldEvent(evs[this.evPtr], out);
      this.evPtr++;
    }
  }

  private pushWorldEvent(ev: WorldEvent, out: RallyEvent[]): void {
    if (ev.kind === 'table') out.push({ type: 'bounce', side: ev.side ?? (ev.p.z >= 0 ? 'player' : 'opponent'), p: clone(ev.p) });
    else if (ev.kind === 'net') out.push({ type: 'net', p: clone(ev.p) });
    else out.push({ type: 'floor', p: clone(ev.p) });
  }

  private doContact(out: RallyEvent[]): void {
    const plan = this.plan!;
    const contactState = cloneBall(plan.incoming.contactState);
    const control = copyControl(this.control);
    // a miss is either the paddle not covering the ball (manual positioning) or a face turned
    // so far that it moves away from the ball and never strikes it
    const covered = (this.opts.autoPosition || paddleCovers(control, contactState.p)) && paddleMeetsBall(contactState, control);
    let result: RallyResult;
    if (covered) {
      const afterHit = hitWithPaddle(contactState, control);
      const ret = simulateReturn(afterHit);
      // The coach's angle search is expensive (~50-300 ms); defer it to the 'result' event so
      // the hit itself never stutters. The contact event carries a provisional report.
      result = { outcome: ret.outcome, returnResult: ret, control, contactState, afterHit, coach: fallbackReport(ret.outcome) };
      this.ball = cloneBall(afterHit);
      this.resultStep = Math.round(ret.flightTime / SIM_DT) + Math.round(RESULT_DELAY / SIM_DT);
    } else {
      result = { outcome: 'miss', returnResult: null, control, contactState, afterHit: null, coach: fallbackReport('miss') };
      this.ball = cloneBall(contactState);
      this.resultStep = Math.round(MISS_RESULT_DELAY / SIM_DT);
    }
    this.result = result;
    this.coachDone = false;
    this.postStep = 0;
    this.ballAtRest = false;
    this.phase = 'returning';
    out.push({ type: 'contact', result });
  }

  /**
   * Supply the coach report for `result` computed elsewhere (main.ts runs the coach in a Web
   * Worker from the moment of contact). Ignored if that ball is no longer current. If the
   * report arrives after the result phase, the engine has already computed it synchronously.
   */
  provideCoach(result: RallyResult, report: CoachReport): void {
    if (result !== this.result || this.coachDone) return;
    result.coach = report;
    result.coachPending = false;
    this.coachDone = true;
  }

  /**
   * true: the caller runs the coach (main.ts, in a worker) and the engine never blocks on it;
   * a result that is decided before the report arrives carries `coachPending: true` and its
   * provisional report until provideCoach() fills it in. false (default): synchronous.
   */
  setExternalCoach(on: boolean): void {
    this.externalCoach = on;
  }

  /** run the (expensive) coach analysis for the current result, once (unless provided) */
  private finishCoaching(): void {
    const r = this.result;
    if (!r || this.coachDone) return;
    if (this.externalCoach) {
      r.coachPending = true;
      return;
    }
    this.coachDone = true;
    try {
      r.coach = analyzeReturn(r.contactState, r.control, r.returnResult);
    } catch (e) {
      console.warn('analyzeReturn failed', e);
      r.coach = fallbackReport(r.outcome);
    }
  }

  /** one SIM_DT step of the post-contact ball (returned or missed) */
  private stepPost(out: RallyEvent[]): void {
    const t = this.postStep * SIM_DT;
    this.postStep++;
    if (this.ballAtRest || t >= MAX_POST_CONTACT) return;
    const events: WorldEvent[] = [];
    const prev = this.ball;
    this.ball = stepWorld(prev, SIM_DT, t, events);
    for (const ev of events) this.pushWorldEvent(ev, out);
    // settle detection only after the outcome (never disturbs parity with simulateReturn)
    const outcomeStep = this.resultStep - Math.round((this.result?.outcome === 'miss' ? MISS_RESULT_DELAY : RESULT_DELAY) / SIM_DT);
    const surfaceHit = events.some((ev) => ev.kind === 'table' || ev.kind === 'floor');
    if (this.postStep > outcomeStep && surfaceHit && Math.abs(this.ball.v.y) < 0.3) {
      // settled on the floor or the table: stop (prevents per-step micro-bounce event spam)
      const onFloor = events.some((ev) => ev.kind === 'floor');
      const restY = (onFloor ? FLOOR_Y : TABLE_Y) + BALL_RADIUS;
      this.ball = { p: v3(this.ball.p.x, restY, this.ball.p.z), v: v3(), w: v3() };
      this.ballAtRest = true;
    }
    if (Math.abs(this.ball.p.z) > 8 || Math.abs(this.ball.p.x) > 8) this.ballAtRest = true;
  }

  private playerPose(t: number): PaddlePose {
    const plan = this.plan;
    const ctrl = this.result ? this.result.control : this.control;
    const auto = this.opts.autoPosition;
    const ready = (): PaddlePose => {
      // aim is table-relative: reference it from this ball's contact point (or the ready spot)
      const n = controlNormal(ctrl, plan ? plan.incoming.contactState.p : PLAYER_READY_POS);
      // manual positioning: show the paddle where the player has put it (only the depth
      // differs from the hit position), so what is drawn is what will be hit-tested
      // (depth = this ball's contact plane, the plane the mouse is projected onto)
      const z = plan ? plan.incoming.contactState.p.z : PLAYER_READY_POS.z;
      const pos = auto ? clone(PLAYER_READY_POS) : v3(ctrl.x, ctrl.y, z);
      return { pos, normal: n, up: bladeUp(n, normalize(v3(-0.25, 1, 0))) };
    };
    if (!plan || this.phase === 'idle') return ready();
    if (this.phase === 'windup') {
      // ease in from wherever the last ball left the paddle (end of its follow-through)
      const r = ready();
      const from = this.playerBlendFrom;
      const u = from ? smooth((t + plan.swing.leadTime) / OPP_BLEND_TIME) : 1;
      if (u >= 1) return r;
      const normal = normalize(lerp(from!.normal, r.normal, u));
      return { pos: lerp(from!.pos, r.pos, u), normal, up: bladeUp(normal, normalize(lerp(from!.up, r.up, u))) };
    }
    const cs = plan.incoming.contactState.p;
    // where the ball centre is "aimed" by the paddle at contact
    let ballAim: Vec3;
    if (auto) ballAim = clone(cs);
    else {
      // paddle centre exactly at (x, y, contactZ): playerPaddlePose offsets the centre by one
      // ball radius behind the ball along the face normal, so pre-compensate
      const n = controlNormal(ctrl, cs);
      ballAim = addScaled(v3(ctrl.x, ctrl.y, cs.z), n, BALL_RADIUS);
    }
    const tRel = t - plan.incoming.contactTime;
    if (tRel >= -BACKSWING) return playerPaddlePose(ctrl, ballAim, tRel, cs);
    // ease from ready toward the start of the backswing
    const start = playerPaddlePose(ctrl, ballAim, -BACKSWING, cs);
    const span = Math.max(plan.incoming.contactTime - BACKSWING, 1e-3);
    const u = smooth(t / span);
    const r = ready();
    return { pos: lerp(r.pos, start.pos, u), normal: start.normal, up: start.up };
  }
}
