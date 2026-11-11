/**
 * Reading what you said: the amount you named (not the one you said to replace), and which line your
 * words are about.
 */
import { describe, expect, it } from 'vitest';
import { amountIn, mentions, namingWords } from '../../src/rails/said';

describe('what you said', () => {
  it('finds the amount you named, however it was written down', () => {
    expect(amountIn('The fixtures will cost more like 7,500.')).toBe(7500);
    expect(amountIn('make it $7600')).toBe(7600);
    expect(amountIn('around 7.6k a wing')).toBe(7600);
    expect(amountIn('about 7.5 thousand')).toBe(7500);
    expect(amountIn('7600.00 for the fixtures')).toBe(7600);
  });

  it('skips the amount you said to replace, and numbers that aren’t prices', () => {
    expect(amountIn('no, this needs to be around 7,500 instead of 6,000')).toBe(7500);
    expect(amountIn('not 6,000, make it 7,500')).toBe(7500);
    expect(amountIn('from 6000 to 7500')).toBe(7500);
    expect(amountIn('the level 2 fixtures are 7,500')).toBe(7500);
    expect(amountIn('the fixtures cost more')).toBeNull();
  });

  it('matches your words to a line, by the words that name something', () => {
    expect(namingWords('The fixtures will cost more like 7,500.')).toEqual(['fixtures']);
    expect(mentions('the fixtures cost more like 7,500', 'Order light fixtures')).toBe(1);
    expect(mentions('the electrician’s labor is more like 6,000', 'Install light fixtures Halden Electrical 100%')).toBe(1);
    expect(mentions('the fixtures cost more like 7,500', 'Test lighting')).toBe(0);
  });

  it('matches a word once its ending is off, so "the wiring" finds the task that wires', () => {
    expect(mentions('the wiring is about seven grand', 'Install and wire light fixtures')).toBe(1);
    expect(mentions('the ordering', 'Order light fixtures, levels 1 to 3')).toBe(1);
    expect(mentions('the wiring', 'Order light fixtures')).toBe(0);
  });

  it('matches a word to the longer one it starts, so "testing" finds the Test task', () => {
    expect(mentions('the testing is actually 1,200', 'Test lighting circuits and controls')).toBe(1);
    expect(mentions('the install is 6,000', 'Install light fixtures')).toBe(1);
  });
});

describe('amounts said in words', () => {
  it('are read the way a transcript writes them out', async () => {
    const { amountIn, amountsInWords } = await import('../../src/rails/said');
    expect(amountIn("Twelve? What are we— what are we buying, desk lamps? Remy, it's more like thirty-five thousand a floor.")).toBe(35_000);
    expect(amountIn('a hundred and five thousand')).toBe(105_000);
    expect(amountIn('forty-two hundred dollars')).toBe(4_200);
    expect(amountIn('not twelve thousand, thirty-five thousand')).toBe(35_000);
    expect(amountIn('five six seven')).toBeNull();
    expect(amountsInWords('twelve, then thirty five thousand').map((found) => found.value)).toEqual([12, 35_000]);
  });
});
