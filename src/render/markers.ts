import * as THREE from 'three';
import type { PaddlePose, Vec3 } from '../contracts';
import { TABLE_HALF_LENGTH, TABLE_HALF_WIDTH, TABLE_Y } from '../physics/constants';
import { applyPose, createPaddleMesh, disposePaddle } from './paddles';

export type PathKind = 'incoming' | 'actual' | 'ideal';

/** decals sit this far above the table top (plus polygonOffset) to avoid z-fighting */
const DECAL_LIFT = 0.0025;

const COLORS = {
  target: 0x3ddc97,
  targetRing: 0xb8ffe0,
  bounce: 0xffb347,
  good: 0x34d058,
  bad: 0xff4d4f,
  incoming: 0xe8f1ff,
  actual: 0xfff176,
  ideal: 0x35e0ff,
};

function decalMaterial(color: number, opacity: number, additive = false): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthWrite: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    toneMapped: false,
  });
}

/** Soft radial-gradient texture (white centre fading to transparent), built procedurally. */
function makeGlowTexture(): THREE.Texture | null {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,0.85)');
  g.addColorStop(0.55, 'rgba(255,255,255,0.45)');
  g.addColorStop(0.8, 'rgba(255,255,255,0.12)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function onTable(p: Vec3): boolean {
  return Math.abs(p.x) <= TABLE_HALF_WIDTH + 1e-3 && Math.abs(p.z) <= TABLE_HALF_LENGTH + 1e-3;
}

interface PathLine {
  line: THREE.Line;
  capacity: number;
}

/** Table decals, trajectory lines and the ghost "ideal angle" paddle. */
export class Markers {
  readonly group = new THREE.Group();
  private readonly scene: THREE.Scene;
  private readonly glowTex: THREE.Texture | null;
  private readonly disposables: { dispose(): void }[] = [];

  // target zone
  private readonly target = new THREE.Group();
  private readonly targetRing: THREE.Mesh;
  private readonly targetGlow: THREE.Mesh;
  private readonly targetRingMat: THREE.MeshBasicMaterial;
  private readonly targetGlowMat: THREE.MeshBasicMaterial;

  // incoming bounce
  private readonly bounce = new THREE.Group();
  private readonly bounceRing: THREE.Mesh;
  private readonly bounceRipple: THREE.Mesh;
  private readonly bounceRippleMat: THREE.MeshBasicMaterial;
  private readonly bounceRingMat: THREE.MeshBasicMaterial;
  private bounceAge = 0;

  // landing
  private readonly landing = new THREE.Group();
  private readonly landingDisc: THREE.Mesh;
  private readonly landingRing: THREE.Mesh;
  private readonly landingCross: THREE.Group;
  private readonly landingDiscMat: THREE.MeshBasicMaterial;
  private readonly landingRingMat: THREE.MeshBasicMaterial;
  private readonly landingCrossMat: THREE.MeshBasicMaterial;
  private landingAge = 0;

  // paths
  private readonly paths: Record<PathKind, PathLine>;

  // ghost paddle
  private readonly ghost: THREE.Group;
  private readonly ghostMats: THREE.Material[];

  private time = 0;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.group.name = 'markers';
    this.glowTex = makeGlowTexture();
    if (this.glowTex) this.disposables.push(this.glowTex);

    const geo = <T extends THREE.BufferGeometry>(g: T): T => {
      g.rotateX(-Math.PI / 2); // lie flat, facing up
      this.disposables.push(g);
      return g;
    };
    const matReg = <T extends THREE.Material>(m: T): T => {
      this.disposables.push(m);
      return m;
    };
    const flat = (g: THREE.BufferGeometry, m: THREE.Material, parent: THREE.Object3D, order: number) => {
      const me = new THREE.Mesh(g, m);
      me.renderOrder = order;
      me.frustumCulled = false;
      parent.add(me);
      return me;
    };

    // ── Target zone: soft glow disc + crisp ring + inner dot
    this.targetGlowMat = matReg(decalMaterial(COLORS.target, 0.55, true));
    if (this.glowTex) this.targetGlowMat.map = this.glowTex;
    this.targetRingMat = matReg(decalMaterial(COLORS.targetRing, 0.85));
    this.targetGlow = flat(geo(new THREE.CircleGeometry(0.2, 48)), this.targetGlowMat, this.target, 3);
    this.targetRing = flat(geo(new THREE.RingGeometry(0.115, 0.135, 64)), this.targetRingMat, this.target, 4);
    flat(geo(new THREE.RingGeometry(0.05, 0.062, 48)), this.targetRingMat, this.target, 4);
    flat(geo(new THREE.CircleGeometry(0.016, 24)), this.targetRingMat, this.target, 4);
    this.target.visible = false;

    // ── Incoming bounce: persistent ring + expanding ripple
    this.bounceRingMat = matReg(decalMaterial(COLORS.bounce, 0.8));
    this.bounceRippleMat = matReg(decalMaterial(COLORS.bounce, 0.0));
    this.bounceRing = flat(geo(new THREE.RingGeometry(0.035, 0.048, 48)), this.bounceRingMat, this.bounce, 5);
    this.bounceRipple = flat(geo(new THREE.RingGeometry(0.04, 0.05, 48)), this.bounceRippleMat, this.bounce, 5);
    const dotMat = matReg(decalMaterial(COLORS.bounce, 0.45));
    flat(geo(new THREE.CircleGeometry(0.02, 24)), dotMat, this.bounce, 5);
    this.bounce.visible = false;

    // ── Landing marker for the player's return
    this.landingDiscMat = matReg(decalMaterial(COLORS.good, 0.35, true));
    if (this.glowTex) this.landingDiscMat.map = this.glowTex;
    this.landingRingMat = matReg(decalMaterial(COLORS.good, 0.95));
    this.landingCrossMat = matReg(decalMaterial(COLORS.bad, 0.95));
    this.landingDisc = flat(geo(new THREE.CircleGeometry(0.1, 40)), this.landingDiscMat, this.landing, 6);
    this.landingRing = flat(geo(new THREE.RingGeometry(0.05, 0.066, 48)), this.landingRingMat, this.landing, 7);
    this.landingCross = new THREE.Group();
    const barGeo = geo(new THREE.PlaneGeometry(0.11, 0.018));
    for (const a of [Math.PI / 4, -Math.PI / 4]) {
      const bar = flat(barGeo, this.landingCrossMat, this.landingCross, 7);
      bar.rotation.y = a;
    }
    this.landing.add(this.landingCross);
    this.landing.visible = false;

    this.group.add(this.target, this.bounce, this.landing);

    // ── Trajectory lines
    const mkPath = (kind: PathKind): PathLine => {
      let mat: THREE.LineBasicMaterial | THREE.LineDashedMaterial;
      if (kind === 'incoming') {
        mat = new THREE.LineDashedMaterial({
          color: COLORS.incoming,
          dashSize: 0.06,
          gapSize: 0.04,
          transparent: true,
          opacity: 0.7,
          depthWrite: false,
        });
      } else {
        mat = new THREE.LineBasicMaterial({
          color: kind === 'actual' ? COLORS.actual : COLORS.ideal,
          transparent: true,
          opacity: kind === 'actual' ? 0.95 : 0.85,
          depthWrite: false,
        });
      }
      matReg(mat);
      const line = new THREE.Line(new THREE.BufferGeometry(), mat);
      line.frustumCulled = false;
      line.renderOrder = 8;
      line.visible = false;
      line.name = `path-${kind}`;
      this.group.add(line);
      return { line, capacity: 0 };
    };
    this.paths = { incoming: mkPath('incoming'), actual: mkPath('actual'), ideal: mkPath('ideal') };

    // ── Ghost paddle
    this.ghost = createPaddleMesh({ frontColor: 0x35e0ff, backColor: 0x35e0ff, ghost: true });
    this.ghost.visible = false;
    this.ghostMats = (this.ghost.userData.materials as THREE.Material[]) ?? [];
    this.ghostMats.forEach((m) => (m.userData.baseOpacity = m.opacity));
    this.group.add(this.ghost);

    scene.add(this.group);
  }

  private placeDecal(obj: THREE.Object3D, p: Vec3): void {
    const y = onTable(p) ? TABLE_Y + DECAL_LIFT : p.y + DECAL_LIFT;
    obj.position.set(p.x, y, p.z);
  }

  /** target zone on the opponent's half (where you should aim) */
  setTarget(p: Vec3 | null): void {
    if (!p) {
      this.target.visible = false;
      return;
    }
    this.placeDecal(this.target, p);
    this.target.position.y = TABLE_Y + DECAL_LIFT; // always a table decal
    this.target.visible = true;
  }

  /** ring where the incoming ball bounced on the player's side */
  setIncomingBounce(p: Vec3 | null): void {
    if (!p) {
      this.bounce.visible = false;
      return;
    }
    this.placeDecal(this.bounce, p);
    this.bounce.position.y += 0.0005; // above the target decal if they overlap
    this.bounce.visible = true;
    this.bounceAge = 0;
  }

  /** landing marker for the player's return */
  setLanding(p: Vec3 | null, good: boolean): void {
    if (!p) {
      this.landing.visible = false;
      return;
    }
    this.placeDecal(this.landing, p);
    this.landing.position.y += 0.001;
    const c = good ? COLORS.good : COLORS.bad;
    this.landingDiscMat.color.setHex(c);
    this.landingRingMat.color.setHex(c);
    this.landingCross.visible = !good;
    this.landingRing.visible = good;
    this.landing.visible = true;
    this.landingAge = 0;
  }

  /** polyline trajectory; null hides it */
  setPath(kind: PathKind, points: Vec3[] | null): void {
    const path = this.paths[kind];
    if (!path) return;
    const n = points ? points.length : 0;
    if (!points || n < 2) {
      path.line.visible = false;
      return;
    }
    let geom = path.line.geometry as THREE.BufferGeometry;
    if (n > path.capacity) {
      const cap = Math.max(64, Math.ceil(n * 1.5));
      geom.dispose();
      geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage));
      geom.setAttribute('lineDistance', new THREE.BufferAttribute(new Float32Array(cap), 1).setUsage(THREE.DynamicDrawUsage));
      path.line.geometry = geom;
      path.capacity = cap;
    }
    const pos = geom.getAttribute('position') as THREE.BufferAttribute;
    const dist = geom.getAttribute('lineDistance') as THREE.BufferAttribute;
    const pa = pos.array as Float32Array;
    const da = dist.array as Float32Array;
    let acc = 0;
    let px = points[0].x;
    let py = points[0].y;
    let pz = points[0].z;
    for (let i = 0; i < n; i++) {
      const q = points[i];
      const x = Number.isFinite(q.x) ? q.x : px;
      const y = Number.isFinite(q.y) ? q.y : py;
      const z = Number.isFinite(q.z) ? q.z : pz;
      if (i > 0) acc += Math.hypot(x - px, y - py, z - pz);
      pa[i * 3] = x;
      pa[i * 3 + 1] = y;
      pa[i * 3 + 2] = z;
      da[i] = acc;
      px = x;
      py = y;
      pz = z;
    }
    pos.needsUpdate = true;
    dist.needsUpdate = true;
    geom.setDrawRange(0, n);
    path.line.visible = true;
  }

  /** translucent ghost paddle at the ideal angle; null hides */
  setGhostPaddle(pose: PaddlePose | null): void {
    if (!pose) {
      this.ghost.visible = false;
      return;
    }
    applyPose(this.ghost, pose);
    this.ghost.visible = true;
  }

  clearAll(): void {
    this.target.visible = false;
    this.bounce.visible = false;
    this.landing.visible = false;
    this.ghost.visible = false;
    (Object.keys(this.paths) as PathKind[]).forEach((k) => (this.paths[k].line.visible = false));
  }

  update(dtReal: number): void {
    const dt = Math.min(Math.max(dtReal, 0), 0.1);
    this.time += dt;
    const t = this.time;

    if (this.target.visible) {
      const pulse = 0.5 + 0.5 * Math.sin(t * 3.2);
      this.targetGlow.scale.setScalar(0.9 + 0.15 * pulse);
      this.targetGlowMat.opacity = 0.4 + 0.25 * pulse;
      this.targetRing.scale.setScalar(1 + 0.05 * pulse);
      this.targetRingMat.opacity = 0.7 + 0.25 * pulse;
    }

    if (this.bounce.visible) {
      this.bounceAge += dt;
      const RIPPLE = 0.7;
      const u = Math.min(this.bounceAge / RIPPLE, 1);
      const ease = 1 - Math.pow(1 - u, 3);
      this.bounceRipple.scale.setScalar(1 + 3.2 * ease);
      this.bounceRippleMat.opacity = u < 1 ? 0.9 * (1 - u) : 0;
      this.bounceRipple.visible = u < 1;
      // ring pops in, then settles
      const pop = this.bounceAge < 0.25 ? 1 + 0.6 * Math.sin((this.bounceAge / 0.25) * Math.PI) : 1;
      this.bounceRing.scale.setScalar(pop);
      this.bounceRingMat.opacity = 0.55 + 0.25 * Math.min(1, this.bounceAge * 4);
    }

    if (this.landing.visible) {
      this.landingAge += dt;
      const a = this.landingAge;
      const pop = a < 0.3 ? 0.4 + 0.6 * (1 - Math.pow(1 - a / 0.3, 3)) + 0.25 * Math.sin((a / 0.3) * Math.PI) : 1;
      this.landingRing.scale.setScalar(pop);
      this.landingCross.scale.setScalar(pop);
      const glow = 0.5 + 0.5 * Math.sin(t * 4);
      this.landingDisc.scale.setScalar(pop * (0.95 + 0.1 * glow));
      this.landingDiscMat.opacity = 0.25 + 0.2 * glow;
    }

    if (this.ghost.visible) {
      const s = 0.85 + 0.15 * Math.sin(t * 5);
      for (const m of this.ghostMats) m.opacity = (m.userData.baseOpacity ?? m.opacity) * s;
    }
  }

  /** Remove from the scene and free GPU resources. */
  dispose(): void {
    this.scene.remove(this.group);
    (Object.keys(this.paths) as PathKind[]).forEach((k) => this.paths[k].line.geometry.dispose());
    disposePaddle(this.ghost);
    this.disposables.forEach((d) => d.dispose());
  }
}
