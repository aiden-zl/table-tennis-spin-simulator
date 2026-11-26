import { describe, expect, it } from 'vitest';
import { surfaceContact, type BallState } from '../src/physics/ball';
import {
  BALL_RADIUS,
  PADDLE_FRICTION,
  PADDLE_RESTITUTION,
  PADDLE_TANGENTIAL_RESTITUTION,
} from '../src/physics/constants';
import { spinVector, type SpinSpec } from '../src/physics/spin';
import { buildOpponentSwing, incomingAtContact, opponentReadyPose } from '../src/game/opponentSwing';
import type { ShotKind } from '../src/contracts';
import { addScaled, cross, dist, dot, len, v3, type Vec3 } from '../src/physics/vec';

const angleDeg = (a: Vec3, b: Vec3) => (Math.acos(Math.min(1, Math.max(-1, dot(a, b) / (len(a) * len(b))))) * 180) / Math.PI;

function makeLaunch(kind: ShotKind, spin: SpinSpec, vel?: Vec3): BallState {
  const v = vel ?? (kind === 'serve' ? v3(0.1, 0.6, 4.2) : v3(0, 1.5, 7));
  const p = kind === 'serve' ? v3(-0.2, 0.9, -1.5) : v3(0.1, 1.0, -1.65);
  return { p, v, w: spinVector(spin, v) };
}

const CASES: { name: string; spin: SpinSpec }[] = [
  { name: 'topspin', spin: { topspin: 40, sidespin: 0, corkscrew: 0 } },
  { name: 'backspin', spin: { topspin: -40, sidespin: 0, corkscrew: 0 } },
  { name: 'sidespin right', spin: { topspin: 0, sidespin: 30, corkscrew: 0 } },
  { name: 'sidespin left', spin: { topspin: 0, sidespin: -30, corkscrew: 0 } },
  { name: 'corkscrew +', spin: { topspin: 0, sidespin: 0, corkscrew: 25 } },
  { name: 'corkscrew -', spin: { topspin: 0, sidespin: 0, corkscrew: -25 } },
  { name: 'back + side', spin: { topspin: -30, sidespin: 25, corkscrew: 0 } },
  { name: 'top + side', spin: { topspin: 30, sidespin: -25, corkscrew: 0 } },
  { name: 'no spin', spin: { topspin: 0, sidespin: 0, corkscrew: 0 } },
];

function replay(launch: BallState, kind: ShotKind, incoming?: BallState) {
  const swing = buildOpponentSwing(launch, kind);
  const ball = incoming ?? incomingAtContact(launch, kind);
  const out = surfaceContact(
    ball,
    swing.contactNormal,
    swing.contactVelocity,
    PADDLE_RESTITUTION,
    PADDLE_FRICTION,
    PADDLE_TANGENTIAL_RESTITUTION,
  );
  return { swing, out };
}

/**
 * Pure corkscrew (w parallel to v) cannot be produced by ONE flat contact on a non-spinning ball:
 * the spin change r x Jt is always perpendicular to the face normal and to the friction
 * impulse, i.e. never parallel to the velocity change. So for corkscrew we only demand the sign.
 */
function expectSpinSigns(out: Vec3, target: Vec3, checkAngle = true, noSpinTol = 40) {
  const mag = len(target);
  if (mag < 1) {
    expect(len(out)).toBeLessThan(noSpinTol); // rad/s of accidental spin (40 ~ 6 rps)
    return;
  }
  for (const k of ['x', 'y', 'z'] as const) {
    if (Math.abs(target[k]) > 0.3 * mag) expect(Math.sign(out[k]), `w.${k}`).toBe(Math.sign(target[k]));
  }
  if (checkAngle) expect(angleDeg(out, target)).toBeLessThan(45);
}

for (const kind of ['serve', 'rally'] as ShotKind[]) {
  describe(`opponent swing physics (${kind})`, () => {
    for (const c of CASES) {
      it(`${c.name}: replaying the swing through surfaceContact reproduces the spin & direction`, () => {
        const launch = makeLaunch(kind, c.spin);
        const { out } = replay(launch, kind);
        const cork = c.name.startsWith('corkscrew');
        expectSpinSigns(out.w, launch.w, !cork);
        // serve corkscrew is reachable approximately; rally corkscrew (non-spinning feed) is
        // physically mostly converted to sidespin by a single contact - documented limit
        if (cork) expect(angleDeg(out.w, launch.w)).toBeLessThan(kind === 'serve' ? 50 : 80);
        expect(angleDeg(out.v, launch.v)).toBeLessThan(25);
      });
    }
  });
}

describe('serve robustness: ball at rest at contact', () => {
  for (const c of CASES) {
    it(`${c.name}: spin signs hold for a ball at rest`, () => {
      const launch = makeLaunch('serve', c.spin);
      const { out } = replay(launch, 'serve', { p: launch.p, v: v3(), w: v3() });
      // the fit targets the real (falling) toss; at rest a "no spin" serve picks up <= ~10 rps
      expectSpinSigns(out.w, launch.w, !c.name.startsWith('corkscrew'), 65);
      expect(angleDeg(out.v, launch.v)).toBeLessThan(35);
    });
  }
});

describe('brush direction and face', () => {
  for (const kind of ['serve', 'rally'] as ShotKind[]) {
    it(`${kind}: topspin brushes up, backspin brushes down`, () => {
      const top = buildOpponentSwing(makeLaunch(kind, CASES[0].spin), kind);
      const back = buildOpponentSwing(makeLaunch(kind, CASES[1].spin), kind);
      expect(top.brushDir.y).toBeGreaterThan(0.3);
      // backspin: brush goes forward-UNDER the ball along a (very) open face, so y < 0
      expect(back.brushDir.y).toBeLessThan(-0.15);
      // physics: spin change ∝ brush × n
      expect(cross(top.brushDir, top.contactNormal).x).toBeGreaterThan(0.5);
      expect(cross(back.brushDir, back.contactNormal).x).toBeLessThan(-0.5);
      // backspin face is more open (looks up) than topspin face
      expect(back.contactNormal.y).toBeGreaterThan(top.contactNormal.y);
      // what the user SEES is the paddle itself: tangential part of its velocity
      const tang = (sw: typeof top) => {
        const vp = sw.contactVelocity;
        const nn = sw.contactNormal;
        return addScaled(vp, nn, -dot(vp, nn));
      };
      expect(tang(top).y).toBeGreaterThan(0);
      expect(tang(back).y).toBeLessThan(0);
      for (const s of [top, back]) {
        expect(s.contactNormal.z).toBeGreaterThan(0.2); // faces the player
        expect(Math.abs(len(s.brushDir) - 1)).toBeLessThan(1e-9);
        expect(Math.abs(dot(s.brushDir, s.contactNormal))).toBeLessThan(1e-9);
      }
    });
    it(`${kind}: sidespin brush is sideways with the physical sign (w.y>0 <=> brush -x)`, () => {
      const right = buildOpponentSwing(makeLaunch(kind, CASES[2].spin), kind);
      const left = buildOpponentSwing(makeLaunch(kind, CASES[3].spin), kind);
      const wR = makeLaunch(kind, CASES[2].spin).w;
      expect(Math.sign(-right.brushDir.x)).toBe(Math.sign(wR.y));
      expect(Math.sign(left.brushDir.x)).toBe(-Math.sign(right.brushDir.x));
      expect(Math.abs(right.brushDir.x)).toBeGreaterThan(0.5);
      // paddle itself moves sideways in the brush direction
      expect(Math.sign(right.contactVelocity.x)).toBe(Math.sign(right.brushDir.x));
      expect(Math.sign(left.contactVelocity.x)).toBe(Math.sign(left.brushDir.x));
    });
  }
});

function expectContinuous(s: ReturnType<typeof buildOpponentSwing>) {
  const dt = 0.002;
  let prev = s.poseAt(-s.leadTime);
  for (let t = -s.leadTime + dt; t <= 0.5 + 1e-9; t += dt) {
    const cur = s.poseAt(t);
    expect(dist(cur.pos, prev.pos)).toBeLessThan(0.05);
    expect(dot(cur.normal, prev.normal)).toBeGreaterThan(0.99);
    expect(dot(cur.up, prev.up)).toBeGreaterThan(0.99);
    expect(Math.abs(dot(cur.up, cur.normal))).toBeLessThan(1e-6);
    expect(Math.abs(len(cur.up) - 1)).toBeLessThan(1e-9);
    prev = cur;
  }
}

describe('poses and pre-contact path', () => {
  for (const kind of ['serve', 'rally'] as ShotKind[]) {
    for (const c of CASES) {
      it(`${kind} ${c.name}: continuous pose, contact pose, ball path`, () => {
        const launch = makeLaunch(kind, c.spin);
        const s = buildOpponentSwing(launch, kind);
        expect(s.leadTime).toBeCloseTo(kind === 'serve' ? 0.9 : 0.6);
        // seamless start from the ready pose at the striking x
        const r = opponentReadyPose(launch.p.x);
        const start = s.poseAt(-s.leadTime);
        expect(dist(start.pos, r.pos)).toBeLessThan(1e-9);
        expect(dist(start.normal, r.normal)).toBeLessThan(1e-9);
        expect(dist(start.up, r.up)).toBeLessThan(1e-9);
        // contact pose
        const p0 = s.poseAt(0);
        expect(dist(p0.pos, addScaled(launch.p, s.contactNormal, -BALL_RADIUS))).toBeLessThan(1e-9);
        expect(dist(p0.normal, s.contactNormal)).toBeLessThan(1e-9);
        // velocity at contact ≈ exaggerated contactVelocity, in the right direction
        const h = 1e-4;
        const vNum = addScaled(s.poseAt(h).pos, s.poseAt(-h).pos, -1);
        expect(angleDeg(vNum, s.contactVelocity)).toBeLessThan(3);
        expectContinuous(s);
        // ball path
        expect(dist(s.preContactBallAt(0), launch.p)).toBeLessThan(1e-9);
        const dt = 0.002;
        let bp = s.preContactBallAt(-s.leadTime);
        for (let t = -s.leadTime + dt; t <= 1e-9; t += dt) {
          const cur = s.preContactBallAt(t);
          expect(dist(cur, bp)).toBeLessThan(0.03);
          bp = cur;
        }
        if (kind === 'serve') {
          const start = s.preContactBallAt(-s.leadTime);
          let apex = -Infinity;
          for (let t = -s.leadTime; t <= 0; t += dt) {
            const q = s.preContactBallAt(t);
            apex = Math.max(apex, q.y);
            expect(Math.abs(q.x - launch.p.x) + Math.abs(q.z - launch.p.z)).toBeLessThan(1e-9); // vertical toss
          }
          expect(apex - start.y).toBeGreaterThanOrEqual(0.16);
        } else {
          expect(s.preContactBallAt(-s.leadTime).z).toBeGreaterThan(0); // comes from the player's side
        }
      });
    }
  }
  it('ready pose faces the player with a valid basis', () => {
    const r = opponentReadyPose(0.3);
    expect(r.normal.z).toBeGreaterThan(0.9);
    expect(r.pos.z).toBeLessThan(-1.37);
    expect(Math.abs(dot(r.up, r.normal))).toBeLessThan(1e-9);
  });
});

describe('sweep over speeds and spin mixes', () => {
  it('top/back and side signs, direction and continuity hold across realistic launches', () => {
    const vels: [ShotKind, Vec3][] = [
      ['serve', v3(0, 1.0, 2.6)],
      ['serve', v3(-0.6, 0.3, 5.5)],
      ['rally', v3(0.4, 2.0, 5)],
      ['rally', v3(-0.3, 0.6, 11)],
      ['serve', v3(0.8, 0.5, 3.5)],
    ];
    for (const [kind, v] of vels) {
      for (const top of [-60, -50, -20, 0, 20, 50]) {
        for (const side of [-40, -30, 0, 30, 40]) {
          const launch = makeLaunch(kind, { topspin: top, sidespin: side, corkscrew: 0 }, v);
          const { out, swing } = replay(launch, kind);
          expectContinuous(swing);
          expect(dist(swing.preContactBallAt(0), launch.p)).toBeLessThan(1e-9);
          expectSpinSigns(out.w, launch.w, true, 45);
          expect(angleDeg(out.v, launch.v), `${kind} ${top}/${side}`).toBeLessThan(25);
          // physics of the brush: spin ∝ brush × n, for every mix
          const bn = cross(swing.brushDir, swing.contactNormal);
          if (Math.abs(top) >= 20) expect(Math.sign(bn.x)).toBe(Math.sign(launch.w.x));
          if (Math.abs(side) >= 30) expect(Math.sign(bn.y)).toBe(Math.sign(launch.w.y));
          // pure top/backspin: brush visibly up / down. (With heavy side mixed in, a backspin
          // brush can be sideways-forward along an open face, so no y check there.)
          if (side === 0 && top >= 20) expect(swing.brushDir.y).toBeGreaterThan(0);
          if (side === 0 && top <= -20) expect(swing.brushDir.y).toBeLessThan(0);
        }
      }
    }
  });
});

import { PRESETS, planShot } from '../src/game/shots';
const PRESETS_FOR_CONTINUITY = () => PRESETS.map((p) => planShot(p.spec)!);

describe('opponent swing pose continuity', () => {
  it('starts at the ready pose at -leadTime, is continuous, and recovers to ready', () => {
    for (const preset of PRESETS_FOR_CONTINUITY()) {
      const plan = preset;
      const sw = plan.swing;
      const ready = opponentReadyPose(plan.launch.p.x);
      const d = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) =>
        Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
      expect(d(sw.poseAt(-sw.leadTime).pos, ready.pos)).toBeLessThan(1e-6);
      expect(d(sw.poseAt(5).pos, ready.pos)).toBeLessThan(1e-6);
      // no jumps bigger than what ~15 m/s paddle motion covers in 2 ms (frames are coarser)
      let prev = sw.poseAt(-sw.leadTime - 0.2);
      for (let t = -sw.leadTime - 0.2; t < 2; t += 0.002) {
        const p = sw.poseAt(t);
        expect(d(p.pos, prev.pos)).toBeLessThan(0.04);
        expect(Math.abs(Math.hypot(p.normal.x, p.normal.y, p.normal.z) - 1)).toBeLessThan(1e-6);
        prev = p;
      }
    }
  });
});
