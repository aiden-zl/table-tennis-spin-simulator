import { describe, expect, it, vi } from 'vitest';

// Sibling modules are being written in parallel: mock them so these tests are hermetic.
vi.mock('../src/game/coach', () => ({
  analyzeReturn: vi.fn((_c: unknown, _ctrl: unknown, actual: { outcome: string } | null) => ({
    outcome: actual ? actual.outcome : 'short',
    ideal: null,
    headline: actual ? `mock ${actual.outcome}` : 'mock miss',
    tips: [],
  })),
  findAngleWindow: vi.fn(() => null),
}));
vi.mock('../src/game/opponentSwing', () => ({
  buildOpponentSwing: vi.fn(),
  opponentReadyPose: (x: number) => ({ pos: { x, y: 0.95, z: -1.65 }, normal: { x: 0, y: 0, z: 1 }, up: { x: 0, y: 1, z: 0 } }),
}));

import { analyzeReturn } from '../src/game/coach';
import { RallyEngine, RallyEvent, paddleCovers } from '../src/game/rally';
import { controlNormal, hitWithPaddle, PaddleControl, StrokeType } from '../src/game/playerStroke';
import { predictIncoming, simulateReturn } from '../src/physics/trajectory';
import { spinVector } from '../src/physics/spin';
import { BALL_RADIUS, FLOOR_Y, SIM_DT, TABLE_Y } from '../src/physics/constants';
import type { OpponentSwing, RallyEngineOptions, RallyResult, ShotPlan } from '../src/contracts';
import type { BallState } from '../src/physics/ball';

function fakeSwing(launch: BallState, leadTime: number): OpponentSwing {
  return {
    poseAt: (t) => {
      // contract: poseAt is defined for every finite tRel (it clamps / recovers itself)
      if (!Number.isFinite(t)) throw new Error(`poseAt got ${t}`);
      return { pos: { x: launch.p.x, y: launch.p.y, z: launch.p.z - 0.05 + t * 0.1 }, normal: { x: 0, y: 0, z: 1 }, up: { x: 0, y: 1, z: 0 } };
    },
    contactVelocity: { x: 0, y: 0, z: 3 },
    contactNormal: { x: 0, y: 0, z: 1 },
    brushDir: { x: 0, y: 1, z: 0 },
    preContactBallAt: (t) => {
      if (t < -leadTime - 1e-9 || t > 1e-9) throw new Error(`preContactBallAt out of range ${t}`);
      return { x: launch.p.x, y: launch.p.y - t * 0.3, z: launch.p.z };
    },
    leadTime,
  };
}

function makePlan(topspin: number, vz: number, vy: number, leadTime = 0.8): ShotPlan {
  const v = { x: 0.1, y: vy, z: vz };
  const launch: BallState = { p: { x: 0, y: 0.95, z: -1.5 }, v, w: spinVector({ topspin, sidespin: 0, corkscrew: 0 }, v) };
  const incoming = predictIncoming(launch, 'rally');
  expect(incoming.valid).toBe(true);
  return {
    spec: { kind: 'rally', spin: { topspin, sidespin: 0, corkscrew: 0 }, pace: 'medium', target: { x: 0, z: 0.8 }, fromX: 0 },
    launch,
    incoming,
    swing: fakeSwing(launch, leadTime),
    name: 'test ball',
  };
}

const TOP = makePlan(20, 4.25, 2.5);
const BACK = makePlan(-20, 3.5, 2.25, 0.3);

const ctrl = (stroke: StrokeType, pitchDeg: number, extra: Partial<PaddleControl> = {}): PaddleControl => ({
  pitchDeg,
  yawDeg: 0,
  stroke,
  strength: 0.5,
  x: 0,
  y: 0,
  ...extra,
});

/** deterministic dt patterns */
function dtPattern(kind: 'fixed' | 'jitter' | 'huge'): () => number {
  if (kind === 'fixed') return () => 1 / 60;
  if (kind === 'huge') return () => 0.2;
  let s = 12345;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return 0.001 + (s / 2147483648) * 0.06;
  };
}

interface RunLog {
  events: RallyEvent[];
  phases: string[];
  contactSnapshotBall: BallState | null;
  resultBall: BallState | null;
  frozenUpdates: number;
}

function runRally(
  plan: ShotPlan,
  opts: RallyEngineOptions,
  control: PaddleControl,
  dt: () => number,
  frozenWait = 5,
): { log: RunLog; engine: RallyEngine } {
  const engine = new RallyEngine(opts);
  engine.setControl(control);
  engine.start(plan);
  const log: RunLog = { events: [], phases: [engine.snapshot().phase], contactSnapshotBall: null, resultBall: null, frozenUpdates: 0 };
  for (let i = 0; i < 5000; i++) {
    const evs = engine.update(dt());
    log.events.push(...evs);
    const snap = engine.snapshot();
    if (log.phases[log.phases.length - 1] !== snap.phase) log.phases.push(snap.phase);
    // every snapshot must be renderable
    expect(Number.isFinite(snap.ball.p.x + snap.ball.p.y + snap.ball.p.z)).toBe(true);
    expect(Number.isFinite(snap.playerPaddle.pos.x + snap.playerPaddle.pos.y + snap.playerPaddle.pos.z)).toBe(true);
    if (evs.some((e) => e.type === 'result')) {
      log.resultBall = snap.ball;
      break;
    }
    if (snap.phase === 'frozen') {
      log.frozenUpdates++;
      if (log.frozenUpdates >= frozenWait) engine.resume();
    }
  }
  return { log, engine };
}

const OPTS_RT: RallyEngineOptions = { controlMode: 'realtime', autoPosition: true, freezeLead: 0.25 };
const OPTS_FR: RallyEngineOptions = { controlMode: 'freeze', autoPosition: true, freezeLead: 0.25 };

describe('RallyEngine', () => {
  it('idle snapshot is valid before the first start', () => {
    const e = new RallyEngine(OPTS_RT);
    const s = e.snapshot();
    expect(s.phase).toBe('idle');
    expect(s.ballVisible).toBe(false);
    expect(s.plan).toBeNull();
    expect(s.result).toBeNull();
    expect(s.ball.p).toEqual({ x: 0, y: 0.95, z: -1.65 });
    expect(e.update(0.016)).toEqual([]);
  });

  for (const mode of ['realtime', 'freeze'] as const) {
    for (const autoPosition of [true, false]) {
      for (const pattern of ['fixed', 'jitter', 'huge'] as const) {
        it(`full rally: ${mode}, auto=${autoPosition}, dt=${pattern}`, () => {
          const control = ctrl('block', 0, { x: TOP.incoming.contactState.p.x + 0.03, y: TOP.incoming.contactState.p.y - 0.02 });
          const { log, engine } = runRally(TOP, { controlMode: mode, autoPosition, freezeLead: 0.25 }, control, dtPattern(pattern));
          const expected = mode === 'freeze'
            ? ['windup', 'incoming', 'frozen', 'incoming', 'returning', 'result']
            : ['windup', 'incoming', 'returning', 'result'];
          expect(log.phases).toEqual(expected);
          const types = log.events.map((e) => e.type);
          expect(types[0]).toBe('windup');
          expect(types[1]).toBe('launch');
          expect(types.filter((t) => t === 'contact')).toHaveLength(1);
          expect(types.filter((t) => t === 'result')).toHaveLength(1);
          expect(types.filter((t) => t === 'frozen')).toHaveLength(mode === 'freeze' ? 1 : 0);
          // incoming bounce on the player's half before contact
          const ci = types.indexOf('contact');
          expect(log.events.slice(0, ci).some((e) => e.type === 'bounce' && e.side === 'player')).toBe(true);

          const contact = log.events[ci] as Extract<RallyEvent, { type: 'contact' }>;
          expect(contact.result.contactState).toEqual(TOP.incoming.contactState);
          const afterHit = hitWithPaddle(TOP.incoming.contactState, control);
          const ret = simulateReturn(afterHit);
          expect(contact.result.afterHit).toEqual(afterHit);
          expect(contact.result.returnResult).toEqual(ret);
          expect(contact.result.outcome).toBe(ret.outcome);
          expect(ret.outcome).toBe('in');
          expect(contact.result.coach.headline).toBe('mock in');
          expect(engine.snapshot().result).toBe(contact.result);
          expect(engine.snapshot().phase).toBe('result');
        });
      }
    }
  }

  it('result snapshot is identical for every dt pattern (fixed-step determinism)', () => {
    const control = ctrl('drive', 0);
    const balls = (['fixed', 'jitter', 'huge'] as const).map((p) => runRally(TOP, OPTS_RT, control, dtPattern(p)).log.resultBall);
    expect(balls[0]).not.toBeNull();
    expect(balls[1]).toEqual(balls[0]);
    expect(balls[2]).toEqual(balls[0]);
  });

  it('the live returning ball reproduces simulateReturn outcomes (in / net / long / own-side)', () => {
    const seen = new Set<string>();
    const cases: [ShotPlan, PaddleControl][] = [
      [TOP, ctrl('block', 0)],
      [TOP, ctrl('chop', 0)],
      [TOP, ctrl('drive', 0)],
      [TOP, ctrl('block', -40)],
      [BACK, ctrl('block', 0)],
      [BACK, ctrl('push', 20)],
      [BACK, ctrl('drive', 0)],
      [BACK, ctrl('chop', 40)],
    ];
    for (const [plan, control] of cases) {
      const ret = simulateReturn(hitWithPaddle(plan.incoming.contactState, control));
      seen.add(ret.outcome);
      const { log } = runRally(plan, OPTS_RT, control, dtPattern('jitter'));
      const ci = log.events.findIndex((e) => e.type === 'contact');
      const post = log.events.slice(ci + 1).filter((e) => e.type === 'bounce' || e.type === 'net' || e.type === 'floor');
      const first = post[0];
      switch (ret.outcome) {
        case 'in':
          expect(first).toMatchObject({ type: 'bounce', side: 'opponent' });
          expect(first.type === 'bounce' && first.p).toEqual(ret.landing);
          break;
        case 'own-side':
          expect(first).toMatchObject({ type: 'bounce', side: 'player' });
          expect(first.type === 'bounce' && first.p).toEqual(ret.landing);
          break;
        case 'net':
          expect(first.type).toBe('net');
          expect(first.type === 'net' && first.p).toEqual(ret.landing);
          break;
        case 'long':
        case 'wide':
          expect(first.type).toBe('floor');
          break;
        case 'short':
          if (ret.landing) expect(first.type).toBe('floor');
          break;
      }
      // no event spam once settled
      expect(post.length).toBeLessThan(40);
    }
    expect(seen.has('in')).toBe(true);
    expect([...seen].filter((o) => o !== 'in').length).toBeGreaterThanOrEqual(2);
  });

  it('after the result the ball only comes to rest on the table or the floor (never mid-air)', () => {
    let sawLateNet = false;
    for (const plan of [TOP, BACK]) {
      for (const stroke of ['block', 'push', 'drive', 'chop'] as const) {
        for (const pitch of [-40, -20, 0, 20, 40]) {
          const e = new RallyEngine(OPTS_RT);
          e.setControl(ctrl(stroke, pitch));
          e.start(plan);
          const evs: RallyEvent[] = [];
          for (let i = 0; i < 400 && e.snapshot().phase !== 'result'; i++) evs.push(...e.update(0.05));
          expect(e.snapshot().phase).toBe('result');
          for (let i = 0; i < 80; i++) evs.push(...e.update(0.05));
          const ci = evs.findIndex((x) => x.type === 'contact');
          const post = evs.slice(ci + 1);
          const firstNet = post.findIndex((x) => x.type === 'net');
          const firstBounce = post.findIndex((x) => x.type === 'bounce' || x.type === 'floor');
          if (firstNet > 0 && firstBounce >= 0 && firstBounce < firstNet) sawLateNet = true;
          const b = e.snapshot().ball;
          if (b.v.x === 0 && b.v.y === 0 && b.v.z === 0) {
            const onTable = Math.abs(b.p.y - (TABLE_Y + BALL_RADIUS)) < 1e-6;
            const onFloor = Math.abs(b.p.y - (FLOOR_Y + BALL_RADIUS)) < 1e-6;
            expect(onTable || onFloor).toBe(true);
          }
          expect(post.length).toBeLessThan(60);
        }
      }
    }
    expect(sawLateNet).toBe(true);
  });

  it('freeze waits until resume() and lets the player change control while frozen', () => {
    const e = new RallyEngine(OPTS_FR);
    e.setControl(ctrl('chop', 0)); // would go into the net
    e.start(TOP);
    let evs: RallyEvent[] = [];
    for (let i = 0; i < 200 && e.snapshot().phase !== 'frozen'; i++) evs.push(...e.update(0.05));
    expect(e.snapshot().phase).toBe('frozen');
    expect(evs.filter((x) => x.type === 'frozen')).toHaveLength(1);
    const frozenBall = e.snapshot().ball;
    const freezeStep = TOP.incoming.contactIndex - Math.round(0.25 / SIM_DT);
    expect(frozenBall).toEqual(TOP.incoming.states[freezeStep]);
    expect(e.snapshot().tSinceLaunch).toBeCloseTo(freezeStep * SIM_DT, 9);
    for (let i = 0; i < 100; i++) expect(e.update(0.1)).toEqual([]);
    expect(e.snapshot().ball).toEqual(frozenBall);
    expect(e.snapshot().phase).toBe('frozen');
    const fixed = ctrl('block', 0);
    e.setControl(fixed);
    // paddle pose follows the control while frozen (aim is table-relative: 0 deg points at
    // the middle of the opponent's half from this ball's contact point)
    const want = controlNormal(fixed, TOP.incoming.contactState.p);
    const got = e.snapshot().playerPaddle.normal;
    expect(got.x).toBeCloseTo(want.x, 9);
    expect(got.y).toBeCloseTo(want.y, 9);
    expect(got.z).toBeCloseTo(want.z, 9);
    e.resume();
    expect(e.snapshot().phase).toBe('incoming');
    evs = [];
    for (let i = 0; i < 100 && !evs.some((x) => x.type === 'contact'); i++) evs.push(...e.update(0.05));
    const c = evs.find((x) => x.type === 'contact') as Extract<RallyEvent, { type: 'contact' }>;
    expect(c.result.control).toEqual(fixed);
    expect(c.result.outcome).toBe('in');
  });

  it('manual positioning: paddle away from the ball misses', () => {
    const cs = TOP.incoming.contactState.p;
    const control = ctrl('block', 0, { x: cs.x + 0.2, y: cs.y });
    for (const pattern of ['fixed', 'huge'] as const) {
      const { log } = runRally(TOP, { controlMode: 'realtime', autoPosition: false, freezeLead: 0.25 }, control, dtPattern(pattern));
      expect(log.phases).toEqual(['windup', 'incoming', 'returning', 'result']);
      const c = log.events.find((x) => x.type === 'contact') as Extract<RallyEvent, { type: 'contact' }>;
      expect(c.result.outcome).toBe('miss');
      expect(c.result.afterHit).toBeNull();
      expect(c.result.returnResult).toBeNull();
      expect(c.result.coach.headline).toBe('mock miss');
      // the ball carried on past the player
      expect(log.resultBall!.p.z).toBeGreaterThan(cs.z + 0.3);
    }
    expect(vi.mocked(analyzeReturn)).toHaveBeenCalledWith(TOP.incoming.contactState, control, null);
  });

  it('paddleCovers uses the blade ellipse plus ball radius', () => {
    const b = { x: 0, y: 1, z: 1 };
    expect(paddleCovers(ctrl('block', 0, { x: 0, y: 1 }), b)).toBe(true);
    expect(paddleCovers(ctrl('block', 0, { x: 0.094, y: 1 }), b)).toBe(true);
    expect(paddleCovers(ctrl('block', 0, { x: 0.096, y: 1 }), b)).toBe(false);
    expect(paddleCovers(ctrl('block', 0, { x: 0, y: 1.099 }), b)).toBe(true);
    expect(paddleCovers(ctrl('block', 0, { x: 0, y: 1.101 }), b)).toBe(false);
    expect(paddleCovers(ctrl('block', 0, { x: 0.07, y: 1.07 }), b)).toBe(false);
  });

  it('autoPosition switch applies immediately; controlMode switch applies from the next ball', () => {
    const cs = TOP.incoming.contactState.p;
    const e = new RallyEngine({ controlMode: 'realtime', autoPosition: false, freezeLead: 0.25 });
    e.setControl(ctrl('block', 0, { x: cs.x + 0.5, y: cs.y }));
    e.start(TOP);
    e.update(0.1);
    e.setOptions({ autoPosition: true, controlMode: 'freeze' });
    const evs: RallyEvent[] = [];
    for (let i = 0; i < 100 && !evs.some((x) => x.type === 'contact'); i++) evs.push(...e.update(0.1));
    expect(evs.some((x) => x.type === 'frozen')).toBe(false);
    const c = evs.find((x) => x.type === 'contact') as Extract<RallyEvent, { type: 'contact' }>;
    expect(c.result.outcome).toBe('in');
    e.start(TOP);
    const evs2: RallyEvent[] = [];
    for (let i = 0; i < 100 && e.snapshot().phase !== 'frozen'; i++) evs2.push(...e.update(0.1));
    expect(e.snapshot().phase).toBe('frozen');
  });

  it('control is copied (mutating the caller object does not change the result)', () => {
    const control = ctrl('block', 0);
    const { log } = runRally(TOP, OPTS_RT, control, dtPattern('huge'));
    const c = log.events.find((x) => x.type === 'contact') as Extract<RallyEvent, { type: 'contact' }>;
    control.pitchDeg = 50;
    expect(c.result.control.pitchDeg).toBe(0);
  });

  it('player paddle meets the ball at contact and the opponent swing stays in range', () => {
    const e = new RallyEngine(OPTS_RT);
    e.setControl(ctrl('drive', 10));
    e.start(TOP);
    const s0 = e.snapshot();
    expect(s0.phase).toBe('windup');
    expect(s0.ballVisible).toBe(true);
    expect(s0.tSinceLaunch).toBeCloseTo(-0.8, 9);
    let evs: RallyEvent[] = [];
    for (let i = 0; i < 200 && !evs.some((x) => x.type === 'contact'); i++) evs = e.update(0.013);
    const s = e.snapshot();
    // within one frame after contact the blade is close to the contact point
    const cs = TOP.incoming.contactState.p;
    const d = Math.hypot(s.playerPaddle.pos.x - cs.x, s.playerPaddle.pos.y - cs.y, s.playerPaddle.pos.z - cs.z);
    expect(d).toBeLessThan(0.15);
    // ran through without poseAt / preContactBallAt range errors (fakeSwing throws)
    for (let i = 0; i < 400; i++) e.update(0.05);
    expect(e.snapshot().phase).toBe('result');
  });

  it('reset returns to idle', () => {
    const e = new RallyEngine(OPTS_RT);
    e.start(BACK);
    e.update(0.1);
    e.reset();
    expect(e.snapshot().phase).toBe('idle');
    expect(e.snapshot().plan).toBeNull();
    expect(e.update(0.1)).toEqual([]);
  });

  it('ignores NaN / negative dt', () => {
    const e = new RallyEngine(OPTS_RT);
    e.start(TOP);
    e.update(NaN);
    e.update(-1);
    expect(e.snapshot().tSinceLaunch).toBeCloseTo(-0.8, 9);
  });
});

describe('RallyEngine.provideCoach', () => {
  it('uses a provided report instead of computing one, and ignores stale results', () => {
    const e = new RallyEngine(OPTS_RT);
    e.setControl(ctrl('drive', 10));
    e.start(TOP);
    let contact: RallyResult | null = null;
    for (let i = 0; i < 400 && !contact; i++) {
      for (const ev of e.update(0.01)) if (ev.type === 'contact') contact = ev.result;
    }
    expect(contact).not.toBeNull();
    const fake = { outcome: contact!.outcome, ideal: null, headline: 'from worker', tips: [] };
    e.provideCoach({ ...contact! }, { ...fake, headline: 'stale' }); // different object: ignored
    e.provideCoach(contact!, fake);
    let result: RallyResult | null = null;
    for (let i = 0; i < 800 && !result; i++) {
      for (const ev of e.update(0.01)) if (ev.type === 'result') result = ev.result;
    }
    expect(result!.coach.headline).toBe('from worker');
  });
});

describe('manual positioning draws the paddle where it will be hit-tested', () => {
  it('after the windup blend the paddle sits at (control.x, control.y) on the contact plane', () => {
    const e = new RallyEngine({ ...OPTS_RT, autoPosition: false });
    const c = ctrl('block', 0, { x: 0.21, y: TABLE_Y + 0.3 });
    e.setControl(c);
    e.start(TOP);
    e.update(0.35); // past the 0.3 s blend, still in the windup (lead 0.8 s)
    const s = e.snapshot();
    expect(s.phase).toBe('windup');
    expect(s.playerPaddle.pos.x).toBeCloseTo(0.21, 6);
    expect(s.playerPaddle.pos.y).toBeCloseTo(TABLE_Y + 0.3, 6);
    expect(s.playerPaddle.pos.z).toBeCloseTo(TOP.incoming.contactState.p.z, 6);
  });

  it('the player paddle does not jump when the next ball starts', () => {
    const e = new RallyEngine(OPTS_RT);
    e.setControl(ctrl('drive', 10));
    e.start(TOP);
    for (let i = 0; i < 600 && e.snapshot().phase !== 'result'; i++) e.update(0.01);
    const before = e.snapshot().playerPaddle.pos;
    e.start(TOP);
    const after = e.snapshot().playerPaddle.pos;
    expect(Math.hypot(after.x - before.x, after.y - before.y, after.z - before.z)).toBeLessThan(1e-9);
  });
});

describe('external (async) coach never blocks the result', () => {
  it('result is pending with a provisional report, then provideCoach fills it in', () => {
    const e = new RallyEngine(OPTS_RT);
    e.setExternalCoach(true);
    e.setControl(ctrl('drive', 10));
    e.start(TOP);
    let result: RallyResult | null = null;
    for (let i = 0; i < 1000 && !result; i++) for (const ev of e.update(0.01)) if (ev.type === 'result') result = ev.result;
    expect(result).not.toBeNull();
    expect(result!.coachPending).toBe(true);
    expect(result!.coach.ideal).toBeNull();
    const report = { outcome: result!.outcome, ideal: null, headline: 'late report', tips: [] };
    e.provideCoach(result!, report);
    expect(result!.coachPending).toBe(false);
    expect(result!.coach.headline).toBe('late report');
    // a second (stale) report for the same ball is ignored
    e.provideCoach(result!, { ...report, headline: 'again' });
    expect(result!.coach.headline).toBe('late report');
  });
});
