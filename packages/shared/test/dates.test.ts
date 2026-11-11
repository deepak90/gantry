import { describe, expect, it } from 'vitest';
import {
  InvalidDateError,
  addDays,
  assertDateOnly,
  compareDateOnly,
  daysBetween,
  isDateOnly,
  parseDateOnly,
  toDateOnly,
} from '../src/dates';

describe('isDateOnly()', () => {
  it.each(['2026-11-02', '2024-02-29', '2000-02-29', '1999-12-31', '2026-01-01'])(
    'accepts %s',
    (text) => {
      expect(isDateOnly(text)).toBe(true);
      expect(() => assertDateOnly(text)).not.toThrow();
    },
  );

  it.each([
    '2026-02-30',
    '2023-02-29',
    '2100-02-29',
    '2026-13-01',
    '2026-00-10',
    '2026-11-00',
    '2026-04-31',
    '2026-1-2',
    '26-11-02',
    '2026/11/02',
    '11/02/2026',
    '2026-11-02T00:00:00Z',
    '2026-11-02 ',
    '',
    'today',
  ])('rejects %j', (text) => {
    expect(isDateOnly(text)).toBe(false);
    expect(() => assertDateOnly(text)).toThrow(InvalidDateError);
  });

  it('rejects non-strings', () => {
    expect(isDateOnly(20261102)).toBe(false);
    expect(isDateOnly(new Date())).toBe(false);
    expect(isDateOnly(null)).toBe(false);
    expect(() => assertDateOnly(undefined)).toThrow(InvalidDateError);
  });
});

describe('toDateOnly() and parseDateOnly()', () => {
  it('formats the local calendar date of a Date', () => {
    expect(toDateOnly(new Date(2026, 10, 2))).toBe('2026-11-02');
    expect(toDateOnly(new Date(2026, 0, 9, 23, 59, 59))).toBe('2026-01-09');
    expect(toDateOnly(new Date(999, 5, 1))).toBe('0999-06-01');
  });

  it('parses to local midnight, the instant Bryntum assigns a plain date', () => {
    const date = parseDateOnly('2026-11-02');
    expect([date.getFullYear(), date.getMonth(), date.getDate()]).toEqual([2026, 10, 2]);
    expect([date.getHours(), date.getMinutes(), date.getSeconds()]).toEqual([0, 0, 0]);
    expect(toDateOnly(date)).toBe('2026-11-02');
  });

  it('rejects invalid input', () => {
    expect(() => toDateOnly(new Date('nonsense'))).toThrow(InvalidDateError);
    expect(() => toDateOnly('2026-11-02' as unknown as Date)).toThrow(InvalidDateError);
    expect(() => parseDateOnly('2026-02-30')).toThrow(InvalidDateError);
  });
});

describe('daysBetween()', () => {
  it('counts the calendar days of a start-inclusive, end-exclusive interval', () => {
    expect(daysBetween('2026-11-30', '2026-12-10')).toBe(10);
    expect(daysBetween('2026-12-04', '2026-12-10')).toBe(6);
    expect(daysBetween('2026-11-02', '2026-11-02')).toBe(0);
    expect(daysBetween('2026-12-31', '2027-01-01')).toBe(1);
    expect(daysBetween('2024-02-28', '2024-03-01')).toBe(2);
    expect(daysBetween('2023-02-28', '2023-03-01')).toBe(1);
  });

  it('is negative when the end precedes the start', () => {
    expect(daysBetween('2026-12-10', '2026-11-30')).toBe(-10);
  });

  it('is unaffected by daylight-saving transitions', () => {
    expect(daysBetween('2026-03-07', '2026-03-09')).toBe(2);
    expect(daysBetween('2026-10-24', '2026-10-26')).toBe(2);
    expect(daysBetween('2026-03-01', '2026-04-01')).toBe(31);
  });

  it('rejects invalid dates', () => {
    expect(() => daysBetween('2026-02-30', '2026-03-01')).toThrow(InvalidDateError);
    expect(() => daysBetween('2026-03-01', 'soon')).toThrow(InvalidDateError);
  });
});

describe('addDays()', () => {
  it('moves across month, year and leap-day boundaries', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDays('2023-02-28', 1)).toBe('2023-03-01');
    expect(addDays('2026-11-30', 10)).toBe('2026-12-10');
    expect(addDays('2026-11-02', 0)).toBe('2026-11-02');
  });

  it('inverts daysBetween', () => {
    expect(addDays('2026-11-30', daysBetween('2026-11-30', '2026-12-10'))).toBe('2026-12-10');
  });

  it('rejects fractional day counts and invalid dates', () => {
    expect(() => addDays('2026-11-02', 1.5)).toThrow(RangeError);
    expect(() => addDays('2026-11-02', Number.NaN)).toThrow(RangeError);
    expect(() => addDays('2026-11-31', 1)).toThrow(InvalidDateError);
  });
});

describe('compareDateOnly()', () => {
  it('orders chronologically', () => {
    expect(compareDateOnly('2026-11-02', '2026-11-03')).toBe(-1);
    expect(compareDateOnly('2026-11-03', '2026-11-02')).toBe(1);
    expect(compareDateOnly('2026-11-02', '2026-11-02')).toBe(0);
    expect(compareDateOnly('2026-12-31', '2027-01-01')).toBe(-1);
    expect(() => compareDateOnly('2026-11-02', '2026-11-2')).toThrow(InvalidDateError);
  });
});
