/**
 * Top-down mini table of the PLAYER's half, used to pick the opponent's bounce target.
 * Drawn with the net at the TOP and the player's end line at the BOTTOM; +x to the right
 * (the player's right, since the player looks toward -z).
 */
import { clamp, h, setAttrs, svg } from './dom';

const HALF_W = 0.7625; // table half width (m)
const HALF_L = 1.37; // half length (m)
const SCALE = 98; // px per metre
const PAD = 8;

export const TARGET_X = { min: -0.65, max: 0.65 };
export const TARGET_Z = { min: 0.25, max: 1.25 };

export class PlacementPicker {
  readonly el: HTMLDivElement;
  private readonly svgEl: SVGSVGElement;
  private readonly marker: SVGCircleElement;
  private readonly ring: SVGCircleElement;
  private readonly fromMarker: SVGRectElement;
  private readonly readout: HTMLSpanElement;
  private readonly w = HALF_W * 2 * SCALE + PAD * 2;
  private readonly hgt = HALF_L * SCALE + PAD * 2;
  private dragging = false;

  constructor(target: { x: number; z: number }, private readonly onPick: (t: { x: number; z: number }) => void) {
    const { w, hgt } = this;
    const tableW = HALF_W * 2 * SCALE;
    const tableH = HALF_L * SCALE;
    const zone = svg('rect', {
      class: 'mt-zone',
      x: this.px(TARGET_X.min), y: this.py(TARGET_Z.min),
      width: this.px(TARGET_X.max) - this.px(TARGET_X.min),
      height: this.py(TARGET_Z.max) - this.py(TARGET_Z.min),
      rx: 4,
    });
    const table = svg('rect', { class: 'mt-table', x: PAD, y: PAD, width: tableW, height: tableH, rx: 2 });
    const centre = svg('line', { class: 'mt-line', x1: this.px(0), x2: this.px(0), y1: PAD, y2: PAD + tableH });
    const net = svg('line', { class: 'mt-net', x1: PAD - 4, x2: PAD + tableW + 4, y1: PAD, y2: PAD });
    const netLbl = svg('text', { class: 'mt-label', x: this.px(0), y: PAD + 11, 'text-anchor': 'middle' });
    netLbl.textContent = 'net';
    const youLbl = svg('text', { class: 'mt-label', x: this.px(0), y: PAD + tableH - 4, 'text-anchor': 'middle' });
    youLbl.textContent = 'you';
    const shortLbl = svg('text', { class: 'mt-label mt-side', x: PAD + 3, y: this.py(0.4) });
    shortLbl.textContent = 'short';
    const longLbl = svg('text', { class: 'mt-label mt-side', x: PAD + 3, y: this.py(1.2) });
    longLbl.textContent = 'deep';
    this.fromMarker = svg('rect', { class: 'mt-from', y: 1, width: 18, height: 4, rx: 2 });
    this.ring = svg('circle', { class: 'mt-ring', r: 9 });
    this.marker = svg('circle', { class: 'mt-marker', r: 4.5 });
    this.svgEl = svg('svg', {
      class: 'mt', viewBox: `0 0 ${w} ${hgt}`, width: w, height: hgt,
      role: 'img', 'aria-label': 'Placement: click where the ball should bounce on your half',
    }, [table, zone, centre, net, netLbl, youLbl, shortLbl, longLbl, this.fromMarker, this.ring, this.marker]);
    this.readout = h('span', { class: 'mt-readout' });
    this.el = h('div', { class: 'mt-wrap' }, [this.svgEl, this.readout]);

    const pick = (e: PointerEvent) => {
      const r = this.svgEl.getBoundingClientRect();
      if (r.width === 0) return;
      const sx = ((e.clientX - r.left) / r.width) * w;
      const sy = ((e.clientY - r.top) / r.height) * hgt;
      const x = clamp((sx - PAD) / SCALE - HALF_W, TARGET_X.min, TARGET_X.max);
      const z = clamp((sy - PAD) / SCALE, TARGET_Z.min, TARGET_Z.max);
      const t = { x: Math.round(x * 100) / 100, z: Math.round(z * 100) / 100 };
      this.set(t);
      this.onPick(t);
    };
    this.svgEl.addEventListener('pointerdown', (e) => {
      this.dragging = true;
      this.svgEl.setPointerCapture(e.pointerId);
      pick(e);
    });
    this.svgEl.addEventListener('pointermove', (e) => { if (this.dragging) pick(e); });
    const end = () => (this.dragging = false);
    this.svgEl.addEventListener('pointerup', end);
    this.svgEl.addEventListener('pointercancel', end);
    this.set(target);
  }

  private px(x: number): number {
    return PAD + (x + HALF_W) * SCALE;
  }

  private py(z: number): number {
    return PAD + z * SCALE;
  }

  set(t: { x: number; z: number }): void {
    const cx = this.px(t.x);
    const cy = this.py(t.z);
    setAttrs(this.marker, { cx, cy });
    setAttrs(this.ring, { cx, cy });
    const side = Math.abs(t.x) < 0.15 ? 'middle' : t.x > 0 ? 'your right' : 'your left';
    const depth = t.z < 0.55 ? 'short' : t.z > 0.95 ? 'deep' : 'half-long';
    this.readout.textContent = `${depth}, ${side}`;
  }

  /**
   * Opponent's striking position, drawn as a tick on the net edge.
   * The opponent faces the player, so the opponent's world +x appears on the player's right too.
   */
  setFrom(fromX: number): void {
    setAttrs(this.fromMarker, { x: this.px(clamp(fromX, -HALF_W, HALF_W)) - 9 });
  }
}
