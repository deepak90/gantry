/**
 * PayPal amounts as exact decimal text. The database keeps integer minor units and every currency
 * the app supports has two decimal places (see packages/shared/src/money.ts), so converting is digit
 * manipulation: no float ever holds an amount on its way to or from PayPal.
 */

const FRACTION_DIGITS = 2;

/** PayPal's `value` grammar as we accept it: plain digits, optionally '.' and one or two digits. */
const DECIMAL_RE = /^(\d+)(?:\.(\d{1,2}))?$/;

export class AmountError extends Error {
  readonly input: unknown;

  constructor(message: string, input: unknown) {
    super(message);
    this.name = 'AmountError';
    this.input = input;
  }
}

/** 120000 → '1200.00'. Only positive safe integers: a payout of nothing or less is a bug upstream. */
export function minorToDecimal(minor: number): string {
  if (typeof minor !== 'number' || !Number.isSafeInteger(minor) || minor <= 0) {
    throw new AmountError(`A payout amount must be a positive whole number of minor units, got ${String(minor)}`, minor);
  }
  const digits = String(minor).padStart(FRACTION_DIGITS + 1, '0');
  return `${digits.slice(0, -FRACTION_DIGITS)}.${digits.slice(-FRACTION_DIGITS)}`;
}

/** '0.25' → 25, '1' → 100, '1.5' → 150. Rejects signs, exponents, grouping and a third decimal. */
export function decimalToMinor(text: unknown): number {
  if (typeof text !== 'string') {
    throw new AmountError(`A PayPal amount must be decimal text, got ${typeof text}`, text);
  }
  const match = DECIMAL_RE.exec(text);
  const whole = match?.[1];
  if (match === null || whole === undefined) {
    throw new AmountError(`${JSON.stringify(text)} is not an amount with at most ${FRACTION_DIGITS} decimals`, text);
  }
  const minor = BigInt(whole + (match[2] ?? '').padEnd(FRACTION_DIGITS, '0'));
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new AmountError(`${JSON.stringify(text)} exceeds the largest exact amount`, text);
  }
  return Number(minor);
}

/**
 * `payout_item_fee` ({ value: '0.25', currency: 'USD' }) in minor units. Null when PayPal has not
 * reported a fee, reports it in another currency than the payout (the row has no fee currency), or
 * sends a value we cannot represent exactly; a fee is informational and never blocks a status.
 */
export function feeMinor(fee: unknown, payoutCurrency: string | null): number | null {
  if (fee === null || typeof fee !== 'object') {
    return null;
  }
  const { value, currency } = fee as { value?: unknown; currency?: unknown };
  if (payoutCurrency !== null && currency !== payoutCurrency) {
    return null;
  }
  try {
    return decimalToMinor(value);
  } catch {
    return null;
  }
}

const CURRENCY_SYMBOLS: Readonly<Record<string, string>> = { USD: '$', EUR: '€', GBP: '£' };

/**
 * An amount as people read it on a document: 120000 USD → '$1,200.00', 25 → '$0.25', and
 * 'CAD 1,200.00' for a currency without a symbol here. Digits only, like the rest of this module.
 */
export function formatMoney(minor: number, currency: string): string {
  if (typeof minor !== 'number' || !Number.isSafeInteger(minor)) {
    throw new AmountError(`An amount must be a whole number of minor units, got ${String(minor)}`, minor);
  }
  const digits = String(Math.abs(minor)).padStart(FRACTION_DIGITS + 1, '0');
  const whole = digits.slice(0, -FRACTION_DIGITS).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const amount = `${whole}.${digits.slice(-FRACTION_DIGITS)}`;
  const symbol = CURRENCY_SYMBOLS[currency];
  const text = symbol === undefined ? `${currency} ${amount}` : `${symbol}${amount}`;
  return minor < 0 ? `-${text}` : text;
}
