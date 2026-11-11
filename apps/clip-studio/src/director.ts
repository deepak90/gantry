/**
 * The camera, the pointer and the frames of a tape at any moment. The camera starts on the whole
 * window; each look moves it to the shot that shows what the look asked for, in the clip's shape
 * and never closer than `minWidth` window pixels, over the look's own time, keeping it above the
 * caption along the bottom (`inset`, a share of the shot's height). Moves pass through the center
 * linearly and the zoom evenly (on a log scale), so a big zoom does not rush at the start.
 */
import { Easing } from 'remotion';
import type { ClipRect, ClipTape } from '../../../packages/shared/src/clips';

export interface Shot extends ClipRect {}

interface Move {
  t: number;
  ms: number;
  from: Shot;
  to: Shot;
  ring: ClipRect | null;
}

export interface Press {
  t: number;
  x: number;
  y: number;
}

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/** Fast away, long settle: a camera operator easing onto the subject. */
const cameraEase = Easing.bezier(0.55, 0, 0.12, 1);

/**
 * The shot that shows `subject`: `aspect` wide to high, at least `minWidth` wide, inside the window,
 * with the subject in the part of it above the bottom `inset`.
 */
export function shotFor(subject: ClipRect, viewport: { width: number; height: number }, aspect: number, minWidth: number, inset = 0): Shot {
  const widest = Math.min(viewport.width, viewport.height * aspect);
  const width = Math.min(widest, Math.max(subject.width, (subject.height / (1 - inset)) * aspect, minWidth));
  const height = width / aspect;
  const x = clamp(subject.x + subject.width / 2 - width / 2, 0, viewport.width - width);
  const y = clamp(subject.y + subject.height / 2 - (height * (1 - inset)) / 2, 0, viewport.height - height);
  return { x, y, width, height };
}

function mix(from: Shot, to: Shot, at: number, aspect: number): Shot {
  const width = Math.exp(Math.log(from.width) + (Math.log(to.width) - Math.log(from.width)) * at);
  const height = width / aspect;
  const cx = from.x + from.width / 2 + (to.x + to.width / 2 - (from.x + from.width / 2)) * at;
  const cy = from.y + from.height / 2 + (to.y + to.height / 2 - (from.y + from.height / 2)) * at;
  return { x: cx - width / 2, y: cy - height / 2, width, height };
}

/** The last index whose `t` is at or before `t` (-1 when none is). */
function lastAtOrBefore<T extends { t: number }>(items: readonly T[], t: number): number {
  let low = 0;
  let high = items.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (items[middle]!.t <= t) {
      found = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  return found;
}

/** Pointer samples further apart than this are a pause, not a move: the pointer waits where it was. */
const PAUSE_MS = 60;

export interface Director {
  wide: Shot;
  shotAt(t: number): Shot;
  /** The look in force at `t` (its ring and when it started), or null before the first. */
  lookAt(t: number): { t: number; ms: number; ring: ClipRect | null; next: number } | null;
  frameAt(t: number): ClipTape['frames'][number];
  pointerAt(t: number): { x: number; y: number; down: boolean; since: number };
  presses: Press[];
}

export function direct(tape: ClipTape, aspect: number, { minWidth = 680, inset = 0 } = {}): Director {
  const wide = shotFor({ x: 0, y: 0, width: tape.viewport.width, height: tape.viewport.height }, tape.viewport, aspect, minWidth);
  const moves: Move[] = [];
  const shotAt = (t: number): Shot => {
    const index = lastAtOrBefore(moves, t);
    if (index === -1) return wide;
    const move = moves[index]!;
    const progress = move.ms > 0 ? clamp((t - move.t) / move.ms, 0, 1) : 1;
    return mix(move.from, move.to, cameraEase(progress), aspect);
  };
  for (const look of tape.looks) {
    moves.push({ t: look.t, ms: look.ms, from: shotAt(look.t), to: shotFor(look.rect, tape.viewport, aspect, minWidth, inset), ring: look.ring });
  }

  const pointer = tape.pointer;
  const presses: Press[] = [];
  /** When the button went down or up. */
  const changes: { t: number }[] = [];
  pointer.forEach((sample, index) => {
    const before = pointer[index - 1];
    if (before && before.down !== sample.down) {
      changes.push({ t: sample.t });
      if (sample.down) presses.push({ t: sample.t, x: sample.x, y: sample.y });
    }
  });

  return {
    wide,
    shotAt,
    lookAt(t) {
      const index = lastAtOrBefore(moves, t);
      if (index === -1) return null;
      const move = moves[index]!;
      return { t: move.t, ms: move.ms, ring: move.ring, next: moves[index + 1]?.t ?? Number.POSITIVE_INFINITY };
    },
    frameAt(t) {
      // A frame's own moment counts as reached (the clip's frame times and the tape's can differ in the last digit).
      return tape.frames[Math.max(0, lastAtOrBefore(tape.frames, t + 0.5))]!;
    },
    pointerAt(t) {
      const index = Math.max(0, lastAtOrBefore(pointer, t));
      const sample = pointer[index]!;
      const next = pointer[index + 1];
      const since = changes[lastAtOrBefore(changes, t)]?.t ?? Number.NEGATIVE_INFINITY;
      if (!next || next.t - sample.t > PAUSE_MS || t < sample.t) return { x: sample.x, y: sample.y, down: sample.down, since };
      const at = (t - sample.t) / (next.t - sample.t);
      return { x: sample.x + (next.x - sample.x) * at, y: sample.y + (next.y - sample.y) * at, down: sample.down, since };
    },
    presses,
  };
}
