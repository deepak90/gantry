/**
 * Exact money arithmetic. Amounts are integer minor units (cents) with an explicit
 * ISO-4217 currency. Nothing here divides or multiplies by a fraction: every operation is
 * integer arithmetic checked against Number.isSafeInteger, and decimal text is parsed and
 * printed by digit manipulation, so no floating-point rounding can reach a boundary.
 */
import { z } from 'zod';

/** Supported ISO-4217 codes. Adding one means adding its symbol to CURRENCY_SYMBOLS too. */
export const CURRENCY_CODES = ['USD'] as const;
export type CurrencyCode = (typeof CURRENCY_CODES)[number];

export interface Money {
  readonly minor: number;
  readonly currency: CurrencyCode;
}

const CURRENCY_SYMBOLS: Readonly<Record<CurrencyCode, string>> = { USD: '$' };

/** Every supported currency has two decimal places; parsing and formatting rely on it. */
const FRACTION_DIGITS = 2;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

/** A minor-unit value or decimal text that cannot be represented exactly. */
export class InvalidAmountError extends MoneyError {
  readonly input: unknown;

  constructor(message: string, input: unknown) {
    super(message);
    this.name = 'InvalidAmountError';
    this.input = input;
  }
}

export class UnknownCurrencyError extends MoneyError {
  readonly input: unknown;

  constructor(input: unknown) {
    super(`Unknown currency ${describeValue(input)}; supported: ${CURRENCY_CODES.join(', ')}`);
    this.name = 'UnknownCurrencyError';
    this.input = input;
  }
}

export class CurrencyMismatchError extends MoneyError {
  readonly left: CurrencyCode;
  readonly right: CurrencyCode;

  constructor(left: CurrencyCode, right: CurrencyCode) {
    super(`Currency mismatch: ${left} and ${right} cannot be combined`);
    this.name = 'CurrencyMismatchError';
    this.left = left;
    this.right = right;
  }
}

function describeValue(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

export function isCurrencyCode(value: unknown): value is CurrencyCode {
  return typeof value === 'string' && (CURRENCY_CODES as readonly string[]).includes(value);
}

function assertCurrencyCode(value: unknown): asserts value is CurrencyCode {
  if (!isCurrencyCode(value)) {
    throw new UnknownCurrencyError(value);
  }
}

/** Builds a Money value, rejecting anything that is not a safe integer number of minor units. */
export function money(minor: number, currency: CurrencyCode): Money {
  if (typeof minor !== 'number' || !Number.isSafeInteger(minor)) {
    throw new InvalidAmountError(
      `Minor units must be a safe integer, got ${describeValue(minor)}`,
      minor,
    );
  }
  assertCurrencyCode(currency);
  // `minor === 0` is also true for -0; normalizing keeps isZero/compare/format consistent.
  return Object.freeze({ minor: minor === 0 ? 0 : minor, currency });
}

export function zero(currency: CurrencyCode): Money {
  return money(0, currency);
}

/** Whole major units (e.g. 600 dollars) to Money; the factor must be an integer. */
export function fromMajorUnits(major: number, currency: CurrencyCode): Money {
  if (typeof major !== 'number' || !Number.isSafeInteger(major)) {
    throw new InvalidAmountError(
      `Major units must be a safe integer, got ${describeValue(major)}`,
      major,
    );
  }
  return money(major * 10 ** FRACTION_DIGITS, currency);
}

/**
 * Decimal amount grammar: optional '-', digits with either no grouping or strict 3-digit
 * comma groups, optional '.' followed by one or two digits. Examples: '1,200.00', '1200',
 * '1200.5', '-300'. No whitespace, sign suffixes, exponents or symbols.
 */
export const DECIMAL_AMOUNT_RE = /^(-?)(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/;

/**
 * Parses decimal text into Money without ever constructing a float. Rejects non-strings
 * (a JavaScript number is not an exact amount), more than two decimals, NaN/Infinity, and
 * magnitudes beyond Number.MAX_SAFE_INTEGER minor units.
 */
export function fromDecimalString(text: string, currency: CurrencyCode): Money {
  if (typeof text !== 'string') {
    throw new InvalidAmountError(
      `Decimal amounts must be strings, got ${describeValue(text)} (${typeof text})`,
      text,
    );
  }
  const match = DECIMAL_AMOUNT_RE.exec(text);
  const whole = match?.[2];
  if (match === null || whole === undefined) {
    throw new InvalidAmountError(
      `${describeValue(text)} is not a decimal amount with at most ${FRACTION_DIGITS} decimals`,
      text,
    );
  }
  const fraction = (match[3] ?? '').padEnd(FRACTION_DIGITS, '0');
  const magnitude = BigInt(whole.replaceAll(',', '') + fraction);
  if (magnitude > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new InvalidAmountError(`${describeValue(text)} exceeds the largest exact amount`, text);
  }
  const minor = Number(magnitude);
  return money(match[1] === '-' ? -minor : minor, currency);
}

/** True when `fromDecimalString` would accept the text. */
export function isDecimalAmount(text: string): boolean {
  if (typeof text !== 'string' || !DECIMAL_AMOUNT_RE.test(text)) {
    return false;
  }
  try {
    fromDecimalString(text, CURRENCY_CODES[0]);
    return true;
  } catch {
    return false;
  }
}

export function isSameCurrency(a: Money, b: Money): boolean {
  return a.currency === b.currency;
}

export function assertSameCurrency(a: Money, b: Money): void {
  if (!isSameCurrency(a, b)) {
    throw new CurrencyMismatchError(a.currency, b.currency);
  }
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.minor + b.minor, a.currency);
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.minor - b.minor, a.currency);
}

/** Scales by an integer factor (quantities such as days). Fractions are rejected. */
export function multiply(amount: Money, factor: number): Money {
  if (typeof factor !== 'number' || !Number.isSafeInteger(factor)) {
    throw new InvalidAmountError(
      `Money can only be multiplied by a safe integer, got ${describeValue(factor)}`,
      factor,
    );
  }
  return money(amount.minor * factor, amount.currency);
}

export function negate(amount: Money): Money {
  return money(-amount.minor, amount.currency);
}

export function abs(amount: Money): Money {
  return amount.minor < 0 ? negate(amount) : amount;
}

/** Adds every item; an empty list is zero in the given currency. */
export function sum(items: Iterable<Money>, currency: CurrencyCode): Money {
  let total = zero(currency);
  for (const item of items) {
    total = add(total, item);
  }
  return total;
}

export function isZero(amount: Money): boolean {
  return amount.minor === 0;
}

export function isNegative(amount: Money): boolean {
  return amount.minor < 0;
}

export function isPositive(amount: Money): boolean {
  return amount.minor > 0;
}

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  if (a.minor < b.minor) return -1;
  if (a.minor > b.minor) return 1;
  return 0;
}

export function equals(a: Money, b: Money): boolean {
  return isSameCurrency(a, b) && a.minor === b.minor;
}

/** Splits |minor| into whole and fractional digit strings without division. */
function splitDigits(amount: Money): { whole: string; fraction: string } {
  const digits = String(Math.abs(amount.minor)).padStart(FRACTION_DIGITS + 1, '0');
  return {
    whole: digits.slice(0, -FRACTION_DIGITS),
    fraction: digits.slice(-FRACTION_DIGITS),
  };
}

/** Canonical two-decimal text, e.g. '1200.00', '-300.00', '0.05'. Round-trips through fromDecimalString. */
export function toDecimalString(amount: Money): string {
  const { whole, fraction } = splitDigits(amount);
  return `${isNegative(amount) ? '-' : ''}${whole}.${fraction}`;
}

/** Display text with symbol and thousands grouping: '$1,200.00', negatives as '-$300.00'. */
export function format(amount: Money): string {
  const { whole, fraction } = splitDigits(amount);
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${isNegative(amount) ? '-' : ''}${CURRENCY_SYMBOLS[amount.currency]}${grouped}.${fraction}`;
}

export const CurrencyCodeSchema = z.enum(CURRENCY_CODES);

/** Boundary schema for Money; `z.int()` only accepts safe integers. */
export const MoneySchema = z.strictObject({
  minor: z.int().describe('Amount in minor units (cents)'),
  currency: CurrencyCodeSchema,
});
