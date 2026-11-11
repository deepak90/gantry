// @vitest-environment node
/**
 * The names people take in a session: thirty, each first and last name different, none the film's people, and the
 * same list as the database's (`copy_seat_names()`), which has the last word. Suggestions leave out the names in use
 * and come shuffled.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { nameSuggestions, SEAT_NAMES, seatTitle } from '../../src/copy/names';

const migration = readFileSync(fileURLToPath(new URL('../../../../supabase/migrations/20261111010000_session_codes_and_names.sql', import.meta.url)), 'utf8');

/** The names in the migration's `copy_seat_names()`, in order. */
function databaseNames(): string[] {
  const body = /create or replace function public\.copy_seat_names\(\)[\s\S]*?array\[([\s\S]*?)\]::text\[\]/.exec(migration)?.[1];
  if (!body) throw new Error('copy_seat_names() not found in the migration');
  return [...body.matchAll(/'([^']+)'/g)].map((match) => match[1]!);
}

describe('the names', () => {
  it('are the database’s list, in the same order', () => {
    expect(databaseNames()).toEqual([...SEAT_NAMES]);
  });

  it('are thirty first and last names, none used twice and none the film’s people', () => {
    expect(SEAT_NAMES).toHaveLength(30);
    expect(new Set(SEAT_NAMES.map((name) => name.split(' ')[0])).size).toBe(30);
    expect(new Set(SEAT_NAMES.map((name) => name.split(' ')[1])).size).toBe(30);
    for (const name of SEAT_NAMES) expect(name).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
    expect(SEAT_NAMES.some((name) => /Deepak|Jayaram|Chris|Hale|Remy|Gantry/.test(name))).toBe(false);
  });

  it('suggest every free name once, in a shuffled order', () => {
    const taken = ['Riley Brooks', 'Avery Patel'];
    const suggested = nameSuggestions(taken);
    expect(suggested).toHaveLength(28);
    expect(new Set(suggested)).toEqual(new Set(SEAT_NAMES.filter((name) => !taken.includes(name))));
  });

  it('shuffle with the randomness given', () => {
    expect(nameSuggestions([], () => 0.999999)).toEqual([...SEAT_NAMES]);
    // Every pick of 0 rotates the list by one.
    expect(nameSuggestions([], () => 0)[0]).toBe(SEAT_NAMES[1]);
  });

  it('say who the person will be: whoever starts the session is its construction manager', () => {
    expect(seatTitle(true)).toBe('construction manager');
    expect(seatTitle(false)).toBe('project manager');
  });
});
