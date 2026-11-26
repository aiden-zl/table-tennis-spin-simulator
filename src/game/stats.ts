import type { RallyResult, ReturnOutcome, ShotPlan, SpinSpec, StatsBucket, StatsSnapshot } from '../contracts';

export type SpinCategory = 'topspin' | 'backspin' | 'sidespin' | 'side-top' | 'side-back' | 'nospin' | 'corkscrew';

export const SPIN_CATEGORIES: SpinCategory[] = ['topspin', 'backspin', 'sidespin', 'side-top', 'side-back', 'nospin', 'corkscrew'];

/** thresholds match describeSpin(): 4 rps for top/side, 6 rps for corkscrew */
const TOP_SIDE_MIN = 4;
const CORK_MIN = 6;
/** both top and side count as "mixed" when the smaller is at least this fraction of the larger */
const MIX_RATIO = 0.4;
export const RECENT_LEN = 20;
export const STATS_STORAGE_KEY = 'tt-spin-trainer.stats.v1';

/** Dominant spin category of a SpinSpec (rps, travel-relative). */
export function spinCategory(spin: SpinSpec): SpinCategory {
  const top = Math.abs(spin.topspin);
  const side = Math.abs(spin.sidespin);
  const cork = Math.abs(spin.corkscrew);
  const hasTop = top >= TOP_SIDE_MIN;
  const hasSide = side >= TOP_SIDE_MIN;
  const hasCork = cork >= CORK_MIN;
  if (!hasTop && !hasSide && !hasCork) return 'nospin';
  if (hasCork && cork > top && cork > side) return 'corkscrew';
  if (hasTop && hasSide && Math.min(top, side) >= MIX_RATIO * Math.max(top, side)) {
    return spin.topspin > 0 ? 'side-top' : 'side-back';
  }
  if (top >= side && hasTop) return spin.topspin > 0 ? 'topspin' : 'backspin';
  if (hasSide) return 'sidespin';
  return spin.topspin > 0 ? 'topspin' : 'backspin';
}

/** Minimal Storage subset (so tests can inject a fake). */
export interface StatsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): StatsStorage | null {
  try {
    const ls = (globalThis as { localStorage?: StatsStorage }).localStorage;
    if (ls && typeof ls.getItem === 'function' && typeof ls.setItem === 'function') return ls;
  } catch {
    /* access can throw (privacy mode / Node's experimental global) */
  }
  return null;
}

const emptyBucket = (): StatsBucket => ({ attempts: 0, made: 0 });
const empty = (): StatsSnapshot => ({ total: emptyBucket(), streak: 0, bestStreak: 0, byCategory: {}, recent: [] });

const OUTCOMES = new Set<string>(['in', 'net', 'long', 'wide', 'own-side', 'short', 'miss']);
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0;
const isBucket = (b: unknown): b is StatsBucket =>
  !!b && typeof b === 'object' && isNum((b as StatsBucket).attempts) && isNum((b as StatsBucket).made);

function parse(raw: string | null): StatsSnapshot | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Partial<StatsSnapshot>;
    if (!o || typeof o !== 'object' || !isBucket(o.total) || !isNum(o.streak) || !isNum(o.bestStreak)) return null;
    const byCategory: Record<string, StatsBucket> = {};
    if (o.byCategory && typeof o.byCategory === 'object') {
      for (const [k, b] of Object.entries(o.byCategory)) if (isBucket(b)) byCategory[k] = { attempts: b.attempts, made: b.made };
    }
    const recent = Array.isArray(o.recent)
      ? (o.recent.filter((r) => typeof r === 'string' && OUTCOMES.has(r)) as (ReturnOutcome | 'miss')[]).slice(-RECENT_LEN)
      : [];
    return {
      total: { attempts: o.total.attempts, made: o.total.made },
      streak: o.streak,
      bestStreak: o.bestStreak,
      byCategory,
      recent,
    };
  } catch {
    return null;
  }
}

export class Stats {
  private s: StatsSnapshot;
  private storage: StatsStorage | null;

  /**
   * @param storage  injected storage; `undefined` = window.localStorage if available,
   *                 `null` = no persistence
   */
  constructor(storage?: StatsStorage | null, private key = STATS_STORAGE_KEY) {
    this.storage = storage === undefined ? defaultStorage() : storage;
    let loaded: StatsSnapshot | null = null;
    try {
      loaded = parse(this.storage ? this.storage.getItem(this.key) : null);
    } catch {
      loaded = null;
    }
    this.s = loaded ?? empty();
  }

  record(result: RallyResult, plan: ShotPlan): void {
    const made = result.outcome === 'in';
    const cat = spinCategory(plan.spec.spin);
    const bump = (b: StatsBucket) => {
      b.attempts++;
      if (made) b.made++;
    };
    bump(this.s.total);
    bump((this.s.byCategory[cat] ??= emptyBucket()));
    this.s.streak = made ? this.s.streak + 1 : 0;
    this.s.bestStreak = Math.max(this.s.bestStreak, this.s.streak);
    this.s.recent.push(result.outcome);
    if (this.s.recent.length > RECENT_LEN) this.s.recent.splice(0, this.s.recent.length - RECENT_LEN);
    this.save();
  }

  snapshot(): StatsSnapshot {
    const byCategory: Record<string, StatsBucket> = {};
    for (const [k, b] of Object.entries(this.s.byCategory)) byCategory[k] = { ...b };
    return {
      total: { ...this.s.total },
      streak: this.s.streak,
      bestStreak: this.s.bestStreak,
      byCategory,
      recent: [...this.s.recent],
    };
  }

  reset(): void {
    this.s = empty();
    this.save();
  }

  private save(): void {
    if (!this.storage) return;
    try {
      this.storage.setItem(this.key, JSON.stringify(this.s));
    } catch {
      /* quota / disabled storage: stats stay in memory */
    }
  }
}
