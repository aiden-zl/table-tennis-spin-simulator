import * as THREE from 'three';

/**
 * A batch of camera-facing tapered ribbons (one draw call) with per-vertex colour + alpha.
 * Buffers are allocated once; each frame the caller writes strips with writeStrip() and then
 * calls commit(). Positions are in the mesh's local space; `camLocal` (camera position in the
 * same space) is used to orient each ribbon toward the viewer.
 */
export class RibbonBatch {
  readonly mesh: THREE.Mesh;
  readonly geometry: THREE.BufferGeometry;
  readonly material: THREE.MeshBasicMaterial;
  private readonly pos: Float32Array;
  private readonly col: Float32Array;
  private readonly posAttr: THREE.BufferAttribute;
  private readonly colAttr: THREE.BufferAttribute;
  /** scratch input buffers for one strip (caller fills these, then calls writeStrip) */
  readonly pts: Float32Array;
  readonly widths: Float32Array;
  readonly alphas: Float32Array;

  constructor(readonly maxStrips: number, readonly maxPts: number, blending: THREE.Blending = THREE.NormalBlending) {
    const nVerts = maxStrips * maxPts * 2;
    this.pos = new Float32Array(nVerts * 3);
    this.col = new Float32Array(nVerts * 4);
    const quads = maxStrips * (maxPts - 1);
    const index = nVerts > 65535 ? new Uint32Array(quads * 6) : new Uint16Array(quads * 6);
    let k = 0;
    for (let s = 0; s < maxStrips; s++) {
      for (let i = 0; i < maxPts - 1; i++) {
        const a = (s * maxPts + i) * 2;
        index[k++] = a; index[k++] = a + 1; index[k++] = a + 2;
        index[k++] = a + 1; index[k++] = a + 3; index[k++] = a + 2;
      }
    }
    this.geometry = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.colAttr = new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('position', this.posAttr);
    this.geometry.setAttribute('color', this.colAttr);
    this.geometry.setIndex(new THREE.BufferAttribute(index, 1));
    this.material = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending,
      toneMapped: false,
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.pts = new Float32Array(maxPts * 3);
    this.widths = new Float32Array(maxPts);
    this.alphas = new Float32Array(maxPts);
  }

  /** Hide every strip (alpha 0, collapsed). */
  clear(): void {
    this.pos.fill(0);
    this.col.fill(0);
  }

  /**
   * Write strip `s` from the first `n` entries of pts/widths/alphas with colour (r,g,b).
   * Unused points are collapsed onto the last point with zero alpha.
   */
  writeStrip(s: number, n: number, r: number, g: number, b: number, camX: number, camY: number, camZ: number): void {
    const M = this.maxPts;
    const pts = this.pts, pos = this.pos, col = this.col;
    const base = s * M * 2;
    if (n < 2) {
      for (let i = 0; i < M * 2; i++) {
        const v = base + i;
        pos[v * 3] = pos[v * 3 + 1] = pos[v * 3 + 2] = 0;
        col[v * 4 + 3] = 0;
      }
      return;
    }
    let lastSx = 0, lastSy = 0, lastSz = 0;
    for (let i = 0; i < M; i++) {
      const ii = Math.min(i, n - 1);
      const px = pts[ii * 3], py = pts[ii * 3 + 1], pz = pts[ii * 3 + 2];
      const vA = base + i * 2;
      const vB = vA + 1;
      if (i < n) {
        const i0 = Math.max(ii - 1, 0), i1 = Math.min(ii + 1, n - 1);
        const tx = pts[i1 * 3] - pts[i0 * 3];
        const ty = pts[i1 * 3 + 1] - pts[i0 * 3 + 1];
        const tz = pts[i1 * 3 + 2] - pts[i0 * 3 + 2];
        const cx = camX - px, cy = camY - py, cz = camZ - pz;
        // side = t × toCam
        let sx = ty * cz - tz * cy;
        let sy = tz * cx - tx * cz;
        let sz = tx * cy - ty * cx;
        const sl = Math.hypot(sx, sy, sz);
        if (sl > 1e-12) {
          const h = (0.5 * this.widths[ii]) / sl;
          sx *= h; sy *= h; sz *= h;
          lastSx = sx; lastSy = sy; lastSz = sz;
        } else {
          sx = lastSx; sy = lastSy; sz = lastSz;
        }
        pos[vA * 3] = px + sx; pos[vA * 3 + 1] = py + sy; pos[vA * 3 + 2] = pz + sz;
        pos[vB * 3] = px - sx; pos[vB * 3 + 1] = py - sy; pos[vB * 3 + 2] = pz - sz;
        const al = this.alphas[ii];
        col[vA * 4] = r; col[vA * 4 + 1] = g; col[vA * 4 + 2] = b; col[vA * 4 + 3] = al;
        col[vB * 4] = r; col[vB * 4 + 1] = g; col[vB * 4 + 2] = b; col[vB * 4 + 3] = al;
      } else {
        pos[vA * 3] = pos[vB * 3] = px;
        pos[vA * 3 + 1] = pos[vB * 3 + 1] = py;
        pos[vA * 3 + 2] = pos[vB * 3 + 2] = pz;
        col[vA * 4 + 3] = 0; col[vB * 4 + 3] = 0;
      }
    }
  }

  commit(): void {
    this.posAttr.needsUpdate = true;
    this.colAttr.needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
