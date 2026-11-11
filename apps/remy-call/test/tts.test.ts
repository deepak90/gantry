import { describe, expect, it } from 'vitest';
import type { AudioFrame } from '@livekit/rtc-node';
import { OpenAI } from 'openai';
import { FrameSplitter, LeadingSilenceTrimmer, newSpeechStats, OpenAISpeech } from '../src/tts.ts';

/** Just enough of a 20 ms frame for the trimmer: its samples, tagged with an index. */
const frame = (index: number, loud: boolean) => ({ index, data: new Int16Array(480).fill(loud ? 8000 : 0) }) as unknown as AudioFrame & { index: number };
const frames = (pattern: Array<[boolean, number]>) => {
  const out: Array<AudioFrame & { index: number }> = [];
  for (const [loud, count] of pattern) for (let i = 0; i < count; i++) out.push(frame(out.length, loud));
  return out;
};
const run = (input: Array<AudioFrame & { index: number }>, enabled = true) => {
  const trimmer = new LeadingSilenceTrimmer(enabled);
  const out: number[] = [];
  for (const f of input) trimmer.add(f, (e) => out.push((e as AudioFrame & { index: number }).index));
  trimmer.end((e) => out.push((e as AudioFrame & { index: number }).index));
  return out;
};

describe('LeadingSilenceTrimmer', () => {
  it('drops a click and the silence before the first word, keeping 40 ms', () => {
    const input = frames([[false, 10], [true, 1], [false, 20], [true, 20]]); // speech from frame 31
    const out = run(input);
    expect(out[0]).toBe(26); // the first 8-frame window with 5 loud frames starts at 28; two frames kept before it
    expect(out.at(-1)).toBe(50);
    expect(out).toHaveLength(25);
  });

  it('never drops more than 0.8 s', () => {
    const out = run(frames([[false, 60], [true, 20]]));
    expect(out[0]).toBe(40);
  });

  it('plays everything when no speech comes within 1.5 s', () => {
    const out = run(frames([[false, 80]]));
    expect(out).toEqual(Array.from({ length: 80 }, (_, i) => i));
  });

  it('can be switched off', () => {
    expect(run(frames([[false, 5], [true, 5]]), false)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});

describe('FrameSplitter', () => {
  it('cuts PCM bytes into 20 ms frames across chunk boundaries, odd ones too', () => {
    const splitter = new FrameSplitter();
    const pcm = new Int16Array(1000).map((_, i) => i);
    const bytes = new Uint8Array(pcm.buffer);
    const frames = [...splitter.write(bytes.subarray(0, 333)), ...splitter.write(bytes.subarray(333, 1501)), ...splitter.write(bytes.subarray(1501)), ...splitter.flush()];
    expect(frames.map((f) => f.samplesPerChannel)).toEqual([480, 480, 40]);
    expect(Array.from(frames.flatMap((f) => Array.from(f.data)))).toEqual(Array.from(pcm));
  });
});

/** An OpenAI client whose speech endpoint answers from a script: an error, or a body of PCM chunks. */
function fakeClient(script: Array<Error | Uint8Array[]>) {
  const calls: unknown[] = [];
  const client = {
    audio: {
      speech: {
        create: async (body: unknown) => {
          calls.push(body);
          const next = script.shift();
          if (!next) throw new Error('no more answers');
          if (next instanceof Error) throw next;
          return { body: (async function* () { yield* next; })() };
        },
      },
    },
  } as unknown as OpenAI;
  return { client, calls };
}

const speech = (n: number) => new Uint8Array(new Int16Array(n).fill(8000).buffer);
const silence = (n: number) => new Uint8Array(new Int16Array(n).buffer);
const serverError = () => new OpenAI.InternalServerError(500, { message: 'busy' }, 'busy', new Headers());

describe('OpenAISpeech', () => {
  it('voices a line from one request, trimming the silence before the first word', async () => {
    const { client, calls } = fakeClient([[silence(4800), speech(9600)]]);
    const stats = newSpeechStats();
    const frames: AudioFrame[] = [];
    for await (const f of new OpenAISpeech({ instructions: 'calm' }, client).frames('Okay. If we wait till Friday.', undefined, stats)) frames.push(f);
    expect(calls).toHaveLength(1);
    expect((calls[0] as { input: string }).input).toBe('Okay. If we wait till Friday.');
    expect(stats.receivedMs).toBe(600);
    expect(stats.keptMs).toBe(500); // the trimmer's window opens 3 frames before the speech and keeps 2 before that
    expect(stats.attempts).toBe(1);
    expect(frames.length).toBe(25);
  });

  it('tries again when the request fails before any sound', async () => {
    const { client, calls } = fakeClient([serverError(), [speech(4800)]]);
    const stats = newSpeechStats();
    const frames: AudioFrame[] = [];
    for await (const f of new OpenAISpeech({}, client).frames('Hi.', undefined, stats)) frames.push(f);
    expect(calls).toHaveLength(2);
    expect(stats.attempts).toBe(2);
    expect(frames.length).toBe(10);
  });

  it('does not try again on a request that can never work', async () => {
    const { client, calls } = fakeClient([new OpenAI.BadRequestError(400, { message: 'bad' }, 'bad', new Headers()), [speech(480)]]);
    await expect(async () => {
      for await (const _ of new OpenAISpeech({}, client).frames('Hi.')) void _;
    }).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
});
