/**
 * The hero's model: Harbor Street Offices, the demo project, as the app's own 3D model of the building on its lot, with
 * the plan's big pieces in a schedule strip under it, both on the same date. When the hero comes on screen it plays
 * one short story (model-story.ts): the slab held until the footings are paid, Paid with PayPal, then the building
 * going up through the winter, and it holds still on the last frame.
 *
 * Only this file and the strip load with the page. three.js and the building (model-scene.ts) load when the hero nears
 * the screen; until they are ready the first frame shows as a still. The last frame shows as a still, the strip at its
 * end, where there is no WebGL, under reduced motion, and on screens narrower than 600px. The story pauses while the
 * hero is off screen or the tab is hidden, and everything is let go on pagehide.
 *
 * The hero around it (landing.html) gets .is-paid from the moment the story pays the footings, for its PayPal card.
 *
 * Markup, inside [data-model]:
 *   .model-body
 *     .model-stage > .model-frame             the picture, 16:10, centered in the space the strip leaves
 *       img.model-still, canvas.model-canvas  the still until the model is live (.model-body.is-live)
 *       .model-pin.model-hold > .model-label  "Hold · footings unpaid", pinned over the slab
 *       .model-pin.model-paid > .model-label  "Paid with PayPal", pinned by the footings
 *     .model-strip                            the schedule: ol.model-strip-rows (one li.model-strip-row.is-<key> a row),
 *                                             .model-strip-axis (the months), .model-strip-now (the date, a hairline down)
 */
import './model.css';
import rows from '../media/harbor-plan.json';
import endStill from '../media/model-end.webp';
import startStill from '../media/model-start.webp';
import { type HarborPlanRow, planTasks } from './harbor';
import type { HeroScene } from './model-scene';
import { along, BEATS, dayName, monthTicks, payBeat, rowProgress, storyDate, stripRows, stripSpan, type StripRow } from './model-story';

/** The stills' size in pixels: twice the picture's largest size on the page (720 by 450). */
const STILL = { width: 1440, height: 900 } as const;

/**
 * Where the labels are pinned on each still, as shares of the picture across and down: the model-scene's anchors as
 * the stills' camera sees them (null: not shown on that still).
 */
const STILL_PINS = {
  start: { hold: [0.4782, 0.4539], paid: [0.4509, 0.5414] },
  end: { hold: null, paid: [0.3888, 0.5341] },
} as const satisfies Record<'start' | 'end', Record<'hold' | 'paid', readonly [number, number] | null>>;

const NARROW = '(max-width: 599.98px)';
const REDUCED = '(prefers-reduced-motion: reduce)';

export function startModel(root: ParentNode = document): void {
  const host = root.querySelector<HTMLElement>('[data-model]');
  if (!host || host.querySelector('.model-body')) return;
  const view = buildView(host);
  const strip = buildStrip(view.strip, stripRows(planTasks(rows as unknown as HarborPlanRow[])));

  const showStill = (which: 'start' | 'end') => {
    view.body.classList.remove('is-live');
    view.still.src = which === 'start' ? startStill : endStill;
    const seconds = which === 'start' ? 0 : BEATS.end;
    const pins = STILL_PINS[which];
    const size = { width: view.frame.clientWidth, height: view.frame.clientHeight };
    pin(view.hold, pins.hold ? { x: pins.hold[0] * size.width, y: pins.hold[1] * size.height } : null);
    pin(view.paid, pins.paid ? { x: pins.paid[0] * size.width, y: pins.paid[1] * size.height } : null);
    labels(view, seconds);
    strip.show(seconds);
    still = which;
  };
  let still: 'start' | 'end' | null = null;
  // The stills' pins are shares of the picture: they follow it when the page changes size.
  const stillResize = new ResizeObserver(() => {
    if (still) showStill(still);
  });
  stillResize.observe(view.frame);

  if (window.matchMedia(REDUCED).matches || window.matchMedia(NARROW).matches || !hasWebGL()) {
    showStill('end');
    return;
  }
  view.still.fetchPriority = 'high';
  showStill('start');

  let scene: HeroScene | null = null;
  let seconds = 0;
  let frame = 0;
  let last = 0;
  let onScreen = false;
  let started = false;
  let gone = false;
  /** How much the model draws (HeroScene.quality), stepped down while frames run long. */
  let quality = 0;
  let levels = 1;
  let slow = { frames: 0, time: 0 };

  const draw = (at: number) => {
    if (!scene) return;
    scene.draw(at);
    pin(view.hold, scene.anchor('hold'));
    pin(view.paid, scene.anchor('paid'));
    labels(view, at);
    strip.show(at);
  };

  const tick = (now: number) => {
    frame = 0;
    const gap = Math.max(0, now - last);
    // A long gap (a busy main thread) slows the story rather than skipping part of it.
    seconds = Math.min(BEATS.end, seconds + Math.min(0.05, gap / 1000));
    last = now;
    keepUp(gap);
    draw(seconds);
    if (seconds < BEATS.end) play();
    // The last frame, held: drawn once more with everything, where frames had to be lighter to keep up.
    else if (scene && quality > 0) {
      quality = 0;
      scene.quality(0);
      draw(seconds);
    }
  };

  /** Under 45 frames a second over half a second: one step lighter. */
  function keepUp(gap: number): void {
    if (!scene || gap > 250) return;
    slow = { frames: slow.frames + 1, time: slow.time + gap };
    if (slow.frames < 30) return;
    if (slow.time / slow.frames > 22 && quality < levels - 1) {
      quality += 1;
      scene.quality(quality);
    }
    slow = { frames: 0, time: 0 };
  }

  function play(): void {
    if (frame || !scene || !started || seconds >= BEATS.end || !onScreen || document.hidden) return;
    if (!last || performance.now() - last > 100) last = performance.now();
    frame = requestAnimationFrame(tick);
  }

  function pause(): void {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    last = 0;
  }

  /** Back to the last still, for good: the model could not load, or its context was lost. */
  const fail = () => {
    pause();
    scene?.dispose();
    scene = null;
    gone = true;
    showStill('end');
  };

  const sized = new ResizeObserver(() => {
    if (!scene) return;
    scene.resize(view.frame.clientWidth, view.frame.clientHeight);
    // Held still (before it starts, paused, or done), the picture is drawn again at its new size.
    if (!frame) draw(seconds);
  });

  async function load(): Promise<void> {
    try {
      const { createHeroScene, QUALITY_LEVELS } = await import('./model-scene');
      // Set up when the page has a moment: building the model and compiling it are the heavy part.
      await idle();
      if (gone) return;
      const made = await createHeroScene(view.canvas);
      if (gone) {
        made.dispose();
        return;
      }
      scene = made;
      levels = QUALITY_LEVELS;
      view.canvas.addEventListener('webglcontextlost', fail, { once: true });
      scene.resize(view.frame.clientWidth, view.frame.clientHeight);
      draw(seconds);
      still = null;
      stillResize.disconnect();
      view.body.classList.add('is-live');
      sized.observe(view.frame);
      play();
    } catch {
      fail();
    }
  }

  const near = new IntersectionObserver(
    (entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      near.disconnect();
      void load();
    },
    { rootMargin: '400px 0px' },
  );
  near.observe(host);

  // On screen: a third of the hero in view starts the story; any of it out of view pauses it.
  const seen = new IntersectionObserver(
    ([entry]) => {
      if (!entry) return;
      onScreen = entry.isIntersecting;
      if (entry.intersectionRatio >= 0.34) started = true;
      if (onScreen) play();
      else pause();
    },
    { threshold: [0, 0.34] },
  );
  seen.observe(host);

  const motion = window.matchMedia(REDUCED);
  const settle = () => {
    if (!motion.matches) return;
    // Reduced motion asked for midway: straight to the last frame.
    pause();
    seconds = BEATS.end;
    if (scene) draw(seconds);
    else showStill('end');
  };
  motion.addEventListener('change', settle);

  const visibility = () => (document.hidden ? pause() : play());
  document.addEventListener('visibilitychange', visibility);

  window.addEventListener(
    'pagehide',
    () => {
      pause();
      near.disconnect();
      seen.disconnect();
      sized.disconnect();
      stillResize.disconnect();
      motion.removeEventListener('change', settle);
      document.removeEventListener('visibilitychange', visibility);
      scene?.dispose();
      scene = null;
      gone = true;
    },
    { once: true },
  );
  // Back from the back/forward cache, with the model let go: the page shows where the story ends.
  window.addEventListener('pageshow', (event) => {
    if (!event.persisted || !gone) return;
    showStill('end');
    stillResize.observe(view.frame);
  });
}

interface View {
  /** The hero around the model: its PayPal card shows once the story has paid the footings (.is-paid). */
  hero: HTMLElement | null;
  body: HTMLElement;
  frame: HTMLElement;
  still: HTMLImageElement;
  canvas: HTMLCanvasElement;
  hold: HTMLElement;
  paid: HTMLElement;
  strip: HTMLElement;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, parent?: HTMLElement): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  parent?.append(node);
  return node;
}

function buildView(host: HTMLElement): View {
  const body = element('div', 'model-body');
  body.setAttribute('aria-hidden', 'true');
  const stage = element('div', 'model-stage', body);
  const frame = element('div', 'model-frame', stage);
  const still = element('img', 'model-still', frame);
  still.alt = '';
  still.decoding = 'async';
  still.width = STILL.width;
  still.height = STILL.height;
  const canvas = element('canvas', 'model-canvas', frame);
  const pinWith = (kind: string, text: string) => {
    const node = element('div', `model-pin ${kind}`, frame);
    element('span', 'model-label', node).textContent = text;
    return node;
  };
  const hold = pinWith('model-hold', 'Hold · footings unpaid');
  const paid = pinWith('model-paid', 'Paid with PayPal');
  const strip = element('div', 'model-strip', body);
  host.append(body);
  return { hero: host.closest<HTMLElement>('.hero'), body, frame, still, canvas, hold, paid, strip };
}

/** Puts a label's pin on a point of the picture (CSS pixels), or hides it. */
function pin(node: HTMLElement, at: { x: number; y: number } | null): void {
  node.hidden = !at;
  if (!at) return;
  node.style.setProperty('--x', `${at.x.toFixed(1)}px`);
  node.style.setProperty('--y', `${at.y.toFixed(1)}px`);
}

/** The labels at a moment: the hold until it has lifted away, Paid from the moment it lands. */
function labels(view: View, seconds: number): void {
  const beat = payBeat(seconds);
  view.hold.style.setProperty('--lift', beat.lifted.toFixed(3));
  if (beat.lifted >= 1) view.hold.hidden = true;
  view.paid.style.setProperty('--land', beat.landed.toFixed(3));
  if (!beat.paid) view.paid.hidden = true;
  view.hero?.classList.toggle('is-paid', beat.paid);
}

interface Strip {
  /** The strip at a moment of the story. */
  show(seconds: number): void;
}

function buildStrip(container: HTMLElement, rows: readonly StripRow[]): Strip {
  const span = stripSpan(rows);
  const list = element('ol', 'model-strip-rows', container);
  const lines = rows.map((row) => {
    const line = element('li', `model-strip-row is-${row.key}`, list);
    line.style.setProperty('--from', along(row.start, span).toFixed(4));
    line.style.setProperty('--to', along(row.end, span).toFixed(4));
    element('span', 'model-strip-name', line).textContent = row.label;
    const track = element('span', 'model-strip-track', line);
    if (row.milestone) element('span', 'model-strip-diamond', track);
    else element('span', 'model-strip-fill', element('span', 'model-strip-bar', track));
    if (row.key === 'footings') element('span', 'model-strip-pill', track).textContent = 'Paid';
    return { row, line };
  });
  const axis = element('div', 'model-strip-axis', container);
  element('span', '', axis);
  const months = element('div', 'model-strip-months', axis);
  for (const tick of monthTicks(span.from, span.to)) {
    const month = element('span', 'model-strip-month', months);
    month.style.setProperty('--at', along(tick.at, span).toFixed(4));
    element('span', 'is-long', month).textContent = tick.label;
    element('span', 'is-short', month).textContent = tick.label.charAt(0);
  }
  const now = element('div', 'model-strip-now', container);
  const head = element('div', 'model-strip-head', now);
  const date = element('span', 'model-strip-date', head);
  let named = '';
  return {
    show(seconds) {
      const at = storyDate(seconds);
      const paid = payBeat(seconds).paid;
      for (const { row, line } of lines) {
        const done = rowProgress(row, at);
        line.style.setProperty('--done', done.toFixed(4));
        line.classList.toggle('is-done', done >= 1);
        if (row.key === 'footings') line.classList.toggle('is-paid', paid);
        if (row.key === 'slab') line.classList.toggle('is-held', !paid);
      }
      head.style.setProperty('--at', along(at, span).toFixed(5));
      const name = dayName(at);
      if (name !== named) date.textContent = named = name;
    },
  };
}

/** The next moment the page is idle (or soon, where it can't say). */
function idle(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(() => resolve(), { timeout: 1200 });
    else setTimeout(resolve, 120);
  });
}

/** WebGL 2, which three.js draws with, without keeping the context. */
function hasWebGL(): boolean {
  try {
    const context = document.createElement('canvas').getContext('webgl2');
    context?.getExtension('WEBGL_lose_context')?.loseContext();
    return Boolean(context);
  } catch {
    return false;
  }
}
