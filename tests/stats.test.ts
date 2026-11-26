import { describe, expect, it } from 'vitest';
import { Stats, StatsStorage, spinCategory, STATS_STORAGE_KEY } from '../src/game/stats';
import type { RallyResult, ShotPlan, SpinSpec } from '../src/contracts';

const plan = (spin: Partial<SpinSpec>): ShotPlan =>
  ({ spec: { kind: 'rally', spin: { topspin: 0, sidespin: 0, corkscrew: 0, ...spin }, pace: 'medium', target: { x: 0, z: 0.8 }, fromX: 0 } }) as unknown as ShotPlan;
const res = (outcome: RallyResult['outcome']): RallyResult => ({ outcome } as unknown as RallyResult);

class MemStorage implements StatsStorage {
  m = new Map<string, string>();
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
}

describe('spinCategory', () => {
  it('classifies the dominant spin', () => {
    expect(spinCategory({ topspin: 0, sidespin: 0, corkscrew: 0 })).toBe('nospin');
    expect(spinCategory({ topspin: 3, sidespin: -3, corkscrew: 5 })).toBe('nospin');
    expect(spinCategory({ topspin: 30, sidespin: 5, corkscrew: 0 })).toBe('topspin');
    expect(spinCategory({ topspin: -40, sidespin: 0, corkscrew: 0 })).toBe('backspin');
    expect(spinCategory({ topspin: 2, sidespin: 30, corkscrew: 0 })).toBe('sidespin');
    expect(spinCategory({ topspin: 20, sidespin: -25, corkscrew: 0 })).toBe('side-top');
    expect(spinCategory({ topspin: -20, sidespin: 20, corkscrew: 0 })).toBe('side-back');
    expect(spinCategory({ topspin: 5, sidespin: 0, corkscrew: 30 })).toBe('corkscrew');
  });
});

describe('Stats', () => {
  it('counts attempts, made, streaks, categories, recent', () => {
    const s = new Stats(null);
    const seq: RallyResult['outcome'][] = ['in', 'in', 'net', 'in', 'in', 'in', 'miss', 'long'];
    for (const o of seq) s.record(res(o), plan({ topspin: -30 }));
    s.record(res('in'), plan({ topspin: 30 }));
    const snap = s.snapshot();
    expect(snap.total).toEqual({ attempts: 9, made: 6 });
    expect(snap.streak).toBe(1);
    expect(snap.bestStreak).toBe(3);
    expect(snap.byCategory.backspin).toEqual({ attempts: 8, made: 5 });
    expect(snap.byCategory.topspin).toEqual({ attempts: 1, made: 1 });
    expect(snap.recent).toEqual([...seq, 'in']);
  });

  it('keeps only the last 20 outcomes, newest last', () => {
    const s = new Stats(null);
    for (let i = 0; i < 25; i++) s.record(res(i % 2 ? 'in' : 'net'), plan({}));
    const r = s.snapshot().recent;
    expect(r).toHaveLength(20);
    expect(r[19]).toBe('net'); // i = 24
    expect(s.snapshot().byCategory.nospin.attempts).toBe(25);
  });

  it('snapshot is a copy', () => {
    const s = new Stats(null);
    s.record(res('in'), plan({}));
    const a = s.snapshot();
    a.total.made = 99;
    a.recent.push('net');
    expect(s.snapshot().total.made).toBe(1);
    expect(s.snapshot().recent).toEqual(['in']);
  });

  it('persists to and loads from storage; reset clears', () => {
    const st = new MemStorage();
    const a = new Stats(st);
    a.record(res('in'), plan({ sidespin: 30 }));
    a.record(res('in'), plan({ sidespin: 30 }));
    expect(st.getItem(STATS_STORAGE_KEY)).toBeTruthy();
    const b = new Stats(st);
    expect(b.snapshot()).toEqual(a.snapshot());
    expect(b.snapshot().bestStreak).toBe(2);
    b.reset();
    expect(new Stats(st).snapshot().total.attempts).toBe(0);
  });

  it('ignores corrupt storage and throwing storage', () => {
    const st = new MemStorage();
    st.setItem(STATS_STORAGE_KEY, '{not json');
    expect(new Stats(st).snapshot().total.attempts).toBe(0);
    st.setItem(STATS_STORAGE_KEY, JSON.stringify({ total: { attempts: 'x' } }));
    expect(new Stats(st).snapshot().total.attempts).toBe(0);
    const bad: StatsStorage = { getItem: () => { throw new Error('nope'); }, setItem: () => { throw new Error('nope'); } };
    const s = new Stats(bad);
    s.record(res('in'), plan({}));
    expect(s.snapshot().total.made).toBe(1);
  });

  it('works without localStorage (Node default)', () => {
    const s = new Stats(undefined, `tt-test-${Math.random()}`);
    s.record(res('wide'), plan({}));
    expect(s.snapshot().total).toEqual({ attempts: 1, made: 0 });
  });
});
