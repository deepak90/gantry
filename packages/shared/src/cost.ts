/**
 * Cost comparison for revised rental dates. The equipment is not paid for yet, so the supplier is paid
 * the rental as revised: fewer days when it would have stood idle, more when the work needs it longer.
 * Pure: the same input always yields the same result and nothing is read from outside.
 * Total over its domain: every well-typed input with safe-integer amounts and non-negative
 * day counts produces a result; anything else throws `CostInputError` before any arithmetic.
 */
import { type CurrencyCode, InvalidAmountError, type Money, money, subtract, multiply } from './money';
import type { CostComparison } from './schemas';

export class CostInputError extends Error {
  readonly field: string;
  readonly input: unknown;

  constructor(field: string, message: string, input: unknown) {
    super(`${field}: ${message}`);
    this.name = 'CostInputError';
    this.field = field;
    this.input = input;
  }
}

export interface CostComparisonInput {
  currency: CurrencyCode;
  /** Rental rate per billable day, in minor units. */
  rentalRateMinor: number;
  /** Billable days of the booking as it stands. */
  bookedDays: number;
  /** Billable days of the revised booking. */
  revisedDays: number;
}

export interface CostComparisonResult {
  readonly currency: CurrencyCode;
  /** rentalRate × bookedDays. */
  readonly bookedRental: Money;
  /** rentalRate × revisedDays: what the supplier is paid. */
  readonly supplierPayment: Money;
  /** bookedRental − supplierPayment; negative when the revised rental is longer. */
  readonly saving: Money;
}

function amountField(field: string, value: unknown, currency: CurrencyCode): Money {
  let parsed: Money;
  try {
    parsed = money(value as number, currency);
  } catch (error) {
    if (error instanceof InvalidAmountError) {
      throw new CostInputError(field, 'must be a safe integer number of minor units', value);
    }
    throw error;
  }
  if (parsed.minor < 0) {
    throw new CostInputError(field, 'must not be negative', value);
  }
  return parsed;
}

function dayCount(field: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new CostInputError(field, 'must be a non-negative integer number of days', value);
  }
  return value;
}

/** Computes every line of the cost comparison table. */
export function compareCosts(input: CostComparisonInput): CostComparisonResult {
  const { currency } = input;
  const rentalRate = amountField('rentalRateMinor', input.rentalRateMinor, currency);
  const bookedRental = multiply(rentalRate, dayCount('bookedDays', input.bookedDays));
  const supplierPayment = multiply(rentalRate, dayCount('revisedDays', input.revisedDays));
  return Object.freeze({ currency, bookedRental, supplierPayment, saving: subtract(bookedRental, supplierPayment) });
}

/** The persisted/transported form (`CostComparison` schema): minor units plus currency. */
export function toCostComparisonRecord(result: CostComparisonResult): CostComparison {
  return {
    currency: result.currency,
    booked_rental_minor: result.bookedRental.minor,
    supplier_payment_minor: result.supplierPayment.minor,
    saving_minor: result.saving.minor,
  };
}

/** Inverse of `toCostComparisonRecord`, for records read back from the database. */
export function fromCostComparisonRecord(record: CostComparison): CostComparisonResult {
  const { currency } = record;
  return Object.freeze({
    currency,
    bookedRental: money(record.booked_rental_minor, currency),
    supplierPayment: money(record.supplier_payment_minor, currency),
    saving: money(record.saving_minor, currency),
  });
}
