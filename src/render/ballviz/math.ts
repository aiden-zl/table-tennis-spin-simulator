/**
 * Pure (three.js-free) maths for the ball visualisation, unit-tested in node.
 *
 * Frames: everything here is in WORLD axes (see src/physics/constants.ts), unless a function
 * says "axis-local frame", in which the spin axis is +Y.
 */
import { AIR_DENSITY, BALL_AREA, BALL_MASS, BALL_RADIUS, LIFT_MAX, LIFT_SLOPE } from '../../physics/constants';
import { spinComponents } from '../../physics/spin';
import type { Vec3 } from '../../physics/vec';

export interface QuatLike {
  x: number;
  y: number;
  z: number;
  w: number;
}

export interface MutVec3 {
  x: number;
  y: number;
  z: number;
}

export const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/**
 * Integrate an orientation quaternion by a WORLD-frame angular velocity w (rad/s) over dt:
 *   q' = exp(0.5 * w * dt) ⊗ q        (left-multiplication = rotation about a world axis)
 * The rotation is exact for constant w over the step (axis-angle), so large dt is fine.
 * Mutates and returns q (works with THREE.Quaternion through its x/y/z/w setters, but callers
 * should prefer `integrateOrientationInto` on plain objects + q.set for fewer callbacks).
 */
export function integrateOrientation<Q extends QuatLike>(q: Q, w: Vec3, dt: number): Q {
  const wx = w.x, wy = w.y, wz = w.z;
  const mag = Math.hypot(wx, wy, wz);
  const angle = mag * dt;
  if (!(Math.abs(angle) > 1e-12) || !Number.isFinite(angle)) return q;
  const half = 0.5 * angle;
  const s = Math.sin(half) / mag;
  // d = (dx, dy, dz, dw) is the delta rotation
  const dx = wx * s, dy = wy * s, dz = wz * s, dw = Math.cos(half);
  const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
  // Hamilton product d ⊗ q
  let nx = dw * qx + dx * qw + dy * qz - dz * qy;
  let ny = dw * qy - dx * qz + dy * qw + dz * qx;
  let nz = dw * qz + dx * qy - dy * qx + dz * qw;
  let nw = dw * qw - dx * qx - dy * qy - dz * qz;
  const n = Math.hypot(nx, ny, nz, nw) || 1;
  nx /= n; ny /= n; nz /= n; nw /= n;
  q.x = nx; q.y = ny; q.z = nz; q.w = nw;
  return q;
}

/** Rotate vector v by unit quaternion q (v' = q v q*). */
export function rotateByQuat(q: QuatLike, v: Vec3): Vec3 {
  const { x: qx, y: qy, z: qz, w: qw } = q;
  // t = 2 * cross(q.xyz, v)
  const tx = 2 * (qy * v.z - qz * v.y);
  const ty = 2 * (qz * v.x - qx * v.z);
  const tz = 2 * (qx * v.y - qy * v.x);
  return {
    x: v.x + qw * tx + (qy * tz - qz * ty),
    y: v.y + qw * ty + (qz * tx - qx * tz),
    z: v.z + qw * tz + (qx * ty - qy * tx),
  };
}

/** Velocity of a surface point at offset r from the centre: w × r. */
export const surfaceVelocity = (w: Vec3, r: Vec3): Vec3 => ({
  x: w.y * r.z - w.z * r.y,
  y: w.z * r.x - w.x * r.z,
  z: w.x * r.y - w.y * r.x,
});

/**
 * Rotation-ring curve in the axis-local frame (spin axis = +Y), unit radius.
 * Angle increases in the right-handed sense about +Y, so the tangent at the END of the arc
 * (where the arrowhead sits) is +Y × point = the direction the ball's surface moves.
 */
export const ringPoint = (angle: number): Vec3 => ({ x: Math.cos(angle), y: 0, z: -Math.sin(angle) });
export const ringTangent = (angle: number): Vec3 => ({ x: -Math.sin(angle), y: 0, z: -Math.cos(angle) });

/** Fade factor for spin visuals: 0 below ~1.5 rps, 1 above ~4 rps. */
export const spinFade = (rps: number): number => smoothstep(1.5, 4, rps);

/** Magnus (lift) acceleration magnitude (m/s^2) matching physics/ball.ts acceleration(). */
export function liftAccel(w: Vec3, v: Vec3): number {
  const speed = Math.hypot(v.x, v.y, v.z);
  const wMag = Math.hypot(w.x, w.y, w.z);
  if (speed < 1e-9 || wMag < 1e-9) return 0;
  // only the spin perpendicular to the velocity makes lift: |w_perp| = |w x v| / |v|
  const c = surfaceVelocity(w, v);
  const wPerp = Math.hypot(c.x, c.y, c.z) / speed;
  if (wPerp < 1e-9) return 0;
  const cl = Math.min((LIFT_SLOPE * BALL_RADIUS * wPerp) / speed, LIFT_MAX);
  return (0.5 * AIR_DENSITY * BALL_AREA * cl * speed * speed) / BALL_MASS;
}

// ───────────────────────────── Colour legend

/**
 * Colour legend for every spin visual (wind streaks, axis arrow, ring, trail).
 * Side-spin colours are named by the way the ball curves AS SEEN BY THE PLAYER
 * (world +x = the player's right), whichever way the ball travels.
 */
export const SPIN_COLORS = {
  topspin: '#ff3b30',
  backspin: '#2f8bff',
  /** sidespin that curves the ball toward the player's RIGHT (+x) */
  sideRight: '#2fd66b',
  /** sidespin that curves the ball toward the player's LEFT (-x) */
  sideLeft: '#b35cff',
  /** corkscrew / gyro spin (axis along the flight) */
  corkscrew: '#ff9f1c',
  /** no / negligible spin */
  none: '#e8edf2',
  /** Magnus force (lift) arrow */
  magnus: '#fff35c',
} as const;

export type SpinColorKey = keyof typeof SPIN_COLORS;

/** Ready-made legend rows for the UI. */
export const SPIN_COLOR_LEGEND: ReadonlyArray<{ key: SpinColorKey; color: string; label: string }> = [
  { key: 'topspin', color: SPIN_COLORS.topspin, label: 'Topspin' },
  { key: 'backspin', color: SPIN_COLORS.backspin, label: 'Backspin' },
  { key: 'sideRight', color: SPIN_COLORS.sideRight, label: 'Sidespin – curves to your right' },
  { key: 'sideLeft', color: SPIN_COLORS.sideLeft, label: 'Sidespin – curves to your left' },
  { key: 'corkscrew', color: SPIN_COLORS.corkscrew, label: 'Corkscrew (axis along flight)' },
  { key: 'none', color: SPIN_COLORS.none, label: 'No spin' },
  { key: 'magnus', color: SPIN_COLORS.magnus, label: 'Magnus force (curve direction)' },
];

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export function hexToRgb(hex: string): RGB {
  const n = parseInt(hex.replace('#', ''), 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

const RGB_CACHE: Record<SpinColorKey, RGB> = Object.fromEntries(
  Object.entries(SPIN_COLORS).map(([k, v]) => [k, hexToRgb(v)]),
) as Record<SpinColorKey, RGB>;

export interface SpinClass {
  /** + topspin / - backspin (rps, relative to travel) */
  topspin: number;
  /** + curves toward the player's right (+x), - left (rps) */
  sidePlayer: number;
  corkscrew: number;
  /** dominant category */
  dominant: SpinColorKey;
}

/** Classify w relative to the flight direction (player-perspective side spin). */
export function classifySpin(w: Vec3, v: Vec3): SpinClass {
  const c = spinComponents(w, v);
  const horiz = Math.hypot(v.x, v.z);
  // sidespin > 0 curves to the right of travel = (d × up); its x component is -d.z.
  const dz = horiz > 1e-9 ? v.z / horiz : 1;
  const sidePlayer = c.sidespin * (dz >= 0 ? -1 : 1);
  const at = Math.abs(c.topspin), as = Math.abs(sidePlayer), ac = Math.abs(c.corkscrew) * 0.6;
  let dominant: SpinColorKey = 'none';
  if (Math.max(at, as, ac) >= 3) {
    if (at >= as && at >= ac) dominant = c.topspin > 0 ? 'topspin' : 'backspin';
    else if (as >= ac) dominant = sidePlayer > 0 ? 'sideRight' : 'sideLeft';
    else dominant = 'corkscrew';
  }
  return { topspin: c.topspin, sidePlayer, corkscrew: c.corkscrew, dominant };
}

/**
 * Blended spin colour: legend colours weighted by the square of each component, faded to
 * 'none' for low spin. Writes into `out` (no allocation) and returns it.
 */
export function spinColor(w: Vec3, v: Vec3, out: RGB = { r: 0, g: 0, b: 0 }): RGB {
  const c = classifySpin(w, v);
  const wt = c.topspin * c.topspin;
  const ws = c.sidePlayer * c.sidePlayer;
  const wc = 0.36 * c.corkscrew * c.corkscrew;
  const sum = wt + ws + wc;
  const none = RGB_CACHE.none;
  if (sum < 1e-9) {
    out.r = none.r; out.g = none.g; out.b = none.b;
    return out;
  }
  const t = c.topspin >= 0 ? RGB_CACHE.topspin : RGB_CACHE.backspin;
  const s = c.sidePlayer >= 0 ? RGB_CACHE.sideRight : RGB_CACHE.sideLeft;
  const k = RGB_CACHE.corkscrew;
  let r = (t.r * wt + s.r * ws + k.r * wc) / sum;
  let g = (t.g * wt + s.g * ws + k.g * wc) / sum;
  let b = (t.b * wt + s.b * ws + k.b * wc) / sum;
  const f = spinFade(Math.sqrt(sum));
  r = none.r + (r - none.r) * f;
  g = none.g + (g - none.g) * f;
  b = none.b + (b - none.b) * f;
  out.r = r; out.g = g; out.b = b;
  return out;
}

// ───────────────────────────── Airflow ("wind") field

export interface FlowParams {
  /** unit direction of the AIR relative to the ball (= -v̂) */
  ux: number; uy: number; uz: number;
  /** unit spin axis (zero vector if no spin) */
  ax: number; ay: number; az: number;
  /** unit Magnus (lift) direction ŵ×v̂ normalised (zero if none) */
  mx: number; my: number; mz: number;
  /** visual sphere radius used by the flow (slightly larger than the ball) */
  a: number;
  /** surface swirl speed relative to the free stream (0..~1.2) */
  swirl: number;
  /** wake deflection strength relative to the free stream (0..~0.8) */
  deflect: number;
}

/**
 * Air velocity in the ball's frame at offset (x,y,z) from the ball centre, for a unit free
 * stream. Potential flow around a sphere + a spin-induced swirl (air dragged along with the
 * surface, w × r, decaying as 1/r^3) + a wake pushed OPPOSITE to the Magnus force
 * (Newton's third law: the ball is lifted one way, the air is thrown the other way).
 * Writes into out.
 */
export function airflow(out: MutVec3, x: number, y: number, z: number, p: FlowParams): MutVec3 {
  const a = p.a;
  const r2 = Math.max(x * x + y * y + z * z, a * a * 1e-4);
  const r = Math.sqrt(r2);
  const a3 = a * a * a;
  const r3 = r2 * r;
  const ur = p.ux * x + p.uy * y + p.uz * z; // U·r
  // potential flow: U(1 + a³/(2r³)) - (3a³/(2r⁵)) (U·r) r
  const k1 = 1 + a3 / (2 * r3);
  const k2 = (3 * a3 * ur) / (2 * r3 * r2);
  let vx = p.ux * k1 - k2 * x;
  let vy = p.uy * k1 - k2 * y;
  let vz = p.uz * k1 - k2 * z;
  // swirl: (â × r)/r * swirl * (a/r)^2  (equals surface direction at r = a)
  if (p.swirl > 0) {
    const sx = p.ay * z - p.az * y;
    const sy = p.az * x - p.ax * z;
    const sz = p.ax * y - p.ay * x;
    const f = (p.swirl * a * a) / (r2 * r);
    vx += sx * f; vy += sy * f; vz += sz * f;
  }
  // wake deflection downstream (ur > 0), opposite to the Magnus direction
  if (p.deflect > 0 && ur > 0) {
    const px = x - p.ux * ur, py = y - p.uy * ur, pz = z - p.uz * ur;
    const rho2 = px * px + py * py + pz * pz;
    const g = smoothstep(0, 2.5 * a, ur) * Math.exp(-rho2 / (4 * a * a));
    const f = -p.deflect * g;
    vx += p.mx * f; vy += p.my * f; vz += p.mz * f;
  }
  out.x = vx; out.y = vy; out.z = vz;
  return out;
}

/** Build FlowParams from the physical w, v (writes into out). */
export function flowParams(w: Vec3, v: Vec3, a: number, out: FlowParams): FlowParams {
  const speed = Math.hypot(v.x, v.y, v.z);
  const wMag = Math.hypot(w.x, w.y, w.z);
  out.a = a;
  if (speed > 1e-6) {
    out.ux = -v.x / speed; out.uy = -v.y / speed; out.uz = -v.z / speed;
  } else {
    out.ux = 0; out.uy = 0; out.uz = -1;
  }
  if (wMag > 1e-6) {
    out.ax = w.x / wMag; out.ay = w.y / wMag; out.az = w.z / wMag;
  } else {
    out.ax = 0; out.ay = 0; out.az = 0;
  }
  const rps = wMag / (2 * Math.PI);
  const strength = spinFade(rps) * Math.min(1, Math.sqrt(rps / 40));
  out.swirl = 1.1 * strength;
  const m = surfaceVelocity(w, v);
  const mLen = Math.hypot(m.x, m.y, m.z);
  if (mLen > 1e-9) {
    out.mx = m.x / mLen; out.my = m.y / mLen; out.mz = m.z / mLen;
    // perpendicular fraction: how much of the spin actually produces lift
    const perp = mLen / Math.max(wMag * speed, 1e-12);
    out.deflect = 0.75 * strength * perp;
  } else {
    out.mx = 0; out.my = 0; out.mz = 0;
    out.deflect = 0;
  }
  return out;
}

export const newFlowParams = (): FlowParams => ({
  ux: 0, uy: 0, uz: -1, ax: 0, ay: 0, az: 0, mx: 0, my: 0, mz: 0, a: 0.03, swirl: 0, deflect: 0,
});

/** Half-length (in ball radii) of the axis arrow for a spin rate: 1.4R..4.6R, capped at 45 rps. */
export const axisHalfLength = (rps: number, min = 1.4, max = 4.6, capRps = 45): number =>
  min + (max - min) * Math.min(Math.max(rps, 0) / capRps, 1);
