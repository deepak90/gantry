/**
 * The flowline: the plan as where and when, the view location-based scheduling is built around. Time runs across,
 * the phases run down, and each piece of work is a slanted line in the color of its firm. Lines that run in step
 * mean trades following each other through the job; a dashed line follows one firm from job to job, so a firm
 * crossing back over itself, or two lines bunching up, shows at a glance. Clicking a line goes into that work.
 */
const NS = 'http://www.w3.org/2000/svg';
const DAY_MS = 86_400_000;
const LEFT = 148;
const TOP = 28;
const RIGHT = 16;
const BOTTOM = 46;

export interface FlowWork {
  key: unknown;
  label: string;
  /** Its number in the plan's outline, for when its name will not fit. */
  code: string;
  dates: string;
  row: number;
  start: number;
  end: number;
  crew: string;
  color: string;
  /** Days its machine is on rent before it starts. */
  /** A machine booked with no work planned, before the work and after it. */
  idleFrom: number | null;
  idleUntil: number | null;
  /** Spans where its crew is booked twice. */
  clashes: readonly (readonly [number, number])[];
  critical: boolean;
}

export interface FlowlineOptions {
  rows: readonly string[];
  works: readonly FlowWork[];
  start: number;
  end: number;
  colors: { ink: string; soft: string; line: string; idle: string; danger: string; weekend: string };
  onOpen: (key: unknown) => void;
  onHover: (key: unknown) => void;
}

export interface Flowline {
  element: HTMLElement;
  show(at: number): void;
  destroy(): void;
}

function el(name: string, attributes: Record<string, string | number> = {}, parent?: Element): SVGElement {
  const node = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  parent?.append(node);
  return node as SVGElement;
}

/** Which label fits: the name if there is room before the next line in its row, else only its number. */
export function labelsFor<T extends { row: number; start: number; end: number; label: string; code: string }>(works: readonly T[], xOf: (at: number) => number, limit: number, charWidth = 5.7): Map<T, string> {
  const labels = new Map<T, string>();
  const rows = new Map<number, T[]>();
  for (const work of works) rows.set(work.row, [...(rows.get(work.row) ?? []), work]);
  for (const list of rows.values()) {
    const ordered = [...list].sort((a, b) => a.end - b.end);
    ordered.forEach((work, index) => {
      const next = ordered[index + 1];
      const room = (next ? xOf(next.end) : limit) - xOf(work.end) - 10;
      labels.set(work, work.label.length * charWidth <= room ? work.label : work.code || work.label);
    });
  }
  return labels;
}

/** In each firm's order of work: the jobs it goes between. A firm that overlaps itself is the thing to see. */
export function firmLinks<T extends { crew: string; start: number }>(works: readonly T[]): [T, T][] {
  const byFirm = new Map<string, T[]>();
  for (const work of works) {
    if (!work.crew) continue;
    byFirm.set(work.crew, [...(byFirm.get(work.crew) ?? []), work]);
  }
  const links: [T, T][] = [];
  for (const list of byFirm.values()) {
    const ordered = [...list].sort((a, b) => a.start - b.start);
    ordered.forEach((work, index) => {
      const next = ordered[index + 1];
      if (next) links.push([work, next]);
    });
  }
  return links;
}

export function createFlowline(options: FlowlineOptions): Flowline {
  const { colors, start, end } = options;
  const element = document.createElement('section');
  element.className = 'fx3d-flowline';
  element.setAttribute('aria-label', 'Where and when: each phase over time');
  const head = document.createElement('header');
  const title = document.createElement('b');
  title.textContent = 'Where and when';
  const note = document.createElement('span');
  note.textContent = 'Each line is a piece of work in its firm’s color. Dashes follow one firm from job to job. Click a line to go in.';
  head.append(title, note);
  const svg = el('svg', { role: 'presentation' });
  const tip = document.createElement('div');
  tip.className = 'fx3d-rail-tip';
  tip.hidden = true;
  const key = document.createElement('footer');
  for (const [crew, color] of new Map(options.works.filter((work) => work.crew).map((work) => [work.crew, work.color]))) {
    const item = document.createElement('span');
    const dot = document.createElement('i');
    dot.style.background = color;
    item.append(dot, crew);
    key.append(item);
  }
  for (const [color, words] of [[colors.idle, 'Machine booked, no work planned'], [colors.danger, 'Booked twice']] as const) {
    const item = document.createElement('span');
    const dot = document.createElement('i');
    dot.style.background = color;
    dot.style.borderRadius = '2px';
    item.append(dot, words);
    key.append(item);
  }
  element.append(head, svg, tip, key);

  let [width, height] = [800, 400];
  let current = start;
  let line: SVGElement | null = null;
  let badge: SVGElement | null = null;
  const xOf = (at: number): number => LEFT + ((at - start) / (end - start)) * (width - LEFT - RIGHT);

  function draw(): void {
    svg.replaceChildren();
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    const rowHeight = (height - TOP - BOTTOM) / Math.max(1, options.rows.length);
    const yOf = (row: number): number => TOP + row * rowHeight;
    const dayWidth = (width - LEFT - RIGHT) / ((end - start) / DAY_MS);

    // Weeks across, phases down: quiet, there to be read against.
    for (let at = start; at < end; at += DAY_MS) {
      const date = new Date(at);
      if (date.getDay() === 0 || date.getDay() === 6) el('rect', { x: xOf(at), y: TOP, width: dayWidth, height: height - TOP - BOTTOM, fill: colors.weekend }, svg);
      if (date.getDay() === 1) {
        el('line', { x1: xOf(at), x2: xOf(at), y1: TOP - 4, y2: height - BOTTOM, stroke: colors.line }, svg);
        if (dayWidth * 7 >= 54) {
          const label = el('text', { x: xOf(at) + 3, y: TOP - 8, fill: colors.soft, 'font-size': 11 }, svg);
          label.textContent = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        }
      }
    }
    options.rows.forEach((name, row) => {
      el('line', { x1: 0, x2: width - RIGHT, y1: yOf(row), y2: yOf(row), stroke: colors.line }, svg);
      const label = el('text', { x: 4, y: yOf(row) + rowHeight / 2 + 4, fill: colors.ink, 'font-size': 12, 'font-weight': 600 }, svg);
      label.textContent = name.length > 21 ? `${name.slice(0, 20)}…` : name;
    });

    const inset = Math.min(10, rowHeight * 0.14);
    const yStart = (work: FlowWork): number => yOf(work.row) + rowHeight - inset;
    const yEnd = (work: FlowWork): number => yOf(work.row) + inset;

    for (const [from, to] of firmLinks(options.works)) {
      el('line', { x1: xOf(from.end), y1: yEnd(from), x2: xOf(to.start), y2: yStart(to), stroke: from.color, 'stroke-width': 1, 'stroke-dasharray': '2 5', opacity: 0.55 }, svg);
    }

    const labels = labelsFor(options.works, xOf, width - RIGHT);
    for (const work of options.works) {
      const [x1, x2, y1, y2] = [xOf(work.start), Math.max(xOf(work.start) + 2, xOf(work.end)), yStart(work), yEnd(work)];
      const group = el('g', { class: 'fx3d-flow-work' }, svg);
      if (work.idleFrom !== null) el('line', { x1: xOf(work.idleFrom), x2: x1, y1, y2: y1, stroke: colors.idle, 'stroke-width': 4 }, group);
      if (work.idleUntil !== null) el('line', { x1: x2, x2: xOf(work.idleUntil), y1: y2, y2, stroke: colors.idle, 'stroke-width': 4 }, group);
      el('line', { x1, y1, x2, y2, stroke: work.color, 'stroke-width': work.critical ? 4 : 2.5, 'stroke-linecap': 'round' }, group);
      for (const [from, to] of work.clashes) {
        const share = (at: number): number => Math.min(1, Math.max(0, (at - work.start) / (work.end - work.start)));
        el('line', { x1: x1 + (x2 - x1) * share(from), y1: y1 + (y2 - y1) * share(from), x2: x1 + (x2 - x1) * share(to), y2: y1 + (y2 - y1) * share(to), stroke: colors.danger, 'stroke-width': 5, 'stroke-linecap': 'round' }, group);
      }
      // Wider than the line, so it is easy to point at.
      const target = el('line', { x1, y1, x2, y2, stroke: 'transparent', 'stroke-width': 18 }, group);
      target.style.cursor = 'pointer';
      const label = el('text', { x: x2 + 5, y: y2 + 4, fill: colors.ink, 'font-size': 11, 'paint-order': 'stroke', stroke: 'white', 'stroke-width': 3 }, group);
      label.textContent = labels.get(work) ?? work.label;
      target.addEventListener('click', () => options.onOpen(work.key));
      target.addEventListener('pointerenter', () => {
        options.onHover(work.key);
        tip.textContent = `${work.label} · ${work.dates}${work.crew ? ` · ${work.crew}` : ''}`;
        tip.hidden = false;
        tip.style.left = `${Math.min(width - 280, Math.max(0, x1))}px`;
      });
      target.addEventListener('pointerleave', () => {
        options.onHover(null);
        tip.hidden = true;
      });
    }

    line = el('line', { y1: TOP - 6, y2: height - BOTTOM, stroke: colors.ink, 'stroke-width': 2 }, svg);
    badge = el('text', { y: height - BOTTOM + 16, fill: colors.ink, 'font-size': 11, 'font-weight': 640, 'text-anchor': 'middle' }, svg);
    show(current);
  }

  function show(at: number): void {
    current = at;
    const x = xOf(at);
    line?.setAttribute('x1', String(x));
    line?.setAttribute('x2', String(x));
    if (badge) {
      badge.setAttribute('x', String(Math.min(width - 40, Math.max(LEFT + 40, x))));
      badge.textContent = new Date(at).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    }
  }

  const observer = new ResizeObserver(() => {
    const box = svg.parentElement?.getBoundingClientRect();
    if (!box) return;
    const headHeight = head.getBoundingClientRect().height + key.getBoundingClientRect().height + 24;
    const [nextW, nextH] = [Math.round(box.width - 24), Math.round(box.height - headHeight)];
    if (nextW > 0 && nextH > 0 && (nextW !== width || nextH !== height)) {
      [width, height] = [nextW, nextH];
      draw();
    }
  });
  observer.observe(element);
  draw();

  return {
    element,
    show,
    destroy() {
      observer.disconnect();
      element.remove();
    },
  };
}
