import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TurnAssembler, type Turn } from '../src/turns.ts';

describe('TurnAssembler', () => {
  let turns: Turn[];
  let t0: number;
  let a: TurnAssembler;
  const at = (ms: number) => t0 + ms;
  /** Moves the clock to `ms` after the start, then does what happens there. */
  const when = (ms: number, act?: () => void) => {
    vi.advanceTimersByTime(at(ms) - Date.now());
    act?.();
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    t0 = Date.now();
    turns = [];
    a = new TurnAssembler('nora', (turn) => turns.push(turn));
  });
  afterEach(() => vi.useRealTimers());

  it('hands a turn over when the final arrives after the person went quiet', () => {
    when(0, () => a.speechStarted(at(0)));
    when(1400, () => a.speechEnded(at(1400))); // the detector's end, 400 ms after the last word
    when(1900, () => a.final('Remy, when do we get paid for the footings?', at(1900)));
    expect(turns).toEqual([
      { identity: 'nora', text: 'Remy, when do we get paid for the footings?', startedAt: at(0), endedAt: at(1000), segments: 1, reason: 'final' },
    ]);
  });

  it('waits out the hold when the final is quick', () => {
    when(0, () => a.speechStarted(at(0)));
    when(1400, () => a.speechEnded(at(1400)));
    when(1500, () => a.final('Okay.', at(1500)));
    expect(turns).toEqual([]);
    when(1649);
    expect(turns).toEqual([]);
    when(1650);
    expect(turns.map((t) => [t.text, t.reason])).toEqual([['Okay.', 'quiet']]);
  });

  it('keeps one turn across a pause the person picks up from', () => {
    when(0, () => a.speechStarted(at(0)));
    when(900, () => a.speechEnded(at(900)));
    when(1200, () => a.speechStarted(at(1200))); // back before the first part's final arrived
    when(1450, () => a.final('Remy, can you', at(1450)));
    when(3000, () => a.speechEnded(at(3000)));
    when(3600, () => a.final("let's move the crane to Monday.", at(3600)));
    expect(turns.map((t) => [t.text, t.segments, t.startedAt, t.endedAt])).toEqual([["Remy, can you let's move the crane to Monday.", 2, at(0), at(2600)]]);
  });

  it('splits turns at a pause long enough for the first part to arrive', () => {
    when(0, () => a.speechStarted(at(0)));
    when(900, () => a.speechEnded(at(900)));
    when(1500, () => a.final('Remy?', at(1500)));
    when(2500, () => a.speechStarted(at(2500)));
    when(4000, () => a.speechEnded(at(4000)));
    when(4600, () => a.final('Can you check the crane?', at(4600)));
    expect(turns.map((t) => t.text)).toEqual(['Remy?', 'Can you check the crane?']);
  });

  it('gives up waiting for a final after the safety time', () => {
    when(0, () => a.speechStarted(at(0)));
    when(500, () => a.final('Remy, the crane', at(500))); // a final from before the detector's end
    when(1000, () => a.speechEnded(at(1000)));
    when(2999);
    expect(turns).toEqual([]);
    when(3000);
    expect(turns.map((t) => [t.text, t.reason])).toEqual([['Remy, the crane', 'safety']]);
  });

  it('hands a late final over at once', () => {
    when(0, () => a.speechStarted(at(0)));
    when(1000, () => a.speechEnded(at(1000)));
    when(4000, () => a.final('Thanks.', at(4000)));
    expect(turns.map((t) => [t.text, t.reason])).toEqual([['Thanks.', 'final']]);
  });

  it('waits a little longer for more when an address may not be over', () => {
    const held = new TurnAssembler('deepak', (turn) => turns.push(turn), { holdOpen: (text) => text.endsWith('?') && text.length < 20 });
    when(0, () => held.speechStarted(at(0)));
    when(1400, () => held.speechEnded(at(1400))); // speech ended at 1000
    when(1750, () => held.final('Remy. You on?', at(1750)));
    expect(turns).toEqual([]);
    when(1830, () => held.speechStarted(at(1830))); // goes on 830 ms after the speech ended
    when(4000, () => held.speechEnded(at(4000)));
    when(4600, () => held.final("Okay. So, um, what'd I miss?", at(4600)));
    expect(turns.map((t) => [t.text, t.segments])).toEqual([["Remy. You on? Okay. So, um, what'd I miss?", 2]]);
  });

  it('hands an unfinished address over once the wait is up', () => {
    const held = new TurnAssembler('deepak', (turn) => turns.push(turn), { holdOpen: () => true });
    when(0, () => held.speechStarted(at(0)));
    when(1400, () => held.speechEnded(at(1400)));
    when(1750, () => held.final('Remy?', at(1750)));
    when(2199);
    expect(turns).toEqual([]);
    when(2200); // 1.2 s after the speech ended
    expect(turns.map((t) => [t.text, t.endedAt])).toEqual([['Remy?', at(1000)]]);
  });

  it('flushes on close and reports who is speaking', () => {
    when(0, () => a.speechStarted(at(0)));
    expect(a.speaking).toBe(true);
    when(200, () => a.final('Remy—', at(200)));
    a.close();
    expect(turns.map((t) => t.reason)).toEqual(['close']);
  });
});
