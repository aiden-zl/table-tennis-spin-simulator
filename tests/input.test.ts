import { describe, expect, it } from 'vitest';
import {
  InputController,
  KEY_HOLD_DELAY_S,
  KEY_TAP_STEP_DEG,
  PITCH_ZERO_ROW,
  clampControl,
  focusPolicy,
  fractionFromPitch,
  fractionFromYaw,
  keyCommand,
  pitchFromFraction,
  pointerToAngles,
  yawFromFraction,
  type InputAction,
} from '../src/game/input';
import { PITCH_LIMITS, YAW_LIMITS, type PaddleControl } from '../src/game/playerStroke';
import { TABLE_Y } from '../src/physics/constants';
import { Sfx } from '../src/render/audio';

class FakeTarget {
  private ls = new Map<string, Set<(e: unknown) => void>>();
  addEventListener(type: string, fn: (e: unknown) => void) {
    if (!this.ls.has(type)) this.ls.set(type, new Set());
    this.ls.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: (e: unknown) => void) {
    this.ls.get(type)?.delete(fn);
  }
  emit(type: string, props: Record<string, unknown>) {
    let prevented = false;
    const e = { type, target: this, preventDefault: () => (prevented = true), ...props };
    for (const fn of this.ls.get(type) ?? []) fn(e);
    return prevented;
  }
  count() {
    let n = 0;
    for (const s of this.ls.values()) n += s.size;
    return n;
  }
}

function setup(initial?: Partial<PaddleControl>) {
  const win = new FakeTarget();
  const el = new FakeTarget() as FakeTarget & Record<string, unknown>;
  el.ownerDocument = { defaultView: win };
  el.getBoundingClientRect = () => ({ left: 100, top: 50, width: 800, height: 400 });
  const actions: InputAction[] = [];
  const changes: PaddleControl[] = [];
  const base: PaddleControl = { pitchDeg: 0, yawDeg: 0, stroke: 'block', strength: 0.5, x: 0, y: TABLE_Y + 0.25 };
  const ic = new InputController(el as unknown as HTMLElement, { ...base, ...initial }, {
    onAction: (a) => actions.push(a),
    onControlChange: (c) => changes.push(c),
  });
  const key = (code: string, extra: Record<string, unknown> = {}) =>
    win.emit('keydown', { code, key: '', shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, repeat: false, ...extra });
  const keyUp = (code: string, extra: Record<string, unknown> = {}) => win.emit('keyup', { code, shiftKey: false, ...extra });
  const move = (clientX: number, clientY: number) =>
    el.emit('pointermove', { clientX, clientY, pointerType: 'mouse', buttons: 0 });
  return { ic, el, win, actions, changes, key, keyUp, move };
}

describe('pure mappings', () => {
  it('yaw is linear edge to edge with centre 0', () => {
    expect(yawFromFraction(0)).toBe(YAW_LIMITS.min);
    expect(yawFromFraction(1)).toBe(YAW_LIMITS.max);
    expect(yawFromFraction(0.5)).toBeCloseTo(0);
    expect(yawFromFraction(0.75)).toBeCloseTo(YAW_LIMITS.max / 2);
    expect(yawFromFraction(-3)).toBe(YAW_LIMITS.min);
    expect(fractionFromYaw(yawFromFraction(0.3))).toBeCloseTo(0.3);
  });

  it('pitch: top closed, bottom open, 0 at 45% and centre slightly open', () => {
    expect(pitchFromFraction(0)).toBe(PITCH_LIMITS.min);
    expect(pitchFromFraction(1)).toBe(PITCH_LIMITS.max);
    expect(pitchFromFraction(PITCH_ZERO_ROW)).toBeCloseTo(0);
    const mid = pitchFromFraction(0.5);
    expect(mid).toBeGreaterThan(3);
    expect(mid).toBeLessThan(10);
    // monotonic
    let prev = -Infinity;
    for (let f = 0; f <= 1; f += 0.05) {
      const p = pitchFromFraction(f);
      expect(p).toBeGreaterThan(prev);
      prev = p;
    }
    for (const f of [0, 0.2, 0.45, 0.7, 1]) expect(fractionFromPitch(pitchFromFraction(f))).toBeCloseTo(f);
  });

  it('pointerToAngles uses the rect', () => {
    const r = { left: 100, top: 50, width: 800, height: 400 };
    expect(pointerToAngles(100, 50, r)).toEqual({ pitchDeg: PITCH_LIMITS.min, yawDeg: YAW_LIMITS.min });
    expect(pointerToAngles(900, 450, r)).toEqual({ pitchDeg: PITCH_LIMITS.max, yawDeg: YAW_LIMITS.max });
    expect(pointerToAngles(2000, -500, r)).toEqual({ pitchDeg: PITCH_LIMITS.min, yawDeg: YAW_LIMITS.max });
    expect(pointerToAngles(10, 10, { left: 0, top: 0, width: 0, height: 0 }).yawDeg).toBeCloseTo(0);
  });

  it('clampControl clamps everything', () => {
    const c = clampControl({ pitchDeg: 500, yawDeg: -500, stroke: 'nope' as never, strength: 7, x: -9, y: 99 });
    expect(c).toEqual({ pitchDeg: PITCH_LIMITS.max, yawDeg: YAW_LIMITS.min, stroke: 'block', strength: 1, x: -1, y: TABLE_Y + 0.6 });
    expect(clampControl({ ...c, pitchDeg: NaN }).pitchDeg).toBe(0);
  });

  it('keyCommand maps codes', () => {
    expect(keyCommand('KeyW')).toEqual({ kind: 'hold', axis: 'pitch', dir: -1 });
    expect(keyCommand('KeyS')).toEqual({ kind: 'hold', axis: 'pitch', dir: 1 });
    expect(keyCommand('KeyA')).toEqual({ kind: 'hold', axis: 'yaw', dir: -1 });
    expect(keyCommand('KeyD')).toEqual({ kind: 'hold', axis: 'yaw', dir: 1 });
    expect(keyCommand('Digit3')).toEqual({ kind: 'stroke', stroke: 'drive' });
    expect(keyCommand('Numpad4')).toEqual({ kind: 'stroke', stroke: 'chop' });
    expect(keyCommand('Digit5')).toBeNull();
    const acts: Record<string, InputAction> = {
      Space: 'next', Enter: 'next', KeyP: 'pause', Escape: 'pause', KeyT: 'slowmo', KeyC: 'camera',
      KeyH: 'help', Slash: 'help', KeyR: 'repeat', KeyV: 'spincam',
    };
    for (const [code, a] of Object.entries(acts)) expect(keyCommand(code)).toEqual({ kind: 'action', action: a });
    expect(keyCommand('IntlRo', '?')).toEqual({ kind: 'action', action: 'help' });
  });

  it('focusPolicy', () => {
    expect(focusPolicy({ tagName: 'INPUT', type: 'text' })).toBe('ignore');
    expect(focusPolicy({ tagName: 'INPUT', type: 'number' })).toBe('ignore');
    expect(focusPolicy({ tagName: 'TEXTAREA' })).toBe('ignore');
    expect(focusPolicy({ tagName: 'SELECT' })).toBe('ignore');
    expect(focusPolicy({ tagName: 'DIV', isContentEditable: true })).toBe('ignore');
    expect(focusPolicy({ tagName: 'INPUT', type: 'range' })).toBe('game-no-activate');
    expect(focusPolicy({ tagName: 'BUTTON' })).toBe('game-no-activate');
    expect(focusPolicy({ tagName: 'CANVAS' })).toBe('game');
    expect(focusPolicy(null)).toBe('game');
  });
});

describe('InputController', () => {
  it('auto mode: mouse maps absolutely, only on movement; keys persist', () => {
    const { ic, changes, move, key, keyUp } = setup();
    move(500, 50 + 400 * PITCH_ZERO_ROW); // centre column, zero row
    expect(changes.length).toBe(0); // already pitch 0 / yaw 0 → no spam
    move(900, 50);
    expect(ic.getControl().yawDeg).toBe(YAW_LIMITS.max);
    expect(ic.getControl().pitchDeg).toBe(PITCH_LIMITS.min);
    key('KeyS');
    keyUp('KeyS');
    expect(ic.getControl().pitchDeg).toBeCloseTo(PITCH_LIMITS.min + KEY_TAP_STEP_DEG);
    move(900, 50); // same coords: not a movement
    expect(ic.getControl().pitchDeg).toBeCloseTo(PITCH_LIMITS.min + KEY_TAP_STEP_DEG);
    const n = changes.length;
    move(500, 250);
    expect(changes.length).toBe(n + 1);
    expect(ic.getControl().yawDeg).toBeCloseTo(0);
  });

  it('held keys repeat at ~60°/s after a short delay, shift = fine', () => {
    const { ic, key, keyUp } = setup();
    key('KeyW');
    expect(ic.getControl().pitchDeg).toBeCloseTo(-KEY_TAP_STEP_DEG);
    for (let k = 0; k < 60; k++) ic.update(1 / 60);
    expect(ic.getControl().pitchDeg).toBeCloseTo(-KEY_TAP_STEP_DEG - 60 * (1 - KEY_HOLD_DELAY_S), 3);
    keyUp('KeyW');
    ic.update(1);
    const p = ic.getControl().pitchDeg;
    expect(p).toBeCloseTo(-KEY_TAP_STEP_DEG - 60 * (1 - KEY_HOLD_DELAY_S), 3);
    key('ShiftLeft', { shiftKey: true });
    key('KeyD', { shiftKey: true });
    expect(ic.getControl().yawDeg).toBeCloseTo(0.3);
    ic.update(KEY_HOLD_DELAY_S / 2);
    ic.update(KEY_HOLD_DELAY_S / 2);
    for (let k = 0; k < 20; k++) ic.update(0.05);
    expect(ic.getControl().yawDeg).toBeCloseTo(0.3 + 18, 3);
    // clamps
    for (let k = 0; k < 20; k++) ic.update(0.1);
    keyUp('KeyD');
    key('KeyW');
    for (let k = 0; k < 100; k++) ic.update(0.1);
    expect(ic.getControl().pitchDeg).toBe(PITCH_LIMITS.min);
  });

  it('strokes, strength, actions, modifiers', () => {
    const { ic, actions, changes, key } = setup({ strength: 0.95 });
    key('Digit3');
    expect(ic.getControl().stroke).toBe('drive');
    key('KeyE');
    key('KeyE');
    expect(ic.getControl().strength).toBe(1);
    const n = changes.length;
    key('KeyE');
    expect(changes.length).toBe(n);
    for (let k = 0; k < 4; k++) key('KeyQ');
    expect(ic.getControl().strength).toBeCloseTo(0.6, 9);
    expect(key('Space')).toBe(true); // preventDefault (no page scroll)
    key('Space', { repeat: true });
    key('KeyR', { metaKey: true }); // Cmd+R stays a browser shortcut
    key('KeyV');
    key('Slash', { shiftKey: true });
    expect(actions).toEqual(['next', 'spincam', 'help']);
  });

  it('ignores typing targets; buttons do not double-activate', () => {
    const { ic, actions, key, keyUp } = setup();
    key('KeyW', { target: { tagName: 'INPUT', type: 'text' } });
    key('Space', { target: { tagName: 'TEXTAREA' } });
    expect(ic.getControl().pitchDeg).toBe(0);
    expect(actions).toEqual([]);
    const btn = { tagName: 'BUTTON' };
    expect(key('Space', { target: btn })).toBe(true);
    expect(keyUp('Space', { target: btn })).toBe(true);
    expect(actions).toEqual(['next']);
  });

  it('lock suppresses angles but not actions', () => {
    const { ic, actions, key, move, el } = setup();
    ic.setLocked(true);
    move(900, 50);
    key('KeyS');
    ic.update(1);
    el.emit('wheel', { deltaY: 100, deltaMode: 0, ctrlKey: false, shiftKey: false });
    expect(ic.getControl().pitchDeg).toBe(0);
    expect(ic.getControl().yawDeg).toBe(0);
    key('KeyC');
    expect(actions).toEqual(['camera']);
    ic.setLocked(false);
    move(899, 50);
    expect(ic.getControl().pitchDeg).toBe(PITCH_LIMITS.min);
  });

  it('wheel: ±2° per notch, preventDefault', () => {
    const { ic, el } = setup();
    expect(el.emit('wheel', { deltaY: 100, deltaMode: 0, ctrlKey: false, shiftKey: false })).toBe(true);
    expect(ic.getControl().pitchDeg).toBeCloseTo(2);
    el.emit('wheel', { deltaY: -3, deltaMode: 1, ctrlKey: false, shiftKey: false });
    expect(ic.getControl().pitchDeg).toBeCloseTo(0);
    el.emit('wheel', { deltaY: 50, deltaMode: 0, ctrlKey: false, shiftKey: false });
    expect(ic.getControl().pitchDeg).toBeCloseTo(0); // half a notch on a trackpad
    el.emit('wheel', { deltaY: 50, deltaMode: 0, ctrlKey: false, shiftKey: false });
    expect(ic.getControl().pitchDeg).toBeCloseTo(2);
  });

  it('manual mode uses the projector with clamping', () => {
    const { ic, move } = setup();
    ic.setAutoPosition(false);
    ic.setProjector((cx, cy) => ({ x: (cx - 500) / 100, y: TABLE_Y + (450 - cy) / 100 }));
    move(450, 400);
    expect(ic.getControl().x).toBeCloseTo(-0.5);
    expect(ic.getControl().y).toBeCloseTo(TABLE_Y + 0.5);
    expect(ic.getControl().pitchDeg).toBe(0);
    move(2000, 600);
    expect(ic.getControl().x).toBe(1);
    expect(ic.getControl().y).toBeCloseTo(TABLE_Y + 0.02);
  });

  it('setControl clamps silently; dispose removes listeners', () => {
    const { ic, changes, el, win } = setup();
    ic.setControl({ pitchDeg: 200, yawDeg: 10, stroke: 'push', strength: 0.3, x: 0, y: TABLE_Y + 0.3 });
    expect(ic.getControl().pitchDeg).toBe(PITCH_LIMITS.max);
    expect(changes.length).toBe(0);
    ic.dispose();
    expect(el.count() + win.count()).toBe(0);
  });
});

describe('Sfx in node', () => {
  it('no-ops safely without WebAudio', () => {
    const s = new Sfx();
    expect(() => {
      s.unlock();
      s.paddle(1);
      s.table(0.5);
      s.net();
      s.floor();
      s.success();
      s.fail();
      s.setEnabled(false);
      s.paddle(NaN);
    }).not.toThrow();
  });
});
