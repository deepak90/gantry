import { afterEach, describe, expect, it } from 'vitest';
import { attention, lendPointer, mirrorCall, moodOf } from '../../src/assistant/attention';
import { Call } from '../../src/rails/call';

const pointerAt = (x: number, y: number, shown = true) => ({ pointer: { x, y, shown, pressing: false } });

describe('moodOf', () => {
  it('reads a call the way its face on the call bar does', () => {
    const base = { presence: 'here', activity: 'idle', speaking: false, youTalking: false } as const;
    expect(moodOf({ ...base, presence: 'away' })).toBe('away');
    expect(moodOf({ ...base, presence: 'joining' })).toBe('joining');
    expect(moodOf(base)).toBe('idle');
    expect(moodOf({ ...base, activity: 'thinking' })).toBe('thinking');
    expect(moodOf({ ...base, activity: 'thinking', speaking: true })).toBe('speaking');
    expect(moodOf({ ...base, youTalking: true })).toBe('listening');
  });
});

describe('mirrorCall', () => {
  const stops: (() => void)[] = [];
  afterEach(() => {
    for (const stop of stops.splice(0)) stop();
  });

  it('follows the call it mirrors, and says away once it stops', async () => {
    const call = new Call({ name: 'Remy', speed: 0 });
    const seen: string[] = [];
    stops.push(attention.subscribe((mood) => seen.push(mood)));
    const stop = mirrorCall(call, pointerAt(10, 20));
    await call.join();
    call.doing('thinking');
    expect(attention.mood).toBe('thinking');
    expect(attention.pointer()).toEqual({ x: 10, y: 20, shown: true, pressing: false });
    stop();
    expect(attention.mood).toBe('away');
    expect(attention.pointer()).toBeNull();
    expect(seen).toEqual(['away', 'joining', 'idle', 'thinking', 'away']);
  });

  it('belongs to the call that mirrored last: an older one stopping leaves it alone', async () => {
    const walkthrough = new Call({ name: 'Remy', speed: 0 });
    const spoken = new Call({ name: 'Remy', speed: 0 });
    const stopWalkthrough = mirrorCall(walkthrough, null);
    const stopSpoken = mirrorCall(spoken, pointerAt(1, 2));
    stops.push(stopSpoken);
    await spoken.join();
    walkthrough.set({ presence: 'here', activity: 'working' });
    expect(attention.mood).toBe('idle');
    stopWalkthrough();
    expect(attention.mood).toBe('idle');
    expect(attention.pointer()?.x).toBe(1);
  });

  it('reads the voice from the call it mirrors', async () => {
    const call = new Call({ name: 'Remy', speed: 0 });
    call.voice = { level: () => 0.7 };
    stops.push(mirrorCall(call, null));
    await call.join();
    expect(attention.voice()).toBe(0.7);
  });
});

describe('lendPointer', () => {
  it('lets the face follow Remy’s own cursor while she shows something, the call’s cursor first', async () => {
    let own = { x: 5, y: 6, shown: false, pressing: false };
    const giveBack = lendPointer(() => own);
    expect(attention.pointer()).toBeNull();
    own = { ...own, shown: true };
    expect(attention.pointer()).toEqual({ x: 5, y: 6, shown: true, pressing: false });
    const call = new Call({ name: 'Remy', speed: 0 });
    const stop = mirrorCall(call, pointerAt(1, 2));
    expect(attention.pointer()?.x).toBe(1);
    stop();
    expect(attention.pointer()?.x).toBe(5);
    giveBack();
    expect(attention.pointer()).toBeNull();
  });
});
