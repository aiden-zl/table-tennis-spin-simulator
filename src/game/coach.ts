/**
 * Coach: finds the paddle angle that returns a given incoming ball, and turns the player's
 * attempt into short, simulation-backed coaching.
 *
 * Everything here uses EXACTLY the live-play physics (hitWithPaddle + simulateReturn, fixed
 * SIM_DT stepping), so replaying { bestPitch, bestYaw, stroke, strength } with hitWithPaddle
 * reproduces the ghost trajectory bit-for-bit.
 */
import type { BallState } from '../physics/ball';
import type { AngleWindow, CoachReport, PaddleControl, ReturnOutcome, ReturnResult, StrokeType } from '../contracts';
import { simulateReturn } from '../physics/trajectory';
import { stepWorld, WorldEvent } from '../physics/ball';
import { BALL_RADIUS, NET_HEIGHT, SIM_DT, TABLE_HALF_LENGTH, TABLE_Y } from '../physics/constants';
import type { Vec3 } from '../physics/vec';
import { describeSpin, spinComponents, SpinSpec } from '../physics/spin';
import { PITCH_LIMITS, STROKES, YAW_LIMITS, hitWithPaddle, paddleMeetsBall } from './playerStroke';

/** Outcome the coach reports; 'miss' = the paddle never touched the ball (manual positioning). */
export type CoachOutcome = ReturnOutcome | 'miss';

/** Strength used when testing / suggesting a different stroke. The ghost paddle for a
 *  suggested stroke must be replayed with this strength. */
export const SUGGEST_STRENGTH = 0.5;
/** swing strengths tried when looking for a better answer to suggest */
export const SUGGEST_STRENGTHS = [0.5, 0.75, 1];

/** Coarse search grid step (degrees). */
export const COARSE_STEP = 5;
/** Integration step of the approximate coarse pre-screen (s). */
const SCREEN_DT = 0.004;
/** Preferred landing point on the opponent's half. */
const TARGET_X = 0;
const TARGET_Z = -0.8;
/** Net clearance (m) below which a return is considered risky (skims the tape). */
const COMFORT_CLEARANCE = 0.03;
/** Below this forgiveness the coach also looks for a better stroke. */
const TINY_FORGIVENESS = 0.02;

/** Search-probe classification. 'fall' = dropped below table height without touching it. */
export type ProbeOutcome = 'in' | 'net' | 'own-side' | 'fall' | 'back' | 'long' | 'timeout';

export interface ProbeResult {
  outcome: ProbeOutcome;
  /** opponent-table bounce point when 'in' */
  landing?: Vec3;
  /** ball bottom above the net top when crossing z=0 (same formula as simulateReturn) */
  netClearance?: number;
}

/**
 * Fast outcome probe used by the search. It runs the SAME stepping loop as simulateReturn
 * (stepWorld at SIM_DT from hitWithPaddle's state, 3 s limit) and therefore gives an
 * identical 'in' / not-'in' verdict, but it stops as soon as the ball can no longer land in:
 * once its bottom drops below table height without a table event it can only reach the
 * floor (short / wide / long); likewise once it is past the opponent's end line and still
 * flying away. That skips ~0.3 s of pointless falling per failed sample.
 * tests/coach.test.ts checks the verdict against simulateReturn.
 *
 * `dt` other than SIM_DT is only used for the approximate coarse pre-screen; every angle the
 * coach reports is re-verified at SIM_DT.
 */
export function probe(
  contact: BallState,
  stroke: StrokeType,
  strength: number,
  pitchDeg: number,
  yawDeg: number,
  dt = SIM_DT,
): ProbeResult {
  const ctl = { pitchDeg, yawDeg, stroke, strength, x: 0, y: 0 };
  // face moving away from the ball: it is never struck (live play scores this as a miss)
  if (!paddleMeetsBall(contact, ctl)) return { outcome: 'back' };
  const start = hitWithPaddle(contact, ctl);
  let b = start;
  const events: WorldEvent[] = [];
  let crossedNet = false;
  let netClearance: number | undefined;
  const steps = Math.ceil(3 / dt);
  for (let i = 0; i < steps; i++) {
    const prev = b;
    events.length = 0;
    b = stepWorld(b, dt, i * dt, events);
    if (!crossedNet && prev.p.z > 0 && b.p.z <= 0) {
      const f = prev.p.z / Math.max(prev.p.z - b.p.z, 1e-12);
      const y = prev.p.y + (b.p.y - prev.p.y) * f;
      netClearance = y - BALL_RADIUS - (TABLE_Y + NET_HEIGHT);
    }
    if (b.p.z < 0) crossedNet = true;
    for (const ev of events) {
      if (ev.kind === 'net') return { outcome: 'net', netClearance };
      if (ev.kind === 'table')
        return ev.side === 'opponent' ? { outcome: 'in', landing: ev.p, netClearance } : { outcome: 'own-side', netClearance };
      if (ev.kind === 'floor') return { outcome: 'fall', netClearance };
    }
    if (prev.p.y - BALL_RADIUS >= TABLE_Y && b.p.y - BALL_RADIUS < TABLE_Y) return { outcome: 'fall', netClearance };
    if (!crossedNet && b.v.z > 0 && b.p.z > start.p.z + 0.3) return { outcome: 'back', netClearance };
    // already beyond the opponent's end line and still flying away: it cannot come back
    if (b.p.z < -TABLE_HALF_LENGTH - 0.02 && b.v.z < -0.5) return { outcome: 'long', netClearance };
  }
  return { outcome: 'timeout', netClearance };
}

const passes = (r: ProbeResult) => r.outcome === 'in';

/**
 * Net clearance (m) up to which an arc is an ideal, low return: good blocks, pushes and
 * drives clear the net by ~3-35 cm. Higher arcs (chops, slow loops) are fine but less ideal;
 * a push or block that floats 60+ cm over the net is the classic "popped-up" ball.
 */
const HIGH_ARC_CLEARANCE = 0.35;
/**
 * Above this clearance (m) the return is a defensive lob that a real opponent smashes. The
 * coach never recommends one when a controlled return exists. (Across every preset and bot
 * ball, passing returns cluster below ~1.0 m or above ~1.4 m: a different family of shots.)
 */
export const LOB_CLEARANCE = 1.0;
/** 'in', over the tape (not a let-like graze) and not a lob: what the coach searches for. */
const controlled = (r: ProbeResult) => passes(r) && (r.netClearance ?? 0) >= 0 && (r.netClearance ?? 0) <= LOB_CLEARANCE;

/** Landing + clearance quality of a passing return, 0..1 (1 = perfect). */
function landingQuality(r: ProbeResult): number {
  const l = r.landing!;
  const dx = (l.x - TARGET_X) / 0.76;
  const dz = (l.z - TARGET_Z) / 0.57;
  const land = Math.max(0, 1 - Math.hypot(dx, dz));
  const nc = r.netClearance ?? 0;
  const clear =
    nc < COMFORT_CLEARANCE
      ? Math.max(nc / COMFORT_CLEARANCE, 0)
      : nc <= HIGH_ARC_CLEARANCE
        ? 1
        : nc <= LOB_CLEARANCE
          ? 1 - (0.8 * (nc - HIGH_ARC_CLEARANCE)) / (LOB_CLEARANCE - HIGH_ARC_CLEARANCE)
          : Math.max(0, 0.2 - (nc - LOB_CLEARANCE) / (5 * LOB_CLEARANCE));
  return 0.3 * land + 0.7 * clear;
}

/**
 * From a passing value `start`, walk outward along one axis in `step` increments until a
 * failure or the limit, then bisect the pass/fail interval. Returns the last passing value.
 */
function findEdge(test: (v: number) => boolean, start: number, dir: 1 | -1, limit: number, step = COARSE_STEP): { value: number } {
  let pass = start;
  for (;;) {
    let next = pass + dir * step;
    if (dir > 0 ? next > limit : next < limit) next = limit;
    if (next === pass) return { value: pass };
    if (test(next)) {
      pass = next;
      continue;
    }
    let fail = next;
    while (Math.abs(fail - pass) > 0.3) {
      const mid = (pass + fail) / 2;
      if (test(mid)) pass = mid;
      else fail = mid;
    }
    return { value: pass };
  }
}

const round05 = (v: number) => Math.round(v * 2) / 2;

/**
 * Passing pitch/yaw window for this incoming contact state with a given stroke/strength.
 *
 * "Passing" means a CONTROLLED return: it lands on the opponent's half and is not a lob
 * (net clearance <= LOB_CLEARANCE). Only if no controlled return exists anywhere does the
 * search fall back to any return that lands (lobs included).
 *
 * Algorithm:
 *  1. Coarse pre-screen over PITCH_LIMITS x YAW_LIMITS every COARSE_STEP degrees, integrated
 *     at SCREEN_DT (4x faster, approximate). forgiveness = the passing fraction of that grid.
 *     If no grid cell passes with a low arc (<= HIGH_ARC_CLEARANCE), low->high pitch
 *     transitions (net/own-side -> long/short) are re-sampled every degree to catch knife-edge windows (real windows against fast spin
 *     balls are often only 2-5 deg wide, narrower than the grid).
 *  2. Each passing cell is scored by its distance to the nearest failing cell (robustness,
 *     capped at 4 cells) plus landing near (0, -0.8) and a comfortable net clearance.
 *     Candidates are verified best-first with the exact SIM_DT probe; up to MAX_FAMILIES
 *     distinct verified candidates (different pitch regions) are compared by landing quality
 *     (low, safe clearance first) weighted by the width of their exact pitch window, so a
 *     lone knife-edge cell cannot beat a wide window and a popped-up ball cannot beat a low one.
 *  3. Refine with exact probes: centre the pitch inside its contiguous window at the best yaw
 *     (inside its low-arc part when the window's middle would pop the ball up),
 *     centre the yaw inside its window at that pitch, re-centre the pitch; window edges are
 *     bisected to ~0.3 deg.
 */
export function findAngleWindow(contact: BallState, stroke: StrokeType, strength: number): AngleWindow | null {
  const pMin = PITCH_LIMITS.min, pMax = PITCH_LIMITS.max, yMin = YAW_LIMITS.min, yMax = YAW_LIMITS.max;
  const np = Math.floor((pMax - pMin) / COARSE_STEP) + 1;
  const ny = Math.floor((yMax - yMin) / COARSE_STEP) + 1;
  const exactR = (p: number, y: number) => probe(contact, stroke, strength, p, y);
  const screen = (p: number, y: number) => probe(contact, stroke, strength, p, y, SCREEN_DT);

  const res: ProbeResult[][] = [];
  for (let i = 0; i < np; i++) {
    const row: ProbeResult[] = [];
    for (let j = 0; j < ny; j++) row.push(screen(pMin + i * COARSE_STEP, yMin + j * COARSE_STEP));
    res.push(row);
  }

  const gridCandidates = (ok: (r: ProbeResult) => boolean) => {
    const cands: { pitch: number; yaw: number; score: number }[] = [];
    const fails: [number, number][] = [];
    for (let i = 0; i < np; i++) for (let j = 0; j < ny; j++) if (!ok(res[i][j])) fails.push([i, j]);
    for (let i = 0; i < np; i++) {
      for (let j = 0; j < ny; j++) {
        const r = res[i][j];
        if (!ok(r)) continue;
        // distance (in cells) to the nearest failure or the edge of the reachable grid
        let d = Math.min(i + 1, np - i, j + 1, ny - j);
        for (const [fi, fj] of fails) {
          const dd = Math.hypot(fi - i, fj - j);
          if (dd < d) d = dd;
        }
        cands.push({ pitch: pMin + i * COARSE_STEP, yaw: yMin + j * COARSE_STEP, score: Math.min(d, 4) / 4 + landingQuality(r) });
      }
    }
    return cands;
  };
  const knifeEdge = (ok: (r: ProbeResult) => boolean) => {
    // 1-degree pitch samples inside low->high transitions
    const cands: { pitch: number; yaw: number; score: number }[] = [];
    const low = (o: ProbeOutcome) => o === 'net' || o === 'own-side';
    for (let j = 0; j < ny; j++) {
      const yaw = yMin + j * COARSE_STEP;
      for (let i = 0; i + 1 < np; i++) {
        if (!low(res[i][j].outcome) || low(res[i + 1][j].outcome)) continue;
        for (let k = 1; k < COARSE_STEP; k++) {
          const pitch = pMin + i * COARSE_STEP + k;
          const r = screen(pitch, yaw);
          if (ok(r)) cands.push({ pitch, yaw, score: landingQuality(r) - Math.abs(yaw) / 1000 });
        }
      }
    }
    return cands;
  };

  let ok = controlled;
  let cands = gridCandidates(ok);
  // also look between grid points when the grid only offers high arcs: the low, realistic
  // window (e.g. a closed block of a fast loop) is often narrower than COARSE_STEP
  const lowArc = (r: ProbeResult) => controlled(r) && (r.netClearance ?? 0) <= HIGH_ARC_CLEARANCE;
  let hasLow = false;
  for (let i = 0; i < np && !hasLow; i++) for (let j = 0; j < ny && !hasLow; j++) hasLow = lowArc(res[i][j]);
  if (!hasLow) cands = cands.concat(knifeEdge(ok));
  if (cands.length === 0) {
    // nothing controlled works: accept any return that lands (lobs included)
    ok = passes;
    cands = gridCandidates(ok);
    if (cands.length === 0) cands = knifeEdge(ok);
  }
  let passCount = 0;
  for (let i = 0; i < np; i++) for (let j = 0; j < ny; j++) if (ok(res[i][j])) passCount++;

  const exact = (p: number, y: number) => ok(exactR(p, y));
  const pitchWindow = (y: number, from: number) => {
    const t = (p: number) => exact(p, y);
    return [findEdge(t, from, -1, pMin).value, findEdge(t, from, 1, pMax).value] as const;
  };
  const yawWindow = (p: number, from: number) => {
    const t = (y: number) => exact(p, y);
    return [findEdge(t, from, -1, yMin).value, findEdge(t, from, 1, yMax).value] as const;
  };

  // verify best-first; keep up to MAX_FAMILIES candidates from distinct pitch regions and
  // pick the one with the widest exact pitch window (ties broken by landing quality)
  cands.sort((a, b) => b.score - a.score);
  const MAX_FAMILIES = 3;
  const families: { pitch: number; yaw: number; lo: number; hi: number; rank: number }[] = [];
  for (let k = 0, verified = 0; k < cands.length && verified < 8 && families.length < MAX_FAMILIES; k++) {
    const c = cands[k];
    if (families.some((f) => c.pitch >= f.lo - 1 && c.pitch <= f.hi + 1 && Math.abs(c.yaw - f.yaw) < 15)) continue;
    verified++;
    const r = exactR(c.pitch, c.yaw);
    if (!ok(r)) continue;
    // approximate (SCREEN_DT) window for ranking only; the chosen one is re-measured exactly
    const st = (p: number) => ok(screen(p, c.yaw));
    const lo = findEdge(st, c.pitch, -1, pMin).value;
    const hi = findEdge(st, c.pitch, 1, pMax).value;
    // a wide window matters, but never enough to prefer a popped-up ball over a low one
    families.push({ pitch: c.pitch, yaw: c.yaw, lo, hi, rank: landingQuality(r) * (0.6 + (0.4 * Math.min(hi - lo, 12)) / 12) });
  }
  if (families.length === 0) return null;
  families.sort((a, b) => b.rank - a.rank);
  const best = families[0];

  // Pitch to recommend inside a passing window [lo, hi] at yaw y: its middle, unless the middle
  // is a high arc (a wide window whose centre pops the ball up); then the middle of the longest
  // low-arc run inside the window (screened every 2 deg), kept at least a quarter of the window
  // width away from either edge so the recommendation stays robust.
  const pitchCentre = (lo: number, hi: number, y: number): number => {
    const mid = round05((lo + hi) / 2);
    if (ok === passes) return mid;
    const rm = exactR(mid, y);
    if (!ok(rm) || lowArc(rm)) return mid;
    let bestRun: [number, number] | null = null;
    let runStart: number | null = null;
    let last = lo;
    for (let p = lo; ; p += 2) {
      const inside = p <= hi;
      const good = inside && lowArc(screen(p, y));
      if (good && runStart === null) runStart = p;
      if (!good && runStart !== null) {
        if (!bestRun || last - runStart > bestRun[1] - bestRun[0]) bestRun = [runStart, last];
        runStart = null;
      }
      if (!inside) break;
      last = p;
    }
    if (!bestRun) return mid;
    const q = (hi - lo) / 4;
    return round05(Math.min(Math.max((bestRun[0] + bestRun[1]) / 2, lo + q), hi - q));
  };

  // ── refine with exact probes: centre of the contiguous passing region
  let bp = best.pitch;
  let by = best.yaw;
  let [plo, phi] = pitchWindow(by, bp);
  let cand = pitchCentre(plo, phi, by);
  if (exact(cand, by)) bp = cand;
  let [ylo, yhi] = yawWindow(bp, by);
  cand = round05((ylo + yhi) / 2);
  if (exact(bp, cand)) by = cand;
  [plo, phi] = pitchWindow(by, bp);
  cand = pitchCentre(plo, phi, by);
  if (exact(cand, by)) bp = cand;
  [ylo, yhi] = yawWindow(bp, by);

  return {
    bestPitch: bp,
    bestYaw: by,
    pitchMin: plo,
    pitchMax: phi,
    yawMin: ylo,
    yawMax: yhi,
    // a knife-edge window found between grid points still gets a token, non-zero value
    forgiveness: passCount > 0 ? passCount / (np * ny) : 0.2 / (np * ny),
  };
}

/** Return trajectory of a given angle (for the ghost paddle), sampled every 5 steps. */
export function idealReturn(contact: BallState, stroke: StrokeType, strength: number, pitchDeg: number, yawDeg: number): ReturnResult {
  return simulateReturn(hitWithPaddle(contact, { pitchDeg, yawDeg, stroke, strength, x: 0, y: 0 }), 5);
}

// ─────────────────────────────────────────────────────────── coaching text

const fmtDeg = (d: number) => {
  const r = Math.round(d);
  return `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r)}°`;
};
const strokeLabel = (s: StrokeType) => STROKES.find((x) => x.id === s)?.label.toLowerCase() ?? s;

function spinNoun(spec: SpinSpec): string {
  const back = spec.topspin <= -4, top = spec.topspin >= 4, side = Math.abs(spec.sidespin) >= 4;
  const heavy = Math.abs(spec.topspin) >= 30 ? 'heavy ' : '';
  if (back && side) return 'side-backspin';
  if (top && side) return 'side-topspin';
  if (back) return `${heavy}backspin`;
  if (top) return `${heavy}topspin`;
  if (side) return 'sidespin';
  return 'no-spin ball';
}

/** x (m) where a return crosses the preferred landing depth z = TARGET_Z (or where it ends). */
function lateralAtTarget(after: BallState): number {
  const path = simulateReturn(after, 1).path;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    if (a.z > TARGET_Z && b.z <= TARGET_Z) return a.x + ((b.x - a.x) * (a.z - TARGET_Z)) / (a.z - b.z);
  }
  return path[path.length - 1].x;
}

/**
 * Sideways drift (m, + = player's right) the incoming SIDESPIN alone gives a straight
 * (yaw 0) return at `pitchDeg`: the same hit is simulated with and without the vertical
 * spin component, and the difference in x at the target depth is reported.
 */
export function sidespinDrift(contact: BallState, stroke: StrokeType, strength: number, pitchDeg: number): number {
  const ctl = { pitchDeg, yawDeg: 0, stroke, strength, x: 0, y: 0 };
  const noSide: BallState = { p: contact.p, v: contact.v, w: { x: contact.w.x, y: 0, z: contact.w.z } };
  return lateralAtTarget(hitWithPaddle(contact, ctl)) - lateralAtTarget(hitWithPaddle(noSide, ctl));
}

function squareBlockTip(contact: BallState, spec: SpinSpec): string | null {
  const after = hitWithPaddle(contact, { pitchDeg: 0, yawDeg: 0, stroke: 'block', strength: 0.5, x: 0, y: 0 });
  const r = simulateReturn(after, 100000);
  const back = spec.topspin <= -4, top = spec.topspin >= 4;
  const spinWord = back ? 'the backspin' : top ? 'the topspin' : null;
  switch (r.outcome) {
    case 'net':
      return `A vertical block of this ball goes into the net${back ? ' — the backspin drags it down' : ''}.`;
    case 'own-side':
      return `A vertical block of this ball drops onto your own side${back ? ' — the backspin drags it down' : ''}.`;
    case 'long':
      return `A vertical block of this ball flies long${top ? ' — the topspin kicks it up off your face' : ''}.`;
    case 'short':
      return `A vertical block of this ball pops up and never reaches the net.`;
    case 'wide': {
      const side = (r.landing?.x ?? 0) > 0 ? 'right' : 'left';
      const why = Math.abs(spec.sidespin) >= 4 ? 'the sidespin kicks it off line' : "the ball's own sideways travel carries on off a face aimed at the middle";
      return `A vertical block of this ball goes wide to your ${side} — ${why}.`;
    }
    case 'in':
      return `A simple vertical block of this ball lands in${spinWord ? ` — ${spinWord} is not enough to beat it` : ''}.`;
  }
}

function sideTip(contact: BallState, spec: SpinSpec, w: AngleWindow, stroke: StrokeType, strength: number): string | null {
  if (Math.abs(spec.sidespin) < 4) return null;
  const drift = sidespinDrift(contact, stroke, strength, w.bestPitch);
  if (Math.abs(drift) < 0.05) return null;
  const cm = Math.round(Math.abs(drift) * 100);
  const driftSide = drift > 0 ? 'right' : 'left';
  const against = drift > 0 ? 'left' : 'right';
  // the best aim also depends on where the ball is and which way it travels, so say how much
  // the SIDESPIN moves it: compare with the same ball without its sidespin
  const noSide: BallState = { p: contact.p, v: contact.v, w: { x: contact.w.x, y: 0, z: contact.w.z } };
  const plain = findAngleWindow(noSide, stroke, strength);
  const shift = plain ? w.bestYaw - plain.bestYaw : 0;
  if (plain && Math.abs(shift) >= 2 && Math.sign(shift) === -Math.sign(drift))
    return `The sidespin kicks a straight return ${cm} cm to your ${driftSide}, so aim about ${Math.abs(Math.round(shift))}° further ${against} than for the same ball without sidespin (${fmtDeg(plain.bestYaw)} → ${fmtDeg(w.bestYaw)}).`;
  return `The sidespin kicks a straight return ${cm} cm to your ${driftSide} — aim against it, toward your ${against}.`;
}

function angleTip(control: PaddleControl, w: AngleWindow, pitchErr: number, yawErr: number, landed: boolean): string | null {
  const parts: string[] = [];
  const pitchOk = control.pitchDeg >= w.pitchMin && control.pitchDeg <= w.pitchMax;
  const yawOk = control.yawDeg >= w.yawMin && control.yawDeg <= w.yawMax;
  // The window is two 1-D slices through the best angle (pitch range at the best aim, aim
  // range at the best pitch), not a rectangle: both numbers can be inside their slices while
  // the combination still misses. Only call it "inside" when the actual return landed.
  if (landed && (!pitchOk || !yawOk)) {
    return `That works too, but it's off the safest line: ${fmtDeg(w.bestPitch)} pitch with ${fmtDeg(w.bestYaw)} aim leaves the most margin.`;
  }
  if (pitchOk && yawOk && !landed) {
    return `Your pitch (${fmtDeg(control.pitchDeg)}) and aim (${fmtDeg(control.yawDeg)}) each work on their own, but not together — try ${fmtDeg(w.bestPitch)} pitch with ${fmtDeg(w.bestYaw)} aim.`;
  }
  if (!pitchOk) {
    const dir = pitchErr < 0 ? 'closed' : 'open';
    const fix = pitchErr < 0 ? 'open' : 'close';
    parts.push(`You were ${Math.abs(Math.round(pitchErr))}° too ${dir}; ${fix} to about ${fmtDeg(w.bestPitch)}.`);
  }
  if (!yawOk) {
    const dir = yawErr > 0 ? 'right' : 'left';
    const fix = yawErr > 0 ? 'left' : 'right';
    parts.push(`You aimed ${Math.abs(Math.round(yawErr))}° too far ${dir}; turn the face ${fix} to about ${fmtDeg(w.bestYaw)}.`);
  }
  if (parts.length) return parts.join(' ');
  if (Math.abs(pitchErr) > 4 || Math.abs(yawErr) > 4)
    return `Your angle was inside the window; the safest is ${fmtDeg(w.bestPitch)} pitch, ${fmtDeg(w.bestYaw)} aim (works from ${fmtDeg(w.pitchMin)} to ${fmtDeg(w.pitchMax)}).`;
  return `Spot on — ${fmtDeg(w.bestPitch)} is the most forgiving angle for this ball.`;
}

function headlineFor(
  outcome: CoachOutcome,
  spinName: string,
  pitchErr?: number,
  yawErr?: number,
  landingX?: number,
  nearEdge = false,
  faceAway = false,
): string {
  switch (outcome) {
    case 'in':
      return nearEdge ? `In! But close to the edge against this ${spinName}` : `In! Nice return against the ${spinName}`;
    case 'net':
      if (pitchErr === undefined) return `Into the net against this ${spinName}`;
      return pitchErr > 0 ? `Into the net — not enough pace to carry this ${spinName}` : `Into the net — too closed for this ${spinName}`;
    case 'own-side':
      // no window for this stroke = no reference angle: don't guess a direction
      if (pitchErr === undefined) return `Hit your own side against this ${spinName}`;
      if (pitchErr > 0) return `Hit your own side — the ${spinName} dragged it down; swing more forward`;
      return `Hit your own side — face too closed for this ${spinName}`;
    case 'long':
      if (pitchErr === undefined) return `Long against this ${spinName}`;
      return pitchErr < 0 ? `Long — too much pace for this ${spinName}` : `Long — face too open for this ${spinName}`;
    case 'short':
      if (pitchErr === undefined) return `Didn't reach the net against this ${spinName}`;
      if (pitchErr < 0) return `Didn't reach the net — face too closed, driven down on your side`;
      return `Didn't reach the net — the ball popped up off an open face`;
    case 'wide': {
      const side = (landingX ?? yawErr ?? 0) > 0 ? 'right' : 'left';
      return `Wide to the ${side} — adjust your aim for this ${spinName}`;
    }
    case 'miss':
      return faceAway
        ? 'The ball slipped past — your face was turned away from it'
        : 'Missed the ball — get the paddle to it first';
  }
}

/**
 * How sensible a stroke is as a RECOMMENDATION for this ball, in real table-tennis terms
 * (0..1, multiplies its forgiveness when the coach looks for a better stroke). The physics
 * decides whether a stroke works; this only stops the coach recommending, say, a chop
 * against a short serve over the table or a push against a loop when a block or loop works.
 */
export function strokeFit(stroke: StrokeType, spec: SpinSpec, contact: BallState): number {
  const top = spec.topspin;
  const overTable = contact.p.z < TABLE_HALF_LENGTH; // short ball taken over the table
  switch (stroke) {
    case 'block':
      return top <= -10 ? 0.5 : 1; // blocking backspin is a weak, passive answer
    case 'push':
      return top >= 10 ? 0.3 : 1; // pushing topspin pops it up; it's the answer to backspin
    case 'drive':
      return 1; // loop / flick is legitimate against everything
    case 'chop':
      // a defensive stroke played from 2+ m back; every contact here is within ~35 cm of the
      // end line, so it is a last resort (a little more natural against topspin)
      return overTable ? 0.15 : top >= 10 ? 0.35 : 0.2;
  }
}

/** Full coaching report. `actual` is null when the player missed the ball entirely. */
export function analyzeReturn(contact: BallState, control: PaddleControl, actual: ReturnResult | null): CoachReport {
  const outcome: CoachOutcome = actual ? actual.outcome : 'miss';
  const spec = spinComponents(contact.w, contact.v);
  const spinText = describeSpin(spec, 'receiver');
  const spinName = spinNoun(spec);

  const ideal = findAngleWindow(contact, control.stroke, control.strength);
  let suggestedStroke: StrokeType | undefined;
  let suggestedWindow: AngleWindow | undefined;
  let suggestedStrength: number | undefined;
  if (!ideal || ideal.forgiveness < TINY_FORGIVENESS) {
    let bestF = ideal ? ideal.forgiveness * 1.5 * strokeFit(control.stroke, spec, contact) : 0;
    // first the normal swing for every stroke; other strengths only if that finds nothing good
    // (some answers only work with a firmer swing, e.g. pushing a heavy chop)
    const consider = (stroke: StrokeType, strength: number) => {
      if (stroke === control.stroke && Math.abs(strength - control.strength) < 0.05) return;
      const w = findAngleWindow(contact, stroke, strength);
      if (!w) return;
      // same stroke at another strength: slightly preferred (smallest change for the player)
      const sameBonus = stroke === control.stroke ? 1.2 : 1;
      // prefer a normal swing: an extreme strength must be clearly better to be suggested
      const strengthPref = 1 - 0.25 * (Math.abs(strength - SUGGEST_STRENGTH) / 0.5);
      const f = w.forgiveness * strokeFit(stroke, spec, contact) * sameBonus * strengthPref;
      if (f > bestF) {
        bestF = f;
        suggestedStroke = stroke;
        suggestedWindow = w;
        suggestedStrength = strength;
      }
    };
    for (const s of STROKES) consider(s.id, SUGGEST_STRENGTH);
    // the same stroke swung harder/softer is the smallest change, so always try it; every
    // stroke at other strengths only when nothing good turned up
    const weak = !suggestedWindow || suggestedWindow.forgiveness < TINY_FORGIVENESS;
    for (const strength of SUGGEST_STRENGTHS) {
      if (strength === SUGGEST_STRENGTH) continue;
      for (const s of STROKES) if (weak || s.id === control.stroke) consider(s.id, strength);
    }
  }

  const tips: string[] = [];
  let pitchError: number | undefined;
  let yawError: number | undefined;
  if (ideal) {
    pitchError = control.pitchDeg - ideal.bestPitch;
    yawError = control.yawDeg - ideal.bestYaw;
  }

  // landed, but within a few degrees of where the window ends
  const nearEdge =
    outcome === 'in' &&
    !!ideal &&
    (Math.min(control.pitchDeg - ideal.pitchMin, ideal.pitchMax - control.pitchDeg) < 4 ||
      Math.min(control.yawDeg - ideal.yawMin, ideal.yawMax - control.yawDeg) < 3);
  const lobClearance = actual && actual.outcome === 'in' && (actual.netClearance ?? 0) > LOB_CLEARANCE ? actual.netClearance! : undefined;
  if (lobClearance !== undefined)
    tips.push(`That landed, but as a lob ${Math.round(lobClearance * 100)} cm over the net — a real opponent would smash it.`);
  const faceAway = outcome === 'miss' && !paddleMeetsBall(contact, control);
  if (faceAway) {
    const target = ideal ? ` Try about ${fmtDeg(ideal.bestPitch)}.` : '';
    tips.push(`At ${fmtDeg(control.pitchDeg)} the ${strokeLabel(control.stroke)} moves the face away from the ball, so it never touches it.${target}`);
  }
  else if (outcome === 'miss') tips.push('Line the paddle up with the ball before worrying about the angle.');
  else if (ideal) {
    const t = angleTip(control, ideal, pitchError!, yawError!, outcome === 'in');
    if (t) tips.push(t);
  }
  if (suggestedStroke && suggestedWindow && suggestedStrength !== undefined) {
    const why = ideal
      ? `The ${strokeLabel(control.stroke)} barely works here.`
      : `No ${strokeLabel(control.stroke)} angle returns this ball at ${Math.round(control.strength * 100)}% strength.`;
    const how = suggestedStroke === control.stroke ? `the ${strokeLabel(suggestedStroke)}` : `a ${strokeLabel(suggestedStroke)}`;
    const str = Math.abs(suggestedStrength - control.strength) >= 0.05 ? ` with ${Math.round(suggestedStrength * 100)}% strength` : '';
    tips.push(`${why} Try ${how} at about ${fmtDeg(suggestedWindow.bestPitch)}${str}.`);
  } else if (!ideal) {
    tips.push(`No ${strokeLabel(control.stroke)} angle returns this ball at that strength — try another stroke.`);
  }
  const sq = squareBlockTip(contact, spec);
  const side = ideal
    ? sideTip(contact, spec, ideal, control.stroke, control.strength)
    : suggestedStroke && suggestedWindow
      ? sideTip(contact, spec, suggestedWindow, suggestedStroke, suggestedStrength ?? SUGGEST_STRENGTH)
      : null;
  if (side && tips.length < 3) tips.push(side);
  if (sq && tips.length < 3) tips.push(sq);
  if (tips.length < 3 && outcome !== 'in') tips.push(`It was ${spinText.toLowerCase()} — read it from the opponent's swing.`);
  if (tips.length === 0) tips.push(`It was ${spinText.toLowerCase()}.`);

  let idealPath;
  if (ideal) idealPath = idealReturn(contact, control.stroke, control.strength, ideal.bestPitch, ideal.bestYaw).path;
  else if (suggestedStroke && suggestedWindow)
    idealPath = idealReturn(contact, suggestedStroke, suggestedStrength ?? SUGGEST_STRENGTH, suggestedWindow.bestPitch, suggestedWindow.bestYaw).path;

  return {
    outcome,
    ideal,
    suggestedStroke,
    suggestedWindow,
    suggestedStrength,
    pitchError,
    yawError,
    headline:
      lobClearance !== undefined
        ? `In — but only as a high lob against this ${spinName}`
        : headlineFor(outcome, spinName, pitchError, yawError, actual?.landing?.x, nearEdge, faceAway),
    tips: tips.slice(0, 3),
    idealPath,
  };
}
