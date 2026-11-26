import * as THREE from 'three';
import { axisHalfLength, ringPoint, ringTangent } from './math';

function makeCanvas(w: number, h: number): HTMLCanvasElement | OffscreenCanvas | null {
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  return null; // headless (tests)
}

/**
 * Equirectangular ball texture (u = longitude, v = latitude, poles = sphere ±Y):
 *  - dark navy great-circle stripe through both poles (longitude 0° / 180°)
 *  - navy pole caps
 *  - thin grey seam on the equator
 *  - two orange dots on the equator at ±90° (the poles of the stripe's great circle)
 *  - an asymmetric "★ 40+" logo so you can tell which side is which
 * Any rotation axis makes at least one of these sweep visibly.
 */
export function makeBallTexture(): THREE.Texture {
  const W = 1024, H = 512;
  const canvas = makeCanvas(W, H);
  const ctx = canvas?.getContext('2d') as CanvasRenderingContext2D | null | undefined;
  if (!canvas || !ctx) return new THREE.Texture();
  const navy = '#18213a';
  const orange = '#f07a1a';
  ctx.fillStyle = '#fbf8f0';
  ctx.fillRect(0, 0, W, H);
  // equator seam
  ctx.fillStyle = '#bdb5a5';
  ctx.fillRect(0, H / 2 - 2, W, 4);
  // meridian stripe (full great circle: u = 0 (wrapping) and u = 0.5)
  const sw = 40; // ≈14° of longitude
  ctx.fillStyle = navy;
  ctx.fillRect(W / 2 - sw / 2, 0, sw, H);
  ctx.fillRect(0, 0, sw / 2, H);
  ctx.fillRect(W - sw / 2, 0, sw / 2, H);
  // pole caps (latitude > ~78°)
  const cap = Math.round(H * (12 / 180));
  ctx.fillRect(0, 0, W, cap);
  ctx.fillRect(0, H - cap, W, cap);
  // equator dots at longitude 90° and 270°
  ctx.fillStyle = orange;
  for (const u of [0.25, 0.75]) {
    ctx.beginPath();
    ctx.ellipse(u * W, H / 2, 34, 34, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  // logo: star + "40+" at longitude ~135°, above the equator
  const lx = W * 0.375, ly = H * 0.36;
  ctx.fillStyle = orange;
  drawStar(ctx, lx - 58, ly, 22, 10);
  ctx.fillStyle = navy;
  ctx.font = 'bold 46px Arial, Helvetica, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText('40+', lx - 30, ly + 2);
  // small mark below the equator on the far side (longitude ~315°) for asymmetry
  ctx.fillStyle = navy;
  ctx.fillRect(W * 0.875 - 40, H * 0.62, 80, 14);

  const tex = new THREE.CanvasTexture(canvas as HTMLCanvasElement);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

function drawStar(ctx: CanvasRenderingContext2D, cx: number, cy: number, ro: number, ri: number): void {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? ro : ri;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const x = cx + r * Math.cos(a), y = cy + r * Math.sin(a);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
}

/** Soft radial blob for the contact shadow. */
export function makeBlobTexture(): THREE.Texture {
  const S = 128;
  const canvas = makeCanvas(S, S);
  const ctx = canvas?.getContext('2d') as CanvasRenderingContext2D | null | undefined;
  if (!canvas || !ctx) return new THREE.Texture();
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, 'rgba(0,0,0,1)');
  g.addColorStop(0.45, 'rgba(0,0,0,0.55)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  const tex = new THREE.CanvasTexture(canvas as HTMLCanvasElement);
  tex.needsUpdate = true;
  return tex;
}

/** Curve for the rotation ring in the axis-local frame (axis = +Y). */
class RingCurve extends THREE.Curve<THREE.Vector3> {
  constructor(private readonly radius: number, private readonly arc: number) {
    super();
  }
  override getPoint(t: number, target = new THREE.Vector3()): THREE.Vector3 {
    const p = ringPoint(t * this.arc);
    return target.set(p.x * this.radius, 0, p.z * this.radius);
  }
}

export interface GizmoOptions {
  /** all lengths in ball radii (the gizmo group is scaled by the ball radius) */
  axisMin: number;
  axisMax: number;
  shaftRadius: number;
  headRadius: number;
  headLength: number;
  ringRadius: number;
  ringTube: number;
  ringHeadRadius: number;
  ringHeadLength: number;
  /** visual angular speed of the ring itself (rad/s, always in the spin sense) */
  ringSpinRate: number;
}

const ARC = Math.PI * 1.5;
const _yAxis = new THREE.Vector3(0, 1, 0);
const _dir = new THREE.Vector3();

/**
 * Spin-axis arrow (through both poles) + a circular arrow showing the rotation sense.
 * Built in an axis-local frame (+Y = spin axis, i.e. ŵ) and scaled by `unit` (ball radius).
 * Right-hand rule: the ring's arrowhead points where the ball's surface moves.
 */
export class SpinGizmo {
  readonly group = new THREE.Group();
  private readonly ringSpin = new THREE.Group();
  private readonly shaft: THREE.Mesh;
  private readonly head: THREE.Mesh;
  private readonly tail: THREE.Mesh;
  private readonly matNorth: THREE.MeshBasicMaterial;
  private readonly matSouth: THREE.MeshBasicMaterial;
  private readonly matRing: THREE.MeshBasicMaterial;
  private readonly geoms: THREE.BufferGeometry[] = [];
  private ringPhase = 0;

  constructor(unit: number, private readonly o: GizmoOptions) {
    const mk = () =>
      new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, toneMapped: false });
    this.matNorth = mk();
    this.matSouth = mk();
    this.matRing = mk();

    // shaft: unit height cylinder spanning y∈[-0.5,0.5]; scaled in update
    const shaftG = new THREE.CylinderGeometry(o.shaftRadius, o.shaftRadius, 1, 12, 1, true);
    const headG = new THREE.ConeGeometry(o.headRadius, o.headLength, 18);
    headG.translate(0, o.headLength / 2, 0); // base at 0, tip at +headLength
    const tailG = new THREE.CylinderGeometry(o.headRadius * 0.8, o.headRadius * 0.8, o.headLength * 0.35, 18);
    this.geoms.push(shaftG, headG, tailG);
    this.shaft = new THREE.Mesh(shaftG, this.matSouth);
    this.head = new THREE.Mesh(headG, this.matNorth);
    this.tail = new THREE.Mesh(tailG, this.matSouth);
    this.group.add(this.shaft, this.head, this.tail);

    const ringG = new THREE.TubeGeometry(new RingCurve(o.ringRadius, ARC), 56, o.ringTube, 8, false);
    const ringHeadG = new THREE.ConeGeometry(o.ringHeadRadius, o.ringHeadLength, 16);
    ringHeadG.translate(0, o.ringHeadLength / 2, 0);
    // orient the cone (+Y) along the ring tangent at the arc's end, placed at the end point
    const t = ringTangent(ARC), p = ringPoint(ARC);
    const q = new THREE.Quaternion().setFromUnitVectors(_yAxis, new THREE.Vector3(t.x, t.y, t.z));
    ringHeadG.applyQuaternion(q);
    ringHeadG.translate(p.x * o.ringRadius, 0, p.z * o.ringRadius);
    this.geoms.push(ringG, ringHeadG);
    this.ringSpin.add(new THREE.Mesh(ringG, this.matRing), new THREE.Mesh(ringHeadG, this.matRing));
    this.group.add(this.ringSpin);
    this.group.scale.setScalar(unit);
    for (const m of [this.shaft, this.head, this.tail]) m.renderOrder = 3;
    for (const m of this.ringSpin.children) m.renderOrder = 3;
  }

  /**
   * @param axis   spin axis (any length; direction of w)
   * @param rps    spin rate
   * @param alpha  overall opacity (0 hides)
   * @param color  linear-space colour for the north pole / ring
   * @param dtReal real seconds (animates the ring)
   */
  update(axis: THREE.Vector3, rps: number, alpha: number, color: THREE.Color, dtReal: number): void {
    const len = axis.length();
    if (alpha < 0.01 || len < 1e-9) {
      this.group.visible = false;
      return;
    }
    this.group.visible = true;
    _dir.copy(axis).multiplyScalar(1 / len);
    this.group.quaternion.setFromUnitVectors(_yAxis, _dir);
    const half = axisHalfLength(rps, this.o.axisMin, this.o.axisMax);
    this.shaft.scale.set(1, 2 * half, 1);
    this.head.position.set(0, half, 0);
    this.tail.position.set(0, -half, 0);
    this.matNorth.color.copy(color);
    this.matSouth.color.copy(color).multiplyScalar(0.45).addScalar(0.08);
    this.matRing.color.copy(color);
    this.matNorth.opacity = alpha;
    this.matSouth.opacity = alpha * 0.9;
    this.matRing.opacity = alpha * 0.95;
    // ring rotates about +Y (= ŵ) in the positive (right-hand) sense
    this.ringPhase = (this.ringPhase + this.o.ringSpinRate * dtReal) % (Math.PI * 2);
    this.ringSpin.rotation.set(0, this.ringPhase, 0);
  }

  dispose(): void {
    for (const g of this.geoms) g.dispose();
    this.matNorth.dispose();
    this.matSouth.dispose();
    this.matRing.dispose();
  }
}

/** Simple arrow (shaft + cone) along local +Y from the origin, length set per frame. */
export class SimpleArrow {
  readonly group = new THREE.Group();
  readonly material: THREE.MeshBasicMaterial;
  private readonly shaft: THREE.Mesh;
  private readonly head: THREE.Mesh;
  private readonly geoms: THREE.BufferGeometry[];

  constructor(shaftRadius: number, headRadius: number, private readonly headLength: number) {
    this.material = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, toneMapped: false });
    const sg = new THREE.CylinderGeometry(shaftRadius, shaftRadius, 1, 10, 1, true);
    sg.translate(0, 0.5, 0); // y ∈ [0, 1]
    const hg = new THREE.ConeGeometry(headRadius, headLength, 16);
    hg.translate(0, headLength / 2, 0);
    this.geoms = [sg, hg];
    this.shaft = new THREE.Mesh(sg, this.material);
    this.head = new THREE.Mesh(hg, this.material);
    this.shaft.renderOrder = 3;
    this.head.renderOrder = 3;
    this.group.add(this.shaft, this.head);
  }

  /** start = distance from the origin where the shaft begins, length = total to the tip. */
  set(dir: THREE.Vector3, start: number, length: number, alpha: number): void {
    const l = dir.length();
    if (alpha < 0.01 || l < 1e-9 || length <= start) {
      this.group.visible = false;
      return;
    }
    this.group.visible = true;
    _dir.copy(dir).multiplyScalar(1 / l);
    this.group.quaternion.setFromUnitVectors(_yAxis, _dir);
    const shaftLen = Math.max(length - start - this.headLength, 1e-4);
    this.shaft.position.set(0, start, 0);
    this.shaft.scale.set(1, shaftLen, 1);
    this.head.position.set(0, start + shaftLen, 0);
    this.material.opacity = alpha;
  }

  dispose(): void {
    for (const g of this.geoms) g.dispose();
    this.material.dispose();
  }
}
