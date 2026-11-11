/**
 * The voice mode's listening: loudness on a decibel scale, a meter that rises fast and falls slowly,
 * talk that survives the gaps between words, and your words on screen exactly as heard: a loud noise
 * with no words shows nothing, and the line taken is what was heard, never the printed one.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Call } from '../../src/rails/call';
import { follow, levelFromRms, Listener, TalkDetector, type Ears, type Heard } from '../../src/rails/voice';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Ears the test speaks through. */
class TestEars implements Ears {
  heard: (words: Heard) => void = () => undefined;
  lines: string[] = [];
  now: Heard = { final: '', tentative: '' };
  start(heard: (words: Heard) => void) {
    this.heard = heard;
  }
  newLine(expected: string) {
    this.lines.push(expected);
    this.now = { final: '', tentative: '' };
  }
  hear(final: string, tentative = '') {
    this.now = { final, tentative };
    this.heard(this.now);
  }
  async settle() {
    return { final: [this.now.final, this.now.tentative].filter(Boolean).join(' '), tentative: '' };
  }
  close() {}
}

function frames() {
  const queue: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => queue.push(callback));
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  let now = 0;
  return (ms: number) => {
    for (let elapsed = 0; elapsed < ms; elapsed += 16) {
      now += 16;
      queue.shift()?.(now);
    }
  };
}

describe('the voice mode', () => {
  it('reads loudness on a decibel scale, from room noise to speaking up', () => {
    expect(levelFromRms(0)).toBe(0);
    expect(levelFromRms(0.0005)).toBe(0);
    expect(levelFromRms(0.2)).toBe(1);
    expect(levelFromRms(0.01)).toBeGreaterThan(levelFromRms(0.003));
  });

  it('rises quickly and falls slowly, like a meter', () => {
    const up = follow(0, 1, 16);
    const down = 1 - follow(1, 0, 16);
    expect(up).toBeGreaterThan(down * 3);
  });

  it('counts talking once it lasts, and the gaps between words as talking', () => {
    const detector = new TalkDetector();
    expect(detector.update(0.6, 30)).toBe(false);
    expect(detector.update(0.6, 50)).toBe(true);
    expect(detector.update(0.02, 200)).toBe(true);
    expect(detector.update(0.02, 300)).toBe(false);
  });

  it('a loud noise with no words moves the meter but shows no words', () => {
    const play = frames();
    const call = new Call({ speed: 0 });
    let level = 0;
    const ears = new TestEars();
    const listener = new Listener(call, { level: () => level }, ears);
    listener.listen('Draft a light fixtures package.');
    level = 0.9;
    play(400);
    expect(call.state.youTalking).toBe(true);
    expect(call.state.words).toBeNull();
    listener.close();
  });

  it('shows your words exactly as heard, the unsettled ones marked, and takes the line as heard', async () => {
    frames();
    const call = new Call({ speed: 0 });
    const ears = new TestEars();
    const listener = new Listener(call, { level: () => 0 }, ears);
    listener.listen('Draft a light fixtures package.');
    expect(ears.lines).toEqual(['Draft a light fixtures package.']);
    ears.hear('draft a light', 'fixtures pack');
    expect(call.state.words).toEqual({ who: 'you', text: 'draft a light fixtures pack', shown: 5, tentative: 2 });
    ears.hear('draft a light fixtures package please');
    expect(call.state.words).toEqual({ who: 'you', text: 'draft a light fixtures package please', shown: 6, tentative: 0 });
    await expect(listener.take()).resolves.toBe('draft a light fixtures package please');
    listener.close();
  });

  it('listening again for the same line keeps what was heard; a new line starts fresh', () => {
    frames();
    const call = new Call({ speed: 0 });
    const ears = new TestEars();
    const listener = new Listener(call, { level: () => 0 }, ears);
    listener.listen('Yes, add it.');
    listener.listen('Yes, add it.');
    expect(ears.lines).toEqual(['Yes, add it.']);
    listener.stop();
    listener.listen('Do it.');
    expect(ears.lines).toEqual(['Yes, add it.', 'Do it.']);
    listener.close();
  });
});
