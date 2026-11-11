/**
 * A signed line is written for Remy's voice by the worker, as the page writes the lines it hands her
 * (apps/web/test/call/thread.test.ts and apps/web/test/talk/spoken.test.ts have the same cases).
 */
import { describe, expect, it } from 'vitest';
import { spokenDates, voiceLine } from '../src/for-voice.ts';

describe('a reply, as Remy’s voice is given it', () => {
  it('says a task link by its name and drops marks for emphasis', () => {
    expect(voiceLine('I moved [Erect crane](task:3104) to **Monday**.')).toBe('I moved Erect crane to Monday.');
    expect(voiceLine('It’s _only_ two days, `today`.')).toBe('It’s only two days, today.');
  });

  it('says days and money the way people say them', () => {
    expect(voiceLine('Booked from Mon, Nov 30 for $8,400.00.')).toBe('Booked from Monday, November 30 for $8,400.');
  });

  it('runs the lines of a reply into one', () => {
    expect(voiceLine('  Two things.\n\nFirst, the crane.  ')).toBe('Two things. First, the crane.');
  });
});

describe('days and money', () => {
  it('says days in full words', () => {
    expect(spokenDates('Chris set the forecast of Curtain wall (Mon, Nov 2 2:12 PM).')).toBe('Chris set the forecast of Curtain wall (Monday, November 2, at 2:12 PM).');
    expect(spokenDates('Fri, Feb 5, 2027')).toBe('Friday, February 5, 2027');
    expect(spokenDates('Tower crane: Jan 31 to Feb 13')).toBe('Tower crane: January 31 to February 13');
    expect(spokenDates('Sept 3 and May 28')).toBe('September 3 and May 28');
  });

  it('says whole dollars without cents, and keeps cents that are there', () => {
    expect(spokenDates('The payment is $8,400.00 for 14 days.')).toBe('The payment is $8,400 for 14 days.');
    expect(spokenDates('Paid $1,234.50 to Northgate Equipment Rental')).toBe('Paid $1,234.50 to Northgate Equipment Rental');
  });

  it('says a range as "to", and leaves nothing to read out as a dot', () => {
    expect(spokenDates('Booked Jan 31–Feb 13 · 14 days · $8,400.00')).toBe('Booked January 31 to February 13, 14 days, $8,400');
    expect(spokenDates('$1,200—$1,500')).toBe('$1,200 to $1,500');
  });

  it('leaves names and words that only look like days alone', () => {
    const said = 'Marcus is on the Monday pour; Lena moved the Sun deck, level 3 — build-out next. Version 2.00 of the plan.';
    expect(spokenDates(said)).toBe(said);
  });
});
