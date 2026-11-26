/** Small SVG diagrams: paddle pitch (side view), paddle yaw (top view), and the angle-window gauge. */
import { clamp, setAttrs, svg } from './dom';

const DEG = Math.PI / 180;

function arrowHead(tipX: number, tipY: number, dirX: number, dirY: number, size = 6): string {
  // dir must be unit
  const bx = tipX - dirX * size;
  const by = tipY - dirY * size;
  const px = -dirY * size * 0.55;
  const py = dirX * size * 0.55;
  return `${tipX.toFixed(1)},${tipY.toFixed(1)} ${(bx + px).toFixed(1)},${(by + py).toFixed(1)} ${(bx - px).toFixed(1)},${(by - py).toFixed(1)}`;
}

/**
 * Side view of the paddle. The opponent is to the LEFT, the player to the right.
 * pitch + = OPEN (face looks up), - = CLOSED (face looks down at the table).
 */
export class PitchDiagram {
  readonly el: SVGSVGElement;
  private readonly blade: SVGLineElement;
  private readonly rubber: SVGLineElement;
  private readonly handle: SVGLineElement;
  private readonly normal: SVGLineElement;
  private readonly head: SVGPolygonElement;
  private last = NaN;
  private readonly cx = 52;
  private readonly cy = 34;

  constructor() {
    this.blade = svg('line', { class: 'dg-blade' });
    this.rubber = svg('line', { class: 'dg-rubber' });
    this.handle = svg('line', { class: 'dg-handle' });
    this.normal = svg('line', { class: 'dg-normal' });
    this.head = svg('polygon', { class: 'dg-normal-head' });
    const vertical = svg('line', { class: 'dg-ref', x1: this.cx, y1: 8, x2: this.cx, y2: 60 });
    const table = svg('line', { class: 'dg-table', x1: 2, y1: 66, x2: 96, y2: 66 });
    const opp = svg('text', { class: 'dg-caption', x: 3, y: 12 });
    opp.textContent = '◀ opp';
    this.el = svg('svg', { class: 'dg dg-pitch', viewBox: '0 0 100 72', width: 100, height: 72, 'aria-hidden': 'true' }, [
      table, vertical, this.normal, this.head, this.handle, this.blade, this.rubber, opp,
    ]);
  }

  set(pitchDeg: number): void {
    if (Math.abs(pitchDeg - this.last) < 0.05) return;
    this.last = pitchDeg;
    const p = pitchDeg * DEG;
    const ux = Math.sin(p);
    const uy = -Math.cos(p); // blade "up" direction in svg coords
    const L = 18;
    const { cx, cy } = this;
    setAttrs(this.blade, { x1: cx - ux * L, y1: cy - uy * L, x2: cx + ux * L, y2: cy + uy * L });
    // red rubber on the hitting face (toward the opponent = face normal side)
    const nx = -Math.cos(p);
    const ny = -Math.sin(p);
    const off = 2.2;
    setAttrs(this.rubber, {
      x1: cx - ux * L + nx * off, y1: cy - uy * L + ny * off,
      x2: cx + ux * L + nx * off, y2: cy + uy * L + ny * off,
    });
    setAttrs(this.handle, { x1: cx - ux * L, y1: cy - uy * L, x2: cx - ux * (L + 11), y2: cy - uy * (L + 11) });
    const A = 24;
    const tx = cx + nx * A;
    const ty = cy + ny * A;
    setAttrs(this.normal, { x1: cx + nx * 3, y1: cy + ny * 3, x2: tx - nx * 4, y2: ty - ny * 4 });
    this.head.setAttribute('points', arrowHead(tx, ty, nx, ny));
  }
}

/**
 * Top view of the paddle. The opponent is at the TOP, the player at the bottom.
 * yaw + = aimed to the player's RIGHT.
 */
export class YawDiagram {
  readonly el: SVGSVGElement;
  private readonly blade: SVGLineElement;
  private readonly normal: SVGLineElement;
  private readonly head: SVGPolygonElement;
  private last = NaN;
  private readonly cx = 50;
  private readonly cy = 48;

  constructor() {
    this.blade = svg('line', { class: 'dg-blade' });
    this.normal = svg('line', { class: 'dg-normal' });
    this.head = svg('polygon', { class: 'dg-normal-head' });
    const straight = svg('line', { class: 'dg-ref', x1: this.cx, y1: 6, x2: this.cx, y2: this.cy });
    const net = svg('line', { class: 'dg-table', x1: 10, y1: 4, x2: 90, y2: 4 });
    const opp = svg('text', { class: 'dg-caption', x: 50, y: 68, 'text-anchor': 'middle' });
    opp.textContent = 'you';
    this.el = svg('svg', { class: 'dg dg-yaw', viewBox: '0 0 100 72', width: 100, height: 72, 'aria-hidden': 'true' }, [
      net, straight, this.normal, this.head, this.blade, opp,
    ]);
  }

  set(yawDeg: number): void {
    if (Math.abs(yawDeg - this.last) < 0.05) return;
    this.last = yawDeg;
    const y = yawDeg * DEG;
    const bx = Math.cos(y);
    const by = Math.sin(y);
    const L = 16;
    const { cx, cy } = this;
    setAttrs(this.blade, { x1: cx - bx * L, y1: cy - by * L, x2: cx + bx * L, y2: cy + by * L });
    const nx = Math.sin(y);
    const ny = -Math.cos(y);
    const A = 34;
    const tx = cx + nx * A;
    const ty = cy + ny * A;
    setAttrs(this.normal, { x1: cx + nx * 3, y1: cy + ny * 3, x2: tx - nx * 4, y2: ty - ny * 4 });
    this.head.setAttribute('points', arrowHead(tx, ty, nx, ny));
  }
}

/**
 * Horizontal gauge: the passing window band, the best angle tick, and the player's needle.
 */
export class AngleGauge {
  readonly el: SVGSVGElement;
  private readonly band: SVGRectElement;
  private readonly best: SVGLineElement;
  private readonly needle: SVGLineElement;
  private readonly needleHead: SVGPolygonElement;
  private readonly W = 260;
  private readonly pad = 10;

  constructor(private readonly min: number, private readonly max: number, leftLabel: string, rightLabel: string) {
    const { W, pad } = this;
    const track = svg('rect', { class: 'gg-track', x: pad, y: 14, width: W - 2 * pad, height: 12, rx: 6 });
    this.band = svg('rect', { class: 'gg-band', x: pad, y: 14, width: 0, height: 12, rx: 4 });
    this.best = svg('line', { class: 'gg-best', y1: 11, y2: 29 });
    this.needle = svg('line', { class: 'gg-needle', y1: 8, y2: 32 });
    this.needleHead = svg('polygon', { class: 'gg-needle-head' });
    const zero = svg('line', { class: 'gg-zero', x1: this.xOf(0), x2: this.xOf(0), y1: 26, y2: 30 });
    const l = svg('text', { class: 'gg-label', x: pad, y: 42 });
    l.textContent = leftLabel;
    const r = svg('text', { class: 'gg-label', x: W - pad, y: 42, 'text-anchor': 'end' });
    r.textContent = rightLabel;
    const z = svg('text', { class: 'gg-label', x: this.xOf(0), y: 42, 'text-anchor': 'middle' });
    z.textContent = '0°';
    this.el = svg('svg', { class: 'gg', viewBox: `0 0 ${W} 46`, width: W, height: 46, 'aria-hidden': 'true' }, [
      track, this.band, zero, this.best, this.needle, this.needleHead, l, r, z,
    ]);
  }

  private xOf(v: number): number {
    const t = (clamp(v, this.min, this.max) - this.min) / (this.max - this.min);
    return this.pad + t * (this.W - 2 * this.pad);
  }

  /** window may be null (no passing angle): band hidden. */
  set(window: { lo: number; hi: number; best: number } | null, yours: number, ok: boolean): void {
    if (window) {
      const x0 = this.xOf(window.lo);
      const x1 = this.xOf(window.hi);
      setAttrs(this.band, { x: x0, width: Math.max(3, x1 - x0) });
      this.band.style.display = '';
      const bx = this.xOf(window.best);
      setAttrs(this.best, { x1: bx, x2: bx });
      this.best.style.display = '';
    } else {
      this.band.style.display = 'none';
      this.best.style.display = 'none';
    }
    const nx = this.xOf(yours);
    setAttrs(this.needle, { x1: nx, x2: nx });
    this.needleHead.setAttribute('points', `${nx},8 ${nx - 5},1 ${nx + 5},1`);
    this.el.classList.toggle('gg-ok', ok);
  }
}
