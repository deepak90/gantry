import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { AudioFrame } from '@livekit/rtc-node';
import { FRY, PACE_FLOOR_MS, PACE_LIMIT_MS, PACE_MIN_SYLLABLES } from '../src/config.ts';
import { pacedFrames, type PaceOptions, type PaceReport, type SpeechSource } from '../src/pace.ts';
import { spokenSyllables } from '../src/spoken.ts';
import { newSpeechStats, type SpeechStats } from '../src/tts.ts';
import { readWav } from '../src/wav.ts';
import { voice } from './tone.ts';

const OPTIONS: PaceOptions = { limitMs: PACE_LIMIT_MS, minSyllables: PACE_MIN_SYLLABLES, floorMs: PACE_FLOOR_MS, fry: FRY };

type Tagged = AudioFrame & { take: number };
/** A take in the script: how much sound it keeps (no samples), real 8 kHz sound, or a failure after some frames. */
type ScriptedTake = { keptMs: number } | { samples: Int16Array } | { failAfterMs: number };

/** A speech source that answers each request with the next take in the script, as 20 ms frames tagged with the take. */
function fakeSpeech(script: ScriptedTake[]) {
  let requests = 0;
  const source: SpeechSource = {
    async *frames(_text: string, _signal?: AbortSignal, stats: SpeechStats = newSpeechStats()) {
      const take = ++requests;
      const next = script.shift();
      if (!next) throw new Error('no more takes');
      if ('samples' in next) {
        for (let at = 0; at + 160 <= next.samples.length; at += 160) {
          stats.keptMs += 20;
          stats.receivedMs += 20;
          yield { take, data: next.samples.slice(at, at + 160), sampleRate: 8000, channels: 1, samplesPerChannel: 160 } as unknown as Tagged;
        }
        stats.ttfbMs = 500 + take;
        return;
      }
      const ms = 'keptMs' in next ? next.keptMs : next.failAfterMs;
      for (let at = 0; at < ms; at += 20) {
        stats.keptMs += 20;
        stats.receivedMs += 20;
        yield { take } as unknown as Tagged;
      }
      if ('failAfterMs' in next) throw new Error('connection reset');
      stats.ttfbMs = 500 + take;
    },
  };
  return { source, requests: () => requests };
}

async function play(source: SpeechSource, text: string, options: PaceOptions = OPTIONS) {
  const stats = newSpeechStats();
  const reports: PaceReport[] = [];
  const skipped: number[] = [];
  const takes: number[] = [];
  for await (const frame of pacedFrames(source, text, undefined, stats, options, { onPace: (r) => reports.push(r), onSkip: ({ syllables }) => skipped.push(syllables) })) {
    takes.push((frame as Tagged).take);
  }
  return { stats, reports, skipped, played: [...new Set(takes)], frames: takes.length };
}

const DRAGGING = 'Drafting the fixtures for one floor.';

describe('the pace limit on a recorded take', () => {
  // Kept ms per line, from the worker's `tts` events.
  it.each([
    ["Hi everyone, I've got the plan open.", 2120, true],
    ['Here you go. Fixtures come to about $12,000 a floor.', 4180, true],
    ['Fair enough, $35,000 a floor it is.', 3540, true],
    ['It goes in with the ceiling tiles on level 1, so nothing moves. Levels 2 and 3 look the same; want me to add them?', 7880, true],
    [DRAGGING, 2660, false],
  ] as Array<[string, number, boolean]>)('%s (%i ms kept) passes: %s', (text, keptMs, passes) => {
    expect(keptMs / spokenSyllables(text) <= PACE_LIMIT_MS).toBe(passes);
  });
});

describe('pacedFrames', () => {
  it('asks again for a dragging take and plays the normal one, reporting both', async () => {
    const { source, requests } = fakeSpeech([{ keptMs: 2660 }, { keptMs: 2000 }]);
    const { reports, played, frames, stats, skipped } = await play(source, DRAGGING);
    expect(requests()).toBe(2);
    expect(played).toEqual([2]);
    expect(frames).toBe(100);
    expect(stats.keptMs).toBe(2000); // the playing take's
    expect(stats.ttfbMs).toBe(502);
    expect(skipped).toEqual([]);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ syllables: 8, limitMs: PACE_LIMIT_MS, keptMs: [2660, 2000], used: 2 });
    expect(reports[0]?.paceMs).toEqual([332.5, 250]);
  });

  it('plays a take at her normal pace without asking again', async () => {
    const { source, requests } = fakeSpeech([{ keptMs: 2120 }, { keptMs: 1500 }]);
    const { reports, played } = await play(source, "Hi everyone, I've got the plan open.");
    expect(requests()).toBe(1);
    expect(played).toEqual([1]);
    expect(reports[0]).toMatchObject({ syllables: 10, paceMs: [212], used: 1 });
  });

  it('never asks more than once: when the retry drags too, the faster of the two plays', async () => {
    const { source, requests } = fakeSpeech([{ keptMs: 2660 }, { keptMs: 2900 }, { keptMs: 1800 }]);
    const { reports, played } = await play(source, DRAGGING);
    expect(requests()).toBe(2);
    expect(played).toEqual([1]);
    expect(reports[0]).toMatchObject({ keptMs: [2660, 2900], used: 1 });
  });

  it('does not check a very short line, which streams from one request', async () => {
    const { source, requests } = fakeSpeech([{ keptMs: 660 }, { keptMs: 400 }]);
    const { reports, played, skipped, stats } = await play(source, 'On it.');
    expect(requests()).toBe(1);
    expect(played).toEqual([1]);
    expect(skipped).toEqual([2]);
    expect(reports).toEqual([]);
    expect(stats.keptMs).toBe(660);
  });

  it('plays the first take when the retry fails', async () => {
    const { source } = fakeSpeech([{ keptMs: 2660 }, { failAfterMs: 400 }]);
    const { reports, played } = await play(source, DRAGGING);
    expect(played).toEqual([1]);
    expect(reports[0]).toMatchObject({ keptMs: [2660], used: 1 });
    expect(String(reports[0]?.retryError)).toContain('connection reset');
  });

  it('never plays a retry so fast it has likely lost words', async () => {
    const { source } = fakeSpeech([{ keptMs: 2660 }, { keptMs: 900 }]); // 112 ms a syllable
    const { reports, played } = await play(source, DRAGGING);
    expect(played).toEqual([1]);
    expect(reports[0]).toMatchObject({ keptMs: [2660, 900], used: 1 });
  });

  it('plays what came of a first take that fails, then throws, like a streamed line', async () => {
    const { source, requests } = fakeSpeech([{ failAfterMs: 400 }, { keptMs: 2000 }]);
    const takes: number[] = [];
    await expect(async () => {
      for await (const frame of pacedFrames(source, DRAGGING, undefined, newSpeechStats(), OPTIONS)) takes.push((frame as Tagged).take);
    }).rejects.toThrow('connection reset');
    expect(requests()).toBe(1);
    expect(takes).toHaveLength(20);
  });

  it('stops without playing or asking again when the line is cut off', async () => {
    const abort = new AbortController();
    let requests = 0;
    const source: SpeechSource = {
      async *frames(_text, _signal, stats = newSpeechStats()) {
        requests++;
        for (let i = 0; i < 150; i++) {
          stats.keptMs += 20;
          yield { take: requests } as unknown as Tagged;
        }
        abort.abort(); // cut off as the slow take finished downloading
      },
    };
    const takes: number[] = [];
    for await (const frame of pacedFrames(source, DRAGGING, abort.signal, newSpeechStats(), OPTIONS)) takes.push((frame as Tagged).take);
    expect(requests).toBe(1);
    expect(takes).toEqual([]);
  });
});

/** Her lines from a recorded take, at 8 kHz. */
const fixture = (name: string) => readWav(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))).samples;
const LEVELS = 'It goes in with the ceiling tiles on level 1, so nothing moves. Levels 2 and 3 look the same; want me to add them?';
const clean = (ms: number) => voice([[200, ms]]);
const creaky = (ms: number) => voice([[200, ms / 2 - 250], [100, 500], [200, ms / 2 - 250]]);

describe('pacedFrames and fry', () => {
  it('asks again for a take with fry and plays the one without it, even when slower', async () => {
    const { source, requests } = fakeSpeech([{ samples: fixture('remy-fry-levels.wav') }, { samples: clean(9000) }]);
    const { reports, played } = await play(source, LEVELS);
    expect(requests()).toBe(2);
    expect(played).toEqual([2]);
    const report = reports[0];
    expect(report).toMatchObject({ syllables: 29, reasons: ['fry'], used: 2 });
    expect(report?.paceMs[0]).toBeLessThan(PACE_LIMIT_MS); // her pace was fine: 283
    expect(report?.paceMs[1]).toBeGreaterThan(PACE_LIMIT_MS);
    expect(report?.fry.map((f) => f?.fry)).toEqual([true, false]);
    expect(report?.fry[0]?.longestRunMs).toBe(300);
  });

  it('plays a slow take without fry over a faster retry with it', async () => {
    const { source } = fakeSpeech([{ samples: clean(9500) }, { samples: fixture('remy-fry-levels.wav') }]);
    const { reports, played } = await play(source, LEVELS);
    expect(played).toEqual([1]);
    expect(reports[0]).toMatchObject({ reasons: ['slow'], used: 1 });
    expect(reports[0]?.fry.map((f) => f?.fry)).toEqual([false, true]);
  });

  it('plays the faster of two takes that both have fry', async () => {
    const { source } = fakeSpeech([{ samples: creaky(9500) }, { samples: fixture('remy-fry-levels.wav') }]);
    const { reports, played } = await play(source, LEVELS);
    expect(played).toEqual([2]);
    expect(reports[0]).toMatchObject({ reasons: ['slow', 'fry'], used: 2 });
  });

  it('does not ask again for a normal take: her greeting', async () => {
    const { source, requests } = fakeSpeech([{ samples: fixture('remy-greeting.wav') }, { samples: clean(2000) }]);
    const { reports, played } = await play(source, "Hi everyone, I've got the plan open.");
    expect(requests()).toBe(1);
    expect(played).toEqual([1]);
    expect(reports[0]).toMatchObject({ reasons: [], used: 1 });
    expect(reports[0]?.fry[0]?.fry).toBe(false);
  });

  it('leaves fry unchecked when it is switched off', async () => {
    const { source, requests } = fakeSpeech([{ samples: fixture('remy-fry-levels.wav') }, { samples: clean(9000) }]);
    const { reports } = await play(source, LEVELS, { ...OPTIONS, fry: null });
    expect(requests()).toBe(1);
    expect(reports[0]).toMatchObject({ fry: [null], reasons: [], used: 1 });
  });
});
