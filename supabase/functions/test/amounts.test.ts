import { describe, expect, it } from 'vitest';
import { AmountError, decimalToMinor, feeMinor, formatMoney, minorToDecimal } from '../_shared/amounts.ts';

describe('minorToDecimal', () => {
  it.each([
    [1, '0.01'],
    [5, '0.05'],
    [99, '0.99'],
    [100, '1.00'],
    [120000, '1200.00'],
    [123456789, '1234567.89'],
    [Number.MAX_SAFE_INTEGER, '90071992547409.91'],
  ])('%d → %s', (minor, text) => {
    expect(minorToDecimal(minor)).toBe(text);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])('rejects %s', (minor) => {
    expect(() => minorToDecimal(minor)).toThrow(AmountError);
  });
});

describe('decimalToMinor', () => {
  it.each([
    ['0.25', 25],
    ['0', 0],
    ['1', 100],
    ['1.5', 150],
    ['1.05', 105],
    ['1200.00', 120000],
    ['0010.10', 1010],
    ['90071992547409.91', Number.MAX_SAFE_INTEGER],
  ])('%s → %d', (text, minor) => {
    expect(decimalToMinor(text)).toBe(minor);
  });

  it.each(['0.001', '1.255', '-1.00', '+1', '1e2', '1,200.00', ' 1.00', '1.', '.5', '', 'NaN', '90071992547409.92'])(
    'rejects %j',
    (text) => {
      expect(() => decimalToMinor(text)).toThrow(AmountError);
    },
  );

  it('rejects numbers: a float is not an exact amount', () => {
    expect(() => decimalToMinor(0.25)).toThrow(AmountError);
  });
});

describe('feeMinor', () => {
  it('reads payout_item_fee in the payout currency', () => {
    expect(feeMinor({ value: '0.25', currency: 'USD' }, 'USD')).toBe(25);
    expect(feeMinor({ value: '0.00', currency: 'USD' }, 'USD')).toBe(0);
  });

  it('accepts any currency when the payout currency is not known', () => {
    expect(feeMinor({ value: '2.00', currency: 'EUR' }, null)).toBe(200);
  });

  it('is null when absent, in another currency, or not exact', () => {
    expect(feeMinor(undefined, 'USD')).toBeNull();
    expect(feeMinor(null, 'USD')).toBeNull();
    expect(feeMinor({ value: '0.25', currency: 'EUR' }, 'USD')).toBeNull();
    expect(feeMinor({ value: '0.255', currency: 'USD' }, 'USD')).toBeNull();
    expect(feeMinor({ value: 0.25, currency: 'USD' }, 'USD')).toBeNull();
  });
});

describe('formatMoney', () => {
  it.each([
    [0, 'USD', '$0.00'],
    [25, 'USD', '$0.25'],
    [120000, 'USD', '$1,200.00'],
    [123456789, 'USD', '$1,234,567.89'],
    [-30000, 'USD', '-$300.00'],
    [90000, 'EUR', '€900.00'],
    [90000, 'GBP', '£900.00'],
    [90000, 'CAD', 'CAD 900.00'],
  ])('%d %s → %s', (minor, currency, text) => {
    expect(formatMoney(minor, currency)).toBe(text);
  });

  it.each([1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])('rejects %s', (minor) => {
    expect(() => formatMoney(minor, 'USD')).toThrow(AmountError);
  });
});
