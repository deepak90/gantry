import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CallLimits, limitsFromEnv, type CallLimitsConfig } from '../src/limits.ts';

const HOSTED: CallLimitsConfig = { maxMs: 300_000, wrapUpMs: 30_000, silenceMs: 60_000 };

function call(config: CallLimitsConfig, state: { busy?: boolean } = {}) {
  const heard: string[] = [];
  const limits = new CallLimits(config, {
    busy: () => state.busy ?? false,
    wrapUp: () => heard.push(`wrap-up at ${Date.now() / 1000}`),
    timeUp: () => heard.push(`time up at ${Date.now() / 1000}`),
    silence: () => heard.push(`silence at ${Date.now() / 1000}`),
  });
  return { limits, heard, state };
}

/** Someone speaks every `everyS` seconds until `untilS`. */
function talk(limits: CallLimits, everyS: number, untilS: number): void {
  for (let at = everyS; at <= untilS; at += everyS) {
    vi.advanceTimersByTime(everyS * 1000);
    limits.activity();
  }
}

describe('limitsFromEnv', () => {
  it('is unlimited on the owner’s machine', () => {
    expect(limitsFromEnv({}).limits).toEqual({ maxMs: 0, wrapUpMs: 30_000, silenceMs: 0 });
    expect(limitsFromEnv({ GANTRY_HOSTED: '0' }).limits).toMatchObject({ maxMs: 0, silenceMs: 0 });
  });

  it('is five minutes a call and a minute of silence on the hosted worker', () => {
    expect(limitsFromEnv({ GANTRY_HOSTED: '1' }).limits).toEqual(HOSTED);
  });

  it('takes the values set, in either place, with 0 for unlimited', () => {
    expect(limitsFromEnv({ GANTRY_HOSTED: '1', REMY_CALL_MAX_S: '120', REMY_SILENCE_S: '0' }).limits).toMatchObject({ maxMs: 120_000, silenceMs: 0 });
    expect(limitsFromEnv({ REMY_CALL_MAX_S: '90', REMY_SILENCE_S: '45' }).limits).toMatchObject({ maxMs: 90_000, silenceMs: 45_000 });
  });

  it('ignores a value that is not a number of seconds, and says so', () => {
    expect(limitsFromEnv({ GANTRY_HOSTED: '1', REMY_CALL_MAX_S: 'five minutes', REMY_SILENCE_S: '-1' })).toEqual({ limits: HOSTED, ignored: ['REMY_CALL_MAX_S', 'REMY_SILENCE_S'] });
  });
});

describe('CallLimits', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => vi.useRealTimers());

  it('knows when the call ends once it starts, and has no end without a time limit', () => {
    vi.setSystemTime(1_000_000);
    const hosted = call(HOSTED).limits;
    expect(hosted.endsAt).toBeNull();
    hosted.start();
    expect(hosted.endsAt).toBe(1_300_000);
    vi.advanceTimersByTime(60_000);
    hosted.start(); // a second start changes nothing
    expect(hosted.endsAt).toBe(1_300_000);
    const local = call({ maxMs: 0, wrapUpMs: 30_000, silenceMs: 0 }).limits;
    local.start();
    expect(local.endsAt).toBeNull();
  });

  it('says the wrap-up line at 4:30 and ends the call at 5:00 while people talk', () => {
    const { limits, heard } = call(HOSTED);
    limits.start();
    talk(limits, 20, 260);
    expect(heard).toEqual([]);
    vi.advanceTimersByTime(9_999);
    expect(heard).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(heard).toEqual(['wrap-up at 270']);
    talk(limits, 10, 30);
    expect(heard).toEqual(['wrap-up at 270', 'time up at 300']);
    vi.advanceTimersByTime(3_600_000);
    expect(heard).toHaveLength(2);
  });

  it('says goodbye after a minute in which nobody spoke', () => {
    const { limits, heard } = call(HOSTED);
    limits.start();
    vi.advanceTimersByTime(59_999);
    expect(heard).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(heard).toEqual(['silence at 60']);
    // The call is over for her: no wrap-up, no time up.
    vi.advanceTimersByTime(3_600_000);
    expect(heard).toEqual(['silence at 60']);
  });

  it('starts the silence clock again whenever someone speaks', () => {
    const { limits, heard } = call(HOSTED);
    limits.start();
    vi.advanceTimersByTime(50_000);
    limits.activity();
    vi.advanceTimersByTime(59_999);
    expect(heard).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(heard).toEqual(['silence at 110']);
  });

  it('does not count talk under way, or an answer on its way, as silence', () => {
    const { limits, heard, state } = call(HOSTED, { busy: true });
    limits.start();
    vi.advanceTimersByTime(60_000);
    expect(heard).toEqual([]);
    state.busy = false;
    vi.advanceTimersByTime(60_000);
    expect(heard).toEqual(['silence at 120']);
  });

  it('ends a call that is shorter than the wrap-up without one', () => {
    const { limits, heard } = call({ maxMs: 20_000, wrapUpMs: 30_000, silenceMs: 0 });
    limits.start();
    vi.advanceTimersByTime(20_000);
    expect(heard).toEqual(['time up at 20']);
  });

  it('never fires when both limits are off', () => {
    const { limits, heard } = call({ maxMs: 0, wrapUpMs: 30_000, silenceMs: 0 });
    limits.start();
    vi.advanceTimersByTime(24 * 3_600_000);
    limits.activity();
    vi.advanceTimersByTime(24 * 3_600_000);
    expect(heard).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps time from start, not from when it was made, and stops for good', () => {
    const { limits, heard } = call(HOSTED);
    vi.advanceTimersByTime(100_000);
    limits.activity();
    expect(heard).toEqual([]);
    limits.start();
    talk(limits, 20, 280);
    limits.stop();
    expect(limits.over).toBe(true);
    vi.advanceTimersByTime(3_600_000);
    limits.start();
    limits.activity();
    vi.advanceTimersByTime(3_600_000);
    expect(heard).toEqual(['wrap-up at 370']);
    expect(vi.getTimerCount()).toBe(0);
  });
});
