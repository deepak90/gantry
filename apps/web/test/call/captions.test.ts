/**
 * CC on the call bar: captions are on unless this person turned them off, and the choice is kept in this browser.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  window.localStorage.clear();
  vi.resetModules();
});

describe('captions on the call bar', () => {
  it('are on until turned off, and stay as chosen', async () => {
    const { captionsShown } = await import('../../src/call/captions');
    expect(captionsShown.get()).toBe(true);
    const heard: boolean[] = [];
    const stop = captionsShown.subscribe(() => heard.push(captionsShown.get()));
    captionsShown.set(false);
    expect(captionsShown.get()).toBe(false);
    expect(window.localStorage.getItem('collab.call.captions')).toBe('off');
    captionsShown.set(false);
    captionsShown.set(true);
    stop();
    expect(heard).toEqual([false, true]);
    expect(window.localStorage.getItem('collab.call.captions')).toBeNull();
  });

  it('come back off in a new page when they were turned off', async () => {
    window.localStorage.setItem('collab.call.captions', 'off');
    const { captionsShown } = await import('../../src/call/captions');
    expect(captionsShown.get()).toBe(false);
  });
});
