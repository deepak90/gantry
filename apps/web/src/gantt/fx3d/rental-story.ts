/**
 * A machine's rental told day by day, as the site view plays it from its first day on rent to its last, and what a
 * change to its dates saved. Every day is the plan's, read the way the calendar on the lot draws it (day-track.ts): a
 * day on rent with no work planned, before or after the work, is idle; a day of cover around the work is cover; a
 * planned day of work is work; a day off inside the work (a weekend) is paid for but not idle, since no new dates take
 * it away. A rental is billed by the calendar day, so what a change saved is the days it took off, at the day rate.
 *
 * Also the go-between for a walkthrough and the site view: the view hands itself in while it is up (`rentalStage`),
 * and the walkthrough moves it in time with what is said on the call.
 *
 * Pure: no three.js, so the reading can be tested on its own.
 */
import type { DayKind, DayTile } from './day-track';

/** A day on rent, with its place among them. */
export interface RentalDay extends DayTile {
  /** 1 for the first day on rent. */
  n: number;
}

/** The days on rent, earliest first; the days around them the calendar shows but the machine isn't on rent are left out. */
export function daysOnRent(tiles: readonly DayTile[]): RentalDay[] {
  return tiles
    .filter((tile) => tile.kind !== 'off')
    .slice()
    .sort((a, b) => a.at - b.at)
    .map((tile, index) => ({ ...tile, n: index + 1 }));
}

/** A rental at a glance: its first and last days and how its days are spent. */
export interface RentalSummary {
  /** Midnight of the first day on rent. */
  first: number;
  /** Midnight of the last day on rent (included). */
  last: number;
  days: number;
  idle: number;
  cover: number;
  work: number;
  /** Days off inside the work (a weekend): paid for, not idle. */
  off: number;
  /** What the idle days come to; 0 for a viewer who may not see money. */
  idleCostMinor: number;
  /** Every day on rent at the day rate; 0 for a viewer who may not see money. */
  costMinor: number;
}

const count = (days: readonly DayTile[], kind: DayKind): number => days.filter((day) => day.kind === kind).length;

export function rentalSummary(tiles: readonly DayTile[], rateMinor: number): RentalSummary | null {
  const days = daysOnRent(tiles);
  if (days.length === 0) return null;
  const idle = days.filter((day) => day.kind === 'idle');
  return {
    first: days[0]!.at,
    last: days[days.length - 1]!.at,
    days: days.length,
    idle: idle.length,
    cover: count(days, 'cover'),
    work: count(days, 'work'),
    off: count(days, 'paid'),
    idleCostMinor: idle.reduce((sum, day) => sum + day.costMinor, 0),
    costMinor: days.length * rateMinor,
  };
}

/** Where a date falls in a rental. */
export interface RentalMoment {
  /** The day on rent the date is in; null before the rental or after it. */
  day: RentalDay | null;
  /** Days on rent in all. */
  of: number;
  /** Idle days gone by on the date, this one included, and in all. */
  idleSoFar: number;
  idle: number;
}

const dayStart = (at: number): number => {
  const date = new Date(at);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
};

export function rentalMoment(days: readonly RentalDay[], at: number): RentalMoment {
  const midnight = dayStart(at);
  const day = days.find((each) => each.at === midnight) ?? null;
  const idle = days.filter((each) => each.kind === 'idle');
  return { day, of: days.length, idleSoFar: idle.filter((each) => each.at <= midnight).length, idle: idle.length };
}

/** What a day on rent is, in a word for its badge and a few for what it means. */
export function momentWords(moment: RentalMoment, machine: string): { badge: string; kind: DayKind; text: string } | null {
  const { day } = moment;
  if (!day) return null;
  const of = `day ${day.n} of ${moment.of} on rent`;
  const name = machine.toLowerCase();
  switch (day.kind) {
    case 'idle':
      return { badge: 'Idle', kind: 'idle', text: `Nothing to lift · ${of}` };
    case 'cover':
      return { badge: 'Cover', kind: 'cover', text: `The ${name} on hand · ${of}` };
    case 'work':
      return { badge: 'Working', kind: 'work', text: `The ${name} lifting · ${of}` };
    case 'paid':
      return { badge: 'Crew off', kind: 'paid', text: `No work planned · ${of}` };
    default:
      return null;
  }
}

/** A change to a rental's dates, as it went in: before and after, and what it saved at the day rate. */
export interface RentalChange {
  before: RentalSummary;
  after: RentalSummary;
  /** Days taken off the rental; negative when it got longer. */
  fewerDays: number;
  /** What it saved; negative when it costs more. 0 for a viewer who may not see money. */
  savedMinor: number;
}

export function rentalChange(before: readonly DayTile[], after: readonly DayTile[], rateMinor: number): RentalChange | null {
  const was = rentalSummary(before, rateMinor);
  const now = rentalSummary(after, rateMinor);
  if (!was || !now) return null;
  if (was.first === now.first && was.last === now.last && was.idle === now.idle && was.cover === now.cover) return null;
  const fewerDays = was.days - now.days;
  return { before: was, after: now, fewerDays, savedMinor: fewerDays * rateMinor };
}

/** The saving as the view shows it ("$3,000 saved"), or what more it costs; null with nothing to say in money. */
export function savedWords(change: RentalChange, money: (minor: number) => string): string | null {
  if (change.savedMinor > 0) return `${money(change.savedMinor)} saved`;
  if (change.savedMinor < 0) return `${money(-change.savedMinor)} more`;
  return null;
}

/** What the rental's days come to, in a few words: "7 idle days · $4,200", "2 days of cover, no idle days". */
export function spendWords(summary: RentalSummary, money: ((minor: number) => string) | null): string {
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  if (summary.idle > 0) return `${plural(summary.idle, 'idle day')}${money && summary.idleCostMinor > 0 ? ` · ${money(summary.idleCostMinor)}` : ''}`;
  if (summary.cover > 0) return `${plural(summary.cover, 'day', 'days')} of cover, no idle days`;
  return 'On rent only for its work';
}

// ---------------------------------------------------------------------------------------------------------------------
// The walkthrough's way in: the site view hands itself in while it is up
// ---------------------------------------------------------------------------------------------------------------------

/** The crane's rental as the site view has it now. */
export interface RentalFacts {
  machine: string;
  taskId: number;
  summary: RentalSummary;
  /** The day rate; 0 for a viewer who may not see money. */
  rateMinor: number;
}

/** What the film's walkthrough asks of the site view, each in time with what is said on the call. */
export interface RentalStage {
  /** The crane's rental now; null while the view is on its way in or has no crane on rent. */
  facts(): RentalFacts | null;
  /** The site from its lot, the crane and its calendar in view, played from the first day on rent to the last. */
  play(): void;
  /** Whether the play has reached the last day on rent. */
  played(): boolean;
  /** Its days on rent stand out: Remy says its dates. */
  span(): void;
  /** In on its idle days, each marked IDLE: Remy says them. Resolves once the camera is there. */
  idle(): Promise<void>;
  /** Out from the idle days with a dolly zoom, then a slow drone circle of the site while the rental changes. */
  pullBack(): void;
  /**
   * Instead of `pullBack`: close on the whole calendar and no further out, its idle days marked, and there while the new
   * dates are asked for. They fold the idle days away on it, and what they saved comes up large right under it.
   */
  holdOnCalendar(): void;
  /** The last change to the crane's dates since the view opened, once it is on screen; null until then. */
  changed(): RentalChange | null;
}

let current: RentalStage | null = null;

export const rentalStage = {
  /** The site view while it is up with a crane on rent; null otherwise. */
  get(): RentalStage | null {
    return current;
  },
  /** The view hands itself in (or out, with null). */
  set(stage: RentalStage | null): void {
    current = stage;
  },
};
