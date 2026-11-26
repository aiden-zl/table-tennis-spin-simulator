/**
 * Ball rendering + spin visualisations (owned by agent "ballviz").
 *
 *  - BallView: the 40 mm ball with readable markings, its orientation integrated from the TRUE
 *    angular velocity (× spinVisualScale), blob shadow, spin-axis arrow + rotation ring,
 *    airflow "wind" streaks, Magnus arrow and a fading motion trail.
 *  - SpinInspector: close-up "spin cam" in its own canvas, same orientation quaternion.
 *
 * Colour legend: SPIN_COLORS / SPIN_COLOR_LEGEND (re-exported from ./ballviz/math).
 */
import * as THREE from 'three';
import { prewarmRender } from './prewarm';
import type { AssistLevel, BallState } from '../contracts';
import { BALL_RADIUS, FLOOR_Y, G, TABLE_Y } from '../physics/constants';
import { onTable } from '../physics/ball';
import {
  airflow,
  flowParams,
  integrateOrientation,
  liftAccel,
  newFlowParams,
  smoothstep,
  spinColor,
  spinFade,
  type MutVec3,
  type QuatLike,
  type RGB,
} from './ballviz/math';
import { SimpleArrow, SpinGizmo, makeBallTexture, makeBlobTexture, type GizmoOptions } from './ballviz/assets';
import { RibbonBatch } from './ballviz/ribbons';

export { SPIN_COLORS, SPIN_COLOR_LEGEND, classifySpin, spinColor } from './ballviz/math';
export type { SpinColorKey } from './ballviz/math';

export interface BallViewOptions {
  assist: AssistLevel;
  visible: boolean;
  /** visual rotation rate = true spin * spinVisualScale (true spin aliases at 60 fps) */
  spinVisualScale: number;
  /** show the motion trail */
  showTrail: boolean;
  /** show spin arrows/wind even when assist is lower (e.g. after the spin is revealed) */
  forceReveal?: boolean;
}

/** Which assist layers are on for the given options. */
export function assistLayers(opts: Pick<BallViewOptions, 'assist' | 'forceReveal'>): {
  arrows: boolean;
  wind: boolean;
  tintTrail: boolean;
} {
  const level: AssistLevel = opts.forceReveal ? 'full' : opts.assist;
  return {
    arrows: level === 'full',
    wind: level === 'full' || level === 'wind',
    tintTrail: level === 'full' || level === 'wind',
  };
}

// ───────────────────────────── tuning

const TRAIL_SECONDS = 0.35;
const TRAIL_MAX = 72;
const TRAIL_WIDTH = 0.026;

const WIND_N = 44;
const WIND_PTS = 10;
/** flow sphere radius (the streaks go around this, a bit outside the ball) */
const WIND_A = BALL_RADIUS * 1.6;
const WIND_S0 = -0.13; // upstream spawn distance along the airflow (m)
const WIND_S1 = 0.18; // downstream end
const WIND_RHO = 0.075; // spawn disc radius
const WIND_STEP = 0.0065; // streak segment length
const WIND_SPEED = 0.3; // visual streak speed (m/s of real time) at ~10 m/s ball speed
const WIND_HEAD_W = 0.011;
const WIND_TAIL_W = 0.004;

const GIZMO_WORLD: GizmoOptions = {
  axisMin: 1.4,
  axisMax: 4.6,
  shaftRadius: 0.13,
  headRadius: 0.42,
  headLength: 1.1,
  ringRadius: 2.3,
  ringTube: 0.14,
  ringHeadRadius: 0.45,
  ringHeadLength: 1.05,
  ringSpinRate: 2.5,
};

const _v = new THREE.Vector3();
const _col = new THREE.Color();
const _rgb: RGB = { r: 1, g: 1, b: 1 };
const _flow: MutVec3 = { x: 0, y: 0, z: 0 };

const finiteVec = (p: { x: number; y: number; z: number }) =>
  Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);

/** Apply the world-frame spin to a THREE.Quaternion: q' = exp(0.5 w dt) ⊗ q. */
const _q: QuatLike = { x: 0, y: 0, z: 0, w: 1 };
function integrateThreeQuat(q: THREE.Quaternion, w: BallState['w'], dt: number): void {
  _q.x = q.x; _q.y = q.y; _q.z = q.z; _q.w = q.w;
  integrateOrientation(_q, w, dt);
  q.set(_q.x, _q.y, _q.z, _q.w);
}

export class BallView {
  /** current visual orientation (shared with the SpinInspector so both rotate identically) */
  readonly orientation = new THREE.Quaternion();

  private readonly scene: THREE.Scene;
  private readonly root = new THREE.Group();
  private readonly ballMesh: THREE.Mesh;
  private readonly ballGeo: THREE.SphereGeometry;
  private readonly ballMat: THREE.MeshStandardMaterial;
  private readonly ballTex: THREE.Texture;
  private readonly shadowMesh: THREE.Mesh;
  private readonly shadowGeo: THREE.PlaneGeometry;
  private readonly shadowMat: THREE.MeshBasicMaterial;
  private readonly shadowTex: THREE.Texture;
  /** follows the ball position, world-aligned (no rotation): gizmo, magnus arrow, wind */
  private readonly follow = new THREE.Group();
  private readonly gizmo: SpinGizmo;
  private readonly magnus: SimpleArrow;
  private readonly wind: RibbonBatch;
  private readonly trail: RibbonBatch;

  private readonly camWorld = new THREE.Vector3(0, 1.6, 3.2);
  private readonly color = new THREE.Color(1, 1, 1);
  private colorInit = false;
  private arrowsAlpha = 0;
  private windAlpha = 0;
  private trailTint = 0;

  // wind particle heads (ball-relative, world axes)
  private readonly wx = new Float32Array(WIND_N);
  private readonly wy = new Float32Array(WIND_N);
  private readonly wz = new Float32Array(WIND_N);
  private readonly wAge = new Float32Array(WIND_N);
  private windPrimed = false;
  private readonly flow = newFlowParams();

  // trail ring (oldest first)
  private readonly tPos = new Float32Array(TRAIL_MAX * 3);
  private readonly tTime = new Float64Array(TRAIL_MAX);
  private tCount = 0;
  private simClock = 0;
  private readonly lastPos = new THREE.Vector3();
  private hasLast = false;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.ballTex = makeBallTexture();
    this.ballGeo = new THREE.SphereGeometry(BALL_RADIUS, 40, 24);
    this.ballMat = new THREE.MeshStandardMaterial({ map: this.ballTex, roughness: 0.42, metalness: 0 });
    this.ballMesh = new THREE.Mesh(this.ballGeo, this.ballMat);
    this.ballMesh.castShadow = true;
    this.ballMesh.name = 'ball';
    this.ballMesh.onBeforeRender = (_r, _s, camera) => {
      this.camWorld.setFromMatrixPosition(camera.matrixWorld);
    };

    this.shadowTex = makeBlobTexture();
    this.shadowGeo = new THREE.PlaneGeometry(1, 1);
    this.shadowGeo.rotateX(-Math.PI / 2);
    this.shadowMat = new THREE.MeshBasicMaterial({
      map: this.shadowTex,
      transparent: true,
      depthWrite: false,
      opacity: 0.5,
      color: 0x000000,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.shadowMesh = new THREE.Mesh(this.shadowGeo, this.shadowMat);
    this.shadowMesh.renderOrder = 1;
    this.shadowMesh.name = 'ballBlobShadow';

    this.gizmo = new SpinGizmo(BALL_RADIUS, GIZMO_WORLD);
    this.magnus = new SimpleArrow(0.0022, 0.0062, 0.014);
    this.magnus.material.color.setStyle('#fff35c');
    this.wind = new RibbonBatch(WIND_N, WIND_PTS);
    this.wind.mesh.renderOrder = 2;
    this.trail = new RibbonBatch(1, TRAIL_MAX + 1);
    this.trail.mesh.renderOrder = 2;

    this.follow.add(this.gizmo.group, this.magnus.group, this.wind.mesh);
    this.root.add(this.ballMesh, this.shadowMesh, this.follow, this.trail.mesh);
    this.root.name = 'BallView';
    scene.add(this.root);
  }

  /** simDt = simulated seconds advanced this frame (0 when paused/frozen) */
  update(ball: BallState, simDt: number, dtReal: number, opts: BallViewOptions): void {
    const dt = Math.min(Math.max(dtReal, 0), 0.1);
    const p = ball.p, v = ball.v, w = ball.w;
    const valid = finiteVec(p) && finiteVec(v) && finiteVec(w);

    // 1) orientation: TRUE angular velocity × simulated time × visual scale (world frame)
    if (valid && simDt > 0 && opts.spinVisualScale !== 0) {
      integrateThreeQuat(this.orientation, w, simDt * opts.spinVisualScale);
    }

    if (!opts.visible || !valid) {
      this.root.visible = false;
      return;
    }
    this.root.visible = true;

    // teleport detection (new shot, reset) → restart trail & wind
    if (this.hasLast && this.lastPos.distanceToSquared(_v.set(p.x, p.y, p.z)) > 0.5 * 0.5) {
      this.resetTrail();
      this.windPrimed = false;
    }
    this.lastPos.set(p.x, p.y, p.z);
    this.hasLast = true;
    this.simClock += Math.max(simDt, 0);

    this.ballMesh.position.set(p.x, p.y, p.z);
    this.ballMesh.quaternion.copy(this.orientation);
    this.follow.position.set(p.x, p.y, p.z);

    this.updateShadow(p);

    // 2) spin quantities
    const wMag = Math.hypot(w.x, w.y, w.z);
    const rps = wMag / (2 * Math.PI);
    const fade = spinFade(rps);
    spinColor(w, v, _rgb);
    _col.setRGB(_rgb.r, _rgb.g, _rgb.b, THREE.SRGBColorSpace);
    if (!this.colorInit) {
      this.color.copy(_col);
      this.colorInit = true;
    } else {
      this.color.lerp(_col, 1 - Math.exp(-dt * 12));
    }

    const layers = assistLayers(opts);
    const ease = 1 - Math.exp(-dt * 8);
    this.arrowsAlpha += ((layers.arrows ? 1 : 0) - this.arrowsAlpha) * ease;
    this.windAlpha += ((layers.wind ? 1 : 0) - this.windAlpha) * ease;
    this.trailTint += ((layers.tintTrail ? 1 : 0) - this.trailTint) * ease;

    // 3) axis arrow + rotation ring
    const ga = this.arrowsAlpha * fade;
    _v.set(w.x, w.y, w.z);
    this.gizmo.update(_v, rps, ga, this.color, dt);

    // 4) Magnus arrow along w × v (the lift)
    const lift = liftAccel(w, v);
    _v.set(w.y * v.z - w.z * v.y, w.z * v.x - w.x * v.z, w.x * v.y - w.y * v.x);
    const k = Math.min(lift / (1.5 * G), 1);
    const liftFade = smoothstep(0.4, 2.5, lift);
    this.magnus.set(_v, BALL_RADIUS * 1.15, BALL_RADIUS * (2.0 + 2.8 * k), ga * liftFade * 0.95);

    // 5) wind
    const speed = Math.hypot(v.x, v.y, v.z);
    const windVis = this.windAlpha * smoothstep(0.3, 1.5, speed);
    if (windVis > 0.01) {
      this.wind.mesh.visible = true;
      this.updateWind(ball, dt, windVis, fade, speed);
    } else {
      this.wind.mesh.visible = false;
      if (this.windAlpha < 0.01) this.windPrimed = false;
    }

    // 6) trail
    if (opts.showTrail) {
      this.trail.mesh.visible = true;
      this.updateTrail(p);
    } else {
      this.trail.mesh.visible = false;
    }
  }

  private updateShadow(p: BallState['p']): void {
    const overTable = onTable(p.x, p.z) && p.y >= TABLE_Y;
    const surf = overTable ? TABLE_Y : FLOOR_Y;
    const h = Math.max(p.y - BALL_RADIUS - surf, 0);
    const size = BALL_RADIUS * 2.2 + h * 0.12;
    this.shadowMesh.position.set(p.x, surf + 0.0015, p.z);
    this.shadowMesh.scale.set(size, 1, size);
    this.shadowMat.opacity = 0.55 / (1 + h * 5);
  }

  private spawnWind(i: number, prime: boolean): void {
    const f = this.flow;
    // perpendicular basis of the airflow direction U
    let ex = 0, ey = 1, ez = 0;
    if (Math.abs(f.uy) > 0.9) { ex = 1; ey = 0; }
    // e1 = normalize(e - (e·U)U), e2 = U × e1
    const d = ex * f.ux + ey * f.uy + ez * f.uz;
    let e1x = ex - d * f.ux, e1y = ey - d * f.uy, e1z = ez - d * f.uz;
    const l = Math.hypot(e1x, e1y, e1z) || 1;
    e1x /= l; e1y /= l; e1z /= l;
    const e2x = f.uy * e1z - f.uz * e1y;
    const e2y = f.uz * e1x - f.ux * e1z;
    const e2z = f.ux * e1y - f.uy * e1x;
    const rho = WIND_RHO * Math.sqrt(0.03 + 0.97 * Math.random());
    const th = Math.random() * Math.PI * 2;
    const c = Math.cos(th) * rho, s = Math.sin(th) * rho;
    const along = prime ? WIND_S0 + Math.random() * (WIND_S1 - WIND_S0) : WIND_S0 - Math.random() * 0.02;
    this.wx[i] = f.ux * along + e1x * c + e2x * s;
    this.wy[i] = f.uy * along + e1y * c + e2y * s;
    this.wz[i] = f.uz * along + e1z * c + e2z * s;
    this.wAge[i] = 0;
  }

  private updateWind(ball: BallState, dt: number, vis: number, fade: number, speed: number): void {
    const f = flowParams(ball.w, ball.v, WIND_A, this.flow);
    if (!this.windPrimed) {
      for (let i = 0; i < WIND_N; i++) this.spawnWind(i, true);
      this.windPrimed = true;
    }
    const adv = dt * WIND_SPEED * Math.min(Math.max(speed / 10, 0.6), 1.5);
    const subs = Math.max(1, Math.ceil(adv / 0.006));
    const h = adv / subs;
    const a = WIND_A;
    const minR = a * 1.04;
    // camera relative to the ball (ribbon positions are ball-relative)
    const cx = this.camWorld.x - ball.p.x, cy = this.camWorld.y - ball.p.y, cz = this.camWorld.z - ball.p.z;
    const cl = Math.hypot(cx, cy, cz) || 1;
    const vx = cx / cl, vy = cy / cl, vz = cz / cl;
    const r = this.color.r, g = this.color.g, b = this.color.b;
    const base = 0.8 * vis * (0.45 + 0.55 * fade);
    const pts = this.wind.pts, wid = this.wind.widths, alp = this.wind.alphas;

    for (let i = 0; i < WIND_N; i++) {
      let x = this.wx[i], y = this.wy[i], z = this.wz[i];
      for (let s = 0; s < subs; s++) {
        airflow(_flow, x, y, z, f);
        x += _flow.x * h; y += _flow.y * h; z += _flow.z * h;
        const rr = Math.hypot(x, y, z);
        if (rr < minR && rr > 1e-9) { const k = minR / rr; x *= k; y *= k; z *= k; }
      }
      this.wAge[i] += dt;
      const along = x * f.ux + y * f.uy + z * f.uz;
      const px = x - f.ux * along, py = y - f.uy * along, pz = z - f.uz * along;
      const perp = Math.hypot(px, py, pz);
      if (along > WIND_S1 || along < WIND_S0 - 0.05 || perp > WIND_RHO * 2 || this.wAge[i] > 3) {
        this.spawnWind(i, false);
        x = this.wx[i]; y = this.wy[i]; z = this.wz[i];
      } else {
        this.wx[i] = x; this.wy[i] = y; this.wz[i] = z;
      }
      const headAlong = x * f.ux + y * f.uy + z * f.uz;
      const region =
        smoothstep(WIND_S0, WIND_S0 + 0.045, headAlong) * (1 - smoothstep(WIND_S1 - 0.07, WIND_S1, headAlong));
      const ageIn = smoothstep(0, 0.25, this.wAge[i]);
      // backward streamline from the head = the streak
      let qx = x, qy = y, qz = z;
      for (let k = 0; k < WIND_PTS; k++) {
        pts[k * 3] = qx; pts[k * 3 + 1] = qy; pts[k * 3 + 2] = qz;
        const t = k / (WIND_PTS - 1);
        wid[k] = WIND_HEAD_W + (WIND_TAIL_W - WIND_HEAD_W) * t;
        // don't let streaks between the camera and the ball cover it
        const dv = qx * vx + qy * vy + qz * vz;
        let occ = 1;
        if (dv > 0) {
          const ox = qx - vx * dv, oy = qy - vy * dv, oz = qz - vz * dv;
          occ = 0.15 + 0.85 * smoothstep(BALL_RADIUS * 1.0, BALL_RADIUS * 1.9, Math.hypot(ox, oy, oz));
        }
        alp[k] = base * region * ageIn * Math.pow(1 - t, 1.2) * occ;
        airflow(_flow, qx, qy, qz, f);
        const ul = Math.hypot(_flow.x, _flow.y, _flow.z);
        if (ul > 1e-9) {
          const step = (WIND_STEP * Math.min(Math.max(ul, 0.35), 1.4)) / ul;
          qx -= _flow.x * step; qy -= _flow.y * step; qz -= _flow.z * step;
          const rr = Math.hypot(qx, qy, qz);
          if (rr < minR && rr > 1e-9) { const kk = minR / rr; qx *= kk; qy *= kk; qz *= kk; }
        }
      }
      this.wind.writeStrip(i, WIND_PTS, r, g, b, cx, cy, cz);
    }
    this.wind.commit();
  }

  private updateTrail(p: BallState['p']): void {
    const T = this.simClock;
    // append a sample when the ball has moved
    const n = this.tCount;
    const lastI = (n - 1) * 3;
    const moved =
      n === 0 ||
      (Math.hypot(p.x - this.tPos[lastI], p.y - this.tPos[lastI + 1], p.z - this.tPos[lastI + 2]) > 0.002 &&
        T - this.tTime[n - 1] >= TRAIL_SECONDS / (TRAIL_MAX - 2));
    if (moved) {
      if (n === TRAIL_MAX) {
        this.tPos.copyWithin(0, 3);
        this.tTime.copyWithin(0, 1);
        this.tCount--;
      }
      const j = this.tCount;
      this.tPos[j * 3] = p.x; this.tPos[j * 3 + 1] = p.y; this.tPos[j * 3 + 2] = p.z;
      this.tTime[j] = T;
      this.tCount++;
    }
    // drop expired samples (keep the newest)
    let drop = 0;
    while (drop < this.tCount - 1 && T - this.tTime[drop] > TRAIL_SECONDS) drop++;
    if (drop > 0) {
      this.tPos.copyWithin(0, drop * 3, this.tCount * 3);
      this.tTime.copyWithin(0, drop, this.tCount);
      this.tCount -= drop;
    }
    // build ribbon: samples (oldest → newest) + current position
    const pts = this.trail.pts, wid = this.trail.widths, alp = this.trail.alphas;
    let m = 0;
    for (let i = 0; i < this.tCount; i++, m++) {
      pts[m * 3] = this.tPos[i * 3]; pts[m * 3 + 1] = this.tPos[i * 3 + 1]; pts[m * 3 + 2] = this.tPos[i * 3 + 2];
      const age = Math.min((T - this.tTime[i]) / TRAIL_SECONDS, 1);
      const life = 1 - age;
      wid[m] = TRAIL_WIDTH * (0.15 + 0.85 * life);
      alp[m] = 0.5 * Math.pow(life, 1.4);
    }
    pts[m * 3] = p.x; pts[m * 3 + 1] = p.y; pts[m * 3 + 2] = p.z;
    wid[m] = TRAIL_WIDTH; alp[m] = 0.5; m++;
    // the segment touching the ball is hidden by the ball itself; no special case needed
    const t = this.trailTint;
    const r = 1 + (this.color.r - 1) * t, g = 1 + (this.color.g - 1) * t, b = 1 + (this.color.b - 1) * t;
    this.trail.writeStrip(0, m, r, g, b, this.camWorld.x, this.camWorld.y, this.camWorld.z);
    this.trail.commit();
  }

  /** age (sim seconds) of the oldest trail sample — for tests/debug */
  trailSpan(): number {
    return this.tCount > 0 ? this.simClock - this.tTime[0] : 0;
  }

  resetTrail(): void {
    this.tCount = 0;
    this.trail.clear();
    this.trail.commit();
  }

  dispose(): void {
    this.scene.remove(this.root);
    this.ballGeo.dispose();
    this.ballMat.dispose();
    this.ballTex.dispose();
    this.shadowGeo.dispose();
    this.shadowMat.dispose();
    this.shadowTex.dispose();
    this.gizmo.dispose();
    this.magnus.dispose();
    this.wind.dispose();
    this.trail.dispose();
  }
}

// ───────────────────────────── Spin inspector

const GIZMO_CLOSE: GizmoOptions = {
  axisMin: 1.3,
  axisMax: 1.95,
  shaftRadius: 0.045,
  headRadius: 0.13,
  headLength: 0.3,
  ringRadius: 1.42,
  ringTube: 0.045,
  ringHeadRadius: 0.13,
  ringHeadLength: 0.3,
  ringSpinRate: 2.5,
};

/** Close-up "spin cam" in its own small canvas: big ball, same orientation, axis + rotation arrows. */
export class SpinInspector {
  private readonly container: HTMLElement;
  private readonly renderer: THREE.WebGLRenderer | null = null;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly ball: THREE.Mesh;
  private readonly ballGeo: THREE.SphereGeometry;
  private readonly ballMat: THREE.MeshStandardMaterial;
  private readonly ballTex: THREE.Texture;
  private readonly gizmo: SpinGizmo;
  private readonly velArrow: SimpleArrow;
  private readonly color = new THREE.Color(1, 1, 1);
  private readonly resizeObs: ResizeObserver | null = null;
  private visible = true;
  private arrowsAlpha = 0;
  private width = 0;
  private height = 0;

  constructor(container: HTMLElement) {
    this.container = container;
    try {
      this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    } catch {
      this.renderer = null; // no WebGL: the inspector simply stays blank
    }
    if (this.renderer) {
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      this.renderer.setClearColor(0x000000, 0);
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      const el = this.renderer.domElement;
      el.style.display = 'block';
      el.style.width = '100%';
      el.style.height = '100%';
      container.appendChild(el);
    }
    // Player's perspective: looking toward -z, +x to the right, slightly from above
    this.camera = new THREE.PerspectiveCamera(32, 1, 0.1, 50);
    const elev = 10 * (Math.PI / 180);
    const dist = 8.6;
    this.camera.position.set(0, Math.sin(elev) * dist, Math.cos(elev) * dist);
    this.camera.lookAt(0, 0, 0);

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x445066, 1.4));
    const key = new THREE.DirectionalLight(0xffffff, 2.0);
    key.position.set(2, 4, 5);
    this.scene.add(key);

    this.ballTex = makeBallTexture();
    this.ballGeo = new THREE.SphereGeometry(1, 48, 32);
    this.ballMat = new THREE.MeshStandardMaterial({ map: this.ballTex, roughness: 0.45, metalness: 0 });
    this.ball = new THREE.Mesh(this.ballGeo, this.ballMat);
    this.scene.add(this.ball);

    this.gizmo = new SpinGizmo(1, GIZMO_CLOSE);
    this.scene.add(this.gizmo.group);
    this.velArrow = new SimpleArrow(0.03, 0.1, 0.24);
    this.velArrow.material.color.setRGB(0.85, 0.9, 1);
    this.scene.add(this.velArrow.group);

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObs = new ResizeObserver(() => this.resize());
      this.resizeObs.observe(container);
    }
    this.resize();
  }

  private resize(): void {
    if (!this.renderer) return;
    const w = Math.max(1, Math.floor(this.container.clientWidth || 220));
    const h = Math.max(1, Math.floor(this.container.clientHeight || 220));
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // keep the whole gizmo in view in narrow boxes
    const baseFov = 32;
    this.camera.fov = w < h ? (2 * Math.atan(Math.tan((baseFov * Math.PI) / 360) * (h / w)) * 180) / Math.PI : baseFov;
    this.camera.updateProjectionMatrix();
  }

  /** draw once with every part visible so the first spinning ball doesn't compile shaders */
  prewarm(): void {
    if (!this.renderer) return;
    if (this.container.clientWidth !== this.width || this.container.clientHeight !== this.height) this.resize();
    prewarmRender(this.renderer, this.scene, this.camera);
  }

  update(ball: BallState, orientation: THREE.Quaternion, dtReal: number, opts: BallViewOptions): void {
    if (!this.renderer || !this.visible) return;
    const dt = Math.min(Math.max(dtReal, 0), 0.1);
    if (this.container.clientWidth !== this.width || this.container.clientHeight !== this.height) this.resize();
    const w = ball.w, v = ball.v;
    const valid = finiteVec(w) && finiteVec(v);
    this.ball.visible = opts.visible;
    this.ball.quaternion.copy(orientation);

    const rps = valid ? Math.hypot(w.x, w.y, w.z) / (2 * Math.PI) : 0;
    const fade = spinFade(rps);
    if (valid) {
      spinColor(w, v, _rgb);
      _col.setRGB(_rgb.r, _rgb.g, _rgb.b, THREE.SRGBColorSpace);
      this.color.lerp(_col, 1 - Math.exp(-dt * 12));
    }
    const layers = assistLayers(opts);
    this.arrowsAlpha += ((layers.arrows ? 1 : 0) - this.arrowsAlpha) * (1 - Math.exp(-dt * 8));
    const a = opts.visible && valid ? this.arrowsAlpha * fade : 0;
    _v.set(w.x, w.y, w.z);
    this.gizmo.update(_v, rps, a, this.color, dt);

    const speed = valid ? Math.hypot(v.x, v.y, v.z) : 0;
    _v.set(v.x, v.y, v.z);
    this.velArrow.set(_v, 1.08, 2.05, opts.visible ? 0.3 * smoothstep(0.2, 1, speed) : 0);

    this.renderer.render(this.scene, this.camera);
  }

  setVisible(v: boolean): void {
    this.visible = v;
    if (this.renderer) this.renderer.domElement.style.visibility = v ? 'visible' : 'hidden';
  }

  dispose(): void {
    this.resizeObs?.disconnect();
    this.gizmo.dispose();
    this.velArrow.dispose();
    this.ballGeo.dispose();
    this.ballMat.dispose();
    this.ballTex.dispose();
    if (this.renderer) {
      this.renderer.dispose();
      this.renderer.domElement.remove();
    }
  }
}
