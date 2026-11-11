import { describe, expect, it } from 'vitest';
import {
  CURRENCY_CODES,
  CurrencyCodeSchema,
  CurrencyMismatchError,
  InvalidAmountError,
  MoneyError,
  MoneySchema,
  UnknownCurrencyError,
  abs,
  add,
  assertSameCurrency,
  compare,
  equals,
  format,
  fromDecimalString,
  fromMajorUnits,
  isCurrencyCode,
  isDecimalAmount,
  isNegative,
  isPositive,
  isSameCurrency,
  isZero,
  money,
  multiply,
  negate,
  subtract,
  sum,
  toDecimalString,
  zero,
  type CurrencyCode,
  type Money,
} from '../src/money';

const usd = (minor: number): Money => money(minor, 'USD');
/** A value in a currency the type system does not know, to exercise mismatch handling. */
const foreign: Money = { minor: 100, currency: 'EUR' as CurrencyCode };

describe('money()', () => {
  it('builds a frozen value from safe-integer minor units', () => {
    const amount = usd(150000);
    expect(amount).toEqual({ minor: 150000, currency: 'USD' });
    expect(Object.isFrozen(amount)).toBe(true);
  });

  it('normalizes negative zero to zero', () => {
    expect(Object.is(usd(-0).minor, 0)).toBe(true);
    expect(isZero(usd(-0))).toBe(true);
  });

  it('accepts the safe-integer limits', () => {
    expect(usd(Number.MAX_SAFE_INTEGER).minor).toBe(Number.MAX_SAFE_INTEGER);
    expect(usd(Number.MIN_SAFE_INTEGER).minor).toBe(Number.MIN_SAFE_INTEGER);
  });

  it.each([
    ['a float', 1.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['2^53', 2 ** 53],
    ['-2^53', -(2 ** 53)],
    ['a numeric string', '100'],
    ['a bigint', 100n],
    ['undefined', undefined],
  ])('rejects %s as minor units', (_label, value) => {
    expect(() => money(value as number, 'USD')).toThrow(InvalidAmountError);
  });

  it('rejects unknown currencies at runtime', () => {
    expect(() => money(1, 'EUR' as CurrencyCode)).toThrow(UnknownCurrencyError);
    expect(() => money(1, 'usd' as CurrencyCode)).toThrow(UnknownCurrencyError);
    expect(isCurrencyCode('USD')).toBe(true);
    expect(isCurrencyCode('usd')).toBe(false);
    expect(isCurrencyCode(1)).toBe(false);
  });

  it('throws typed errors that extend MoneyError', () => {
    let caught: unknown;
    try {
      money(0.5, 'USD');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InvalidAmountError);
    expect(caught).toBeInstanceOf(MoneyError);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as InvalidAmountError).name).toBe('InvalidAmountError');
    expect((caught as InvalidAmountError).input).toBe(0.5);
  });

  it('zero() and fromMajorUnits() are conveniences over money()', () => {
    expect(zero('USD')).toEqual(usd(0));
    expect(fromMajorUnits(600, 'USD')).toEqual(usd(60000));
    expect(fromMajorUnits(-3, 'USD')).toEqual(usd(-300));
    expect(() => fromMajorUnits(6.5, 'USD')).toThrow(InvalidAmountError);
    expect(() => fromMajorUnits(2 ** 52, 'USD')).toThrow(InvalidAmountError);
  });
});

describe('fromDecimalString()', () => {
  it.each([
    ['1,200.00', 120000],
    ['1200', 120000],
    ['1200.5', 120050],
    ['-300', -30000],
    ['0', 0],
    ['0.05', 5],
    ['0.5', 50],
    ['12', 1200],
    ['999.99', 99999],
    ['1,234,567.89', 123456789],
    ['007', 700],
    ['-0.00', 0],
    ['-1,200.75', -120075],
  ])('parses %s to %i minor units', (text, minor) => {
    expect(fromDecimalString(text, 'USD')).toEqual(usd(minor));
  });

  it.each([
    '1.234',
    '1,2',
    '12,34',
    '1,2000',
    '1,234.567',
    '1e3',
    'NaN',
    'Infinity',
    '-Infinity',
    '',
    ' 1200',
    '1200 ',
    '$1,200',
    '+5',
    '--5',
    '.5',
    '5.',
    '1.2.3',
    '1_000',
    '1 200',
    '1200,00',
  ])('rejects %j', (text) => {
    expect(() => fromDecimalString(text, 'USD')).toThrow(InvalidAmountError);
    expect(isDecimalAmount(text)).toBe(false);
  });

  it('rejects JavaScript numbers, including integral and float ones', () => {
    expect(() => fromDecimalString(1200 as unknown as string, 'USD')).toThrow(InvalidAmountError);
    expect(() => fromDecimalString(0.1 + 0.2 as unknown as string, 'USD')).toThrow(
      InvalidAmountError,
    );
    expect(() => fromDecimalString(Number.NaN as unknown as string, 'USD')).toThrow(
      InvalidAmountError,
    );
    expect(isDecimalAmount(1200 as unknown as string)).toBe(false);
  });

  it('rejects magnitudes beyond the safe-integer range without losing precision', () => {
    expect(fromDecimalString('90071992547409.91', 'USD').minor).toBe(Number.MAX_SAFE_INTEGER);
    expect(fromDecimalString('-90071992547409.91', 'USD').minor).toBe(Number.MIN_SAFE_INTEGER);
    expect(() => fromDecimalString('90071992547409.92', 'USD')).toThrow(InvalidAmountError);
    expect(() => fromDecimalString('99999999999999999999', 'USD')).toThrow(InvalidAmountError);
    expect(isDecimalAmount('90071992547409.92')).toBe(false);
    expect(isDecimalAmount('90071992547409.91')).toBe(true);
  });

  it('round-trips through toDecimalString', () => {
    for (const minor of [0, 1, 5, 99, 100, 120050, -30000, 123456789, Number.MAX_SAFE_INTEGER]) {
      expect(fromDecimalString(toDecimalString(usd(minor)), 'USD')).toEqual(usd(minor));
    }
  });

  it('attaches the offending input to the error', () => {
    expect(() => fromDecimalString('1.234', 'USD')).toThrow(
      expect.objectContaining({ name: 'InvalidAmountError', input: '1.234' }),
    );
  });
});

describe('arithmetic', () => {
  it('adds and subtracts exactly', () => {
    expect(add(usd(90000), usd(30000))).toEqual(usd(120000));
    expect(subtract(usd(240000), usd(120000))).toEqual(usd(120000));
    expect(subtract(usd(60000), usd(90000))).toEqual(usd(-30000));
    expect(add(usd(1), usd(-1))).toEqual(usd(0));
  });

  it('is exact where floats are not', () => {
    // 0.1 + 0.2 !== 0.3 as floats; 10 + 20 minor units is 30 minor units.
    expect(add(fromDecimalString('0.10', 'USD'), fromDecimalString('0.20', 'USD'))).toEqual(
      fromDecimalString('0.30', 'USD'),
    );
    expect(toDecimalString(multiply(fromDecimalString('0.07', 'USD'), 100))).toBe('7.00');
  });

  it('multiplies by integer factors only', () => {
    expect(multiply(usd(60000), 4)).toEqual(usd(240000));
    expect(multiply(usd(60000), 0)).toEqual(usd(0));
    expect(multiply(usd(60000), -2)).toEqual(usd(-120000));
    expect(multiply(usd(-500), 3)).toEqual(usd(-1500));
    expect(() => multiply(usd(60000), 1.5)).toThrow(InvalidAmountError);
    expect(() => multiply(usd(60000), Number.NaN)).toThrow(InvalidAmountError);
    expect(() => multiply(usd(60000), '4' as unknown as number)).toThrow(InvalidAmountError);
  });

  it('refuses results outside the safe-integer range', () => {
    expect(() => add(usd(Number.MAX_SAFE_INTEGER), usd(1))).toThrow(InvalidAmountError);
    expect(() => subtract(usd(Number.MIN_SAFE_INTEGER), usd(1))).toThrow(InvalidAmountError);
    expect(() => multiply(usd(2 ** 52), 2)).toThrow(InvalidAmountError);
    expect(() => multiply(usd(Number.MAX_SAFE_INTEGER), -2)).toThrow(InvalidAmountError);
    expect(() => negate(usd(Number.MIN_SAFE_INTEGER))).not.toThrow();
  });

  it('negates, takes absolute values and sums', () => {
    expect(negate(usd(300))).toEqual(usd(-300));
    expect(negate(usd(0))).toEqual(usd(0));
    expect(abs(usd(-300))).toEqual(usd(300));
    expect(abs(usd(300))).toEqual(usd(300));
    expect(sum([usd(100), usd(200), usd(-50)], 'USD')).toEqual(usd(250));
    expect(sum([], 'USD')).toEqual(usd(0));
    expect(sum(new Set([usd(5)]), 'USD')).toEqual(usd(5));
  });

  it('never combines currencies', () => {
    expect(isSameCurrency(usd(1), usd(2))).toBe(true);
    expect(isSameCurrency(usd(1), foreign)).toBe(false);
    expect(() => assertSameCurrency(usd(1), usd(2))).not.toThrow();
    expect(() => add(usd(1), foreign)).toThrow(CurrencyMismatchError);
    expect(() => subtract(foreign, usd(1))).toThrow(CurrencyMismatchError);
    expect(() => compare(usd(1), foreign)).toThrow(CurrencyMismatchError);
    expect(() => sum([foreign], 'USD')).toThrow(CurrencyMismatchError);
    expect(() => assertSameCurrency(usd(1), foreign)).toThrow(
      expect.objectContaining({ name: 'CurrencyMismatchError', left: 'USD', right: 'EUR' }),
    );
  });
});

describe('comparison', () => {
  it('compares and tests sign', () => {
    expect(compare(usd(1), usd(2))).toBe(-1);
    expect(compare(usd(2), usd(1))).toBe(1);
    expect(compare(usd(2), usd(2))).toBe(0);
    expect(compare(usd(-1), usd(0))).toBe(-1);
    expect(equals(usd(5), usd(5))).toBe(true);
    expect(equals(usd(5), usd(6))).toBe(false);
    expect(equals(usd(100), foreign)).toBe(false);
    expect(isZero(usd(0))).toBe(true);
    expect(isZero(usd(1))).toBe(false);
    expect(isNegative(usd(-1))).toBe(true);
    expect(isNegative(usd(0))).toBe(false);
    expect(isPositive(usd(1))).toBe(true);
    expect(isPositive(usd(0))).toBe(false);
  });
});

describe('formatting', () => {
  it.each([
    [120000, '1200.00'],
    [-30000, '-300.00'],
    [0, '0.00'],
    [5, '0.05'],
    [50, '0.50'],
    [100, '1.00'],
    [-1, '-0.01'],
    [123456789, '1234567.89'],
    [Number.MAX_SAFE_INTEGER, '90071992547409.91'],
    [Number.MIN_SAFE_INTEGER, '-90071992547409.91'],
  ])('toDecimalString(%i) is %s', (minor, text) => {
    expect(toDecimalString(usd(minor))).toBe(text);
  });

  it.each([
    [120000, '$1,200.00'],
    [-30000, '-$300.00'],
    [0, '$0.00'],
    [5, '$0.05'],
    [99999, '$999.99'],
    [100000, '$1,000.00'],
    [123456789, '$1,234,567.89'],
    [-123456789, '-$1,234,567.89'],
    [240000, '$2,400.00'],
    [150000, '$1,500.00'],
  ])('format(%i) is %s', (minor, text) => {
    expect(format(usd(minor))).toBe(text);
  });
});

describe('MoneySchema', () => {
  it('accepts minor units that are safe integers in a known currency', () => {
    expect(MoneySchema.parse({ minor: 90000, currency: 'USD' })).toEqual(usd(90000));
    expect(MoneySchema.parse({ minor: -5, currency: 'USD' })).toEqual(usd(-5));
    expect(MoneySchema.safeParse({ minor: Number.MAX_SAFE_INTEGER, currency: 'USD' }).success).toBe(
      true,
    );
  });

  it.each([
    ['a float', { minor: 900.5, currency: 'USD' }],
    ['2^53', { minor: 2 ** 53, currency: 'USD' }],
    ['NaN', { minor: Number.NaN, currency: 'USD' }],
    ['a numeric string', { minor: '900', currency: 'USD' }],
    ['an unknown currency', { minor: 900, currency: 'EUR' }],
    ['a lowercase currency', { minor: 900, currency: 'usd' }],
    ['an extra key', { minor: 900, currency: 'USD', symbol: '$' }],
    ['a missing currency', { minor: 900 }],
  ])('rejects %s', (_label, value) => {
    expect(MoneySchema.safeParse(value).success).toBe(false);
  });

  it('exposes the supported currency codes', () => {
    expect(CurrencyCodeSchema.options).toEqual([...CURRENCY_CODES]);
    expect(CURRENCY_CODES).toContain('USD');
  });
});
