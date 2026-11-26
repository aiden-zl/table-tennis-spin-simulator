/**
 * Spin Lab DOM overlay: top bar + settings, custom shot panel, paddle HUD, shot banner,
 * result/coach card, stats chip, spin-cam box, help + welcome overlays, toasts.
 *
 * Plain TS + DOM. All dynamic strings go through textContent.
 * The overlay root is pointer-events:none so the 3D canvas keeps receiving mouse input;
 * only the panels themselves capture the pointer.
 */
import './styles.css';
import type {
  AssistLevel, ControlMode, OpponentMode, Pace, PaddleControl, RallyPhase, RallyResult, ShotPlan,
  ShotPreset, ShotSpec, SpinSpec, StatsSnapshot, StrokeType,
} from '../contracts';
import type { CameraView } from '../render/arena';
import { PITCH_LIMITS, STROKES, YAW_LIMITS } from '../game/playerStroke';
import { describeSpin, spinComponents } from '../physics/spin';
import { SPIN_COLORS } from '../render/ballView';
import { Segmented, Slider, Toggle, button, clamp, h, signed } from './components/dom';
import { AngleGauge, PitchDiagram, YawDiagram } from './components/diagrams';
import { PlacementPicker } from './components/miniTable';

export interface Settings {
  opponentMode: OpponentMode;
  controlMode: ControlMode;
  autoPosition: boolean;
  assist: AssistLevel;
  /** simulation speed multiplier: 1, 0.5, 0.25, 0.1 */
  timeScale: number;
  /** automatically serve the next ball after the result card */
  autoNext: boolean;
  /** show the ghost ideal paddle + ideal path in the result */
  showIdeal: boolean;
  /** show the spin-cam inset */
  showSpinCam: boolean;
  camera: CameraView;
  sound: boolean;
}

export interface UICallbacks {
  /** user pressed "Next ball" / Space when idle or after a result */
  onNextBall(): void;
  /** freeze mode: user pressed "Hit" */
  onResume(): void;
  onTogglePause(): void;
  onSettingsChange(settings: Settings): void;
  /** custom mode: the edited spec (already sanitised by UI using the provided sanitizer) */
  onCustomSpecChange(spec: ShotSpec): void;
  /** the user changed paddle control through the on-screen controls (sliders / stroke buttons) */
  onControlChange(control: PaddleControl): void;
  onResetStats(): void;
  /** replay the same ball again (same plan) */
  onRepeatBall(): void;
}

export interface UIInit {
  settings: Settings;
  customSpec: ShotSpec;
  presets: ShotPreset[];
  control: PaddleControl;
  sanitize(spec: ShotSpec): ShotSpec;
}

/**
 * Spin colour legend used by the overlay — taken from the ball visuals (SPIN_COLORS) so the
 * HUD, sliders, stats bars and spin-cam legend all match the 3D arrows/wind.
 */
export const UI_SPIN_COLORS = {
  topspin: SPIN_COLORS.topspin,
  backspin: SPIN_COLORS.backspin,
  /** curves toward the receiver's LEFT */
  sideLeft: SPIN_COLORS.sideLeft,
  /** curves toward the receiver's RIGHT */
  sideRight: SPIN_COLORS.sideRight,
  corkscrew: SPIN_COLORS.corkscrew,
} as const;

export const TIME_SCALES = [1, 0.5, 0.25, 0.1] as const;
export const CAMERA_VIEWS: CameraView[] = ['player', 'side', 'opponent'];
const CAMERA_LABEL: Record<CameraView, string> = { player: 'Player', side: 'Side', opponent: 'Opponent' };

const OUTCOME_LABEL: Record<string, string> = {
  in: 'IN',
  net: 'NET',
  long: 'LONG',
  wide: 'WIDE',
  'own-side': 'OWN SIDE',
  short: 'SHORT',
  miss: 'MISSED',
};

const CATEGORY_LABEL: Record<string, string> = {
  topspin: 'Topspin',
  backspin: 'Backspin',
  sidespin: 'Sidespin',
  'side-top': 'Side-top',
  'side-back': 'Side-back',
  nospin: 'No spin',
  corkscrew: 'Corkscrew',
  mixed: 'Mixed',
};

const WELCOME_KEY = 'spinlab.welcomed.v1';

function strokeLabel(id: StrokeType | undefined): string {
  return STROKES.find((s) => s.id === id)?.label ?? String(id ?? '');
}

/** Numeric spin readout from the receiver's point of view. */
export function spinNumbers(spin: SpinSpec): string {
  const parts: string[] = [];
  const top = Math.round(spin.topspin);
  parts.push(top === 0 ? 'Top/back 0 rps' : `${top > 0 ? 'Topspin' : 'Backspin'} ${Math.abs(top)} rps`);
  const recv = -spin.sidespin; // + = curves to the receiver's RIGHT
  if (Math.round(Math.abs(recv)) >= 1) {
    parts.push(`Side ${Math.round(Math.abs(recv))} rps (curves your ${recv > 0 ? 'right' : 'left'})`);
  } else {
    parts.push('Side 0');
  }
  if (Math.round(Math.abs(spin.corkscrew)) >= 1) parts.push(`Cork ${signed(spin.corkscrew)} rps`);
  return parts.join(' · ');
}

function pitchWord(p: number): string {
  if (Math.abs(p) < 3) return 'vertical';
  return p > 0 ? 'open' : 'closed';
}

/** Aim is table-relative: 0° points at the middle of the opponent's half from the contact point. */
function yawWord(y: number): string {
  if (Math.abs(y) < 3) return 'at the middle';
  return y > 0 ? 'right of middle' : 'left of middle';
}

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: ignore */
  }
}

/** DOM overlay: menus, HUD, custom spin panel, feedback card, stats, help. */
export class UI {
  private readonly root: HTMLElement;
  private readonly init: UIInit;
  private readonly cb: UICallbacks;

  private settings: Settings;
  private spec: ShotSpec;
  private control: PaddleControl;
  private phase: RallyPhase = 'idle';
  private paused = false;
  private activePresetId: string | null = null;
  private resultVisible = false;
  private lastShotKey = '';
  private lastPlan: ShotPlan | null = null;
  private lastReveal = false;
  private lastStatsKey = '';
  private toastTimer = 0;

  // top bar / settings
  private oppSeg!: Segmented<OpponentMode>;
  private ctrlSeg!: Segmented<ControlMode>;
  private settingsPanel!: HTMLDivElement;
  private settingsBtn!: HTMLButtonElement;
  private assistSeg!: Segmented<AssistLevel>;
  private speedSeg!: Segmented<number>;
  private camSeg!: Segmented<CameraView>;
  private toggles!: {
    autoPosition: Toggle; autoNext: Toggle; showIdeal: Toggle; showSpinCam: Toggle; sound: Toggle;
  };
  private speedChip!: HTMLSpanElement;
  private pausedChip!: HTMLSpanElement;

  // custom panel
  private customPanel!: HTMLDivElement;
  private presetButtons = new Map<string, HTMLButtonElement>();
  private presetDesc!: HTMLParagraphElement;
  private kindSeg!: Segmented<'serve' | 'rally'>;
  private paceSeg!: Segmented<Pace>;
  private topSlider!: Slider;
  private sideSlider!: Slider;
  private corkSlider!: Slider;
  private fromSlider!: Slider;
  private picker!: PlacementPicker;
  private specDesc!: HTMLDivElement;

  // HUD
  private strokeButtons = new Map<StrokeType, HTMLButtonElement>();
  private pitchDiagram!: PitchDiagram;
  private yawDiagram!: YawDiagram;
  private pitchReadout!: HTMLDivElement;
  private yawReadout!: HTMLDivElement;
  private pitchSlider!: Slider;
  private yawSlider!: Slider;
  private strengthSlider!: Slider;
  private strengthFill!: HTMLDivElement;
  private actionSlot!: HTMLDivElement;
  private hitBtn!: HTMLButtonElement;
  private nextBtn!: HTMLButtonElement;
  private phaseHint!: HTMLDivElement;

  // banner
  private banner!: HTMLDivElement;
  private bannerKicker!: HTMLDivElement;
  private bannerTitle!: HTMLDivElement;
  private bannerSub!: HTMLDivElement;

  // result
  private resultCard!: HTMLDivElement;
  private resChip!: HTMLSpanElement;
  private resHeadline!: HTMLHeadingElement;
  private resTips!: HTMLUListElement;
  private resPitchGauge!: AngleGauge;
  private resYawGauge!: AngleGauge;
  private resPitchText!: HTMLDivElement;
  private resYawText!: HTMLDivElement;
  private resWindowTitle!: HTMLDivElement;
  private resSuggest!: HTMLDivElement;
  private resSpin!: HTMLDivElement;
  private resSpinNums!: HTMLDivElement;
  private resForgive!: HTMLDivElement;

  // stats
  private statPct!: HTMLSpanElement;
  private statCount!: HTMLSpanElement;
  private statStreak!: HTMLSpanElement;
  private statRecent!: HTMLDivElement;
  private statCats!: HTMLDivElement;

  // spin cam
  private spinCamWrap!: HTMLDivElement;
  private spinCamBox!: HTMLDivElement;

  // overlays
  private helpOverlay!: HTMLDivElement;
  private welcomeOverlay!: HTMLDivElement;
  private toastEl!: HTMLDivElement;

  constructor(root: HTMLElement, init: UIInit, cb: UICallbacks) {
    this.root = root;
    this.init = init;
    this.cb = cb;
    this.settings = { ...init.settings };
    this.spec = this.safeSanitize(init.customSpec);
    this.control = { ...init.control };

    root.classList.add('sl-root');
    root.style.setProperty('--sl-top', UI_SPIN_COLORS.topspin);
    root.style.setProperty('--sl-back', UI_SPIN_COLORS.backspin);
    root.style.setProperty('--sl-side-l', UI_SPIN_COLORS.sideLeft);
    root.style.setProperty('--sl-side-r', UI_SPIN_COLORS.sideRight);
    root.style.setProperty('--sl-cork', UI_SPIN_COLORS.corkscrew);
    root.replaceChildren();

    root.appendChild(this.buildTopBar());
    root.appendChild(this.buildBanner());
    root.appendChild(this.buildCustomPanel());
    root.appendChild(this.buildStats());
    root.appendChild(this.buildResultCard());
    root.appendChild(this.buildSpinCam());
    root.appendChild(this.buildHud());
    this.toastEl = h('div', { class: 'sl-toast', attrs: { role: 'status', 'aria-live': 'polite' } });
    root.appendChild(this.toastEl);
    root.appendChild(this.buildHelp());
    root.appendChild(this.buildWelcome());

    document.addEventListener('pointerdown', (e) => {
      if (!this.settingsPanel.classList.contains('open')) return;
      const t = e.target as Node | null;
      if (t && (this.settingsPanel.contains(t) || this.settingsBtn.contains(t))) return;
      this.settingsPanel.classList.remove('open');
    });

    this.applySettingsView();
    this.refreshSpecControls();
    this.refreshControlView(true);
    this.updateActionSlot();
    this.showShotInfo(null, false);
    this.setStats({ total: { attempts: 0, made: 0 }, streak: 0, bestStreak: 0, byCategory: {}, recent: [] });

    if (readStorage(WELCOME_KEY) !== '1') this.welcomeOverlay.classList.add('open');
  }

  // ═════════════════════════════ public API

  /** reflect the current paddle control (from keyboard/mouse) in the HUD */
  setControl(control: PaddleControl): void {
    const prev = this.control;
    this.control = { ...control };
    if (
      prev.pitchDeg !== control.pitchDeg || prev.yawDeg !== control.yawDeg ||
      prev.stroke !== control.stroke || prev.strength !== control.strength
    ) {
      this.refreshControlView(false);
    }
  }

  setPhase(phase: RallyPhase): void {
    if (phase === this.phase) return;
    this.phase = phase;
    this.root.dataset.phase = phase;
    this.updateActionSlot();
  }

  setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    this.paused = paused;
    this.pausedChip.classList.toggle('show', paused);
    this.root.classList.toggle('sl-paused', paused);
  }

  /** shot banner; revealSpin=false in bot mode until the player has hit */
  showShotInfo(plan: ShotPlan | null, revealSpin: boolean): void {
    this.lastPlan = plan;
    this.lastReveal = revealSpin;
    const s = plan?.spec.spin;
    const key = plan
      ? `${plan.name}|${plan.spec.kind}|${plan.spec.pace}|${s?.topspin}|${s?.sidespin}|${s?.corkscrew}|${revealSpin}|${this.settings.opponentMode}`
      : `none|${this.settings.opponentMode}`;
    if (key === this.lastShotKey) return;
    this.lastShotKey = key;

    this.banner.classList.remove('hidden-spin', 'revealed');
    if (!plan) {
      this.bannerKicker.textContent = this.settings.opponentMode === 'bot' ? 'Bot mode' : 'Custom mode';
      this.bannerTitle.textContent = 'Press Space for the next ball';
      this.bannerSub.textContent =
        this.settings.opponentMode === 'bot'
          ? 'Random shots. Read the spin from the swing and the ball.'
          : 'Set up the opponent’s shot on the left, then play it.';
      return;
    }
    const kind = plan.spec.kind === 'serve' ? 'Serve' : 'Rally ball';
    const pace = plan.spec.pace.charAt(0).toUpperCase() + plan.spec.pace.slice(1);
    if (!revealSpin) {
      // Nothing that encodes the spin may leak here (plan.name is the spin text for bot shots).
      this.banner.classList.add('hidden-spin');
      this.bannerKicker.textContent = `${kind} · ${pace}`;
      this.bannerTitle.textContent = 'Read the spin…';
      this.bannerSub.textContent = 'Watch the opponent’s swing and the ball, then pick your angle.';
      return;
    }
    if (this.settings.opponentMode === 'bot') this.banner.classList.add('revealed');
    this.bannerKicker.textContent = this.settings.opponentMode === 'bot' ? `Revealed · ${kind} · ${pace}` : `${kind} · ${pace}`;
    this.bannerTitle.textContent = this.settings.opponentMode === 'bot' ? describeSpin(plan.spec.spin, 'receiver') : plan.name;
    this.bannerSub.textContent =
      this.settings.opponentMode === 'bot'
        ? spinNumbers(plan.spec.spin)
        : `${describeSpin(plan.spec.spin, 'receiver')} — ${spinNumbers(plan.spec.spin)}`;
  }

  showResult(result: RallyResult, plan: ShotPlan): void {
    const coach = result.coach;
    const outcome = result.outcome;
    const ok = outcome === 'in';
    this.resultCard.dataset.outcome = outcome;
    this.resChip.textContent = OUTCOME_LABEL[outcome] ?? String(outcome).toUpperCase();
    this.resHeadline.textContent = coach.headline || (ok ? 'Good return!' : 'Not quite');

    this.resTips.replaceChildren(...coach.tips.map((t) => h('li', { text: t })));
    this.resTips.style.display = coach.tips.length ? '' : 'none';

    const usedStroke = result.control.stroke;
    this.resultCard.classList.toggle('pending', !!result.coachPending);
    if (result.coachPending) {
      // the coach is still searching (it runs in a worker); showResult is called again with it
      this.resTips.replaceChildren(h('li', { text: 'Working out which angles would have worked…' }));
      this.resTips.style.display = '';
      this.resWindowTitle.textContent = `Passing window for your ${strokeLabel(usedStroke)} — calculating…`;
      this.resPitchGauge.set(null, result.control.pitchDeg, ok);
      this.resYawGauge.set(null, result.control.yawDeg, ok);
      this.resPitchText.textContent = `Pitch: you ${signed(result.control.pitchDeg)}° (${pitchWord(result.control.pitchDeg)})`;
      this.resYawText.textContent = `Aim: you ${signed(result.control.yawDeg)}° (${yawWord(result.control.yawDeg)})`;
      this.resForgive.textContent = '';
      this.resSuggest.style.display = 'none';
      this.fillSpin(result, plan);
      this.openResult();
      return;
    }
    const win = coach.ideal ?? coach.suggestedWindow ?? null;
    const winStroke = coach.ideal ? usedStroke : coach.suggestedStroke;
    if (coach.ideal) {
      this.resWindowTitle.textContent = `Passing window for your ${strokeLabel(usedStroke)}`;
    } else if (win && winStroke) {
      const st = coach.suggestedStrength !== undefined ? ` at ${Math.round(coach.suggestedStrength * 100)}% strength` : '';
      this.resWindowTitle.textContent =
        winStroke === usedStroke
          ? `No ${strokeLabel(usedStroke)} angle works at your strength — window${st}`
          : `No angle works with ${strokeLabel(usedStroke)} — window for ${strokeLabel(winStroke)}${st}`;
    } else {
      this.resWindowTitle.textContent = `No passing angle found for ${strokeLabel(usedStroke)}`;
    }
    const yourP = result.control.pitchDeg;
    const yourY = result.control.yawDeg;
    this.resPitchGauge.set(win ? { lo: win.pitchMin, hi: win.pitchMax, best: win.bestPitch } : null, yourP, ok);
    this.resYawGauge.set(win ? { lo: win.yawMin, hi: win.yawMax, best: win.bestYaw } : null, yourY, ok);
    this.resPitchText.textContent = win
      ? `Pitch: you ${signed(yourP)}° (${pitchWord(yourP)}) · ideal ${signed(win.bestPitch)}° (${signed(win.pitchMin)}…${signed(win.pitchMax)} at ideal aim)${this.errText(coach.pitchError, 'open', 'closed', ok)}`
      : `Pitch: you ${signed(yourP)}° (${pitchWord(yourP)})`;
    this.resYawText.textContent = win
      ? `Aim: you ${signed(yourY)}° (${yawWord(yourY)}) · ideal ${signed(win.bestYaw)}° (${signed(win.yawMin)}…${signed(win.yawMax)} at ideal pitch)${this.errText(coach.yawError, 'right', 'left', ok)}`
      : `Aim: you ${signed(yourY)}° (${yawWord(yourY)})`;
    this.resForgive.textContent = win
      ? `Forgiveness (${strokeLabel(winStroke)}): ${win.forgiveness < 0.001 ? 'under 0.1' : (win.forgiveness * 100).toFixed(1)}% of all pitch × aim combinations land — ${win.forgiveness < 0.02 ? 'a tough ball' : win.forgiveness < 0.06 ? 'needs precision' : 'fairly forgiving'}`
      : '';

    if (coach.suggestedStroke && coach.suggestedStroke !== usedStroke) {
      const st = coach.suggestedStrength !== undefined ? `, ${Math.round(coach.suggestedStrength * 100)}% strength` : '';
      this.resSuggest.textContent = `Try a ${strokeLabel(coach.suggestedStroke)} (key ${STROKES.find((s) => s.id === coach.suggestedStroke)?.key ?? '?'}${st}) for this ball.`;
      this.resSuggest.style.display = '';
    } else if (coach.suggestedStroke && coach.suggestedStrength !== undefined) {
      this.resSuggest.textContent = `Swing at ${Math.round(coach.suggestedStrength * 100)}% strength (Q / E) for this ball.`;
      this.resSuggest.style.display = '';
    } else {
      this.resSuggest.style.display = 'none';
    }

    this.fillSpin(result, plan);
    this.openResult();
  }

  private fillSpin(result: RallyResult, plan: ShotPlan): void {
    // Spin decays in flight and the bounce changes it, so show what actually reached the bat
    // (this is what the coach analysed) next to what the opponent put on the ball.
    const atBat = spinComponents(result.contactState.w, result.contactState.v);
    this.resSpin.textContent = `At your bat: ${describeSpin(atBat, 'receiver')}`;
    this.resSpinNums.textContent = `${spinNumbers(atBat)}\nOff their bat: ${spinNumbers(plan.spec.spin)} (flight and bounce change it)`;
  }

  private openResult(): void {
    this.resultVisible = true;
    this.resultCard.classList.add('open');
    this.root.classList.add('result-open');
    this.updateActionSlot();
  }

  isResultOpen(): boolean {
    return this.resultVisible;
  }

  hideResult(): void {
    this.resultVisible = false;
    this.resultCard.classList.remove('open');
    this.root.classList.remove('result-open');
    this.updateActionSlot();
  }

  setStats(stats: StatsSnapshot): void {
    const key = JSON.stringify(stats);
    if (key === this.lastStatsKey) return;
    this.lastStatsKey = key;
    const { attempts, made } = stats.total;
    this.statPct.textContent = attempts ? `${Math.round((made / attempts) * 100)}%` : '—';
    this.statCount.textContent = `${made}/${attempts}`;
    this.statStreak.textContent = `Streak ${stats.streak} · Best ${stats.bestStreak}`;
    this.statRecent.replaceChildren(
      ...stats.recent.slice(-20).map((o) =>
        h('span', { class: `sl-dot ${o === 'in' ? 'ok' : 'bad'}`, title: OUTCOME_LABEL[o] ?? String(o) }),
      ),
    );
    const cats = Object.entries(stats.byCategory).filter(([, b]) => b.attempts > 0);
    this.statCats.replaceChildren(
      ...cats.map(([cat, b]) => {
        const pct = b.attempts ? b.made / b.attempts : 0;
        const fill = h('div', { class: 'sl-bar-fill' });
        fill.style.width = `${Math.round(pct * 100)}%`;
        fill.dataset.cat = cat;
        return h('div', { class: 'sl-cat' }, [
          h('span', { class: 'sl-cat-name', text: CATEGORY_LABEL[cat] ?? cat }),
          h('div', { class: 'sl-bar' }, [fill]),
          h('span', { class: 'sl-cat-num', text: `${b.made}/${b.attempts}` }),
        ]);
      }),
    );
    this.statCats.style.display = cats.length ? '' : 'none';
  }

  /** short transient message (e.g. "Slow-mo 0.25x") */
  toast(msg: string): void {
    this.toastEl.textContent = msg;
    this.toastEl.classList.add('show');
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.remove('show'), 1800);
  }

  getSettings(): Settings {
    return { ...this.settings };
  }

  /** element in which the SpinInspector canvas lives (≈220×220, never cleared by the UI) */
  spinCamContainer(): HTMLElement {
    return this.spinCamBox;
  }

  // ── extra public helpers for main.ts (keyboard actions that have no UI-owned listener)

  /** Update settings from outside (e.g. keyboard). Reflects them in the UI; emits onSettingsChange only if emit=true. */
  setSettings(partial: Partial<Settings>, emit = false): void {
    this.settings = { ...this.settings, ...partial };
    this.applySettingsView();
    if (emit) this.cb.onSettingsChange(this.getSettings());
  }

  /** T key: cycle 1 → 0.5 → 0.25 → 0.1 → 1. Emits onSettingsChange and toasts. */
  cycleTimeScale(): number {
    const i = TIME_SCALES.findIndex((s) => Math.abs(s - this.settings.timeScale) < 1e-6);
    const next = TIME_SCALES[(i + 1) % TIME_SCALES.length];
    this.setSettings({ timeScale: next }, true);
    this.toast(next === 1 ? 'Normal speed' : `Slow-mo ${next}×`);
    return next;
  }

  /** C key: cycle camera view. Emits onSettingsChange and toasts. */
  cycleCamera(): CameraView {
    const i = CAMERA_VIEWS.indexOf(this.settings.camera);
    const next = CAMERA_VIEWS[(i + 1) % CAMERA_VIEWS.length];
    this.setSettings({ camera: next }, true);
    this.toast(`Camera: ${CAMERA_LABEL[next]} view`);
    return next;
  }

  /** V key: toggle the spin cam. Emits onSettingsChange. */
  toggleSpinCam(): boolean {
    const v = !this.settings.showSpinCam;
    this.setSettings({ showSpinCam: v }, true);
    this.toast(v ? 'Spin cam on' : 'Spin cam off');
    return v;
  }

  /** H key: toggle the help overlay (force to set explicitly). */
  toggleHelp(force?: boolean): void {
    const open = force ?? !this.helpOverlay.classList.contains('open');
    this.helpOverlay.classList.toggle('open', open);
    if (open && this.welcomeOverlay.classList.contains('open')) {
      // opening help from the welcome card counts as having seen it
      writeStorage(WELCOME_KEY, '1');
      this.welcomeOverlay.classList.remove('open');
    }
  }

  /** close the help and welcome overlays; closing the welcome card counts as seen */
  closeOverlays(): void {
    if (this.welcomeOverlay.classList.contains('open')) writeStorage(WELCOME_KEY, '1');
    this.welcomeOverlay.classList.remove('open');
    this.helpOverlay.classList.remove('open');
  }

  isHelpOpen(): boolean {
    return this.helpOverlay.classList.contains('open') || this.welcomeOverlay.classList.contains('open');
  }

  /** Replace the custom spec from outside (no callback). */
  setCustomSpec(spec: ShotSpec): void {
    this.spec = this.safeSanitize(spec);
    this.activePresetId = null;
    this.refreshSpecControls();
  }

  // ═════════════════════════════ internals: settings

  private emitSettings(partial: Partial<Settings>): void {
    this.setSettings(partial, true);
  }

  private applySettingsView(): void {
    const s = this.settings;
    this.oppSeg.set(s.opponentMode);
    this.ctrlSeg.set(s.controlMode);
    this.assistSeg.set(s.assist);
    this.speedSeg.set(s.timeScale);
    this.camSeg.set(s.camera);
    this.toggles.autoPosition.set(s.autoPosition);
    this.toggles.autoNext.set(s.autoNext);
    this.toggles.showIdeal.set(s.showIdeal);
    this.toggles.showSpinCam.set(s.showSpinCam);
    this.toggles.sound.set(s.sound);
    this.root.dataset.opponent = s.opponentMode;
    this.root.dataset.control = s.controlMode;
    this.root.dataset.spincam = s.showSpinCam ? 'on' : 'off';
    this.customPanel.classList.toggle('hidden', s.opponentMode !== 'custom');
    this.spinCamWrap.classList.toggle('off', !s.showSpinCam);
    this.speedChip.textContent = `${s.timeScale}×`;
    this.speedChip.classList.toggle('show', s.timeScale !== 1);
    this.updateActionSlot();
    if (this.banner) this.showShotInfo(this.lastPlan, this.lastReveal); // mode changes how the banner reads
  }

  // ═════════════════════════════ internals: custom spec

  private safeSanitize(spec: ShotSpec): ShotSpec {
    const copy: ShotSpec = { ...spec, spin: { ...spec.spin }, target: { ...spec.target } };
    try {
      const s = this.init.sanitize(copy);
      return { ...s, spin: { ...s.spin }, target: { ...s.target } };
    } catch {
      return copy;
    }
  }

  private applySpec(next: ShotSpec, presetId: string | null = null): void {
    this.spec = this.safeSanitize(next);
    this.activePresetId = presetId;
    this.refreshSpecControls();
    this.cb.onCustomSpecChange({ ...this.spec, spin: { ...this.spec.spin }, target: { ...this.spec.target } });
  }

  private editSpec(mut: (s: ShotSpec) => void): void {
    const s: ShotSpec = { ...this.spec, spin: { ...this.spec.spin }, target: { ...this.spec.target } };
    mut(s);
    this.applySpec(s, null);
  }

  private refreshSpecControls(): void {
    const s = this.spec;
    this.kindSeg.set(s.kind);
    this.paceSeg.set(s.pace);
    this.topSlider.set(s.spin.topspin);
    this.sideSlider.set(-s.spin.sidespin); // slider shows the RECEIVER's view (+ = curves to your right)
    this.corkSlider.set(s.spin.corkscrew);
    this.fromSlider.set(s.fromX);
    this.picker.set(s.target);
    this.picker.setFrom(s.fromX);
    this.specDesc.textContent = describeSpin(s.spin, 'receiver');
    for (const [id, b] of this.presetButtons) b.classList.toggle('active', id === this.activePresetId);
    const preset = this.init.presets.find((p) => p.id === this.activePresetId);
    this.presetDesc.textContent = preset ? preset.description : 'Pick a preset, or shape your own shot below.';
  }

  // ═════════════════════════════ internals: paddle control

  private emitControl(partial: Partial<PaddleControl>): void {
    this.control = { ...this.control, ...partial };
    this.refreshControlView(false);
    this.cb.onControlChange({ ...this.control });
  }

  private refreshControlView(force: boolean): void {
    const c = this.control;
    this.pitchDiagram.set(c.pitchDeg);
    this.yawDiagram.set(c.yawDeg);
    this.pitchReadout.textContent = `${signed(c.pitchDeg)}° ${pitchWord(c.pitchDeg)}`;
    this.yawReadout.textContent = `${signed(c.yawDeg)}° ${yawWord(c.yawDeg)}`;
    this.pitchReadout.dataset.dir = Math.abs(c.pitchDeg) < 3 ? 'neutral' : c.pitchDeg > 0 ? 'open' : 'closed';
    this.pitchSlider.set(c.pitchDeg, force);
    this.yawSlider.set(c.yawDeg, force);
    this.strengthSlider.set(Math.round(c.strength * 100), force);
    this.strengthFill.style.width = `${Math.round(clamp(c.strength, 0, 1) * 100)}%`;
    for (const [id, b] of this.strokeButtons) {
      const on = id === c.stroke;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    }
  }

  private updateActionSlot(): void {
    if (!this.actionSlot) return;
    const frozen = this.phase === 'frozen';
    const showHit = frozen;
    const showNext = !showHit && (this.phase === 'idle' || (this.phase === 'result' && !this.resultVisible));
    this.hitBtn.classList.toggle('show', showHit);
    this.nextBtn.classList.toggle('show', showNext);
    let hint = '';
    if (showHit) hint = 'Frozen — set your angle, then hit';
    else if (this.phase === 'windup') hint = 'Watch the opponent’s swing…';
    else if (this.phase === 'incoming') hint = this.settings.controlMode === 'freeze' ? 'Ball incoming — it will pause before contact' : 'Ball incoming — set your angle!';
    this.phaseHint.textContent = hint;
    this.phaseHint.classList.toggle('show', hint !== '');
  }

  private errText(err: number | undefined, plusWord: string, minusWord: string, landed = false): string {
    if (err === undefined || !Number.isFinite(err) || Math.abs(err) < 1) return '';
    // a return that landed wasn't "too" anything: just say how far from the safest angle it was
    if (landed) return ` — ${Math.round(Math.abs(err))}° more ${err > 0 ? plusWord : minusWord} than the safest`;
    return ` — ${Math.round(Math.abs(err))}° too ${err > 0 ? plusWord : minusWord}`;
  }

  // ═════════════════════════════ builders

  private buildTopBar(): HTMLElement {
    const brand = h('div', { class: 'sl-brand' }, [
      h('span', { class: 'sl-logo', attrs: { 'aria-hidden': 'true' } }),
      h('span', { class: 'sl-brand-name', text: 'Spin Lab' }),
    ]);

    this.oppSeg = new Segmented<OpponentMode>(
      [
        { value: 'custom', label: 'Custom', title: 'Design the opponent’s shot yourself; spin is shown' },
        { value: 'bot', label: 'Bot', title: 'Random shots; read the spin yourself (revealed after your return)' },
      ],
      this.settings.opponentMode,
      (v) => {
        this.emitSettings({ opponentMode: v });
        this.toast(v === 'bot' ? 'Bot mode — read the spin!' : 'Custom mode');
      },
    );
    this.ctrlSeg = new Segmented<ControlMode>(
      [
        { value: 'realtime', label: 'Real-time', title: 'Play at speed: set your angle while the ball flies' },
        { value: 'freeze', label: 'Freeze-frame', title: 'The ball pauses just before contact so you can adjust, then press Hit' },
      ],
      this.settings.controlMode,
      (v) => this.emitSettings({ controlMode: v }),
    );

    this.speedChip = h('span', { class: 'sl-chip sl-speed-chip', title: 'Simulation speed (T)' });
    this.pausedChip = h('span', { class: 'sl-chip sl-paused-chip', text: 'Paused' });
    const pauseBtn = button('❚❚', 'sl-icon-btn', () => this.cb.onTogglePause(), 'Pause / resume (P)');
    this.settingsBtn = button('⚙', 'sl-icon-btn', () => this.settingsPanel.classList.toggle('open'), 'Settings');
    const helpBtn = button('?', 'sl-icon-btn', () => this.toggleHelp(), 'Help & controls (H)');

    const bar = h('div', { class: 'sl-topbar sl-glass' }, [
      brand,
      h('div', { class: 'sl-topbar-group' }, [h('span', { class: 'sl-group-label', text: 'Opponent' }), this.oppSeg.el]),
      h('div', { class: 'sl-topbar-group' }, [h('span', { class: 'sl-group-label', text: 'Control' }), this.ctrlSeg.el]),
      h('div', { class: 'sl-topbar-right' }, [this.pausedChip, this.speedChip, pauseBtn, this.settingsBtn, helpBtn]),
    ]);

    // settings popover
    this.assistSeg = new Segmented<AssistLevel>(
      [
        { value: 'full', label: 'Full', title: 'Spin arrows + wind + ball markings' },
        { value: 'wind', label: 'Wind', title: 'Airflow streaks + ball markings' },
        { value: 'ball', label: 'Ball only', title: 'Only the ball’s logo rotation — like a real match' },
      ],
      this.settings.assist,
      (v) => this.emitSettings({ assist: v }),
    );
    this.speedSeg = new Segmented<number>(
      TIME_SCALES.map((s) => ({ value: s, label: `${s}×` })),
      this.settings.timeScale,
      (v) => this.emitSettings({ timeScale: v }),
    );
    this.camSeg = new Segmented<CameraView>(
      CAMERA_VIEWS.map((v) => ({ value: v, label: CAMERA_LABEL[v] })),
      this.settings.camera,
      (v) => this.emitSettings({ camera: v }),
    );
    this.toggles = {
      autoPosition: new Toggle('Auto-position paddle', this.settings.autoPosition, (v) => this.emitSettings({ autoPosition: v }), 'Only angles & stroke are yours'),
      autoNext: new Toggle('Auto next ball', this.settings.autoNext, (v) => this.emitSettings({ autoNext: v }), 'Serve again after each result'),
      showIdeal: new Toggle('Show ideal return', this.settings.showIdeal, (v) => this.emitSettings({ showIdeal: v }), 'Ghost paddle + ideal path'),
      showSpinCam: new Toggle('Spin cam', this.settings.showSpinCam, (v) => this.emitSettings({ showSpinCam: v }), 'Close-up of the ball (V)'),
      sound: new Toggle('Sound', this.settings.sound, (v) => this.emitSettings({ sound: v })),
    };
    const row = (label: string, ctl: HTMLElement, hint?: string) =>
      h('div', { class: 'sl-set-row' }, [
        h('div', { class: 'sl-set-label' }, [h('span', { text: label }), hint ? h('small', { text: hint }) : null]),
        ctl,
      ]);
    const resetBtn = button('Reset stats', 'sl-btn-ghost sl-btn-danger', () => {
      this.cb.onResetStats();
      this.toast('Stats reset');
    });
    this.settingsPanel = h('div', { class: 'sl-settings sl-glass sl-card', attrs: { role: 'dialog', 'aria-label': 'Settings' } }, [
      h('h3', { text: 'Settings' }),
      row('Assist level', this.assistSeg.el, 'Bot mode spin visuals'),
      row('Speed', this.speedSeg.el, 'T to cycle'),
      row('Camera', this.camSeg.el, 'C to cycle'),
      h('div', { class: 'sl-set-toggles' }, [
        this.toggles.autoPosition.el, this.toggles.autoNext.el, this.toggles.showIdeal.el,
        this.toggles.showSpinCam.el, this.toggles.sound.el,
      ]),
      h('div', { class: 'sl-set-foot' }, [resetBtn]),
    ]);

    return h('div', { class: 'sl-top' }, [bar, this.settingsPanel]);
  }

  private buildBanner(): HTMLElement {
    this.bannerKicker = h('div', { class: 'sl-banner-kicker' });
    this.bannerTitle = h('div', { class: 'sl-banner-title' });
    this.bannerSub = h('div', { class: 'sl-banner-sub' });
    this.banner = h('div', { class: 'sl-banner sl-glass' }, [this.bannerKicker, this.bannerTitle, this.bannerSub]);
    return this.banner;
  }

  private buildCustomPanel(): HTMLElement {
    const collapseBtn = button('–', 'sl-icon-btn sl-collapse', () => {
      const c = this.customPanel.classList.toggle('collapsed');
      collapseBtn.textContent = c ? '+' : '–';
      collapseBtn.title = c ? 'Expand' : 'Collapse';
    }, 'Collapse');
    const head = h('div', { class: 'sl-panel-head' }, [
      h('div', {}, [h('div', { class: 'sl-kicker', text: 'Custom mode' }), h('h3', { text: 'Opponent’s shot' })]),
      collapseBtn,
    ]);

    // presets
    const presetList = h('div', { class: 'sl-presets' });
    for (const p of this.init.presets) {
      const b = button(p.name, 'sl-preset', () => this.applySpec(p.spec, p.id), p.description);
      this.presetButtons.set(p.id, b);
      presetList.appendChild(b);
    }
    this.presetDesc = h('p', { class: 'sl-preset-desc' });
    const presetsSection = this.init.presets.length
      ? h('div', { class: 'sl-section' }, [h('div', { class: 'sl-section-title', text: 'Presets' }), presetList, this.presetDesc])
      : h('div', { class: 'sl-section' }, [this.presetDesc]);

    this.kindSeg = new Segmented<'serve' | 'rally'>(
      [{ value: 'serve', label: 'Serve' }, { value: 'rally', label: 'Rally' }],
      this.spec.kind,
      (v) => this.editSpec((s) => (s.kind = v)),
    );
    this.paceSeg = new Segmented<Pace>(
      [{ value: 'slow', label: 'Slow' }, { value: 'medium', label: 'Medium' }, { value: 'fast', label: 'Fast' }],
      this.spec.pace,
      (v) => this.editSpec((s) => (s.pace = v)),
    );

    const rps = (v: number) => `${signed(v)} rps`;
    this.topSlider = new Slider({
      label: 'Backspin ←→ Topspin', min: -60, max: 60, step: 1, value: this.spec.spin.topspin,
      format: (v) => (Math.round(v) === 0 ? '0 rps' : `${Math.abs(Math.round(v))} rps ${v > 0 ? 'top' : 'back'}`),
      leftHint: 'floats, checks', rightHint: 'dips, kicks',
      tint: 'tint-topback',
      onInput: (v) => this.editSpec((s) => (s.spin.topspin = v)),
    });
    this.sideSlider = new Slider({
      label: 'Sidespin (as you see it)', min: -60, max: 60, step: 1, value: -this.spec.spin.sidespin,
      format: (v) => (Math.round(v) === 0 ? '0 rps' : `${Math.abs(Math.round(v))} rps ${v > 0 ? '→ right' : '← left'}`),
      leftHint: '← curves to your left', rightHint: 'curves to your right →',
      tint: 'tint-side',
      // receiver's right (+) = curves to the LEFT of travel  =>  SpinSpec.sidespin = -value
      onInput: (v) => this.editSpec((s) => (s.spin.sidespin = -v)),
    });
    this.corkSlider = new Slider({
      label: 'Corkscrew', min: -40, max: 40, step: 1, value: this.spec.spin.corkscrew,
      format: rps, leftHint: '− against travel', rightHint: 'along travel +',
      onInput: (v) => this.editSpec((s) => (s.spin.corkscrew = v)),
    });
    this.specDesc = h('div', { class: 'sl-spec-desc' });

    this.picker = new PlacementPicker(this.spec.target, (t) => this.editSpec((s) => (s.target = t)));
    this.fromSlider = new Slider({
      label: 'Opponent hits from', min: -0.6, max: 0.6, step: 0.05, value: this.spec.fromX,
      format: (v) => (Math.abs(v) < 0.08 ? 'middle' : `${Math.abs(v).toFixed(2)} m ${v > 0 ? 'your right' : 'your left'}`),
      leftHint: 'your left', rightHint: 'your right',
      onInput: (v) => this.editSpec((s) => (s.fromX = v)),
    });

    const body = h('div', { class: 'sl-panel-body' }, [
      presetsSection,
      h('div', { class: 'sl-section sl-two' }, [
        h('div', {}, [h('div', { class: 'sl-section-title', text: 'Shot' }), this.kindSeg.el]),
        h('div', {}, [h('div', { class: 'sl-section-title', text: 'Pace' }), this.paceSeg.el]),
      ]),
      h('div', { class: 'sl-section' }, [
        h('div', { class: 'sl-section-title', text: 'Spin' }),
        this.topSlider.el, this.sideSlider.el, this.corkSlider.el, this.specDesc,
      ]),
      h('div', { class: 'sl-section' }, [
        h('div', { class: 'sl-section-title', text: 'Placement — click your half' }),
        this.picker.el,
        this.fromSlider.el,
      ]),
    ]);

    this.customPanel = h('div', { class: 'sl-custom sl-glass sl-card' }, [head, body]);
    return this.customPanel;
  }

  private buildStats(): HTMLElement {
    this.statPct = h('span', { class: 'sl-stat-pct', text: '—' });
    this.statCount = h('span', { class: 'sl-stat-count' });
    this.statStreak = h('span', { class: 'sl-stat-streak' });
    this.statRecent = h('div', { class: 'sl-recent' });
    this.statCats = h('div', { class: 'sl-cats' });
    return h('div', { class: 'sl-stats sl-glass' }, [
      h('div', { class: 'sl-stats-main' }, [
        h('div', { class: 'sl-stats-num' }, [this.statPct, h('span', { class: 'sl-stats-cap', text: 'returns in' })]),
        h('div', { class: 'sl-stats-side' }, [this.statCount, this.statStreak]),
      ]),
      this.statRecent,
      this.statCats,
    ]);
  }

  private buildResultCard(): HTMLElement {
    this.resChip = h('span', { class: 'sl-res-chip' });
    this.resHeadline = h('h2', { class: 'sl-res-headline' });
    this.resTips = h('ul', { class: 'sl-res-tips' });
    this.resWindowTitle = h('div', { class: 'sl-section-title' });
    this.resPitchGauge = new AngleGauge(PITCH_LIMITS.min, PITCH_LIMITS.max, '← closed', 'open →');
    this.resYawGauge = new AngleGauge(YAW_LIMITS.min, YAW_LIMITS.max, '← aim left', 'aim right →');
    this.resPitchText = h('div', { class: 'sl-res-angle' });
    this.resYawText = h('div', { class: 'sl-res-angle' });
    this.resForgive = h('div', { class: 'sl-res-forgive' });
    this.resSuggest = h('div', { class: 'sl-res-suggest' });
    this.resSpin = h('div', { class: 'sl-res-spin' });
    this.resSpinNums = h('div', { class: 'sl-res-spin-nums' });

    const legend = h('div', { class: 'sl-gauge-legend' }, [
      h('span', { class: 'lg lg-band', text: 'passing window' }),
      h('span', { class: 'lg lg-best', text: 'best' }),
      h('span', { class: 'lg lg-you', text: 'you' }),
    ]);

    const nextBtn = button('Next ball', 'sl-btn-primary', () => this.cb.onNextBall(), 'Next ball (Space)');
    nextBtn.appendChild(h('kbd', { text: 'Space' }));
    const repeatBtn = button('Repeat ball', 'sl-btn-ghost', () => this.cb.onRepeatBall(), 'Repeat the same ball (R)');
    repeatBtn.appendChild(h('kbd', { text: 'R' }));
    const closeBtn = button('×', 'sl-icon-btn sl-res-close', () => this.hideResult(), 'Hide');

    this.resultCard = h('div', { class: 'sl-result sl-glass sl-card', attrs: { role: 'region', 'aria-label': 'Result' } }, [
      h('div', { class: 'sl-res-top' }, [this.resChip, closeBtn]),
      this.resHeadline,
      // the spin reveal comes first: reading it is the point of the trainer
      h('div', { class: 'sl-res-spinbox' }, [this.resSpin, this.resSpinNums]),
      this.resTips,
      this.resSuggest,
      h('div', { class: 'sl-section' }, [
        this.resWindowTitle,
        this.resForgive,
        this.resPitchGauge.el, this.resPitchText,
        this.resYawGauge.el, this.resYawText,
        legend,
      ]),
      h('div', { class: 'sl-res-actions' }, [nextBtn, repeatBtn]),
    ]);
    return this.resultCard;
  }

  private buildSpinCam(): HTMLElement {
    this.spinCamBox = h('div', { class: 'sl-spincam-box' });
    const sw = (color: string, label: string) => {
      const s = h('span', { class: 'sl-swatch' });
      s.style.background = color;
      return h('span', { class: 'sl-legend-item' }, [s, h('span', { text: label })]);
    };
    const legend = h('div', { class: 'sl-legend' }, [
      sw(UI_SPIN_COLORS.topspin, 'Topspin'),
      sw(UI_SPIN_COLORS.backspin, 'Backspin'),
      sw(UI_SPIN_COLORS.corkscrew, 'Corkscrew'),
      sw(UI_SPIN_COLORS.sideLeft, 'Curves \u2190 your left'),
      sw(UI_SPIN_COLORS.sideRight, 'Curves your right \u2192'),
    ]);
    this.spinCamWrap = h('div', { class: 'sl-spincam sl-glass' }, [
      h('div', { class: 'sl-spincam-head' }, [
        h('span', { class: 'sl-kicker', text: 'Spin cam' }),
        h('span', { class: 'sl-spincam-cap', text: 'Ball close-up, flying toward you' }),
      ]),
      this.spinCamBox,
      legend,
    ]);
    return this.spinCamWrap;
  }

  private buildHud(): HTMLElement {
    // stroke buttons
    const strokes = h('div', { class: 'sl-strokes' });
    for (const s of STROKES) {
      const b = button('', 'sl-stroke', () => this.emitControl({ stroke: s.id }), `${s.label} (${s.key}) — ${s.blurb}`);
      b.appendChild(h('kbd', { text: s.key }));
      b.appendChild(h('span', { text: s.label }));
      this.strokeButtons.set(s.id, b);
      strokes.appendChild(b);
    }
    this.strengthFill = h('div', { class: 'sl-strength-fill' });
    this.strengthSlider = new Slider({
      label: 'Strength', min: 0, max: 100, step: 1, value: Math.round(this.control.strength * 100),
      format: (v) => `${Math.round(v)}%`, leftHint: 'Q soft', rightHint: 'hard E',
      onInput: (v) => this.emitControl({ strength: v / 100 }),
    });
    const strokeBlock = h('div', { class: 'sl-hud-block sl-hud-strokes' }, [
      h('div', { class: 'sl-hud-title', text: 'Stroke' }),
      strokes,
      h('div', { class: 'sl-strength-bar' }, [this.strengthFill]),
      this.strengthSlider.el,
    ]);

    // pitch
    this.pitchDiagram = new PitchDiagram();
    this.pitchReadout = h('div', { class: 'sl-angle-readout' });
    this.pitchSlider = new Slider({
      label: 'Face', min: PITCH_LIMITS.min, max: PITCH_LIMITS.max, step: 1, value: this.control.pitchDeg,
      format: (v) => `${signed(v)}°`, leftHint: 'closed (W)', rightHint: '(S) open',
      onInput: (v) => this.emitControl({ pitchDeg: v }),
    });
    const pitchBlock = h('div', { class: 'sl-hud-block sl-hud-angle' }, [
      h('div', { class: 'sl-hud-title' }, [h('span', { text: 'Face tilt' }), this.pitchReadout]),
      h('div', { class: 'sl-angle-row' }, [this.pitchDiagram.el]),
      this.pitchSlider.el,
    ]);

    // yaw
    this.yawDiagram = new YawDiagram();
    this.yawReadout = h('div', { class: 'sl-angle-readout' });
    this.yawSlider = new Slider({
      label: 'Aim', min: YAW_LIMITS.min, max: YAW_LIMITS.max, step: 1, value: this.control.yawDeg,
      format: (v) => `${signed(v)}°`, leftHint: 'left (A)', rightHint: '(D) right',
      onInput: (v) => this.emitControl({ yawDeg: v }),
    });
    const yawBlock = h('div', { class: 'sl-hud-block sl-hud-angle' }, [
      h('div', { class: 'sl-hud-title' }, [h('span', { text: 'Aim' }), this.yawReadout]),
      h('div', { class: 'sl-angle-row' }, [this.yawDiagram.el]),
      this.yawSlider.el,
    ]);

    // action slot (Hit / Next) above the HUD
    this.hitBtn = button('Hit', 'sl-btn-primary sl-btn-big sl-hit', () => this.cb.onResume(), 'Hit (Space)');
    this.hitBtn.appendChild(h('kbd', { text: 'Space' }));
    this.nextBtn = button('Next ball', 'sl-btn-primary sl-next', () => this.cb.onNextBall(), 'Next ball (Space)');
    this.nextBtn.appendChild(h('kbd', { text: 'Space' }));
    this.phaseHint = h('div', { class: 'sl-phase-hint' });
    this.actionSlot = h('div', { class: 'sl-action' }, [this.phaseHint, this.hitBtn, this.nextBtn]);

    const hud = h('div', { class: 'sl-hud sl-glass' }, [strokeBlock, pitchBlock, yawBlock]);
    return h('div', { class: 'sl-bottom' }, [this.actionSlot, hud]);
  }

  private buildHelp(): HTMLElement {
    const keyRow = (keys: string[], what: string) =>
      h('div', { class: 'sl-key-row' }, [
        h('span', { class: 'sl-keys' }, keys.map((k) => h('kbd', { text: k }))),
        h('span', { text: what }),
      ]);
    const controls = h('div', { class: 'sl-help-col' }, [
      h('h3', { text: 'Controls' }),
      keyRow(['Mouse ↕'], 'Tilt the face: move UP to close, DOWN to open (auto-position)'),
      keyRow(['Mouse ↔'], 'Aim left / right (0° = middle of their half)'),
      keyRow(['W', 'S'], 'Close / open the face'),
      keyRow(['A', 'D'], 'Aim left / right'),
      keyRow(['Wheel'], 'Fine pitch'),
      keyRow(['1', '2', '3', '4'], 'Block · Push · Drive · Chop'),
      keyRow(['Q', 'E'], 'Strength − / +'),
      keyRow(['Space'], 'Next ball / Hit (freeze-frame)'),
      keyRow(['R'], 'Repeat the same ball'),
      keyRow(['P'], 'Pause'),
      keyRow(['T'], 'Slow motion 1 → 0.5 → 0.25 → 0.1×'),
      keyRow(['C'], 'Camera: player / side / opponent'),
      keyRow(['V'], 'Spin cam on / off'),
      keyRow(['H'], 'This help'),
    ]);
    const tip = (cls: string, title: string, lines: string[]) =>
      h('div', { class: `sl-read ${cls}` }, [h('h4', { text: title }), ...lines.map((l) => h('p', { text: l }))]);
    const reading = h('div', { class: 'sl-help-col' }, [
      h('h3', { text: 'How to read spin' }),
      tip('rd-back', 'Backspin', [
        'The opponent brushes DOWN under the ball. It floats, stays low and slows after the bounce; the logo rotates underneath, back toward the server.',
        'Answer: OPEN your face (tilt it back) and lift — or push. A vertical or closed face goes into the net.',
      ]),
      tip('rd-top', 'Topspin', [
        'The opponent brushes UP the back of the ball. It dips in flight and kicks forward and low off the table.',
        'Answer: CLOSE your face (tilt it forward over the ball) and block or drive. An open face sends it long.',
      ]),
      tip('rd-side', 'Sidespin', [
        'The swing goes across the ball. It curves in the air and kicks sideways off your paddle.',
        'Answer: aim AGAINST the kick — if it curves to your left it jumps off your paddle to your right, so aim a little left.',
      ]),
      tip('rd-none', 'No spin (float)', [
        'Same motion, but the paddle goes through the ball. The logo barely turns. Use a nearly vertical face.',
      ]),
    ]);
    const close = button('Got it', 'sl-btn-primary', () => this.toggleHelp(false));
    const card = h('div', { class: 'sl-modal sl-card' }, [
      h('div', { class: 'sl-modal-head' }, [h('h2', { text: 'Spin Lab — help' }), button('×', 'sl-icon-btn', () => this.toggleHelp(false), 'Close')]),
      h('div', { class: 'sl-help-grid' }, [controls, reading]),
      h('div', { class: 'sl-modal-foot' }, [close]),
    ]);
    this.helpOverlay = h('div', { class: 'sl-overlay' }, [card]);
    this.helpOverlay.addEventListener('pointerdown', (e) => {
      if (e.target === this.helpOverlay) this.toggleHelp(false);
    });
    return this.helpOverlay;
  }

  private buildWelcome(): HTMLElement {
    const dismiss = () => {
      this.welcomeOverlay.classList.remove('open');
      writeStorage(WELCOME_KEY, '1');
    };
    const mode = (title: string, text: string) => h('div', { class: 'sl-welcome-mode' }, [h('h4', { text: title }), h('p', { text })]);
    const start = button('Let’s play', 'sl-btn-primary sl-btn-big', dismiss);
    const helpBtn = button('Show controls', 'sl-btn-ghost', () => { dismiss(); this.toggleHelp(true); });
    const card = h('div', { class: 'sl-modal sl-card sl-welcome' }, [
      h('div', { class: 'sl-welcome-hero' }, [h('span', { class: 'sl-logo sl-logo-big', attrs: { 'aria-hidden': 'true' } }), h('h2', { text: 'Welcome to Spin Lab' })]),
      h('p', { class: 'sl-welcome-lead', text: 'Learn to read the spin on the ball and pick the paddle angle that sends it back onto the table.' }),
      h('div', { class: 'sl-welcome-grid' }, [
        mode('Custom opponent', 'Shape the opponent’s shot yourself (spin, pace, placement) or pick a preset. The spin is shown, so you can explore how each one reacts.'),
        mode('Bot opponent', 'Random shots with the spin numbers hidden. Read it from the swing and the ball, then see the truth after your return.'),
        mode('Real-time', 'Play at full speed (or slow-mo with T) and set your angle while the ball flies.'),
        mode('Freeze-frame', 'The ball pauses just before contact. Adjust your angle at leisure, then press Hit.'),
      ]),
      h('p', { class: 'sl-welcome-tip', text: 'Move the mouse up to close the face, down to open it, and left/right to aim (0° always points at the middle of their half). Keys 1–4 pick the stroke. After each ball the coach shows the angle window that would have worked.' }),
      h('div', { class: 'sl-modal-foot' }, [helpBtn, start]),
    ]);
    this.welcomeOverlay = h('div', { class: 'sl-overlay' }, [card]);
    return this.welcomeOverlay;
  }
}

