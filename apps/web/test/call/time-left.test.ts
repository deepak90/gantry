/**
 * The time left on a call, as the call bar shows it: minutes and seconds rounded up, amber in the last 30 seconds, and
 * where the moment comes from: Remy's `remy.ends_at` attribute, set by her worker, read on this tab's clock unless that
 * clock is seconds off the call server's.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ENDS_AT, endsAtOf } from '../../src/call/protocol';
import { CLOCK_TOLERANCE_MS, clockOffsetOf, ENDING_MS, formatTimeLeft, isEnding, localEndsAt, msLeft, spokenTimeLeft } from '../../src/call/time-left';

describe('the time left, in words', () => {
  it('reads as minutes and seconds, rounded up to the second', () => {
    expect(formatTimeLeft(300_000)).toBe('5:00 left');
    expect(formatTimeLeft(299_001)).toBe('5:00 left');
    expect(formatTimeLeft(299_000)).toBe('4:59 left');
    expect(formatTimeLeft(252_000)).toBe('4:12 left');
    expect(formatTimeLeft(9_400)).toBe('0:10 left');
    expect(formatTimeLeft(500)).toBe('0:01 left');
    expect(formatTimeLeft(0)).toBe('0:00 left');
    expect(formatTimeLeft(-5_000)).toBe('0:00 left');
    expect(formatTimeLeft(3_723_000)).toBe('1:02:03 left');
  });

  it('is said in words for a screen reader', () => {
    expect(spokenTimeLeft(252_000)).toBe('4 minutes 12 seconds left on the call');
    expect(spokenTimeLeft(60_000)).toBe('1 minute left on the call');
    expect(spokenTimeLeft(1_000)).toBe('1 second left on the call');
    expect(spokenTimeLeft(0)).toBe('0 seconds left on the call');
  });

  it('turns amber for the last 30 seconds, when Remy says she has to drop off', () => {
    expect(ENDING_MS).toBe(30_000);
    expect(isEnding(30_001)).toBe(false);
    expect(isEnding(30_000)).toBe(true);
    expect(isEnding(0)).toBe(true);
  });

  it('never runs below zero', () => {
    expect(msLeft(10_000, 4_000)).toBe(6_000);
    expect(msLeft(10_000, 14_000)).toBe(0);
  });
});

describe('where the time comes from', () => {
  it('is Remy’s attribute: the moment her worker ends the call, in ms since the epoch', () => {
    expect(ENDS_AT).toBe('remy.ends_at');
    expect(endsAtOf({ 'remy.ends_at': '1794081541139', 'lk.agent.state': 'listening' })).toBe(1_794_081_541_139);
    expect(endsAtOf({ 'lk.agent.state': 'listening' })).toBeNull();
    expect(endsAtOf(undefined)).toBeNull();
    // An attribute is deleted by setting it empty.
    expect(endsAtOf({ 'remy.ends_at': '' })).toBeNull();
    for (const raw of ['soon', '-5', '12.5', '0', '1e15']) expect(endsAtOf({ 'remy.ends_at': raw }), raw).toBeNull();
  });

  it('has the name her worker sets it under', () => {
    const worker = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../remy-call/src/messages.ts'), 'utf8');
    expect(worker).toContain(`ENDS_AT_ATTRIBUTE = '${ENDS_AT}'`);
  });

  it('takes this tab’s clock as right within two seconds of the server’s (the join’s own delay)', () => {
    expect(CLOCK_TOLERANCE_MS).toBe(2_000);
    expect(clockOffsetOf(1_000_000, 1_000_400)).toBe(0);
    expect(clockOffsetOf(1_001_900, 1_000_000)).toBe(0);
    expect(clockOffsetOf(0, 1_000_000)).toBe(0);
    expect(clockOffsetOf(Number.NaN, 1_000_000)).toBe(0);
  });

  it('counts down to the worker’s moment on a tab whose clock is minutes off', () => {
    // This tab's clock is three minutes slow: the server's says 12:03 when this one says 12:00.
    const offset = clockOffsetOf(1_000_180_000, 1_000_000_000);
    expect(offset).toBe(180_000);
    const serverEndsAt = 1_000_480_000;
    expect(localEndsAt(serverEndsAt, offset)).toBe(1_000_300_000);
    expect(formatTimeLeft(msLeft(localEndsAt(serverEndsAt, offset)!, 1_000_000_000))).toBe('5:00 left');
    expect(localEndsAt(null, offset)).toBeNull();
  });
});
