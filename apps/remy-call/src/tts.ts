/**
 * Remy's mouth: one request per line, whichever voice is speaking.
 *
 * - `LineSpeech.frames(text)` voices a whole line from one request and yields 20 ms frames as the PCM downloads.
 *   Read whole, a line keeps one intonation and the model's own timing between its sentences. (The session's
 *   chunked path read each sentence as a request of its own: every sentence restarted its intonation and kept its
 *   tail of silence.) The worker hands the frames to the session itself, behind a jitter buffer (jitter-buffer.ts).
 *   `OpenAISpeech` here and `ElevenLabsSpeech` (elevenlabs.ts) are the two voices; each only opens the download.
 * - gpt-4o-mini-tts clips often open with a click and up to ~0.8 s of near-silence before the first word. The trimmer
 *   holds the first frames until speech is sustained, then plays from 40 ms before it, dropping at most 0.8 s.
 * - Long pauses inside a line are shortened, and the silence after it cut short (pauses.ts).
 * - `StreamingLineTTS` is the session's own TTS, for a line said without audio in hand (none in this worker today).
 */
import { shortuuid, tts, type APIConnectOptions } from '@livekit/agents';
import { AudioFrame } from '@livekit/rtc-node';
import { OpenAI } from 'openai';
import { TTS_MODEL, TTS_VOICE } from './config.ts';
import { PAUSES, PauseShortener, type PauseOptions } from './pauses.ts';

export const SAMPLE_RATE = 24000;
export const CHANNELS = 1;
export const FRAME_SAMPLES = 480; // 20 ms

/** Sustained speech: at least NEEDED of WINDOW frames louder than -42 dBFS. */
const WINDOW = 8;
const NEEDED = 5;
const KEEP_BEFORE = 2; // frames kept before the speech, 40 ms
const MAX_TRIM = 40; // frames, 0.8 s
const GIVE_UP = 75; // frames, 1.5 s: no speech found, play as is
const LOUD_DBFS = -42;

/** A request that fails before its first byte is tried this many times in all. */
const ATTEMPTS = 3;
const RETRY_AFTER_MS = [250, 750];

export class LeadingSilenceTrimmer {
  #enabled: boolean;
  #buffer: AudioFrame[] = [];
  #started = false;

  constructor(enabled = true) {
    this.#enabled = enabled;
  }

  static loud(frame: AudioFrame): boolean {
    const data = frame.data;
    if (!data.length) return false;
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += (data[i] ?? 0) ** 2;
    const rms = Math.sqrt(sum / data.length) / 32768;
    return rms > 0 && 20 * Math.log10(rms) > LOUD_DBFS;
  }

  add(frame: AudioFrame, emit: (frame: AudioFrame) => void): void {
    if (!this.#enabled || this.#started) {
      emit(frame);
      return;
    }
    this.#buffer.push(frame);
    const held = this.#buffer;
    for (let i = 0; i + WINDOW <= held.length; i++) {
      if (held.slice(i, i + WINDOW).filter((f) => LeadingSilenceTrimmer.loud(f)).length >= NEEDED) {
        this.#started = true;
        const from = Math.min(Math.max(0, i - KEEP_BEFORE), MAX_TRIM);
        for (const f of held.slice(from)) emit(f);
        this.#buffer = [];
        return;
      }
    }
    if (held.length >= GIVE_UP) this.end(emit);
  }

  /** The audio ended: let out whatever is held. */
  end(emit: (frame: AudioFrame) => void): void {
    if (this.#started) return;
    this.#started = true;
    for (const f of this.#buffer) emit(f);
    this.#buffer = [];
  }
}

/** Raw 16-bit PCM bytes, as they download, cut into 20 ms frames (the last one may be shorter). */
export class FrameSplitter {
  #pending = new Uint8Array(0);

  write(chunk: Uint8Array): AudioFrame[] {
    let bytes = chunk;
    if (this.#pending.length) {
      bytes = new Uint8Array(this.#pending.length + chunk.length);
      bytes.set(this.#pending);
      bytes.set(chunk, this.#pending.length);
    }
    const size = FRAME_SAMPLES * 2;
    const frames: AudioFrame[] = [];
    let at = 0;
    for (; at + size <= bytes.length; at += size) frames.push(FrameSplitter.#frame(bytes.slice(at, at + size)));
    this.#pending = bytes.slice(at);
    return frames;
  }

  flush(): AudioFrame[] {
    const even = this.#pending.length - (this.#pending.length % 2);
    const rest = this.#pending.slice(0, even);
    this.#pending = new Uint8Array(0);
    return rest.length ? [FrameSplitter.#frame(rest)] : [];
  }

  static #frame(bytes: Uint8Array): AudioFrame {
    const samples = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.length / 2);
    return new AudioFrame(samples, SAMPLE_RATE, CHANNELS, samples.length);
  }
}

/** What a line's sound goes through on its way out, for every voice. */
export interface LineShaping {
  trimLeadingSilence: boolean;
  /** How long pauses are shortened (pauses.ts); null keeps the model's own. */
  pauses: PauseOptions | null;
}

export interface SpeechOptions extends LineShaping {
  model: string;
  voice: string;
  instructions?: string;
  speed: number;
  apiKey?: string;
}

/** What one line's synthesis took, filled in as it runs. */
export interface SpeechStats {
  /** From the request to its first byte, in ms. */
  ttfbMs: number | null;
  /** Sound received, in ms. */
  receivedMs: number;
  /** Sound kept after the leading click and silence were trimmed and long pauses shortened, in ms. */
  keptMs: number;
  /** Silence taken out of long pauses and after the last word, in ms. */
  shortenedMs: number;
  attempts: number;
}

export const newSpeechStats = (): SpeechStats => ({ ttfbMs: null, receivedMs: 0, keptMs: 0, shortenedMs: 0, attempts: 0 });

const frameMs = (frame: AudioFrame) => (frame.samplesPerChannel / frame.sampleRate) * 1000;

/** A status worth trying again: a timeout, a conflict, a rate limit, a server error. */
export const transientStatus = (status: number) => status === 408 || status === 409 || status === 429 || status >= 500;

const pause = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/**
 * A voice that says one line from one request and downloads it as raw 16-bit PCM, mono, at 24 kHz. Everything from the
 * first byte on is the same for every voice; a voice only says how to open the download and which failures to retry.
 */
export abstract class LineSpeech {
  abstract readonly provider: string;
  abstract readonly model: string;
  /** The voice's name, for the log. Never an id or a key. */
  abstract readonly voiceLabel: string;
  /** What makes two takes sound alike: a new one makes the fillers again (filler-audio.ts). */
  abstract readonly voiceKey: string;
  /** Takes are checked for pace and fry before they play (pace.ts): only worth waiting for on a voice that drifts. */
  abstract readonly checksPace: boolean;
  #shaping: LineShaping;

  constructor(shaping: LineShaping) {
    this.#shaping = shaping;
  }

  /** Asks for a line. Resolves with the download once the voice has answered; throws if it refuses. */
  protected abstract open(text: string, signal?: AbortSignal): Promise<AsyncIterable<Uint8Array>>;
  /** Worth trying again before the first byte: no connection, a timeout, a rate limit, a server error. */
  protected abstract retryable(error: unknown): boolean;

  /**
   * One line from one request, as 20 ms frames while the PCM downloads: the click and silence before the first word
   * trimmed, long pauses shortened. A request that fails before its first byte is tried again, twice and briefly; a
   * later failure throws.
   */
  async *frames(text: string, signal?: AbortSignal, stats: SpeechStats = newSpeechStats()): AsyncGenerator<AudioFrame> {
    const startedAt = Date.now();
    const body = await this.#request(text, signal, stats);
    const bytes = new FrameSplitter();
    const trimmer = new LeadingSilenceTrimmer(this.#shaping.trimLeadingSilence);
    const shortener = this.#shaping.pauses ? new PauseShortener(this.#shaping.pauses) : null;
    const ready: AudioFrame[] = [];
    const keep = (frame: AudioFrame) => void ready.push(frame);
    const shorten = shortener ? (frame: AudioFrame) => shortener.add(frame, keep) : keep;
    const drain = function* () {
      while (ready.length) {
        const frame = ready.shift() as AudioFrame;
        stats.keptMs += frameMs(frame);
        yield frame;
      }
    };
    for await (const chunk of body) {
      stats.ttfbMs ??= Date.now() - startedAt;
      for (const frame of bytes.write(chunk)) {
        stats.receivedMs += frameMs(frame);
        trimmer.add(frame, shorten);
      }
      yield* drain();
    }
    for (const frame of bytes.flush()) {
      stats.receivedMs += frameMs(frame);
      trimmer.add(frame, shorten);
    }
    trimmer.end(shorten);
    shortener?.end(keep);
    stats.shortenedMs = shortener?.droppedMs ?? 0;
    yield* drain();
  }

  /** A whole line as one block of PCM (trimmed like `frames`). */
  async pcm(text: string, signal?: AbortSignal): Promise<Int16Array> {
    const parts: Int16Array[] = [];
    for await (const frame of this.frames(text, signal)) parts.push(frame.data.slice());
    const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }

  async #request(text: string, signal: AbortSignal | undefined, stats: SpeechStats): Promise<AsyncIterable<Uint8Array>> {
    for (let attempt = 1; ; attempt++) {
      stats.attempts = attempt;
      try {
        return await this.open(text, signal);
      } catch (error) {
        if (signal?.aborted || attempt >= ATTEMPTS || !this.retryable(error)) throw error;
        await pause(RETRY_AFTER_MS[attempt - 1] ?? 750, signal);
      }
    }
  }
}

export class OpenAISpeech extends LineSpeech {
  readonly provider = 'api.openai.com';
  readonly checksPace = true;
  readonly options: SpeechOptions;
  readonly client: OpenAI;

  constructor(options: Partial<SpeechOptions> = {}, client?: OpenAI) {
    const all: SpeechOptions = { model: TTS_MODEL, voice: TTS_VOICE, speed: 1, trimLeadingSilence: true, pauses: PAUSES, ...options };
    super(all);
    this.options = all;
    this.client = client ?? new OpenAI({ apiKey: all.apiKey ?? process.env.OPENAI_API_KEY, maxRetries: 0 });
  }

  get model(): string {
    return this.options.model;
  }

  get voiceLabel(): string {
    return this.options.voice;
  }

  get voiceKey(): string {
    const { model, voice, speed, instructions } = this.options;
    return [model, voice, speed, instructions ?? ''].join('|');
  }

  protected async open(text: string, signal?: AbortSignal): Promise<AsyncIterable<Uint8Array>> {
    const response = await this.client.audio.speech.create(
      {
        input: text,
        model: this.options.model,
        voice: this.options.voice,
        ...(this.options.instructions ? { instructions: this.options.instructions } : {}),
        response_format: 'pcm',
        speed: this.options.speed,
      },
      { signal },
    );
    if (!response.body) throw new Error('the speech response has no body');
    return response.body as unknown as AsyncIterable<Uint8Array>;
  }

  protected retryable(error: unknown): boolean {
    if (!(error instanceof OpenAI.APIError)) return false;
    return error.status === undefined || transientStatus(error.status);
  }
}

export class StreamingLineTTS extends tts.TTS {
  label: string;
  #speech: LineSpeech;
  #closed = new AbortController();

  constructor(speech: LineSpeech) {
    super(SAMPLE_RATE, CHANNELS, { streaming: false });
    this.#speech = speech;
    this.label = `${speech.provider}.LineTTS`;
  }

  override get model(): string {
    return this.#speech.model;
  }

  override get provider(): string {
    return this.#speech.provider;
  }

  synthesize(text: string, connOptions?: APIConnectOptions, abortSignal?: AbortSignal): tts.ChunkedStream {
    return new SpeechChunks(this, text, this.#speech, this.#closed.signal, connOptions, abortSignal);
  }

  stream(): tts.SynthesizeStream {
    throw new Error('StreamingLineTTS is chunked: the session wraps synthesize() with a sentence tokenizer');
  }

  override async close(): Promise<void> {
    this.#closed.abort();
  }
}

class SpeechChunks extends tts.ChunkedStream {
  label: string;
  #speech: LineSpeech;
  #closed: AbortSignal;

  constructor(owner: StreamingLineTTS, text: string, speech: LineSpeech, closed: AbortSignal, connOptions?: APIConnectOptions, abortSignal?: AbortSignal) {
    super(text, owner, connOptions, abortSignal);
    this.label = `${speech.provider}.LineChunks`;
    this.#speech = speech;
    this.#closed = closed;
  }

  protected async run(): Promise<void> {
    const signal = AbortSignal.any([this.abortSignal, this.#closed]);
    const requestId = shortuuid();
    // One frame is held back so the last one can be marked final.
    let held: AudioFrame | null = null;
    try {
      for await (const frame of this.#speech.frames(this.inputText, signal)) {
        if (held) this.queue.put({ requestId, segmentId: requestId, frame: held, final: false });
        held = frame;
      }
      const last: AudioFrame | null = held;
      if (last) this.queue.put({ requestId, segmentId: requestId, frame: last, final: true });
    } catch (error) {
      // Cut off (barge-in, a closing session): that's the end of this line, not a failure.
      if (signal.aborted) return;
      throw error;
    }
  }
}
