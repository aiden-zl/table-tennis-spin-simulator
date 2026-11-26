import { describe, expect, it } from 'vitest';
import {
  airflow,
  classifySpin,
  flowParams,
  hexToRgb,
  integrateOrientation,
  newFlowParams,
  ringPoint,
  ringTangent,
  rotateByQuat,
  spinColor,
  spinFade,
  surfaceVelocity,
  SPIN_COLORS,
  type QuatLike,
} from '../src/render/ballviz/math';
import { spinVector } from '../src/physics/spin';
import { acceleration } from '../src/physics/ball';
import { cross, dot, normalize, v3, type Vec3 } from '../src/physics/vec';

const ident = (): QuatLike => ({ x: 0, y: 0, z: 0, w: 1 });
const axisAngle = (ax: Vec3, ang: number): QuatLike => {
  const n = normalize(ax);
  const s = Math.sin(ang / 2);
  return { x: n.x * s, y: n.y * s, z: n.z * s, w: Math.cos(ang / 2) };
};
const expectVec = (a: Vec3, b: Vec3, eps = 1e-6) => {
  expect(a.x).toBeCloseTo(b.x, 5);
  expect(a.y).toBeCloseTo(b.y, 5);
  expect(a.z).toBeCloseTo(b.z, 5);
  void eps;
};

describe('orientation integration (world-frame w)', () => {
  it('topspin toward the player: the top of the ball moves toward the player (+z)', () => {
    const v = v3(0, 0, 10);
    const w = spinVector({ topspin: 30, sidespin: 0, corkscrew: 0 }, v);
    expect(w.x).toBeGreaterThan(0); // convention check
    const q = integrateOrientation(ident(), w, 1e-6); // small step
    const top = rotateByQuat(q, v3(0, 1, 0));
    expect(top.z).toBeGreaterThan(0);
    // and it matches w × r
    const sv = surfaceVelocity(w, v3(0, 1, 0));
    expect(sv.z).toBeGreaterThan(0);
    expect(dot(normalize(sv), normalize(v3(top.x, top.y - 1, top.z)))).toBeGreaterThan(0.999);
  });

  it('backspin toward the player: the top moves away (toward the opponent, -z)', () => {
    const v = v3(0, 0, 10);
    const w = spinVector({ topspin: -30, sidespin: 0, corkscrew: 0 }, v);
    const top = rotateByQuat(integrateOrientation(ident(), w, 0.001), v3(0, 1, 0));
    expect(top.z).toBeLessThan(0);
  });

  it('any surface point moves along w × r', () => {
    const w = v3(12, -40, 25);
    const dt = 1e-7;
    for (const r of [v3(1, 0, 0), v3(0, 1, 0), v3(0, 0, 1), normalize(v3(1, -2, 0.5))]) {
      const start = axisAngle(v3(0.3, 1, -0.4), 1.1);
      const p0 = rotateByQuat(start, r);
      const p1 = rotateByQuat(integrateOrientation({ ...start }, w, dt), r);
      const vel = { x: (p1.x - p0.x) / dt, y: (p1.y - p0.y) / dt, z: (p1.z - p0.z) / dt };
      // world-frame rule: velocity of the CURRENT world point p0 is w × p0
      const expected = surfaceVelocity(w, p0);
      expect(vel.x).toBeCloseTo(expected.x, 2);
      expect(vel.y).toBeCloseTo(expected.y, 2);
      expect(vel.z).toBeCloseTo(expected.z, 2);
    }
  });

  it('is left-multiplication q\' = exp(w dt / 2) ⊗ q (world axis, not body axis)', () => {
    const q0 = axisAngle(v3(0, 0, 1), Math.PI / 2); // body x → world y
    const w = v3(Math.PI / 2, 0, 0); // rotate 90° about WORLD x in 1 s
    const q1 = integrateOrientation({ ...q0 }, w, 1);
    // body x: first → world y, then world-x rotation by 90° maps y → z
    expectVec(rotateByQuat(q1, v3(1, 0, 0)), v3(0, 0, 1));
  });

  it('a full revolution returns to the start; result stays normalised', () => {
    const q0 = axisAngle(v3(1, 2, 3), 0.7);
    const w = v3(0, 2 * Math.PI * 5, 0);
    const q = { ...q0 };
    for (let i = 0; i < 200; i++) integrateOrientation(q, w, 1 / 1000); // 5 rps × 0.2 s = 1 rev
    expect(Math.hypot(q.x, q.y, q.z, q.w)).toBeCloseTo(1, 9);
    const a = rotateByQuat(q, v3(1, 0, 0)), b = rotateByQuat(q0, v3(1, 0, 0));
    expectVec(a, b);
  });

  it('zero w / zero dt leaves q unchanged', () => {
    const q = axisAngle(v3(1, 0, 0), 0.3);
    const before = { ...q };
    integrateOrientation(q, v3(), 0.1);
    integrateOrientation(q, v3(1, 1, 1), 0);
    expect(q).toEqual(before);
  });
});

describe('rotation ring', () => {
  it('arrow tangent equals axis(+Y) × point, i.e. the surface motion direction', () => {
    for (const a of [0, 0.5, Math.PI, 1.5 * Math.PI, 4]) {
      const p = ringPoint(a), t = ringTangent(a);
      expectVec(t, cross(v3(0, 1, 0), p));
      // numeric derivative agrees
      const p2 = ringPoint(a + 1e-6);
      expect(dot(normalize(v3(p2.x - p.x, p2.y - p.y, p2.z - p.z)), t)).toBeGreaterThan(0.9999);
    }
  });
});

describe('spin colours', () => {
  const v = v3(0, 0.5, 9); // toward the player
  const near = (key: keyof typeof SPIN_COLORS, w: Vec3, vel = v) => {
    const c = spinColor(w, vel);
    const ref = hexToRgb(SPIN_COLORS[key]);
    expect(Math.abs(c.r - ref.r) + Math.abs(c.g - ref.g) + Math.abs(c.b - ref.b)).toBeLessThan(0.02);
  };
  it('pure components map to the legend', () => {
    near('topspin', spinVector({ topspin: 30, sidespin: 0, corkscrew: 0 }, v));
    near('backspin', spinVector({ topspin: -30, sidespin: 0, corkscrew: 0 }, v));
    near('none', v3());
  });
  it('side colours follow the curve as seen by the player (matches the physics Magnus x)', () => {
    for (const vel of [v3(0, 0, 9), v3(0.5, 0.3, -9)]) {
      for (const side of [25, -25]) {
        const w = spinVector({ topspin: 0, sidespin: side, corkscrew: 0 }, vel);
        const ax = acceleration(vel, w).x;
        const k = classifySpin(w, vel);
        expect(k.dominant).toBe(ax > 0 ? 'sideRight' : 'sideLeft');
        near(ax > 0 ? 'sideRight' : 'sideLeft', w, vel);
      }
    }
  });
  it('topspin hit by the player toward the opponent is still topspin', () => {
    const vel = v3(0, 0.5, -9);
    const w = spinVector({ topspin: 30, sidespin: 0, corkscrew: 0 }, vel);
    expect(w.x).toBeLessThan(0);
    expect(classifySpin(w, vel).dominant).toBe('topspin');
  });
  it('fades to neutral below ~3 rps', () => {
    expect(spinFade(0.5)).toBe(0);
    expect(spinFade(5)).toBe(1);
    expect(spinFade(2.75)).toBeGreaterThan(0);
    expect(spinFade(2.75)).toBeLessThan(1);
  });
});

describe('airflow field', () => {
  const v = v3(0, 0, 10);
  const a = 0.032;
  it('front stagnation point has ~zero flow without spin', () => {
    const p = flowParams(v3(), v, a, newFlowParams());
    const o = { x: 0, y: 0, z: 0 };
    airflow(o, 0, 0, a, p); // upstream = toward the player (+z), air flows -z
    expect(Math.hypot(o.x, o.y, o.z)).toBeLessThan(1e-9);
    airflow(o, 0, 0, 10, p); // far away: free stream
    expectVec(o, v3(0, 0, -1));
  });
  it('swirl near the surface follows the surface motion (w × r)', () => {
    const w = spinVector({ topspin: 40, sidespin: 0, corkscrew: 0 }, v);
    const p = flowParams(w, v, a, newFlowParams());
    const p0 = flowParams(v3(), v, a, newFlowParams());
    const o = { x: 0, y: 0, z: 0 }, o0 = { x: 0, y: 0, z: 0 };
    airflow(o, 0, a * 1.05, 0, p);
    airflow(o0, 0, a * 1.05, 0, p0);
    // top surface moves +z (against the -z air) → air above is slowed
    expect(o.z - o0.z).toBeGreaterThan(0.3);
  });
  it('wake is deflected opposite to the Magnus force', () => {
    for (const spec of [
      { topspin: 40, sidespin: 0, corkscrew: 0 },
      { topspin: -40, sidespin: 0, corkscrew: 0 },
      { topspin: 0, sidespin: 30, corkscrew: 0 },
    ]) {
      const w = spinVector(spec, v);
      const magnus = normalize(cross(w, v));
      const p = flowParams(w, v, a, newFlowParams());
      const o = { x: 0, y: 0, z: 0 };
      airflow(o, 0, 0, -3 * a, p); // downstream on the axis
      expect(dot(o, magnus)).toBeLessThan(-0.2);
      // and Magnus agrees with the physics lift direction
      const acc = acceleration(v, w);
      const acc0 = acceleration(v, v3());
      expect(dot(v3(acc.x - acc0.x, acc.y - acc0.y, acc.z - acc0.z), magnus)).toBeGreaterThan(0);
    }
  });
});

describe('BallView smoke test (headless)', () => {
  it('updates many frames without NaNs and respects assist layers', async () => {
    const THREE = await import('three');
    const { BallView } = await import('../src/render/ballView');
    const scene = new THREE.Scene();
    const view = new BallView(scene);
    const ball = { p: v3(0.1, 1.0, -1.2), v: v3(0.3, 1.0, 8), w: spinVector({ topspin: 35, sidespin: 10, corkscrew: 0 }, v3(0, 0, 8)) };
    const q0 = view.orientation.clone();
    for (let i = 0; i < 120; i++) {
      ball.p = v3(ball.p.x + ball.v.x / 60, ball.p.y, ball.p.z + ball.v.z / 60);
      view.update(ball, 1 / 60, 1 / 60, { assist: i < 60 ? 'full' : 'ball', visible: true, spinVisualScale: 0.1, showTrail: true });
    }
    expect(view.orientation.angleTo(q0)).toBeGreaterThan(0.01);
    let meshes = 0;
    scene.traverse((o) => {
      const m = o as InstanceType<typeof THREE.Mesh>;
      if (!m.isMesh) return;
      meshes++;
      const pos = m.geometry.getAttribute('position').array as ArrayLike<number>;
      for (let i = 0; i < pos.length; i++) expect(Number.isFinite(pos[i])).toBe(true);
    });
    expect(meshes).toBeGreaterThan(5);
    view.update(ball, 0, 1 / 60, { assist: 'full', visible: false, spinVisualScale: 0.1, showTrail: true });
    expect(scene.getObjectByName('BallView')!.visible).toBe(false);
    view.dispose();
    expect(scene.getObjectByName('BallView')).toBeUndefined();
  });
});

describe('BallView trail', () => {
  it('keeps ~0.35 s of sim time even in slow-mo at high refresh', async () => {
    const THREE = await import('three');
    const { BallView } = await import('../src/render/ballView');
    const view = new BallView(new THREE.Scene());
    const ball = { p: v3(0, 1, -1.2), v: v3(0, 0, 8), w: v3(100, 0, 0) };
    const simDt = 1 / 480; // 0.25x at 120 Hz
    for (let i = 0; i < 400; i++) {
      ball.p = v3(0, 1, ball.p.z + ball.v.z * simDt);
      view.update(ball, simDt, 1 / 120, { assist: 'full', visible: true, spinVisualScale: 0.1, showTrail: true });
    }
    expect(view.trailSpan()).toBeGreaterThan(0.3);
    expect(view.trailSpan()).toBeLessThan(0.36);
    view.dispose();
  });
});

import { liftAccel } from '../src/render/ballviz/math';
import { G, K_DRAG } from '../src/physics/constants';

describe('Magnus arrow magnitude matches the physics', () => {
  it('equals |a - gravity - drag| for oblique spin (incl. corkscrew component)', () => {
    const cases = [
      { v: { x: 0, y: -1, z: 9 }, w: { x: 200, y: 50, z: 150 } },
      { v: { x: 1, y: 2, z: -6 }, w: { x: -300, y: 0, z: -400 } },
      { v: { x: 0, y: 0, z: 12 }, w: { x: 0, y: 0, z: 300 } }, // pure gyro: no lift
    ];
    for (const { v, w } of cases) {
      const a = acceleration(v, w);
      const sp = Math.hypot(v.x, v.y, v.z);
      const lift = { x: a.x + K_DRAG * sp * v.x, y: a.y + G + K_DRAG * sp * v.y, z: a.z + K_DRAG * sp * v.z };
      expect(liftAccel(w, v)).toBeCloseTo(Math.hypot(lift.x, lift.y, lift.z), 6);
    }
  });
});
