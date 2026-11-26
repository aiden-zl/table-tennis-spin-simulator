/**
 * Table-relative aim: yaw 0 points the face and the swing from the contact point at the middle
 * of the opponent's half, and the paddle that is DRAWN uses exactly the normal the physics uses.
 */
import { describe, expect, it } from 'vitest';
import { BallState } from '../src/physics/ball';
import { TABLE_Y } from '../src/physics/constants';
import { simulateReturn } from '../src/physics/trajectory';
import { v3 } from '../src/physics/vec';
import {
  AIM_CENTRE,
  PaddleControl,
  aimBaseDeg,
  controlNormal,
  faceNormal,
  hitWithPaddle,
  playerPaddlePose,
} from '../src/game/playerStroke';

const ctl = (yawDeg: number, pitchDeg = 5): PaddleControl => ({ pitchDeg, yawDeg, stroke: 'block', strength: 0.5, x: 0, y: 0 });

describe('table-relative aim', () => {
  it('base yaw points from the contact point at AIM_CENTRE', () => {
    expect(aimBaseDeg(v3(0, 1, 1.5))).toBeCloseTo(0, 12);
    const p = v3(0.6, 1, 1.4);
    const b = aimBaseDeg(p) * (Math.PI / 180);
    // aim direction (sin b, 0, -cos b) is parallel to AIM_CENTRE - p
    const dx = AIM_CENTRE.x - p.x;
    const dz = AIM_CENTRE.z - p.z;
    expect(Math.sin(b) * dz - -Math.cos(b) * dx).toBeCloseTo(0, 12);
    expect(aimBaseDeg(v3(-0.6, 1, 1.4))).toBeCloseTo(-aimBaseDeg(p), 12);
  });

  it('the drawn face normal is the physics normal (at contact)', () => {
    const cs = v3(-0.55, TABLE_Y + 0.25, 1.3);
    for (const y of [-20, -5, 0, 7, 30]) {
      const c = ctl(y, 12);
      const pose = playerPaddlePose(c, cs, 0);
      const n = controlNormal(c, cs);
      expect(pose.normal.x).toBeCloseTo(n.x, 12);
      expect(pose.normal.y).toBeCloseTo(n.y, 12);
      expect(pose.normal.z).toBeCloseTo(n.z, 12);
      expect(n.x).toBeCloseTo(faceNormal(12, y + aimBaseDeg(cs)).x, 12);
    }
  });

  it('a no-spin cross-court ball taken wide, returned at 0 deg, lands near the middle', () => {
    for (const x of [-0.6, 0.6]) {
      // travelling diagonally out from the opponent's middle, as a real angled ball does
      const ball: BallState = { p: v3(x, TABLE_Y + 0.25, 1.4), v: v3((x / 2.8) * 4, -0.5, 4), w: v3() };
      const ret = simulateReturn(hitWithPaddle(ball, ctl(0, 18)));
      expect(ret.outcome).toBe('in');
      expect(Math.abs(ret.landing!.x)).toBeLessThan(0.3);
    }
  });
});
