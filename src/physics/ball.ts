import {
  BALL_INERTIA,
  BALL_MASS,
  BALL_RADIUS,
  FLOOR_Y,
  G,
  K_DRAG,
  LIFT_MAX,
  LIFT_SLOPE,
  AIR_DENSITY,
  BALL_AREA,
  NET_HALF_WIDTH,
  NET_HEIGHT,
  SPIN_DECAY,
  TABLE_FRICTION,
  TABLE_HALF_LENGTH,
  TABLE_HALF_WIDTH,
  TABLE_RESTITUTION,
  TABLE_Y,
  TANGENTIAL_MASS_FACTOR,
} from './constants';
import { Vec3, add, addScaled, clone, cross, dot, len, scale, sub, v3 } from './vec';

export interface BallState {
  /** centre position (m) */
  p: Vec3;
  /** linear velocity (m/s) */
  v: Vec3;
  /** angular velocity (rad/s) */
  w: Vec3;
}

export const cloneBall = (b: BallState): BallState => ({ p: clone(b.p), v: clone(b.v), w: clone(b.w) });

/** Aerodynamic + gravity acceleration. */
export function acceleration(v: Vec3, w: Vec3): Vec3 {
  const speed = len(v);
  let a = v3(0, -G, 0);
  if (speed < 1e-9) return a;
  a = addScaled(a, v, -K_DRAG * speed);
  // Lift direction: (w x v); magnitude 0.5 rho A C_L v^2 / m. Only the spin component
  // perpendicular to v generates lift (a pure corkscrew about the flight axis gives none), so
  // the spin ratio uses w_perp = |w x v| / |v|.
  const dir = cross(w, v);
  const dirLen = len(dir);
  if (dirLen > 1e-12) {
    const spinRatio = (BALL_RADIUS * dirLen) / (speed * speed);
    const cl = Math.min(LIFT_SLOPE * spinRatio, LIFT_MAX);
    const mag = (0.5 * AIR_DENSITY * BALL_AREA * cl * speed * speed) / BALL_MASS;
    a = addScaled(a, dir, mag / dirLen);
  }
  return a;
}

/** Free flight integration (RK2 midpoint) for one step, no collisions. */
export function integrateFlight(b: BallState, dt: number): BallState {
  const a1 = acceleration(b.v, b.w);
  const vMid = addScaled(b.v, a1, dt / 2);
  const a2 = acceleration(vMid, b.w);
  const decay = Math.exp(-SPIN_DECAY * dt);
  return {
    p: addScaled(b.p, vMid, dt),
    v: addScaled(b.v, a2, dt),
    w: scale(b.w, decay),
  };
}

/**
 * Rigid-body impulsive contact of the ball against a flat surface (Garwin / Cross model).
 *
 * @param n         unit normal of the surface pointing TOWARD the ball
 * @param surfVel   velocity of the surface (paddle swing), zero for the table
 * @param e         normal coefficient of restitution (0..1)
 * @param mu        Coulomb friction coefficient
 * @param et        tangential coefficient of restitution (0 = ends rolling; >0 = elastic
 *                  "grip and release" of rubber that can reverse the contact-point slip)
 *
 * Normal: relative normal velocity is reversed and scaled by e (impulse Jn = -(1+e) m vn).
 * Tangential: the contact-point slip velocity u changes by TANGENTIAL_MASS_FACTOR * Jt / m
 * (=2.5 Jt/m for a thin shell, from linear + angular impulse). The impulse needed to reach
 * the target slip -et*u is m(1+et)|u|/2.5; if that exceeds mu*Jn the ball slides throughout
 * and Coulomb friction mu*Jn is applied instead.
 * Both branches dissipate (or at most conserve, when e = et = 1) kinetic energy in the
 * surface's frame, so no collision can create energy.
 * Returns a NEW state; the input is untouched. If the ball is separating, returns a copy.
 */
export function surfaceContact(
  b: BallState,
  n: Vec3,
  surfVel: Vec3,
  e: number,
  mu: number,
  et = 0,
): BallState {
  const vRel = sub(b.v, surfVel);
  const vn = dot(vRel, n);
  if (vn >= 0) return cloneBall(b);
  const r = scale(n, -BALL_RADIUS); // centre -> contact point
  const vc = add(vRel, cross(b.w, r));
  const vct = sub(vc, scale(n, dot(vc, n)));
  const slip = len(vct);
  const jn = -(1 + e) * vn * BALL_MASS; // > 0
  let jt = v3();
  if (slip > 1e-9) {
    const jtMag = Math.min((BALL_MASS * (1 + et) * slip) / TANGENTIAL_MASS_FACTOR, mu * jn);
    jt = scale(vct, -jtMag / slip);
  }
  const impulse = add(scale(n, jn), jt);
  return {
    p: clone(b.p),
    v: addScaled(b.v, impulse, 1 / BALL_MASS),
    w: addScaled(b.w, cross(r, jt), 1 / BALL_INERTIA),
  };
}

/** Kinetic energy (translational + rotational) in a frame moving with `frameVel`. */
export function kineticEnergy(b: BallState, frameVel: Vec3 = v3()): number {
  const v = sub(b.v, frameVel);
  return 0.5 * BALL_MASS * dot(v, v) + 0.5 * BALL_INERTIA * dot(b.w, b.w);
}

export type WorldEventKind = 'table' | 'net' | 'floor';

export interface WorldEvent {
  kind: WorldEventKind;
  /** simulation time of the event (s) */
  t: number;
  /** ball centre at the event */
  p: Vec3;
  /** for 'table': which half was hit */
  side?: 'player' | 'opponent';
}

export const onTable = (x: number, z: number): boolean =>
  Math.abs(x) <= TABLE_HALF_WIDTH && Math.abs(z) <= TABLE_HALF_LENGTH;

/**
 * One fixed step of the world: flight + table bounce + net + floor.
 * The ball keeps flying after a net hit (it is simply flagged and damped) so callers decide
 * what a net hit means. `t` is the time at the START of the step.
 */
export function stepWorld(b: BallState, dt: number, t: number, events?: WorldEvent[]): BallState {
  let nb = integrateFlight(b, dt);

  // Net: thin vertical plane at z = 0. The ball (radius R) touches it when its leading surface
  // reaches the plane, i.e. its centre crosses z = +R (travelling -z) or z = -R (travelling +z),
  // while its bottom is below the tape (centre lower than net top + R) and above the table.
  const dir = nb.p.z - b.p.z;
  if (dir !== 0) {
    const planeZ = dir < 0 ? BALL_RADIUS : -BALL_RADIUS;
    if ((b.p.z - planeZ) * (nb.p.z - planeZ) <= 0 && b.p.z !== planeZ) {
      const f = (b.p.z - planeZ) / (b.p.z - nb.p.z);
      const cx = b.p.x + (nb.p.x - b.p.x) * f;
      const cy = b.p.y + (nb.p.y - b.p.y) * f;
      if (Math.abs(cx) <= NET_HALF_WIDTH && cy - BALL_RADIUS < TABLE_Y + NET_HEIGHT && cy > TABLE_Y) {
        // Net is soft: kill most of the forward speed and drop the ball on the hitter's side.
        const back = dir < 0 ? 1 : -1;
        nb = {
          p: v3(cx, cy, back * (BALL_RADIUS + 0.002)),
          v: v3(nb.v.x * 0.2, Math.min(nb.v.y, 0) * 0.3, -nb.v.z * 0.1),
          w: scale(nb.w, 0.3),
        };
        events?.push({ kind: 'net', t: t + dt * f, p: v3(cx, cy, 0) });
        return nb;
      }
    }
  }

  // Table top
  const prevBottom = b.p.y - BALL_RADIUS;
  const newBottom = nb.p.y - BALL_RADIUS;
  if (prevBottom >= TABLE_Y && newBottom < TABLE_Y && nb.v.y < 0) {
    // interpolate crossing point
    const f = (prevBottom - TABLE_Y) / (prevBottom - newBottom);
    const cx = b.p.x + (nb.p.x - b.p.x) * f;
    const cz = b.p.z + (nb.p.z - b.p.z) * f;
    if (onTable(cx, cz)) {
      // Integrate exactly to the moment of impact, resolve the impulse, then fly the rest of
      // the step so no time is lost (keeps results independent of where the step boundary falls).
      const fh = Math.min(Math.max(f, 0), 1);
      const atImpact = integrateFlight(b, dt * fh);
      atImpact.p = v3(cx, TABLE_Y + BALL_RADIUS, cz);
      const bounced = surfaceContact(atImpact, v3(0, 1, 0), v3(), TABLE_RESTITUTION, TABLE_FRICTION);
      events?.push({ kind: 'table', t: t + dt * fh, p: clone(bounced.p), side: cz >= 0 ? 'player' : 'opponent' });
      nb = integrateFlight(bounced, dt * (1 - fh));
      if (nb.p.y < TABLE_Y + BALL_RADIUS) nb.p = v3(nb.p.x, TABLE_Y + BALL_RADIUS, nb.p.z);
    }
  }

  // Floor
  if (nb.p.y - BALL_RADIUS < FLOOR_Y && nb.v.y < 0) {
    nb = surfaceContact(nb, v3(0, 1, 0), v3(), 0.75, 0.3);
    nb.p = v3(nb.p.x, FLOOR_Y + BALL_RADIUS, nb.p.z);
    events?.push({ kind: 'floor', t: t + dt, p: clone(nb.p) });
  }
  return nb;
}
