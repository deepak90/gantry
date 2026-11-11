import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudioFrame } from '@livekit/rtc-node';
import { ELEVEN_TTS_MODEL, FRY_CHECK_ON, PACE_CHECK_ON } from '../src/config.ts';
import { chooseSpeech, ElevenLabsError, ElevenLabsSpeech } from '../src/elevenlabs.ts';
import { newSpeechStats, OpenAISpeech, SAMPLE_RATE } from '../src/tts.ts';

const KEY = 'test-key-not-real';
const VOICE = 'test-voice-id';
const speech = (options: Partial<ConstructorParameters<typeof ElevenLabsSpeech>[0]> = {}) => new ElevenLabsSpeech({ apiKey: KEY, voiceId: VOICE, model: 'test-model', ...options });

const loud = (n: number) => new Uint8Array(new Int16Array(n).fill(8000).buffer);
const quiet = (n: number) => new Uint8Array(new Int16Array(n).buffer);

/** A 200 whose body hands out these chunks of PCM. */
const pcmResponse = (chunks: Uint8Array[]) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
    { status: 200 },
  );

const refusal = (status: number, detail: unknown) => new Response(JSON.stringify({ detail }), { status, headers: { 'content-type': 'application/json' } });

interface Call {
  url: string;
  init: RequestInit;
  body: { text: string; model_id: string; apply_text_normalization?: string };
}

/** Stubs `fetch` with these answers, in order: a Response to answer, an Error to reject with. */
function stubFetch(answers: Array<Response | Error>) {
  const calls: Call[] = [];
  const fake = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {}, body: JSON.parse(String(init?.body)) as Call['body'] });
    const next = answers.shift();
    if (!next) throw new Error('no more answers');
    if (next instanceof Error) throw next;
    return next;
  });
  vi.stubGlobal('fetch', fake);
  return { calls, fake };
}

const collect = async (source: AsyncIterable<AudioFrame>) => {
  const out: AudioFrame[] = [];
  for await (const frame of source) out.push(frame);
  return out;
};

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ElevenLabsSpeech', () => {
  it('asks for a line as one streaming request for 24 kHz PCM, the key in a header', async () => {
    const { calls } = stubFetch([pcmResponse([loud(9600)])]);
    await collect(speech().frames('Hello there.'));
    expect(calls).toHaveLength(1);
    const { url, init, body } = calls[0] as Call;
    expect(url).toBe(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE}/stream?output_format=pcm_24000`);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['xi-api-key']).toBe(KEY);
    expect(body.model_id).toBe('test-model');
  });

  it('sends the line written out, money and dates as words, and tells the server not to expand it again', async () => {
    const { calls } = stubFetch([pcmResponse([loud(4800)])]);
    await collect(speech().frames("That's $35,000 on Mon, Nov 2."));
    expect(calls[0]?.body.text).toBe("That's thirty-five thousand dollars on Monday, November second.");
    expect(calls[0]?.body.apply_text_normalization).toBe('off');
  });

  it('streams 20 ms frames at 24 kHz across chunk boundaries, the silence before the first word trimmed', async () => {
    const pcm = new Uint8Array([...quiet(4800), ...loud(9600)]);
    stubFetch([pcmResponse([pcm.subarray(0, 333), pcm.subarray(333, 9601), pcm.subarray(9601)])]);
    const stats = newSpeechStats();
    const frames = await collect(speech().frames('Okay.', undefined, stats));
    expect(frames.every((f) => f.sampleRate === SAMPLE_RATE && f.channels === 1)).toBe(true);
    expect(frames.every((f) => f.samplesPerChannel === 480)).toBe(true);
    expect(stats.receivedMs).toBe(600);
    expect(stats.keptMs).toBe(500); // the trimmer's window opens 3 frames before the speech and keeps 2 before that
    expect(stats.attempts).toBe(1);
    expect(stats.ttfbMs).not.toBeNull();
  });

  it('hands a whole line back as PCM', async () => {
    stubFetch([pcmResponse([loud(1200), loud(1200)])]);
    const samples = await speech({ trimLeadingSilence: false, pauses: null }).pcm('Hi.');
    expect(samples).toHaveLength(2400);
    expect(samples[0]).toBe(8000);
  });

  it.each([[429], [500], [503]])('tries again when it answers %i before any sound', async (status) => {
    const { calls } = stubFetch([refusal(status, { status: 'busy', message: 'try later' }), pcmResponse([loud(4800)])]);
    const stats = newSpeechStats();
    const frames = await collect(speech().frames('Hi.', undefined, stats));
    expect(calls).toHaveLength(2);
    expect(stats.attempts).toBe(2);
    expect(frames).toHaveLength(10);
  });

  it('tries again when the server cannot be reached', async () => {
    const { calls } = stubFetch([new TypeError('fetch failed'), pcmResponse([loud(4800)])]);
    await collect(speech().frames('Hi.'));
    expect(calls).toHaveLength(2);
  });

  it('gives up after three attempts', async () => {
    const { calls } = stubFetch([refusal(500, 'a'), refusal(500, 'b'), refusal(500, 'c'), pcmResponse([loud(4800)])]);
    await expect(collect(speech().frames('Hi.'))).rejects.toMatchObject({ status: 500 });
    expect(calls).toHaveLength(3);
  });

  it.each([[401], [422]])('does not try again on %i, which can never work', async (status) => {
    const { calls } = stubFetch([refusal(status, { status: 'nope', message: 'no' }), pcmResponse([loud(480)])]);
    await expect(collect(speech().frames('Hi.'))).rejects.toBeInstanceOf(ElevenLabsError);
    expect(calls).toHaveLength(1);
  });

  it('says why it was refused, without the key or the voice id', async () => {
    stubFetch([refusal(404, { status: 'voice_not_found', message: `A voice with the voice_id ${VOICE} was not found for key ${KEY}.` })]);
    const error = await collect(speech().frames('Hi.')).catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(ElevenLabsError);
    expect((error as Error).message).toContain('404');
    expect((error as Error).message).toContain('voice_not_found');
    expect((error as Error).message).not.toContain(VOICE);
    expect((error as Error).message).not.toContain(KEY);
  });

  it('plays what came and throws when the download fails partway, without asking again', async () => {
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) controller.error(new Error('connection lost'));
        else controller.enqueue(loud(4800));
        sent = true;
      },
    });
    const { calls } = stubFetch([new Response(body, { status: 200 })]);
    const frames: AudioFrame[] = [];
    await expect(
      (async () => {
        for await (const frame of speech({ trimLeadingSilence: false, pauses: null }).frames('A longer line.')) frames.push(frame);
      })(),
    ).rejects.toThrow('connection lost');
    expect(calls).toHaveLength(1);
    expect(frames.length).toBeGreaterThan(0);
  });

  it('passes the abort signal to the request and stops without asking again when cut off', async () => {
    const abort = new AbortController();
    const { calls, fake } = stubFetch([]);
    fake.mockImplementation(async (input, init) => {
      calls.push({ url: String(input), init: init ?? {}, body: JSON.parse(String(init?.body)) as Call['body'] });
      abort.abort();
      throw new DOMException('The operation was aborted.', 'AbortError');
    });
    await expect(collect(speech().frames('Hi.', abort.signal))).rejects.toThrow('aborted');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init.signal).toBe(abort.signal);
  });

  it('names its voice in the log without the id, and makes new fillers for a new model', () => {
    const one = speech();
    expect(one.voiceLabel).not.toContain(VOICE);
    expect(one.voiceKey).not.toBe(speech({ model: 'other-model' }).voiceKey);
  });

  describe('a line of a word or two', () => {
    const STEADY = { stability: 0.85, similarity_boost: 0.75 };
    const answers = (n: number) => Array.from({ length: n }, () => pcmResponse([loud(4800)]));

    it('is read plainly and steadily, in the tone of what she said before it', async () => {
      const { calls } = stubFetch(answers(2));
      const remy = speech();
      await collect(remy.frames('Both payments went through, so the ground floor can start tomorrow.'));
      await collect(remy.frames('Anytime!'));
      expect(calls[1]?.body).toMatchObject({
        text: 'Anytime.',
        voice_settings: STEADY,
        previous_text: 'Both payments went through, so the ground floor can start tomorrow.',
      });
    });

    it('goes without that context when she has said nothing yet', async () => {
      const { calls } = stubFetch(answers(1));
      await collect(speech().frames('Anytime.'));
      expect(calls[0]?.body).toMatchObject({ text: 'Anytime.', voice_settings: STEADY });
      expect(calls[0]?.body).not.toHaveProperty('previous_text');
    });

    it('is not what the next one takes its tone from', async () => {
      const { calls } = stubFetch(answers(3));
      const remy = speech();
      await collect(remy.frames('Both payments went through, so we can start.'));
      await collect(remy.frames('Sure.'));
      await collect(remy.frames('Anytime.'));
      expect(calls[2]?.body).toMatchObject({ previous_text: 'Both payments went through, so we can start.' });
    });

    it('leaves a longer line as it was, its exclamation and her saved settings too', async () => {
      const { calls } = stubFetch(answers(2));
      const remy = speech();
      await collect(remy.frames('It stays on hold until both payments land.'));
      await collect(remy.frames('Both payments went through!'));
      expect(calls[1]?.body.text).toBe('Both payments went through!');
      for (const call of calls) {
        expect(call.body).not.toHaveProperty('voice_settings');
        expect(call.body).not.toHaveProperty('previous_text');
      }
    });

    it('counts words as she says them: an amount alone is a full line', async () => {
      const { calls } = stubFetch(answers(1));
      await collect(speech().frames('$35,000.'));
      expect(calls[0]?.body).not.toHaveProperty('voice_settings');
    });
  });
});

describe('chooseSpeech', () => {
  it('uses her ElevenLabs voice when its id is set', () => {
    const chosen = chooseSpeech({ ELEVEN_LABS_VOICE_REMY_KEY: VOICE, ELEVEN_LABS_API_KEY: KEY });
    expect(chosen).toBeInstanceOf(ElevenLabsSpeech);
    expect(chosen.model).toBe(ELEVEN_TTS_MODEL);
    expect(chosen.checksPace).toBe(false);
  });

  it('uses OpenAI, pace-checked as before, without a voice id', () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-openai-key');
    for (const env of [{}, { ELEVEN_LABS_VOICE_REMY_KEY: '  ' }, { ELEVEN_LABS_API_KEY: KEY }]) {
      const chosen = chooseSpeech(env);
      expect(chosen).toBeInstanceOf(OpenAISpeech);
      expect(chosen.checksPace).toBe(true);
    }
    vi.unstubAllEnvs();
  });

  it('refuses a voice id without a key, rather than quietly using another voice', () => {
    expect(() => chooseSpeech({ ELEVEN_LABS_VOICE_REMY_KEY: VOICE })).toThrow('ELEVEN_LABS_API_KEY');
  });

  it('gives the hosted worker, which has only an OpenAI key, gpt-4o-mini-tts with the pace and fry checks on', () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-openai-key');
    const chosen = chooseSpeech({ GANTRY_HOSTED: '1', OPENAI_API_KEY: 'test-openai-key' });
    expect(chosen).toBeInstanceOf(OpenAISpeech);
    expect(chosen.model).toBe('gpt-4o-mini-tts');
    expect(chosen.checksPace).toBe(true);
    expect(PACE_CHECK_ON).toBe(true);
    expect(FRY_CHECK_ON).toBe(true);
    vi.unstubAllEnvs();
  });
});
