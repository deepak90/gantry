import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FILLERS } from '../src/config.ts';
import { FillerScheduler, fillerDueAt, pickFiller } from '../src/filler.ts';

const [FIRST, SECOND, THIRD] = FILLERS;

/** `random` 0 picks the first filler she hasn't said lately, so the order can be told. */
function scheduler(state: { busy?: boolean; floor?: boolean; ready?: (text: string) => boolean } = {}, random: () => number = () => 0) {
  const played: string[] = [];
  const s = new FillerScheduler({ busy: () => state.busy ?? false, floorTaken: () => state.floor ?? false, ready: (text) => state.ready?.(text) ?? true, play: (text) => played.push(text) }, { random });
  return { s, played, state };
}

/** A repeatable stand-in for Math.random (mulberry32). */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

describe('the fillers', () => {
  it('are several, all different, each a few words in one breath', () => {
    expect(FILLERS.length).toBeGreaterThanOrEqual(6);
    expect(new Set(FILLERS).size).toBe(FILLERS.length);
    for (const text of FILLERS) {
      expect(text.split(' ').length, text).toBeLessThanOrEqual(4);
      expect(text, text).toMatch(/^[A-Z][a-z' ]+\.$/);
    }
  });

  it('are not all "check"', () => {
    expect(FILLERS.filter((text) => /check/i.test(text)).length).toBeLessThanOrEqual(1);
  });
});

describe('pickFiller', () => {
  const ALL = ['A.', 'B.', 'C.', 'D.', 'E.', 'F.'];

  it('picks any of them at first', () => {
    expect(pickFiller(ALL, [], () => 0)).toBe('A.');
    expect(pickFiller(ALL, [], () => 0.999)).toBe('F.');
  });

  it('never the last one said, nor any of the last half of the set', () => {
    for (let r = 0; r < 1; r += 0.05) expect(['A.', 'B.', 'C.']).toContain(pickFiller(ALL, ['D.', 'E.', 'F.'], () => r));
    expect(pickFiller(ALL, ['F.', 'A.', 'B.', 'C.'], () => 0)).toBe('D.');
  });

  it('says none rather than the same one twice in a row', () => {
    expect(pickFiller(['A.'], ['A.'])).toBeNull();
    expect(pickFiller(['A.', 'B.'], ['A.'], () => 0)).toBe('B.');
    expect(pickFiller(['A.', 'B.'], ['B.'], () => 0.9)).toBe('A.');
  });

  it('over a long call: never the same twice in a row, each back only after half the others, and all of them used', () => {
    const random = seeded(7);
    const said: string[] = [];
    for (let n = 0; n < 60; n++) said.push(pickFiller(FILLERS, said, random)!);
    const half = Math.floor(FILLERS.length / 2);
    for (let i = 1; i < said.length; i++) {
      const gap = said.slice(Math.max(0, i - half), i);
      expect(gap, `pick ${i}: ${said[i]}`).not.toContain(said[i]);
    }
    for (const text of FILLERS) expect(said.filter((s) => s === text).length, text).toBeGreaterThanOrEqual(4);
  });

  it('starts a call on different fillers', () => {
    const firsts = new Set(Array.from({ length: 20 }, (_, n) => pickFiller(FILLERS, [], seeded(n + 1))));
    expect(firsts.size).toBeGreaterThan(3);
  });
});

describe('fillerDueAt', () => {
  it('is 1.2 s after the line ended, but never before the line was heard plus 250 ms', () => {
    expect(fillerDueAt(10_000, 10_900)).toBe(11_200);
    expect(fillerDueAt(10_000, 11_600)).toBe(11_850);
  });
});

describe('FillerScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
  });
  afterEach(() => vi.useRealTimers());

  it('says one filler 1.2 s after an addressed line ended', () => {
    const { s, played } = scheduler();
    s.addressed(Date.now() - 300); // heard 300 ms after the line ended
    vi.advanceTimersByTime(899);
    expect(played).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(played).toEqual([FIRST]);
  });

  it('says it at once (after the grace) when the transcript came late', () => {
    const { s, played } = scheduler();
    s.addressed(Date.now() - 1500);
    vi.advanceTimersByTime(249);
    expect(played).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(played).toEqual([FIRST]);
  });

  it('says nothing when the line arrives first', () => {
    const { s, played } = scheduler();
    s.addressed(Date.now() - 300);
    vi.advanceTimersByTime(500);
    s.lineArrived();
    vi.advanceTimersByTime(5000);
    expect(played).toEqual([]);
  });

  it('never says two fillers in a row, and takes turns with the words', () => {
    const { s, played } = scheduler();
    s.addressed(Date.now());
    vi.advanceTimersByTime(1200);
    s.addressed(Date.now());
    vi.advanceTimersByTime(5000);
    expect(played).toEqual([FIRST]);
    s.lineArrived();
    s.addressed(Date.now());
    vi.advanceTimersByTime(1200);
    expect(played).toEqual([FIRST, SECOND]);
  });

  it('stays quiet while Remy is talking or has a line on its way', () => {
    const { s, played, state } = scheduler({ busy: true });
    s.addressed(Date.now());
    vi.advanceTimersByTime(5000);
    expect(played).toEqual([]);
    state.busy = false;
    s.addressed(Date.now());
    vi.advanceTimersByTime(1200);
    expect(played).toEqual([FIRST]);
  });

  it('waits for someone talking to stop, then gives up', () => {
    const { s, played, state } = scheduler({ floor: true });
    s.addressed(Date.now());
    vi.advanceTimersByTime(1200 + 400);
    expect(played).toEqual([]);
    state.floor = false;
    vi.advanceTimersByTime(100);
    expect(played).toEqual([FIRST]);

    s.lineArrived();
    state.floor = true;
    s.addressed(Date.now());
    vi.advanceTimersByTime(1200 + 1500 + 100);
    state.floor = false;
    vi.advanceTimersByTime(5000);
    expect(played).toEqual([FIRST]);
  });

  it('says only fillers whose sound is ready, and none when none is', () => {
    const { s, played, state } = scheduler({ ready: (text) => text !== FIRST });
    s.addressed(Date.now());
    vi.advanceTimersByTime(1200);
    expect(played).toEqual([SECOND]);
    s.lineArrived();
    s.addressed(Date.now());
    vi.advanceTimersByTime(1200);
    expect(played).toEqual([SECOND, THIRD]);
    s.lineArrived();
    state.ready = () => false;
    s.addressed(Date.now());
    vi.advanceTimersByTime(5000);
    expect(played).toEqual([SECOND, THIRD]);
    state.ready = () => true;
    s.addressed(Date.now()); // nothing was said last time, so this one may have a filler
    vi.advanceTimersByTime(1200);
    expect(played).toHaveLength(3);
  });

  it('never says the same filler twice in a row, on and on', () => {
    const { s, played } = scheduler({}, seeded(3));
    for (let n = 0; n < 30; n++) {
      s.addressed(Date.now());
      vi.advanceTimersByTime(1200);
      s.lineArrived();
    }
    expect(played).toHaveLength(30);
    for (let i = 1; i < played.length; i++) expect(played[i], `filler ${i}`).not.toBe(played[i - 1]);
    expect(new Set(played).size).toBe(FILLERS.length);
  });

  it('says none when the only filler ready is the one she said last', () => {
    const { s, played, state } = scheduler({ ready: (text) => text === FIRST });
    s.addressed(Date.now());
    vi.advanceTimersByTime(1200);
    s.lineArrived();
    s.addressed(Date.now());
    vi.advanceTimersByTime(1200);
    expect(played).toEqual([FIRST]);
    s.lineArrived();
    state.ready = () => true;
    s.addressed(Date.now());
    vi.advanceTimersByTime(1200);
    expect(played).toEqual([FIRST, SECOND]);
  });
});
