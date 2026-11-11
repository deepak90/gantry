/**
 * What a rental comes to, and what it could be. A machine is paid for by the calendar day, weekends and holidays
 * included, from its first day on rent to its last: its working calendar says when it can work, not what it costs.
 *
 * Idle is the days on rent on either side of the work. A weekend inside the work is paid too, but it is not idle: no
 * new rental dates take it away, so flagging it would raise an alert that nothing can clear.
 *
 * Nobody books a machine for exactly the days of the work: a late delivery or a slow finish would leave the crew
 * without it. So up to two working days either side is a buffer, not a problem, and only more than that gets flagged.
 *
 * Dates are `YYYY-MM-DD`, ends exclusive. No imports: the seed loads this through Node's type stripping.
 */

const MS_PER_DAY = 86_400_000;

const dayNumber = (date: string): number => Date.parse(`${date}T00:00:00Z`) / MS_PER_DAY;
const shifted = (date: string, days: number): string => new Date((dayNumber(date) + days) * MS_PER_DAY).toISOString().slice(0, 10);

export interface RentalSpan {
  start: string;
  /** Exclusive. */
  end: string;
}

/** Whether the machine can work on a day, on its own calendar. */
export type IsWorkingDay = (day: string) => boolean;

/** The days paid for in [start, end); 0 for an empty or inverted interval. */
export function rentalDays(start: string, end: string): number {
  return end > start ? dayNumber(end) - dayNumber(start) : 0;
}

/** Days on rent with no work planned, on each side of the work. A rental that misses the work altogether is idle all through. */
export function idleRentalDays(rental: RentalSpan, work: RentalSpan): { before: number; after: number } {
  const stop = work.start < rental.end ? work.start : rental.end;
  const resume = work.end > rental.start ? work.end : rental.start;
  return { before: rentalDays(rental.start, stop), after: rentalDays(resume, rental.end) };
}

/**
 * A rental around the work: on rent `before` working days ahead of its first day and `after` working days past its last.
 * Counted on the machine's calendar, so the day before a Monday start is the Friday, and the weekend comes with it.
 */
export function paddedRental(work: RentalSpan, pad: { before: number; after: number }, isWorkingDay: IsWorkingDay): RentalSpan {
  let start = work.start;
  for (let left = pad.before, guard = 0; left > 0 && guard < 400; guard++) {
    start = shifted(start, -1);
    if (isWorkingDay(start)) left -= 1;
  }
  let end = work.end;
  for (let left = pad.after, guard = 0; left > 0 && guard < 400; guard++) {
    if (isWorkingDay(end)) left -= 1;
    end = shifted(end, 1);
  }
  return { start, end };
}

/** Working days of cover either side of the work that are not worth raising. */
const BUFFER_WORKING_DAYS = 2;

/** No more than the buffer's working days of cover on either side of the work: a sensible rental, whatever days of the week that comes to. */
export function withinBuffer(rental: RentalSpan, work: RentalSpan, isWorkingDay: IsWorkingDay): boolean {
  const room = paddedRental(work, { before: BUFFER_WORKING_DAYS, after: BUFFER_WORKING_DAYS }, isWorkingDay);
  return rental.start >= room.start && rental.end <= room.end;
}

export type RentalOptionKey = 'either_side' | 'before_only' | 'after_only' | 'just_the_work' | 'as_asked';

export interface RentalOption extends RentalSpan {
  key: RentalOptionKey;
  /** In a few words, for a button or a card. */
  label: string;
  days: number;
  costMinor: number;
  /** Against the rental as it stands now; negative when this one is longer. */
  savingMinor: number;
  idle: { before: number; after: number };
  /** Days paid only because the cover runs over a weekend or a shutdown. */
  offDaysInCover: number;
}

export interface RentalChoice {
  /** The one to do, with reasons of cost and risk behind it; null when no shorter rental still covers the work. */
  recommended: RentalOption | null;
  /** The others worth weighing, cheapest first. */
  alternatives: RentalOption[];
}

export interface RentalChoiceInput {
  rental: RentalSpan;
  work: RentalSpan;
  rateMinor: number;
  isWorkingDay: IsWorkingDay;
}

/** One way of renting the machine, priced against the rental as it stands. */
export function rentalOption(key: RentalOptionKey, label: string, span: RentalSpan, input: Pick<RentalChoiceInput, 'rental' | 'work' | 'rateMinor' | 'isWorkingDay'>): RentalOption {
  const days = rentalDays(span.start, span.end);
  const idle = idleRentalDays(span, input.work);
  let offDays = 0;
  for (let day = span.start; day < input.work.start && day < span.end; day = shifted(day, 1)) if (!input.isWorkingDay(day)) offDays += 1;
  for (let day = input.work.end > span.start ? input.work.end : span.start; day < span.end; day = shifted(day, 1)) if (!input.isWorkingDay(day)) offDays += 1;
  return {
    key,
    label,
    ...span,
    days,
    costMinor: days * input.rateMinor,
    savingMinor: (rentalDays(input.rental.start, input.rental.end) - days) * input.rateMinor,
    idle,
    offDaysInCover: offDays,
  };
}

/**
 * What to do about a rental that costs more than the work needs. A working day of cover either side is the usual answer,
 * since a day's wait for a machine costs a crew far more than a day's rental. Cover that would run over a weekend is left
 * out of the recommendation, because one working day of cover then costs three days on rent, but stays on offer.
 */
export function suggestRental(input: RentalChoiceInput): RentalChoice {
  const { work, isWorkingDay } = input;
  const span = (before: number, after: number) => paddedRental(work, { before, after }, isWorkingDay);
  const before = span(1, 0);
  const after = span(0, 1);
  const beforeIsPlain = rentalDays(before.start, work.start) === 1;
  const afterIsPlain = rentalDays(work.end, after.end) === 1;
  const either = rentalOption('either_side', 'A working day either side', span(1, 1), input);
  const onlyBefore = rentalOption('before_only', 'A working day before', before, input);
  const onlyAfter = rentalOption('after_only', 'A working day after', after, input);
  const justWork = rentalOption('just_the_work', 'Just the days of the work', work, input);
  const first = beforeIsPlain && afterIsPlain ? either : afterIsPlain ? onlyAfter : beforeIsPlain ? onlyBefore : justWork;
  const worthwhile = (option: RentalOption) => option.savingMinor > 0 || (input.rateMinor === 0 && option.days < rentalDays(input.rental.start, input.rental.end));
  const recommended = worthwhile(first) ? first : worthwhile(justWork) ? justWork : null;
  const alternatives = [justWork, either, onlyAfter, onlyBefore]
    .filter((option) => option.key !== recommended?.key && worthwhile(option))
    .sort((a, b) => a.days - b.days);
  return { recommended, alternatives };
}
