/**
 * The hosted worker takes lines of at most 400 characters as her voice is given them, so a longer answer is handed over
 * in parts: at the ends of sentences, else between words, each part the answer's own words in order.
 */
import { describe, expect, it } from 'vitest';
import { speakable, voiceParts } from '../../src/call/speech';

const squeezed = (text: string) => text.replace(/\s+/g, ' ').trim();

describe('a line in parts for the voice', () => {
  it('is one part when it fits, and none when empty', () => {
    expect(voiceParts('  The crane is idle.\n\nIt costs $1,200.00 a day.  ', 400)).toEqual(['The crane is idle. It costs $1,200.00 a day.']);
    expect(voiceParts('   ', 400)).toEqual([]);
  });

  it('cuts at the ends of sentences, never inside an amount, each part within the limit as said', () => {
    const line = 'The crane is idle from Mon, Nov 30 to Wed, Dec 2. It costs $1,200.00 a day. The steel is late. Pay Granite on Friday.';
    const parts = voiceParts(line, 70);
    expect(parts).toEqual(['The crane is idle from Mon, Nov 30 to Wed, Dec 2.', 'It costs $1,200.00 a day. The steel is late. Pay Granite on Friday.']);
    for (const part of parts) expect(speakable(part).length).toBeLessThanOrEqual(70);
  });

  it('cuts a sentence too long on its own between words', () => {
    const line = `${Array.from({ length: 40 }, (_, index) => `word${index}`).join(' ')}.`;
    const parts = voiceParts(line, 50);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(speakable(part).length).toBeLessThanOrEqual(50);
    expect(parts.join(' ')).toBe(line);
  });

  it('keeps every part a stretch of the line, so a signed reply still covers it', () => {
    const line = 'First things first.\nThe slab pour moves to Thursday, which frees the pump on Wednesday.   Then the crane can start a day early. That saves $3,600.00 in rental.';
    for (const part of voiceParts(line, 70)) expect(squeezed(line)).toContain(part);
  });
});
