/** Tiny DOM helpers + reusable controls for the Spin Lab overlay (plain DOM, no framework). */

export interface HProps {
  class?: string;
  text?: string;
  title?: string;
  attrs?: Record<string, string>;
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: HProps = {},
  children: (Node | null | undefined)[] = [],
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props.class) el.className = props.class;
  if (props.text !== undefined) el.textContent = props.text;
  if (props.title) el.title = props.title;
  if (props.attrs) for (const [k, v] of Object.entries(props.attrs)) el.setAttribute(k, v);
  for (const c of children) if (c) el.appendChild(c);
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
  children: (Node | null | undefined)[] = [],
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  for (const c of children) if (c) el.appendChild(c);
  return el;
}

export function setAttrs(el: Element, attrs: Record<string, string | number>): void {
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
}

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export function signed(v: number, digits = 0): string {
  const r = Number(v.toFixed(digits));
  if (r === 0) return (0).toFixed(digits);
  return r > 0 ? `+${r.toFixed(digits)}` : r.toFixed(digits);
}

/** Remove keyboard focus after a pointer interaction so Space/keys go to the game, not the control. */
export function blurAfterUse(el: HTMLElement): void {
  const blur = () => {
    // defer so the click/change handler runs first
    setTimeout(() => el.blur(), 0);
  };
  el.addEventListener('pointerup', blur);
  el.addEventListener('change', blur);
  el.addEventListener('click', (e) => {
    // keyboard-activated clicks (detail === 0) keep focus for accessibility; pointer clicks blur
    if ((e as MouseEvent).detail !== 0) blur();
  });
}

export function button(label: string, cls: string, onClick: () => void, title?: string): HTMLButtonElement {
  const b = h('button', { class: `sl-btn ${cls}`.trim(), text: label, title, attrs: { type: 'button' } });
  b.addEventListener('click', onClick);
  blurAfterUse(b);
  return b;
}

// ───────────────────────────── Slider

export interface SliderOpts {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  format: (v: number) => string;
  onInput: (v: number) => void;
  leftHint?: string;
  rightHint?: string;
  /** css class for the track tint, e.g. 'tint-spin' */
  tint?: string;
}

export class Slider {
  readonly el: HTMLDivElement;
  readonly input: HTMLInputElement;
  private readonly valueEl: HTMLSpanElement;
  private dragging = false;

  constructor(private readonly opts: SliderOpts) {
    this.input = h('input', {
      class: `sl-range ${opts.tint ?? ''}`.trim(),
      attrs: { type: 'range', min: String(opts.min), max: String(opts.max), step: String(opts.step), 'aria-label': opts.label },
    });
    this.input.value = String(opts.value);
    this.valueEl = h('span', { class: 'sl-slider-value', text: opts.format(opts.value) });
    const head = h('div', { class: 'sl-slider-head' }, [h('span', { class: 'sl-slider-label', text: opts.label }), this.valueEl]);
    const children: Node[] = [head, this.input];
    if (opts.leftHint || opts.rightHint) {
      children.push(
        h('div', { class: 'sl-slider-hints' }, [
          h('span', { text: opts.leftHint ?? '' }),
          h('span', { text: opts.rightHint ?? '' }),
        ]),
      );
    }
    this.el = h('div', { class: 'sl-slider' }, children);
    this.input.addEventListener('pointerdown', () => (this.dragging = true));
    const end = () => (this.dragging = false);
    this.input.addEventListener('pointerup', end);
    this.input.addEventListener('pointercancel', end);
    this.input.addEventListener('blur', end);
    this.input.addEventListener('input', () => {
      const v = Number(this.input.value);
      this.valueEl.textContent = opts.format(v);
      opts.onInput(v);
    });
    blurAfterUse(this.input);
  }

  get value(): number {
    return Number(this.input.value);
  }

  /** Programmatic update; ignored while the user is dragging this slider (unless forced). */
  set(v: number, force = false): void {
    if (this.dragging && !force) return;
    const c = clamp(v, this.opts.min, this.opts.max);
    if (Number(this.input.value) !== c) this.input.value = String(c);
    const txt = this.opts.format(c);
    if (this.valueEl.textContent !== txt) this.valueEl.textContent = txt;
  }

  setValueText(txt: string): void {
    if (this.valueEl.textContent !== txt) this.valueEl.textContent = txt;
  }
}

// ───────────────────────────── Segmented control

export interface SegOption<T extends string | number> {
  value: T;
  label: string;
  title?: string;
}

export class Segmented<T extends string | number> {
  readonly el: HTMLDivElement;
  private readonly buttons = new Map<T, HTMLButtonElement>();
  private current: T;

  constructor(options: SegOption<T>[], value: T, onChange: (v: T) => void, cls = '') {
    this.current = value;
    this.el = h('div', { class: `sl-seg ${cls}`.trim(), attrs: { role: 'group' } });
    for (const o of options) {
      const b = button(o.label, 'sl-seg-btn', () => {
        if (this.current === o.value) return;
        this.set(o.value);
        onChange(o.value);
      }, o.title);
      this.buttons.set(o.value, b);
      this.el.appendChild(b);
    }
    this.set(value);
  }

  set(v: T): void {
    this.current = v;
    for (const [val, b] of this.buttons) {
      const on = val === v;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    }
  }
}

// ───────────────────────────── Toggle switch

export class Toggle {
  readonly el: HTMLLabelElement;
  private readonly input: HTMLInputElement;

  constructor(label: string, value: boolean, onChange: (v: boolean) => void, hint?: string) {
    this.input = h('input', { attrs: { type: 'checkbox' } });
    this.input.checked = value;
    this.input.addEventListener('change', () => onChange(this.input.checked));
    blurAfterUse(this.input);
    const text = h('span', { class: 'sl-toggle-text' }, [
      h('span', { class: 'sl-toggle-label', text: label }),
      hint ? h('span', { class: 'sl-toggle-hint', text: hint }) : null,
    ]);
    this.el = h('label', { class: 'sl-toggle' }, [text, this.input, h('span', { class: 'sl-switch' })]);
  }

  set(v: boolean): void {
    this.input.checked = v;
  }
}
