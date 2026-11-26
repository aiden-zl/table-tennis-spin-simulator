/**
 * Opponent shot solver: finds the launch velocity that makes a ball with a given spin follow a
 * ShotSpec (bounce at the requested target, serves bouncing on the server's half first).
 *
 * Method: shooting method on the real integrator. Residuals come from a "ghost" simulation that
 * uses exactly the same fixed-step flight integrator and table impulse model as stepWorld, but
 * with an infinite table plane and no net, so the residual is a smooth function of the launch
 * parameters everywhere. A damped Newton iteration with a finite-difference Jacobian solves
 *   rally: unknowns (elevation, azimuth) at a pace-derived speed -> first bounce (x, z)
 *   serve: unknowns (speed, elevation, azimuth) -> first bounce z (server half) + second bounce (x, z)
 * The result is then validated with the authoritative predictIncoming() (net, table edges,
 * contact height). If the nominal speed / first-bounce depth fails, nearby values are tried.
 */
import { BallState, integrateFlight, surfaceContact } from './ball';
import { BALL_RADIUS, NET_HEIGHT, SIM_DT, TABLE_FRICTION, TABLE_HALF_LENGTH, TABLE_RESTITUTION, TABLE_Y } from './constants';
import { SpinSpec, spinVector } from './spin';
import { IncomingPrediction, predictIncoming } from './trajectory';
import { Vec3, v3 } from './vec';
import type { Pace, ShotSpec } from '../contracts';

/** Minimum net clearance (ball bottom above net top) for an accepted shot (m). */
export const MIN_NET_CLEARANCE = 0.01;
/** Accepted distance between the requested target and the predicted bounce (m). */
export const TARGET_TOLERANCE = 0.02;

/** Build the spin vector (rad/s) for a spin spec given the flight velocity. */
export function spinFromComponents(spin: SpinSpec, velocity: Vec3): Vec3 {
  return spinVector(spin, velocity);
}

/** Opponent contact point for a spec (where the ball leaves the opponent's paddle). */
export function launchPoint(spec: ShotSpec): { x: number; y: number; z: number } {
  if (spec.kind === 'serve') {
    // contact behind the end line, a little above table height (legal serve contact)
    // (≈20 cm: a lower contact cannot produce a first bounce high enough to clear the net
    // except with an implausibly fast downward hit)
    const dy = spec.pace === 'fast' ? 0.23 : spec.pace === 'slow' ? 0.18 : 0.2;
    return { x: spec.fromX, y: TABLE_Y + dy, z: -(TABLE_HALF_LENGTH + 0.08) };
  }
  const dy = spec.pace === 'fast' ? 0.25 : spec.pace === 'slow' ? 0.2 : 0.22;
  const z = spec.pace === 'fast' ? -1.7 : spec.pace === 'slow' ? -1.55 : -1.6;
  return { x: spec.fromX, y: TABLE_Y + dy, z };
}

/** Nominal launch speed for a rally ball (m/s). Backspin balls are naturally slower. */
export function rallySpeed(pace: Pace, spin: SpinSpec): number {
  const base = pace === 'fast' ? 14.5 : pace === 'medium' ? 10.5 : 7.5;
  const back = Math.max(0, -spin.topspin);
  const top = Math.max(0, spin.topspin);
  // heavy chops/pushes come off slower; heavy loops are brushed, so a bit slower than a flat drive
  const f = Math.max(0.6, 1 - 0.006 * back - 0.002 * top);
  return base * f;
}

/**
 * Preferred net clearance (ball bottom over the net top, m) for a serve. Good serves are low:
 * short serves skim the net, long serves are a touch higher; slow serves float a bit more.
 */
export function serveNetClearance(pace: Pace, targetZ: number): number {
  const depth = Math.min(1, Math.max(0, (targetZ - 0.25) / 1.0)); // 0 short .. 1 long
  const base = pace === 'fast' ? 0.035 : pace === 'medium' ? 0.045 : 0.06;
  return base + 0.04 * depth;
}

// ───────────────────────────── ghost simulation

interface GhostResult {
  bounces: { x: number; z: number }[];
  /** ball-bottom height above the net top when crossing z = 0 (undefined if never crossed) */
  netClearance?: number;
}

/** Same integrator + table impulse as stepWorld, but infinite table plane and no net. */
function ghost(launch: BallState, nBounces: number, maxTime = 2.5): GhostResult {
  let b = launch;
  const bounces: { x: number; z: number }[] = [];
  let netClearance: number | undefined;
  const steps = Math.ceil(maxTime / SIM_DT);
  for (let i = 0; i < steps; i++) {
    let nb = integrateFlight(b, SIM_DT);
    const prevBottom = b.p.y - BALL_RADIUS;
    const newBottom = nb.p.y - BALL_RADIUS;
    if (b.p.z < 0 && nb.p.z >= 0 && netClearance === undefined) {
      const f = -b.p.z / Math.max(nb.p.z - b.p.z, 1e-12);
      const y = b.p.y + (nb.p.y - b.p.y) * f;
      netClearance = y - BALL_RADIUS - (TABLE_Y + NET_HEIGHT);
    }
    if (prevBottom >= TABLE_Y && newBottom < TABLE_Y && nb.v.y < 0) {
      const f = (prevBottom - TABLE_Y) / (prevBottom - newBottom);
      const cx = b.p.x + (nb.p.x - b.p.x) * f;
      const cz = b.p.z + (nb.p.z - b.p.z) * f;
      nb = surfaceContact(nb, v3(0, 1, 0), v3(), TABLE_RESTITUTION, TABLE_FRICTION);
      nb.p = v3(cx, TABLE_Y + BALL_RADIUS, cz);
      bounces.push({ x: cx, z: cz });
      if (bounces.length >= nBounces) break;
    }
    b = nb;
    if (b.p.y < TABLE_Y - 0.5) break;
  }
  return { bounces, netClearance };
}

// ───────────────────────────── small linear algebra

function solveLinear(A: number[][], bv: number[]): number[] | null {
  const n = bv.length;
  const M = A.map((r, i) => [...r, bv[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-12) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r, i) => r[n] / r[i]);
}

const norm = (r: number[]) => Math.sqrt(r.reduce((s, x) => s + x * x, 0));

/**
 * Damped Newton with forward-difference Jacobian and backtracking. `residual` returns null when
 * undefined (e.g. not enough bounces). Returns the solution if |F| < tol.
 */
function newton(
  residual: (u: number[]) => number[] | null,
  u0: number[],
  h: number[],
  maxStep: number[],
  lo: number[],
  hi: number[],
  tol = 0.002,
  maxIter = 14,
): number[] | null {
  let u = [...u0];
  let F = residual(u);
  if (!F) return null;
  for (let it = 0; it < maxIter; it++) {
    const fn = norm(F);
    if (fn < tol) return u;
    const n = u.length;
    const J: number[][] = F.map(() => new Array(n).fill(0));
    for (let j = 0; j < n; j++) {
      const up = [...u];
      up[j] += h[j];
      const Fp = residual(up);
      if (!Fp) return null;
      for (let i = 0; i < F.length; i++) J[i][j] = (Fp[i] - F[i]) / h[j];
    }
    const d = solveLinear(J, F.map((x) => -x));
    if (!d) return null;
    // clamp step size
    let s = 1;
    for (let j = 0; j < n; j++) if (Math.abs(d[j]) * s > maxStep[j]) s = maxStep[j] / Math.abs(d[j]);
    let accepted = false;
    for (let k = 0; k < 6; k++) {
      const cand = u.map((x, j) => Math.min(hi[j], Math.max(lo[j], x + d[j] * s)));
      const Fc = residual(cand);
      if (Fc && norm(Fc) < fn * (1 - 0.1 * s)) {
        u = cand;
        F = Fc;
        accepted = true;
        break;
      }
      s *= 0.5;
    }
    if (!accepted) return null;
  }
  return norm(F) < tol ? u : null;
}

// ───────────────────────────── launch construction

function makeLaunch(p: Vec3, spin: SpinSpec, speed: number, elev: number, az: number): BallState {
  const ch = Math.cos(elev);
  const v = v3(speed * ch * Math.sin(az), speed * Math.sin(elev), speed * ch * Math.cos(az));
  return { p: { ...p }, v, w: spinVector(spin, v) };
}

/** Elevation guess from a drag-free ballistic arc (low branch), with a fallback. */
function ballisticElevation(speed: number, range: number, drop: number): number {
  // y(x) = x tan(a) - g x^2 / (2 v^2 cos^2 a) ; want y(range) = -drop
  const g = 9.81 * 1.3; // fudge for drag
  const k = (g * range * range) / (2 * speed * speed);
  // k T^2 - range T + (k - drop) = 0 with T = tan(a)
  const disc = range * range - 4 * k * (k - drop);
  if (disc < 0) return 0.6;
  return Math.atan((range - Math.sqrt(disc)) / (2 * k));
}

function validate(
  launch: BallState,
  spec: ShotSpec,
): { launch: BallState; incoming: IncomingPrediction } | null {
  const inc = predictIncoming(launch, spec.kind);
  if (!inc.valid || !inc.playerBounce) return null;
  if (inc.netClearance === undefined || inc.netClearance < MIN_NET_CLEARANCE) return null;
  const dx = inc.playerBounce.x - spec.target.x;
  const dz = inc.playerBounce.z - spec.target.z;
  if (Math.hypot(dx, dz) > TARGET_TOLERANCE) return null;
  if (spec.kind === 'serve') {
    const sb = inc.serverBounce;
    if (!sb || sb.z >= 0) return null;
  }
  return { launch, incoming: inc };
}

function solveRally(spec: ShotSpec): { launch: BallState; incoming: IncomingPrediction } | null {
  const p = launchPoint(spec);
  const tx = spec.target.x;
  const tz = spec.target.z;
  const az0 = Math.atan2(tx - p.x, tz - p.z);
  const range = Math.hypot(tx - p.x, tz - p.z);
  const nominal = rallySpeed(spec.pace, spec.spin);
  const factors = [1, 0.9, 1.12, 0.8, 1.25, 0.7, 1.4, 0.6, 0.5, 0.42, 0.35];
  for (const f of factors) {
    const speed = nominal * f;
    if (speed < 2.5) continue;
    const residual = (u: number[]): number[] | null => {
      const g = ghost(makeLaunch(p, spec.spin, speed, u[0], u[1]), 1);
      if (g.bounces.length < 1) return null;
      return [g.bounces[0].x - tx, g.bounces[0].z - tz];
    };
    const e0 = ballisticElevation(speed, range, p.y - TABLE_Y - BALL_RADIUS);
    // topspin dips (aim higher), backspin floats (aim lower)
    const e1 = e0 + spec.spin.topspin * 0.002;
    for (const eg of [e1, e0 + 0.15]) {
      const u = newton(residual, [eg, az0], [1e-3, 1e-3], [0.15, 0.15], [-0.6, -1.2], [1.2, 1.2]);
      if (!u) continue;
      const ok = validate(makeLaunch(p, spec.spin, speed, u[0], u[1]), spec);
      if (ok) return ok;
    }
  }
  return null;
}

function solveServe(spec: ShotSpec): { launch: BallState; incoming: IncomingPrediction } | null {
  const p = launchPoint(spec);
  const tx = spec.target.x;
  const tz = spec.target.z;
  const az0 = Math.atan2(tx - p.x, tz - p.z);
  const clear = serveNetClearance(spec.pace, tz);
  const h = [0.005, 1e-3, 1e-3];
  const maxStep = [1.0, 0.12, 0.12];
  const lo = [1.5, -1.2, -1.2];
  const hi = [12, 0.9, 1.2];
  const sim = (u: number[]) => ghost(makeLaunch(p, spec.spin, u[0], u[1], u[2]), 2);
  // stage 2: net clearance + second bounce (x, z)
  const resClear = (u: number[]): number[] | null => {
    const g = sim(u);
    if (g.bounces.length < 2 || g.netClearance === undefined || g.bounces[0].z >= 0) return null;
    return [g.netClearance - clear, g.bounces[1].x - tx, g.bounces[1].z - tz];
  };
  const tryLaunch = (u: number[]) => validate(makeLaunch(p, spec.spin, u[0], u[1], u[2]), spec);

  let fallback: { launch: BallState; incoming: IncomingPrediction } | null = null;
  // stage 1 (continuation start): fix the first bounce depth, which is easy to converge from a
  // crude guess; then release it in favour of the desired net clearance.
  for (const zb of [-1.05, -0.9, -1.18, -0.75]) {
    const resBounce = (u: number[]): number[] | null => {
      const g = sim(u);
      if (g.bounces.length < 2) return null;
      return [g.bounces[0].z - zb, g.bounces[1].x - tx, g.bounces[1].z - tz];
    };
    const dist = tz - p.z;
    const sGuess = Math.min(8, Math.max(3.5, 2.2 + dist * 1.4));
    const eGuess = Math.atan2(-(p.y - TABLE_Y), zb - p.z) - 0.05;
    for (const [sg, eg] of [
      [sGuess, eGuess],
      [sGuess * 0.8, eGuess + 0.15],
    ]) {
      const u1 = newton(resBounce, [sg, eg, az0], h, maxStep, lo, hi);
      if (!u1) continue;
      const u2 = newton(resClear, u1, h, maxStep, lo, hi);
      if (u2) {
        const ok = tryLaunch(u2);
        if (ok) return ok;
      }
      if (!fallback) fallback = tryLaunch(u1);
      break; // this zb converged; another start won't change stage 2
    }
  }
  return fallback;
}

/**
 * Solve the launch velocity (with the spec's spin) so the ball follows the spec: lands at
 * spec.target on the player's half (serve: after first bouncing on the opponent's half),
 * clears the net, and arrives hittable. Returns null if no legal solution.
 */
export function solveLaunch(spec: ShotSpec): { launch: BallState; incoming: IncomingPrediction } | null {
  return spec.kind === 'serve' ? solveServe(spec) : solveRally(spec);
}
