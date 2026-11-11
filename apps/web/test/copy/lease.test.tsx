/**
 * Keeping the copy: touch_copy every 2 minutes while the tab is visible, once more on coming back to a tab hidden for
 * longer, never while hidden. A refused touch means the copy was reset; touches that can't get through only give up
 * once the lease has run out by this browser's clock. The header says when the session ends in its last 10 minutes.
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { LeaseClock, LeaseKeeper, sessionEndsText, TOUCH_EVERY_MS, type LeaseOptions } from '../../src/copy/lease';
import { CopyError } from '../../src/copy/rpc';
import { SessionEnds } from '../../src/copy/SessionEnds';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function harness(overrides: Partial<LeaseOptions> = {}) {
  let now = Date.parse('2026-11-11T18:00:00Z');
  let visible = true;
  let tick: (() => void) | null = null;
  let onVisibility: (() => void) | null = null;
  const touch = vi.fn<() => Promise<string | null>>(async () => new Date(now + 30 * 60_000).toISOString());
  const onGone = vi.fn();
  const onError = vi.fn();
  const keeper = new LeaseKeeper({
    touch,
    onGone,
    onError,
    leaseUntil: new Date(now + 30 * 60_000).toISOString(),
    now: () => now,
    visible: () => visible,
    onVisibilityChange: (listener) => {
      onVisibility = listener;
      return () => {
        onVisibility = null;
      };
    },
    setTimer: (run, ms) => {
      expect(ms).toBe(TOUCH_EVERY_MS);
      tick = run;
      return () => {
        tick = null;
      };
    },
    ...overrides,
  });
  return {
    keeper,
    touch,
    onGone,
    onError,
    /** Time passes and the interval fires. */
    async every(minutes = 2) {
      now += minutes * 60_000;
      tick?.();
      await Promise.resolve();
      await Promise.resolve();
    },
    async show(after: number) {
      now += after * 60_000;
      visible = true;
      onVisibility?.();
      await Promise.resolve();
      await Promise.resolve();
    },
    hide() {
      visible = false;
      onVisibility?.();
    },
    get ticking() {
      return tick !== null;
    },
  };
}

describe('LeaseKeeper', () => {
  it('touches the copy every 2 minutes while the tab is visible', async () => {
    const lease = harness();
    lease.keeper.start();
    expect(lease.touch).not.toHaveBeenCalled();
    await lease.every();
    await lease.every();
    expect(lease.touch).toHaveBeenCalledTimes(2);
    expect(lease.keeper.until).toBe(Date.parse('2026-11-11T18:34:00Z'));
  });

  it('does not touch while hidden, and touches at once on coming back after a while', async () => {
    const lease = harness();
    lease.keeper.start();
    lease.hide();
    await lease.every();
    await lease.every();
    expect(lease.touch).not.toHaveBeenCalled();
    await lease.show(1);
    expect(lease.touch).toHaveBeenCalledTimes(1);
  });

  it('does not touch again on coming back to a tab touched a moment ago', async () => {
    const lease = harness();
    lease.keeper.start();
    await lease.every();
    lease.hide();
    await lease.show(0.5);
    expect(lease.touch).toHaveBeenCalledTimes(1);
  });

  it('gives the copy up when the database refuses a touch, once, and stops', async () => {
    const lease = harness();
    lease.touch.mockRejectedValue(new CopyError('This copy was reset.', 'P0001'));
    lease.keeper.start();
    await lease.every();
    expect(lease.onGone).toHaveBeenCalledTimes(1);
    expect(lease.keeper.isGone).toBe(true);
    expect(lease.ticking).toBe(false);
    await lease.keeper.touch();
    expect(lease.touch).toHaveBeenCalledTimes(1);
    expect(lease.onGone).toHaveBeenCalledTimes(1);
  });

  it('tries again after a touch that did not get through, until the lease has run out', async () => {
    const lease = harness();
    lease.touch.mockRejectedValue(new CopyError('TypeError: Failed to fetch'));
    lease.keeper.start();
    await lease.every();
    expect(lease.onError).toHaveBeenCalledTimes(1);
    expect(lease.onGone).not.toHaveBeenCalled();
    // The lease ends 30 minutes after it was last kept.
    await lease.every(30);
    expect(lease.onGone).toHaveBeenCalledTimes(1);
  });

  it('keeps the last known end when the database doesn’t say a new one', async () => {
    const lease = harness();
    lease.touch.mockResolvedValue(null);
    lease.keeper.start();
    await lease.every();
    expect(lease.keeper.until).toBe(Date.parse('2026-11-11T18:30:00Z'));
    expect(lease.onGone).not.toHaveBeenCalled();
  });

  it('stops touching when stopped', async () => {
    const lease = harness();
    lease.keeper.start();
    lease.keeper.stop();
    expect(lease.ticking).toBe(false);
  });
});

describe('the time left, near Start over', () => {
  const at = Date.parse('2026-11-11T20:00:00Z');

  it('is said only in the session’s last 10 minutes', () => {
    expect(sessionEndsText(null, at)).toBeNull();
    expect(sessionEndsText(at + 30 * 60_000, at)).toBeNull();
    expect(sessionEndsText(at + 10 * 60_000, at)).toBeNull();
    expect(sessionEndsText(at + 9 * 60_000 + 59_000, at)).toBe('This session ends in 10 min');
    expect(sessionEndsText(at + 8 * 60_000, at)).toBe('This session ends in 8 min');
    expect(sessionEndsText(at + 90_000, at)).toBe('This session ends in 2 min');
    expect(sessionEndsText(at + 45_000, at)).toBe('This session ends in less than a minute');
    expect(sessionEndsText(at - 5_000, at)).toBe('This session ends in less than a minute');
  });

  it('follows the lease as each touch moves it', async () => {
    const onLease = vi.fn();
    const later = new Date(Date.parse('2026-11-11T18:00:00Z') + 32 * 60_000).toISOString();
    const lease = harness({ onLease, touch: vi.fn(async () => later) });
    lease.keeper.start();
    await lease.every();
    expect(onLease).toHaveBeenCalledWith(Date.parse(later));
    await lease.every();
    expect(onLease).toHaveBeenCalledTimes(1);
  });

  it('is kept for React in a clock that tells its listeners when it moves', () => {
    const clock = new LeaseClock('2026-11-11T20:00:00Z');
    expect(clock.get()).toBe(at);
    const listener = vi.fn();
    const stop = clock.subscribe(listener);
    clock.set(at);
    expect(listener).not.toHaveBeenCalled();
    clock.set(at + 60_000);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(clock.get()).toBe(at + 60_000);
    stop();
    clock.set(at + 120_000);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('shows in the header as the end comes near, and not before', async () => {
    const clock = new LeaseClock(new Date(at + 25 * 60_000).toISOString());
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<SessionEnds clock={clock} now={() => at} />));
    expect(host.textContent).toBe('');
    await act(async () => clock.set(at + 8 * 60_000));
    expect(host.querySelector('[data-testid="session-ends"]')?.textContent).toBe('This session ends in 8 min');
    await act(async () => root.unmount());
    host.remove();
  });
});
