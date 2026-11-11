/**
 * The labels on the board, read the way a map's are: always sharp and the same size, saying more the closer you
 * get, and giving way to each other rather than piling up. Far out a plot has its name, dates and anything wrong;
 * closer it adds where it stands and its crew; close up its money and how much of its rental is being used.
 */
import type { Progress } from './facts';

export type PlateLevel = 0 | 1 | 2;

/** How much a label says, from how large the board is on the screen right now: pixels for one unit of it. */
export const plateLevel = (pixelsPerUnit: number): PlateLevel => (pixelsPerUnit >= 1.5 ? 2 : pixelsPerUnit >= 0.95 ? 1 : 0);

const DAY_MS = 86_400_000;

/** Where the plan has a piece of work on a date, in the plate's few words. */
export function standingOf(progress: Progress, start: number, end: number, at: number): string {
  // Only what has been reported is known: done ahead of its dates can only come from a report, and the rest is the plan.
  if (progress.state === 'done') return at >= end ? 'Planned to be done' : 'Reported finished early';
  if (progress.state === 'active') return progress.day > 0 ? `Planned day ${progress.day} of ${progress.of}` : 'Planned day off';
  const days = Math.ceil((start - at) / DAY_MS);
  return days <= 1 ? 'Planned to start tomorrow' : `Planned to start in ${days} days`;
}

export interface PlateLine {
  text: string;
  /** Shown from this level up. */
  from: PlateLevel;
  tone?: 'caution' | 'danger' | 'strong' | 'paypal';
  /** A crew's hat color beside its name. */
  dot?: string;
}

export interface Plate {
  element: HTMLElement;
  /** Its size, from when it last changed: reading layout every frame for every label would be wasteful. */
  width: number;
  height: number;
  level: PlateLevel;
  setLines(lines: readonly PlateLine[]): void;
  setLevel(level: PlateLevel): void;
  place(x: number, y: number, shown: boolean): void;
}

export function createPlate(parent: HTMLElement, kind: 'plot' | 'phase', swatch?: string, onClick?: () => void): Plate {
  const element = document.createElement('div');
  element.className = `fx3d-plate is-${kind}`;
  element.hidden = true;
  if (onClick) element.addEventListener('click', onClick);
  parent.append(element);
  let lines: readonly PlateLine[] = [];
  let lastKey = '';

  const render = (plate: Plate): void => {
    const visible = lines.filter((line) => line.from <= plate.level);
    element.dataset.level = String(plate.level);
    const key = `${plate.level}|${visible.map((line) => `${line.tone ?? ''}:${line.text}`).join('|')}`;
    if (key === lastKey) return;
    lastKey = key;
    element.replaceChildren(
      ...visible.map((line, index) => {
        const row = document.createElement(index === 0 ? 'b' : 'span');
        if (line.tone) row.dataset.tone = line.tone;
        if (index === 0 && swatch) {
          const chip = document.createElement('i');
          chip.style.background = swatch;
          row.append(chip);
        }
        if (line.dot) {
          const dot = document.createElement('i');
          dot.className = 'is-dot';
          dot.style.background = line.dot;
          row.append(dot);
        }
        row.append(line.text);
        return row;
      }),
    );
    // Measured once it has changed, while it can be measured.
    const wasHidden = element.hidden;
    element.hidden = false;
    plate.width = element.offsetWidth;
    plate.height = element.offsetHeight;
    element.hidden = wasHidden;
  };

  const plate: Plate = {
    element,
    width: 0,
    height: 0,
    level: 0,
    setLines(next) {
      lines = next;
      render(plate);
    },
    setLevel(level) {
      if (level === plate.level) return;
      plate.level = level;
      render(plate);
    },
    place(x, y, shown) {
      element.hidden = !shown;
      if (shown) element.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    },
  };
  return plate;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const overlaps = (a: Box, b: Box): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
