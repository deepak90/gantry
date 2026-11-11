/**
 * The dot plot of the odds, like a bean machine: every engine run drops one dot into the column of its handover
 * day as the run finishes, teal on or before the contract date and amber after it. When the same runs are asked
 * again (PayPal paid, a step applied, a way forward shown), each dot is the same roll of the dice scheduled again,
 * and slides from its old day to its new one. Days the handover can't fall on (weekends, holidays) are shaded, so
 * the gaps between the stacks say why.
 *
 * Drawn on a canvas (a thousand dots stay smooth at 60 frames a second); the text a reader needs is also in the
 * panel and its table, and the hover readout is plain HTML, so nothing depends on reading the canvas.
 */

const DAY_MS = 86_400_000;
const dateOfDay = (day: number) => {
  const utc = new Date(day * DAY_MS);
  return new Date(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate());
};
/** 0 is Sunday. */
const weekdayOf = (day: number) => (((day + 4) % 7) + 7) % 7;
const MONTH_DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });

export interface PlotPass {
  /** Start from an empty plot (dots fall), or keep the dots and move each as its run comes back. */
  fresh: boolean;
  total: number;
  contractDay: number;
  /** Where the plan alone (no dice) puts the handover: the axis starts around it. */
  plannedDay: number | null;
  /** Days the handover can't fall on, around the dates on show. */
  nonWorking: (day: number) => boolean;
}

export interface PlotHover {
  day: number;
  count: number;
  /** Runs handed over by the end of that day. */
  byThen: number;
  total: number;
  /** Where the column's middle is, in CSS pixels from the plot's left edge. */
  x: number;
}

interface Dot {
  run: number;
  day: number;
  x: number;
  y: number;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  start: number;
  duration: number;
  ease: (t: number) => number;
}

interface Layout {
  left: number;
  width: number;
  top: number;
  bottom: number;
  column: number;
  perRow: number;
  size: number;
  pitchX: number;
  pitchY: number;
}

interface Colors {
  onTime: string;
  late: string;
  ink: string;
  soft: string;
  faint: string;
  line: string;
  shade: string;
  font: string;
}

const easeIn = (t: number) => t * t;
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const easeOut = (t: number) => 1 - (1 - t) ** 3;

/** Space around the dots for the axis and its labels (CSS pixels). */
const PAD = { top: 26, bottom: 46, side: 6 };

export class DotPlot {
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly dots = new Map<number, Dot>();
  private readonly columns = new Map<number, number[]>();
  private axis = { start: 0, end: 34 };
  /** This pass started from an empty plot: its axis is fitted to it once it is over. */
  private fresh = false;
  private layout: Layout | null = null;
  private capacity = 0;
  private expected = 0;
  private contractDay = 0;
  private nonWorking: (day: number) => boolean = (day) => weekdayOf(day) === 0 || weekdayOf(day) === 6;
  private total = 0;
  private colors: Colors | null = null;
  private frame = 0;
  private width = 0;
  private height = 0;
  private hovered: number | null = null;
  private readonly reduced: boolean;
  private readonly resize: ResizeObserver;
  private disposed = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly onHover: (hover: PlotHover | null) => void,
  ) {
    // No 2D canvas (an old browser, a test page): the counts, the readout and the table still work.
    this.ctx = canvas.getContext?.('2d') ?? null;
    this.reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.resize = new ResizeObserver(() => this.measure());
    this.resize.observe(canvas);
    canvas.addEventListener('pointermove', this.onPointer);
    canvas.addEventListener('pointerleave', this.onLeave);
    canvas.addEventListener('keydown', this.onKey);
    canvas.addEventListener('blur', this.onLeave);
    this.measure();
  }

  // -------------------------------------------------------------------------------------------
  // What the controller tells it
  // -------------------------------------------------------------------------------------------

  begin(pass: PlotPass): void {
    this.contractDay = pass.contractDay;
    this.nonWorking = pass.nonWorking;
    this.total = pass.total;
    if (pass.fresh || this.dots.size === 0) {
      this.dots.clear();
      this.columns.clear();
      const anchor = pass.plannedDay ?? pass.contractDay;
      this.setAxis(this.niceAxis(Math.min(anchor, pass.contractDay) - 3, Math.max(anchor, pass.contractDay) + 24), false);
      this.fresh = true;
      // About one run in eight lands on the busiest day: room for that from the start, so the stacks rarely rescale.
      this.expected = Math.ceil(pass.total * 0.13);
      this.capacity = 0;
    }
    this.relayout(false);
    this.kick();
  }

  /** Runs that just finished: each dot falls in, or slides from where its run was before. */
  land(landed: readonly { run: number; day: number }[]): void {
    const now = performance.now();
    let widen = false;
    for (const { day } of landed) if (day < this.axis.start + 1 || day > this.axis.end - 1) widen = true;
    if (widen) {
      const days = [...this.columns.keys(), ...landed.map((item) => item.day), this.contractDay];
      this.setAxis(this.niceAxis(Math.min(...days, this.axis.start) - 2, Math.max(...days, this.axis.end) + 2), true);
    }
    for (const [index, { run, day }] of landed.entries()) {
      const dot = this.dots.get(run);
      if (dot && dot.day === day) continue;
      if (dot) this.leave(dot);
      const stack = this.columns.get(day) ?? [];
      stack.push(run);
      this.columns.set(day, stack);
      if (stack.length > this.capacity) this.relayout(true);
      const target = this.slot(day, stack.length - 1);
      const delay = index * 9;
      if (dot) {
        dot.day = day;
        this.tween(dot, target, now + delay, 620, easeInOut);
      } else {
        const fresh: Dot = { run, day, x: target.x, y: -6, fromX: target.x, fromY: -6, toX: target.x, toY: target.y, start: 0, duration: 0, ease: easeIn };
        this.dots.set(run, fresh);
        this.tween(fresh, target, now + delay, 280 + 260 * (target.y / Math.max(1, this.height)), easeIn);
      }
    }
    this.kick();
  }

  /** The pass is over: dots whose runs did not come back this time are taken away; a new answer gets an axis that fits it. */
  end(runs: readonly number[]): void {
    const kept = new Set(runs);
    for (const dot of [...this.dots.values()]) {
      if (kept.has(dot.run)) continue;
      this.leave(dot);
      this.dots.delete(dot.run);
    }
    if (this.fresh) {
      this.fresh = false;
      const days = [...this.columns.entries()].filter(([, stack]) => stack.length > 0).map(([day]) => day);
      if (days.length > 0) {
        this.expected = 0;
        this.setAxis(this.niceAxis(Math.min(...days, this.contractDay) - 3, Math.max(...days, this.contractDay) + 3), true);
      }
    }
    this.kick();
  }

  /**
   * Puts every dot on the day given for its run at once: a way forward on show, or back to now. Dots that move
   * slide there; with `instant`, an answer already made is simply shown (nothing falls, since nothing is running).
   */
  show(runs: ArrayLike<number>, days: ArrayLike<number>, instant = false): void {
    const landed: { run: number; day: number }[] = [];
    for (let i = 0; i < runs.length; i += 1) landed.push({ run: runs[i]!, day: days[i]! });
    const now = performance.now();
    // Every column is rebuilt in run order, so a stack reads the same way each time it is shown.
    this.columns.clear();
    landed.sort((a, b) => a.run - b.run);
    const all = landed.map((item) => item.day).concat(this.contractDay);
    const lo = Math.min(...all);
    const hi = Math.max(...all);
    if (lo < this.axis.start + 1 || hi > this.axis.end - 1) this.setAxis(this.niceAxis(Math.min(lo, this.axis.start) - 2, Math.max(hi, this.axis.end) + 2), true);
    for (const { run, day } of landed) {
      const stack = this.columns.get(day) ?? [];
      stack.push(run);
      this.columns.set(day, stack);
    }
    this.capacity = 0;
    this.relayout(false);
    for (const { run, day } of landed) {
      const stack = this.columns.get(day)!;
      const target = this.slot(day, stack.indexOf(run));
      const dot = this.dots.get(run);
      if (dot) {
        dot.day = day;
        this.tween(dot, target, now + (run % 97) * 2.5, instant ? 0 : 700, easeInOut);
      } else {
        const fresh: Dot = { run, day, x: target.x, y: target.y, fromX: target.x, fromY: target.y, toX: target.x, toY: target.y, start: 0, duration: 0, ease: easeIn };
        this.dots.set(run, fresh);
        if (!instant) {
          fresh.y = fresh.fromY = -6;
          this.tween(fresh, target, now + (run % 97) * 2.5, 520, easeIn);
        }
      }
    }
    const shown = new Set(landed.map((item) => item.run));
    for (const run of [...this.dots.keys()]) if (!shown.has(run)) this.dots.delete(run);
    this.kick();
  }

  /** The days on show, for the readout and the table. */
  counts(): { day: number; count: number }[] {
    return [...this.columns.entries()].map(([day, stack]) => ({ day, count: stack.length })).filter((entry) => entry.count > 0).sort((a, b) => a.day - b.day);
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.resize.disconnect();
    this.canvas.removeEventListener('pointermove', this.onPointer);
    this.canvas.removeEventListener('pointerleave', this.onLeave);
    this.canvas.removeEventListener('keydown', this.onKey);
    this.canvas.removeEventListener('blur', this.onLeave);
  }

  // -------------------------------------------------------------------------------------------
  // Layout
  // -------------------------------------------------------------------------------------------

  /** The days from `from` to `to`, three weeks at least. */
  private niceAxis(from: number, to: number): { start: number; end: number } {
    return { start: from, end: Math.max(to, from + 20) };
  }

  private setAxis(axis: { start: number; end: number }, animate: boolean): void {
    if (axis.start === this.axis.start && axis.end === this.axis.end) return;
    this.axis = axis;
    this.relayout(animate);
  }

  private measure(): void {
    const box = this.canvas.getBoundingClientRect();
    const ratio = Math.min(3, globalThis.devicePixelRatio || 1);
    this.width = Math.max(120, box.width);
    this.height = Math.max(120, box.height);
    this.canvas.width = Math.round(this.width * ratio);
    this.canvas.height = Math.round(this.height * ratio);
    this.ctx?.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.colors = null;
    this.relayout(false, true);
    this.kick();
  }

  /**
   * Dot size and stacking for the days on show and the tallest stack expected: the biggest dots that stack without
   * overlapping, a few side by side in a column when the columns are wide enough.
   */
  private relayout(animate: boolean, force = false): void {
    const days = this.axis.end - this.axis.start + 1;
    const width = this.width - PAD.side * 2;
    const column = width / days;
    const top = PAD.top;
    const bottom = this.height - PAD.bottom;
    const tallest = Math.max(1, this.expected, ...[...this.columns.values()].map((stack) => stack.length));
    const room = bottom - top;
    let best: Layout | null = null;
    let bestScore = -Infinity;
    for (let perRow = 1; perRow <= 4; perRow += 1) {
      const pitchX = column / perRow;
      const rows = Math.ceil(tallest / perRow);
      const pitchY = Math.min(pitchX, room / rows);
      // Dots a pixel apart across, and pressed together by a tenth at most up a tall stack.
      const size = Math.min(7, Math.max(2, Math.min(pitchX - 1, pitchY * 1.12)));
      if (size > bestScore) {
        bestScore = size;
        best = { left: PAD.side, width, top, bottom, column, perRow, size, pitchX, pitchY };
      }
    }
    const before = this.layout;
    this.layout = best;
    this.capacity = best ? Math.floor((room / best.pitchY) * best.perRow) : 0;
    if (!before || force || animate || before.column !== best!.column || before.pitchY !== best!.pitchY || before.perRow !== best!.perRow) {
      const now = performance.now();
      for (const [day, stack] of this.columns) {
        stack.forEach((run, index) => {
          const dot = this.dots.get(run);
          if (!dot) return;
          const target = this.slot(day, index);
          if (animate && !force) this.tween(dot, target, now, 380, easeInOut);
          else this.retarget(dot, target);
        });
      }
    }
  }

  private slot(day: number, index: number): { x: number; y: number } {
    const layout = this.layout!;
    const row = Math.floor(index / layout.perRow);
    const across = index % layout.perRow;
    const columnLeft = layout.left + (day - this.axis.start) * layout.column;
    return {
      x: columnLeft + across * layout.pitchX + layout.pitchX / 2,
      y: layout.bottom - row * layout.pitchY - layout.pitchY / 2,
    };
  }

  /** A dot leaves its column: the dots above it settle down a place. */
  private leave(dot: Dot): void {
    const stack = this.columns.get(dot.day);
    if (!stack) return;
    const at = stack.indexOf(dot.run);
    if (at < 0) return;
    stack.splice(at, 1);
    const now = performance.now();
    for (let index = at; index < stack.length; index += 1) {
      const above = this.dots.get(stack[index]!);
      if (above) this.tween(above, this.slot(dot.day, index), now + 60, 240, easeOut);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Motion
  // -------------------------------------------------------------------------------------------

  private tween(dot: Dot, to: { x: number; y: number }, start: number, duration: number, ease: (t: number) => number): void {
    dot.fromX = dot.x;
    dot.fromY = dot.y;
    dot.toX = to.x;
    dot.toY = to.y;
    dot.start = start;
    dot.duration = this.reduced ? 0 : duration;
    dot.ease = ease;
  }

  private retarget(dot: Dot, to: { x: number; y: number }): void {
    const moving = performance.now() < dot.start + dot.duration;
    dot.toX = to.x;
    dot.toY = to.y;
    if (!moving) {
      dot.x = dot.fromX = to.x;
      dot.y = dot.fromY = to.y;
    }
  }

  private kick(): void {
    if (this.disposed || this.frame) return;
    this.frame = requestAnimationFrame(this.tick);
  }

  private readonly tick = (time: number): void => {
    this.frame = 0;
    let moving = false;
    for (const dot of this.dots.values()) {
      if (time < dot.start) {
        moving = true;
        continue;
      }
      const t = dot.duration > 0 ? Math.min(1, (time - dot.start) / dot.duration) : 1;
      const k = dot.ease(t);
      dot.x = dot.fromX + (dot.toX - dot.fromX) * k;
      dot.y = dot.fromY + (dot.toY - dot.fromY) * k;
      if (t < 1) moving = true;
    }
    this.draw();
    if (moving) this.kick();
  };

  // -------------------------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------------------------

  private readColors(): Colors {
    if (this.colors) return this.colors;
    const style = getComputedStyle(this.canvas);
    const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
    this.colors = {
      onTime: read('--odds-on-time', '#008e82'),
      late: read('--odds-late', '#cf7c00'),
      ink: read('--ink', '#121921'),
      soft: read('--ink-soft', '#4b5563'),
      faint: read('--ink-faint', '#636d79'),
      line: read('--line-strong', '#cfd5dd'),
      shade: read('--surface-sunken', '#f6f7f9'),
      font: style.fontFamily || 'system-ui, sans-serif',
    };
    return this.colors;
  }

  private draw(): void {
    const layout = this.layout;
    const ctx = this.ctx;
    if (!layout || !ctx) return;
    const colors = this.readColors();
    ctx.clearRect(0, 0, this.width, this.height);
    const xOf = (day: number) => layout.left + (day - this.axis.start) * layout.column;

    // Days the keys can't change hands: shaded.
    ctx.fillStyle = colors.shade;
    for (let day = this.axis.start; day <= this.axis.end; day += 1) {
      if (this.nonWorking(day)) ctx.fillRect(xOf(day), layout.top - 6, layout.column, layout.bottom - layout.top + 6);
    }

    // The hovered day.
    if (this.hovered !== null) {
      ctx.fillStyle = colors.line;
      ctx.globalAlpha = 0.35;
      ctx.fillRect(xOf(this.hovered), layout.top - 6, layout.column, layout.bottom - layout.top + 6);
      ctx.globalAlpha = 1;
    }

    // The dots, colored by which side of the contract date they are on now.
    const boundary = xOf(this.contractDay + 1);
    const radius = layout.size / 2;
    for (const [color, onTime] of [
      [colors.onTime, true],
      [colors.late, false],
    ] as const) {
      ctx.fillStyle = color;
      ctx.beginPath();
      for (const dot of this.dots.values()) {
        if (dot.x < boundary !== onTime) continue;
        ctx.moveTo(dot.x + radius, dot.y);
        ctx.arc(dot.x, dot.y, radius, 0, Math.PI * 2);
      }
      ctx.fill();
    }

    // The axis: a hairline, a tick each Monday with its date, a short tick each day.
    ctx.fillStyle = colors.line;
    ctx.fillRect(layout.left, layout.bottom, layout.width, 1);
    ctx.font = `500 11px ${colors.font}`;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'center';
    const labelEvery = layout.column * 7 < 44 ? 14 : 7;
    for (let day = this.axis.start; day <= this.axis.end + 1; day += 1) {
      const x = Math.round(xOf(day)) + 0.5;
      const monday = weekdayOf(day) === 1;
      ctx.fillStyle = colors.line;
      ctx.fillRect(x - 0.5, layout.bottom, 1, monday ? 5 : 2);
      if (monday && (day - this.axis.start) % labelEvery === 0 && day <= this.axis.end) {
        ctx.fillStyle = colors.faint;
        ctx.fillText(MONTH_DAY.format(dateOfDay(day)), Math.min(Math.max(x, layout.left + 16), layout.left + layout.width - 16), layout.bottom + 7);
      }
    }

    // The contract date: a line at the end of its day, named at the top.
    const lineX = Math.round(boundary) + 0.5;
    ctx.fillStyle = colors.ink;
    ctx.fillRect(lineX - 0.5, layout.top - 14, 1, layout.bottom - layout.top + 14);
    ctx.font = `600 11px ${colors.font}`;
    ctx.textBaseline = 'alphabetic';
    const label = `Contract ${MONTH_DAY.format(dateOfDay(this.contractDay))}`;
    const labelWidth = ctx.measureText(label).width;
    const rightRoom = layout.left + layout.width - lineX;
    ctx.textAlign = rightRoom > labelWidth + 8 ? 'left' : 'right';
    ctx.fillText(label, ctx.textAlign === 'left' ? lineX + 5 : lineX - 5, layout.top - 6);

    // P50 and P80 of the runs on show, under the axis.
    const marks = this.percentiles();
    if (marks) {
      ctx.font = `600 11px ${colors.font}`;
      ctx.textBaseline = 'alphabetic';
      const placed: { left: number; right: number }[] = [];
      for (const [name, day] of [
        ['P50', marks.p50],
        ['P80', marks.p80],
      ] as const) {
        const x = xOf(day) + layout.column / 2;
        const y = layout.bottom + 24;
        ctx.fillStyle = colors.ink;
        ctx.beginPath();
        ctx.moveTo(x, y - 6);
        ctx.lineTo(x + 4, y);
        ctx.lineTo(x - 4, y);
        ctx.closePath();
        ctx.fill();
        const text = `${name} ${MONTH_DAY.format(dateOfDay(day))}`;
        const textWidth = ctx.measureText(text).width;
        let left = Math.min(Math.max(x - textWidth / 2, layout.left), layout.left + layout.width - textWidth);
        // Side by side when they would touch.
        const clash = placed.find((other) => left < other.right + 6 && left + textWidth > other.left - 6);
        if (clash) left = clash.right + 8;
        placed.push({ left, right: left + textWidth });
        ctx.fillStyle = colors.soft;
        ctx.textAlign = 'left';
        ctx.fillText(text, left, y + 14);
      }
    }
  }

  /** P50 and P80 of the dots on show (nearest rank, as the results are read). */
  private percentiles(): { p50: number; p80: number } | null {
    const counts = this.counts();
    const total = counts.reduce((sum, entry) => sum + entry.count, 0);
    if (total < 20) return null;
    const at = (q: number) => {
      const rank = Math.ceil(q * total - 1e-9);
      let seen = 0;
      for (const entry of counts) {
        seen += entry.count;
        if (seen >= rank) return entry.day;
      }
      return counts.at(-1)!.day;
    };
    return { p50: at(0.5), p80: at(0.8) };
  }

  // -------------------------------------------------------------------------------------------
  // Reading it
  // -------------------------------------------------------------------------------------------

  private hoverDay(day: number | null): void {
    const layout = this.layout;
    if (day === null || !layout) {
      if (this.hovered !== null) {
        this.hovered = null;
        this.onHover(null);
        this.kick();
      }
      return;
    }
    const clamped = Math.min(this.axis.end, Math.max(this.axis.start, day));
    this.hovered = clamped;
    const counts = this.counts();
    const total = counts.reduce((sum, entry) => sum + entry.count, 0);
    const count = this.columns.get(clamped)?.length ?? 0;
    const byThen = counts.filter((entry) => entry.day <= clamped).reduce((sum, entry) => sum + entry.count, 0);
    this.onHover({ day: clamped, count, byThen, total, x: layout.left + (clamped - this.axis.start + 0.5) * layout.column });
    this.kick();
  }

  private readonly onPointer = (event: PointerEvent): void => {
    const layout = this.layout;
    if (!layout) return;
    const box = this.canvas.getBoundingClientRect();
    const x = event.clientX - box.left;
    this.hoverDay(this.axis.start + Math.floor((x - layout.left) / layout.column));
  };

  private readonly onLeave = (): void => this.hoverDay(null);

  private readonly onKey = (event: KeyboardEvent): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const start = this.hovered ?? this.counts()[0]?.day ?? this.contractDay;
    this.hoverDay(start + (event.key === 'ArrowLeft' ? -1 : 1));
  };
}
