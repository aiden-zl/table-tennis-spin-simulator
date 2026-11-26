// Arena: renderer, camera rig, lights, table + net, floor/court and stylised background.
import * as THREE from 'three';
import {
  NET_HALF_WIDTH,
  NET_HEIGHT,
  TABLE_HALF_LENGTH,
  TABLE_HALF_WIDTH,
  TABLE_THICKNESS,
  TABLE_Y,
} from '../physics/constants';
import {
  barrierTexture,
  courtMatTexture,
  mulberry32,
  netTexture,
  tableTopTexture,
  wallTexture,
  woodFloorTexture,
} from './arena/textures';

export type CameraView = 'player' | 'side' | 'opponent';

export interface ArenaHandle {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  /** smoothly move the camera to a preset view (instant=true snaps) */
  setView(view: CameraView, instant?: boolean): void;
  getView(): CameraView;
  /** call every frame with REAL (unscaled) seconds; animates camera transitions & ambient bits */
  update(dtReal: number): void;
  render(): void;
  /** world point on the vertical plane z = planeZ under the given client (mouse) coords, or null */
  projectToPlane(clientX: number, clientY: number, planeZ: number): { x: number; y: number } | null;
  dispose(): void;
}

export interface CameraPreset {
  position: THREE.Vector3;
  lookAt: THREE.Vector3;
  fov: number;
}

/** Camera presets (world coords). Exported so other modules can reason about framing. */
export const CAMERA_PRESETS: Record<CameraView, CameraPreset> = {
  // Mid-court: eye ~3 m behind the player's end line, slightly elevated, looking down the
  // table. +x is screen-right. Framed so every contact point (z up to 1.72) stays above the
  // bottom HUD, even at 1280x720.
  player: { position: new THREE.Vector3(0, 1.72, 4.35), lookAt: new THREE.Vector3(0, 0.7, -0.3), fov: 46 },
  // From the player's right (+x) side: whole flight arc, opponent on screen-right, player on screen-left.
  side: { position: new THREE.Vector3(3.9, 1.4, -0.2), lookAt: new THREE.Vector3(0, 0.95, -0.2), fov: 48 },
  // Mid-table (player's half, slightly right) looking at the opponent's contact zone.
  opponent: { position: new THREE.Vector3(0.7, 1.28, 0.25), lookAt: new THREE.Vector3(-0.05, 0.95, -1.75), fov: 50 },
};

const TRANSITION_SECONDS = 0.6;
/** Below this aspect ratio (portrait-ish) the camera backs off so the framing still fits. */
const MIN_COMFORT_ASPECT = 1.25;
/**
 * Max camera back-off factor per view, keeping the camera inside the court boards (|x| < 4,
 * |z| < 6): side x <= 5.3 (looks over the low boards), player z <= -0.3 + 4.65 * 1.2 = 5.28.
 */
const MAX_BACKOFF: Record<CameraView, number> = { player: 1.2, side: 1.35, opponent: 1.4 };
const MAX_FOV = 78;
const DEG2RAD = Math.PI / 180;

/** Key light shadow frustum half-size (m) – covers table, both players and their paddles. */
export const SHADOW_HALF_EXTENT = 3.4;

const easeInOutCubic = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

// ---------------------------------------------------------------------------------------------
// Scene building helpers
// ---------------------------------------------------------------------------------------------

function mesh(
  geo: THREE.BufferGeometry,
  mat: THREE.Material | THREE.Material[],
  opts: { cast?: boolean; receive?: boolean } = {},
): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = opts.cast ?? false;
  m.receiveShadow = opts.receive ?? false;
  return m;
}

function buildTable(anisotropy: number): THREE.Group {
  const g = new THREE.Group();
  g.name = 'table';
  const W = TABLE_HALF_WIDTH * 2;
  const L = TABLE_HALF_LENGTH * 2;
  const T = TABLE_THICKNESS;

  // --- playing surface board (top face exactly at TABLE_Y) ---
  const topMat = new THREE.MeshStandardMaterial({
    map: tableTopTexture(anisotropy),
    roughness: 0.55,
    metalness: 0,
  });
  const sideMat = new THREE.MeshStandardMaterial({ color: 0x163f7c, roughness: 0.6 });
  const underMat = new THREE.MeshStandardMaterial({ color: 0x2a2f3a, roughness: 0.9 });
  // BoxGeometry face order: +x, -x, +y, -y, +z, -z
  const board = mesh(new THREE.BoxGeometry(W, T, L), [sideMat, sideMat, topMat, underMat, sideMat, sideMat], {
    cast: true,
    receive: true,
  });
  board.position.set(0, TABLE_Y - T / 2, 0);
  board.name = 'tableTop';
  g.add(board);

  // --- white lines, slightly above the surface + polygonOffset to avoid z-fighting ---
  const lineMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.5,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
  });
  const LINE_Y = TABLE_Y + 0.0008;
  const EDGE = 0.02;
  const CENTRE = 0.004;
  const addLine = (w: number, l: number, x: number, z: number): void => {
    const geo = new THREE.PlaneGeometry(w, l);
    geo.rotateX(-Math.PI / 2); // lies flat, normal +y
    const m = mesh(geo, lineMat, { receive: true });
    m.position.set(x, LINE_Y, z);
    m.renderOrder = 1;
    g.add(m);
  };
  addLine(EDGE, L, TABLE_HALF_WIDTH - EDGE / 2, 0); // right side line
  addLine(EDGE, L, -TABLE_HALF_WIDTH + EDGE / 2, 0); // left side line
  // end lines span between side lines (no overlap => no double-blending artefacts)
  addLine(W - 2 * EDGE, EDGE, 0, TABLE_HALF_LENGTH - EDGE / 2);
  addLine(W - 2 * EDGE, EDGE, 0, -TABLE_HALF_LENGTH + EDGE / 2);
  // centre line (doubles side), between end lines
  addLine(CENTRE, L - 2 * EDGE, 0, 0);

  // --- apron (dark skirt under the top) ---
  const apronMat = new THREE.MeshStandardMaterial({ color: 0x1d2230, roughness: 0.7 });
  const apronH = 0.07;
  const apronT = 0.025;
  const inset = 0.06;
  const apronY = TABLE_Y - T - apronH / 2;
  const ax = TABLE_HALF_WIDTH - inset;
  const az = TABLE_HALF_LENGTH - inset;
  const apronLong = new THREE.BoxGeometry(apronT, apronH, az * 2);
  const apronShort = new THREE.BoxGeometry(ax * 2, apronH, apronT);
  for (const sx of [-1, 1]) {
    const a = mesh(apronLong, apronMat, { cast: true });
    a.position.set(sx * (ax - apronT / 2), apronY, 0);
    g.add(a);
  }
  for (const sz of [-1, 1]) {
    const a = mesh(apronShort, apronMat, { cast: true });
    a.position.set(0, apronY, sz * (az - apronT / 2));
    g.add(a);
    // inner cross member near the centre of each half
    const c = mesh(apronShort, apronMat, { cast: true });
    c.position.set(0, apronY, sz * 0.04);
    g.add(c);
  }

  // --- undercarriage: legs, bars, wheels ---
  const metalMat = new THREE.MeshStandardMaterial({ color: 0x3b4252, roughness: 0.45, metalness: 0.6 });
  const footMat = new THREE.MeshStandardMaterial({ color: 0x15171c, roughness: 0.9 });
  const legTop = TABLE_Y - T; // legs meet the board underside
  const legBottom = 0.03;
  const legH = legTop - legBottom;
  const legGeo = new THREE.CylinderGeometry(0.025, 0.025, legH, 10);
  const footGeo = new THREE.CylinderGeometry(0.04, 0.045, 0.03, 12);
  const lx = TABLE_HALF_WIDTH - 0.2;
  const lz = TABLE_HALF_LENGTH - 0.35;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const leg = mesh(legGeo, metalMat, { cast: true });
      leg.position.set(sx * lx, legBottom + legH / 2, sz * lz);
      g.add(leg);
      const foot = mesh(footGeo, footMat, { cast: true });
      foot.position.set(sx * lx, 0.015, sz * lz);
      g.add(foot);
    }
  }
  // cross bars along x at each leg pair
  const barX = new THREE.CylinderGeometry(0.015, 0.015, lx * 2, 8);
  barX.rotateZ(Math.PI / 2);
  for (const sz of [-1, 1]) {
    const b = mesh(barX, metalMat, { cast: true });
    b.position.set(0, 0.22, sz * lz);
    g.add(b);
  }
  // longitudinal bars along z
  const barZ = new THREE.CylinderGeometry(0.015, 0.015, lz * 2, 8);
  barZ.rotateX(Math.PI / 2);
  for (const sx of [-1, 1]) {
    const b = mesh(barZ, metalMat, { cast: true });
    b.position.set(sx * lx, 0.16, 0);
    g.add(b);
  }
  // central support posts + wheels (the folding mechanism look)
  const postGeo = new THREE.CylinderGeometry(0.02, 0.02, legTop - 0.1, 8);
  const wheelGeo = new THREE.CylinderGeometry(0.05, 0.05, 0.03, 14);
  wheelGeo.rotateZ(Math.PI / 2);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const p = mesh(postGeo, metalMat, { cast: true });
      p.position.set(sx * (lx - 0.05), 0.1 + (legTop - 0.1) / 2, sz * 0.12);
      g.add(p);
      const w = mesh(wheelGeo, footMat, { cast: true });
      w.position.set(sx * (lx - 0.05), 0.05, sz * 0.12);
      g.add(w);
    }
  }

  // --- net assembly ---
  g.add(buildNet(anisotropy));
  return g;
}

function buildNet(anisotropy: number): THREE.Group {
  const g = new THREE.Group();
  g.name = 'net';
  const tapeH = 0.015;
  const meshH = NET_HEIGHT - tapeH;
  const width = NET_HALF_WIDTH * 2;

  const tex = netTexture(anisotropy);
  const cell = 0.014; // ~1.4 cm mesh
  tex.repeat.set(width / cell, meshH / cell);
  const netMat = new THREE.MeshStandardMaterial({
    map: tex,
    transparent: true,
    alphaTest: 0.05,
    depthWrite: false,
    side: THREE.DoubleSide,
    roughness: 0.9,
  });
  const net = mesh(new THREE.PlaneGeometry(width, meshH), netMat, { receive: true });
  net.position.set(0, TABLE_Y + meshH / 2, 0);
  g.add(net);

  // white top tape
  const tapeMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 });
  const tape = mesh(new THREE.BoxGeometry(width, tapeH, 0.004), tapeMat, { cast: true, receive: true });
  tape.position.set(0, TABLE_Y + NET_HEIGHT - tapeH / 2, 0);
  g.add(tape);
  // thin bottom cord
  const cord = mesh(new THREE.BoxGeometry(width, 0.003, 0.003), new THREE.MeshStandardMaterial({ color: 0x1a2340 }));
  cord.position.set(0, TABLE_Y + 0.0015, 0);
  g.add(cord);

  // posts + clamps
  const postMat = new THREE.MeshStandardMaterial({ color: 0x23324f, roughness: 0.4, metalness: 0.5 });
  const accentMat = new THREE.MeshStandardMaterial({ color: 0x5fd0ff, roughness: 0.5 });
  const postH = NET_HEIGHT + 0.005;
  const postGeo = new THREE.CylinderGeometry(0.011, 0.011, postH, 12);
  const capGeo = new THREE.SphereGeometry(0.014, 12, 8);
  const armLen = NET_HALF_WIDTH - TABLE_HALF_WIDTH + 0.02;
  const armGeo = new THREE.BoxGeometry(armLen, 0.025, 0.035);
  const jawGeo = new THREE.BoxGeometry(0.03, 0.008, 0.035);
  const knobGeo = new THREE.CylinderGeometry(0.012, 0.012, 0.03, 10);
  for (const sx of [-1, 1]) {
    const px = sx * NET_HALF_WIDTH;
    const post = mesh(postGeo, postMat, { cast: true });
    // post foot sits level with the arm (just below the playing surface)
    post.position.set(px, TABLE_Y - 0.012 + postH / 2, 0);
    g.add(post);
    const cap = mesh(capGeo, accentMat, { cast: true });
    cap.position.set(px, TABLE_Y - 0.012 + postH, 0);
    g.add(cap);
    // horizontal arm from the table edge out to the post, flush with the board side
    const arm = mesh(armGeo, postMat, { cast: true });
    arm.position.set(sx * (TABLE_HALF_WIDTH + armLen / 2 - 0.02), TABLE_Y - TABLE_THICKNESS / 2 - 0.004, 0);
    g.add(arm);
    // upper jaw gripping the top edge (tiny, just inside the white edge line)
    const jaw = mesh(jawGeo, postMat, { cast: true });
    jaw.position.set(sx * (TABLE_HALF_WIDTH - 0.005), TABLE_Y + 0.004, 0);
    g.add(jaw);
    // tension knob under the arm
    const knob = mesh(knobGeo, accentMat, { cast: true });
    knob.position.set(sx * (TABLE_HALF_WIDTH + 0.02), TABLE_Y - TABLE_THICKNESS - 0.025, 0);
    g.add(knob);
  }
  return g;
}

interface Surroundings {
  group: THREE.Group;
  crowd: { bodies: THREE.InstancedMesh; heads: THREE.InstancedMesh; base: Float32Array; phase: Float32Array };
}

const COURT_HALF_X = 4;
const COURT_HALF_Z = 6;

function buildSurroundings(anisotropy: number): Surroundings {
  const g = new THREE.Group();
  g.name = 'surroundings';

  // --- wooden hall floor ---
  const floorTex = woodFloorTexture(anisotropy);
  const FLOOR = 60;
  floorTex.repeat.set(FLOOR / 4, FLOOR / 4);
  const floorGeo = new THREE.PlaneGeometry(FLOOR, FLOOR);
  floorGeo.rotateX(-Math.PI / 2);
  const floor = mesh(floorGeo, new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.5 }), { receive: true });
  floor.name = 'floor';
  g.add(floor);

  // --- court mat (raised a few mm + polygonOffset) ---
  const matTex = courtMatTexture(anisotropy);
  matTex.repeat.set(COURT_HALF_X, COURT_HALF_Z);
  const matGeo = new THREE.PlaneGeometry(COURT_HALF_X * 2, COURT_HALF_Z * 2);
  matGeo.rotateX(-Math.PI / 2);
  const court = mesh(
    matGeo,
    new THREE.MeshStandardMaterial({
      map: matTex,
      roughness: 0.85,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -2,
    }),
    { receive: true },
  );
  court.position.y = 0.003;
  court.name = 'court';
  g.add(court);
  // white court border (slightly above the mat)
  const borderMat = new THREE.MeshStandardMaterial({
    color: 0xf6f1e8,
    roughness: 0.7,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
  });
  const bw = 0.06;
  const addBorder = (w: number, l: number, x: number, z: number): void => {
    const geo = new THREE.PlaneGeometry(w, l);
    geo.rotateX(-Math.PI / 2);
    const b = mesh(geo, borderMat, { receive: true });
    b.position.set(x, 0.005, z);
    g.add(b);
  };
  const bxIn = COURT_HALF_X - 0.35;
  const bzIn = COURT_HALF_Z - 0.35;
  addBorder(bw, bzIn * 2, bxIn, 0);
  addBorder(bw, bzIn * 2, -bxIn, 0);
  addBorder(bxIn * 2 - bw, bw, 0, bzIn);
  addBorder(bxIn * 2 - bw, bw, 0, -bzIn);

  // --- low divider boards around the court ---
  const bTex = barrierTexture(anisotropy);
  const boardFace = new THREE.MeshStandardMaterial({ map: bTex, roughness: 0.6 });
  const boardEdge = new THREE.MeshStandardMaterial({ color: 0x173a86, roughness: 0.6 });
  const boardTop = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 });
  const BOARD_W = 1.96;
  const BOARD_H = 0.72;
  const boardGeo = new THREE.BoxGeometry(BOARD_W, BOARD_H, 0.04);
  const footGeo = new THREE.BoxGeometry(0.06, 0.03, 0.4);
  const footMat = new THREE.MeshStandardMaterial({ color: 0x1b1f29, roughness: 0.8 });
  const boardMats = [boardEdge, boardEdge, boardTop, boardEdge, boardFace, boardFace];
  const placeBoard = (x: number, z: number, rotY: number): void => {
    const b = new THREE.Group();
    const panel = mesh(boardGeo, boardMats);
    panel.position.y = BOARD_H / 2 + 0.02;
    b.add(panel);
    for (const s of [-1, 1]) {
      const f = mesh(footGeo, footMat);
      f.position.set(s * (BOARD_W / 2 - 0.15), 0.015, 0);
      b.add(f);
    }
    b.position.set(x, 0, z);
    b.rotation.y = rotY;
    g.add(b);
  };
  const nX = Math.round((COURT_HALF_X * 2) / 2);
  const nZ = Math.round((COURT_HALF_Z * 2) / 2);
  for (let i = 0; i < nX; i++) {
    const x = -COURT_HALF_X + 1 + i * 2;
    placeBoard(x, -COURT_HALF_Z, 0);
    placeBoard(x, COURT_HALF_Z, 0);
  }
  for (let i = 0; i < nZ; i++) {
    const z = -COURT_HALF_Z + 1 + i * 2;
    placeBoard(-COURT_HALF_X, z, Math.PI / 2);
    placeBoard(COURT_HALF_X, z, Math.PI / 2);
  }

  // --- stands (stepped blocks) + low-poly crowd (instanced) ---
  const standMat = new THREE.MeshStandardMaterial({ color: 0xe9e4da, roughness: 0.8 });
  const seatMats = [0x3aa0e8, 0xffc93c].map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.6 }));
  const rnd = mulberry32(42);
  const seats: { x: number; y: number; z: number; rotY: number }[] = [];
  const ROWS = 4;
  const ROW_D = 0.85;
  const ROW_H = 0.42;

  /** A stand whose front edge is at local z=0, rows climbing toward local -z. */
  const addStand = (cx: number, cz: number, rotY: number, length: number): void => {
    const sg = new THREE.Group();
    for (let r = 0; r < ROWS; r++) {
      const h = ROW_H * (r + 1);
      const step = mesh(new THREE.BoxGeometry(length, h, ROW_D), standMat, { receive: false });
      step.position.set(0, h / 2, -ROW_D / 2 - r * ROW_D);
      sg.add(step);
      const bench = mesh(new THREE.BoxGeometry(length, 0.06, 0.32), seatMats[r % 2]);
      bench.position.set(0, h + 0.03, -0.35 - r * ROW_D);
      sg.add(bench);
      for (let s = -length / 2 + 0.35; s <= length / 2 - 0.3; s += 0.62) {
        if (rnd() < 0.62) {
          seats.push({ x: s + (rnd() - 0.5) * 0.12, y: h + 0.06, z: -0.4 - r * ROW_D, rotY: 0 });
          const last = seats[seats.length - 1];
          // convert local -> world now (stand transform)
          const v = new THREE.Vector3(last.x, last.y, last.z).applyAxisAngle(new THREE.Vector3(0, 1, 0), rotY);
          last.x = v.x + cx;
          last.y = v.y;
          last.z = v.z + cz;
          last.rotY = rotY;
        }
      }
    }
    sg.position.set(cx, 0, cz);
    sg.rotation.y = rotY;
    g.add(sg);
  };
  addStand(0, -COURT_HALF_Z - 1.2, 0, 10); // far end, faces +z (toward table)
  addStand(-COURT_HALF_X - 1.6, -1.5, Math.PI / 2, 8); // left side, faces +x
  addStand(COURT_HALF_X + 1.6, -1.5, -Math.PI / 2, 8); // right side, faces -x

  const shirtColors = [0xff6b6b, 0xffd93d, 0x6bcb77, 0x4d96ff, 0xff9f1c, 0x9b5de5, 0xf15bb5, 0x00bbf9, 0xffffff, 0x2ec4b6];
  const skinColors = [0xf6d2b5, 0xe8b28c, 0xc98c5f, 0x9a6440, 0x6b4428, 0xfbe0c8];
  const bodyGeo = new THREE.CylinderGeometry(0.15, 0.2, 0.5, 8);
  const headGeo = new THREE.IcosahedronGeometry(0.13, 1);
  const crowdMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7, flatShading: true });
  const headMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6, flatShading: true });
  const n = Math.max(1, seats.length);
  const bodies = new THREE.InstancedMesh(bodyGeo, crowdMat, n);
  const heads = new THREE.InstancedMesh(headGeo, headMat, n);
  const base = new Float32Array(n * 4); // x, y, z, rotY
  const phase = new Float32Array(n);
  const m4 = new THREE.Matrix4();
  const col = new THREE.Color();
  for (let i = 0; i < n; i++) {
    const s = seats[i] ?? { x: 0, y: -10, z: 0, rotY: 0 };
    base[i * 4] = s.x;
    base[i * 4 + 1] = s.y;
    base[i * 4 + 2] = s.z;
    base[i * 4 + 3] = s.rotY;
    phase[i] = rnd() * Math.PI * 2;
    bodies.setColorAt(i, col.setHex(shirtColors[Math.floor(rnd() * shirtColors.length)]));
    heads.setColorAt(i, col.setHex(skinColors[Math.floor(rnd() * skinColors.length)]));
  }
  bodies.frustumCulled = false; // instances move; bounds of the base geometry would be wrong
  heads.frustumCulled = false;
  g.add(bodies, heads);
  const crowd = { bodies, heads, base, phase };
  updateCrowd(crowd, 0, m4);

  // --- distant hall walls ---
  const wTex = wallTexture(anisotropy);
  const wallMatFor = (len: number): THREE.MeshStandardMaterial => {
    const t = wTex.clone();
    t.repeat.set(len / 4, 1);
    t.needsUpdate = true;
    return new THREE.MeshStandardMaterial({ map: t, roughness: 0.95 });
  };
  const WALL_H = 7;
  const addWall = (len: number, x: number, z: number, rotY: number): void => {
    const w = mesh(new THREE.PlaneGeometry(len, WALL_H), wallMatFor(len));
    w.position.set(x, WALL_H / 2, z);
    w.rotation.y = rotY;
    g.add(w);
  };
  addWall(30, 0, -13, 0); // faces +z
  addWall(30, -11, 0, Math.PI / 2); // faces +x
  addWall(30, 11, 0, -Math.PI / 2); // faces -x
  addWall(30, 0, 13, Math.PI); // faces -z

  // --- light towers at the corners (emissive panels, no real lights = cheap) ---
  const poleMat = new THREE.MeshStandardMaterial({ color: 0xb8c2d1, roughness: 0.4, metalness: 0.7 });
  const lampMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff4d6, emissiveIntensity: 2.2 });
  const lampFrameMat = new THREE.MeshStandardMaterial({ color: 0x2b3345, roughness: 0.6 });
  const poleGeo = new THREE.CylinderGeometry(0.06, 0.09, 6, 8);
  const frameGeo = new THREE.BoxGeometry(1.1, 0.6, 0.12);
  const lampGeo = new THREE.PlaneGeometry(1.0, 0.5);
  for (const [x, z] of [
    [-6.5, -9],
    [6.5, -9],
    [-6.5, 9],
    [6.5, 9],
  ] as const) {
    const tower = new THREE.Group();
    const pole = mesh(poleGeo, poleMat);
    pole.position.y = 3;
    tower.add(pole);
    const head = new THREE.Group();
    head.position.y = 6.1;
    const frame = mesh(frameGeo, lampFrameMat);
    head.add(frame);
    const lamp = mesh(lampGeo, lampMat);
    lamp.position.z = 0.061;
    head.add(lamp);
    tower.add(head);
    tower.position.set(x, 0, z);
    g.add(tower);
    // aim the lamp face (+z of head) at the table
    head.updateMatrixWorld(true);
    tower.updateMatrixWorld(true);
    head.lookAt(new THREE.Vector3(0, TABLE_Y, 0));
  }

  // --- benches, a towel box and a few plants (cheap props) ---
  const benchMat = new THREE.MeshStandardMaterial({ color: 0x4d96ff, roughness: 0.6 });
  const benchLegMat = new THREE.MeshStandardMaterial({ color: 0x2b3345, roughness: 0.6 });
  const addBench = (x: number, z: number, rotY: number): void => {
    const b = new THREE.Group();
    const seat = mesh(new THREE.BoxGeometry(1.6, 0.06, 0.38), benchMat, { receive: true });
    seat.position.y = 0.45;
    b.add(seat);
    for (const s of [-1, 1]) {
      const leg = mesh(new THREE.BoxGeometry(0.05, 0.42, 0.32), benchLegMat);
      leg.position.set(s * 0.7, 0.21, 0);
      b.add(leg);
    }
    b.position.set(x, 0, z);
    b.rotation.y = rotY;
    g.add(b);
  };
  addBench(-4.7, 1.0, Math.PI / 2); // outside the divider boards
  addBench(4.7, 1.0, Math.PI / 2);

  const towelBox = new THREE.Group();
  const tbBody = mesh(new THREE.BoxGeometry(0.4, 0.5, 0.3), new THREE.MeshStandardMaterial({ color: 0xffc93c, roughness: 0.6 }));
  tbBody.position.y = 0.25;
  towelBox.add(tbBody);
  const towel = mesh(new THREE.BoxGeometry(0.36, 0.04, 0.26), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 }));
  towel.position.y = 0.52;
  towelBox.add(towel);
  towelBox.position.set(2.9, 0, -2.6);
  g.add(towelBox);

  const potMat = new THREE.MeshStandardMaterial({ color: 0xd9734e, roughness: 0.8 });
  const leafMat = new THREE.MeshStandardMaterial({ color: 0x4caf50, roughness: 0.7, flatShading: true });
  const potGeo = new THREE.CylinderGeometry(0.28, 0.2, 0.45, 8);
  const leafGeo = new THREE.IcosahedronGeometry(0.55, 0);
  for (const [x, z] of [
    [-5.4, -6.6],
    [5.4, -6.6],
    [-9.5, -11.5],
    [9.5, -11.5],
  ] as const) {
    const pot = mesh(potGeo, potMat);
    pot.position.set(x, 0.225, z);
    g.add(pot);
    const leaves = mesh(leafGeo, leafMat);
    leaves.position.set(x, 0.85, z);
    leaves.scale.set(1, 1.25, 1);
    g.add(leaves);
  }

  return { group: g, crowd };
}

const _cq = new THREE.Quaternion();
const _cUp = new THREE.Vector3(0, 1, 0);
const _cOne = new THREE.Vector3(1, 1, 1);
const _cP = new THREE.Vector3();

function updateCrowd(crowd: Surroundings['crowd'], time: number, m4: THREE.Matrix4): void {
  const { bodies, heads, base, phase } = crowd;
  const q = _cq;
  const up = _cUp;
  const one = _cOne;
  const p = _cP;
  for (let i = 0; i < bodies.count; i++) {
    const bob = Math.max(0, Math.sin(time * 2.2 + phase[i])) * 0.035;
    q.setFromAxisAngle(up, base[i * 4 + 3] + Math.sin(time * 0.7 + phase[i]) * 0.15);
    p.set(base[i * 4], base[i * 4 + 1] + 0.25 + bob, base[i * 4 + 2]);
    m4.compose(p, q, one);
    bodies.setMatrixAt(i, m4);
    p.y += 0.36;
    m4.compose(p, q, one);
    heads.setMatrixAt(i, m4);
  }
  bodies.instanceMatrix.needsUpdate = true;
  heads.instanceMatrix.needsUpdate = true;
}

function buildSkyDome(): THREE.Mesh {
  const geo = new THREE.SphereGeometry(90, 32, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      topColor: { value: new THREE.Color(0x7fc3f5) },
      horizonColor: { value: new THREE.Color(0xf3f6fb) },
      bottomColor: { value: new THREE.Color(0xe8dcc8) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 topColor;
      uniform vec3 horizonColor;
      uniform vec3 bottomColor;
      varying vec3 vDir;
      void main() {
        float h = normalize(vDir).y;
        vec3 c = h > 0.0
          ? mix(horizonColor, topColor, pow(smoothstep(0.0, 0.85, h), 0.8))
          : mix(horizonColor, bottomColor, smoothstep(0.0, 0.25, -h));
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
  const dome = new THREE.Mesh(geo, mat);
  dome.name = 'skyDome';
  dome.renderOrder = -1;
  dome.frustumCulled = false;
  return dome;
}

// ---------------------------------------------------------------------------------------------
// createArena
// ---------------------------------------------------------------------------------------------

/** Build the whole environment (table, net, floor, walls, lights, renderer, camera) inside `container`. */
export function createArena(container: HTMLElement): ArenaHandle {
  // --- renderer ---
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const canvas = renderer.domElement;
  canvas.style.display = 'block';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.touchAction = 'none';
  container.appendChild(canvas);
  const anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());

  // --- scene ---
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf3f6fb);
  scene.fog = new THREE.Fog(0xeef2f7, 16, 55);
  scene.add(buildSkyDome());
  scene.add(buildTable(anisotropy));
  const surroundings = buildSurroundings(anisotropy);
  scene.add(surroundings.group);

  // --- lights ---
  const hemi = new THREE.HemisphereLight(0xeaf3ff, 0xb08a64, 1.35);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(0xfff2de, 2.6);
  key.name = 'keyLight';
  key.position.set(2.0, 6.5, 2.6);
  key.target.position.set(0, TABLE_Y, -0.2);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  const sc = key.shadow.camera;
  sc.left = -SHADOW_HALF_EXTENT;
  sc.right = SHADOW_HALF_EXTENT;
  sc.top = SHADOW_HALF_EXTENT;
  sc.bottom = -SHADOW_HALF_EXTENT;
  sc.near = 0.5;
  sc.far = 16;
  sc.updateProjectionMatrix();
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.015;
  scene.add(key, key.target);
  const fill = new THREE.DirectionalLight(0xcfe0ff, 0.55);
  fill.position.set(-3.5, 3.5, -2.5);
  fill.target.position.set(0, TABLE_Y, 0);
  scene.add(fill, fill.target);
  const rim = new THREE.DirectionalLight(0xffffff, 0.35);
  rim.position.set(0, 3, -6);
  rim.target.position.set(0, 1, 0);
  scene.add(rim, rim.target);

  // --- camera ---
  const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 200);
  camera.up.set(0, 1, 0);

  let currentView: CameraView = 'player';
  const curPos = new THREE.Vector3();
  const curLook = new THREE.Vector3();
  let curFov = 50;
  const fromPos = new THREE.Vector3();
  const fromLook = new THREE.Vector3();
  let fromFov = 50;
  let transitionT = 1; // 1 = done
  let transitioning = false;

  /** Preset adjusted for the current aspect (backs off on narrow viewports). */
  const presetFor = (view: CameraView, outPos: THREE.Vector3, outLook: THREE.Vector3): number => {
    const p = CAMERA_PRESETS[view];
    outLook.copy(p.lookAt);
    outPos.copy(p.position);
    const aspect = camera.aspect;
    if (aspect > 0 && aspect < MIN_COMFORT_ASPECT) {
      // keep roughly the same horizontal coverage: back off (limited so the camera never
      // enters stands/boards) and widen the FOV for the remainder.
      const f = MIN_COMFORT_ASPECT / aspect;
      const k = Math.min(MAX_BACKOFF[view], Math.pow(f, 0.6));
      outPos.sub(outLook).multiplyScalar(k).add(outLook);
      const halfTan = (Math.tan((p.fov * DEG2RAD) / 2) * f) / k;
      return Math.min(MAX_FOV, (2 * Math.atan(halfTan)) / DEG2RAD);
    }
    return p.fov;
  };

  const applyCamera = (): void => {
    camera.position.copy(curPos);
    if (camera.fov !== curFov) {
      camera.fov = curFov;
      camera.updateProjectionMatrix();
    }
    camera.lookAt(curLook);
    camera.updateMatrixWorld();
  };

  const snapTo = (view: CameraView): void => {
    curFov = presetFor(view, curPos, curLook);
    transitioning = false;
    transitionT = 1;
    applyCamera();
  };

  // --- sizing ---
  let lastW = 0;
  let lastH = 0;
  let useWindowSize = false;
  const resize = (): void => {
    let w = container.clientWidth;
    let h = container.clientHeight;
    if (useWindowSize || w === 0 || h === 0) {
      // container has no definite size: track the window instead (sticky, so a later
      // height:auto layout pass can't lock the aspect to a stale value)
      useWindowSize = true;
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    }
    w = Math.max(1, w);
    h = Math.max(1, h);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    if (w === lastW && h === lastH) return;
    lastW = w;
    lastH = h;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (!transitioning) snapTo(currentView); // re-frame for the new aspect
  };
  resize();
  snapTo('player');

  let ro: ResizeObserver | null = null;
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => resize());
    ro.observe(container);
  }
  window.addEventListener('resize', resize);

  // --- per-frame ---
  let time = 0;
  const crowdM4 = new THREE.Matrix4();
  const toPos = new THREE.Vector3();
  const toLook = new THREE.Vector3();

  const setView = (view: CameraView, instant = false): void => {
    if (instant) {
      currentView = view;
      snapTo(view);
      return;
    }
    if (view === currentView && !transitioning) return;
    currentView = view;
    fromPos.copy(curPos);
    fromLook.copy(curLook);
    fromFov = curFov;
    transitionT = 0;
    transitioning = true;
  };

  const update = (dtReal: number): void => {
    const dt = Number.isFinite(dtReal) ? Math.min(Math.max(dtReal, 0), 0.1) : 0;
    time += dt;
    if (transitioning) {
      transitionT = Math.min(1, transitionT + dt / TRANSITION_SECONDS);
      const e = easeInOutCubic(transitionT);
      const toFov = presetFor(currentView, toPos, toLook);
      curPos.lerpVectors(fromPos, toPos, e);
      curLook.lerpVectors(fromLook, toLook, e);
      // small lift mid-swoop so the camera never dives through the net/players
      curPos.y += Math.sin(Math.PI * e) * 0.2 * Math.min(1, fromPos.distanceTo(toPos) / 2);
      curFov = fromFov + (toFov - fromFov) * e;
      if (transitionT >= 1) {
        transitioning = false;
        curFov = presetFor(currentView, curPos, curLook);
      }
      applyCamera();
    }
    updateCrowd(surroundings.crowd, time, crowdM4);
  };

  const render = (): void => {
    renderer.render(scene, camera);
  };

  // --- picking ---
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  const hit = new THREE.Vector3();
  const projectToPlane = (clientX: number, clientY: number, planeZ: number): { x: number; y: number } | null => {
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    camera.updateMatrixWorld();
    raycaster.setFromCamera(ndc, camera);
    plane.set(plane.normal.set(0, 0, 1), -planeZ); // z - planeZ = 0
    const r = raycaster.ray.intersectPlane(plane, hit);
    if (!r) return null;
    return { x: hit.x, y: hit.y };
  };

  // --- cleanup ---
  const dispose = (): void => {
    ro?.disconnect();
    window.removeEventListener('resize', resize);
    const textures = new Set<THREE.Texture>();
    const materials = new Set<THREE.Material>();
    const geometries = new Set<THREE.BufferGeometry>();
    scene.traverse((obj) => {
      const m = obj as THREE.Mesh;
      if (m.geometry) geometries.add(m.geometry);
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (mat) (Array.isArray(mat) ? mat : [mat]).forEach((x) => materials.add(x));
      if (obj instanceof THREE.InstancedMesh) obj.dispose();
    });
    materials.forEach((mat) => {
      for (const v of Object.values(mat as unknown as Record<string, unknown>)) {
        if (v instanceof THREE.Texture) textures.add(v);
      }
      mat.dispose();
    });
    geometries.forEach((g) => g.dispose());
    textures.forEach((t) => t.dispose());
    key.shadow.map?.dispose();
    renderer.dispose();
    if (canvas.parentElement) canvas.parentElement.removeChild(canvas);
  };

  return {
    scene,
    camera,
    renderer,
    setView,
    getView: () => currentView,
    update,
    render,
    projectToPlane,
    dispose,
  };
}
