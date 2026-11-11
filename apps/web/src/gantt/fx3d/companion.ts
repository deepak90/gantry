/**
 * The assistant in the 3D view: its face from the call, lifted out of its tile on the call bar and floating over the
 * scene, the way a companion floats beside you. It comes out of the tile once the view is up and goes back into it
 * when the view closes or the call ends. While it is out, it takes the cursor's place, so there is one of it on
 * screen: it goes where the cursor goes to press something, and otherwise waits at the side of the view, or hovers
 * beside whatever it points at with a thread of light to it, never over it.
 *
 * It wears the call face's moods: its light follows its voice while it speaks (its real voice on a spoken call), the
 * three orbs chase round it while it thinks, and it leans the way it flies. It is drawn in the page, not in the scene,
 * so the scene's light, shading and glow never touch it.
 */
import { type Box3, type PerspectiveCamera, Vector3 } from 'three';
import { attention, type AssistantMood } from '../../assistant/attention';
import { remyMarkElement } from '../../assistant/RemyMark';
import '../../styles/rails.css';
import '../../styles/companion.css';

export interface ViewRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface CompanionOptions {
  camera: () => PerspectiveCamera;
  /** Where the scene is drawn on the page. */
  view: () => ViewRect;
  /** Whether the view is up and settled, not on its way in from the chart or back out to it. */
  up: () => boolean;
  reducedMotion: boolean;
}

export interface Companion {
  /** Whether it is out over the scene, or on its way out or back. */
  shown(): boolean;
  /** Something in the scene to point at, or nothing. */
  attend(target: Box3 | null): void;
  /** Something may have changed: it looks again on the next frame. */
  wake(): void;
  dispose(): void;
}

interface Point {
  x: number;
  y: number;
}

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** The face's size over the scene, a little larger than on the call. */
const FACE = 52;
const RADIUS = FACE / 2;
/** How far it keeps from what it points at. */
const GAP = 16;
/** How long it stays with the cursor after the cursor last moved or pressed. */
const HAND_HOLD_MS = 1400;
/** How often it looks again at what is on the page around it. */
const LOOK_MS = 260;
/** A better place has to be this much better before it moves there, so it doesn't hop as the camera turns. */
const SETTLE_SCORE = 900;
const OUT_MOODS: ReadonlySet<AssistantMood> = new Set(['idle', 'listening', 'thinking', 'working', 'speaking']);
/** What it keeps clear of: the view's own controls and cards, the side panel, and the call. */
const BLOCKERS = [
  '.fxb-readout',
  '.fxb-floors',
  '.fxb-bar',
  '.fxb-callout:not([hidden])',
  '.fxb-hint.is-shown',
  '.fxb-legend',
  '.fxb-close',
  '.fxb-chip:not([hidden])',
  '.fxb-toast:not([hidden])',
  '.fxb-calendar-tag:not([hidden])',
  '.fxb-idle-tag:not([hidden])',
  '.fxb-machine:not([hidden])',
  '.inspector-host.is-lifted > .inspector',
  '.fx3d-panelbar',
  '.fx3d-viewpad',
  '.fx3d-sitebar',
  '.fx3d-nav',
  '.fx3d-diary',
  '[data-testid="rail-call"]',
].join(', ');

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const overlap = (a: Rect, b: Rect) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
const around = (at: Point, half: number): Rect => ({ left: at.x - half, top: at.y - half, right: at.x + half, bottom: at.y + half });
const area = (rect: Rect) => Math.max(0, rect.right - rect.left) * Math.max(0, rect.bottom - rect.top);
const faceMood = (mood: AssistantMood) => (mood === 'away' || mood === 'joining' || mood === 'leaving' ? 'idle' : mood);

export function createCompanion({ camera, view, up, reducedMotion }: CompanionOptions): Companion {
  const layer = document.createElement('div');
  layer.className = 'fx3d-companion';
  layer.setAttribute('aria-hidden', 'true');
  layer.hidden = true;

  // The thread to what it points at, and the spot where it lands.
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'fx3d-companion-thread');
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  svg.append(line);
  const dot = document.createElement('span');
  dot.className = 'fx3d-companion-dot';

  // The face, as on the call: the aura, the night-blue disc with the crane, and the three orbs.
  const face = document.createElement('span');
  const aura = document.createElement('span');
  aura.className = 'rail-face-aura';
  const disc = document.createElement('span');
  disc.className = 'rail-face is-assistant';
  const markSlot = document.createElement('span');
  markSlot.className = 'rail-face-mark';
  const mark = remyMarkElement('breath');
  markSlot.append(mark);
  disc.append(markSlot);
  const orbs = document.createElement('span');
  orbs.className = 'rail-face-orbs';
  orbs.append(document.createElement('i'), document.createElement('i'), document.createElement('i'));
  face.append(aura, disc, orbs);
  layer.append(svg, dot, face);
  document.body.append(layer);

  let out = false;
  let going = false;
  let target: Box3 | null = null;
  let mood: AssistantMood = attention.mood;
  const at: Point = { x: 0, y: 0 };
  let lean = 0;
  let scale = 1;
  let shownAmount = 0;
  let threadAmount = 0;
  let frame = 0;
  let last = 0;
  let time = 0;
  let handAt: Point | null = null;
  let handMovedAt = 0;
  let blockers: Rect[] = [];
  let lookedAt = -Infinity;
  /** The spot it has settled on beside its target, as an index into the spots it weighs. */
  let chosen = -1;
  const point = new Vector3();
  const corners = Array.from({ length: 8 }, () => new Vector3());

  const stopMood = attention.subscribe((next) => {
    mood = next;
    face.className = `fx3d-companion-face rail-face-frame is-md is-${faceMood(next)}`;
    mark.setAttribute('class', `remy-mark is-${next === 'thinking' || next === 'working' ? 'work' : 'breath'}`);
    wake();
  });

  function project(world: Vector3, rect: ViewRect): Point & { behind: boolean } {
    point.copy(world).project(camera());
    return { x: rect.left + ((point.x + 1) / 2) * rect.width, y: rect.top + ((1 - point.y) / 2) * rect.height, behind: point.z > 1 };
  }

  /** The face on the call bar, where it comes out from and goes back into. */
  function tile(): { at: Point; size: number } | null {
    const onCall = document.querySelector<HTMLElement>('[data-testid="rail-call-assistant"] .rail-face');
    const rect = onCall?.getBoundingClientRect();
    if (!rect || rect.width === 0) return null;
    return { at: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }, size: rect.width };
  }

  /** Reads where the page's own controls are, a few times a second. True when it just did. */
  function lookAround(now: number): boolean {
    if (now - lookedAt < LOOK_MS) return false;
    lookedAt = now;
    blockers = [...document.querySelectorAll<HTMLElement>(BLOCKERS)]
      .map((element) => element.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0)
      .map((rect) => ({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }));
    return true;
  }

  /** How bad a spot is: covering the page's controls, covering what it points at, or leaving the view. */
  function score(spot: Point, rect: ViewRect, covered: Rect | null): number {
    const box = around(spot, RADIUS + 10);
    let cost = 0;
    for (const blocker of blockers) cost += overlap(box, blocker);
    if (covered) cost += overlap(box, covered) * 3;
    const inside = { left: rect.left + 8, top: rect.top + 8, right: rect.left + rect.width - 8, bottom: rect.top + rect.height - 8 };
    cost += (area(box) - overlap(box, inside)) * 4;
    return cost;
  }

  function best(spots: readonly Point[], rect: ViewRect, covered: Rect | null): number {
    let found = 0;
    let lowest = Infinity;
    spots.forEach((spot, index) => {
      const cost = score(spot, rect, covered);
      if (cost < lowest) {
        lowest = cost;
        found = index;
      }
    });
    return found;
  }

  /** Places to wait while it points at nothing: down the left of the view, where nothing of the view's own sits. */
  function homeSpots(rect: ViewRect): Point[] {
    const left = rect.left + RADIUS + 28;
    return [
      { x: left, y: rect.top + rect.height * 0.46 },
      { x: left, y: rect.top + rect.height * 0.62 },
      { x: left, y: rect.top + rect.height * 0.32 },
      { x: rect.left + rect.width * 0.5, y: rect.top + RADIUS + 22 },
    ];
  }

  /** Beside the target on the screen, and the point on it the thread lands on. */
  function besideTarget(rect: ViewRect, looked: boolean): { goal: Point; anchor: Point | null } {
    const { min, max } = target!;
    let index = 0;
    for (const x of [min.x, max.x]) for (const y of [min.y, max.y]) for (const z of [min.z, max.z]) corners[index++]!.set(x, y, z);
    const projected = corners.map((corner) => project(corner, rect));
    const shown = projected.filter((spot) => !spot.behind);
    if (shown.length === 0) {
      const homes = homeSpots(rect);
      return { goal: homes[best(homes, rect, null)]!, anchor: null };
    }
    const right = rect.left + rect.width;
    const bottom = rect.top + rect.height;
    const on: Rect = {
      left: clamp(Math.min(...shown.map((spot) => spot.x)), rect.left, right),
      right: clamp(Math.max(...shown.map((spot) => spot.x)), rect.left, right),
      top: clamp(Math.min(...shown.map((spot) => spot.y)), rect.top, bottom),
      bottom: clamp(Math.max(...shown.map((spot) => spot.y)), rect.top, bottom),
    };
    const width = on.right - on.left;
    const reach = RADIUS + GAP;
    const spots: Point[] = [
      { x: on.right + reach, y: on.top + RADIUS },
      { x: on.left - reach, y: on.top + RADIUS },
      { x: on.left + width * 0.75, y: on.top - reach },
      { x: on.left + width * 0.25, y: on.top - reach },
      { x: on.right + reach, y: on.bottom - RADIUS },
      { x: on.left - reach, y: on.bottom - RADIUS },
      { x: on.left + width * 0.5, y: on.bottom + reach },
      ...homeSpots(rect),
    ];
    if (chosen < 0 || chosen >= spots.length) chosen = best(spots, rect, on);
    else if (looked) {
      // A few times a second it may move to a much better spot; a slightly better one isn't worth the hop.
      const bestIndex = best(spots, rect, on);
      if (bestIndex !== chosen && score(spots[bestIndex]!, rect, on) < score(spots[chosen]!, rect, on) - SETTLE_SCORE) chosen = bestIndex;
    }
    const goal = spots[chosen]!;
    // The thread lands on the target's top corner nearest the face, a little way in from it.
    const tops = [1, 3, 5, 7].map((at) => projected[at]!).filter((spot) => !spot.behind);
    const center = project(point.set((min.x + max.x) / 2, (min.y + max.y) / 2, max.z), rect);
    let anchor: Point | null = null;
    if (tops.length > 0) {
      const nearest = tops.reduce((a, b) => (Math.hypot(a.x - goal.x, a.y - goal.y) <= Math.hypot(b.x - goal.x, b.y - goal.y) ? a : b));
      anchor = { x: nearest.x + (center.x - nearest.x) * 0.18, y: nearest.y + (center.y - nearest.y) * 0.18 };
    }
    return { goal, anchor };
  }

  /** The cursor, while it is at work and for a moment after: it goes there instead of pointing. */
  function cursorAtWork(now: number): Point | null {
    const pointer = attention.pointer();
    if (!pointer || !pointer.shown) {
      handAt = null;
      return null;
    }
    if (!handAt || Math.abs(pointer.x - handAt.x) + Math.abs(pointer.y - handAt.y) > 0.5 || pointer.pressing) handMovedAt = now;
    handAt = { x: pointer.x, y: pointer.y };
    return now - handMovedAt < HAND_HOLD_MS ? handAt : null;
  }

  function comeOut(): void {
    const from = tile();
    const rect = view();
    const homes = homeSpots(rect);
    const start = from?.at ?? homes[best(homes, rect, null)]!;
    at.x = start.x;
    at.y = start.y;
    scale = from ? from.size / FACE : 0.6;
    shownAmount = from ? 1 : 0;
    // Where the cursor was before the view opened is not something to fly to.
    handAt = null;
    handMovedAt = 0;
    const pointer = attention.pointer();
    if (pointer) handAt = { x: pointer.x, y: pointer.y };
    out = true;
    going = false;
    chosen = -1;
    layer.hidden = false;
    document.documentElement.classList.add('remy-embodied');
  }

  function goneBack(): void {
    out = false;
    going = false;
    layer.hidden = true;
    document.documentElement.classList.remove('remy-embodied');
  }

  function step(now: number): void {
    const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000));
    last = now;
    time += dt;
    const wanted = up() && OUT_MOODS.has(mood);
    if (wanted && !out) comeOut();
    if (!out) return;
    going = !wanted;

    const rect = view();
    const looked = lookAround(now);
    let goal: Point;
    let anchor: Point | null = null;
    let goalScale = 1;
    if (going) {
      const home = tile();
      if (!home) {
        // No call bar to go back into: it fades where it is.
        shownAmount = Math.max(0, shownAmount - dt * 4);
        goal = at;
        if (shownAmount <= 0.01) {
          goneBack();
          return;
        }
      } else {
        goal = home.at;
        goalScale = home.size / FACE;
        if (Math.hypot(at.x - goal.x, at.y - goal.y) < 2.5) {
          goneBack();
          return;
        }
      }
    } else {
      shownAmount = Math.min(1, shownAmount + dt * 3);
      const hand = cursorAtWork(now);
      if (hand) {
        // Just above and to the left of the cursor's tip, where a cursor's body would be.
        goal = { x: hand.x - RADIUS - 8, y: hand.y - RADIUS - 12 };
        anchor = hand;
        chosen = -1;
      } else if (target) {
        const beside = besideTarget(rect, looked);
        goal = beside.goal;
        anchor = beside.anchor;
      } else {
        chosen = -1;
        const homes = homeSpots(rect);
        goal = homes[best(homes, rect, null)]!;
      }
    }

    // It flies there with a little give, leaning into the way it goes.
    const rate = reducedMotion ? 14 : going ? 5.2 : 4.4;
    const k = 1 - Math.exp(-rate * dt);
    const fromX = at.x;
    at.x += (goal.x - at.x) * k;
    at.y += (goal.y - at.y) * k;
    const speed = (at.x - fromX) / dt;
    lean += (clamp(speed * 0.03, -16, 16) - lean) * (1 - Math.exp(-8 * dt));
    scale += (goalScale - scale) * (1 - Math.exp(-6 * dt));
    const bob = reducedMotion || going ? 0 : Math.sin(time * 1.9) * 3;

    face.style.transform = `translate3d(${(at.x - RADIUS).toFixed(1)}px, ${(at.y - RADIUS + bob).toFixed(1)}px, 0) rotate(${lean.toFixed(2)}deg) scale(${scale.toFixed(3)})`;
    face.style.opacity = shownAmount.toFixed(3);
    const level = mood === 'speaking' ? attention.voice() : mood === 'listening' ? attention.yours() * 0.6 : 0;
    face.style.setProperty('--level', (Math.round(level * 100) / 100).toString());

    // The thread, from the face's edge to the point it lands on.
    const far = anchor ? Math.hypot(anchor.x - at.x, anchor.y - (at.y + bob)) : 0;
    const wantThread = anchor !== null && far > RADIUS + 10 && !going;
    threadAmount += ((wantThread ? 1 : 0) - threadAmount) * (1 - Math.exp(-9 * dt));
    if (anchor && far > 0) {
      const ux = (anchor.x - at.x) / far;
      const uy = (anchor.y - (at.y + bob)) / far;
      line.setAttribute('x1', (at.x + ux * (RADIUS + 3)).toFixed(1));
      line.setAttribute('y1', (at.y + bob + uy * (RADIUS + 3)).toFixed(1));
      line.setAttribute('x2', anchor.x.toFixed(1));
      line.setAttribute('y2', anchor.y.toFixed(1));
      dot.style.transform = `translate3d(${anchor.x.toFixed(1)}px, ${anchor.y.toFixed(1)}px, 0)`;
    }
    const threadShown = (threadAmount * shownAmount).toFixed(3);
    svg.style.opacity = threadShown;
    dot.style.opacity = threadShown;
  }

  function loop(now: number): void {
    frame = 0;
    step(now);
    if (out || (up() && OUT_MOODS.has(mood))) frame = requestAnimationFrame(loop);
  }

  function wake(): void {
    // Nothing to draw while no call has Remy on it and the face isn't out.
    if (frame || (!out && !OUT_MOODS.has(mood))) return;
    last = performance.now();
    frame = requestAnimationFrame(loop);
  }

  return {
    shown: () => out,
    attend(next) {
      target = next ? next.clone() : null;
      chosen = -1;
      wake();
    },
    wake,
    dispose() {
      cancelAnimationFrame(frame);
      frame = 0;
      stopMood();
      layer.remove();
      document.documentElement.classList.remove('remy-embodied');
    },
  };
}
