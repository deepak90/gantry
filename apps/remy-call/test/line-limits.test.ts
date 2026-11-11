import { describe, expect, it } from 'vitest';
import { HOSTED_LINE_LIMITS, LineBudget, lineLimitsFromEnv } from '../src/line-limits.ts';

/** A call's budget on a clock the test moves. */
function budget(config = HOSTED_LINE_LIMITS) {
  let now = 1_794_081_000_000;
  const lines = new LineBudget({ ...config }, () => now);
  return { lines, later: (ms: number) => (now += ms) };
}

describe('what the host may hand Remy', () => {
  it('is limited on the hosted worker: 400 a line, 2,500 a call, 10 a minute, one waiting while one plays', () => {
    expect(lineLimitsFromEnv({ GANTRY_HOSTED: '1' }, 4000)).toEqual({ maxLineChars: 400, maxCallChars: 2500, linesPerMinute: 10, maxPending: 2 });
  });

  it('is only the line’s length on the owner’s machine', () => {
    const local = lineLimitsFromEnv({}, 4000);
    expect(local).toEqual({ maxLineChars: 4000, maxCallChars: Infinity, linesPerMinute: Infinity, maxPending: Infinity });
    const { lines } = budget(local);
    for (let index = 0; index < 50; index += 1) {
      expect(lines.refusal(4000, index)).toBeNull();
      lines.take(4000);
    }
    expect(lines.refusal(4001, 0)).toBe('too long');
  });

  it('refuses a line over 400 characters', () => {
    const { lines } = budget();
    expect(lines.refusal(400, 0)).toBeNull();
    expect(lines.refusal(401, 0)).toBe('too long');
  });

  it('refuses a line that would take the call past 2,500 characters of answers, and only counts lines taken', () => {
    const { lines, later } = budget();
    for (let index = 0; index < 6; index += 1) {
      expect(lines.refusal(400, 0)).toBeNull();
      lines.take(400);
      later(10_000);
    }
    expect(lines.spent).toBe(2400);
    expect(lines.refusal(101, 0)).toBe('call budget spent');
    // Refused lines cost nothing: one that fits is still taken.
    expect(lines.refusal(100, 0)).toBeNull();
    lines.take(100);
    expect(lines.refusal(1, 0)).toBe('call budget spent');
  });

  it('refuses an eleventh line within a minute, and takes lines again as the minute moves on', () => {
    const { lines, later } = budget();
    for (let index = 0; index < 10; index += 1) {
      expect(lines.refusal(20, 0)).toBeNull();
      lines.take(20);
      later(1_000);
    }
    expect(lines.refusal(20, 0)).toBe('too many lines');
    // The first line was taken 10 s ago... 60 s after it, there is room for one more.
    later(50_001);
    expect(lines.refusal(20, 0)).toBeNull();
  });

  it('keeps one line waiting while one plays, and no more', () => {
    const { lines } = budget();
    expect(lines.refusal(20, 0)).toBeNull();
    expect(lines.refusal(20, 1)).toBeNull();
    expect(lines.refusal(20, 2)).toBe('busy');
  });
});
