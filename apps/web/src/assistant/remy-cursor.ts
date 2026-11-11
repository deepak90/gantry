/**
 * Remy's cursor: her mark with her name beside it, on the screen of the person who asked her to show them something.
 * It glides to the real control on a gentle curve, presses it with a ripple, and fades a moment after she is done.
 *
 * It is only a picture. Nothing of it takes a click (the person's own pointer goes straight through it) and it sends
 * no events: what it presses is done by the app's own code (remy-ui.ts). With reduced motion it does not travel: it
 * shows where it presses.
 */
import { animate } from 'motion';
import { ASSISTANT_NAME } from './identity';
import { remyMarkElement } from './RemyMark';
import '../styles/remy-cursor.css';

export interface Point {
  x: number;
  y: number;
}

/** Where to go: an element (a point inside it), a point, or either worked out on every frame (a row that scrolls). */
export type CursorTarget = Element | Point | (() => Element | Point | null | undefined);

export interface RemyCursorOptions {
  document?: Document;
  /** 1 is the usual pace; 0 jumps straight there (tests). */
  speed?: number;
  /** Whether to keep still (the person's reduced-motion setting, by default). */
  reducedMotion?: () => boolean;
  /** How long it stays after the last press before it fades, in ms. */
  lingerMs?: number;
}

const isPoint = (value: unknown): value is Point => typeof value === 'object' && value !== null && !(value instanceof Element) && 'x' in value && 'y' in value;

/** Where in an element the cursor points: its middle, or a little in from the left of something wide (a row's name). */
export function aimAt(element: Element): Point {
  const rect = element.getBoundingClientRect();
  const x = rect.width > 240 ? rect.left + Math.min(120, rect.width / 3) : rect.left + rect.width / 2;
  return { x, y: rect.top + rect.height / 2 };
}

/** Whether an element is drawn and inside the window. */
export function onScreen(element: Element, view: Window | null = typeof window === 'undefined' ? null : window): boolean {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  if (!view) return true;
  return rect.bottom > 0 && rect.right > 0 && rect.top < view.innerHeight && rect.left < view.innerWidth;
}

function resolve(target: CursorTarget): Point | null {
  const value = typeof target === 'function' ? target() : target;
  if (!value) return null;
  return isPoint(value) ? value : aimAt(value);
}

/** A point on the curve from `from` to `to` bowed by `bow` (a quadratic curve, its control off to one side). */
export function curvePoint(from: Point, to: Point, t: number, bow = 0.14): Point {
  const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  // Off to the left of the way it goes, by a share of the distance: a hand's arc, not a ruler's line.
  const control = { x: mid.x - dy * bow, y: mid.y + dx * bow };
  const u = 1 - t;
  return { x: u * u * from.x + 2 * u * t * control.x + t * t * to.x, y: u * u * from.y + 2 * u * t * control.y + t * t * to.y };
}

/** How long a move of this length takes, in seconds: quick for a short hop, never slow. */
export function moveSeconds(distance: number): number {
  return Math.min(0.9, Math.max(0.32, 0.26 + distance / 2200));
}

export class RemyCursor {
  private readonly doc: Document;
  private readonly speed: number;
  private readonly reduced: () => boolean;
  private readonly lingerMs: number;
  private root: HTMLDivElement | null = null;
  private at: Point | null = null;
  private fadeTimer: ReturnType<typeof setTimeout> | null = null;
  private stopMove: (() => void) | null = null;

  constructor({ document: doc = document, speed = 1, reducedMotion, lingerMs = 2600 }: RemyCursorOptions = {}) {
    this.doc = doc;
    this.speed = speed;
    this.lingerMs = lingerMs;
    this.reduced =
      reducedMotion ??
      (() => typeof doc.defaultView?.matchMedia === 'function' && doc.defaultView.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  /** Where it is now; null while it is off the page. */
  get position(): Point | null {
    return this.at ? { ...this.at } : null;
  }

  /** Where it is, whether it is at work and whether it is pressing: the 3D view's floating face goes there on a call. */
  get pointer(): { x: number; y: number; shown: boolean; pressing: boolean } {
    return { x: this.at?.x ?? 0, y: this.at?.y ?? 0, shown: this.shown && this.at !== null, pressing: Boolean(this.root?.classList.contains('is-pressing')) };
  }

  /** Shows what it carries beside it (a library card being dragged), or puts it down (null). */
  carry(label: string | null): void {
    const root = this.element();
    let card = root.querySelector<HTMLElement>('.remy-cursor-carry');
    if (!label) {
      card?.remove();
      root.classList.remove('is-carrying');
      return;
    }
    if (!card) {
      card = this.doc.createElement('span');
      card.className = 'remy-cursor-carry';
      root.append(card);
    }
    card.textContent = label;
    root.classList.add('is-carrying');
  }

  get shown(): boolean {
    return Boolean(this.root?.classList.contains('is-shown'));
  }

  private element(): HTMLDivElement {
    if (this.root?.isConnected) return this.root;
    const root = this.doc.createElement('div');
    root.className = 'remy-cursor';
    root.setAttribute('aria-hidden', 'true');
    root.dataset.testid = 'remy-cursor';
    const mark = remyMarkElement('still', 'remy-cursor-mark');
    const tag = this.doc.createElement('span');
    tag.className = 'remy-cursor-tag';
    tag.textContent = ASSISTANT_NAME;
    root.append(mark, tag);
    this.doc.body.append(root);
    this.root = root;
    return root;
  }

  private place(point: Point): void {
    this.at = { ...point };
    this.element().style.transform = `translate3d(${point.x.toFixed(1)}px, ${point.y.toFixed(1)}px, 0)`;
  }

  private show(): void {
    if (this.fadeTimer) clearTimeout(this.fadeTimer);
    this.fadeTimer = null;
    this.element().classList.add('is-shown');
  }

  /** Where it comes in from when it isn't on the page yet: beside Remy's tab, else the top right. */
  private entry(to: Point): Point {
    const tab = this.doc.querySelector('[data-testid="inspector-tab-assistant"]');
    if (tab) {
      const rect = tab.getBoundingClientRect();
      if (rect.width > 0) return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }
    const view = this.doc.defaultView;
    return view ? { x: view.innerWidth - 80, y: 64 } : { x: to.x + 120, y: to.y - 80 };
  }

  /**
   * Glides to the target and resolves there. A target that moves on the way (a row the chart is still scrolling to) is
   * followed. False when there is nothing to point at.
   */
  async moveTo(target: CursorTarget, { pace = 1 }: { pace?: number } = {}): Promise<boolean> {
    const first = resolve(target);
    if (!first) return false;
    this.stopMove?.();
    const wasShown = this.shown && this.at !== null;
    const from = wasShown ? this.at! : this.entry(first);
    this.place(from);
    this.show();
    if (this.speed <= 0 || this.reduced()) {
      this.place(first);
      return true;
    }
    const distance = Math.hypot(first.x - from.x, first.y - from.y);
    if (distance < 2) {
      this.place(first);
      return true;
    }
    let last = first;
    const aim = () => {
      last = resolve(target) ?? last;
      return last;
    };
    await new Promise<void>((done) => {
      const controls = animate(0, 1, {
        duration: (moveSeconds(distance) * pace) / this.speed,
        ease: [0.25, 0.1, 0.2, 1],
        onUpdate: (t: number) => this.place(curvePoint(from, aim(), t)),
        onComplete: () => done(),
      });
      this.stopMove = () => {
        controls.stop();
        done();
      };
    });
    this.stopMove = null;
    this.place(aim());
    return true;
  }

  /** Goes to the target and presses it: the mark dips and a ring spreads from the spot. */
  async press(target: CursorTarget, times: 1 | 2 = 1): Promise<boolean> {
    if (!(await this.moveTo(target))) return false;
    await this.pause(110);
    for (let press = 0; press < times; press += 1) {
      this.ripple();
      await this.pause(times === 2 ? 120 : 160);
    }
    return true;
  }

  /** A press where the cursor is. */
  ripple(): void {
    const root = this.element();
    const at = this.at;
    root.classList.add('is-pressing');
    setTimeout(() => root.classList.remove('is-pressing'), 140);
    if (!at) return;
    const ring = this.doc.createElement('span');
    ring.className = 'remy-cursor-ripple';
    ring.style.left = `${at.x}px`;
    ring.style.top = `${at.y}px`;
    this.doc.body.append(ring);
    setTimeout(() => ring.remove(), 700);
  }

  /** A short wait at the cursor's pace. */
  pause(ms: number): Promise<void> {
    if (this.speed <= 0) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, ms / this.speed));
  }

  /** Done for now: it stays a moment where it is, so the person sees what it did, then fades. */
  rest(): void {
    if (!this.root) return;
    if (this.fadeTimer) clearTimeout(this.fadeTimer);
    this.fadeTimer = setTimeout(() => {
      this.fadeTimer = null;
      this.root?.classList.remove('is-shown');
      this.at = null;
    }, this.lingerMs);
  }

  /** Off the page at once. */
  hide(): void {
    this.stopMove?.();
    if (this.fadeTimer) clearTimeout(this.fadeTimer);
    this.fadeTimer = null;
    this.root?.classList.remove('is-shown');
    this.at = null;
  }

  destroy(): void {
    this.hide();
    this.root?.remove();
    this.root = null;
  }
}
