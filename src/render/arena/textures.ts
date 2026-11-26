// Procedural CanvasTextures for the arena (no external assets).
import * as THREE from 'three';

/** Small deterministic PRNG so the scene looks identical every load. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');
  return [c, ctx];
}

function finish(
  canvas: HTMLCanvasElement,
  opts: { srgb?: boolean; repeat?: [number, number]; anisotropy?: number } = {},
): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  if (opts.srgb !== false) tex.colorSpace = THREE.SRGBColorSpace;
  if (opts.repeat) {
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(opts.repeat[0], opts.repeat[1]);
  }
  tex.anisotropy = opts.anisotropy ?? 8;
  tex.needsUpdate = true;
  return tex;
}

function speckle(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  count: number,
  alpha: number,
  rnd: () => number,
): void {
  for (let i = 0; i < count; i++) {
    const light = rnd() < 0.5;
    ctx.fillStyle = light ? `rgba(255,255,255,${alpha * rnd()})` : `rgba(0,0,0,${alpha * rnd()})`;
    const s = rnd() < 0.85 ? 1 : 2;
    ctx.fillRect(Math.floor(rnd() * w), Math.floor(rnd() * h), s, s);
  }
}

/** Blue playing surface: flat ITTF blue with a very fine, subtle matte speckle. */
export function tableTopTexture(anisotropy: number): THREE.CanvasTexture {
  const w = 512;
  const h = 1024; // matches the 1.525 x 2.74 aspect closely
  const [c, ctx] = makeCanvas(w, h);
  ctx.fillStyle = '#1c5db8';
  ctx.fillRect(0, 0, w, h);
  // gentle large-scale tonal variation (never perfectly flat CG)
  const g = ctx.createRadialGradient(w * 0.5, h * 0.5, 50, w * 0.5, h * 0.5, h * 0.7);
  g.addColorStop(0, 'rgba(255,255,255,0.05)');
  g.addColorStop(1, 'rgba(0,0,30,0.06)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  speckle(ctx, w, h, 60000, 0.07, mulberry32(11));
  return finish(c, { anisotropy });
}

/** Warm wooden planks (sports-hall parquet). Represents ~4 m x 4 m. */
export function woodFloorTexture(anisotropy: number): THREE.CanvasTexture {
  const size = 1024;
  const [c, ctx] = makeCanvas(size, size);
  const rnd = mulberry32(7);
  const rows = 32;
  const rowH = size / rows;
  for (let r = 0; r < rows; r++) {
    let x = -Math.floor(rnd() * 300);
    while (x < size) {
      const len = 220 + Math.floor(rnd() * 320);
      const hue = 28 + rnd() * 8;
      const sat = 48 + rnd() * 12;
      const lig = 56 + rnd() * 10;
      ctx.fillStyle = `hsl(${hue},${sat}%,${lig}%)`;
      ctx.fillRect(x, r * rowH, len, rowH);
      // grain
      for (let k = 0; k < 7; k++) {
        ctx.strokeStyle = `rgba(110,60,20,${0.05 + rnd() * 0.08})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        const y0 = r * rowH + 2 + rnd() * (rowH - 4);
        ctx.moveTo(x, y0);
        ctx.bezierCurveTo(x + len * 0.3, y0 + (rnd() - 0.5) * 4, x + len * 0.7, y0 + (rnd() - 0.5) * 4, x + len, y0);
        ctx.stroke();
      }
      // plank end gap
      ctx.fillStyle = 'rgba(70,40,15,0.45)';
      ctx.fillRect(x, r * rowH, 2, rowH);
      x += len;
    }
    // row gap
    ctx.fillStyle = 'rgba(70,40,15,0.4)';
    ctx.fillRect(0, r * rowH, size, 1.5);
  }
  // note: planks are clipped at the tile edge (reads as a plank joint; mostly hidden by the court mat)
  speckle(ctx, size, size, 20000, 0.05, rnd);
  return finish(c, { repeat: [1, 1], anisotropy });
}

/** Rubberised sports-court mat (brick red) with soft noise. */
export function courtMatTexture(anisotropy: number): THREE.CanvasTexture {
  const size = 256;
  const [c, ctx] = makeCanvas(size, size);
  ctx.fillStyle = '#c4523c';
  ctx.fillRect(0, 0, size, size);
  speckle(ctx, size, size, 14000, 0.09, mulberry32(3));
  return finish(c, { repeat: [1, 1], anisotropy });
}

/** One net cell (repeated): dark cord on transparent background. */
export function netTexture(anisotropy: number): THREE.CanvasTexture {
  const size = 32;
  const [c, ctx] = makeCanvas(size, size);
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = 'rgba(22,30,58,1)';
  ctx.fillRect(0, 0, size, 4);
  ctx.fillRect(0, 0, 4, size);
  return finish(c, { repeat: [1, 1], anisotropy });
}

/** Barrier board graphic: navy board with a friendly white/cyan swoosh (no text/logos). */
export function barrierTexture(anisotropy: number): THREE.CanvasTexture {
  const w = 512;
  const h = 192;
  const [c, ctx] = makeCanvas(w, h);
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#2a57b8');
  g.addColorStop(1, '#173a86');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  // swoosh
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.beginPath();
  ctx.moveTo(0, h * 0.72);
  ctx.bezierCurveTo(w * 0.3, h * 0.45, w * 0.65, h * 0.95, w, h * 0.55);
  ctx.lineTo(w, h * 0.68);
  ctx.bezierCurveTo(w * 0.65, h * 1.08, w * 0.3, h * 0.58, 0, h * 0.85);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = 'rgba(95,215,255,0.85)';
  ctx.beginPath();
  ctx.moveTo(0, h * 0.6);
  ctx.bezierCurveTo(w * 0.3, h * 0.33, w * 0.65, h * 0.83, w, h * 0.43);
  ctx.lineTo(w, h * 0.5);
  ctx.bezierCurveTo(w * 0.65, h * 0.9, w * 0.3, h * 0.4, 0, h * 0.67);
  ctx.closePath();
  ctx.fill();
  // little ball dots
  const rnd = mulberry32(21);
  for (let i = 0; i < 6; i++) {
    ctx.fillStyle = i % 2 ? 'rgba(255,214,64,0.95)' : 'rgba(255,255,255,0.9)';
    ctx.beginPath();
    ctx.arc(40 + i * 85 + rnd() * 20, h * 0.22 + rnd() * 10, 9, 0, Math.PI * 2);
    ctx.fill();
  }
  // top white trim
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, 8);
  return finish(c, { anisotropy });
}

/** Soft cream wall with a pale blue band, for the distant hall walls. */
export function wallTexture(anisotropy: number): THREE.CanvasTexture {
  const w = 256;
  const h = 256;
  const [c, ctx] = makeCanvas(w, h);
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#f4efe6');
  g.addColorStop(0.55, '#ece3d3');
  g.addColorStop(0.56, '#8fc4e8');
  g.addColorStop(0.72, '#8fc4e8');
  g.addColorStop(0.73, '#d9cdb8');
  g.addColorStop(1, '#cdbfa6');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  // vertical panel seams
  ctx.fillStyle = 'rgba(120,100,70,0.12)';
  for (let x = 0; x < w; x += 64) ctx.fillRect(x, 0, 2, h);
  return finish(c, { repeat: [1, 1], anisotropy });
}
