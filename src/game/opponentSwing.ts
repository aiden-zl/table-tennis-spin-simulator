/**
 * Opponent paddle motion that physically explains the launched spin.
 *
 * The opponent stands behind z = -1.37 facing +z (toward the player) and is right-handed
 * (their paddle is on THEIR right = world -x side of the body).
 *
 * Physics: the face normal n (pointing at the ball / the player) and the paddle velocity Vp
 * at contact are found by a small numeric fit: a ball arriving exactly as `incomingAtContact`
 * says (falling out of the toss for serves, a feed from the player's side for rally balls) is
 * struck through the very same `surfaceContact` impulse model (PADDLE_RESTITUTION,
 * PADDLE_FRICTION, PADDLE_TANGENTIAL_RESTITUTION) and (n, Vp) are chosen so the outgoing
 * velocity direction and spin vector match `launch` as closely as possible. Directions are
 * weighted far above magnitudes so the visible face tilt and brush direction are truthful even
 * when the exact speed/spin combination is not reachable by a single impulse.
 *
 * Brush relation (follows from the impulse model, r = -R n):
 *   spin change  Δw ∝ r × Jt ∝ (brush) × n     — brush = tangential motion of the paddle
 *   relative to the ball's contact point. Brushing UP behind a ball flying to +z gives
 *   w.x > 0 (topspin); brushing DOWN/under gives backspin; brushing toward -x gives w.y > 0.
 */
import { BallState, surfaceContact } from '../physics/ball';
import {
  BALL_RADIUS,
  DEG,
  G,
  PADDLE_FRICTION,
  PADDLE_RESTITUTION,
  PADDLE_TANGENTIAL_RESTITUTION,
  TABLE_Y,
} from '../physics/constants';
import { Vec3, add, addScaled, clone, cross, dot, len, normalize, scale, sub, v3 } from '../physics/vec';
import type { OpponentSwing, PaddlePose, ShotKind } from '../contracts';

// ─────────────────────────────────────────────────────────────── tunables

export const SERVE_LEAD_TIME = 0.9;
export const RALLY_LEAD_TIME = 0.6;
/** toss height above the palm (rules require >= 16 cm) */
export const TOSS_HEIGHT = 0.3;
/** horizontal speed of the visual feed ball in rally mode (m/s) */
const FEED_SPEED = 5;
/** visual exaggeration of the swing path so it reads from the far end */
const PATH_EXAGGERATION = 1.3;
/** max backswing / follow-through lengths (m, before exaggeration) */
const MAX_BACKSWING = 0.45;
const MAX_FOLLOW = 0.4;
/** face tilt limits for the fit */
const MAX_PITCH = 78 * DEG;
const MAX_YAW = 70 * DEG;
/**
 * Suggested horizontal offset from the opponent's paddle to their body centre: the paddle is
 * on THEIR right (world -x of the body), so body.x ≈ paddle.x - OPPONENT_PADDLE_OFFSET_X.
 */
export const OPPONENT_PADDLE_OFFSET_X = -0.22;
/**
 * preferred handle->tip direction: the tip leans to the opponent's LEFT (+x) and slightly back
 * toward the opponent (-z). The -z lean guarantees it is never parallel to a face normal (all
 * fitted normals have n.z > 0), so `up` cannot flip.
 */
const PREFERRED_UP = normalize(v3(0.25, 1, -0.5));
const upFor = (n: Vec3): Vec3 => normalize(sub(PREFERRED_UP, scale(n, dot(PREFERRED_UP, n))));

/** rally feed bounce restitution on the table (visual arc only) */
const FEED_BOUNCE_E = 0.9;

// ─────────────────────────────────────────────────────────────── incoming ball

interface FeedPath {
  at(tRel: number): Vec3;
  /** ball state the instant before the opponent's contact */
  contact: BallState;
}

/** Serve: ball rests in the open palm directly below the contact point, then a vertical toss. */
function serveFeed(launch: BallState): FeedPath {
  const P = launch.p;
  const palmY = Math.max(P.y, TABLE_Y + 0.03);
  const apexY = palmY + TOSS_HEIGHT;
  const tRise = Math.sqrt((2 * TOSS_HEIGHT) / G);
  const tFall = Math.sqrt((2 * (apexY - P.y)) / G);
  const tApex = -tFall;
  const tToss = tApex - tRise; // instant the ball leaves the palm (negative)
  const at = (tRel: number): Vec3 => {
    if (tRel <= tToss) return v3(P.x, palmY, P.z);
    const t = Math.min(tRel, 0);
    if (tRel >= 0) return clone(P);
    return v3(P.x, apexY - 0.5 * G * (t - tApex) * (t - tApex), P.z);
  };
  return { at, contact: { p: clone(P), v: v3(0, -G * tFall, 0), w: v3() } };
}

/**
 * Rally: a ball the player has just hit, arriving from the player's side, bouncing once on the
 * opponent's half and rising into the contact point. Gravity-only arcs (visual), continuous.
 */
function rallyFeed(launch: BallState): FeedPath {
  const P = launch.p;
  const total = RALLY_LEAD_TIME;
  // start horizontally over the player's half, roughly centred
  const startXZ = { x: P.x * 0.3, z: P.z + FEED_SPEED * total };
  const hx = (P.x - startXZ.x) / total;
  const hz = (P.z - startXZ.z) / total; // < 0 (toward the opponent)
  const hSpeed = Math.hypot(hx, hz);
  // bounce ~0.6 m in front of the contact point (on the table)
  const bounceZ = Math.min(Math.max(P.z + 0.6, -1.25), -0.3); // always on the opponent's half
  const bounceDist = Math.max(bounceZ - P.z, 0.15);
  const T2 = Math.min(bounceDist / hSpeed, total * 0.6);
  const by = TABLE_Y + BALL_RADIUS;
  const dy = Math.max(P.y - by, 0.02);
  // after bounce: from B (t = -T2) up to P (t = 0)
  const vyUp = dy / T2 + 0.5 * G * T2;
  const vyDown = -vyUp / FEED_BOUNCE_E;
  const B = v3(P.x - hx * T2, by, P.z - hz * T2);
  const at = (tRel: number): Vec3 => {
    const t = Math.min(Math.max(tRel, -total), 0);
    if (tRel >= 0) return clone(P);
    if (t >= -T2) {
      const s = t + T2;
      return v3(B.x + hx * s, by + vyUp * s - 0.5 * G * s * s, B.z + hz * s);
    }
    const s = t + T2; // negative
    return v3(B.x + hx * s, by + vyDown * s - 0.5 * G * s * s, B.z + hz * s);
  };
  return { at, contact: { p: clone(P), v: v3(hx, vyUp - G * T2, hz), w: v3() } };
}

/** Ball state the instant before the opponent's paddle touches it (used by the fit and tests). */
export function incomingAtContact(launch: BallState, kind: ShotKind): BallState {
  return (kind === 'serve' ? serveFeed(launch) : rallyFeed(launch)).contact;
}

// ─────────────────────────────────────────────────────────────── contact fit

const normalFromAngles = (pitch: number, yaw: number): Vec3 =>
  v3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));

const strike = (ball: BallState, n: Vec3, vp: Vec3): BallState =>
  surfaceContact(ball, n, vp, PADDLE_RESTITUTION, PADDLE_FRICTION, PADDLE_TANGENTIAL_RESTITUTION);

const cosBetween = (a: Vec3, b: Vec3): number => {
  const la = len(a);
  const lb = len(b);
  return la < 1e-9 || lb < 1e-9 ? 0 : dot(a, b) / (la * lb);
};

/** params: [pitch, yaw, Vp.x, Vp.y, Vp.z] */
type Params = number[];

const CORK_WEIGHT = 8;

function fitCost(p: Params, ball: BallState, target: BallState): number {
  const [pitch, yaw, vx, vy, vz] = p;
  const n = normalFromAngles(pitch, yaw);
  const vp = v3(vx, vy, vz);
  const out = strike(ball, n, vp);
  let c = 0;
  const vt = len(target.v);
  const vo = len(out.v);
  const cv = cosBetween(out.v, target.v);
  c += 10 * (1 - cv);
  // barrier: the swing must send the ball where it actually goes (within ~18 deg)
  c += 300 * Math.max(0, Math.acos(Math.min(1, Math.max(-1, cv))) - 18 * DEG) ** 2;
  c += 1.5 * Math.log((vo + 0.3) / (vt + 0.3)) ** 2;
  const wt = len(target.w);
  const wo = len(out.w);
  if (wt > 6) {
    // corkscrew-dominated spin is hard to make from one flat contact; weight its direction up
    // so the fit prefers a face that brushes sideways under/over the ball (the real mechanism)
    const cork = cosBetween(target.w, target.v) ** 2;
    c += (4 + CORK_WEIGHT * cork) * (1 - cosBetween(out.w, target.w));
    c += 0.4 * Math.log((wo + 15) / (wt + 15)) ** 2;
  } else {
    c += (wo / 40) ** 2;
  }
  // plausibility penalties
  const over = (x: number, lim: number) => Math.max(0, Math.abs(x) - lim);
  c += 50 * (over(pitch, MAX_PITCH) ** 2 + over(yaw, MAX_YAW) ** 2);
  c += 0.02 * over(len(vp), 12) ** 2;
  // the paddle must actually be moving into the ball (separating -> no contact)
  if (dot(sub(ball.v, vp), n) >= 0) c += 5;
  return c;
}

/** Analytic first guess of Vp for a given face (grip regime of the impulse model). */
function guessVp(n: Vec3, ball: BallState, target: BallState): Vec3 {
  const e = PADDLE_RESTITUTION;
  const vinN = dot(ball.v, n);
  const voutN = Math.max(dot(target.v, n), 0.5);
  const vpN = vinN + (voutN - vinN) / (1 + e);
  // spin perpendicular to n requires contact-point slip u: |Δw| = 1.5 (1+et) |u| / (2.5 R)
  const wPerp = sub(target.w, scale(n, dot(target.w, n)));
  const brush = cross(n, wPerp); // direction such that brush × n ∝ wPerp
  const uMag = (len(wPerp) * 2.5 * BALL_RADIUS) / (1.5 * (1 + PADDLE_TANGENTIAL_RESTITUTION));
  const vinT = sub(ball.v, scale(n, vinN));
  const t = len(brush) > 1e-9 ? scale(normalize(brush), uMag) : v3();
  return add(add(scale(n, vpN), vinT), t);
}

function nelderMead(f: (p: Params) => number, x0: Params, steps: Params, iters: number): { x: Params; fx: number } {
  const dim = x0.length;
  let simplex: Params[] = [x0.slice()];
  for (let i = 0; i < dim; i++) {
    const x = x0.slice();
    x[i] += steps[i];
    simplex.push(x);
  }
  let vals = simplex.map(f);
  for (let it = 0; it < iters; it++) {
    const order = vals.map((_, i) => i).sort((a, b) => vals[a] - vals[b]);
    simplex = order.map((i) => simplex[i]);
    vals = order.map((i) => vals[i]);
    if (vals[dim] - vals[0] < 1e-10) break;
    const centroid = new Array(dim).fill(0);
    for (let i = 0; i < dim; i++) for (let j = 0; j < dim; j++) centroid[j] += simplex[i][j] / dim;
    const worst = simplex[dim];
    const pt = (a: number) => centroid.map((c, j) => c + a * (worst[j] - c));
    const xr = pt(-1);
    const fr = f(xr);
    if (fr < vals[0]) {
      const xe = pt(-2);
      const fe = f(xe);
      if (fe < fr) {
        simplex[dim] = xe;
        vals[dim] = fe;
      } else {
        simplex[dim] = xr;
        vals[dim] = fr;
      }
    } else if (fr < vals[dim - 1]) {
      simplex[dim] = xr;
      vals[dim] = fr;
    } else {
      const xc = fr < vals[dim] ? pt(-0.5) : pt(0.5);
      const fc = f(xc);
      if (fc < Math.min(fr, vals[dim])) {
        simplex[dim] = xc;
        vals[dim] = fc;
      } else {
        for (let i = 1; i <= dim; i++) {
          simplex[i] = simplex[i].map((v, j) => simplex[0][j] + 0.5 * (v - simplex[0][j]));
          vals[i] = f(simplex[i]);
        }
      }
    }
  }
  let best = 0;
  for (let i = 1; i <= dim; i++) if (vals[i] < vals[best]) best = i;
  return { x: simplex[best], fx: vals[best] };
}

export interface ContactFit {
  normal: Vec3;
  velocity: Vec3;
  /** ball state produced by striking `incoming` with (normal, velocity) */
  result: BallState;
  cost: number;
}

/** Find the paddle face normal and velocity that best reproduce `launch` from `incoming`. */
export function fitContact(incoming: BallState, launch: BallState, alsoAtRest = false): ContactFit {
  // Serves: also require the same paddle to work on a ball struck at rest (weight 0.5). This
  // keeps the solution robust (the paddle genuinely moves INTO the ball) rather than relying on
  // the ball falling onto a near-stationary face.
  const rest: BallState = { p: incoming.p, v: v3(), w: v3() };
  const f = alsoAtRest
    ? (p: Params) => fitCost(p, incoming, launch) + 0.5 * fitCost(p, rest, launch)
    : (p: Params) => fitCost(p, incoming, launch);
  const starts: { x: Params; fx: number }[] = [];
  for (let pi = -4; pi <= 5; pi++) {
    for (let yi = -4; yi <= 4; yi++) {
      const pitch = pi * 15 * DEG;
      const yaw = yi * 15 * DEG;
      const n = normalFromAngles(pitch, yaw);
      const vp = guessVp(n, incoming, launch);
      const x = [pitch, yaw, vp.x, vp.y, vp.z];
      starts.push({ x, fx: f(x) });
    }
  }
  starts.sort((a, b) => a.fx - b.fx);
  let best = starts[0];
  const steps = [0.15, 0.15, 0.8, 0.8, 0.8];
  for (const s of starts.slice(0, 5)) {
    let r = nelderMead(f, s.x, steps, 700);
    r = nelderMead(f, r.x, steps.map((v) => v * 0.3), 500); // restart to escape collapse
    if (r.fx < best.fx) best = r;
  }
  const [pitch, yaw, vx, vy, vz] = best.x;
  const normal = normalFromAngles(pitch, yaw);
  const velocity = v3(vx, vy, vz);
  return { normal, velocity, result: strike(incoming, normal, velocity), cost: best.fx };
}

// ─────────────────────────────────────────────────────────────── poses

const smoothstep = (u: number) => {
  const x = Math.min(Math.max(u, 0), 1);
  return x * x * (3 - 2 * x);
};

/** Normalised lerp of two unit vectors (both face +z-ish, so never antiparallel here). */
const nlerp = (a: Vec3, b: Vec3, t: number): Vec3 => {
  const r = add(scale(a, 1 - t), scale(b, t));
  return len(r) < 1e-6 ? b : normalize(r);
};

/**
 * Resting/ready pose of the opponent's paddle (between shots). x = lateral position of the
 * PADDLE (= the x the opponent will strike from). buildOpponentSwing(launch).poseAt(-leadTime)
 * is exactly opponentReadyPose(launch.p.x), so idling here and then starting the swing is seamless.
 */
/** follow-through is held until RECOVER_START s after contact, then eases back to ready */
const RECOVER_START = 0.5;
const RECOVER_TIME = 0.6;

export function opponentReadyPose(x: number): PaddlePose {
  const normal = normalize(v3(0, 0.15, 1));
  return { pos: v3(x, 0.95, -1.7), normal, up: upFor(normal) };
}

/**
 * Build the opponent's paddle motion from the launch state. Face normal and brush direction
 * are derived from launch.w and launch.v so the swing physically explains the spin.
 */
export function buildOpponentSwing(launch: BallState, kind: ShotKind): OpponentSwing {
  const feed = kind === 'serve' ? serveFeed(launch) : rallyFeed(launch);
  const leadTime = kind === 'serve' ? SERVE_LEAD_TIME : RALLY_LEAD_TIME;
  const fit = fitContact(feed.contact, launch, kind === 'serve');
  const n = fit.normal;
  const vp = fit.velocity;

  // brush = paddle motion along the face RELATIVE to the ball's contact point (what makes spin)
  const r = scale(n, -BALL_RADIUS);
  const vcIn = add(feed.contact.v, cross(feed.contact.w, r));
  const rel = sub(vp, vcIn);
  const relT = sub(rel, scale(n, dot(rel, n)));
  const brushDir = len(relT) > 0.05 ? normalize(relT) : upFor(n);

  const contactPos = addScaled(launch.p, n, -BALL_RADIUS);
  const speed = Math.max(len(vp), 0.3);
  const dir = normalize(vp);
  const up = upFor(n);

  // swing timing: accelerate from rest at the backswing extreme to `speed` at contact
  const Lb = Math.min((speed * 0.24) / 2, MAX_BACKSWING);
  const Ts = (2 * Lb) / speed; // so ds/dt(0-) = speed
  const Lf = Math.min((speed * 0.22) / 2, MAX_FOLLOW);
  const Tf = (2 * Lf) / speed; // ds/dt(0+) = speed
  const k = PATH_EXAGGERATION;

  // where the paddle waits before the swing begins
  const ready = opponentReadyPose(launch.p.x);
  const backPos = addScaled(contactPos, dir, -Lb * k);
  // gentle arc so the swing reads as a stroke, not a slide: away from the contact the blade is
  // pulled back behind its face; zero offset and zero slope at contact (s = 0)
  const arc = (s: number, L: number) => scale(n, (-0.2 * k * s * s) / Math.max(L, 1e-6));
  const windStart = -leadTime;
  const windEnd = -Ts - 0.08;

  const poseAt = (tRel: number): PaddlePose => {
    if (tRel > RECOVER_START) {
      // recover smoothly from the held follow-through back to the ready pose, so idling at
      // opponentReadyPose afterwards (next ball) does not snap
      const u = smoothstep((tRel - RECOVER_START) / RECOVER_TIME);
      const held = poseAt(RECOVER_START);
      const normal = nlerp(held.normal, ready.normal, u);
      return { pos: add(scale(held.pos, 1 - u), scale(ready.pos, u)), normal, up: upFor(normal) };
    }
    const t = Math.max(tRel, -leadTime);
    let pos: Vec3;
    let normal = n;
    if (t < windEnd) {
      // drift from ready pose into the backswing extreme, rotating the face into place
      const u = smoothstep((t - windStart) / (windEnd - windStart));
      const backWithArc = add(backPos, arc(-Lb, Lb));
      pos = add(scale(ready.pos, 1 - u), scale(backWithArc, u));
      normal = nlerp(ready.normal, n, u);
    } else if (t < -Ts) {
      pos = add(backPos, arc(-Lb, Lb));
    } else if (t < 0) {
      const u = (t + Ts) / Ts; // 0..1
      const s = -Lb * (1 - u * u); // ds/dt = 2 Lb u / Ts -> speed at contact
      pos = add(addScaled(contactPos, dir, s * k), arc(s, Lb));
    } else if (t < Tf) {
      const u = t / Tf;
      const s = Lf * (1 - (1 - u) * (1 - u));
      pos = add(addScaled(contactPos, dir, s * k), arc(s, Lf));
    } else {
      pos = add(addScaled(contactPos, dir, Lf * k), arc(Lf, Lf));
    }
    return { pos, normal, up: normal === n ? up : upFor(normal) };
  };

  const preContactBallAt = (tRel: number): Vec3 => feed.at(Math.max(tRel, -leadTime));

  return {
    poseAt,
    contactVelocity: clone(vp),
    contactNormal: clone(n),
    brushDir,
    preContactBallAt,
    leadTime,
  };
}
