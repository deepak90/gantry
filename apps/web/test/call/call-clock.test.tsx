/**
 * The time left on the call bar: counting down to the moment the call ends, read again each second, calm, then amber
 * for the last 30 seconds, when Remy says she has to drop off; nothing on a call without a limit.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CallClock } from '../../src/call/CallStrip';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

function mount(node: React.ReactNode): void {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(node));
}

const clock = () => document.querySelector<HTMLElement>('[data-testid="call-time"]');

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('the time left on the call bar', () => {
  it('counts down to the moment the call ends, calm, then amber for the last 30 seconds', () => {
    vi.setSystemTime(1_000_000);
    mount(<CallClock endsAt={1_000_000 + 252_000} />);
    expect(clock()!.textContent).toBe('4:12 left');
    expect(clock()!.dataset.ending).toBe('false');
    expect(clock()!.getAttribute('role')).toBe('timer');
    expect(clock()!.getAttribute('aria-label')).toBe('4 minutes 12 seconds left on the call');
    // It reads the clock again just after each whole second.
    act(() => vi.advanceTimersByTime(1_005));
    expect(clock()!.textContent).toBe('4:11 left');
    act(() => vi.advanceTimersByTime(221_000));
    expect(clock()!.textContent).toBe('0:30 left');
    expect(clock()!.dataset.ending).toBe('true');
    expect(clock()!.className).toContain('is-ending');
    act(() => vi.advanceTimersByTime(40_000));
    expect(clock()!.textContent).toBe('0:00 left');
  });

  it('shows nothing on a call without a limit', () => {
    mount(<CallClock endsAt={null} />);
    expect(clock()).toBeNull();
  });
});
