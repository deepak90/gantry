/**
 * Remy's own voice: ElevenLabs, one request per line, behind the same `LineSpeech` as OpenAI's (tts.ts), so the jitter
 * buffer, captions, barge-in and fillers don't know which voice is speaking. The line is written out before it is sent
 * (`speakableText`): left alone the fast models read "Mon, Nov 2" as it stands and garble "sq ft". ElevenLabs' own
 * text normalization is off: it would add about 26 ms a line and leave her reading of money and dates to the server;
 * the captions keep the digits they were handed.
 */
import { ELEVEN_TTS_MODEL, TTS_INSTRUCTIONS, TTS_MODEL, TTS_VOICE } from './config.ts';
import { PAUSES } from './pauses.ts';
import { speakableText, spokenWords } from './spoken.ts';
import { LineSpeech, OpenAISpeech, transientStatus, type LineShaping } from './tts.ts';

const API = 'https://api.elevenlabs.io/v1';
/** Raw 16-bit PCM at 24 kHz, the rate the rest of the mouth runs at. */
const OUTPUT_FORMAT = 'pcm_24000';

/**
 * A line of a word or two gives the voice nothing to take its tone from, and it guesses: three of four takes of
 * "Anytime!" came out loud and high, and one ran nearly an octave above her. Such a line is read
 * without an exclamation, steadier than her saved 0.5, following what she said last: four of four takes that way sat at
 * her own pitch. Her longer lines keep her saved settings.
 */
const BARE_LINE_WORDS = 2;
const BARE_LINE_VOICE = { stability: 0.85, similarity_boost: 0.75 };

export interface ElevenLabsOptions extends LineShaping {
  apiKey: string;
  voiceId: string;
  model: string;
}

/** ElevenLabs refused a request. The message says why; it never holds the key or the voice's id. */
export class ElevenLabsError extends Error {
  readonly status: number;

  constructor(status: number, reason: string) {
    super(`ElevenLabs answered ${status}: ${reason}`);
    this.name = 'ElevenLabsError';
    this.status = status;
  }
}

export class ElevenLabsSpeech extends LineSpeech {
  readonly provider = 'api.elevenlabs.io';
  readonly model: string;
  readonly voiceLabel = 'custom';
  /**
   * Off: a checked line can't start until it is all rendered, and the limits were tuned on OpenAI's voice for a drift
   * this one doesn't show: of 96 takes of her lines on Flash and Multilingual, the slowest ran 278 ms a syllable against
   * the 300 limit, none had fry, and no line's slowest take ran more than 1.3 times its fastest.
   */
  readonly checksPace = false;
  #apiKey: string;
  #voiceId: string;
  /** Her last full line as sent: what a bare line takes its tone from. */
  #lastLine = '';

  constructor(options: Pick<ElevenLabsOptions, 'apiKey' | 'voiceId'> & Partial<ElevenLabsOptions>) {
    const all: ElevenLabsOptions = { model: ELEVEN_TTS_MODEL, trimLeadingSilence: true, pauses: PAUSES, ...options };
    super(all);
    this.model = all.model;
    this.#apiKey = all.apiKey;
    this.#voiceId = all.voiceId;
  }

  get voiceKey(): string {
    return [this.provider, this.model, this.#voiceId].join('|');
  }

  protected async open(text: string, signal?: AbortSignal): Promise<AsyncIterable<Uint8Array>> {
    const response = await fetch(`${API}/text-to-speech/${encodeURIComponent(this.#voiceId)}/stream?output_format=${OUTPUT_FORMAT}`, {
      method: 'POST',
      headers: { 'xi-api-key': this.#apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ ...this.#reading(text), model_id: this.model, apply_text_normalization: 'off' }),
      signal,
    });
    if (!response.ok) throw new ElevenLabsError(response.status, await this.#reason(response));
    if (!response.body) throw new Error('the speech response has no body');
    return response.body as unknown as AsyncIterable<Uint8Array>;
  }

  /** What the voice is asked to read, and how. */
  #reading(text: string): { text: string; voice_settings?: typeof BARE_LINE_VOICE; previous_text?: string } {
    const line = speakableText(text);
    if (spokenWords(text).length > BARE_LINE_WORDS) {
      this.#lastLine = line;
      return { text: line };
    }
    return { text: line.replace(/!+$/, '.'), voice_settings: BARE_LINE_VOICE, ...(this.#lastLine ? { previous_text: this.#lastLine } : {}) };
  }

  protected retryable(error: unknown): boolean {
    // fetch rejects with a TypeError when it can't reach the server at all.
    return error instanceof ElevenLabsError ? transientStatus(error.status) : error instanceof TypeError;
  }

  async #reason(response: Response): Promise<string> {
    const raw = await response.text().catch(() => '');
    let reason = raw;
    try {
      const { detail } = JSON.parse(raw) as { detail?: unknown };
      if (detail !== undefined) reason = typeof detail === 'string' ? detail : JSON.stringify(detail);
    } catch {
      // not JSON: the text as it came
    }
    return reason.split(this.#apiKey).join('<key>').split(this.#voiceId).join('<voice>').slice(0, 300);
  }
}

/** Her ElevenLabs voice when its id is set, otherwise OpenAI's. */
export function chooseSpeech(env: Record<string, string | undefined> = process.env): LineSpeech {
  const voiceId = env.ELEVEN_LABS_VOICE_REMY_KEY?.trim();
  if (!voiceId) return new OpenAISpeech({ model: TTS_MODEL, voice: TTS_VOICE, instructions: TTS_INSTRUCTIONS });
  const apiKey = env.ELEVEN_LABS_API_KEY?.trim();
  if (!apiKey) throw new Error('ELEVEN_LABS_VOICE_REMY_KEY is set but ELEVEN_LABS_API_KEY is not');
  return new ElevenLabsSpeech({ apiKey, voiceId });
}
