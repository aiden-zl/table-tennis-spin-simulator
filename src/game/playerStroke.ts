import { BallState, surfaceContact } from '../physics/ball';
import {
  BALL_RADIUS,
  DEG,
  PADDLE_FRICTION,
  PADDLE_RESTITUTION,
  PADDLE_TANGENTIAL_RESTITUTION,
} from '../physics/constants';
import { Vec3, add, addScaled, cross, dot, normalize, scale, sub, v3 } from '../physics/vec';

export type StrokeType = 'block' | 'push' | 'drive' | 'chop';

export const STROKES: { id: StrokeType; label: string; key: string; blurb: string }[] = [
  { id: 'block', label: 'Block', key: '1', blurb: 'Short, firm forward motion. Mostly uses the incoming pace and spin.' },
  { id: 'push', label: 'Push', key: '2', blurb: 'Forward and slightly down under the ball. Adds backspin; the safe answer to backspin.' },
  { id: 'drive', label: 'Drive / Loop', key: '3', blurb: 'Fast forward and upward brush. Adds topspin; overpowers incoming spin.' },
  { id: 'chop', label: 'Chop', key: '4', blurb: 'Downward-forward slicing motion. Adds heavy backspin.' },
];

/**
 * The player's paddle control state.
 * pitchDeg: face tilt from vertical. + OPEN (face looks up toward the ceiling), - CLOSED
 *           (face looks down at the table). 0 = perfectly vertical, facing the opponent.
 * yawDeg:   horizontal aim RELATIVE TO THE TABLE: 0 = face (and swing) pointed from the contact
 *           point at the middle of the opponent's half (AIM_CENTRE), wherever the ball is taken.
 *           + turns it toward the player's RIGHT (+x), - toward the left. (A player squares up
 *           to the table; "0" is not "parallel to the side line", which from a wide ball would
 *           already point off the table.) Use aimBaseDeg / worldYawDeg for the world angle.
 * strength: 0..1 swing intensity for the chosen stroke.
 * x, y:     paddle centre position in MANUAL positioning mode (ignored in auto mode).
 */
export interface PaddleControl {
  pitchDeg: number;
  yawDeg: number;
  stroke: StrokeType;
  strength: number;
  x: number;
  y: number;
}

export const PITCH_LIMITS = { min: -70, max: 80 };
export const YAW_LIMITS = { min: -45, max: 45 };

/** Paddle pose for rendering. `normal` = hitting face direction, `up` = from handle toward blade tip. */
export interface PaddlePose {
  pos: Vec3;
  normal: Vec3;
  up: Vec3;
}

/** Point the player's aim is referenced to: the middle of the opponent's half. */
export const AIM_CENTRE = { x: 0, z: -0.75 } as const;

/** World yaw (deg) of the line from a contact point to AIM_CENTRE (0 = straight down the table). */
export function aimBaseDeg(ballPos: Vec3): number {
  return Math.atan2(AIM_CENTRE.x - ballPos.x, Math.max(ballPos.z - AIM_CENTRE.z, 0.5)) / DEG;
}

/** World-frame yaw (deg) for a table-relative control yaw at this contact point. */
export const worldYawDeg = (yawDeg: number, ballPos: Vec3): number => yawDeg + aimBaseDeg(ballPos);

/** The player's face normal at a contact point (the one the physics uses). */
export const controlNormal = (control: PaddleControl, ballPos: Vec3): Vec3 =>
  faceNormal(control.pitchDeg, worldYawDeg(control.yawDeg, ballPos));

/** Unit normal of the player's hitting face (points toward the opponent / the incoming ball). `yawDeg` is the WORLD yaw. */
export function faceNormal(pitchDeg: number, yawDeg: number): Vec3 {
  const p = pitchDeg * DEG;
  const y = yawDeg * DEG;
  return v3(Math.sin(y) * Math.cos(p), Math.sin(p), -Math.cos(y) * Math.cos(p));
}

/** Horizontal aim direction of the swing (toward the opponent, turned by WORLD yaw). */
export function aimDirection(yawDeg: number): Vec3 {
  const y = yawDeg * DEG;
  return v3(Math.sin(y), 0, -Math.cos(y));
}

/**
 * Paddle velocity at the moment of contact for each stroke (m/s, world frame).
 * The component along the face creates/changes spin (brushing); the normal component
 * adds pace.
 */
export function strokeVelocity(stroke: StrokeType, strength: number, yawDeg: number): Vec3 {
  // yawDeg here is the WORLD yaw (callers convert with worldYawDeg)
  const s = Math.min(Math.max(strength, 0), 1);
  const d = aimDirection(yawDeg);
  const up = v3(0, 1, 0);
  let fwd = 0;
  let vert = 0;
  switch (stroke) {
    case 'block':
      // short punch, ~0.6-1.8 m/s: a block mostly re-uses the incoming pace and spin
      fwd = 0.6 + 1.2 * s;
      vert = 0;
      break;
    case 'push':
      // real pushes: ~1.5-3.5 m/s mostly forward with a slight downward slice
      fwd = 1.5 + 2.0 * s;
      vert = -(0.2 + 0.5 * s);
      break;
    case 'drive':
      // loop: steep (~45-50 deg) upward brush at 6-11 m/s paddle speed (club-level forehand
      // loop). Returns leave at ~10-16 m/s with ~25-60 rps topspin, as measured for real loops.
      // (Was fwd 3+4s / vert 1.6+2.4s: only 6-29 rps, i.e. a flat hit, not a loop.)
      fwd = 3.0 + 5.0 * s;
      vert = 3.0 + 6.0 * s;
      break;
    case 'chop':
      // mostly downward slice (~2-5 m/s) under the ball
      fwd = 1.0 + 1.0 * s;
      vert = -(2.0 + 2.5 * s);
      break;
  }
  return add(scale(d, fwd), scale(up, vert));
}

/**
 * Apply the player's paddle to the ball. The physics is the same rigid-body impulse model as
 * every other contact: restitution along the face normal, Coulomb friction / grip along it.
 */
export function hitWithPaddle(ball: BallState, control: PaddleControl): BallState {
  const yaw = worldYawDeg(control.yawDeg, ball.p);
  const n = faceNormal(control.pitchDeg, yaw);
  const vel = strokeVelocity(control.stroke, control.strength, yaw);
  return surfaceContact(ball, n, vel, PADDLE_RESTITUTION, PADDLE_FRICTION, PADDLE_TANGENTIAL_RESTITUTION);
}

/**
 * Does the swing actually strike the ball? The face must be closing on the ball (relative
 * velocity into the face). With an extreme angle (e.g. a steeply open chop, or a drive with
 * the face rolled right over) the face moves away from the ball and it slips past untouched.
 */
export function paddleMeetsBall(ball: BallState, control: PaddleControl): boolean {
  const yaw = worldYawDeg(control.yawDeg, ball.p);
  const n = faceNormal(control.pitchDeg, yaw);
  const vel = strokeVelocity(control.stroke, control.strength, yaw);
  return dot(sub(ball.v, vel), n) < 0;
}

/** Orthonormal "up" (handle->tip) vector for a paddle face normal, preferring world up. */
export function bladeUp(normal: Vec3, preferred: Vec3 = v3(0, 1, 0)): Vec3 {
  let u = sub(preferred, scale(normal, dot(preferred, normal)));
  if (Math.hypot(u.x, u.y, u.z) < 0.2) {
    const alt = v3(0, 0, 1);
    u = sub(alt, scale(normal, dot(alt, normal)));
  }
  return normalize(u);
}

/**
 * Rendering pose of the player's paddle `tRel` seconds relative to contact (negative =
 * before). The blade centre sits one ball radius behind the ball at contact and moves along
 * the stroke velocity, with a backswing before and a short follow-through after.
 */
export function playerPaddlePose(
  control: PaddleControl,
  contactBallPos: Vec3,
  tRel: number,
  /** where the aim is referenced from (the real ball position at contact); defaults to contactBallPos */
  aimFrom: Vec3 = contactBallPos,
): PaddlePose {
  const yaw = worldYawDeg(control.yawDeg, aimFrom);
  const n = faceNormal(control.pitchDeg, yaw);
  const vel = strokeVelocity(control.stroke, control.strength, yaw);
  const contactCentre = addScaled(contactBallPos, n, -BALL_RADIUS);
  // ease: swing covers the path with smoothly varying speed, matching vel at tRel=0
  const backswing = 0.18;
  const follow = 0.16;
  let s: number;
  if (tRel <= -backswing) s = -backswing * 0.5;
  else if (tRel < 0) {
    // from rest at -backswing to full swing speed (ds/dt = 1) at contact
    const u = (tRel + backswing) / backswing; // 0..1
    s = (backswing * (u * u - 1)) / 2;
  } else if (tRel < follow) {
    const u = tRel / follow;
    s = follow * (u - (u * u) / 2);
  } else s = follow * 0.5;
  const pos = addScaled(contactCentre, vel, s);
  // tilt the blade slightly to the forehand side so the handle points down-right
  const up = bladeUp(n, normalize(v3(-0.25, 1, 0)));
  return { pos, normal: n, up };
}

/** Right vector of a paddle pose (completes the basis). */
export const poseRight = (pose: PaddlePose): Vec3 => cross(pose.up, pose.normal);
