/**
 * "Start here" by the counter in the header: it comes a moment after the session first opens, goes at the first press
 * or key anywhere or after a few seconds, and doesn't come back for that session in this browser; none without a
 * session to remember it for.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StartHere, useStartHere } from '../../src/onboarding/StartHere';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

beforeEach(() => vi.useFakeTimers());

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  window.localStorage.clear();
  vi.useRealTimers();
});

function Probe({ storageKey }: { storageKey: string | null }) {
  const shown = useStartHere(storageKey, { delayMs: 500, shownMs: 6000 });
  return <StartHere shown={shown} />;
}

function mount(storageKey: string | null) {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<Probe storageKey={storageKey} />));
  return { shown: () => host.querySelector('[data-testid="start-here"]') !== null, text: () => host.textContent };
}

const KEY = 'gantry.try:p:tok:u:start-here';

describe('Start here', () => {
  it('comes a moment after the session opens, says so, and goes after a few seconds for good', () => {
    const page = mount(KEY);
    expect(page.shown()).toBe(false);
    act(() => vi.advanceTimersByTime(500));
    expect(page.shown()).toBe(true);
    expect(page.text()).toBe('Start here');
    act(() => vi.advanceTimersByTime(6000));
    // Its fade is done by the next frames.
    act(() => vi.advanceTimersByTime(1000));
    expect(window.localStorage.getItem(KEY)).not.toBeNull();

    act(() => root!.unmount());
    const again = mount(KEY);
    act(() => vi.advanceTimersByTime(10_000));
    expect(again.shown()).toBe(false);
  });

  it('goes at the first press or key anywhere', () => {
    for (const event of [new Event('pointerdown'), new KeyboardEvent('keydown', { key: 'a' })]) {
      const page = mount(KEY);
      act(() => vi.advanceTimersByTime(500));
      expect(page.shown()).toBe(true);
      act(() => void window.dispatchEvent(event));
      expect(window.localStorage.getItem(KEY)).not.toBeNull();
      act(() => root!.unmount());
      window.localStorage.clear();
    }
    root = null;
  });

  it('never comes when someone pressed something before it was up', () => {
    const page = mount(KEY);
    act(() => void window.dispatchEvent(new Event('pointerdown')));
    act(() => vi.advanceTimersByTime(10_000));
    expect(page.shown()).toBe(false);
  });

  it('never comes without a session to remember it for', () => {
    const page = mount(null);
    act(() => vi.advanceTimersByTime(10_000));
    expect(page.shown()).toBe(false);
  });
});
