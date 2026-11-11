/**
 * The date rail: the plan's own Gantt in miniature, under the site board, and the one control for the date.
 * Rows follow the WBS and bars keep the chart's colors, so the board and the chart stay the same plan; left
 * of the date line the plan is solid, right of it still ahead. Idle rentals, double bookings, constraints,
 * deadlines and payments sit on their rows, which is how a date worth looking at gets found.
 */
import { planClock } from '../../plan-clock';

const DAY_MS = 86_400_000;
const NS = 'http://www.w3.org/2000/svg';
const GUTTER = 168;
const HEADER = 19;

export interface RailBar {
  key: unknown;
  label: string;
  row: number;
  start: number;
  end: number;
  color: string;
  critical: boolean;
  /** When its machine is booked with no work planned: before the work, after it, or both. */
  idle: readonly (readonly [number, number])[];
  clashes: readonly (readonly [number, number])[];
  baseline: readonly [number, number] | null;
  constraint: { at: number; label: string } | null;
  deadline: { at: number; missed: boolean } | null;
  payout: 'none' | 'ready' | 'moving' | 'paid' | 'failed';
}

export interface RailMark {
  label: string;
  row: number;
  at: number;
}

export interface RailPhase {
  label: string;
  firstRow: number;
  rows: number;
}

export interface RailBand {
  label: string;
  from: number;
  to: number;
}

export interface DateRailOptions {
  start: number;
  end: number;
  bars: readonly RailBar[];
  milestones: readonly RailMark[];
  phases: readonly RailPhase[];
  bands: readonly RailBand[];
  rowCount: number;
  /** Tokens, resolved by the caller. */
  colors: { ink: string; soft: string; line: string; accent: string; warning: string; danger: string; paypal: string; ready: string; weekend: string };
  onDate: (at: number) => void;
  onHover: (key: unknown) => void;
}

export interface DateRail {
  element: HTMLElement;
  /** Moves the date line, without telling anyone. */
  show(at: number): void;
  highlight(key: unknown): void;
  /** Which days the rail is showing: the whole plan, or closer in on one piece of work. */
  setWindow(from: number, to: number): void;
  /** The days to mark as this work's own, or none. */
  markSpan(span: readonly [number, number] | null): void;
  destroy(): void;
}

const midnightOf = (at: number): number => {
  const date = new Date(at);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
};

/** Noon of a day: the date a day means, so the work of that day is under way. */
export const middayOf = (at: number): number => midnightOf(at) + DAY_MS / 2;

// Making a formatter is what is slow, and a rail asks for dozens of labels each time it is drawn.
const formatters = new Map<Intl.DateTimeFormatOptions, Intl.DateTimeFormat>();
const dayLabel = (at: number, options: Intl.DateTimeFormatOptions): string => {
  let format = formatters.get(options);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', options);
    formatters.set(options, format);
  }
  return format.format(at);
};
const SHORT_DAY: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
const WEEKDAY_DAY: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric' };
const FULL_DAY: Intl.DateTimeFormatOptions = { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' };

function el(name: string, attributes: Record<string, string | number> = {}, parent?: Element): SVGElement {
  const node = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  parent?.append(node);
  return node as SVGElement;
}

export function createDateRail(options: DateRailOptions): DateRail {
  const { start, end, colors } = options;
  const element = document.createElement('div');
  element.className = 'fx3d-rail';
  element.tabIndex = 0;
  element.setAttribute('role', 'slider');
  element.setAttribute('aria-label', 'Date on the plan');
  const totalDays = Math.max(1, Math.round((end - start) / DAY_MS));
  element.setAttribute('aria-valuemin', '0');
  element.setAttribute('aria-valuemax', String(totalDays));
  const svg = el('svg', { role: 'presentation' }, element);
  const tip = document.createElement('div');
  tip.className = 'fx3d-rail-tip';
  tip.hidden = true;
  element.append(tip);

  const rowHeight = Math.min(4.6, Math.max(1.6, 84 / Math.max(1, options.rowCount)));
  const rowGap = rowHeight > 3 ? 1.6 : 0.8;
  const phaseGap = rowHeight > 3 ? 3 : 1;
  const phaseIndexOf = (row: number): number => options.phases.filter((phase) => phase.firstRow <= row).length - 1;
  const yOf = (row: number): number => HEADER + row * (rowHeight + rowGap) + Math.max(0, phaseIndexOf(row)) * phaseGap;
  const height = yOf(options.rowCount) + 3;

  let width = 800;
  let current = start;
  let highlighted: unknown = null;
  let dateClip: SVGElement | null = null;
  let line: SVGElement | null = null;
  let badge: SVGElement | null = null;
  let badgeBack: SVGElement | null = null;
  let badgeText: SVGElement | null = null;
  let glow: SVGElement | null = null;
  let viewFrom = start;
  let viewTo = end;
  let marked: readonly [number, number] | null = null;

  const span = (): number => Math.max(1, width - GUTTER - 10);
  const xOf = (at: number): number => GUTTER + ((at - viewFrom) / (viewTo - viewFrom)) * span();
  const atOf = (x: number): number => viewFrom + ((x - GUTTER) / span()) * (viewTo - viewFrom);

  function draw(): void {
    svg.replaceChildren();
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    const dayWidth = span() / Math.max(1, (viewTo - viewFrom) / DAY_MS);
    const defs = el('defs', {}, svg);
    const areaId = `fx3d-rail-area-${Math.round(Math.random() * 1e9)}`;
    el('rect', { x: GUTTER, y: 0, width: span() + 10, height }, el('clipPath', { id: areaId }, defs));
    const area = el('g', { 'clip-path': `url(#${areaId})` }, svg);

    // Weeks and weekends, quiet: they are only there to read the dates against.
    const grid = el('g', {}, area);
    for (let at = midnightOf(start); at < end; at += DAY_MS) {
      const date = new Date(at);
      // Daylight saving moves midnight by an hour; going by the date keeps the grid on days.
      const midnight = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
      const x = xOf(midnight);
      if ((date.getDay() === 0 || date.getDay() === 6) && dayWidth >= 3) {
        el('rect', { x, y: HEADER - 2, width: dayWidth, height: height - HEADER, fill: colors.weekend }, grid);
      }
    }
    const weekEvery = dayWidth * 7 >= 62 ? 1 : dayWidth * 14 >= 62 ? 2 : 4;
    // Close in, every day gets its line and, when there is room, its own date.
    const daily = dayWidth >= 26;
    let week = 0;
    for (let at = midnightOf(start); at < end; at += DAY_MS) {
      const date = new Date(at);
      const monday = date.getDay() === 1;
      if (!monday && !daily) continue;
      const x = xOf(new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime());
      if (daily || week % weekEvery === 0) {
        el('line', { x1: x, x2: x, y1: HEADER - 3, y2: height, stroke: colors.line, 'stroke-width': 1 }, grid);
        const label = el('text', { x: x + 3, y: 11, fill: colors.soft, 'font-size': 11 }, grid);
        label.textContent = monday || dayWidth >= 46 ? dayLabel(date.getTime(), SHORT_DAY) : String(date.getDate());
      }
      if (monday) week += 1;
    }
    if (marked) {
      el('rect', { x: xOf(marked[0]), y: HEADER - 3, width: Math.max(1, xOf(marked[1]) - xOf(marked[0])), height: height - HEADER + 3, fill: colors.accent, opacity: 0.1 }, grid);
    }
    for (const band of options.bands) {
      el('rect', { x: xOf(band.from), y: HEADER - 2, width: Math.max(1, xOf(band.to) - xOf(band.from)), height: height - HEADER, fill: colors.accent, opacity: 0.08 }, grid);
    }

    // The WBS, in words, so identity never rests on color alone.
    for (const phase of options.phases) {
      const label = el('text', { x: 0, y: yOf(phase.firstRow) + 8.5, fill: colors.ink, 'font-size': 11, 'font-weight': 540 }, svg);
      label.textContent = phase.label.length > 25 ? `${phase.label.slice(0, 24)}…` : phase.label;
    }

    // The plan twice: pale for all of it, and solid up to the date.
    const pale = el('g', { opacity: 0.3 }, area);
    const clipId = `fx3d-rail-${Math.round(Math.random() * 1e9)}`;
    const clip = el('clipPath', { id: clipId }, defs);
    dateClip = el('rect', { x: GUTTER, y: 0, width: 0, height }, clip);
    const solidBars = el('g', { 'clip-path': `url(#${clipId})` }, area);
    for (const bar of options.bars) {
      const y = yOf(bar.row);
      const x = xOf(bar.start);
      const w = Math.max(1.5, xOf(bar.end) - x);
      for (const group of [pale, solidBars]) el('rect', { x, y, width: w, height: rowHeight, rx: Math.min(1.5, rowHeight / 2), fill: bar.color }, group);
    }
    // What the bars are saying on top, always readable.
    const marks = el('g', {}, area);
    for (const bar of options.bars) {
      const y = yOf(bar.row);
      if (bar.baseline) {
        el('line', { x1: xOf(bar.baseline[0]), x2: xOf(bar.baseline[1]), y1: y + rowHeight + 0.4, y2: y + rowHeight + 0.4, stroke: colors.soft, 'stroke-width': 0.7, opacity: 0.8 }, marks);
      }
      for (const [from, to] of bar.idle) {
        el('rect', { x: xOf(from), y, width: Math.max(1, xOf(to) - xOf(from)), height: rowHeight, fill: colors.warning, rx: 1 }, marks);
      }
      for (const [from, to] of bar.clashes) {
        el('rect', { x: xOf(from), y: y - 0.4, width: Math.max(1.5, xOf(to) - xOf(from)), height: rowHeight + 0.8, fill: colors.danger, rx: 1 }, marks);
      }
      if (bar.constraint) {
        const x = xOf(bar.constraint.at);
        el('path', { d: `M${x - 3},${y - 1.2} L${x + 3},${y - 1.2} L${x},${y + 3.2} Z`, fill: colors.ink }, marks);
      }
      if (bar.deadline) {
        const x = xOf(bar.deadline.at);
        el('line', { x1: x, x2: x, y1: y - 1, y2: y + rowHeight + 1, stroke: bar.deadline.missed ? colors.danger : colors.ink, 'stroke-width': 1.4 }, marks);
      }
      if (bar.payout !== 'none') {
        const fill = bar.payout === 'ready' ? colors.ready : bar.payout === 'failed' ? colors.danger : colors.paypal;
        el('circle', { cx: xOf(bar.end) + 4.5, cy: y + rowHeight / 2, r: 3, fill, stroke: 'white', 'stroke-width': 1 }, marks);
      }
    }
    for (const mark of options.milestones) {
      const x = xOf(mark.at);
      const y = yOf(mark.row) + rowHeight / 2;
      el('path', { d: `M${x},${y - 4} L${x + 4},${y} L${x},${y + 4} L${x - 4},${y} Z`, fill: colors.ink }, marks);
    }
    const today = planClock.now().getTime();
    if (today > start && today < end) {
      const x = xOf(today);
      el('line', { x1: x, x2: x, y1: HEADER - 3, y2: height, stroke: colors.accent, 'stroke-width': 1.5 }, area);
    }

    glow = el('rect', { x: GUTTER - 2, y: 0, width: span() + 4, height: rowHeight + 2, fill: colors.accent, opacity: 0, rx: 2 }, area);
    line = el('line', { y1: 13, y2: height, stroke: colors.ink, 'stroke-width': 2 }, area);
    badge = el('g', {}, svg);
    badgeBack = el('rect', { y: 0, height: 15, rx: 3, fill: colors.ink }, badge);
    badgeText = el('text', { y: 11, fill: 'white', 'font-size': 11, 'font-weight': 640, 'text-anchor': 'middle' }, badge);
    show(current);
    highlight(highlighted);
  }

  function show(at: number): void {
    current = Math.min(end, Math.max(start, at));
    const x = xOf(current);
    dateClip?.setAttribute('width', String(Math.max(0, x - GUTTER)));
    line?.setAttribute('x1', String(x));
    line?.setAttribute('x2', String(x));
    const label = dayLabel(current, WEEKDAY_DAY);
    if (badgeText && badgeBack) {
      badgeText.textContent = label;
      const boxWidth = 84;
      const boxX = Math.min(width - boxWidth, Math.max(GUTTER, x - boxWidth / 2));
      badgeBack.setAttribute('x', String(boxX));
      badgeBack.setAttribute('width', String(boxWidth));
      badgeText.setAttribute('x', String(boxX + boxWidth / 2));
    }
    element.setAttribute('aria-valuenow', String(Math.round((current - start) / DAY_MS)));
    element.setAttribute('aria-valuetext', dayLabel(current, FULL_DAY));
  }

  function highlight(key: unknown): void {
    highlighted = key;
    const bar = options.bars.find((item) => item.key === key);
    if (!glow) return;
    glow.setAttribute('opacity', bar ? '0.16' : '0');
    if (bar) glow.setAttribute('y', String(yOf(bar.row) - 1));
  }

  // -- The pointer: anywhere on the rail sets the date, and drags it. --------------------------------------
  let dragging = false;
  const setFromPointer = (event: PointerEvent): void => {
    const box = element.getBoundingClientRect();
    options.onDate(middayOf(Math.min(end - DAY_MS / 2, Math.max(start, Math.max(viewFrom, Math.min(viewTo - DAY_MS / 2, atOf(event.clientX - box.left)))))));
  };
  const barAt = (event: PointerEvent): RailBar | null => {
    const box = element.getBoundingClientRect();
    const y = event.clientY - box.top;
    return options.bars.find((bar) => y >= yOf(bar.row) - rowGap && y < yOf(bar.row) + rowHeight + rowGap) ?? null;
  };
  const onDown = (event: PointerEvent): void => {
    dragging = true;
    element.setPointerCapture(event.pointerId);
    setFromPointer(event);
  };
  const onMove = (event: PointerEvent): void => {
    if (dragging) setFromPointer(event);
    const bar = barAt(event);
    options.onHover(bar?.key ?? null);
    if (!bar) {
      tip.hidden = true;
      return;
    }
    tip.textContent = bar.label;
    tip.hidden = false;
    const box = element.getBoundingClientRect();
    tip.style.left = `${Math.min(box.width - 240, Math.max(0, event.clientX - box.left - 20))}px`;
  };
  const onUp = (): void => {
    dragging = false;
  };
  const onLeave = (): void => {
    if (dragging) return;
    tip.hidden = true;
    options.onHover(null);
  };
  const lastDayOnShow = (): number => Math.min(end - DAY_MS / 2, viewTo - DAY_MS / 2);
  const onKey = (event: KeyboardEvent): void => {
    const step: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, PageDown: 7, PageUp: -7 };
    const by = step[event.key];
    let next: number | null = null;
    if (by !== undefined) next = current + by * (event.shiftKey ? 7 : 1) * DAY_MS;
    else if (event.key === 'Home') next = viewFrom;
    else if (event.key === 'End') next = lastDayOnShow();
    if (next === null) return;
    event.preventDefault();
    event.stopPropagation();
    options.onDate(middayOf(Math.min(lastDayOnShow(), Math.max(viewFrom, next))));
  };
  element.addEventListener('pointerdown', onDown);
  element.addEventListener('pointermove', onMove);
  element.addEventListener('pointerup', onUp);
  element.addEventListener('pointerleave', onLeave);
  element.addEventListener('keydown', onKey);

  const observer = new ResizeObserver(([entry]) => {
    const next = Math.round(entry?.contentRect.width ?? 0);
    if (next > 0 && next !== width) {
      width = next;
      draw();
    }
  });
  observer.observe(element);
  draw();

  return {
    element,
    show,
    highlight,
    setWindow(from, to) {
      viewFrom = from;
      viewTo = to;
      draw();
    },
    markSpan(next) {
      marked = next;
      draw();
    },
    destroy() {
      observer.disconnect();
      element.remove();
    },
  };
}
