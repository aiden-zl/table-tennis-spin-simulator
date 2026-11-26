// Keyboard + mouse paddle control for the spin trainer.
import type { PaddleControl, StrokeType } from '../contracts';
import { PITCH_LIMITS, STROKES, YAW_LIMITS } from './playerStroke';
import { TABLE_Y } from '../physics/constants';

export type InputAction =
  | 'next' // Space/Enter when idle/result: next ball;  in freeze mode while frozen: hit
  | 'pause' // P / Escape
  | 'slowmo' // T: cycle simulation speed
  | 'camera' // C: cycle camera view
  | 'help' // H or ?
  | 'repeat' // R: replay same ball
  | 'spincam'; // V: toggle spin cam

export interface InputCallbacks {
  onAction(action: InputAction): void;
  onControlChange(control: PaddleControl): void;
}

// ───────────────────────────── tunables

/** Fraction of the target's height (from the top) at which the auto-mode map gives pitch 0°. */
export const PITCH_ZERO_ROW = 0.45;
/** Held-key angle rate (deg / real second). */
export const KEY_RATE_DEG_PER_S = 60;
/** Shift multiplier for fine control (keys and wheel). */
export const FINE_FACTOR = 0.3;
/** Immediate step on the first key press (deg), so quick taps always register. */
export const KEY_TAP_STEP_DEG = 1;
/** Hold time before continuous repeat kicks in (s). */
export const KEY_HOLD_DELAY_S = 0.15;
/** Wheel pitch step per notch (deg). Scrolling down (toward you) opens the face. */
export const WHEEL_STEP_DEG = 2;
/** Pixel delta treated as one wheel notch (trackpads accumulate). */
export const WHEEL_NOTCH_PX = 100;
export const STRENGTH_STEP = 0.1;
/** Manual-mode paddle centre bounds (world metres). */
export const MANUAL_X_LIMITS = { min: -1.0, max: 1.0 };
export const MANUAL_Y_LIMITS = { min: TABLE_Y + 0.02, max: TABLE_Y + 0.6 };

// ───────────────────────────── pure mapping helpers (unit-tested in node)

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Horizontal fraction (0 = left edge, 1 = right edge) → yaw. Linear, centre = 0°. */
export function yawFromFraction(fx: number): number {
  const f = clamp(fx, 0, 1);
  return YAW_LIMITS.min + (YAW_LIMITS.max - YAW_LIMITS.min) * f;
}

/**
 * Vertical fraction (0 = top, 1 = bottom) → pitch. Piecewise linear: top = fully closed
 * (PITCH_LIMITS.min), PITCH_ZERO_ROW = vertical face (0°), bottom = fully open (max).
 * The centre row (0.5) is therefore slightly open (~7°).
 */
export function pitchFromFraction(fy: number): number {
  const f = clamp(fy, 0, 1);
  if (f <= PITCH_ZERO_ROW) return PITCH_LIMITS.min * (1 - f / PITCH_ZERO_ROW);
  return (PITCH_LIMITS.max * (f - PITCH_ZERO_ROW)) / (1 - PITCH_ZERO_ROW);
}

/** Inverse of pitchFromFraction (useful e.g. for drawing a cursor guide). */
export function fractionFromPitch(pitchDeg: number): number {
  const p = clamp(pitchDeg, PITCH_LIMITS.min, PITCH_LIMITS.max);
  if (p <= 0) return PITCH_ZERO_ROW * (1 - p / PITCH_LIMITS.min);
  return PITCH_ZERO_ROW + (1 - PITCH_ZERO_ROW) * (p / PITCH_LIMITS.max);
}

/** Inverse of yawFromFraction. */
export function fractionFromYaw(yawDeg: number): number {
  const y = clamp(yawDeg, YAW_LIMITS.min, YAW_LIMITS.max);
  return (y - YAW_LIMITS.min) / (YAW_LIMITS.max - YAW_LIMITS.min);
}

export interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Absolute auto-position mapping: client coordinates over `rect` → paddle angles. */
export function pointerToAngles(clientX: number, clientY: number, rect: RectLike): { pitchDeg: number; yawDeg: number } {
  const fx = rect.width > 0 ? (clientX - rect.left) / rect.width : 0.5;
  const fy = rect.height > 0 ? (clientY - rect.top) / rect.height : PITCH_ZERO_ROW;
  return { pitchDeg: pitchFromFraction(fy), yawDeg: yawFromFraction(fx) };
}

const STROKE_IDS = new Set<StrokeType>(STROKES.map((s) => s.id));

/** Clamp every field of a control to its legal range (returns a new object). */
export function clampControl(c: PaddleControl): PaddleControl {
  const num = (v: number, fallback: number) => (Number.isFinite(v) ? v : fallback);
  return {
    pitchDeg: clamp(num(c.pitchDeg, 0), PITCH_LIMITS.min, PITCH_LIMITS.max),
    yawDeg: clamp(num(c.yawDeg, 0), YAW_LIMITS.min, YAW_LIMITS.max),
    stroke: STROKE_IDS.has(c.stroke) ? c.stroke : 'block',
    strength: clamp(num(c.strength, 0.5), 0, 1),
    x: clamp(num(c.x, 0), MANUAL_X_LIMITS.min, MANUAL_X_LIMITS.max),
    y: clamp(num(c.y, TABLE_Y + 0.25), MANUAL_Y_LIMITS.min, MANUAL_Y_LIMITS.max),
  };
}

export function controlsEqual(a: PaddleControl, b: PaddleControl): boolean {
  return (
    a.pitchDeg === b.pitchDeg &&
    a.yawDeg === b.yawDeg &&
    a.stroke === b.stroke &&
    a.strength === b.strength &&
    a.x === b.x &&
    a.y === b.y
  );
}

/** What a key (by KeyboardEvent.code) does. */
export type KeyCommand =
  | { kind: 'action'; action: InputAction }
  | { kind: 'stroke'; stroke: StrokeType }
  | { kind: 'strength'; delta: number }
  | { kind: 'hold'; axis: 'pitch' | 'yaw'; dir: -1 | 1 };

const ACTION_KEYS: Record<string, InputAction> = {
  Space: 'next',
  Enter: 'next',
  NumpadEnter: 'next',
  KeyP: 'pause',
  Escape: 'pause',
  KeyT: 'slowmo',
  KeyC: 'camera',
  KeyH: 'help',
  Slash: 'help',
  KeyR: 'repeat',
  KeyV: 'spincam',
};

export function keyCommand(code: string, key?: string): KeyCommand | null {
  const a = ACTION_KEYS[code];
  if (a) return { kind: 'action', action: a };
  switch (code) {
    case 'KeyW':
      return { kind: 'hold', axis: 'pitch', dir: -1 }; // close
    case 'KeyS':
      return { kind: 'hold', axis: 'pitch', dir: 1 }; // open
    case 'KeyA':
      return { kind: 'hold', axis: 'yaw', dir: -1 };
    case 'KeyD':
      return { kind: 'hold', axis: 'yaw', dir: 1 };
    case 'KeyQ':
      return { kind: 'strength', delta: -STRENGTH_STEP };
    case 'KeyE':
      return { kind: 'strength', delta: STRENGTH_STEP };
  }
  const m = /^(?:Digit|Numpad)([1-9])$/.exec(code);
  if (m) {
    const s = STROKES[Number(m[1]) - 1];
    if (s) return { kind: 'stroke', stroke: s.id };
  }
  if (key === '?') return { kind: 'action', action: 'help' };
  return null;
}

interface ElementLike {
  tagName?: string;
  type?: string;
  isContentEditable?: boolean;
}

/**
 * Focus policy:
 *  - 'ignore': text-entry controls (text/number inputs, textarea, select, contenteditable) keep
 *    all keystrokes.
 *  - 'game-no-activate': buttons and range/checkbox/radio inputs — game keys still work, but
 *    Space/Enter are preventDefault-ed so they trigger 'next' instead of also clicking/toggling
 *    the focused control (no double-trigger).
 *  - 'game': anything else (body, canvas…).
 */
export function focusPolicy(el: unknown): 'ignore' | 'game-no-activate' | 'game' {
  if (!el || typeof el !== 'object') return 'game';
  const e = el as ElementLike;
  if (e.isContentEditable) return 'ignore';
  const tag = (e.tagName ?? '').toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return 'ignore';
  if (tag === 'INPUT') {
    const t = (e.type ?? 'text').toLowerCase();
    if (t === 'range' || t === 'checkbox' || t === 'radio' || t === 'button' || t === 'submit' || t === 'reset')
      return 'game-no-activate';
    return 'ignore';
  }
  if (tag === 'BUTTON' || tag === 'A' || tag === 'SUMMARY') return 'game-no-activate';
  return 'game';
}

/** Convert a wheel delta to pixels (deltaMode 0 = px, 1 = lines, 2 = pages). */
export function wheelDeltaPx(deltaY: number, deltaMode: number): number {
  if (deltaMode === 1) return deltaY * 33; // ~3 lines per notch
  if (deltaMode === 2) return deltaY * 800;
  return deltaY;
}

// ───────────────────────────── controller

type Listener = (e: never) => void;
interface EvTarget {
  addEventListener(type: string, fn: Listener, opts?: AddEventListenerOptions | boolean): void;
  removeEventListener(type: string, fn: Listener, opts?: EventListenerOptions | boolean): void;
}

/**
 * Keyboard + mouse paddle control.
 * AUTO-POSITION mode: mouse horizontal -> yaw, mouse vertical -> pitch (absolute mapping over
 * the target, or the setRegion() rect; moving the mouse UP closes the face). The mouse only applies when it actually
 * moves, so W/S/A/D/wheel adjustments persist until the next mouse movement.
 * MANUAL mode: mouse moves the paddle (via projector) and angles come from W/S/A/D + wheel.
 * 1-4 select stroke, Q/E strength -/+. Shift = fine (×0.3) for held keys / taps / wheel.
 * Keys are matched by KeyboardEvent.code (layout independent) and ignored with Ctrl/Meta/Alt
 * so browser shortcuts (Cmd+R…) keep working. Pointer moves are read on the target itself, so
 * UI panels layered above it (with pointer events) do not steer the paddle.
 * setControl() does NOT fire onControlChange (the caller already knows); every other change
 * fires it exactly once per actual change.
 */
export class InputController {
  private control: PaddleControl;
  private auto = true;
  private locked = false;
  private projector: ((clientX: number, clientY: number) => { x: number; y: number } | null) | null = null;
  private region: (() => RectLike | null) | null = null;
  private held = new Map<string, { axis: 'pitch' | 'yaw'; dir: -1 | 1; age: number }>();
  private shift = false;
  private lastPointer: { x: number; y: number } | null = null;
  private wheelAccum = 0;
  private readonly win: EvTarget | null;
  private readonly offs: (() => void)[] = [];

  constructor(
    private readonly target: HTMLElement,
    initial: PaddleControl,
    private readonly cb: InputCallbacks,
  ) {
    this.control = clampControl(initial);
    const doc = (target as unknown as { ownerDocument?: { defaultView?: unknown } }).ownerDocument;
    this.win =
      (doc?.defaultView as EvTarget | undefined) ??
      (typeof window !== 'undefined' ? (window as unknown as EvTarget) : null);

    this.on(target as unknown as EvTarget, 'pointermove', (e: PointerEvent) => this.onPointer(e));
    this.on(target as unknown as EvTarget, 'pointerdown', (e: PointerEvent) => this.onPointer(e));
    this.on(target as unknown as EvTarget, 'wheel', (e: WheelEvent) => this.onWheel(e), { passive: false });
    if (this.win) {
      this.on(this.win, 'keydown', (e: KeyboardEvent) => this.onKeyDown(e));
      this.on(this.win, 'keyup', (e: KeyboardEvent) => this.onKeyUp(e));
      this.on(this.win, 'blur', () => this.releaseAll());
    }
  }

  private on<E>(t: EvTarget, type: string, fn: (e: E) => void, opts?: AddEventListenerOptions): void {
    const l = fn as unknown as Listener;
    t.addEventListener(type, l, opts);
    this.offs.push(() => t.removeEventListener(type, l, opts));
  }

  setAutoPosition(auto: boolean): void {
    this.auto = auto;
    this.lastPointer = null; // next movement applies in the new mode
  }

  /** manual mode: maps client coords to paddle centre (x, y) world, or null */
  setProjector(fn: (clientX: number, clientY: number) => { x: number; y: number } | null): void {
    this.projector = fn;
  }

  /**
   * auto mode: the client-space rect the absolute angle map spans (e.g. the part of the canvas
   * not covered by UI panels, so full open / closed / left / right are reachable without the
   * pointer having to pass under a panel). Positions outside it clamp. null = the whole target.
   */
  setRegion(fn: (() => RectLike | null) | null): void {
    this.region = fn;
  }

  /** externally set control (e.g. from UI sliders). Clamped; does not fire onControlChange. */
  setControl(control: PaddleControl): void {
    this.control = clampControl(control);
  }

  getControl(): PaddleControl {
    return { ...this.control };
  }

  /** while true, mouse/keys do not change the angle or position (stroke/strength and actions still work) */
  setLocked(locked: boolean): void {
    this.locked = locked;
    if (locked) this.held.clear();
  }

  /** per-frame update for held keys (real seconds) */
  update(dtReal: number): void {
    if (!(dtReal > 0) || this.held.size === 0) return;
    const dt = Math.min(dtReal, 0.25); // a long stall (tab switch) never jumps far
    let dp = 0;
    let dy = 0;
    const rate = KEY_RATE_DEG_PER_S * (this.shift ? FINE_FACTOR : 1);
    for (const h of this.held.values()) {
      const before = h.age;
      h.age += dt;
      const active = Math.max(0, h.age - Math.max(before, KEY_HOLD_DELAY_S));
      if (active <= 0) continue;
      if (h.axis === 'pitch') dp += h.dir * rate * active;
      else dy += h.dir * rate * active;
    }
    if (dp !== 0 || dy !== 0) this.adjustAngles(dp, dy);
  }

  dispose(): void {
    for (const off of this.offs.splice(0)) off();
    this.held.clear();
  }

  // ── internals

  private commit(next: PaddleControl): void {
    const c = clampControl(next);
    if (controlsEqual(c, this.control)) return;
    this.control = c;
    this.cb.onControlChange({ ...c });
  }

  private adjustAngles(dPitch: number, dYaw: number): void {
    if (this.locked) return;
    this.commit({ ...this.control, pitchDeg: this.control.pitchDeg + dPitch, yawDeg: this.control.yawDeg + dYaw });
  }

  private onPointer(e: PointerEvent): void {
    if (e.pointerType === 'touch' && e.type === 'pointermove' && e.buttons === 0) return;
    if (focusPolicy(e.target) !== 'game' && e.target !== (this.target as unknown)) return;
    const last = this.lastPointer;
    if (e.type === 'pointermove' && last && last.x === e.clientX && last.y === e.clientY) return;
    this.lastPointer = { x: e.clientX, y: e.clientY };
    if (this.locked) return;
    if (this.auto) {
      const r = this.region?.() ?? null;
      const rect = r && r.width > 0 && r.height > 0 ? r : this.target.getBoundingClientRect();
      const a = pointerToAngles(e.clientX, e.clientY, rect);
      this.commit({ ...this.control, pitchDeg: a.pitchDeg, yawDeg: a.yawDeg });
    } else if (this.projector) {
      const p = this.projector(e.clientX, e.clientY);
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) this.commit({ ...this.control, x: p.x, y: p.y });
    }
  }

  private onWheel(e: WheelEvent): void {
    if (e.ctrlKey) return; // pinch-zoom / browser zoom
    e.preventDefault();
    if (this.locked) return;
    this.wheelAccum += wheelDeltaPx(e.deltaY, e.deltaMode);
    let notches = 0;
    while (this.wheelAccum >= WHEEL_NOTCH_PX) {
      this.wheelAccum -= WHEEL_NOTCH_PX;
      notches++;
    }
    while (this.wheelAccum <= -WHEEL_NOTCH_PX) {
      this.wheelAccum += WHEEL_NOTCH_PX;
      notches--;
    }
    // a single small mouse notch (<100 px, e.g. Firefox lines) still counts once
    if (notches === 0 && Math.abs(e.deltaY) > 0 && e.deltaMode !== 0) {
      notches = Math.sign(e.deltaY);
      this.wheelAccum = 0;
    }
    if (notches !== 0) this.adjustAngles(notches * WHEEL_STEP_DEG * (e.shiftKey ? FINE_FACTOR : 1), 0);
  }

  private onKeyDown(e: KeyboardEvent): void {
    this.shift = e.shiftKey;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const policy = focusPolicy(e.target);
    if (policy === 'ignore') return;
    const cmd = keyCommand(e.code, e.key);
    if (!cmd) return;
    // prevent page scroll on Space and activation of a focused button with Space/Enter
    if (cmd.kind === 'action' && cmd.action === 'next') e.preventDefault();
    else if (policy === 'game') e.preventDefault();
    switch (cmd.kind) {
      case 'action':
        if (!e.repeat) this.cb.onAction(cmd.action);
        break;
      case 'stroke':
        this.commit({ ...this.control, stroke: cmd.stroke });
        break;
      case 'strength':
        // round to avoid 0.30000000000000004 drift
        this.commit({ ...this.control, strength: Math.round((this.control.strength + cmd.delta) * 1000) / 1000 });
        break;
      case 'hold':
        if (this.held.has(e.code) || this.locked) break;
        this.held.set(e.code, { axis: cmd.axis, dir: cmd.dir, age: 0 });
        {
          const step = cmd.dir * KEY_TAP_STEP_DEG * (e.shiftKey ? FINE_FACTOR : 1);
          if (cmd.axis === 'pitch') this.adjustAngles(step, 0);
          else this.adjustAngles(0, step);
        }
        break;
    }
  }

  private onKeyUp(e: KeyboardEvent): void {
    this.shift = e.shiftKey;
    this.held.delete(e.code);
    // Space on a focused button activates on keyup: suppress so 'next' doesn't double-trigger
    if ((e.code === 'Space' || e.code === 'Enter') && focusPolicy(e.target) === 'game-no-activate') e.preventDefault();
  }

  private releaseAll(): void {
    this.held.clear();
    this.shift = false;
  }
}
