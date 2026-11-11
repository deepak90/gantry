/**
 * What the voice is handed is said, not read: on a call Remy said "Mon, nov 2" and read amounts like a web
 * address ("eight thousand four hundred dot zero zero"). Days are in full words, whole dollars lose their
 * cents, a range says "to", and nothing is left to be read out as "dot". Numbers and names don't change.
 */
import { describe, expect, it } from 'vitest';
import { spoken } from '../../src/talk/spoken';

describe('text the voice is handed', () => {
  it('says days in full words', () => {
    expect(spoken('Chris set the forecast of Curtain wall (Mon, Nov 2 2:12 PM).')).toBe('Chris set the forecast of Curtain wall (Monday, November 2, at 2:12 PM).');
    expect(spoken('Fri, Feb 5, 2027')).toBe('Friday, February 5, 2027');
    expect(spoken('its work starts Mon, Mar 1')).toBe('its work starts Monday, March 1');
    expect(spoken('Tower crane: Jan 31 to Feb 13')).toBe('Tower crane: January 31 to February 13');
    expect(spoken('Sept 3 and May 28')).toBe('September 3 and May 28');
  });

  it('says whole dollars without cents, and keeps cents that are there', () => {
    expect(spoken('The payment is $8,400.00 for 14 days.')).toBe('The payment is $8,400 for 14 days.');
    expect(spoken('Paid $1,234.50 to Northgate Equipment Rental')).toBe('Paid $1,234.50 to Northgate Equipment Rental');
    expect(spoken('from $400,000.00 to $412,000.00')).toBe('from $400,000 to $412,000');
  });

  it('says a range as "to", and leaves nothing to read out as a dot', () => {
    expect(spoken('Booked Jan 31–Feb 13 · 14 days · $8,400.00')).toBe('Booked January 31 to February 13, 14 days, $8,400');
    expect(spoken('$1,200—$1,500')).toBe('$1,200 to $1,500');
    expect(spoken('Erect steel and metal deck · day 5 of 10')).toBe('Erect steel and metal deck, day 5 of 10');
  });

  it('leaves names and words that only look like days alone', () => {
    const said = 'Marcus is on the Monday pour; Lena moved the Sun deck, level 3 — build-out next. Version 2.00 of the plan.';
    expect(spoken(said)).toBe(said);
  });
});
