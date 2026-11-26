/**
 * PHYSICS AUDIT TESTS
 *
 * Checks sign conventions, collision theory (impulse / restitution / Coulomb friction /
 * grip), conservation laws, aerodynamic magnitudes vs. literature, and integrator quality.
 *
 * Key derivations used below (thin shell, I = 2/3 m R^2):
 *  - Contact-point velocity: vc = v + w x r, r = -R n (centre -> contact).
 *  - A tangential impulse J changes vc by J (1/m + R^2/I) = 2.5 J/m.
 *  - Any impulse applied AT the contact point has zero moment about the contact point, so
 *    L_c = I w + m (R n) x v is conserved exactly by every surface contact.
 *  - Paddle vs. flight: rotating the backspin case 90 deg about the travel axis gives the
 *    sidespin case. Backspin lifts in flight (Magnus +y) yet leaves a passive paddle LOW
 *    (friction at the contact point pushes down). Therefore sidespin that curves to one side
 *    in flight deflects off a passive paddle to the OPPOSITE side. Tested below.
 */
import { describe, expect, it } from 'vitest';
import {
  BallState,
  WorldEvent,
  acceleration,
  integrateFlight,
  kineticEnergy,
  stepWorld,
  surfaceContact,
} from '../src/physics/ball';
import {
  AIR_DENSITY,
  BALL_AREA,
  BALL_INERTIA,
  BALL_MASS,
  BALL_RADIUS,
  G,
  K_DRAG,
  NET_HEIGHT,
  PADDLE_FRICTION,
  PADDLE_RESTITUTION,
  PADDLE_TANGENTIAL_RESTITUTION,
  RPS_TO_RAD,
  SPIN_DECAY,
  TABLE_FRICTION,
  TABLE_HALF_LENGTH,
  TABLE_HALF_WIDTH,
  TABLE_RESTITUTION,
  TABLE_Y,
} from '../src/physics/constants';
import { SpinSpec, spinComponents, spinVector } from '../src/physics/spin';
import { predictIncoming, simulateReturn } from '../src/physics/trajectory';
import { Vec3, add, cross, dot, len, normalize, scale, sub, v3 } from '../src/physics/vec';
import { PaddleControl, faceNormal, hitWithPaddle } from '../src/game/playerStroke';

// ───────────────────────────── helpers

const spec = (topspin = 0, sidespin = 0, corkscrew = 0): SpinSpec => ({ topspin, sidespin, corkscrew });

const ball = (p: Vec3, v: Vec3, s: SpinSpec = spec()): BallState => ({ p, v, w: spinVector(s, v) });

function fly(b: BallState, T: number, dt = 1e-3): BallState {
  const n = Math.round(T / dt);
  let s = b;
  for (let i = 0; i < n; i++) s = integrateFlight(s, dt);
  return s;
}

function world(b: BallState, T: number, dt = 1e-3): { b: BallState; events: WorldEvent[]; states: BallState[] } {
  const events: WorldEvent[] = [];
  const states: BallState[] = [b];
  const n = Math.round(T / dt);
  let s = b;
  for (let i = 0; i < n; i++) {
    s = stepWorld(s, dt, i * dt, events);
    states.push(s);
  }
  return { b: s, events, states };
}

/** mulberry32 seeded PRNG */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const randUnit = (r: () => number): Vec3 => {
  for (;;) {
    const p = v3(r() * 2 - 1, r() * 2 - 1, r() * 2 - 1);
    const l = len(p);
    if (l > 0.1 && l <= 1) return scale(p, 1 / l);
  }
};

/** Angular momentum about the contact point (centre is at +R n from the contact point). */
const Lc = (b: BallState, n: Vec3): Vec3 =>
  add(scale(b.w, BALL_INERTIA), scale(cross(scale(n, BALL_RADIUS), b.v), BALL_MASS));

/** Magnus-only acceleration (total minus gravity minus drag). */
function magnusAccel(v: Vec3, w: Vec3): Vec3 {
  const a = acceleration(v, w);
  const speed = len(v);
  return sub(sub(a, v3(0, -G, 0)), scale(v, -K_DRAG * speed));
}

const UP = v3(0, 1, 0);
const tableHit = (b: BallState) => surfaceContact(b, UP, v3(), TABLE_RESTITUTION, TABLE_FRICTION);

// ───────────────────────────── 1. signs

describe('1. spin sign conventions in flight', () => {
  it('spinVector follows the constants.ts header (w.x > 0 = topspin for +z travel, flips for -z)', () => {
    expect(spinVector(spec(10), v3(0, 0, 5)).x).toBeGreaterThan(0);
    expect(spinVector(spec(-10), v3(0, 0, 5)).x).toBeLessThan(0);
    expect(spinVector(spec(10), v3(0, 0, -5)).x).toBeLessThan(0);
    // sidespin + curves right of travel: for +z travel that is -x, so w.y must be < 0
    expect(spinVector(spec(0, 10), v3(0, 0, 5)).y).toBeLessThan(0);
    // topspin: the top of the ball moves along the direction of travel
    for (const vz of [5, -5]) {
      const w = spinVector(spec(10), v3(0, 0, vz));
      const topVel = cross(w, v3(0, BALL_RADIUS, 0));
      expect(Math.sign(topVel.z)).toBe(Math.sign(vz));
    }
  });

  it('spinComponents round-trips spinVector for arbitrary travel directions', () => {
    const r = rng(1);
    for (let i = 0; i < 500; i++) {
      const vel = v3(r() * 20 - 10, r() * 10 - 5, r() * 20 - 10);
      if (Math.hypot(vel.x, vel.z) < 0.1) continue;
      const s = spec(r() * 120 - 60, r() * 120 - 60, r() * 120 - 60);
      const back = spinComponents(spinVector(s, vel), vel);
      expect(back.topspin).toBeCloseTo(s.topspin, 9);
      expect(back.sidespin).toBeCloseTo(s.sidespin, 9);
      expect(back.corkscrew).toBeCloseTo(s.corkscrew, 9);
    }
  });

  for (const dir of [1, -1]) {
    it(`backspin floats, topspin dips (travel ${dir > 0 ? '+z' : '-z'})`, () => {
      const p = v3(0, 1.1, -dir * 1.2);
      const v = v3(0, 0.5, dir * 8);
      const yNone = fly(ball(p, v), 0.3).p.y;
      const yBack = fly(ball(p, v, spec(-40)), 0.3).p.y;
      const yTop = fly(ball(p, v, spec(40)), 0.3).p.y;
      expect(yBack).toBeGreaterThan(yNone + 0.03);
      expect(yTop).toBeLessThan(yNone - 0.03);
    });

    it(`sidespin + curves to the right of travel (travel ${dir > 0 ? '+z' : '-z'})`, () => {
      const v = v3(0, 0.5, dir * 8);
      const right = cross(normalize(v3(v.x, 0, v.z)), UP);
      const end = fly(ball(v3(0, 1, 0), v, spec(0, 40)), 0.3);
      expect(dot(end.p, right)).toBeGreaterThan(0.03);
      const endL = fly(ball(v3(0, 1, 0), v, spec(0, -40)), 0.3);
      expect(dot(endL.p, right)).toBeLessThan(-0.03);
    });
  }

  it('sidespin curves right of travel for a diagonal flight direction too', () => {
    const v = v3(3, 0.5, -7);
    const right = cross(normalize(v3(v.x, 0, v.z)), UP);
    const ref = fly(ball(v3(), v), 0.3);
    const side = fly(ball(v3(), v, spec(0, 40)), 0.3);
    expect(dot(sub(side.p, ref.p), right)).toBeGreaterThan(0.03);
  });

  it('pure corkscrew (w parallel to v) has no Magnus force', () => {
    const v = v3(0, 0, 8);
    const m = magnusAccel(v, spinVector(spec(0, 0, 50), v));
    expect(len(m)).toBeLessThan(1e-9);
  });

  it('Magnus uses only the spin component perpendicular to v (corkscrew adds no lift)', () => {
    const v = v3(0, 0, 8);
    const small = magnusAccel(v, spinVector(spec(2), v));
    const withCork = magnusAccel(v, spinVector(spec(2, 0, 50), v));
    expect(len(withCork)).toBeCloseTo(len(small), 6);
  });
});

// ───────────────────────────── 2. table bounce

describe('2. table bounce', () => {
  const vin = v3(0, -3, 6);
  const at = v3(0, TABLE_Y + BALL_RADIUS, 0.5);
  const none = tableHit(ball(at, vin));
  const top = tableHit(ball(at, vin, spec(40)));
  const back = tableHit(ball(at, vin, spec(-40)));

  it('topspin kicks forward and lower; backspin checks up', () => {
    expect(top.v.z).toBeGreaterThan(none.v.z + 0.1);
    // Coulomb physics: when BOTH balls slide through the whole contact the friction impulse is
    // mu*Jn regardless of spin, so a backspin ball leaves with the same linear velocity as a
    // no-spin one (only its spin differs). Backspin checks up relative to no-spin when the
    // no-spin ball would grip (steeper / slower incoming ball, e.g. pushes and short balls).
    expect(back.v.z).toBeLessThanOrEqual(none.v.z + 1e-12);
    const slow = v3(0, -3, 3);
    const noneS = tableHit(ball(at, slow));
    const backS = tableHit(ball(at, slow, spec(-40)));
    expect(backS.v.z).toBeLessThan(noneS.v.z - 0.1);
    expect(Math.atan2(backS.v.y, backS.v.z)).toBeGreaterThan(Math.atan2(noneS.v.y, noneS.v.z));
    expect(spinComponents(back.w, back.v).topspin).toBeGreaterThan(-40); // backspin reduced
    const angle = (b: BallState) => Math.atan2(b.v.y, b.v.z);
    expect(angle(top)).toBeLessThan(angle(none));
    expect(angle(back)).toBeGreaterThanOrEqual(angle(none) - 1e-12);
    // a no-spin ball loses forward speed to friction and picks up topspin
    expect(none.v.z).toBeLessThan(vin.z);
    expect(spinComponents(none.w, none.v).topspin).toBeGreaterThan(0);
  });

  it('vertical speed ratio equals e', () => {
    for (const b of [none, top, back]) expect(b.v.y / -vin.y).toBeCloseTo(TABLE_RESTITUTION, 12);
  });

  it('pure sidespin gives no sideways kick, corkscrew does', () => {
    const side = tableHit(ball(at, vin, spec(0, 40)));
    expect(Math.abs(side.v.x)).toBeLessThan(1e-12);
    expect(side.w.y).toBeCloseTo(spinVector(spec(0, 40), vin).y, 12); // vertical spin untouched
    const cork = tableHit(ball(at, vin, spec(0, 0, 40)));
    // w = +wz z, contact point r = -R y: w x r = (+wz R, 0, 0) -> slips +x -> kicked -x
    expect(cork.v.x).toBeLessThan(-0.05);
  });

  it('an incoming slipping ball tends to rolling (exactly rolling when friction is not saturated)', () => {
    const slip = (b: BallState) => {
      const vc = add(b.v, cross(b.w, v3(0, -BALL_RADIUS, 0)));
      return Math.hypot(vc.x, vc.z);
    };
    const steep = ball(at, v3(0, -5, 2));
    const out = tableHit(steep);
    expect(slip(steep)).toBeGreaterThan(1);
    expect(slip(out)).toBeLessThan(1e-9);
    // shallow fast ball: friction saturates, slip reduces but stays the same direction
    const shallow = ball(at, v3(0, -1.5, 12));
    const out2 = tableHit(shallow);
    expect(slip(out2)).toBeLessThan(slip(shallow));
    expect(slip(out2)).toBeGreaterThan(0);
    const vcz = (b: BallState) => add(b.v, cross(b.w, v3(0, -BALL_RADIUS, 0))).z;
    expect(Math.sign(vcz(out2))).toBe(Math.sign(vcz(shallow)));
  });
});

// ───────────────────────────── 3. paddle

describe('3. paddle contact', () => {
  it('faceNormal convention: pitch + opens the face (+y), yaw + turns it to +x, unit length', () => {
    expect(faceNormal(0, 0).z).toBeCloseTo(-1, 12);
    expect(faceNormal(30, 0).y).toBeGreaterThan(0);
    expect(faceNormal(-30, 0).y).toBeLessThan(0);
    expect(faceNormal(0, 20).x).toBeGreaterThan(0);
    for (const [p, y] of [[0, 0], [45, 30], [-60, -40]]) expect(len(faceNormal(p, y))).toBeCloseTo(1, 12);
  });

  const at = v3(0, TABLE_Y + 0.25, 1.5);
  const vin = v3(0, 0, 7); // travelling toward the player
  const passive = (s: SpinSpec) =>
    surfaceContact(
      ball(at, vin, s),
      faceNormal(0, 0),
      v3(),
      PADDLE_RESTITUTION,
      PADDLE_FRICTION,
      PADDLE_TANGENTIAL_RESTITUTION,
    );
  const block = (s: SpinSpec): BallState => {
    const c: PaddleControl = { pitchDeg: 0, yawDeg: 0, stroke: 'block', strength: 0.5, x: 0, y: 0 };
    return hitWithPaddle(ball(at, vin, s), c);
  };

  for (const [name, hit] of [['stationary', passive], ['block', block]] as const) {
    it(`${name} vertical paddle: backspin leaves DOWN, topspin leaves UP vs no-spin`, () => {
      const n = hit(spec());
      const b = hit(spec(-40));
      const t = hit(spec(40));
      expect(n.v.z).toBeLessThan(0); // returned toward the opponent
      expect(Math.abs(n.v.y)).toBeLessThan(1e-9);
      expect(b.v.y).toBeLessThan(n.v.y - 0.5);
      expect(t.v.y).toBeGreaterThan(n.v.y + 0.5);
    });

    it(`${name} vertical paddle: sidespin deflects OPPOSITE to its in-flight curve`, () => {
      for (const s of [40, -40]) {
        const curve = fly(ball(at, vin, spec(0, s)), 0.2).p.x - fly(ball(at, vin), 0.2).p.x;
        const out = hit(spec(0, s));
        expect(Math.abs(curve)).toBeGreaterThan(0.01);
        expect(Math.abs(out.v.x)).toBeGreaterThan(0.3);
        expect(Math.sign(out.v.x)).toBe(-Math.sign(curve));
      }
    });
  }

  it('normal COR off a stationary paddle equals PADDLE_RESTITUTION', () => {
    const out = passive(spec(-30, 20));
    expect(-out.v.z / vin.z).toBeCloseTo(PADDLE_RESTITUTION, 12);
  });
});

// ───────────────────────────── 4. energy & momentum

describe('4. conservation laws', () => {
  it('surfaceContact never creates kinetic energy in the surface frame (randomized)', () => {
    const r = rng(42);
    let checked = 0;
    for (let i = 0; i < 20000; i++) {
      const n = randUnit(r);
      const surfVel = scale(randUnit(r), r() * 8);
      const b: BallState = {
        p: v3(),
        v: scale(randUnit(r), r() * 30),
        w: scale(randUnit(r), r() * 150 * RPS_TO_RAD),
      };
      const e = r();
      const mu = r() * 1.5;
      const et = r();
      const out = surfaceContact(b, n, surfVel, e, mu, et);
      const k0 = kineticEnergy(b, surfVel);
      const k1 = kineticEnergy(out, surfVel);
      expect(k1).toBeLessThanOrEqual(k0 * (1 + 1e-9) + 1e-15);
      // angular momentum about the contact point is conserved (impulse acts through it)
      const d = sub(Lc(out, n), Lc(b, n));
      expect(len(d)).toBeLessThanOrEqual(1e-9 * (len(Lc(b, n)) + 1e-9));
      if (dot(sub(b.v, surfVel), n) < 0) checked++;
    }
    expect(checked).toBeGreaterThan(5000);
  });

  it('e = 1, mu = 0: perfectly elastic and frictionless (KE, tangential momentum, spin conserved)', () => {
    const r = rng(7);
    for (let i = 0; i < 2000; i++) {
      const n = randUnit(r);
      const b: BallState = { p: v3(), v: scale(randUnit(r), 10), w: scale(randUnit(r), 300) };
      const out = surfaceContact(b, n, v3(), 1, 0, 0);
      expect(kineticEnergy(out)).toBeCloseTo(kineticEnergy(b), 12);
      const tang = (x: Vec3) => sub(x, scale(n, dot(x, n)));
      expect(len(sub(tang(out.v), tang(b.v)))).toBeLessThan(1e-9);
      expect(len(sub(out.w, b.w))).toBeLessThan(1e-9);
    }
  });

  it('grip with tangential restitution et reverses the slip to exactly -et*u when unsaturated', () => {
    const n = UP;
    const b: BallState = { p: v3(), v: v3(0, -6, 1), w: v3(0, 0, 0) };
    const out = surfaceContact(b, n, v3(), 0.8, 10, 0.4);
    const r = v3(0, -BALL_RADIUS, 0);
    const u0 = add(b.v, cross(b.w, r)).z;
    const u1 = add(out.v, cross(out.w, r)).z;
    expect(u1).toBeCloseTo(-0.4 * u0, 12);
  });

  it('separating balls are untouched', () => {
    const b = ball(v3(), v3(0, 2, 3), spec(30));
    const out = tableHit(b);
    expect(out).toEqual(b);
    expect(out).not.toBe(b);
  });

  it('flight: mechanical energy decreases monotonically (drag), Magnus does no work', () => {
    let b = ball(v3(0, 1.2, -1.3), v3(1, 2, 12), spec(50, 30, 20));
    const E = (s: BallState) => 0.5 * BALL_MASS * dot(s.v, s.v) + BALL_MASS * G * s.p.y;
    let prev = E(b);
    for (let i = 0; i < 1500; i++) {
      b = integrateFlight(b, 1e-3);
      const e = E(b);
      expect(e).toBeLessThan(prev);
      prev = e;
    }
    const r = rng(3);
    for (let i = 0; i < 1000; i++) {
      const v = scale(randUnit(r), 1 + r() * 30);
      const w = scale(randUnit(r), r() * 1000);
      expect(Math.abs(dot(magnusAccel(v, w), v))).toBeLessThan(1e-9 * (1 + len(magnusAccel(v, w)) * len(v)));
    }
  });
});

// ───────────────────────────── 5. magnitudes vs literature

describe('5. realism vs. literature', () => {
  it('terminal velocity of a 2.7 g, 40 mm ball is 8-9 m/s', () => {
    const vt = Math.sqrt(G / K_DRAG);
    expect(vt).toBeGreaterThan(8);
    expect(vt).toBeLessThan(9);
    const fall = fly({ p: v3(0, 100, 0), v: v3(), w: v3() }, 10);
    expect(-fall.v.y).toBeCloseTo(vt, 2);
  });

  it('lift coefficient is 0.2-0.4 for spin ratio 0.3-0.5 and grows with spin ratio', () => {
    const v = v3(0, 0, 10);
    const cl = (S: number) => {
      const w = v3((S * 10) / BALL_RADIUS, 0, 0);
      return (len(magnusAccel(v, w)) * BALL_MASS) / (0.5 * AIR_DENSITY * BALL_AREA * 100);
    };
    for (const S of [0.3, 0.4, 0.5]) {
      expect(cl(S)).toBeGreaterThanOrEqual(0.2);
      expect(cl(S)).toBeLessThanOrEqual(0.4 + 1e-9);
    }
    expect(cl(0.5)).toBeGreaterThan(cl(0.3));
  });

  it('table/paddle coefficients are in the published ranges', () => {
    expect(TABLE_RESTITUTION).toBeGreaterThanOrEqual(0.88);
    expect(TABLE_RESTITUTION).toBeLessThanOrEqual(0.93);
    expect(TABLE_FRICTION).toBeGreaterThanOrEqual(0.2);
    expect(TABLE_FRICTION).toBeLessThanOrEqual(0.3);
    expect(PADDLE_RESTITUTION).toBeGreaterThanOrEqual(0.75);
    expect(PADDLE_RESTITUTION).toBeLessThanOrEqual(0.88);
  });

  it('ITTF drop test: dropped from 30.5 cm the ball bounces to 23-26 cm', () => {
    const start: BallState = { p: v3(0, TABLE_Y + 0.305 + BALL_RADIUS, 0.3), v: v3(), w: v3() };
    const { states, events } = world(start, 0.9);
    expect(events.filter((e) => e.kind === 'table').length).toBeGreaterThanOrEqual(1);
    const firstBounce = states.findIndex((s, i) => i > 0 && s.v.y > 0);
    let apex = 0;
    for (let i = firstBounce; i < states.length && states[i].v.y > 0; i++) apex = Math.max(apex, states[i].p.y);
    const h = apex - BALL_RADIUS - TABLE_Y;
    expect(h).toBeGreaterThanOrEqual(0.23);
    expect(h).toBeLessThanOrEqual(0.26);
  });

  it('spin decays only a few % per second in flight', () => {
    expect(SPIN_DECAY).toBeGreaterThan(0);
    expect(1 - Math.exp(-SPIN_DECAY)).toBeLessThan(0.1);
  });
});

// ───────────────────────────── 6. integrator & world

describe('6. integrator and collision detection', () => {
  const rally = ball(v3(0.1, TABLE_Y + 0.3, -1.5), v3(-0.5, 2.0, 8), spec(45, 15, 10));

  it('free flight converges: dt 1 ms vs 0.25 ms differ < 2 mm over 1 s', () => {
    const a = fly(rally, 1, 1e-3);
    const b = fly(rally, 1, 2.5e-4);
    expect(len(sub(a.p, b.p))).toBeLessThan(0.002);
  });

  it('through a table bounce, dt 1 ms vs 0.25 ms stay within a few mm', () => {
    const a = world(rally, 0.6, 1e-3);
    const b = world(rally, 0.6, 2.5e-4);
    expect(a.events[0].kind).toBe('table');
    expect(b.events[0].kind).toBe('table');
    expect(len(sub(a.events[0].p, b.events[0].p))).toBeLessThan(0.002);
    expect(len(sub(a.b.p, b.b.p))).toBeLessThan(0.002);
  });

  it('is deterministic', () => {
    const a = world(rally, 1.5);
    const b = world(rally, 1.5);
    expect(a.b).toEqual(b.b);
    expect(a.events).toEqual(b.events);
  });

  it('net does not tunnel at 25 m/s', () => {
    for (const x of [0, 0.5, -0.85]) {
      const start = ball(v3(x, TABLE_Y + 0.08, -0.7), v3(0, 0, 25));
      const { events, b } = world(start, 0.2);
      expect(events.some((e) => e.kind === 'net')).toBe(true);
      expect(b.p.z).toBeLessThan(0); // stays on the hitter's side
    }
    // just over the net clears it
    const over = ball(v3(0, TABLE_Y + NET_HEIGHT + BALL_RADIUS + 0.01, -0.7), v3(0, 0, 25));
    expect(world(over, 0.05).events.some((e) => e.kind === 'net')).toBe(false);
  });

  it('table bounce is detected for very fast and very grazing balls', () => {
    const fast = ball(v3(0, TABLE_Y + 0.3, -1.2), v3(0, -12, 25), spec(60));
    const f = world(fast, 0.1);
    expect(f.events[0]?.kind).toBe('table');
    expect(f.b.p.y).toBeGreaterThan(TABLE_Y + BALL_RADIUS - 1e-9);
    const graze = ball(v3(0, TABLE_Y + BALL_RADIUS + 0.002, 0.1), v3(0, -0.05, 6));
    const g = world(graze, 0.15);
    expect(g.events[0]?.kind).toBe('table');
    for (const s of g.states) expect(s.p.y).toBeGreaterThan(TABLE_Y + BALL_RADIUS - 1e-6);
  });

  it('a ball resting/dribbling on the table never falls through it', () => {
    const start: BallState = { p: v3(0, TABLE_Y + BALL_RADIUS + 0.001, 0.4), v: v3(), w: v3() };
    const { states } = world(start, 2);
    for (const s of states) expect(s.p.y).toBeGreaterThan(TABLE_Y + BALL_RADIUS - 1e-3);
  });

  it('off the end / beside the table the ball falls to the floor', () => {
    const offEnd = ball(v3(0, TABLE_Y + 0.2, TABLE_HALF_LENGTH + 0.05), v3(0, 0, 1));
    const a = world(offEnd, 1);
    expect(a.events.some((e) => e.kind === 'table')).toBe(false);
    expect(a.events.some((e) => e.kind === 'floor')).toBe(true);
    const onEdge = ball(v3(TABLE_HALF_WIDTH - 0.005, TABLE_Y + 0.2, 0.5), v3());
    expect(world(onEdge, 0.5).events[0]?.kind).toBe('table');
    const offSide = ball(v3(TABLE_HALF_WIDTH + 0.005, TABLE_Y + 0.2, 0.5), v3());
    expect(world(offSide, 1).events[0]?.kind).toBe('floor');
  });

  it('floor bounce dissipates energy and keeps the ball above the floor', () => {
    const start = ball(v3(0, 0.5, 3), v3(0, 0, 1));
    const { states, events } = world(start, 2);
    expect(events[0].kind).toBe('floor');
    for (const s of states) expect(s.p.y).toBeGreaterThan(BALL_RADIUS - 1e-3);
  });
});

describe('6b. predictIncoming / simulateReturn sanity', () => {
  it('flat 20 m/s hit 1 m above the table goes long', () => {
    const r = simulateReturn(ball(v3(0, TABLE_Y + 1, TABLE_HALF_LENGTH), v3(0, 0, -20)));
    expect(r.outcome).toBe('long');
  });

  it('a ball driven down from low near the net hits the net', () => {
    const r = simulateReturn(ball(v3(0, TABLE_Y + 0.2, 0.6), v3(0, -0.3, -10)));
    expect(r.outcome).toBe('net');
    expect(r.netClearance).toBeLessThan(0);
  });

  it('a sensible topspin drive lands in', () => {
    const v = v3(0, 1.8, -9);
    const r = simulateReturn(ball(v3(0, TABLE_Y + 0.25, TABLE_HALF_LENGTH + 0.2), v, spec(40)));
    expect(r.outcome).toBe('in');
    expect(r.landing!.z).toBeLessThan(0);
    expect(r.landing!.z).toBeGreaterThan(-TABLE_HALF_LENGTH);
    expect(r.netClearance).toBeGreaterThan(0);
  });

  it('a hit straight into own half is own-side; a weak lob that never reaches the net is short', () => {
    expect(simulateReturn(ball(v3(0, TABLE_Y + 0.3, 1), v3(0, -3, -3))).outcome).toBe('own-side');
    expect(simulateReturn(ball(v3(0, TABLE_Y + 0.3, TABLE_HALF_LENGTH + 0.25), v3(0, 1, -0.2))).outcome).toBe('short');
  });

  it('a medium rally ball from the opponent is valid and taken after a bounce on the player half', () => {
    const p = predictIncoming(ball(v3(0, TABLE_Y + 0.22, -1.6), v3(0, 2.0, 8.5), spec(20)), 'rally');
    expect(p.valid).toBe(true);
    expect(p.playerBounce!.z).toBeGreaterThan(0);
    expect(p.netClearance).toBeGreaterThan(0);
    // taken at the top of the bounce, or when it passes CONTACT_MAX_Z
    expect(p.contactState.v.y <= 0.02 || p.contactState.p.z >= TABLE_HALF_LENGTH + 0.3).toBe(true);
    expect(p.contactState.p.y - TABLE_Y).toBeGreaterThan(0.04);
  });

  it('a rally ball bouncing on its own half is rejected; one into the net too', () => {
    expect(predictIncoming(ball(v3(0, TABLE_Y + 0.25, -1.2), v3(0, -3, 3)), 'rally').reason).toBe('bounced-own-side');
    const intoNet = predictIncoming(ball(v3(0, TABLE_Y + 0.1, -0.6), v3(0, 0, 10)), 'rally');
    expect(intoNet.reason).toBe('net');
    expect(intoNet.netClearance).toBeLessThan(0);
  });
});
