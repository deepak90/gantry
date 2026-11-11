/**
 * Moving the camera in the ways that do not depend on knowing a gesture: telling a wheel from a trackpad, the
 * on-screen pad (zoom, turn, tilt, hold to keep going) and the same moves from the keyboard.
 */

export type WheelAction = 'zoom' | 'move';

/** Two wheel events this close together are the same gesture. */
const GESTURE_GAP_MS = 220;
/** A notched wheel on a Mac reports multiples of this (the same number Mapbox GL goes by). */
const MAC_WHEEL_STEP = 4.000244140625;

export interface WheelGesture {
  action: WheelAction;
  at: number;
}

/**
 * What a wheel event means. A pinch arrives as ctrl + wheel; a mouse wheel zooms, as on any map; a trackpad's two
 * fingers move. A gesture is judged by how it starts, since a flick grows as large as a wheel notch halfway through.
 */
export function wheelAction(event: { deltaX: number; deltaY: number; deltaMode: number; ctrlKey: boolean }, previous: WheelGesture | null, at: number): WheelGesture {
  if (event.ctrlKey) return { action: 'zoom', at };
  if (previous && at - previous.at < GESTURE_GAP_MS) return { action: previous.action, at };
  if (event.deltaMode !== 0 || event.deltaX !== 0) return { action: event.deltaMode !== 0 ? 'zoom' : 'move', at };
  const size = Math.abs(event.deltaY);
  const steps = size / MAC_WHEEL_STEP;
  const notched = size >= 50 || (size > 0 && Math.abs(steps - Math.round(steps)) < 1e-6);
  return { action: notched ? 'zoom' : 'move', at };
}

export interface OrbitLimits {
  minPolar: number;
  maxPolar: number;
  minDistance: number;
  maxDistance: number;
}

export interface OrbitStep {
  /** Radians around the up axis. */
  turn?: number;
  /** Radians toward the horizon. */
  tilt?: number;
  /** Times the distance: below 1 is closer. */
  zoom?: number;
}

/** The camera's offset from what it looks at after one step, z up and kept within the limits. */
export function steppedOffset(offset: { x: number; y: number; z: number }, step: OrbitStep, limits: OrbitLimits): { x: number; y: number; z: number } {
  const length = Math.hypot(offset.x, offset.y, offset.z) || 1;
  const azimuth = Math.atan2(offset.x, -offset.y) + (step.turn ?? 0);
  const polar = Math.min(limits.maxPolar, Math.max(limits.minPolar, Math.acos(Math.min(1, Math.max(-1, offset.z / length))) + (step.tilt ?? 0)));
  const distance = Math.min(limits.maxDistance, Math.max(limits.minDistance, length * (step.zoom ?? 1)));
  return { x: distance * Math.sin(polar) * Math.sin(azimuth), y: -distance * Math.sin(polar) * Math.cos(azimuth), z: distance * Math.cos(polar) };
}

export type PadMove = 'zoom-in' | 'zoom-out' | 'turn-left' | 'turn-right' | 'tilt-up' | 'tilt-down';

/** How much each move does per second while it is held. */
export function stepFor(move: PadMove, seconds: number): OrbitStep {
  switch (move) {
    case 'zoom-in':
      return { zoom: Math.exp(-1.1 * seconds) };
    case 'zoom-out':
      return { zoom: Math.exp(1.1 * seconds) };
    case 'turn-left':
      return { turn: 0.9 * seconds };
    case 'turn-right':
      return { turn: -0.9 * seconds };
    case 'tilt-up':
      return { tilt: -0.6 * seconds };
    default:
      return { tilt: 0.6 * seconds };
  }
}

const BUTTONS: readonly { move: PadMove; icon: string; label: string; key: string }[] = [
  { move: 'zoom-in', icon: 'fa-plus', label: 'Zoom in', key: '+' },
  { move: 'zoom-out', icon: 'fa-minus', label: 'Zoom out', key: '-' },
  { move: 'turn-left', icon: 'fa-rotate-left', label: 'Turn left', key: 'Q' },
  { move: 'turn-right', icon: 'fa-rotate-right', label: 'Turn right', key: 'E' },
  { move: 'tilt-down', icon: 'fa-angle-down', label: 'Tilt toward the horizon', key: 'F' },
  { move: 'tilt-up', icon: 'fa-angle-up', label: 'Tilt toward overhead', key: 'R' },
];

const KEYS: Readonly<Record<string, PadMove>> = { '+': 'zoom-in', '=': 'zoom-in', '-': 'zoom-out', _: 'zoom-out', q: 'turn-left', e: 'turn-right', f: 'tilt-down', r: 'tilt-up' };
const ARROWS: Readonly<Record<string, readonly [number, number]>> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1], a: [-1, 0], d: [1, 0], w: [0, 1], s: [0, -1] };

export interface ViewPad {
  element: HTMLElement;
  /** Applies whatever is being held, for this many seconds. */
  apply(seconds: number, run: { step(step: OrbitStep): void; move(across: number, along: number): void }): void;
  /** True while a move is held, so the frame loop keeps it going. */
  active(): boolean;
  destroy(): void;
}

export function createViewPad(enabled: () => boolean, wake: () => void): ViewPad {
  const element = document.createElement('div');
  element.className = 'fx3d-viewpad';
  element.setAttribute('role', 'toolbar');
  element.setAttribute('aria-label', 'Move the view');
  const held = new Set<PadMove>();
  const heldArrows = new Set<string>();

  for (const { move, icon, label, key } of BUTTONS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.title = `${label} (${key}), hold to keep going`;
    button.setAttribute('aria-label', label);
    const glyph = document.createElement('i');
    glyph.className = `fa ${icon}`;
    button.append(glyph);
    const release = (): void => {
      held.delete(move);
    };
    button.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      button.setPointerCapture(event.pointerId);
      held.add(move);
      wake();
    });
    button.addEventListener('pointerup', release);
    button.addEventListener('pointercancel', release);
    button.addEventListener('lostpointercapture', release);
    // A key press on a focused button: one step's worth, as a held button would give.
    button.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      event.stopPropagation();
      held.add(move);
      wake();
      window.setTimeout(release, 160);
    });
    element.append(button);
  }

  const isTyping = (event: KeyboardEvent): boolean => {
    const target = event.target as HTMLElement | null;
    return target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || Boolean(target?.isContentEditable) || Boolean(target?.closest?.('[role="slider"]'));
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (!enabled() || event.metaKey || event.ctrlKey || event.altKey || isTyping(event)) return;
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    const move = KEYS[key];
    if (move) {
      held.add(move);
    } else if (ARROWS[key]) {
      heldArrows.add(key);
    } else {
      return;
    }
    event.preventDefault();
    wake();
  };
  const onKeyUp = (event: KeyboardEvent): void => {
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    const move = KEYS[key];
    if (move) held.delete(move);
    heldArrows.delete(key);
  };
  const clearAll = (): void => {
    held.clear();
    heldArrows.clear();
  };
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', clearAll);

  return {
    element,
    active: () => held.size > 0 || heldArrows.size > 0,
    apply(seconds, run) {
      for (const move of held) run.step(stepFor(move, seconds));
      for (const key of heldArrows) {
        const [across, along] = ARROWS[key]!;
        run.move(across * seconds, along * seconds);
      }
    },
    destroy() {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', clearAll);
      element.remove();
    },
  };
}
