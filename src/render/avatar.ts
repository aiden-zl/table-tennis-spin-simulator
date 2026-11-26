import * as THREE from 'three';
import type { PaddlePose } from '../contracts';
import { paddleGripPoint } from './paddles';

/** Default standing spot (body root, feet on the floor). */
export const AVATAR_HOME_Z = -2.15;
const Z_MIN = -2.35;
const Z_MAX = -1.9;
const X_LIMIT = 1.3;
/** body x ≈ paddle x + this (right hand is on the world -x side of a +z-facing body) */
const BODY_X_OFFSET = 0.3;
/** body root stands this far behind (−z) the grip */
const BODY_Z_STANDOFF = 0.43;
/** max distance the reach correction may push the body beyond its smoothed spot */
const MAX_REACH_SHIFT = 0.3;
const THIGH = 0.42;
const SHIN = 0.42;
const ANKLE_Y = 0.1;
const MAX_CROUCH = 0.36;

const UPPER_ARM = 0.31;
const FOREARM = 0.33; // elbow -> centre of the grip (includes the hand)
const REACH = UPPER_ARM + FOREARM;

const SHOULDER_Y = 0.52; // above the hip pivot
const SHOULDER_HALF = 0.2;
const HIP_Y = ANKLE_Y + THIGH + SHIN - 0.01; // standing hip height (legs almost straight)

const PALETTE = {
  skin: 0xf2c29b,
  skinShade: 0xe0a98a,
  hair: 0x3b2a20,
  jersey: 0x1e88e5,
  jerseyAccent: 0xffd23f,
  shorts: 0x243b6b,
  sock: 0xffffff,
  shoe: 0xfafafa,
  shoeAccent: 0xff5a5f,
  sole: 0x3d4250,
  eye: 0x2a2230,
  cheek: 0xff9e9e,
  band: 0xff5a5f,
};

const Y_AXIS = new THREE.Vector3(0, 1, 0);

/**
 * Stylised (original design) opponent character standing at the far end (z ~ -2.15), holding
 * the opponent paddle. The paddle itself is driven by the pose; the body and arm follow it.
 *
 * `group` should stay at the scene origin (identity) — but the IK works in group-local space,
 * so moving the group as a whole is also safe.
 */
export class OpponentAvatar {
  readonly group = new THREE.Group();
  private readonly scene: THREE.Scene;
  private readonly body = new THREE.Group(); // feet on floor, slides in x/z
  private readonly torso = new THREE.Group(); // pivot at hips, twists + leans
  private readonly head = new THREE.Group();
  private readonly rShoulder = new THREE.Object3D();
  private readonly lShoulder = new THREE.Object3D();
  private readonly arms = new THREE.Group(); // arm meshes, posed in group-local space
  private readonly rUpper: THREE.Mesh;
  private readonly rFore: THREE.Mesh;
  private readonly rHand: THREE.Mesh;
  private readonly rElbow: THREE.Mesh;
  private readonly lUpper: THREE.Mesh;
  private readonly lFore: THREE.Mesh;
  private readonly lHand: THREE.Mesh;
  private readonly lElbow: THREE.Mesh;
  private readonly legs: { side: number; thigh: THREE.Mesh; knee: THREE.Mesh; shin: THREE.Mesh; ankle: THREE.Mesh; sock: THREE.Mesh }[] = [];
  private crouch = 0.1;
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];

  private bodyX = 0.35;
  private bodyZ = AVATAR_HOME_Z;
  private twist = 0;
  private lean = 0.12;
  private time = 0;
  private initialised = false;

  // scratch
  private readonly grip = new THREE.Vector3();
  private readonly sW = new THREE.Vector3();
  private readonly eW = new THREE.Vector3();
  private readonly hW = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();
  private readonly tmp2 = new THREE.Vector3();
  private readonly pole = new THREE.Vector3();
  private readonly legHip = new THREE.Vector3();
  private readonly legAnkle = new THREE.Vector3();
  private readonly legSock = new THREE.Vector3();
  /** debug: how far the reach correction pushed the body this frame (m) */
  lastReachShift = 0;
  private readonly ikDir = new THREE.Vector3();
  private readonly ikPerp = new THREE.Vector3();

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.group.name = 'opponent-avatar';
    const m = (color: number, rough = 0.6) => {
      const mat = new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0 });
      this.materials.push(mat);
      return mat;
    };
    const g = <T extends THREE.BufferGeometry>(geo: T): T => {
      this.geometries.push(geo);
      return geo;
    };
    const mesh = (geo: THREE.BufferGeometry, mat: THREE.Material, parent: THREE.Object3D, x = 0, y = 0, z = 0) => {
      const me = new THREE.Mesh(geo, mat);
      me.position.set(x, y, z);
      me.castShadow = true;
      me.receiveShadow = true;
      parent.add(me);
      return me;
    };

    const skin = m(PALETTE.skin, 0.65);
    const jersey = m(PALETTE.jersey, 0.55);
    const accent = m(PALETTE.jerseyAccent, 0.5);
    const shorts = m(PALETTE.shorts, 0.6);
    const sock = m(PALETTE.sock, 0.7);
    const shoe = m(PALETTE.shoe, 0.45);
    const shoeAccent = m(PALETTE.shoeAccent, 0.45);
    const sole = m(PALETTE.sole, 0.8);
    const hair = m(PALETTE.hair, 0.7);
    const eye = m(PALETTE.eye, 0.3);
    const white = m(0xffffff, 0.3);
    const cheek = m(PALETTE.cheek, 0.8);
    const band = m(PALETTE.band, 0.5);

    this.group.add(this.body);
    this.group.add(this.arms);

    // ── Legs & shoes (fixed to body root)
    // unit-height segments (+Y end = distal joint), stretched per frame by the leg IK
    const thighGeo = g(new THREE.CylinderGeometry(0.06, 0.072, 1, 14));
    const shinGeo = g(new THREE.CylinderGeometry(0.045, 0.058, 1, 14));
    const kneeGeo = g(new THREE.SphereGeometry(0.06, 12, 10));
    const ankleGeo = g(new THREE.SphereGeometry(0.047, 12, 10));
    const sockGeo = g(new THREE.CylinderGeometry(0.056, 0.052, 1, 16));
    const shoeGeo = g(new THREE.SphereGeometry(1, 20, 14));
    const soleGeo = g(new THREE.CylinderGeometry(1, 1, 1, 20));
    const stripeGeo = g(new THREE.TorusGeometry(0.045, 0.008, 6, 16, Math.PI));
    for (const side of [-1, 1]) {
      const lx = side * 0.11;
      this.legs.push({
        side,
        thigh: mesh(thighGeo, skin, this.body),
        knee: mesh(kneeGeo, skin, this.body),
        shin: mesh(shinGeo, skin, this.body),
        ankle: mesh(ankleGeo, sock, this.body, lx, ANKLE_Y, 0),
        sock: mesh(sockGeo, sock, this.body),
      });
      const s = mesh(shoeGeo, shoe, this.body, lx, 0.055, 0.035);
      s.scale.set(0.065, 0.05, 0.13);
      const so = mesh(soleGeo, sole, this.body, lx, 0.012, 0.035);
      so.scale.set(0.066, 0.024, 0.13);
      const st = mesh(stripeGeo, shoeAccent, this.body, lx + side * 0.06, 0.06, 0.04);
      st.rotation.y = Math.PI / 2;
      st.scale.set(1, 0.7, 1);
    }

    // ── Torso (pivot at hips)
    this.torso.position.set(0, HIP_Y, 0);
    this.torso.rotation.order = 'YXZ';
    this.body.add(this.torso);

    const shortsGeo = g(new THREE.CylinderGeometry(0.175, 0.195, 0.24, 24));
    const s = mesh(shortsGeo, shorts, this.torso, 0, -0.02, 0);
    s.scale.set(1, 1, 0.72);
    const shortStripeGeo = g(new THREE.BoxGeometry(0.012, 0.22, 0.03));
    mesh(shortStripeGeo, accent, this.torso, -0.193, -0.02, 0);
    mesh(shortStripeGeo, accent, this.torso, 0.193, -0.02, 0);

    const chestGeo = g(new THREE.CapsuleGeometry(0.17, 0.26, 8, 20));
    const chest = mesh(chestGeo, jersey, this.torso, 0, 0.3, 0);
    chest.scale.set(1.15, 1, 0.72);
    // accent chest band + hem band around the jersey
    const chestBandGeo = g(new THREE.CylinderGeometry(0.172, 0.172, 0.05, 28, 1, true));
    const cb = mesh(chestBandGeo, accent, this.torso, 0, 0.36, 0);
    cb.scale.set(1.165, 1, 0.74);
    const hemGeo = g(new THREE.CylinderGeometry(0.172, 0.172, 0.025, 28, 1, true));
    const hem = mesh(hemGeo, accent, this.torso, 0, 0.17, 0);
    hem.scale.set(1.165, 1, 0.74);
    // collar
    const collarGeo = g(new THREE.TorusGeometry(0.065, 0.016, 8, 20));
    const collar = mesh(collarGeo, accent, this.torso, 0, 0.555, 0);
    collar.rotation.x = Math.PI / 2;
    // sleeves (shoulder caps)
    const sleeveGeo = g(new THREE.SphereGeometry(0.075, 16, 12));
    mesh(sleeveGeo, jersey, this.torso, -SHOULDER_HALF, SHOULDER_Y, 0);
    mesh(sleeveGeo, jersey, this.torso, SHOULDER_HALF, SHOULDER_Y, 0);
    this.rShoulder.position.set(-SHOULDER_HALF, SHOULDER_Y, 0); // right shoulder: world -x
    this.lShoulder.position.set(SHOULDER_HALF, SHOULDER_Y, 0);
    this.torso.add(this.rShoulder, this.lShoulder);

    // neck + head
    const neckGeo = g(new THREE.CylinderGeometry(0.05, 0.055, 0.08, 14));
    mesh(neckGeo, skin, this.torso, 0, 0.6, 0);
    this.head.position.set(0, 0.74, 0.01);
    this.torso.add(this.head);
    const R = 0.125;
    const headGeo = g(new THREE.SphereGeometry(R, 28, 20));
    const hd = mesh(headGeo, skin, this.head);
    hd.scale.set(1, 1.04, 0.97);
    const hairGeo = g(new THREE.SphereGeometry(R * 1.06, 28, 16, 0, Math.PI * 2, 0, Math.PI * 0.42));
    const hr = mesh(hairGeo, hair, this.head, 0, 0.012, -0.006);
    hr.rotation.x = -0.25; // swept back a little, forehead shows
    const backHairGeo = g(new THREE.SphereGeometry(R * 1.04, 24, 14, 0, Math.PI, 0, Math.PI * 0.7));
    const bh = mesh(backHairGeo, hair, this.head, 0, 0.005, -0.01);
    bh.rotation.y = Math.PI; // half-sphere covering the back (-z)
    // swoopy fringe tuft
    const tuftGeo = g(new THREE.SphereGeometry(0.05, 14, 10));
    const tuft = mesh(tuftGeo, hair, this.head, -0.04, 0.1, 0.075);
    tuft.scale.set(1.3, 0.55, 0.8);
    tuft.rotation.z = 0.4;
    // sweatband
    const bandGeo = g(new THREE.TorusGeometry(0.113, 0.013, 8, 32));
    const hb = mesh(bandGeo, band, this.head, 0, 0.065, 0);
    hb.rotation.x = Math.PI / 2 - 0.15; // front sits a little higher than the back
    // ears
    const earGeo = g(new THREE.SphereGeometry(0.026, 12, 10));
    mesh(earGeo, skin, this.head, -R * 0.98, -0.005, 0).scale.set(0.6, 1, 0.8);
    mesh(earGeo, skin, this.head, R * 0.98, -0.005, 0).scale.set(0.6, 1, 0.8);
    // face (+z = toward the player)
    const eyeGeo = g(new THREE.SphereGeometry(0.016, 12, 10));
    const glintGeo = g(new THREE.SphereGeometry(0.0055, 8, 6));
    for (const side of [-1, 1]) {
      const ex = side * 0.042;
      const e = mesh(eyeGeo, eye, this.head, ex, 0.012, R * 0.94);
      e.scale.set(0.85, 1.25, 0.6);
      e.castShadow = false;
      const gl = mesh(glintGeo, white, this.head, ex + 0.005, 0.02, R * 0.955 + 0.008);
      gl.castShadow = false;
      const c = mesh(eyeGeo, cheek, this.head, side * 0.07, -0.03, 0.094);
      c.scale.set(1.3, 0.8, 0.5);
      c.castShadow = false;
      // eyebrows
      const brow = mesh(g(new THREE.CapsuleGeometry(0.005, 0.022, 3, 6)), hair, this.head, ex, 0.048, 0.106);
      brow.rotation.z = Math.PI / 2 + side * 0.15;
      brow.castShadow = false;
    }
    const smileGeo = g(new THREE.TorusGeometry(0.028, 0.0055, 6, 16, Math.PI));
    const smile = mesh(smileGeo, eye, this.head, 0, -0.035, 0.116);
    smile.rotation.z = Math.PI; // lower half-arc -> smile
    smile.rotation.x = 0.4; // follow the curve of the chin
    smile.castShadow = false;
    const noseGeo = g(new THREE.SphereGeometry(0.014, 10, 8));
    const nose = mesh(noseGeo, m(PALETTE.skinShade, 0.6), this.head, 0, -0.008, R * 0.99);
    nose.castShadow = false;

    // ── Arms
    // unit-height tapered cylinders along +Y (+Y end = distal joint), stretched per frame
    const upperGeo = g(new THREE.CylinderGeometry(0.041, 0.047, 1, 14));
    const foreGeo = g(new THREE.CylinderGeometry(0.033, 0.04, 1, 14));
    const jointGeo = g(new THREE.SphereGeometry(0.043, 12, 10));
    const handGeo = g(new THREE.SphereGeometry(0.045, 16, 12));
    const wristGeo = g(new THREE.TorusGeometry(0.04, 0.012, 6, 16));
    this.rUpper = mesh(upperGeo, skin, this.arms);
    this.rElbow = mesh(jointGeo, skin, this.arms);
    this.rFore = mesh(foreGeo, skin, this.arms);
    this.rHand = mesh(handGeo, skin, this.arms);
    this.rHand.scale.set(1, 1.15, 0.9);
    const wb = mesh(wristGeo, band, this.rHand, 0, -0.035, 0); // wristband just above the hand
    wb.rotation.x = Math.PI / 2;
    this.lUpper = mesh(upperGeo, skin, this.arms);
    this.lElbow = mesh(jointGeo, skin, this.arms);
    this.lFore = mesh(foreGeo, skin, this.arms);
    this.lHand = mesh(handGeo, skin, this.arms);

    scene.add(this.group);
  }

  /** pose = opponent paddle pose this frame; dtReal for idle animation */
  update(pose: PaddlePose, dtReal: number): void {
    const dt = Math.min(Math.max(dtReal, 0), 0.1);
    this.time += dt;
    const grip = paddleGripPoint(pose, this.grip);
    if (![grip.x, grip.y, grip.z].every(Number.isFinite)) return;
    // target in group-local space (group is normally identity)
    this.group.updateMatrixWorld(true);
    const target = this.group.worldToLocal(this.tmp2.copy(grip));

    // ── Body placement (smoothed)
    const wantX = THREE.MathUtils.clamp(target.x + BODY_X_OFFSET, -X_LIMIT, X_LIMIT);
    const wantZ = THREE.MathUtils.clamp(target.z - BODY_Z_STANDOFF, Z_MIN, Z_MAX);
    if (!this.initialised) {
      this.bodyX = wantX;
      this.bodyZ = wantZ;
      this.initialised = true;
    } else {
      const k = 1 - Math.exp(-dt * 7);
      this.bodyX += (wantX - this.bodyX) * k;
      this.bodyZ += (wantZ - this.bodyZ) * (1 - Math.exp(-dt * 4));
    }

    // ── Torso twist / lean follow the swing
    // twist>0 brings the right shoulder (-x) forward (+z): forward swing / follow-through
    const fwd = target.z - (this.bodyZ + BODY_Z_STANDOFF);
    const wantTwist = THREE.MathUtils.clamp(fwd * 1.4 + (this.bodyX - BODY_X_OFFSET - target.x) * -0.4, -0.55, 0.55);
    // low grips: bend forward and sink into the knees so the hand still reaches the handle
    const wantLean = THREE.MathUtils.clamp(0.2 + (1.15 - target.y) * 0.7 + fwd * 0.3, 0.05, 0.75);
    const wantCrouch = THREE.MathUtils.clamp(0.05 + (1.0 - target.y) * 0.6, 0, MAX_CROUCH);
    const kt = 1 - Math.exp(-dt * 12);
    this.twist += (wantTwist - this.twist) * kt;
    this.lean += (wantLean - this.lean) * kt;
    this.crouch += (wantCrouch - this.crouch) * kt;

    const breath = Math.sin(this.time * 2.1);
    this.body.position.set(this.bodyX, 0, this.bodyZ);
    this.torso.position.y = HIP_Y - this.crouch + 0.004 * breath;
    this.torso.rotation.set(this.lean, this.twist, 0);
    this.torso.scale.set(1, 1 + 0.008 * breath, 1 + 0.01 * breath);
    this.head.rotation.set(-this.lean * 0.6 + 0.02 * breath, -this.twist * 0.6, 0);

    // ── Reach correction: if the grip is beyond the arm's reach, shift the body horizontally
    this.body.updateMatrix();
    this.updateShoulder(this.rShoulder, this.sW);
    const baseX = this.body.position.x;
    const baseZ = this.body.position.z;
    for (let iter = 0; iter < 4; iter++) {
      const excess = this.sW.distanceTo(target) - REACH * 0.985;
      if (excess <= 1e-4) break;
      this.tmp.subVectors(target, this.sW);
      this.tmp.y = 0;
      const hl = this.tmp.length();
      if (hl > 1e-6) {
        const shift = Math.min(excess, hl);
        this.tmp.multiplyScalar(shift / hl);
        this.body.position.add(this.tmp);
        // cap the correction (arm straightens instead) and never walk into the table
        const ox = this.body.position.x - baseX;
        const oz = this.body.position.z - baseZ;
        const ol = Math.hypot(ox, oz);
        if (ol > MAX_REACH_SHIFT) {
          this.body.position.x = baseX + (ox * MAX_REACH_SHIFT) / ol;
          this.body.position.z = baseZ + (oz * MAX_REACH_SHIFT) / ol;
        }
        this.body.position.x = THREE.MathUtils.clamp(this.body.position.x, -X_LIMIT, X_LIMIT);
        this.body.position.z = Math.min(this.body.position.z, -1.65);
        this.updateShoulder(this.rShoulder, this.sW);
      } else break;
    }

    this.lastReachShift = Math.hypot(this.body.position.x - baseX, this.body.position.z - baseZ);

    // ── Legs: feet planted, knees bend forward as the hips sink (body-local space)
    for (const L of this.legs) {
      this.legHip.set(L.side * 0.1, this.torso.position.y, 0);
      this.legAnkle.set(L.side * 0.11, ANKLE_Y, 0);
      this.pole.set(L.side * 0.15, 0, 1);
      this.solveArm(this.legHip, this.legAnkle, this.pole, this.eW, this.hW, THIGH, SHIN);
      this.placeSegment(L.thigh, this.legHip, this.eW);
      this.placeSegment(L.shin, this.eW, this.hW);
      L.knee.position.copy(this.eW);
      L.ankle.position.copy(this.hW);
      this.legSock.subVectors(this.eW, this.hW).setLength(0.13).add(this.hW);
      this.placeSegment(L.sock, this.legSock, this.hW);
    }

    // ── Right arm: 2-bone IK to the grip
    // pole: elbow points down, out to the right side (-x) and slightly back
    this.pole.set(-0.65, -1, -0.35);
    this.solveArm(this.sW, target, this.pole, this.eW, this.hW);
    this.placeSegment(this.rUpper, this.sW, this.eW);
    this.placeSegment(this.rFore, this.eW, this.hW);
    this.rElbow.position.copy(this.eW);
    this.rHand.position.copy(this.hW);
    this.rHand.quaternion.setFromUnitVectors(Y_AXIS, this.tmp.subVectors(this.hW, this.eW).normalize());

    // ── Left arm: relaxed, balanced in front (counter-swings slightly)
    this.updateShoulder(this.lShoulder, this.sW);
    const sway = Math.sin(this.time * 1.3) * 0.015;
    this.tmp2.set(0.3, 1.0 + this.lean * 0.4 + 0.01 * breath, 0.22 - this.twist * 0.25 + sway);
    this.tmp2.applyMatrix4(this.body.matrix); // body-local -> group-local
    this.pole.set(0.7, -1, -0.3);
    this.solveArm(this.sW, this.tmp2, this.pole, this.eW, this.hW);
    this.placeSegment(this.lUpper, this.sW, this.eW);
    this.placeSegment(this.lFore, this.eW, this.hW);
    this.lElbow.position.copy(this.eW);
    this.lHand.position.copy(this.hW);
  }

  /** shoulder anchor position in group-local space (body matrix must be current) */
  private updateShoulder(anchor: THREE.Object3D, out: THREE.Vector3): void {
    this.body.updateMatrix();
    this.torso.updateMatrix();
    out.copy(anchor.position).applyMatrix4(this.torso.matrix).applyMatrix4(this.body.matrix);
  }

  /**
   * Analytic two-bone IK. s = shoulder, t = target, pole = preferred elbow direction.
   * Writes elbow and hand (hand = t when reachable, else the clamped point toward t).
   */
  private solveArm(
    s: THREE.Vector3,
    t: THREE.Vector3,
    pole: THREE.Vector3,
    elbow: THREE.Vector3,
    hand: THREE.Vector3,
    a = UPPER_ARM,
    b = FOREARM,
  ): void {
    const dir = this.ikDir.subVectors(t, s);
    let d = dir.length();
    if (d < 1e-6) {
      dir.set(0, -1, 0);
      d = 1e-6;
    } else dir.divideScalar(d);
    const dc = THREE.MathUtils.clamp(d, Math.abs(a - b) + 0.02, a + b - 1e-4);
    const cosA = THREE.MathUtils.clamp((a * a + dc * dc - b * b) / (2 * a * dc), -1, 1);
    const sinA = Math.sqrt(1 - cosA * cosA);
    const perp = this.ikPerp.copy(pole).addScaledVector(dir, -pole.dot(dir));
    if (perp.lengthSq() < 1e-8) perp.set(0, 0, 1).addScaledVector(dir, -dir.z);
    if (perp.lengthSq() < 1e-8) perp.set(1, 0, 0).addScaledVector(dir, -dir.x);
    perp.normalize();
    elbow.copy(s).addScaledVector(dir, a * cosA).addScaledVector(perp, a * sinA);
    // hand on target when reachable, else the furthest point toward it (arm nearly straight)
    hand.copy(s).addScaledVector(dir, dc);
  }

  /** stretch a unit capsule (height 1 + caps along Y) between two points */
  private placeSegment(seg: THREE.Mesh, a: THREE.Vector3, b: THREE.Vector3): void {
    const d = this.tmp.subVectors(b, a);
    const l = d.length();
    seg.position.addVectors(a, b).multiplyScalar(0.5);
    if (l < 1e-6) return;
    seg.quaternion.setFromUnitVectors(Y_AXIS, d.divideScalar(l));
    seg.scale.set(1, l, 1);
  }

  dispose(): void {
    this.scene.remove(this.group);
    this.geometries.forEach((g) => g.dispose());
    this.materials.forEach((m) => m.dispose());
  }
}
