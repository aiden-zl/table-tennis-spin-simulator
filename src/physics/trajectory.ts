import { BallState, WorldEvent, cloneBall, stepWorld } from './ball';
import {
  BALL_RADIUS,
  SIM_DT,
  TABLE_HALF_LENGTH,
  TABLE_HALF_WIDTH,
  TABLE_Y,
} from './constants';
import { Vec3, clone, v3 } from './vec';

/** Furthest z (behind the player's end line) at which the receiver will take the ball. */
export const CONTACT_MAX_Z = TABLE_HALF_LENGTH + 0.35;
/** Lowest playable contact height (ball centre above table top). */
export const MIN_CONTACT_HEIGHT = 0.04;

export type ShotKind = 'serve' | 'rally';

export interface IncomingPrediction {
  valid: boolean;
  /** why the shot is not a legal, hittable incoming ball */
  reason?: string;
  /** samples every SIM_DT from launch (index i => time i*SIM_DT), up to and including contact */
  states: BallState[];
  events: WorldEvent[];
  /** index into states at which the receiver's paddle meets the ball */
  contactIndex: number;
  contactTime: number;
  contactState: BallState;
  /** first bounce on the player's half */
  playerBounce?: Vec3;
  /** for serves: first bounce on the opponent's half */
  serverBounce?: Vec3;
  /** ball centre height above the net top as it crosses z=0 */
  netClearance?: number;
}

/**
 * Simulate an opponent shot from the moment it leaves the opponent's paddle until the
 * player's contact point. Deterministic: fixed SIM_DT steps from the launch state.
 *
 * Contact rule: after the ball bounces on the player's half it is taken at the top of the
 * bounce (vy crosses from + to -), or as soon as it travels past CONTACT_MAX_Z.
 */
export function predictIncoming(launch: BallState, kind: ShotKind, maxTime = 3): IncomingPrediction {
  const states: BallState[] = [cloneBall(launch)];
  const events: WorldEvent[] = [];
  let b = cloneBall(launch);
  let serverBounce: Vec3 | undefined;
  let playerBounce: Vec3 | undefined;
  let netClearance: number | undefined;
  let bouncedOnPlayer = false;
  const fail = (reason: string): IncomingPrediction => ({
    valid: false,
    reason,
    states,
    events,
    contactIndex: states.length - 1,
    contactTime: (states.length - 1) * SIM_DT,
    contactState: cloneBall(states[states.length - 1]),
    playerBounce,
    serverBounce,
    netClearance,
  });

  const steps = Math.ceil(maxTime / SIM_DT);
  for (let i = 0; i < steps; i++) {
    const t = i * SIM_DT;
    const prev = b;
    const evStart = events.length;
    b = stepWorld(b, SIM_DT, t, events);
    states.push(b);

    // net crossing clearance
    if (prev.p.z < 0 && b.p.z >= 0 && netClearance === undefined) {
      const f = -prev.p.z / Math.max(b.p.z - prev.p.z, 1e-12);
      const y = prev.p.y + (b.p.y - prev.p.y) * f;
      netClearance = y - BALL_RADIUS - (TABLE_Y + 0.1525);
    }

    for (let k = evStart; k < events.length; k++) {
      const ev = events[k];
      if (ev.kind === 'net') {
        // the net handler pushes the ball back, so the crossing above never fires
        if (netClearance === undefined) netClearance = ev.p.y - BALL_RADIUS - (TABLE_Y + 0.1525);
        return fail('net');
      }
      if (ev.kind === 'floor') return fail(bouncedOnPlayer ? 'not-reached' : 'out');
      if (ev.kind === 'table') {
        if (ev.side === 'opponent') {
          if (kind === 'rally') return fail('bounced-own-side');
          if (serverBounce) return fail('double-bounce-server');
          serverBounce = clone(ev.p);
        } else {
          if (kind === 'serve' && !serverBounce) return fail('serve-missed-own-side');
          if (bouncedOnPlayer) return fail('double-bounce');
          bouncedOnPlayer = true;
          playerBounce = clone(ev.p);
        }
      }
    }

    if (bouncedOnPlayer && playerBounce) {
      const apex = prev.v.y > 0 && b.v.y <= 0;
      const pastLimit = b.p.z >= CONTACT_MAX_Z;
      if (apex || pastLimit) {
        const height = b.p.y - TABLE_Y;
        if (height < MIN_CONTACT_HEIGHT) return fail('too-low');
        if (Math.abs(b.p.x) > TABLE_HALF_WIDTH + 0.45) return fail('too-wide');
        return {
          valid: true,
          states,
          events,
          contactIndex: states.length - 1,
          contactTime: (states.length - 1) * SIM_DT,
          contactState: cloneBall(b),
          playerBounce,
          serverBounce,
          netClearance,
        };
      }
    }
    if (b.v.z <= 0 && b.p.z > -TABLE_HALF_LENGTH) {
      // ball stopped coming toward the player (e.g. huge backspin pulled it back over the net)
      if (bouncedOnPlayer) return fail('came-back');
    }
  }
  return fail('timeout');
}

export type ReturnOutcome = 'in' | 'net' | 'long' | 'wide' | 'own-side' | 'short';

export interface ReturnResult {
  outcome: ReturnOutcome;
  /** where the ball first touched the opponent's half ('in'), or crossed table height ('long'/'wide') */
  landing?: Vec3;
  /** ball bottom height above the net top when crossing z=0 (negative = below the net top) */
  netClearance?: number;
  /** sampled path every `sampleEvery` steps, starting at the hit */
  path: Vec3[];
  flightTime: number;
}

/**
 * Simulate the player's return from the instant after paddle contact until it is decided.
 * Uses the same SIM_DT stepping as live play, so the coach's predictions match what the
 * player will actually see.
 */
export function simulateReturn(afterHit: BallState, sampleEvery = 10, maxTime = 3): ReturnResult {
  let b = cloneBall(afterHit);
  const path: Vec3[] = [clone(b.p)];
  const events: WorldEvent[] = [];
  let netClearance: number | undefined;
  let crossedNet = false;
  let descendLanding: Vec3 | undefined;
  const steps = Math.ceil(maxTime / SIM_DT);
  for (let i = 0; i < steps; i++) {
    const prev = b;
    const evStart = events.length;
    b = stepWorld(b, SIM_DT, i * SIM_DT, events);
    if (i % sampleEvery === sampleEvery - 1) path.push(clone(b.p));
    const t = (i + 1) * SIM_DT;

    if (!crossedNet && prev.p.z > 0 && b.p.z <= 0) {
      const f = prev.p.z / Math.max(prev.p.z - b.p.z, 1e-12);
      const y = prev.p.y + (b.p.y - prev.p.y) * f;
      netClearance = y - BALL_RADIUS - (TABLE_Y + 0.1525);
    }
    if (b.p.z < 0) crossedNet = true;

    // record where an out ball comes down through table height (for the landing marker)
    if (
      !descendLanding &&
      prev.p.y - BALL_RADIUS >= TABLE_Y &&
      b.p.y - BALL_RADIUS < TABLE_Y &&
      b.p.z < 0
    ) {
      descendLanding = v3(b.p.x, TABLE_Y, b.p.z);
    }

    for (let k = evStart; k < events.length; k++) {
      const ev = events[k];
      const done = (outcome: ReturnOutcome, landing?: Vec3): ReturnResult => {
        path.push(clone(b.p));
        return { outcome, landing, netClearance, path, flightTime: t };
      };
      if (ev.kind === 'net') {
        // the net handler pushes the ball back, so the crossing above never fires
        if (netClearance === undefined) netClearance = ev.p.y - BALL_RADIUS - (TABLE_Y + 0.1525);
        return done('net', ev.p);
      }
      if (ev.kind === 'table') {
        if (ev.side === 'opponent') return done('in', ev.p);
        return done('own-side', ev.p);
      }
      if (ev.kind === 'floor') {
        if (!crossedNet) return done('short', ev.p);
        const l = descendLanding ?? ev.p;
        if (Math.abs(l.x) > TABLE_HALF_WIDTH && l.z >= -TABLE_HALF_LENGTH) return done('wide', l);
        if (l.z < -TABLE_HALF_LENGTH && Math.abs(l.x) > TABLE_HALF_WIDTH + 0.25) return done('wide', l);
        return done('long', l);
      }
    }
    if (!crossedNet && b.v.z > 0 && b.p.z > afterHit.p.z + 0.3) {
      path.push(clone(b.p));
      return { outcome: 'short', netClearance, path, flightTime: t };
    }
  }
  return { outcome: 'short', netClearance, path, flightTime: maxTime };
}
