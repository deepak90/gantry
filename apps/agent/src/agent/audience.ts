/**
 * Who reads a thread, and what follows for money. A thread shared with the project is read by every
 * member; a private one by its starter and the people they invited. Amounts may be said when everyone
 * reading may see costs, or when someone who sees them chose to share the costs in that conversation
 * (they were warned when they invited someone who cannot see costs, or shared it with the project:
 * `agent_threads.costs_shared_by`). Otherwise (the General thread when a member who cannot see costs
 * is on the project, e.g. a site teammate) amounts are withheld: the model is told so (it still works
 * with the figures, e.g. to put a fix on the table); a card goes without its amounts or not at all;
 * and amounts in the reply are masked as they stream. Everyone has one role; only seeing costs counts.
 */
import type { PlanMember } from '../plan/snapshot';

export interface Audience {
  visibility: 'project' | 'private';
  /** Everyone who reads the thread. */
  people: readonly PlanMember[];
  /** Who shared the costs in this conversation with the people in it, if anyone did. */
  costsSharedBy?: PlanMember | null;
}

export const WITHHELD = 'withheld';

/** Amounts may be said when everyone reading may see costs, or when the costs were shared in the conversation. */
export function moneyAllowed(audience: Audience | null): boolean {
  return !audience || Boolean(audience.costsSharedBy) || audience.people.every((person) => person.canViewCosts);
}

/** The audience line put in front of each turn, for the model. */
export function describeAudience(audience: Audience | null): string {
  if (!audience) return '';
  const people = audience.people.map((person) => `${person.name} (${person.canViewCosts ? 'sees costs' : 'no cost access'})`).join('; ');
  const shared = audience.costsSharedBy && !audience.people.every((person) => person.canViewCosts);
  const money = shared ? 'shared' : moneyAllowed(audience) ? 'allowed' : 'withheld';
  const by = shared ? ` shared_by="${audience.costsSharedBy!.name}"` : '';
  return `\n<audience thread="${audience.visibility === 'private' ? 'private' : 'shared with the project'}" money="${money}"${by}>${people}</audience>`;
}

/** Field names that carry money in tool results (minor units, amounts, rates, fees, budgets …). */
const MONEY_KEY = /(_minor$|^amount|amount$|money|price|^rate$|_rate$|rate_|budget|forecast|spent|^paid$|_paid$|paid_|unpaid|cost|fee|saving|variance|over_budget|at_stake)/i;
/** A number as amounts are written: "2,400", "1200.50", "9". */
const NUMBER = String.raw`(?:\d[\d,]*\d|\d)(?:\.\d+)?`;
/** "$2,400", "$1.2K", "USD 900", "900 dollars". */
const AMOUNT = new RegExp(String.raw`(?:US)?\$\s?${NUMBER}(?:\s?[KkMm]\b)?|\b(?:USD|EUR|GBP)\s?${NUMBER}|\b${NUMBER}\s?(?:dollars|USD)\b`, 'g');

/** Masks any amount of money in words. */
export function redactAmounts(text: string): string {
  return text.replace(AMOUNT, WITHHELD_TEXT);
}

/** What a masked amount reads as (the app draws it as a small lock). */
export const WITHHELD_TEXT = '[amount withheld]';

/** The tail of streamed text that may be the start of an amount still being written. */
const OPEN_TAIL = /(?:US|U|USD?|EUR?|GBP?|\$)?\s?[\d,.]*$/;

/**
 * Masks amounts in a reply as it streams: text that may be the start of an amount waits for the
 * next piece, so "$2," then "400" never shows the digits. `push` returns what may be shown now;
 * `end` returns the rest.
 */
export function streamRedactor(): { push(text: string): string; end(): string } {
  let held = '';
  return {
    push(text) {
      held += text;
      const tail = OPEN_TAIL.exec(held)?.[0] ?? '';
      const ready = held.slice(0, held.length - tail.length);
      held = tail;
      return redactAmounts(ready);
    },
    end() {
      const rest = redactAmounts(held);
      held = '';
      return rest;
    },
  };
}

/**
 * Card props without money, two ways to try against the card's schema: money fields set to null
 * (for nullable ones, like an issue card's headline amount), or left out (for optional ones). Amounts
 * in text are masked either way.
 */
export function withoutMoney(props: unknown, mode: 'null' | 'drop'): unknown {
  if (typeof props === 'string') return redactAmounts(props);
  if (Array.isArray(props)) return props.map((entry) => withoutMoney(entry, mode));
  if (props && typeof props === 'object') {
    const entries = Object.entries(props as Record<string, unknown>).flatMap(([key, entry]): [string, unknown][] => {
      if (MONEY_KEY.test(key) && entry !== null && typeof entry !== 'boolean') return mode === 'null' ? [[key, null]] : [];
      return [[key, withoutMoney(entry, mode)]];
    });
    return Object.fromEntries(entries);
  }
  return props;
}

/** Whether card props carry an amount (a money field with a value, or an amount in its text). */
export function carriesMoney(props: unknown): boolean {
  if (typeof props === 'string') return new RegExp(AMOUNT.source).test(props);
  if (Array.isArray(props)) return props.some(carriesMoney);
  if (props && typeof props === 'object') {
    return Object.entries(props as Record<string, unknown>).some(
      ([key, entry]) => (MONEY_KEY.test(key) && entry !== null && entry !== undefined && typeof entry !== 'boolean' && entry !== WITHHELD) || carriesMoney(entry),
    );
  }
  return false;
}
