import { describe, expect, it } from 'vitest';
import type { BallState } from '../src/physics/ball';
import { predictIncoming, simulateReturn } from '../src/physics/trajectory';
import { spinVector } from '../src/physics/spin';
import { hitWithPaddle, PITCH_LIMITS, YAW_LIMITS, StrokeType } from '../src/game/playerStroke';
import { LOB_CLEARANCE, analyzeReturn, findAngleWindow, probe, sidespinDrift, strokeFit } from '../src/game/coach';
import { PRESETS, planShot } from '../src/game/shots';
import { spinComponents } from '../src/physics/spin';

/**
 * Build a valid incoming rally ball from the opponent's end with the given spin (rps) and
 * forward pace, choosing the launch elevation whose first bounce lands closest to `bounceZ`.
 */
function makeBall(topspin: number, sidespin: number, vz: number, bounceZ = 0.6): BallState {
  let best: { s: number; c: BallState } | null = null;
  for (let vy = -1; vy <= 3; vy += 0.02) {
    const v = { x: 0, y: vy, z: vz };
    const inc = predictIncoming({ p: { x: 0, y: 0.98, z: -1.6 }, v, w: spinVector({ topspin, sidespin, corkscrew: 0 }, v) }, 'rally');
    if (!inc.valid || inc.contactState.p.z > 1.6) continue;
    const s = Math.abs(inc.playerBounce!.z - bounceZ);
    if (!best || s < best.s) best = { s, c: inc.contactState };
  }
  if (!best) throw new Error(`no valid launch for top=${topspin} side=${sidespin} vz=${vz}`);
  return best.c;
}

const ctl = (pitchDeg: number, yawDeg: number, stroke: StrokeType = 'block', strength = 0.5) => ({
  pitchDeg,
  yawDeg,
  stroke,
  strength,
  x: 0,
  y: 0,
});

const replay = (c: BallState, stroke: StrokeType, strength: number, pitch: number, yaw: number) =>
  simulateReturn(hitWithPaddle(c, ctl(pitch, yaw, stroke, strength)), 5);

const BALLS: { name: string; top: number; side: number; vz: number }[] = [
  { name: 'heavy backspin, slow', top: -40, side: 0, vz: 6 },
  { name: 'backspin, fast', top: -25, side: 0, vz: 7 },
  { name: 'no spin, slow', top: 0, side: 0, vz: 6 },
  { name: 'no spin, fast', top: 0, side: 0, vz: 9 },
  { name: 'topspin, slow', top: 30, side: 0, vz: 6 },
  { name: 'heavy topspin, fast', top: 40, side: 0, vz: 9 },
  { name: 'left sidespin', top: 0, side: 30, vz: 7 },
  { name: 'right sidespin', top: 0, side: -30, vz: 7 },
  { name: 'side-backspin', top: -20, side: 25, vz: 7 },
  { name: 'side-topspin', top: 25, side: 25, vz: 8 },
];

describe('coach probe', () => {
  it('gives the same in / not-in verdict as simulateReturn', () => {
    for (const b of [BALLS[0], BALLS[4], BALLS[6]]) {
      const c = makeBall(b.top, b.side, b.vz);
      for (const stroke of ['block', 'push', 'drive', 'chop'] as StrokeType[]) {
        for (let p = PITCH_LIMITS.min; p <= PITCH_LIMITS.max; p += 7.5) {
          for (let y = YAW_LIMITS.min; y <= YAW_LIMITS.max; y += 15) {
            const exact = simulateReturn(hitWithPaddle(c, ctl(p, y, stroke)), 1000).outcome === 'in';
            expect(probe(c, stroke, 0.5, p, y).outcome === 'in', `${b.name} ${stroke} ${p}/${y}`).toBe(exact);
          }
        }
      }
    }
  });
});

describe('findAngleWindow', () => {
  for (const b of BALLS) {
    it(`finds a block or push window that replays 'in': ${b.name}`, () => {
      const c = makeBall(b.top, b.side, b.vz);
      let found = false;
      for (const stroke of ['block', 'push'] as StrokeType[]) {
        for (const strength of [0.5, 0.9]) {
          const w = findAngleWindow(c, stroke, strength);
          if (!w) continue;
          found = true;
          expect(w.pitchMin).toBeLessThanOrEqual(w.bestPitch);
          expect(w.pitchMax).toBeGreaterThanOrEqual(w.bestPitch);
          expect(w.yawMin).toBeLessThanOrEqual(w.bestYaw);
          expect(w.yawMax).toBeGreaterThanOrEqual(w.bestYaw);
          expect(w.forgiveness).toBeGreaterThan(0);
          expect(w.forgiveness).toBeLessThanOrEqual(1);
          // the ghost paddle replays exactly
          const r = replay(c, stroke, strength, w.bestPitch, w.bestYaw);
          expect(r.outcome).toBe('in');
          expect(r.netClearance!).toBeGreaterThan(0);
          // window edges also pass
          expect(replay(c, stroke, strength, w.pitchMin, w.bestYaw).outcome).toBe('in');
          expect(replay(c, stroke, strength, w.pitchMax, w.bestYaw).outcome).toBe('in');
          expect(replay(c, stroke, strength, w.bestPitch, w.yawMin).outcome).toBe('in');
          expect(replay(c, stroke, strength, w.bestPitch, w.yawMax).outcome).toBe('in');
        }
      }
      expect(found).toBe(true);
    });
  }

  it('backspin needs a more open face than no-spin, which needs more than topspin', () => {
    for (const vz of [6, 7]) {
      const pitch = (top: number) => {
        const w = findAngleWindow(makeBall(top, 0, vz, 0.5), 'block', 0.9);
        expect(w, `block window for top=${top} vz=${vz}`).not.toBeNull();
        return w!.bestPitch;
      };
      const back = pitch(-40), none = pitch(0), top = pitch(40);
      console.log(`[coach] block@0.9 vz=${vz}: backspin ${back}°, no-spin ${none}°, topspin ${top}°`);
      expect(back).toBeGreaterThan(none);
      expect(none).toBeGreaterThan(top);
    }
  });

  it('aims against the sideways push of sidespin', () => {
    for (const side of [30, -30, 20, -20]) {
      for (const vz of [6, 8]) {
        const c = makeBall(0, side, vz);
        const w = findAngleWindow(c, 'block', 0.5)!;
        expect(w).not.toBeNull();
        // same ball without its sidespin component: the yaw shift must oppose the drift
        const noSide: BallState = { p: c.p, v: c.v, w: { x: c.w.x, y: 0, z: c.w.z } };
        const w0 = findAngleWindow(noSide, 'block', 0.5)!;
        const drift = sidespinDrift(c, 'block', 0.5, w.bestPitch);
        console.log(`[coach] side=${side} vz=${vz}: drift ${(drift * 100).toFixed(0)} cm, yaw ${w.bestYaw}° (no-side ${w0.bestYaw}°)`);
        expect(Math.abs(drift)).toBeGreaterThan(0.03);
        expect(Math.sign(w.bestYaw - w0.bestYaw)).toBe(-Math.sign(drift));
      }
    }
  });

  it('returns null when nothing can pass', () => {
    const c = makeBall(-40, 0, 6, 0.9);
    // a weak block of heavy backspin taken deep never gets back over
    expect(findAngleWindow(c, 'block', 0.2)).toBeNull();
  });

  it('runs in < 150 ms', () => {
    const balls = BALLS.map((b) => makeBall(b.top, b.side, b.vz));
    findAngleWindow(balls[0], 'block', 0.5); // warm up the JIT
    let worst = 0;
    let total = 0;
    let n = 0;
    for (const c of balls) {
      for (const stroke of ['block', 'push', 'drive', 'chop'] as StrokeType[]) {
        const t0 = performance.now();
        findAngleWindow(c, stroke, 0.5);
        const dt = performance.now() - t0;
        worst = Math.max(worst, dt);
        total += dt;
        n++;
      }
    }
    console.log(`[coach] findAngleWindow: mean ${(total / n).toFixed(1)} ms, worst ${worst.toFixed(1)} ms`);
    expect(total / n).toBeLessThan(100);
    expect(worst).toBeLessThan(200);
  });
});

describe('analyzeReturn', () => {
  it('reports errors consistent with the ideal and gives tips', () => {
    const c = makeBall(-40, 0, 6, 0.5);
    const control = ctl(0, 0, 'block', 0.9);
    const actual = simulateReturn(hitWithPaddle(c, control), 5);
    const rep = analyzeReturn(c, control, actual);
    console.log('[coach] heavy backspin, square block:', rep.headline, '|', rep.tips.join(' / '));
    expect(rep.outcome).toBe(actual.outcome);
    expect(rep.outcome).not.toBe('in');
    expect(rep.ideal).not.toBeNull();
    expect(rep.pitchError).toBeCloseTo(0 - rep.ideal!.bestPitch, 6);
    expect(rep.yawError).toBeCloseTo(0 - rep.ideal!.bestYaw, 6);
    expect(rep.pitchError!).toBeLessThan(0); // too closed for backspin
    expect(rep.tips.length).toBeGreaterThanOrEqual(1);
    expect(rep.tips.length).toBeLessThanOrEqual(3);
    expect(rep.tips.join(' ')).toMatch(/too closed/);
    expect(rep.idealPath!.length).toBeGreaterThan(10);
    expect(rep.headline.length).toBeGreaterThan(0);
  });

  it('praises a return at the ideal angle', () => {
    const c = makeBall(0, 0, 6);
    const w = findAngleWindow(c, 'block', 0.5)!;
    const control = ctl(w.bestPitch, w.bestYaw);
    const rep = analyzeReturn(c, control, simulateReturn(hitWithPaddle(c, control), 5));
    expect(rep.outcome).toBe('in');
    expect(rep.pitchError).toBe(0);
    expect(rep.yawError).toBe(0);
    expect(rep.headline).toMatch(/^In/);
  });

  it('mentions sidespin and the aim for a sidespin ball', () => {
    const c = makeBall(0, 30, 7);
    const control = ctl(0, 0);
    const rep = analyzeReturn(c, control, simulateReturn(hitWithPaddle(c, control), 5));
    console.log('[coach] left sidespin, square block:', rep.headline, '|', rep.tips.join(' / '));
    expect(rep.tips.join(' ')).toMatch(/sidespin/i);
  });

  it('suggests another stroke when the chosen one cannot work', () => {
    const c = makeBall(-40, 0, 6, 0.9);
    const control = ctl(0, 0, 'block', 0.2);
    const rep = analyzeReturn(c, control, simulateReturn(hitWithPaddle(c, control), 5));
    console.log('[coach] weak block of deep heavy backspin:', rep.headline, '|', rep.tips.join(' / '), rep.suggestedStroke);
    expect(rep.ideal).toBeNull();
    expect(rep.suggestedStroke).toBeDefined();
    expect(rep.suggestedWindow).toBeDefined();
    expect(rep.pitchError).toBeUndefined();
    expect(rep.idealPath).toBeDefined();
    const sw = rep.suggestedWindow!;
    expect(replay(c, rep.suggestedStroke!, 0.5, sw.bestPitch, sw.bestYaw).outcome).toBe('in');
  });

  it('handles a missed ball', () => {
    const c = makeBall(30, 0, 6);
    const rep = analyzeReturn(c, ctl(0, 0), null);
    expect(rep.outcome as string).toBe('miss');
    expect(rep.headline).toMatch(/Missed/);
    expect(rep.tips.length).toBeGreaterThan(0);
  });
});

describe('realistic recommendations', () => {
  const contactOf = (id: string) => planShot(PRESETS.find((p) => p.id === id)!.spec)!.incoming.contactState;
  const outSpin = (c: BallState, stroke: StrokeType, st: number, pitch: number, yaw: number) => {
    const o = hitWithPaddle(c, ctl(pitch, yaw, stroke, st));
    return spinComponents(o.w, o.v).topspin;
  };

  it('never recommends a high lob when a controlled return exists', () => {
    // these used to come out as 1.5-3 m lobs (e.g. a +78 deg "drive" against a chop)
    for (const id of ['heavy-chop', 'float-serve', 'backspin-push', 'heavy-topspin-loop', 'pendulum-side-backspin']) {
      const c = contactOf(id);
      for (const stroke of ['block', 'drive', 'chop'] as StrokeType[])
        for (const st of [0.3, 0.6, 0.9]) {
          const w = findAngleWindow(c, stroke, st);
          if (!w) continue;
          const r = replay(c, stroke, st, w.bestPitch, w.bestYaw);
          expect(r.outcome, `${id} ${stroke}@${st}`).toBe('in');
          expect(r.netClearance!, `${id} ${stroke}@${st} pitch ${w.bestPitch}`).toBeLessThanOrEqual(LOB_CLEARANCE);
        }
    }
  });

  it('push vs a short heavy backspin serve: open face, low over the net', () => {
    const c = contactOf('heavy-backspin-short-serve');
    expect(spinComponents(c.w, c.v).topspin).toBeLessThan(-20); // still heavy backspin on arrival
    const w = findAngleWindow(c, 'push', 0.6)!;
    expect(w.bestPitch).toBeGreaterThan(30);
    expect(w.bestPitch).toBeLessThan(55);
    expect(replay(c, 'push', 0.6, w.bestPitch, w.bestYaw).netClearance!).toBeLessThan(0.3);
  });

  it('loop vs topspin closes the face; loop vs backspin is about vertical; both make real topspin', () => {
    for (const st of [0.3, 0.6, 0.9]) {
      const top = contactOf('topspin-loop');
      const wt = findAngleWindow(top, 'drive', st)!;
      expect(wt.bestPitch).toBeLessThan(-12);
      expect(outSpin(top, 'drive', st, wt.bestPitch, wt.bestYaw)).toBeGreaterThan(20);
      const back = contactOf('heavy-chop');
      const wb = findAngleWindow(back, 'drive', st)!;
      expect(Math.abs(wb.bestPitch)).toBeLessThan(15);
      expect(outSpin(back, 'drive', st, wb.bestPitch, wb.bestYaw)).toBeGreaterThan(25);
    }
  });

  it('block vs a loop is closed', () => {
    for (const id of ['topspin-loop', 'heavy-topspin-loop', 'fast-topspin']) {
      const w = findAngleWindow(contactOf(id), 'block', 0.6)!;
      expect(w.bestPitch, id).toBeLessThan(-5);
      expect(w.bestPitch, id).toBeGreaterThan(-35);
    }
  });

  it('chop vs a loop is an open, slicing face', () => {
    const w = findAngleWindow(contactOf('topspin-loop'), 'chop', 0.6)!;
    expect(w.bestPitch).toBeGreaterThan(5);
  });

  it('flags a return that only lands as a lob', () => {
    const c = contactOf('heavy-chop');
    const control = ctl(78, 0, 'drive', 0.6);
    const actual = simulateReturn(hitWithPaddle(c, control), 5);
    if (actual.outcome !== 'in' || actual.netClearance! <= LOB_CLEARANCE) return; // physics changed; nothing to check
    const rep = analyzeReturn(c, control, actual);
    expect(rep.headline).toMatch(/lob/);
    expect(rep.tips.join(' ')).toMatch(/lob/);
  });

  it('stroke fit: never pushes a loop or chops over the table when better strokes exist', () => {
    const serve = contactOf('heavy-backspin-short-serve');
    const loop = contactOf('topspin-loop');
    const sp = (c: BallState) => spinComponents(c.w, c.v);
    expect(strokeFit('chop', sp(serve), serve)).toBeLessThan(0.3);
    expect(strokeFit('push', sp(serve), serve)).toBe(1);
    expect(strokeFit('push', sp(loop), loop)).toBeLessThan(strokeFit('block', sp(loop), loop));
    expect(strokeFit('chop', sp(loop), loop)).toBeLessThan(strokeFit('drive', sp(loop), loop));
  });
});

describe('coach wording matches the actual outcome', () => {
  it('never says "inside the window" / "spot on" for a ball that missed', async () => {
    const { PRESETS: P, planShot: plan } = await import('../src/game/shots');
    const { analyzeReturn: analyze } = await import('../src/game/coach');
    const { hitWithPaddle: hit } = await import('../src/game/playerStroke');
    const { simulateReturn: sim } = await import('../src/physics/trajectory');
    let checked = 0;
    for (const preset of P.slice(0, 6)) {
      const c = plan(preset.spec)!.incoming.contactState;
      for (const pitchDeg of [-30, -10, 0, 15, 35, 55]) {
        for (const yawDeg of [-12, 0, 12]) {
          const control = { pitchDeg, yawDeg, stroke: 'push' as const, strength: 0.5, x: 0, y: 0 };
          const actual = sim(hit(c, control));
          const r = analyze(c, control, actual);
          const text = [r.headline, ...r.tips].join(' ');
          if (actual.outcome !== 'in') {
            expect(text).not.toMatch(/inside the window|Spot on/);
            expect(r.headline).not.toMatch(/^In\b(?!to)/);
          } else expect(r.headline).toMatch(/^In[!\s]/);
          checked++;
        }
      }
    }
    expect(checked).toBe(108);
  }, 120000);
});

describe('QA round 3 regressions', () => {
  const contactOf = (id: string) => planShot(PRESETS.find((p) => p.id === id)!.spec)!.incoming.contactState;

  it('a face moving away from the ball never strikes it: coach reports a miss with the reason', async () => {
    const { paddleMeetsBall } = await import('../src/game/playerStroke');
    const c = contactOf('heavy-backspin-short-serve');
    const control = { pitchDeg: 75, yawDeg: 0, stroke: 'chop' as const, strength: 0.5, x: 0, y: 0 };
    expect(paddleMeetsBall(c, control)).toBe(false);
    expect(probe(c, 'chop', 0.5, 75, 0).outcome).not.toBe('in');
    const r = analyzeReturn(c, control, null);
    expect(r.headline).toMatch(/slipped past/);
  });

  it('suggests a firmer swing when the stroke only works at another strength (heavy chop)', () => {
    const c = contactOf('heavy-chop');
    const r = analyzeReturn(c, { pitchDeg: 0, yawDeg: 0, stroke: 'push', strength: 0.5, x: 0, y: 0 }, null);
    expect(r.ideal).toBeNull(); // no push angle works at 50% (the case being tested)
    {
      expect(r.suggestedStroke).toBeDefined();
      expect(r.suggestedStrength).toBeDefined();
      // replaying the suggestion lands in
      const after = hitWithPaddle(c, {
        pitchDeg: r.suggestedWindow!.bestPitch, yawDeg: r.suggestedWindow!.bestYaw,
        stroke: r.suggestedStroke!, strength: r.suggestedStrength!, x: 0, y: 0,
      });
      expect(simulateReturn(after).outcome).toBe('in');
    }
  }, 60000);

  it('never prints a negative zero angle', () => {
    for (const p of PRESETS.slice(0, 8)) {
      const c = planShot(p.spec)!.incoming.contactState;
      const control = { pitchDeg: 10, yawDeg: -0.3, stroke: 'block' as const, strength: 0.5, x: 0, y: 0 };
      const r = analyzeReturn(c, control, simulateReturn(hitWithPaddle(c, control)));
      expect([r.headline, ...r.tips].join(' ')).not.toMatch(/[−-]0°/);
    }
  }, 60000);
});
