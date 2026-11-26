import { RAD_TO_RPS, RPS_TO_RAD } from './constants';
import { Vec3, add, cross, dot, len, normalize, scale, v3 } from './vec';

/**
 * Human-friendly spin description, relative to the ball's direction of travel.
 * All values in revolutions per second (rps). Typical: 0..50 rps (heavy loop/chop ~ 40-60).
 */
export interface SpinSpec {
  /** + topspin, - backspin */
  topspin: number;
  /** + curves to the RIGHT of the direction of travel (as seen by someone behind the ball), - left */
  sidespin: number;
  /** + axis points along the direction of travel (right-hand rule), - against */
  corkscrew: number;
}

/**
 * Build the angular-velocity vector (rad/s) from a SpinSpec and the velocity of the ball.
 * Uses the horizontal flight direction d (ignores vertical component):
 *   right = d x up        (to the right of travel)
 *   topspin axis = right  => w = top * right gives forward rotation (top of ball moves along d)
 *   sidespin axis: Magnus a ~ w x v. Curving right needs w x d = right  => w = -up ... see below.
 */
export function spinVector(spec: SpinSpec, velocity: Vec3): Vec3 {
  const d = normalize(v3(velocity.x, 0, velocity.z));
  const up = v3(0, 1, 0);
  const right = cross(d, up); // e.g. d=(0,0,1) (toward player) -> right = (-1,0,0)?? check below
  // For d = +z: cross((0,0,1),(0,1,0)) = (-1,0,0). Someone walking in +z (toward the player)
  // has their right hand at -x. Correct (it's the player's left).
  //
  // Topspin: the top of the ball moves along d. Top point r = up*R: w x up = d  =>  w = up x d... solve:
  //   w = k * right: right x up = (d x up) x up = -d  (since d ⟂ up)  => top moves -d  (wrong)
  //   so topspin w = -right * top.
  const topAxis = scale(right, -1);
  // Sidespin: Magnus a ∝ w x v. With w = s * up, w x d = s * (up x d) = s * (-(d x up)) = -s * right.
  // So curving to the right needs w = -up * side.
  const sideAxis = v3(0, -1, 0);
  const w = add(add(scale(topAxis, spec.topspin), scale(sideAxis, spec.sidespin)), scale(d, spec.corkscrew));
  return scale(w, RPS_TO_RAD);
}

/** Inverse of spinVector: decompose w relative to the ball's horizontal flight direction. */
export function spinComponents(w: Vec3, velocity: Vec3): SpinSpec {
  const d = normalize(v3(velocity.x, 0, velocity.z));
  const right = cross(d, v3(0, 1, 0));
  return {
    topspin: -dot(w, right) * RAD_TO_RPS,
    sidespin: -w.y * RAD_TO_RPS,
    corkscrew: dot(w, d) * RAD_TO_RPS,
  };
}

export const spinRps = (w: Vec3): number => len(w) * RAD_TO_RPS;

/**
 * Human readable label like "Heavy backspin + sidespin (curves to your left)".
 * perspective 'receiver': the ball travels TOWARD the viewer, so "right of travel" is the
 * viewer's LEFT. perspective 'travel': described from behind the ball (the hitter's view).
 */
export function describeSpin(spec: SpinSpec, perspective: 'receiver' | 'travel' = 'receiver'): string {
  const parts: string[] = [];
  const mag = (x: number) => (Math.abs(x) >= 35 ? 'heavy ' : Math.abs(x) >= 15 ? '' : 'light ');
  if (Math.abs(spec.topspin) >= 4) parts.push(`${mag(spec.topspin)}${spec.topspin > 0 ? 'topspin' : 'backspin'}`);
  if (Math.abs(spec.sidespin) >= 4) {
    const curvesRightOfTravel = spec.sidespin > 0;
    const viewerRight = perspective === 'receiver' ? !curvesRightOfTravel : curvesRightOfTravel;
    const who = perspective === 'receiver' ? 'your' : 'the';
    parts.push(`${mag(spec.sidespin)}sidespin (curves to ${who} ${viewerRight ? 'right' : 'left'})`);
  }
  if (Math.abs(spec.corkscrew) >= 6) parts.push(`${mag(spec.corkscrew)}corkscrew`);
  if (parts.length === 0) return 'No spin (float)';
  const s = parts.join(' + ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}
