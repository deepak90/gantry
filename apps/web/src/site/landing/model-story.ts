/**
 * The story the landing page's model plays, as numbers: what date is on show at each moment, when the payment lands,
 * how the camera and the machines move, and the schedule strip under the model. Pure: no DOM and no three.js, so the
 * hero's timing can be tested on its own and read without the model.
 *
 * The story, in seconds from when the hero comes on screen:
 *   0     Harbor as it stands at the end of Tue, Nov 10: the footings done, the slab held until they are paid.
 *   2     Paid with PayPal: the chip lands by the footings and the hold lifts away.
 *   2.5   The date runs: the slab pours (dark while wet, pale once cured), the crane comes, the steel and its decks go up
 *         story by story, the concrete decks are poured, the roof goes on and the glass goes up.
 *   8     The date stops, on the building well advanced; the camera settles, and the hero holds still.
 */
import { builtBy, type PlanTask } from '../../gantt/fx3d/building-plan';

/** The story's beats, in seconds. */
export const BEATS = {
  /** The payment lands: the chip by the footings, the strip's Paid pill, the hold starting to lift. */
  pay: 2,
  /** The hold tag is gone. */
  lifted: 2.6,
  /** The date starts to run, and stops. */
  run: 2.5,
  ran: 8,
  /** The camera has settled: nothing moves after this, and the loop stops. */
  end: 9,
} as const;

/** The day the story opens on, as the hosted copies open on it: the footings done, the slab held. */
export const OPENING_DAY = '2026-11-10';

/**
 * The date on show, in days after the end of the opening day, at moments of the run: the slab's pour day taken slowly
 * enough to see the concrete spread, the steel slowly enough to see the crane lift, and the rest at a timelapse's pace.
 * Days are counted from midnight after Tue, Nov 10 (Wed, Nov 11 is 0).
 */
export const RUN_KEYS: readonly (readonly [seconds: number, days: number])[] = [
  [BEATS.run, 0],
  // The base, the rebar and the inspection; the pour on Fri, Nov 20.
  [3.2, 9],
  [3.85, 10],
  // The cure, to Wed, Dec 2, when the steel starts.
  [4.55, 21],
  // The steel and its metal deck, story by story, to Thu, Dec 17.
  [6.25, 36],
  // The concrete decks, the roof and the curtain wall, to the end of Mon, Feb 8.
  [BEATS.ran, 90],
];

/** The last date on show: the end of the run. */
export const CLOSING_DAYS = RUN_KEYS[RUN_KEYS.length - 1]![1];

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const smooth = (t: number) => t * t * (3 - 2 * t);

/**
 * A monotone cubic through points (Fritsch and Carlson), starting and ending at rest: the date never runs backward and
 * changes pace without a jolt.
 */
export function monotone(points: readonly (readonly [number, number])[]): (x: number) => number {
  const n = points.length;
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const secants = xs.slice(1).map((x, index) => (ys[index + 1]! - ys[index]!) / (x - xs[index]!));
  const tangents = xs.map((_, index) => {
    if (index === 0 || index === n - 1) return 0;
    const [before, after] = [secants[index - 1]!, secants[index]!];
    return before * after <= 0 ? 0 : (2 * before * after) / (before + after);
  });
  return (x) => {
    if (x <= xs[0]!) return ys[0]!;
    if (x >= xs[n - 1]!) return ys[n - 1]!;
    let index = 0;
    while (x > xs[index + 1]!) index += 1;
    const h = xs[index + 1]! - xs[index]!;
    const s = (x - xs[index]!) / h;
    const [s2, s3] = [s * s, s * s * s];
    return (2 * s3 - 3 * s2 + 1) * ys[index]! + (s3 - 2 * s2 + s) * h * tangents[index]! + (-2 * s3 + 3 * s2) * ys[index + 1]! + (s3 - s2) * h * tangents[index + 1]!;
  };
}

const runDays = monotone(RUN_KEYS);

/** Days after the end of the opening day, at a moment of the story. */
export const daysAt = (seconds: number): number => runDays(seconds);

/** How fast the date runs at a moment, in days a second. */
export function paceAt(seconds: number): number {
  const step = 1 / 120;
  return (daysAt(seconds + step) - daysAt(seconds - step)) / (2 * step);
}

/** Local midnight of a calendar day ('YYYY-MM-DD'), plus whole days. */
export function dayStart(day: string, plus = 0): number {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(year ?? 1970, (month ?? 1) - 1, (date ?? 1) + plus).getTime();
}

/** The date on show at a moment of the story (epoch ms, local): a day's length is the calendar's, across a clock change too. */
export function storyDate(seconds: number): number {
  const days = daysAt(seconds);
  const whole = Math.floor(days);
  const from = dayStart(OPENING_DAY, 1 + whole);
  const to = dayStart(OPENING_DAY, 2 + whole);
  return from + (to - from) * (days - whole);
}

/** How far the payment has landed, 0 to 1, and how far the hold has lifted away. */
export function payBeat(seconds: number): { paid: boolean; landed: number; lifted: number } {
  return {
    paid: seconds >= BEATS.pay,
    landed: smooth(clamp01((seconds - BEATS.pay) / 0.35)),
    lifted: smooth(clamp01((seconds - BEATS.pay) / (BEATS.lifted - BEATS.pay))),
  };
}

/** The camera's slow orbit, 0 to 1, from the first moment to the settle: easing in and out, never stopping between. */
export const orbitAt = (seconds: number): number => smooth(clamp01(seconds / BEATS.end));

/**
 * The machines' own clock (the crane's lifts, the pump's boom): real seconds while the date stands, four times as fast
 * while it runs, so the crane is seen at work in a timelapse. Rising to speed and back over half a second each way.
 */
export function machineClock(seconds: number): number {
  const ramp = 0.5;
  const extra = 3;
  // How long a step from 0 to 1, rising evenly over [from, from + ramp], has been on by t: its integral.
  const on = (t: number, from: number) => {
    const u = Math.min(Math.max(t - from, 0), ramp);
    return (u * u) / (2 * ramp) + Math.max(0, t - from - ramp);
  };
  return seconds + extra * (on(seconds, BEATS.run) - on(seconds, BEATS.ran - ramp));
}

// -----------------------------------------------------------------------------------------
// The schedule strip
// -----------------------------------------------------------------------------------------

export interface StripRow {
  key: 'footings' | 'slab' | 'steel' | 'decks' | 'envelope' | 'fitout' | 'handover';
  label: string;
  /** Epoch ms; the end exclusive. A milestone's end is its start. */
  start: number;
  end: number;
  milestone: boolean;
  /** The plan's rows behind it, for how far it has come. */
  tasks: readonly PlanTask[];
}

const under = (tasks: readonly PlanTask[], test: (task: PlanTask) => boolean) => tasks.filter(test);

/**
 * The strip's rows, read from the plan by its groups: the footings, the slab, the steel, the concrete decks, the
 * envelope, the floors' fit-out and the handover.
 */
export function stripRows(tasks: readonly PlanTask[]): StripRow[] {
  const groups: [StripRow['key'], string, PlanTask[]][] = [
    ['footings', 'Footings', under(tasks, (task) => task.path.includes('Footings') && !task.milestone)],
    ['slab', 'Slab on grade', under(tasks, (task) => task.path.includes('Slab on grade'))],
    ['steel', 'Steel', under(tasks, (task) => /\bsteel\b/i.test(task.name))],
    ['decks', 'Decks', under(tasks, (task) => task.path.some((name) => /^Concrete deck/.test(name)))],
    ['envelope', 'Envelope', under(tasks, (task) => task.path.includes('Envelope'))],
    ['fitout', 'Fit-out', under(tasks, (task) => task.path.some((name) => /build-out$/.test(name)))],
    ['handover', 'Handover', under(tasks, (task) => task.milestone && /hand ?over/i.test(task.name))],
  ];
  return groups.map(([key, label, rows]) => {
    if (rows.length === 0) throw new Error(`model-story: the plan has no ${label}`);
    const start = Math.min(...rows.map((task) => task.start));
    const end = Math.max(...rows.map((task) => task.end));
    return { key, label, start, end, milestone: key === 'handover', tasks: rows };
  });
}

/** How far a strip row has come on a date, 0 to 1: its working days done, as the model builds them. */
export function rowProgress(row: StripRow, date: number): number {
  if (row.milestone) return date >= row.start ? 1 : 0;
  let days = 0;
  let done = 0;
  for (const task of row.tasks) {
    const weight = Math.max(1, task.workDays.length);
    days += weight;
    done += weight * builtBy(task, date);
  }
  return days === 0 ? 0 : done / days;
}

/** The strip's span: from the first of the month the footings start in to the first of the month after the handover. */
export function stripSpan(rows: readonly StripRow[]): { from: number; to: number } {
  const first = new Date(Math.min(...rows.map((row) => row.start)));
  const last = new Date(Math.max(...rows.map((row) => row.end)));
  return { from: new Date(first.getFullYear(), first.getMonth(), 1).getTime(), to: new Date(last.getFullYear(), last.getMonth() + 1, 1).getTime() };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** The first of each month in a span, with its short name; January carries its year, as the chart's axis does. */
export function monthTicks(from: number, to: number): { at: number; label: string }[] {
  const ticks: { at: number; label: string }[] = [];
  const first = new Date(from);
  for (let month = new Date(first.getFullYear(), first.getMonth(), 1); month.getTime() < to; month = new Date(month.getFullYear(), month.getMonth() + 1, 1)) {
    const name = MONTHS[month.getMonth()]!;
    ticks.push({ at: month.getTime(), label: month.getMonth() === 0 ? `${name} ’${String(month.getFullYear()).slice(2)}` : name });
  }
  return ticks;
}

/**
 * The day a date belongs to, as the strip names it: 'Tue, Nov 10'. A date at midnight is the end of the day before,
 * since the model shows each day's work once it is done.
 */
export function dayName(date: number): string {
  const day = new Date(date - 1);
  return `${WEEKDAYS[day.getDay()]}, ${MONTHS[day.getMonth()]} ${day.getDate()}`;
}

/** Where a date falls along the strip, 0 to 1. */
export const along = (date: number, span: { from: number; to: number }): number => clamp01((date - span.from) / (span.to - span.from));
