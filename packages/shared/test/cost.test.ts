import { describe, expect, it } from 'vitest';
import {
  CostInputError,
  compareCosts,
  fromCostComparisonRecord,
  toCostComparisonRecord,
  type CostComparisonInput,
} from '../src/cost';
import { format, money, type Money } from '../src/money';
import { CostComparison } from '../src/schemas';

const usd = (minor: number): Money => money(minor, 'USD');

/** Scenario: the crane booked for 10 days at $600/day would stand idle 4; the revised rental is 6 days. */
const idleCrane: CostComparisonInput = { currency: 'USD', rentalRateMinor: 60000, bookedDays: 10, revisedDays: 6 };

/** Scenario: the erection needs two more days than the rental covers. */
const longerRental: CostComparisonInput = { ...idleCrane, revisedDays: 12 };

describe('revised rental dates', () => {
  it('pays the supplier the shorter rental and saves the idle days', () => {
    const result = compareCosts(idleCrane);
    expect(result.currency).toBe('USD');
    expect(result.bookedRental).toEqual(usd(600000));
    expect(result.supplierPayment).toEqual(usd(360000));
    expect(result.saving).toEqual(usd(240000));
    expect([result.bookedRental, result.supplierPayment, result.saving].map(format)).toEqual(['$6,000.00', '$3,600.00', '$2,400.00']);
  });

  it('pays the longer rental when the work needs more days: the saving is negative', () => {
    const result = compareCosts(longerRental);
    expect(result.supplierPayment).toEqual(usd(720000));
    expect(result.saving).toEqual(usd(-120000));
  });

  it('saves nothing when the dates move but the length stays', () => {
    expect(compareCosts({ ...idleCrane, revisedDays: 10 }).saving).toEqual(usd(0));
  });

  it('is pure and returns a frozen result', () => {
    const input = { ...idleCrane };
    const first = compareCosts(input);
    expect(compareCosts(input)).toEqual(first);
    expect(input).toEqual(idleCrane);
    expect(Object.isFrozen(first)).toBe(true);
  });
});

describe('input validation', () => {
  function expectCostInputError(input: unknown, field: string): void {
    let caught: unknown;
    try {
      compareCosts(input as CostComparisonInput);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CostInputError);
    expect((caught as CostInputError).field).toBe(field);
  }

  it('rejects a rental rate that is not a non-negative safe integer', () => {
    expectCostInputError({ ...idleCrane, rentalRateMinor: 600.5 }, 'rentalRateMinor');
    expectCostInputError({ ...idleCrane, rentalRateMinor: '60000' }, 'rentalRateMinor');
    expectCostInputError({ ...idleCrane, rentalRateMinor: 2 ** 53 }, 'rentalRateMinor');
    expectCostInputError({ ...idleCrane, rentalRateMinor: -1 }, 'rentalRateMinor');
  });

  it('rejects day counts that are not non-negative integers', () => {
    expectCostInputError({ ...idleCrane, bookedDays: -1 }, 'bookedDays');
    expectCostInputError({ ...idleCrane, bookedDays: '10' }, 'bookedDays');
    expectCostInputError({ ...idleCrane, revisedDays: 1.5 }, 'revisedDays');
    expectCostInputError({ ...idleCrane, revisedDays: undefined }, 'revisedDays');
  });

  it('rejects an unknown currency', () => {
    expect(() => compareCosts({ ...idleCrane, currency: 'EUR' as 'USD' })).toThrow(/Unknown currency/);
  });

  it('reports the field in the message', () => {
    expect(() => compareCosts({ ...idleCrane, bookedDays: -1 })).toThrow('bookedDays: must be a non-negative integer number of days');
  });
});

describe('record conversion', () => {
  it('serializes to the CostComparison record shape', () => {
    const record = toCostComparisonRecord(compareCosts(idleCrane));
    expect(record).toEqual({ currency: 'USD', booked_rental_minor: 600000, supplier_payment_minor: 360000, saving_minor: 240000 });
    expect(CostComparison.parse(record)).toEqual(record);
  });

  it('round-trips through the record form, a negative saving included', () => {
    for (const input of [idleCrane, longerRental]) {
      const result = compareCosts(input);
      const restored = fromCostComparisonRecord(CostComparison.parse(JSON.parse(JSON.stringify(toCostComparisonRecord(result)))));
      expect(restored).toEqual(result);
      expect(Object.isFrozen(restored)).toBe(true);
    }
  });
});
