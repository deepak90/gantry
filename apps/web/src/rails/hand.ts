/**
 * The assistant's hand: its own cursor on the page, with its name beside it. It joins the plan the way a
 * person joins a call and leaves the same way. In between it moves like a person's pointer and acts
 * through the real interface. A press, a drag or a keystroke reaches the page as the same events a mouse
 * or keyboard sends, at whatever is under the cursor, so the app runs its own code for them: Bryntum's
 * drag, React's handlers, the library's drop. Nothing here changes the plan directly.
 *
 * It moves the way the crowd's people do (crowd/motion.ts): curved reaches whose speed rises and falls,
 * often a little past the target and back, never a straight line. At rest it is still, as a mouse
 * left on the desk is. Carrying something it goes slower: a tug to free it, a carry that bends
 * partway, a look at where it goes, then a careful last move onto the spot.
 */
import { minimumJerk, planMove, type MoveOptions } from '../crowd/motion';
import { Random } from '../crowd/random';
import { sleep, throwIfStopped } from './wait';

export interface Point {
  x: number;
  y: number;
}

/** Where to go: an element (its middle), a point, or either worked out when the hand sets off. */
export type Target = Element | Point | (() => Element | Point | null | undefined);

export interface HandOptions {
  /** The name beside the cursor. */
  name?: string;
  /** A short tag after the name, so nobody takes it for a person. */
  tag?: string;
  /** 1 is a person's pace. 0 jumps straight there, for tests. */
  speed?: number;
  /** Where the cursor is drawn and its events are sent, for tests. */
  document?: Document;
  /** Seeds the hand's wobble, so a run can be played again the same way. */
  seed?: number;
}

export interface DragOptions {
  /** How slowly it carries: 1 is a quick reach; the default is a careful carry. */
  pace?: number;
  /** How long it holds over the spot before letting go, in ms, so the drop line shows. */
  hold?: number;
  /** Carries it in one straight, smooth line onto the spot: no tug, bend or second look. A quick, plain drag. */
  straight?: boolean;
}

const ARROW_PATH = 'M1.5 1.5 L1.5 16.5 L5.6 12.6 L8.6 18.8 L11.4 17.5 L8.5 11.4 L14.2 11.4 Z';
/** What a press can focus: anything with a tabindex counts, even -1, which only a click reaches (grid cells). */
const FOCUSABLE = 'input, textarea, select, button, a[href], [tabindex], [contenteditable=""], [contenteditable="true"]';

const isPoint = (value: unknown): value is Point => typeof value === 'object' && value !== null && !(value instanceof Element) && 'x' in value && 'y' in value;

export function middleOf(element: Element): Point {
  const rect = element.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function resolve(target: Target): { point: Point; element: Element | null } {
  const value = typeof target === 'function' ? target() : target;
  if (!value) throw new Error('The assistant has nowhere to point');
  return isPoint(value) ? { point: value, element: null } : { point: middleOf(value), element: value };
}

function frame(signal?: AbortSignal): Promise<void> {
  throwIfStopped(signal);
  return typeof requestAnimationFrame === 'function' ? new Promise((resolve) => requestAnimationFrame(() => resolve())) : sleep(16, signal);
}

/** Where the cursor rests: in the header, where the people on the plan are, or the header's right side. */
function restingSpot(): Point | null {
  const people = document.querySelector('.app-header-actions')?.getBoundingClientRect();
  if (people && people.width > 0) return { x: people.left + 14, y: people.top + people.height * 0.55 };
  return typeof window === 'undefined' ? null : { x: window.innerWidth - 320, y: 22 };
}

/** Sends one pointer or mouse event, as a mouse would. False when the page cancelled it. */
function fire(target: EventTarget, type: string, at: Point, init: MouseEventInit = {}): boolean {
  const base: MouseEventInit = { bubbles: true, cancelable: true, composed: true, clientX: at.x, clientY: at.y, screenX: at.x, screenY: at.y, button: 0, ...init };
  const event =
    type.startsWith('pointer') && typeof PointerEvent === 'function'
      ? new PointerEvent(type, { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true })
      : new MouseEvent(type, base);
  return target.dispatchEvent(event);
}

export class Hand {
  /** 1 is a person's pace; 2 is twice as fast; 0 jumps. */
  speed: number;
  private readonly doc: Document;
  private readonly root: HTMLDivElement;
  private readonly note: HTMLSpanElement;
  private readonly random: Random;
  private at: Point = { x: -40, y: -40 };
  private here = false;

  constructor({ name = 'Assistant', tag = 'AI', speed = 1, document: doc = document, seed = Date.now() }: HandOptions = {}) {
    this.speed = speed;
    this.doc = doc;
    this.random = new Random(seed);
    const root = doc.createElement('div');
    root.className = 'rail-hand';
    root.setAttribute('aria-hidden', 'true');
    root.setAttribute('data-testid', 'rail-hand');
    root.innerHTML = `<svg class="rail-hand-arrow" width="18" height="20" viewBox="0 0 18 20"><path d="${ARROW_PATH}"/></svg><span class="rail-hand-label"><span class="rail-hand-name"></span><span class="rail-hand-tag"></span><span class="rail-hand-note"></span></span>`;
    root.querySelector('.rail-hand-name')!.textContent = name;
    root.querySelector('.rail-hand-tag')!.textContent = tag;
    this.note = root.querySelector('.rail-hand-note')!;
    // On the page from when it first joins: a cursor made and never shown leaves nothing behind.
    root.hidden = true;
    this.root = root;
  }

  /** Set while the cursor drifts to its resting place or waits there; any action picks it back up. */
  private resting: AbortController | null = null;

  /**
   * Moves out of the way once there is nothing to do, the way a person takes their hand off the mouse: a
   * slow drift to `spot` (beside the assistant's face in the header, by default), where it waits, faded.
   */
  async rest(spot: () => Point | null = restingSpot): Promise<void> {
    if (!this.here) return;
    this.resting?.abort();
    const resting = new AbortController();
    this.resting = resting;
    const aim = () => spot() ?? restingSpot() ?? this.at;
    try {
      if (this.speed > 0) await this.travel(aim, { pace: 0.6, targetWidth: 40 }, 0, resting.signal);
      else this.place(aim());
      if (!resting.signal.aborted) this.root.classList.add('is-resting');
    } catch {
      // Picked back up on the way.
    }
  }

  /** Back to work: no longer resting, and not drifting off either. */
  private wake(): void {
    this.resting?.abort();
    this.resting = null;
    this.root.classList.remove('is-resting');
  }

  /** Whether the assistant is on the plan now. */
  get present(): boolean {
    return this.here;
  }

  get position(): Point {
    return { ...this.at };
  }

  /** Where the cursor is, whether it is at work (on the page and not resting) and whether it is pressing: the 3D view's face takes its place there. */
  get pointer(): { x: number; y: number; shown: boolean; pressing: boolean } {
    return { x: this.at.x, y: this.at.y, shown: this.here && this.resting === null && !this.root.classList.contains('is-resting'), pressing: this.root.classList.contains('is-pressing') };
  }

  /** Takes the cursor off the page. It comes back if it joins again (React's development mode unmounts and mounts once). */
  destroy(): void {
    this.wake();
    this.root.remove();
    this.root.hidden = true;
    this.here = false;
  }

  /** A pause at the hand's pace. */
  beat(ms: number, signal?: AbortSignal): Promise<void> {
    throwIfStopped(signal);
    return this.speed <= 0 ? Promise.resolve() : sleep(ms / this.speed, signal);
  }

  private place(point: Point): void {
    this.at = { ...point };
    this.root.style.transform = `translate(${point.x.toFixed(1)}px, ${point.y.toFixed(1)}px)`;
  }

  private show(): void {
    if (this.here) return;
    if (!this.root.isConnected) this.doc.body.append(this.root);
    this.root.hidden = false;
    this.here = true;
  }

  private under(point: Point): Element | null {
    return typeof this.doc.elementFromPoint === 'function' ? this.doc.elementFromPoint(point.x, point.y) : null;
  }

  private moveEvents(point: Point, buttons: number): void {
    const over = this.under(point) ?? this.doc.body;
    fire(over, 'pointermove', point, { buttons });
    fire(over, 'mousemove', point, { buttons });
  }

  private setNote(text: string): void {
    this.note.textContent = text;
    this.root.classList.toggle('has-note', text !== '');
  }

  /** Arrives on the plan, as a person joins a call: the cursor fades in at `at`, saying so. */
  async join(at: Point = { x: window.innerWidth - 220, y: 72 }, signal?: AbortSignal): Promise<void> {
    this.place(at);
    this.root.classList.remove('is-leaving');
    this.root.classList.add('is-joining');
    this.show();
    this.setNote('joined');
    await this.beat(1100, signal);
    this.root.classList.remove('is-joining');
    this.setNote('');
  }

  /** Leaves the plan, saying so, and the cursor fades out. */
  async leave(signal?: AbortSignal): Promise<void> {
    if (!this.here) return;
    this.setNote('left');
    this.root.classList.add('is-leaving');
    await this.beat(900, signal);
    this.root.hidden = true;
    this.root.classList.remove('is-leaving');
    this.setNote('');
    this.here = false;
  }

  /** Puts the cursor away at once, as when the walkthrough goes back to its start. */
  reset(): void {
    this.root.hidden = true;
    this.root.classList.remove('is-joining', 'is-leaving', 'is-pressing', 'is-dragging');
    this.setNote('');
    this.here = false;
  }

  /**
   * One reach toward wherever `aim` points: curved, its speed rising and falling, often a little past and
   * back (crowd/motion.ts). A target that drifts on the way pulls the rest of the path with it. With
   * `buttons`, it is a drag, so the page hears every step of the way.
   */
  private async travel(aim: () => Point, options: MoveOptions, buttons: number, signal?: AbortSignal): Promise<Point> {
    const from = this.at;
    const planned = aim();
    const view = this.doc.defaultView;
    const bounds = view ? { left: 2, top: 2, right: view.innerWidth - 2, bottom: view.innerHeight - 2 } : undefined;
    const path = planMove(from, planned, this.random, { bounds, ...options, pace: (options.pace ?? 1) / this.speed });
    const started = performance.now();
    for (;;) {
      const t = performance.now() - started;
      const now = aim();
      const pull = minimumJerk(t / path.duration);
      const on = path.at(t);
      const point = { x: on.x + (now.x - planned.x) * pull, y: on.y + (now.y - planned.y) * pull };
      this.place(point);
      if (buttons) this.moveEvents(point, buttons);
      if (t >= path.duration) return point;
      await frame(signal);
    }
  }

  /** Stays with a target that is still moving (a panel scrolling, a card growing) until it stands still. */
  private async settle(aim: () => Point, from: Point, buttons: number, signal?: AbortSignal): Promise<Point> {
    let point = from;
    const settling = performance.now();
    let still = settling;
    while (performance.now() - settling < 2000) {
      await frame(signal);
      const now = aim();
      if (Math.hypot(now.x - point.x, now.y - point.y) > 1.5) {
        // A short glide after it, not a jump.
        point = { x: point.x + (now.x - point.x) * 0.4, y: point.y + (now.y - point.y) * 0.4 };
        still = performance.now();
        this.place(point);
        if (buttons) this.moveEvents(point, buttons);
      } else if (performance.now() - still > 160) break;
    }
    point = aim();
    this.place(point);
    if (buttons) this.moveEvents(point, buttons);
    return point;
  }

  private aimer(target: Target, fallback: Point): () => Point {
    let last = fallback;
    return () => {
      try {
        last = resolve(target).point;
      } catch {
        // Keep the last known point.
      }
      return last;
    };
  }

  /**
   * Moves to the target and returns what is under the cursor there. A target that moves on the way (a
   * panel scrolling as an answer arrives, a card growing) is followed, and the hand waits for it to
   * stand still before it stops, the way a person's eye and hand do.
   */
  async moveTo(target: Target, signal?: AbortSignal, options: MoveOptions = {}): Promise<Element | null> {
    throwIfStopped(signal);
    this.wake();
    const first = resolve(target);
    const element = first.element;
    if (element instanceof HTMLElement) {
      const rect = element.getBoundingClientRect();
      if (rect.width > 0 && (rect.bottom < 0 || rect.top > window.innerHeight)) element.scrollIntoView({ block: 'center', inline: 'nearest' });
    }
    const aim = this.aimer(target, first.point);
    this.show();
    let point = aim();
    if (this.speed > 0) {
      const width = element ? Math.max(8, Math.min(element.getBoundingClientRect().width, 200)) : 24;
      point = await this.travel(aim, { targetWidth: width, ...options }, 0, signal);
      point = await this.settle(aim, point, 0, signal);
    }
    this.place(point);
    const over = this.under(point) ?? element;
    if (over) {
      fire(over, 'pointermove', point);
      fire(over, 'mousemove', point);
    }
    return over;
  }

  /** Presses whatever is at the target: the events of a mouse button going down and up, then a click. */
  async click(target: Target, signal?: AbortSignal): Promise<Element> {
    const reached = await this.moveTo(target, signal);
    await this.beat(this.speed > 0 ? this.random.range(90, 190) : 0, signal);
    const intended = resolve(target).element;
    let hit = this.under(this.at) ?? reached;
    // Something else is under the cursor now (the target moved, or a popup covers it): aim again once,
    // then press the target itself rather than whatever happens to be there.
    if (intended && hit && hit !== intended && !intended.contains(hit)) {
      hit = (await this.moveTo(intended, signal)) ?? intended;
      if (hit !== intended && !intended.contains(hit)) hit = intended;
    }
    const at = this.at;
    if (!hit) throw new Error('There is nothing under the assistant’s cursor to press');
    try {
      this.root.classList.add('is-pressing');
      this.ripple(at);
      fire(hit, 'pointerdown', at, { buttons: 1 });
      if (fire(hit, 'mousedown', at, { buttons: 1, detail: 1 })) this.focusFor(hit);
      await this.beat(80, signal);
      fire(hit, 'pointerup', at, { buttons: 0 });
      fire(hit, 'mouseup', at, { buttons: 0, detail: 1 });
      fire(hit, 'click', at, { buttons: 0, detail: 1 });
    } finally {
      this.root.classList.remove('is-pressing');
    }
    return hit;
  }

  /**
   * Presses the right button on the target, as a person does to open its menu. Some widgets only open their
   * menu for a real right-click; the caller opens it for them then, with the cursor already on the spot.
   */
  async rightClick(target: Target, signal?: AbortSignal): Promise<Element> {
    const reached = await this.moveTo(target, signal);
    await this.beat(this.speed > 0 ? this.random.range(90, 190) : 0, signal);
    const hit = this.under(this.at) ?? reached ?? resolve(target).element;
    const at = this.at;
    if (!hit) throw new Error('There is nothing under the assistant’s cursor to press');
    try {
      this.root.classList.add('is-pressing');
      this.ripple(at);
      fire(hit, 'pointerdown', at, { button: 2, buttons: 2 });
      fire(hit, 'mousedown', at, { button: 2, buttons: 2, detail: 1 });
      await this.beat(80, signal);
      fire(hit, 'pointerup', at, { button: 2, buttons: 0 });
      fire(hit, 'mouseup', at, { button: 2, buttons: 0, detail: 1 });
      fire(hit, 'contextmenu', at, { button: 2, buttons: 0 });
    } finally {
      this.root.classList.remove('is-pressing');
    }
    return hit;
  }

  /** Double-clicks the target: two quick presses on one spot, then the double click itself. */
  async doubleClick(target: Target, signal?: AbortSignal): Promise<Element> {
    const reached = await this.moveTo(target, signal);
    await this.beat(this.speed > 0 ? this.random.range(90, 170) : 0, signal);
    const intended = resolve(target).element;
    const under = this.under(this.at) ?? reached;
    // What is under the cursor, if it is part of the target; the target itself otherwise.
    const hit = intended && under && !intended.contains(under) ? intended : (under ?? intended);
    if (!hit) throw new Error('There is nothing under the assistant’s cursor to press');
    const at = this.at;
    try {
      for (const detail of [1, 2]) {
        this.root.classList.add('is-pressing');
        this.ripple(at);
        fire(hit, 'pointerdown', at, { buttons: 1 });
        if (fire(hit, 'mousedown', at, { buttons: 1, detail })) this.focusFor(hit);
        await this.beat(55, signal);
        fire(hit, 'pointerup', at, { buttons: 0 });
        fire(hit, 'mouseup', at, { buttons: 0, detail });
        fire(hit, 'click', at, { buttons: 0, detail });
        this.root.classList.remove('is-pressing');
        if (detail === 1) await this.beat(70, signal);
      }
      fire(hit, 'dblclick', at, { buttons: 0, detail: 2 });
    } finally {
      this.root.classList.remove('is-pressing');
    }
    return hit;
  }

  /**
   * Types into a text box one letter at a time, so a React-controlled box sees every change. With
   * `replace`, it first selects what is there, the way a person double-clicks a number to type over it.
   */
  async type(field: HTMLInputElement | HTMLTextAreaElement, text: string, signal?: AbortSignal, { perSecond = 20, replace = false }: { perSecond?: number; replace?: boolean } = {}): Promise<void> {
    this.wake();
    if (this.doc.activeElement !== field) await this.click(field, signal);
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')?.set;
    const write = (value: string, data: string | null, inputType: string) => {
      if (setter) setter.call(field, value);
      else field.value = value;
      field.dispatchEvent(typeof InputEvent === 'function' ? new InputEvent('input', { bubbles: true, data, inputType }) : new Event('input', { bubbles: true }));
    };
    let value = field.value;
    let overwrite = false;
    if (replace && value) {
      field.select();
      // The old value shows selected for a moment before the first key replaces it.
      await this.beat(420, signal);
      overwrite = true;
    }
    for (const char of text) {
      throwIfStopped(signal);
      value = overwrite ? char : value + char;
      overwrite = false;
      write(value, char, 'insertText');
      // A person types unevenly, a little faster inside a word than across a space.
      await this.beat((char === ' ' ? 1.6 : 0.8 + Math.random() * 0.5) * (1000 / perSecond), signal);
    }
  }

  /**
   * Leaves a field the way a person does, by moving on, so a field that saves when it is left saves. Without
   * the window's focus (a background window, a test browser) the browser moves the focus without saying so,
   * and then it is said here instead.
   */
  leaveField(field: HTMLElement): void {
    let left = false;
    const mark = () => {
      left = true;
    };
    field.addEventListener('blur', mark, { once: true });
    field.blur();
    field.removeEventListener('blur', mark);
    if (left) return;
    field.dispatchEvent(new FocusEvent('blur'));
    field.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  }

  /** Presses a key in the focused element, or in `on`. */
  key(key: string, on?: Element | null): void {
    const target = on ?? this.doc.activeElement ?? this.doc.body;
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    target.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }));
  }

  /**
   * Picks up what is at `from`, carries it to `to` and lets go there. The target is worked out again on
   * every frame, so a row that moved while the plan scrolled is still where the hand lets go.
   */
  async drag(from: Target, to: Target, signal?: AbortSignal, { pace = 2.1, hold = 480, straight = false }: DragOptions = {}): Promise<void> {
    this.wake();
    const reached = await this.moveTo(from, signal);
    const start = this.at;
    const picked = this.under(start) ?? reached;
    if (!picked) throw new Error('There is nothing under the assistant’s cursor to pick up');
    const aim = this.aimer(to, resolve(to).point);
    this.root.classList.add('is-pressing', 'is-dragging');
    fire(picked, 'pointerdown', start, { buttons: 1 });
    fire(picked, 'mousedown', start, { buttons: 1 });
    let released = false;
    try {
      if (this.speed > 0) await (straight ? this.carryStraight(start, aim, pace, signal) : this.carry(start, aim, pace, signal));
      else {
        for (let index = 1; index <= 6; index += 1) {
          throwIfStopped(signal);
          const end = aim();
          const point = { x: start.x + ((end.x - start.x) * index) / 6, y: start.y + ((end.y - start.y) * index) / 6 };
          this.place(point);
          this.moveEvents(point, 1);
        }
      }
      await this.beat(hold, signal);
      const at = this.at;
      const over = this.under(at) ?? this.doc.body;
      released = true;
      fire(over, 'pointerup', at, { buttons: 0 });
      fire(over, 'mouseup', at, { buttons: 0 });
    } finally {
      this.root.classList.remove('is-pressing', 'is-dragging');
      if (!released) {
        // Stopped part way: let go the way a person cancels a drag, so nothing lands.
        this.doc.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        const over = this.under(this.at) ?? this.doc.body;
        fire(over, 'pointerup', this.at, { buttons: 0 });
        fire(over, 'mouseup', this.at, { buttons: 0 });
      }
    }
  }

  /**
   * Carries what it holds to wherever `aim` points, the way a person does: a moment to get a grip, a
   * short tug to free it, a slow carry that bends partway and ends a little off the spot (about a row
   * above or below it), a look, and a careful last move onto it.
   */
  private async carry(start: Point, aim: () => Point, pace: number, signal?: AbortSignal): Promise<void> {
    const random = this.random;
    await this.beat(random.range(200, 320), signal);
    const goal = aim();
    const length = Math.hypot(goal.x - start.x, goal.y - start.y) || 1;
    const along = { x: (goal.x - start.x) / length, y: (goal.y - start.y) / length };
    const across = { x: -along.y, y: along.x };

    // A short tug, not quite toward the spot, that lifts it free.
    const pull = random.range(18, 30);
    const sway = random.range(-14, 14);
    const tug = { x: start.x + along.x * pull + across.x * sway, y: start.y + along.y * pull + across.y * sway };
    await this.travel(() => tug, { pace: pace * 0.9, correct: false, bow: random.range(-0.3, 0.3), targetWidth: 30 }, 1, signal);
    await this.beat(random.range(90, 200), signal);

    // The carry bends partway: first off to one side of the straight line, then on toward the spot.
    if (length > 260) {
      const share = random.range(0.42, 0.6);
      const bend = Math.min(140, length * random.range(0.08, 0.16)) * random.sign();
      const via = (): Point => {
        const now = aim();
        return { x: tug.x + (now.x - tug.x) * share + across.x * bend, y: tug.y + (now.y - tug.y) * share + across.y * bend };
      };
      await this.travel(via, { pace, correct: false, bow: random.range(0.06, 0.2) * random.sign(), targetWidth: 60 }, 1, signal);
      await this.beat(random.range(0, 110), signal);
    }

    // Toward the spot, ending a little off it: a row or so above or below, a little short or past.
    const off = { x: random.range(-50, 50), y: random.sign() * random.range(14, 30) };
    const near = (): Point => {
      const now = aim();
      return { x: now.x + off.x, y: now.y + off.y };
    };
    await this.travel(near, { pace, correct: false, bow: random.range(0.05, 0.22) * random.sign(), targetWidth: 40 }, 1, signal);

    // A look at where it goes, then onto it, carefully, and with it if the rows moved.
    await this.beat(random.range(220, 400), signal);
    const landed = await this.travel(aim, { pace: pace * 0.9, correct: true, targetWidth: 8 }, 1, signal);
    await this.settle(aim, landed, 1, signal);
  }

  /** Carries what it holds straight onto wherever `aim` points: a moment to get a grip, then one smooth line onto it. */
  private async carryStraight(start: Point, aim: () => Point, pace: number, signal?: AbortSignal): Promise<void> {
    await this.beat(120, signal);
    const goal = aim();
    const length = Math.hypot(goal.x - start.x, goal.y - start.y);
    const duration = Math.min(1100, Math.max(420, (260 + length * 0.55) * pace)) / this.speed;
    const started = performance.now();
    for (;;) {
      const t = Math.min(1, (performance.now() - started) / duration);
      const now = aim();
      const along = minimumJerk(t);
      const point = { x: start.x + (now.x - start.x) * along, y: start.y + (now.y - start.y) * along };
      this.place(point);
      this.moveEvents(point, 1);
      if (t >= 1) break;
      await frame(signal);
    }
    await this.settle(aim, this.at, 1, signal);
  }

  /**
   * A press moves the focus the way a mouse does: to the nearest thing that takes it, or away from
   * whatever had it. Bryntum selects a row when one of its cells gets the focus, not on the press itself.
   */
  private focusFor(hit: Element): void {
    const target = hit.closest<HTMLElement>(FOCUSABLE);
    if (target) target.focus({ preventScroll: true });
    else if (this.doc.activeElement instanceof HTMLElement && this.doc.activeElement !== this.doc.body) this.doc.activeElement.blur();
  }

  private ripple(at: Point): void {
    const ring = this.doc.createElement('span');
    ring.className = 'rail-ripple';
    ring.style.left = `${at.x}px`;
    ring.style.top = `${at.y}px`;
    this.doc.body.append(ring);
    setTimeout(() => ring.remove(), 600);
  }
}
