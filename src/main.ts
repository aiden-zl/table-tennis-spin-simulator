/**
 * Spin Lab — integration layer. Wires the pure simulation (RallyEngine, shots, coach) to the
 * three.js renderer, the DOM overlay and the input controller.
 */
import type { PaddleControl, PaddlePose, RallyPhase, RallyResult, ShotPlan, ShotSpec } from './contracts';
import { SUGGEST_STRENGTH, analyzeReturn } from './game/coach';
import { InputController, type InputAction } from './game/input';
import { AIM_CENTRE, playerPaddlePose } from './game/playerStroke';
import { DEFAULT_CONTROL, PLAYER_READY_POS, RallyEngine, type RallyEvent } from './game/rally';
import { CoachClient } from './game/coachClient';
import { PRESETS, makeRng, planRandomShot, planShot, sanitizeSpec } from './game/shots';
import { Stats } from './game/stats';
import { MAX_FRAME_DT, TABLE_Y } from './physics/constants';
import { v3, type Vec3 } from './physics/vec';
import { prewarmRender } from './render/prewarm';
import { createArena } from './render/arena';
import { Sfx } from './render/audio';
import { OpponentAvatar } from './render/avatar';
import { BallView, SpinInspector, type BallViewOptions } from './render/ballView';
import { Markers } from './render/markers';
import { applyPose, createPaddleMesh, setPaddleFade } from './render/paddles';
import { UI, type Settings } from './ui/ui';

const FREEZE_LEAD = 0.12;
const AUTO_NEXT_DELAY = 2.6;
/** where the player should aim on the opponent's half (shown as the target ring); 0° aim points here */
const AIM_TARGET: Vec3 = { x: AIM_CENTRE.x, y: TABLE_Y, z: AIM_CENTRE.z };

function boot(): void {
  const app = document.getElementById('app');
  const uiRoot = document.getElementById('ui-root');
  if (!app || !uiRoot) throw new Error('missing #app / #ui-root');

  // ── state
  const settings: Settings = {
    opponentMode: 'custom',
    controlMode: 'realtime',
    autoPosition: true,
    assist: 'full',
    timeScale: 1,
    autoNext: false,
    showIdeal: true,
    showSpinCam: true,
    camera: 'player',
    sound: true,
  };
  let customSpec: ShotSpec = sanitizeSpec(PRESETS[0]?.spec ?? {
    kind: 'serve',
    spin: { topspin: -30, sidespin: 0, corkscrew: 0 },
    pace: 'medium',
    target: { x: 0, z: 0.6 },
    fromX: 0,
  });
  let control: PaddleControl = { ...DEFAULT_CONTROL };
  let plan: ShotPlan | null = null;
  let paused = false;
  let lastPhase: RallyPhase = 'idle';
  let paddleFade = 1;
  let lastResult: RallyResult | null = null;
  let autoNextTimer = -1;
  let previewTimer: number | undefined;
  const rng = makeRng((Date.now() ^ 0x5f3759df) >>> 0);

  // ── rendering
  const arena = createArena(app);
  const { scene } = arena;
  const ballView = new BallView(scene);
  const markers = new Markers(scene);
  const avatar = new OpponentAvatar(scene);
  const playerPaddle = createPaddleMesh({ frontColor: 0xd62828, backColor: 0x1b1b1b, opacity: 0.62 });
  const opponentPaddle = createPaddleMesh({ frontColor: 0xd62828, backColor: 0x1b1b1b });
  scene.add(playerPaddle, opponentPaddle);
  const sfx = new Sfx();

  // ── simulation
  const coachClient = new CoachClient();
  const engine = new RallyEngine({
    controlMode: settings.controlMode,
    autoPosition: settings.autoPosition,
    freezeLead: FREEZE_LEAD,
  });
  engine.setExternalCoach(coachClient.available);
  coachClient.onFail = () => engine.setExternalCoach(false);
  engine.setControl(control);
  const stats = new Stats();

  // ── UI
  const ui = new UI(
    uiRoot,
    { settings, customSpec, presets: PRESETS, control, sanitize: sanitizeSpec },
    {
      onNextBall: () => nextBall(),
      onResume: () => resumeFromFreeze(),
      onTogglePause: () => togglePause(),
      onSettingsChange: (s) => applySettings(s),
      onCustomSpecChange: (spec) => {
        customSpec = spec;
        schedulePreview();
      },
      onControlChange: (c) => {
        setControl(c);
        input.setControl(c);
      },
      onResetStats: () => {
        stats.reset();
        ui.setStats(stats.snapshot());
        ui.toast('Stats reset');
      },
      onRepeatBall: () => repeatBall(),
    },
  );
  ui.setStats(stats.snapshot());

  const spinCam = new SpinInspector(ui.spinCamContainer());
  spinCam.setVisible(settings.showSpinCam);

  // ── input
  const input = new InputController(arena.renderer.domElement, control, {
    onAction: (a) => handleAction(a),
    onControlChange: (c) => {
      setControl(c);
      ui.setControl(c);
    },
  });
  input.setAutoPosition(settings.autoPosition);
  input.setProjector((cx, cy) => {
    const z = plan ? plan.incoming.contactState.p.z : PLAYER_READY_POS.z;
    return arena.projectToPlane(cx, cy, z);
  });

  // Auto mode maps the pointer over the part of the canvas NOT covered by the edge-docked UI
  // (top bar + shot banner, bottom HUD, left panel), so full closed / open / left / right are
  // reachable just inside the panels instead of only on thin strips beneath / beside them.
  // Cached briefly: layout changes (resize, panel collapse, overlays closing) are picked up
  // within a second, while the map stays steady during a stroke.
  let playRect: { left: number; top: number; width: number; height: number } | null = null;
  let playRectAt = -Infinity;
  window.addEventListener('resize', () => (playRectAt = -Infinity));
  input.setRegion(() => {
    const now = performance.now();
    if (now - playRectAt > 1000) {
      playRect = computePlayRect();
      playRectAt = now;
    }
    return playRect;
  });

  const unlockAudio = () => sfx.unlock();
  window.addEventListener('pointerdown', unlockAudio, { capture: true });
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape') unlockAudio();
    },
    { capture: true },
  );

  /**
   * Scan out from the canvas centre (up, down, left) for the first point covered by an overlay
   * docked to that viewport edge and return the unobstructed rect, horizontally symmetric about
   * the centre. Transient centre cards (freeze hint, result card…) are not docked and are
   * ignored, as is the phase-dependent action slot above the HUD, so the map stays put while a
   * ball is played.
   */
  function computePlayRect(): { left: number; top: number; width: number; height: number } | null {
    const canvas = arena.renderer.domElement;
    const r = canvas.getBoundingClientRect();
    if (r.width < 50 || r.height < 50) return null;
    const W = window.innerWidth;
    const H = window.innerHeight;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const MARGIN = 8;
    // the bottom edge saturates a little higher so full "open" is reached above the action
    // button (Next ball / Hit) that sits on top of the HUD in the centre column
    const MARGIN_BOTTOM = 52;
    const STEP = 4;
    const blocked = (x: number, y: number, docked: (b: DOMRect) => boolean): boolean => {
      let el = document.elementFromPoint(x, y);
      if (!el || el === canvas || el.closest('.sl-action')) return false;
      for (; el && el !== document.body; el = el.parentElement) {
        const b = el.getBoundingClientRect();
        if (b.width >= W - 1 && b.height >= H - 1) return false; // full-screen layer / modal backdrop
        if (docked(b)) return true;
      }
      return false;
    };
    let top = r.top;
    for (let y = cy; y > r.top; y -= STEP) {
      if (blocked(cx, y, (b) => b.top < H * 0.2)) {
        top = y + STEP + MARGIN;
        break;
      }
    }
    let bottom = r.bottom;
    for (let y = cy; y < r.bottom; y += STEP) {
      if (blocked(cx, y, (b) => b.bottom > H * 0.8)) {
        bottom = y - STEP - MARGIN_BOTTOM;
        break;
      }
    }
    let left = r.left;
    for (let x = cx; x > r.left; x -= STEP) {
      if (blocked(x, cy, (b) => b.left < W * 0.2)) {
        left = x + STEP + MARGIN;
        break;
      }
    }
    const half = cx - left;
    // keep a usable span even on tiny / crowded layouts
    if (bottom - top < r.height * 0.35 || half < r.width * 0.15) return null;
    return { left, top, width: 2 * half, height: bottom - top };
  }

  /**
   * Compile every shader up front: markers, paths, ghost paddle and spin visuals are hidden
   * until a ball is played, and compiling them on first use stalls that frame (~0.4 s).
   */
  function prewarmShaders(): void {
    const pts = [v3(0, TABLE_Y + 0.3, 1), v3(0, TABLE_Y + 0.4, 0), v3(0, TABLE_Y + 0.1, -1)];
    markers.setLanding(v3(0, TABLE_Y, -0.8), true);
    markers.setIncomingBounce(v3(0, TABLE_Y, 0.8));
    markers.setPath('actual', pts);
    markers.setPath('ideal', pts);
    markers.setPath('incoming', pts);
    markers.setGhostPaddle(engine.snapshot().playerPaddle);
    prewarmRender(arena.renderer, scene, arena.camera);
    spinCam.prewarm();
    markers.clearAll();
  }

  // ── behaviour
  function setControl(c: PaddleControl): void {
    control = { ...c };
    engine.setControl(control);
  }

  function clearAutoNext(): void {
    if (autoNextTimer >= 0) {
      window.clearTimeout(autoNextTimer);
      autoNextTimer = -1;
    }
  }

  function beginPlan(p: ShotPlan): void {
    clearAutoNext();
    plan = p;
    lastResult = null;
    markers.clearAll();
    markers.setTarget(AIM_TARGET);
    ballView.resetTrail();
    ui.hideResult();
    ui.showShotInfo(p, settings.opponentMode === 'custom');
    engine.start(p);
    if (paused) togglePause();
  }

  function nextBall(): void {
    let p: ShotPlan | null;
    if (settings.opponentMode === 'bot') p = planRandomShot(rng);
    else {
      p = planShot(customSpec);
      if (!p) {
        ui.toast("That spin/placement combination can't land on the table — try less spin or a different pace.");
        return;
      }
      // planShot may have moved the target or changed the pace to make the shot land: say so
      const changes: string[] = [];
      if (p.spec.pace !== customSpec.pace) changes.push(`pace ${customSpec.pace} → ${p.spec.pace}`);
      const moved = Math.hypot(p.spec.target.x - customSpec.target.x, p.spec.target.z - customSpec.target.z);
      if (moved > 0.03) changes.push(`landing spot moved ${Math.round(moved * 100)} cm`);
      if (changes.length) ui.toast(`Adjusted so the shot can land: ${changes.join(', ')}.`);
    }
    beginPlan(p);
  }

  function repeatBall(): void {
    if (!plan) {
      nextBall();
      return;
    }
    beginPlan(plan);
  }

  function resumeFromFreeze(): void {
    if (engine.snapshot().phase === 'frozen') engine.resume();
  }

  function togglePause(): void {
    paused = !paused;
    ui.setPaused(paused);
    if (paused) clearAutoNext();
    else if (lastPhase === 'result' && settings.autoNext) scheduleAutoNext();
  }

  function scheduleAutoNext(): void {
    clearAutoNext();
    autoNextTimer = window.setTimeout(() => {
      autoNextTimer = -1;
      if (!paused && engine.snapshot().phase === 'result') nextBall();
    }, AUTO_NEXT_DELAY * 1000);
  }

  function applySettings(s: Settings): void {
    const prev = { ...settings };
    Object.assign(settings, s);
    engine.setOptions({ controlMode: settings.controlMode, autoPosition: settings.autoPosition });
    input.setAutoPosition(settings.autoPosition);
    sfx.setEnabled(settings.sound);
    spinCam.setVisible(settings.showSpinCam);
    if (prev.camera !== settings.camera) arena.setView(settings.camera);
    if (prev.opponentMode !== settings.opponentMode) {
      // switching who serves: abandon the current ball so spin info cannot leak
      const ph = engine.snapshot().phase;
      if (ph !== 'idle' && ph !== 'result') {
        engine.reset();
        plan = null;
        lastResult = null;
        markers.clearAll();
        ui.hideResult();
      }
      // the banner now invites the next ball in the new mode (the last ball's card stays)
      ui.showShotInfo(null, false);
    }
    if (prev.controlMode !== settings.controlMode && engine.snapshot().phase !== 'idle') {
      ui.toast(`${settings.controlMode === 'freeze' ? 'Freeze-frame' : 'Real-time'} applies from the next ball`);
    }
    if (prev.showIdeal !== settings.showIdeal && lastResult) showIdealOverlay(lastResult);
    if (prev.autoNext !== settings.autoNext) {
      if (settings.autoNext && lastPhase === 'result' && !paused) scheduleAutoNext();
      if (!settings.autoNext) clearAutoNext();
    }
  }

  function schedulePreview(): void {
    if (previewTimer !== undefined) window.clearTimeout(previewTimer);
    previewTimer = window.setTimeout(() => {
      previewTimer = undefined;
      const ph = engine.snapshot().phase;
      if (settings.opponentMode !== 'custom' || (ph !== 'idle' && ph !== 'result')) return;
      const p = planShot(customSpec);
      if (!p) {
        ui.toast("This combination can't land on the table — it will be adjusted or rejected.");
        markers.setPath('incoming', null);
        return;
      }
      // preview the incoming trajectory for tinkering
      markers.setPath('incoming', samplePath(p.incoming.states.map((s) => s.p), 8));
      markers.setIncomingBounce(p.incoming.playerBounce ?? null);
    }, 160);
  }

  function samplePath(points: Vec3[], every: number): Vec3[] {
    const out: Vec3[] = [];
    for (let i = 0; i < points.length; i += every) out.push(points[i]);
    if (points.length) out.push(points[points.length - 1]);
    return out;
  }

  function idealPose(result: RallyResult): PaddlePose | null {
    const c = result.coach;
    const win = c.ideal ?? c.suggestedWindow ?? null;
    if (!win) return null;
    const stroke = c.ideal ? result.control.stroke : c.suggestedStroke ?? result.control.stroke;
    const strength = c.ideal ? result.control.strength : (c.suggestedStrength ?? SUGGEST_STRENGTH);
    const ctrl: PaddleControl = { ...result.control, pitchDeg: win.bestPitch, yawDeg: win.bestYaw, stroke, strength };
    return playerPaddlePose(ctrl, result.contactState.p, 0);
  }

  function showIdealOverlay(result: RallyResult): void {
    if (!settings.showIdeal) {
      markers.setGhostPaddle(null);
      markers.setPath('ideal', null);
      return;
    }
    markers.setGhostPaddle(idealPose(result));
    markers.setPath('ideal', result.coach.idealPath ?? null);
  }

  function handleAction(a: InputAction): void {
    if (ui.isHelpOpen()) {
      // any overlay open: Esc / Space / Enter / H close it (and remember the welcome card)
      if (a === 'pause' || a === 'next' || a === 'help') ui.closeOverlays();
      return;
    }
    switch (a) {
      case 'next': {
        const ph = engine.snapshot().phase;
        if (ph === 'frozen') resumeFromFreeze();
        else if (ph === 'idle' || ph === 'result') nextBall();
        break;
      }
      case 'pause':
        togglePause();
        break;
      case 'slowmo':
        ui.cycleTimeScale();
        break;
      case 'camera':
        ui.cycleCamera();
        break;
      case 'help':
        ui.toggleHelp();
        break;
      case 'repeat': {
        const ph = engine.snapshot().phase;
        if (ph === 'idle' || ph === 'result') repeatBall();
        break;
      }
      case 'spincam':
        ui.toggleSpinCam();
        break;
    }
  }

  function handleEvent(ev: RallyEvent): void {
    switch (ev.type) {
      case 'launch':
        sfx.paddle(0.7);
        break;
      case 'bounce':
        sfx.table(0.8);
        if (ev.side === 'player' && !lastResult) markers.setIncomingBounce(ev.p);
        break;
      case 'net':
        sfx.net();
        break;
      case 'floor':
        sfx.floor();
        break;
      case 'frozen':
        ui.toast('Frozen — read the spin, set your angle, then Hit (Space)');
        break;
      case 'contact': {
        lastResult = ev.result;
        if (coachClient.available) {
          // coach off the main thread. The engine never waits for it: a result decided first
          // shows a provisional card that is filled in when the report arrives.
          const r = ev.result;
          const forPlan = plan;
          coachClient
            .request(r.contactState, r.control, r.returnResult)
            .then((rep) => {
              if (lastResult !== r) return; // a newer ball replaced it
              // worker failed: analyse here (rare; costs one stall)
              const report = rep ?? analyzeReturn(r.contactState, r.control, r.returnResult);
              engine.provideCoach(r, report);
              if (r.coach === report && forPlan && plan === forPlan && engine.snapshot().phase === 'result') {
                if (ui.isResultOpen()) ui.showResult(r, forPlan);
                showIdealOverlay(r);
              }
            })
            .catch((e) => console.warn('coach request failed', e));
        }
        if (ev.result.outcome !== 'miss') sfx.paddle(1);
        if (plan) {
          stats.record(ev.result, plan);
          ui.setStats(stats.snapshot());
          ui.showShotInfo(plan, true); // reveal the spin now that the player has committed
        }
        break;
      }
      case 'result': {
        const r = ev.result;
        lastResult = r;
        if (!plan) break;
        ui.showResult(r, plan);
        if (r.outcome === 'in') sfx.success();
        else sfx.fail();
        const rr = r.returnResult;
        if (rr?.landing) markers.setLanding(rr.landing, r.outcome === 'in');
        markers.setPath('actual', rr ? rr.path : null);
        markers.setPath('incoming', samplePath(plan.incoming.states.map((s) => s.p), 8));
        showIdealOverlay(r);
        if (settings.autoNext && !paused) scheduleAutoNext();
        break;
      }
      case 'windup':
        break;
    }
  }

  // ── frame loop
  let last = performance.now();
  function frame(now: number): void {
    const rawDt = Math.max((now - last) / 1000, 0);
    const dtReal = Math.min(rawDt, MAX_FRAME_DT);
    last = now;

    // held keys run on wall-clock time so W/S/A/D keep their ~60°/s on slow frames too
    input.update(Math.min(rawDt, 0.25));
    const simDt = paused ? 0 : dtReal * settings.timeScale;
    const before = engine.snapshot().phase;
    const events = engine.update(simDt);
    for (const ev of events) handleEvent(ev);
    const snap = engine.snapshot();
    const advancing = !paused && before !== 'frozen' && snap.phase !== 'frozen' && snap.phase !== 'idle';

    if (snap.phase !== lastPhase) {
      lastPhase = snap.phase;
      ui.setPhase(snap.phase);
    }

    const revealed = snap.phase === 'returning' || snap.phase === 'result';
    const viewOpts: BallViewOptions = {
      // assist level only limits the spin visuals in bot mode (custom mode: you set the spin)
      assist: settings.opponentMode === 'bot' ? settings.assist : 'full',
      visible: snap.ballVisible,
      spinVisualScale: Math.min(1, 0.1 / Math.max(settings.timeScale, 0.01)),
      showTrail: true,
      forceReveal: revealed && settings.opponentMode === 'bot',
    };
    ballView.update(snap.ball, advancing ? simDt : 0, dtReal, viewOpts);
    spinCam.update(snap.ball, ballView.orientation, dtReal, viewOpts);

    applyPose(playerPaddle, snap.playerPaddle);
    // frozen just before contact the paddle sits between you and the ball: see through it
    paddleFade += ((snap.phase === 'frozen' ? 0.35 : 1) - paddleFade) * (1 - Math.exp(-dtReal * 10));
    setPaddleFade(playerPaddle, paddleFade);
    applyPose(opponentPaddle, snap.opponentPaddle);
    avatar.update(snap.opponentPaddle, dtReal);
    markers.update(dtReal);
    arena.update(dtReal);
    arena.render();
    requestAnimationFrame(frame);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && !paused && lastPhase !== 'idle' && lastPhase !== 'result') togglePause();
  });

  // debugging / automated smoke-test hook (read-only use)
  (window as unknown as { __spinlab: unknown }).__spinlab = {
    engine,
    settings,
    stats,
    nextBall,
    getPlan: () => plan,
    getLastResult: () => lastResult,
    applySettings: (s: Partial<Settings>) => ui.setSettings(s, true),
    setControl: (c: Partial<PaddleControl>) => {
      const next = { ...control, ...c };
      setControl(next);
      input.setControl(next);
      ui.setControl(next);
    },
  };

  arena.setView(settings.camera, true);
  prewarmShaders();
  markers.setTarget(AIM_TARGET);
  schedulePreview();
  requestAnimationFrame((t) => {
    last = t;
    frame(t);
  });
}

try {
  boot();
} catch (err) {
  console.error(err);
  const el = document.createElement('pre');
  el.style.cssText = 'position:fixed;inset:20px;color:#b91c1c;background:#fff;padding:16px;font:14px monospace;white-space:pre-wrap;z-index:99';
  el.textContent = `Spin Lab failed to start:\n${err instanceof Error ? err.stack ?? err.message : String(err)}`;
  document.body.appendChild(el);
}
