/**
 * Procedural WebAudio sound effects (no asset files). Safe to call before a user gesture and in
 * environments without WebAudio (Node/tests): every method silently no-ops.
 * The AudioContext is created lazily (on unlock() or the first sound) and resumed on unlock().
 */

type Ctor = new () => AudioContext;

const MAX_VOICES = 14;
/** identical sounds closer than this (s) are merged, e.g. double-reported contacts */
const MIN_REPEAT_S = 0.012;

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 0.5);

function audioCtor(): Ctor | null {
  const g = globalThis as unknown as { AudioContext?: Ctor; webkitAudioContext?: Ctor };
  return g.AudioContext ?? g.webkitAudioContext ?? null;
}

export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private enabled = true;
  private failed = false;
  private voices = 0;
  private lastPlayed = new Map<string, number>();

  /** master volume 0..1 */
  volume = 0.8;

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(on ? this.volume : 0, this.ctx.currentTime, 0.02);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** call on a user gesture to unlock audio */
  unlock(): void {
    const ctx = this.ensure();
    if (ctx && ctx.state !== 'running') void ctx.resume().catch(() => {});
  }

  /** paddle "tock": filtered noise click + resonant wooden body, louder/brighter with intensity */
  paddle(intensity: number): void {
    const i = clamp01(intensity);
    const v = this.begin('paddle', 0.09);
    if (!v) return;
    const { ctx, out, t } = v;
    const amp = 0.18 + 0.55 * i;
    this.noiseBurst(ctx, out, t, 0.022, 'bandpass', 1500 + 900 * i, 2.5, amp * 0.9);
    this.tone(ctx, out, t, 'sine', 1250 + 500 * i, 1150 + 400 * i, 0.05, amp * 0.6);
    this.tone(ctx, out, t, 'triangle', 190, 140, 0.06, amp * 0.35);
  }

  /** table "tick": brighter and shorter than the paddle */
  table(intensity: number): void {
    const i = clamp01(intensity);
    const v = this.begin('table', 0.05);
    if (!v) return;
    const { ctx, out, t } = v;
    const amp = 0.12 + 0.45 * i;
    this.noiseBurst(ctx, out, t, 0.012, 'highpass', 3000, 0.8, amp * 0.7);
    this.tone(ctx, out, t, 'sine', 2600 + 400 * i, 2400, 0.03, amp * 0.5);
    this.tone(ctx, out, t, 'sine', 420, 380, 0.035, amp * 0.25);
  }

  /** soft thud into the net */
  net(): void {
    const v = this.begin('net', 0.12);
    if (!v) return;
    const { ctx, out, t } = v;
    this.noiseBurst(ctx, out, t, 0.09, 'lowpass', 500, 0.7, 0.3);
    this.tone(ctx, out, t, 'sine', 130, 90, 0.1, 0.25);
  }

  /** dull bounce on the floor */
  floor(): void {
    const v = this.begin('floor', 0.12);
    if (!v) return;
    const { ctx, out, t } = v;
    this.tone(ctx, out, t, 'sine', 260, 150, 0.09, 0.28);
    this.noiseBurst(ctx, out, t, 0.03, 'lowpass', 900, 0.7, 0.15);
  }

  /** gentle ascending chime */
  success(): void {
    const v = this.begin('success', 0.7);
    if (!v) return;
    const { ctx, out, t } = v;
    const notes = [1046.5, 1318.5, 1568.0]; // C6 E6 G6
    notes.forEach((f, k) => {
      this.bell(ctx, out, t + k * 0.075, f, 0.45, 0.16);
      this.bell(ctx, out, t + k * 0.075, f * 2, 0.25, 0.03);
    });
  }

  /** gentle low "nope" buzz */
  fail(): void {
    const v = this.begin('fail', 0.45);
    if (!v) return;
    const { ctx, out, t } = v;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 900;
    lp.connect(out);
    this.tone(ctx, lp, t, 'sawtooth', 233, 220, 0.16, 0.09, 0.01);
    this.tone(ctx, lp, t + 0.17, 'sawtooth', 196, 175, 0.24, 0.09, 0.01);
  }

  // ───────────────────────────── internals

  private ensure(): AudioContext | null {
    if (this.ctx) return this.ctx;
    if (this.failed) return null;
    const C = audioCtor();
    if (!C) {
      this.failed = true;
      return null;
    }
    try {
      const ctx = new C();
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -12;
      comp.ratio.value = 6;
      comp.connect(ctx.destination);
      const master = ctx.createGain();
      master.gain.value = this.enabled ? this.volume : 0;
      master.connect(comp);
      const len = Math.floor(ctx.sampleRate * 0.5);
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let k = 0; k < len; k++) d[k] = Math.random() * 2 - 1;
      this.ctx = ctx;
      this.master = master;
      this.noise = buf;
      return ctx;
    } catch {
      this.failed = true;
      return null;
    }
  }

  /**
   * Start a voice: returns a per-voice output gain (auto-disconnected after `dur`) or null when
   * audio is unavailable/disabled/suspended, polyphony is full, or the same sound just played.
   */
  private begin(id: string, dur: number): { ctx: AudioContext; out: GainNode; t: number } | null {
    if (!this.enabled) return null;
    try {
      const ctx = this.ensure();
      if (!ctx || !this.master) return null;
      if (ctx.state === 'suspended') {
        void ctx.resume().catch(() => {});
        return null;
      }
      if (ctx.state !== 'running') return null;
      if (this.voices >= MAX_VOICES) return null;
      const t = ctx.currentTime;
      const last = this.lastPlayed.get(id);
      if (last !== undefined && t - last < MIN_REPEAT_S && t >= last) return null;
      this.lastPlayed.set(id, t);
      const out = ctx.createGain();
      out.gain.value = 1;
      out.connect(this.master);
      this.voices++;
      setTimeout(() => {
        this.voices = Math.max(0, this.voices - 1);
        try {
          out.disconnect();
        } catch {
          /* already gone */
        }
      }, (dur + 0.1) * 1000);
      return { ctx, out, t: t + 0.002 };
    } catch {
      return null;
    }
  }

  private envelope(ctx: AudioContext, t: number, dur: number, peak: number, attack = 0.001): GainNode {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(Math.max(peak, 0.0002), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(dur, attack + 0.002));
    return g;
  }

  private noiseBurst(
    ctx: AudioContext,
    out: AudioNode,
    t: number,
    dur: number,
    type: BiquadFilterType,
    freq: number,
    q: number,
    peak: number,
  ): void {
    if (!this.noise) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = this.envelope(ctx, t, dur, peak);
    src.connect(f).connect(g).connect(out);
    src.start(t, Math.random() * 0.3);
    src.stop(t + dur + 0.01);
  }

  private tone(
    ctx: AudioContext,
    out: AudioNode,
    t: number,
    type: OscillatorType,
    f0: number,
    f1: number,
    dur: number,
    peak: number,
    attack = 0.001,
  ): void {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(f1, 1), t + dur);
    const g = this.envelope(ctx, t, dur, peak, attack);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + dur + 0.01);
  }

  private bell(ctx: AudioContext, out: AudioNode, t: number, f: number, dur: number, peak: number): void {
    this.tone(ctx, out, t, 'sine', f, f, dur, peak, 0.008);
  }
}
