import * as THREE from 'three';
import type { PaddlePose } from '../contracts';
import { PADDLE_HALF_HEIGHT, PADDLE_HALF_WIDTH } from '../physics/constants';

export interface PaddleMeshOptions {
  /** colour of the hitting (front, +Z local) rubber */
  frontColor: number;
  backColor: number;
  /** semi-transparent (player's paddle, so the ball stays visible) */
  opacity?: number;
  /** ghost style (wireframe-ish, used for the "ideal angle" paddle) */
  ghost?: boolean;
}

/** Distance from the blade centre (along -up) to the middle of the grip. */
export const PADDLE_GRIP_OFFSET = 0.12;
/** Distance from the blade centre (along -up) to the very end of the handle. */
export const PADDLE_HANDLE_LENGTH_FROM_CENTRE = 0.186;

const WOOD_HALF_DEPTH = 0.0028;
const BEVEL = 0.0006;
const RUBBER_DEPTH = 0.0018;
const RUBBER_Z0 = WOOD_HALF_DEPTH + BEVEL; // where rubber starts on each face

/** Superellipse outline of the blade (slightly squarer than an ellipse, like a real blade). */
function bladePoints(scale: number, n = 64): THREE.Vector2[] {
  const pts: THREE.Vector2[] = [];
  const e = 2 / 2.35;
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const c = Math.cos(t);
    const s = Math.sin(t);
    pts.push(
      new THREE.Vector2(
        PADDLE_HALF_WIDTH * scale * Math.sign(c) * Math.pow(Math.abs(c), e),
        PADDLE_HALF_HEIGHT * scale * Math.sign(s) * Math.pow(Math.abs(s), e),
      ),
    );
  }
  return pts;
}

function handleGeometry(): THREE.LatheGeometry {
  // (radius, y) profile, from the blade throat down to the flared, rounded butt
  const prof: [number, number][] = [
    [0.0, -0.074],
    [0.0095, -0.074],
    [0.0115, -0.085],
    [0.0125, -0.11],
    [0.0135, -0.14],
    [0.0158, -0.165],
    [0.0172, -0.176],
    [0.0158, -0.183],
    [0.01, -0.1858],
    [0.0, -PADDLE_HANDLE_LENGTH_FROM_CENTRE],
  ];
  const g = new THREE.LatheGeometry(
    // LatheGeometry wants the profile bottom -> top for outward-facing normals
    prof.map(([r, y]) => new THREE.Vector2(r, y)).reverse(),
    24,
  );
  g.scale(1, 1, 0.62); // flattened grip, thinner across the blade
  return g;
}

/**
 * Paddle model. LOCAL FRAME: origin = blade centre, +Z = front face normal (frontColor side),
 * +Y = from handle toward blade tip. Blade ~ 15 x 16 cm, handle ~ 10 cm below the blade.
 *
 * group.userData.materials holds every material (for fades); call disposePaddle() to free.
 */
export function createPaddleMesh(opts: PaddleMeshOptions): THREE.Group {
  const group = new THREE.Group();
  group.name = opts.ghost ? 'paddle-ghost' : 'paddle';
  const ghost = !!opts.ghost;
  const opacity = ghost ? 0.3 : opts.opacity ?? 1;
  const transparent = ghost || opacity < 1;
  const materials: THREE.Material[] = [];

  const mat = (color: number, rough: number, extra: Partial<THREE.MeshStandardMaterialParameters> = {}) => {
    const m = ghost
      ? new THREE.MeshStandardMaterial({
          color: 0x9ff8ff,
          emissive: 0x22d3ee,
          emissiveIntensity: 0.9,
          roughness: 0.4,
          metalness: 0,
          transparent: true,
          opacity,
          depthWrite: false,
          side: THREE.DoubleSide,
        })
      : new THREE.MeshStandardMaterial({
          color,
          roughness: rough,
          metalness: 0,
          transparent,
          opacity,
          depthWrite: !transparent,
          ...extra,
        });
    materials.push(m);
    return m;
  };

  const woodMat = mat(0xd8a868, 0.55);
  const handleMat = mat(0xe8bd82, 0.5);
  const frontMat = mat(opts.frontColor, 0.42);
  const backMat = mat(opts.backColor, 0.42);
  const bandMat = mat(0x2b3a67, 0.4);
  if (ghost) (frontMat as THREE.MeshStandardMaterial).emissiveIntensity = 1.3;

  // Wooden core (full outline -> its rim shows around the slightly smaller rubbers)
  const coreShape = new THREE.Shape(bladePoints(1));
  const core = new THREE.ExtrudeGeometry(coreShape, {
    depth: WOOD_HALF_DEPTH * 2,
    bevelEnabled: true,
    bevelThickness: BEVEL,
    bevelSize: BEVEL,
    bevelSegments: 1,
    curveSegments: 1,
  });
  core.translate(0, 0, -WOOD_HALF_DEPTH);
  const coreMesh = new THREE.Mesh(core, woodMat);
  group.add(coreMesh);

  // Rubbers
  const rubberShape = new THREE.Shape(bladePoints(0.975));
  const rubberGeo = new THREE.ExtrudeGeometry(rubberShape, { depth: RUBBER_DEPTH, bevelEnabled: false, curveSegments: 1 });
  const front = new THREE.Mesh(rubberGeo, frontMat);
  front.position.z = RUBBER_Z0;
  front.name = 'rubber-front';
  group.add(front);
  const back = new THREE.Mesh(rubberGeo.clone(), backMat);
  back.position.z = -RUBBER_Z0 - RUBBER_DEPTH;
  back.name = 'rubber-back';
  group.add(back);

  // Handle + decorative band
  const handle = new THREE.Mesh(handleGeometry(), handleMat);
  group.add(handle);
  const bandGeo = new THREE.CylinderGeometry(0.0138, 0.0132, 0.008, 24, 1, true);
  bandGeo.scale(1, 1, 0.62);
  const band = new THREE.Mesh(bandGeo, bandMat);
  band.position.y = -0.1;
  group.add(band);

  // Outlines (ghost and translucent paddles keep a readable silhouette)
  if (transparent) {
    const lineMat = new THREE.LineBasicMaterial({
      color: ghost ? 0xc8fdff : 0xffffff,
      transparent: true,
      opacity: ghost ? 0.95 : Math.min(1, opacity + 0.45),
      depthWrite: false,
    });
    materials.push(lineMat);
    const outlinePts = bladePoints(1.002, 72).map((p) => new THREE.Vector3(p.x, p.y, 0));
    const outlineGeo = new THREE.BufferGeometry().setFromPoints(outlinePts);
    const zf = RUBBER_Z0 + RUBBER_DEPTH + 0.0003;
    const o1 = new THREE.LineLoop(outlineGeo, lineMat);
    o1.position.z = zf;
    const o2 = new THREE.LineLoop(outlineGeo.clone(), lineMat);
    o2.position.z = -zf;
    group.add(o1, o2);
    // handle silhouette as a thin outline in the blade plane
    const hp = [
      [0.0095, -0.076], [0.0125, -0.11], [0.0135, -0.14], [0.0172, -0.176], [0.01, -0.1862],
      [-0.01, -0.1862], [-0.0172, -0.176], [-0.0135, -0.14], [-0.0125, -0.11], [-0.0095, -0.076],
    ].map(([x, y]) => new THREE.Vector3(x, y, 0));
    const h1 = new THREE.Line(new THREE.BufferGeometry().setFromPoints(hp), lineMat);
    group.add(h1);
  }

  group.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      o.castShadow = !transparent;
      o.receiveShadow = !transparent;
      if (transparent) o.renderOrder = 2;
    }
  });
  group.userData.materials = materials;
  return group;
}

/** Free geometries and materials of any object tree (paddles, markers...). */
export function disposePaddle(obj: THREE.Object3D): void {
  const seen = new Set<THREE.Material>();
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    const mm = m.material as THREE.Material | THREE.Material[] | undefined;
    if (mm) (Array.isArray(mm) ? mm : [mm]).forEach((x) => seen.add(x));
  });
  seen.forEach((m) => m.dispose());
}

const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _m = new THREE.Matrix4();

/**
 * Orthonormal right-handed basis for a pose: z = normal, y = up made orthogonal to z,
 * x = y × z (= up × normal). Robust to non-unit / non-orthogonal / degenerate input.
 */
export function poseBasis(pose: PaddlePose, x: THREE.Vector3, y: THREE.Vector3, z: THREE.Vector3): void {
  z.set(pose.normal.x, pose.normal.y, pose.normal.z);
  if (z.lengthSq() < 1e-12) z.set(0, 0, 1);
  z.normalize();
  y.set(pose.up.x, pose.up.y, pose.up.z);
  y.addScaledVector(z, -y.dot(z));
  if (y.lengthSq() < 1e-10) {
    // up parallel to normal: pick any perpendicular (prefer world up)
    y.set(0, 1, 0).addScaledVector(z, -z.y);
    if (y.lengthSq() < 1e-10) y.set(0, 0, 1).addScaledVector(z, -z.z);
  }
  y.normalize();
  x.crossVectors(y, z).normalize();
}

/** Quaternion that maps local +Z -> pose.normal and local +Y -> pose.up (orthogonalised). */
export function poseQuaternion(pose: PaddlePose, out = new THREE.Quaternion()): THREE.Quaternion {
  poseBasis(pose, _x, _y, _z);
  _m.makeBasis(_x, _y, _z);
  return out.setFromRotationMatrix(_m);
}

/** World position of the grip (where a hand holds the handle). */
export function paddleGripPoint(pose: PaddlePose, out = new THREE.Vector3(), offset = PADDLE_GRIP_OFFSET): THREE.Vector3 {
  poseBasis(pose, _x, _y, _z);
  return out.set(pose.pos.x, pose.pos.y, pose.pos.z).addScaledVector(_y, -offset);
}

/** Place a paddle object so its local frame matches the pose (normal -> +Z, up -> +Y). */
export function applyPose(obj: THREE.Object3D, pose: PaddlePose): void {
  obj.position.set(pose.pos.x, pose.pos.y, pose.pos.z);
  poseQuaternion(pose, obj.quaternion);
}

/**
 * Fade a (transparent) paddle by `factor` (0..1) relative to the opacity it was built with.
 * Used to see the ball through the player's paddle while it is frozen just before contact.
 */
export function setPaddleFade(obj: THREE.Object3D, factor: number): void {
  const f = Math.min(Math.max(factor, 0), 1);
  obj.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    if (!m) return;
    for (const mat of Array.isArray(m) ? m : [m]) {
      if (!mat.transparent) continue;
      const base = (mat.userData.baseOpacity ??= mat.opacity) as number;
      mat.opacity = base * f;
    }
  });
}
