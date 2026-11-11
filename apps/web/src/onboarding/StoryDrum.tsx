/**
 * A counter wheel, like the hour meter on a machine: rows printed on a drum that turns behind a fixed
 * window. It rolls through whatever lies between and stops dead on the row, with no bounce.
 */
import { animate, useMotionValue, useReducedMotion, useTransform, type MotionValue } from 'motion/react';
import { useLayoutEffect, useState, type CSSProperties } from 'react';

export interface DrumShape {
  /** The height of a row at the window, in pixels. */
  rowHeight: number;
  /** How far the drum turns from one row to the next. */
  degrees: number;
}

const TURN = { type: 'spring', bounce: 0, visualDuration: 0.38 } as const;
/** How hard the drum is kicked, in rows a second for each row it has to go, so it moves on the very first frame. */
const KICK = 4;

export interface DrumOptions {
  /** Where the drum stands when it first shows, if not already on its row. */
  start?: number;
  /** Go straight to the row, as when a project is still loading its data. */
  snap?: boolean;
}

/**
 * Turns the drum to row `at`. `first` to `last` are the rows that show, for a drum that only draws those. A snap
 * lands before the page is painted, so a row that is on its way out is never seen in the window.
 */
export function useDrum(at: number, { start = at, snap = false }: DrumOptions = {}) {
  const reduce = useReducedMotion();
  const turn = useMotionValue(reduce ? at : start);
  const [rest, setRest] = useState(at);
  useLayoutEffect(() => {
    if (reduce || snap) {
      turn.set(at);
      setRest(at);
      return undefined;
    }
    const controls = animate(turn, at, { ...TURN, velocity: (at - turn.get()) * KICK, onComplete: () => setRest(at) });
    return () => controls.stop();
  }, [at, reduce, snap, turn]);
  return { turn, first: Math.min(rest, at), last: Math.max(rest, at) };
}

/** Rows fade as they go round the drum, gone by the time they would turn their back. */
function faceOpacity(degrees: number): number {
  const facing = Math.cos((degrees * Math.PI) / 180);
  return Math.abs(degrees) >= 90 ? 0 : Math.max(0, (facing - 0.1) / 0.9);
}

/** Where row `index` stands as the drum turns. The row at the window sits flat on the page, so its text stays sharp. */
export function useFace(turn: MotionValue<number>, index: number, { rowHeight, degrees }: DrumShape) {
  const radius = rowHeight / (2 * Math.tan((degrees * Math.PI) / 360));
  const transform = useTransform(turn, (value) => `translateZ(${-radius}px) rotateX(${(value - index) * degrees}deg) translateZ(${radius}px)`);
  const opacity = useTransform(turn, (value) => faceOpacity((value - index) * degrees));
  return { transform, opacity };
}

/** Hands the row height to the stylesheet, so the numbers live in one place. */
export const drumStyle = ({ rowHeight }: DrumShape) => ({ '--drum-row': `${rowHeight}px` }) as CSSProperties;
