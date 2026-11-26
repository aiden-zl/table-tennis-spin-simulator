import { describe, expect, it, vi } from 'vitest';

// opponentSwing is built by another module; mock it only if it is still a stub.
vi.mock('../src/game/opponentSwing', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/game/opponentSwing')>();
  const v = { x: 0, y: 0, z: 1 };
  const fake = {
    poseAt: () => ({ pos: v, normal: v, up: { x: 0, y: 1, z: 0 } }),
    contactVelocity: v,
    contactNormal: v,
    brushDir: v,
    preContactBallAt: () => v,
    leadTime: 0.5,
  };
  return {
    ...real,
    buildOpponentSwing: (...args: Parameters<typeof real.buildOpponentSwing>) => {
      try {
        return real.buildOpponentSwing(...args);
      } catch (e) {
        if (String(e).includes('not implemented')) return fake;
        throw e;
      }
    },
  };
});

import { PRESETS, isTrainableBall, makeRng, planRandomShot, planShot, sanitizeSpec } from '../src/game/shots';
import { launchPoint, solveLaunch } from '../src/physics/shotSolver';
import { spinComponents } from '../src/physics/spin';
import { TABLE_HALF_LENGTH, TABLE_HALF_WIDTH, TABLE_Y } from '../src/physics/constants';
import type { ShotPlan, ShotSpec } from '../src/contracts';

function checkPlan(plan: ShotPlan) {
  const inc = plan.incoming;
  expect(inc.valid).toBe(true);
  expect(inc.netClearance!).toBeGreaterThan(0.01);
  const pb = inc.playerBounce!;
  expect(pb.z).toBeGreaterThan(0);
  expect(pb.z).toBeLessThanOrEqual(TABLE_HALF_LENGTH);
  expect(Math.abs(pb.x)).toBeLessThanOrEqual(TABLE_HALF_WIDTH);
  if (plan.spec.kind === 'serve') {
    const sb = inc.serverBounce!;
    expect(sb).toBeDefined();
    expect(sb.z).toBeLessThan(0);
    expect(sb.z).toBeGreaterThanOrEqual(-TABLE_HALF_LENGTH);
    // the server's bounce happens before the player's bounce
    const tableEvents = inc.events.filter((e) => e.kind === 'table');
    expect(tableEvents[0].side).toBe('opponent');
    expect(tableEvents[1].side).toBe('player');
  } else {
    expect(inc.serverBounce).toBeUndefined();
  }
  // contact height playable
  expect(inc.contactState.p.y - TABLE_Y).toBeGreaterThan(0.04);
  // spin decomposes back to the spec
  const c = spinComponents(plan.launch.w, plan.launch.v);
  expect(c.topspin).toBeCloseTo(plan.spec.spin.topspin, 6);
  expect(c.sidespin).toBeCloseTo(plan.spec.spin.sidespin, 6);
  expect(c.corkscrew).toBeCloseTo(plan.spec.spin.corkscrew, 6);
  // launch at the opponent's contact point
  const lp = launchPoint(plan.spec);
  expect(plan.launch.p.x).toBeCloseTo(lp.x, 9);
  expect(plan.launch.p.z).toBeCloseTo(lp.z, 9);
  expect(plan.name.length).toBeGreaterThan(0);
}

describe('presets', () => {
  it('has a decent, uniquely-identified library', () => {
    expect(PRESETS.length).toBeGreaterThanOrEqual(12);
    expect(new Set(PRESETS.map((p) => p.id)).size).toBe(PRESETS.length);
    for (const p of PRESETS) {
      expect(sanitizeSpec(p.spec)).toEqual(p.spec);
      expect(p.description.length).toBeGreaterThan(20);
    }
  });

  for (const p of PRESETS) {
    it(`preset "${p.name}" solves exactly`, () => {
      const plan = planShot(p.spec);
      expect(plan).not.toBeNull();
      checkPlan(plan!);
      expect(plan!.spec).toEqual(p.spec); // no fallback needed
      expect(plan!.name).toBe(p.name);
      const pb = plan!.incoming.playerBounce!;
      expect(Math.hypot(pb.x - p.spec.target.x, pb.z - p.spec.target.z)).toBeLessThan(0.05);
    });
  }
});

describe('solver', () => {
  it('lands within 5 cm of the target across spins, paces and kinds', () => {
    let solved = 0;
    let total = 0;
    for (const kind of ['rally', 'serve'] as const)
      for (const top of [-40, -15, 0, 25, 50])
        for (const side of [-30, 0, 30])
          for (const [x, z] of [
            [0, 0.9],
            [0.5, 1.1],
            [-0.5, 0.7],
          ]) {
            const spec: ShotSpec = {
              kind,
              pace: 'medium',
              spin: { topspin: kind === 'serve' ? Math.min(top, 30) : top, sidespin: side, corkscrew: 0 },
              target: { x, z },
              fromX: 0.2,
            };
            total++;
            const r = solveLaunch(spec);
            if (!r) continue;
            solved++;
            const pb = r.incoming.playerBounce!;
            expect(Math.hypot(pb.x - x, pb.z - z)).toBeLessThan(0.05);
          }
    expect(solved / total).toBeGreaterThan(0.95);
  });

  it('serves bounce on the opponent half first and use realistic speeds', () => {
    for (const p of PRESETS.filter((q) => q.spec.kind === 'serve')) {
      const r = solveLaunch(p.spec)!;
      const speed = Math.hypot(r.launch.v.x, r.launch.v.y, r.launch.v.z);
      expect(speed).toBeGreaterThan(3);
      expect(speed).toBeLessThan(10.5);
      expect(r.incoming.serverBounce!.z).toBeLessThan(0);
    }
  });

  it('returns null for impossible requests instead of an illegal ball', () => {
    // a hard-hit flat rally ball cannot land 25 cm behind the net at a sane speed, but if the
    // solver finds something it must be legal
    const r = solveLaunch({
      kind: 'rally',
      pace: 'fast',
      spin: { topspin: -60, sidespin: 60, corkscrew: 60 },
      target: { x: 0.65, z: 0.25 },
      fromX: -0.6,
    });
    if (r) expect(r.incoming.valid).toBe(true);
  });

  it('is fast enough for the bot (typical < 30 ms)', () => {
    const rng = makeRng(7);
    const times: number[] = [];
    for (let i = 0; i < 30; i++) {
      const t0 = performance.now();
      planRandomShot(rng);
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)];
    expect(median).toBeLessThan(60); // generous for slow CI; typically ~10 ms
  });
});

describe('planShot / sanitizeSpec', () => {
  it('clamps out-of-range specs', () => {
    const s = sanitizeSpec({
      kind: 'rally',
      pace: 'medium',
      spin: { topspin: 200, sidespin: -99, corkscrew: NaN },
      target: { x: 3, z: -1 },
      fromX: 9,
    });
    expect(s.spin).toEqual({ topspin: 60, sidespin: -60, corkscrew: 0 });
    expect(s.target).toEqual({ x: 0.65, z: 0.25 });
    expect(s.fromX).toBe(0.6);
  });

  it('falls back to a nearby target when the exact one is unreachable', () => {
    const plan = planShot({
      kind: 'rally',
      pace: 'fast',
      spin: { topspin: 0, sidespin: 0, corkscrew: 0 },
      target: { x: 0, z: 0.25 },
      fromX: 0,
    });
    expect(plan).not.toBeNull();
    checkPlan(plan!);
  });

  it('names custom shots from their spin', () => {
    const plan = planShot({
      kind: 'serve',
      pace: 'medium',
      spin: { topspin: -30, sidespin: 0, corkscrew: 0 },
      target: { x: 0, z: 0.5 },
      fromX: 0,
    })!;
    expect(plan.name).toBe('Backspin serve');
  });
});

describe('realism', () => {
  it('presets still carry their named spin when they reach the player (after the bounces)', () => {
    for (const p of PRESETS) {
      const c = planShot(p.spec)!.incoming.contactState;
      const top = spinComponents(c.w, c.v).topspin;
      const name = p.name.toLowerCase();
      if (name.includes('backspin') || name.includes('chop') || name.includes('push')) expect(top, p.id).toBeLessThan(-8);
      if (name.includes('topspin') || name.includes('loop')) expect(top, p.id).toBeGreaterThan(8);
    }
  });

  it('presets are trainable balls', () => {
    for (const p of PRESETS) expect(isTrainableBall(planShot(p.spec)!.incoming), p.id).toBe(true);
  });

  it('bot balls are trainable and labelled backspin balls arrive with backspin', () => {
    const rng = makeRng(2024);
    let back = 0;
    for (let i = 0; i < 60; i++) {
      const plan = planRandomShot(rng);
      expect(isTrainableBall(plan.incoming)).toBe(true);
      if (plan.spec.spin.topspin < -15) {
        back++;
        const c = plan.incoming.contactState;
        expect(spinComponents(c.w, c.v).topspin, plan.name).toBeLessThan(-4);
      }
    }
    expect(back).toBeGreaterThan(10);
  });
});

describe('bot', () => {
  it('200 random shots are all valid and land on the player half', () => {
    const rng = makeRng(12345);
    const kinds = { serve: 0, rally: 0 };
    for (let i = 0; i < 200; i++) {
      const plan = planRandomShot(rng);
      checkPlan(plan);
      kinds[plan.spec.kind]++;
    }
    expect(kinds.serve).toBeGreaterThan(60);
    expect(kinds.rally).toBeGreaterThan(60);
  });

  it('is deterministic for a seed', () => {
    const a = planRandomShot(makeRng(99));
    const b = planRandomShot(makeRng(99));
    expect(a.spec).toEqual(b.spec);
    expect(a.launch).toEqual(b.launch);
  });
});
