/**
 * Opponent shot library: presets, custom-spec planning and the random "bot" opponent.
 * Every plan is solved by the physics shot solver (real flight + bounce model) and validated by
 * predictIncoming, so what the player sees is exactly what the simulation produces.
 */
import type { Pace, ShotPlan, ShotPreset, ShotSpec } from '../contracts';
import type { IncomingPrediction } from '../physics/trajectory';
import { TABLE_Y } from '../physics/constants';
import { solveLaunch } from '../physics/shotSolver';
import { describeSpin } from '../physics/spin';
import { buildOpponentSwing } from './opponentSwing';

/** Legal ranges for spec fields (see ShotSpec docs). */
export const SPEC_LIMITS = {
  spin: 60,
  targetX: 0.65,
  targetZMin: 0.25,
  targetZMax: 1.25,
  fromX: 0.6,
} as const;

const spec = (
  kind: ShotSpec['kind'],
  pace: Pace,
  topspin: number,
  sidespin: number,
  corkscrew: number,
  tx: number,
  tz: number,
  fromX: number,
): ShotSpec => ({ kind, pace, spin: { topspin, sidespin, corkscrew }, target: { x: tx, z: tz }, fromX });

/*
 * Note on sidespin signs: + curves to the RIGHT of travel (= the receiver's LEFT). A
 * right-handed forehand pendulum serve brushes the back of the ball from the server's right to
 * left, which curves the ball to the server's right (+) and kicks off the receiver's paddle to
 * the receiver's right. Opponent's left (their backhand corner) is world +x.
 *
 * Note on spin values: every table bounce converts some spin through table friction (sliding
 * friction changes w by ~1.5 mu (1+e) vn / R, i.e. ~8-13 rps per bounce for typical balls), so a
 * serve loses backspin on BOTH bounces and a no-spin ball picks up topspin (up to the rolling
 * rate v/R). Backspin values are therefore what leaves the server's paddle and are chosen so the
 * ball still ARRIVES with clear backspin (what the player and the coach actually read).
 */
export const PRESETS: ShotPreset[] = [
  {
    id: 'heavy-backspin-short-serve',
    name: 'Heavy backspin short serve',
    description: 'A low serve chopped sharply under the ball so it stays short and checks back toward the net; a closed face or too little lift goes into the net.',
    spec: spec('serve', 'slow', -55, 0, 0, 0.1, 0.4, 0.35),
  },
  {
    id: 'float-serve',
    name: 'No-spin (float) serve',
    description: 'Disguised with the same motion as a backspin serve but struck flat through the ball. Friction with the table rolls it into mild topspin by the time it reaches you, so opening up for backspin pops it high or long.',
    spec: spec('serve', 'slow', -2, 0, 0, -0.15, 0.45, 0.35),
  },
  {
    id: 'topspin-long-serve',
    name: 'Fast topspin long serve',
    description: 'A fast, deep serve brushed up the back of the ball that skids into your backhand corner and kicks forward off the table.',
    spec: spec('serve', 'fast', 28, 0, 0, 0.45, 1.15, 0.4),
  },
  {
    id: 'pendulum-side-backspin',
    name: 'Pendulum side-backspin serve',
    description: 'Forehand pendulum serve brushing down and across the ball: it curves to your left and jumps off your paddle to your right and down.',
    spec: spec('serve', 'medium', -42, 30, 0, -0.25, 0.5, 0.35),
  },
  {
    id: 'pendulum-side-topspin',
    name: 'Pendulum side-topspin serve (long)',
    description: 'Same pendulum motion but brushing up and across: the ball runs long and deflects off your paddle to your right and upward.',
    spec: spec('serve', 'fast', 20, 32, 0, -0.4, 1.1, 0.35),
  },
  {
    id: 'reverse-pendulum',
    name: 'Reverse pendulum serve',
    description: 'The paddle sweeps the other way (server left to right), so the sidespin is mirrored: it curves to your right and kicks off your paddle to your left.',
    spec: spec('serve', 'medium', -35, -35, 0, 0.3, 0.6, 0.3),
  },
  {
    id: 'tomahawk-corkscrew',
    name: 'Tomahawk (corkscrew) serve',
    description: 'A tomahawk-style serve with a strong spin axis along the flight: it barely curves in the air but kicks sideways off the table and your paddle.',
    spec: spec('serve', 'medium', 5, -12, 30, 0.35, 0.95, 0.0),
  },
  {
    id: 'backspin-push',
    name: 'Long backspin push',
    description: 'A slow, controlled push underneath the ball that skids deep with moderate backspin; you need an open face and some lift.',
    spec: spec('rally', 'slow', -28, 0, 0, 0.25, 1.05, 0.1),
  },
  {
    id: 'heavy-chop',
    name: 'Defensive chop (heavy backspin)',
    description: 'A defender slices down hard from far back, sending a floaty heavy backspin ball that drops into the net if you hit it flat.',
    spec: spec('rally', 'slow', -50, 0, 0, 0, 1.05, 0.0),
  },
  {
    id: 'topspin-loop',
    name: 'Topspin loop',
    description: 'A standard forehand loop brushed upward over the ball: it dips onto the table and jumps forward, so close the face to keep it down.',
    spec: spec('rally', 'medium', 35, 0, 0, -0.3, 1.0, 0.3),
  },
  {
    id: 'heavy-topspin-loop',
    name: 'Heavy topspin loop',
    description: 'A slow, spinny loop with maximum brush: it arcs high, dives late and kicks up hard; an open face sends it long.',
    spec: spec('rally', 'medium', 55, 0, 0, 0.35, 1.05, 0.2),
  },
  {
    id: 'flat-drive',
    name: 'Flat drive',
    description: 'A fast, almost spinless counter-hit straight through the ball on a low line. The bounce rolls it into mild topspin, so a near-vertical block with a short punch is enough.',
    spec: spec('rally', 'fast', 8, 0, 0, -0.4, 0.85, -0.2),
  },
  {
    id: 'fast-topspin',
    name: 'Fast topspin drive',
    description: 'An aggressive, fast loop-drive with solid topspin that rushes you; block with a closed face and short stroke.',
    spec: spec('rally', 'fast', 30, 0, 0, 0.3, 1.1, 0.25),
  },
  {
    id: 'hook-loop',
    name: 'Sidespin hook loop',
    description: 'A forehand loop brushed around the outside of the ball so it hooks to your right in the air and kicks off your paddle to your left.',
    spec: spec('rally', 'medium', 35, -25, 0, 0.4, 1.0, -0.2),
  },
];

/** Deterministic PRNG so tests and "replay this ball" are reproducible. */
export type Rng = () => number;
export function makeRng(seed: number): Rng {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

const clamp = (x: number, lo: number, hi: number) => (Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : (lo + hi) / 2);
const clampSpin = (x: number) => (Number.isFinite(x) ? clamp(x, -SPEC_LIMITS.spin, SPEC_LIMITS.spin) : 0);

/** Clamp/sanitise a user-edited spec into legal ranges. */
export function sanitizeSpec(s: ShotSpec): ShotSpec {
  const kind = s.kind === 'serve' ? 'serve' : 'rally';
  const pace: Pace = s.pace === 'slow' || s.pace === 'fast' ? s.pace : 'medium';
  return {
    kind,
    pace,
    spin: {
      topspin: clampSpin(s.spin?.topspin),
      sidespin: clampSpin(s.spin?.sidespin),
      corkscrew: clampSpin(s.spin?.corkscrew),
    },
    target: {
      x: clamp(s.target?.x ?? 0, -SPEC_LIMITS.targetX, SPEC_LIMITS.targetX),
      z: clamp(s.target?.z ?? 0.9, SPEC_LIMITS.targetZMin, SPEC_LIMITS.targetZMax),
    },
    fromX: clamp(s.fromX ?? 0, -SPEC_LIMITS.fromX, SPEC_LIMITS.fromX),
  };
}

/** Name for a spec: the matching preset's name, else a spin description. */
export function shotName(s: ShotSpec): string {
  const near = (a: number, b: number) => Math.abs(a - b) < 0.5;
  const p = PRESETS.find(
    (pr) =>
      pr.spec.kind === s.kind &&
      pr.spec.pace === s.pace &&
      near(pr.spec.spin.topspin, s.spin.topspin) &&
      near(pr.spec.spin.sidespin, s.spin.sidespin) &&
      near(pr.spec.spin.corkscrew, s.spin.corkscrew),
  );
  if (p) return p.name;
  return describeSpin(s.spin, 'receiver') + (s.kind === 'serve' ? ' serve' : ' shot');
}

/** Solve exactly this (already sanitised) spec, no fallbacks. */
function planExact(s: ShotSpec): ShotPlan | null {
  const solved = solveLaunch(s);
  if (!solved) return null;
  return {
    spec: s,
    launch: solved.launch,
    incoming: solved.incoming,
    swing: buildOpponentSwing(solved.launch, s.kind),
    name: shotName(s),
  };
}

const PACES: Pace[] = ['slow', 'medium', 'fast'];

/**
 * Plan a shot from a spec: solve, validate, build the swing. If the exact target is not
 * reachable with this spin/pace, nearby targets (pulled toward a safe mid-depth, centre
 * position) and neighbouring paces are tried; the returned plan's spec says what was used.
 * Null if impossible.
 */
export function planShot(input: ShotSpec): ShotPlan | null {
  const s = sanitizeSpec(input);
  const exact = planExact(s);
  if (exact) return exact;

  const safeZ = s.kind === 'serve' ? 0.75 : 0.95;
  const i = PACES.indexOf(s.pace);
  const paces: Pace[] = [s.pace, ...[PACES[i - 1], PACES[i + 1]].filter((p): p is Pace => !!p)];
  const pulls = [0.2, 0.4, 0.65];
  for (const pace of paces) {
    for (const f of pace === s.pace ? pulls : [0, ...pulls]) {
      const cand = sanitizeSpec({
        ...s,
        pace,
        target: { x: s.target.x * (1 - 0.6 * f), z: s.target.z + (safeZ - s.target.z) * f },
      });
      const plan = planExact(cand);
      if (plan) return plan;
    }
  }
  return null;
}

// ───────────────────────────── bot

const between = (rng: Rng, a: number, b: number) => a + (b - a) * rng();
const sign = (rng: Rng) => (rng() < 0.5 ? -1 : 1);
const round1 = (x: number) => Math.round(x * 10) / 10;

/** A random, realistic spec (not yet solved). */
export function randomSpec(rng: Rng): ShotSpec {
  const kind: ShotSpec['kind'] = rng() < 0.5 ? 'serve' : 'rally';
  const serve = kind === 'serve';
  let top = 0;
  let side = 0;
  let cork = 0;
  const r = rng();
  let category: string;
  if (r < 0.22) category = 'topspin';
  else if (r < 0.44) category = 'backspin';
  else if (r < 0.62) category = 'side-top';
  else if (r < 0.82) category = 'side-back';
  else if (r < 0.93) category = 'nospin';
  else category = 'corkscrew';
  switch (category) {
    case 'topspin':
      top = serve ? between(rng, 12, 32) : between(rng, 18, 58);
      side = between(rng, -6, 6);
      break;
    case 'backspin':
      // launch values; two bounces (serve) or one (rally) remove ~10-25 rps before contact
      top = serve ? -between(rng, 28, 58) : -between(rng, 18, 50);
      side = between(rng, -6, 6);
      break;
    case 'side-top':
      top = between(rng, 10, serve ? 28 : 40);
      side = sign(rng) * between(rng, 15, serve ? 45 : 30);
      break;
    case 'side-back':
      top = -between(rng, serve ? 28 : 18, serve ? 52 : 40);
      side = sign(rng) * between(rng, 15, serve ? 45 : 25);
      break;
    case 'nospin':
      top = between(rng, -4, 4);
      side = between(rng, -3, 3);
      break;
    default:
      cork = sign(rng) * between(rng, 15, 35);
      side = between(rng, -15, 15);
      top = between(rng, -5, 10);
  }

  let pace: Pace;
  let tz: number;
  if (serve) {
    const long = rng() < 0.4;
    tz = long ? between(rng, 0.9, 1.2) : between(rng, 0.3, 0.6);
    // long backspin serves are not hit fast (a fast serve bounces hard and loses its backspin)
    const fastOk = long && top > -8;
    pace = fastOk ? (rng() < 0.6 ? 'fast' : 'medium') : long ? (rng() < 0.7 ? 'medium' : 'slow') : rng() < 0.6 ? 'slow' : 'medium';
  } else {
    tz = between(rng, 0.7, 1.2);
    if (top < -8) pace = rng() < 0.8 ? 'slow' : 'medium';
    else if (top > 8) pace = rng() < 0.5 ? 'medium' : 'fast';
    else pace = PACES[Math.floor(rng() * 3)];
  }
  return {
    kind,
    pace,
    spin: { topspin: round1(top), sidespin: round1(side), corkscrew: round1(cork) },
    target: { x: Math.round(between(rng, -0.55, 0.55) * 100) / 100, z: Math.round(tz * 100) / 100 },
    fromX: Math.round(between(rng, -0.5, 0.5) * 100) / 100,
  };
}

/**
 * Is a solved incoming ball a fair training ball? The receiver takes the ball at the top of the
 * bounce or when it passes CONTACT_MAX_Z; a fast, flat ball bounced deep is still low and rising
 * there, and only a high lob gets it back (no realistic stroke works). Such balls are legal but
 * pointless for angle training, so the bot re-rolls them. Cheap: reads the predicted contact.
 */
export function isTrainableBall(incoming: IncomingPrediction): boolean {
  const c = incoming.contactState;
  const h = c.p.y - TABLE_Y;
  const speed = Math.hypot(c.v.x, c.v.y, c.v.z);
  if (h < 0.12) return false;
  if (h < 0.16 && speed > 7) return false;
  return true;
}

/** A random, always-valid bot shot. Bounded work: re-rolls a few times, then uses a preset. */
export function planRandomShot(rng: Rng): ShotPlan {
  for (let attempt = 0; attempt < 10; attempt++) {
    const s = sanitizeSpec(randomSpec(rng));
    const solved = solveLaunch(s);
    if (!solved || !isTrainableBall(solved.incoming)) continue;
    return {
      spec: s,
      launch: solved.launch,
      incoming: solved.incoming,
      swing: buildOpponentSwing(solved.launch, s.kind),
      name: shotName(s),
    };
  }
  const start = Math.floor(rng() * PRESETS.length);
  for (let k = 0; k < PRESETS.length; k++) {
    const plan = planExact(PRESETS[(start + k) % PRESETS.length].spec);
    if (plan) return plan;
  }
  throw new Error('planRandomShot: no preset solvable (solver broken?)');
}
