import { describe, expect, it } from 'vitest';
import { idleRentalDays, paddedRental, rentalDays, suggestRental, withinBuffer } from '../src/rental-days';

describe('a rental is paid by the calendar day', () => {
  it('counts every day of [start, end), weekends too', () => {
    // Mon, Feb 1 to Tue, Feb 16, 2027: two weekends inside.
    expect(rentalDays('2027-02-01', '2027-02-16')).toBe(15);
    // One Saturday.
    expect(rentalDays('2027-02-06', '2027-02-07')).toBe(1);
  });

  it('is nothing for an empty or inverted interval', () => {
    expect(rentalDays('2027-02-01', '2027-02-01')).toBe(0);
    expect(rentalDays('2027-02-16', '2027-02-01')).toBe(0);
  });

  it('crosses a daylight saving change without losing a day', () => {
    expect(rentalDays('2027-03-13', '2027-03-15')).toBe(2);
    expect(rentalDays('2027-11-06', '2027-11-08')).toBe(2);
  });
});

describe('idle days', () => {
  const rental = { start: '2027-02-01', end: '2027-02-16' };

  it('counts a weekend on either side of the work', () => {
    // Work ending Thu, Feb 11: on rent Fri, Sat, Sun and Mon after it.
    expect(idleRentalDays(rental, { start: '2027-02-04', end: '2027-02-12' })).toEqual({ before: 3, after: 4 });
    // Work starting Mon, Feb 8: on rent the whole week and the weekend before it.
    expect(idleRentalDays(rental, { start: '2027-02-08', end: '2027-02-16' })).toEqual({ before: 7, after: 0 });
  });

  it('leaves out a weekend inside the work: no dates would take it away', () => {
    expect(idleRentalDays({ start: '2027-02-08', end: '2027-02-16' }, { start: '2027-02-08', end: '2027-02-16' })).toEqual({ before: 0, after: 0 });
  });

  it('calls a rental that misses the work idle all through', () => {
    expect(idleRentalDays(rental, { start: '2027-03-01', end: '2027-03-05' })).toEqual({ before: 15, after: 0 });
    expect(idleRentalDays(rental, { start: '2027-01-11', end: '2027-01-15' })).toEqual({ before: 0, after: 15 });
  });
});

describe('what to do about a rental', () => {
  const weekdays = (day: string) => ![0, 6].includes(new Date(`${day}T00:00:00Z`).getUTCDay());
  const rental = { start: '2027-02-01', end: '2027-02-16' };

  it('recommends a working day either side, which is what someone would book by hand', () => {
    // Work Thu, Feb 4 to Thu, Feb 11.
    const { recommended, alternatives } = suggestRental({ rental, work: { start: '2027-02-04', end: '2027-02-12' }, rateMinor: 60_000, isWorkingDay: weekdays });
    expect(recommended).toMatchObject({ key: 'either_side', start: '2027-02-03', end: '2027-02-13', days: 10, costMinor: 600_000, savingMinor: 300_000 });
    expect(alternatives[0]).toMatchObject({ key: 'just_the_work', days: 8, savingMinor: 420_000 });
  });

  it('leaves out cover that would run over a weekend, and still offers it with what it costs', () => {
    // Work Mon, Feb 8 to Mon, Feb 15: a day before is the Friday, three days on rent for one day of cover.
    const { recommended, alternatives } = suggestRental({ rental, work: { start: '2027-02-08', end: '2027-02-16' }, rateMinor: 60_000, isWorkingDay: weekdays });
    expect(recommended).toMatchObject({ key: 'after_only', start: '2027-02-08', end: '2027-02-17', days: 9, savingMinor: 360_000 });
    const either = alternatives.find((option) => option.key === 'either_side')!;
    expect(either).toMatchObject({ start: '2027-02-05', end: '2027-02-17', days: 12, offDaysInCover: 2, savingMinor: 180_000 });
  });

  it('says nothing shorter covers the work when the rental is already the days of the work', () => {
    const work = { start: '2027-02-08', end: '2027-02-16' };
    expect(suggestRental({ rental: work, work, rateMinor: 60_000, isWorkingDay: weekdays }).recommended).toBeNull();
  });
});

describe('cover around the work', () => {
  const weekdays = (day: string) => ![0, 6].includes(new Date(`${day}T00:00:00Z`).getUTCDay());
  const work = { start: '2027-02-08', end: '2027-02-16' }; // Mon, Feb 8 to Mon, Feb 15.

  it('counts in working days: the day before a Monday is the Friday', () => {
    expect(paddedRental(work, { before: 1, after: 1 }, weekdays)).toEqual({ start: '2027-02-05', end: '2027-02-17' });
    expect(paddedRental(work, { before: 2, after: 0 }, weekdays)).toEqual({ start: '2027-02-04', end: '2027-02-16' });
  });

  it('is not a problem up to two working days either side, whatever days of the week that comes to', () => {
    expect(withinBuffer({ start: '2027-02-05', end: '2027-02-17' }, work, weekdays)).toBe(true);
    expect(withinBuffer({ start: '2027-02-04', end: '2027-02-18' }, work, weekdays)).toBe(true);
    expect(withinBuffer({ start: '2027-02-03', end: '2027-02-16' }, work, weekdays)).toBe(false);
    expect(withinBuffer({ start: '2027-02-08', end: '2027-02-19' }, work, weekdays)).toBe(false);
  });
});
