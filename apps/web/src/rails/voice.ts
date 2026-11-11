/**
 * The voice mode, for recording the film on this machine: how loud you are, on screen, and what you
 * say, transcribed as you say it, like live captions on a call. What was heard is what is shown and what
 * goes to the assistant: nothing is swapped for the printed line. If nothing was heard, the step waits
 * for you to say it again. Only the dev server can load this file, and only with `?voice` in the address
 * (`?voice=fake` makes up a talker, to check the screen without one).
 *
 * The words come from the browser's own speech recognition. Chrome sends the audio to Google's speech
 * service while it listens; the app keeps none of it. The level comes from the microphone, read and
 * dropped frame by frame, so a cough moves the meter, as on any call, but makes no words.
 */
import { wordsOf, type Call, type LevelSource } from './call';

/** The language you are heard in: English as spoken in India. */
export const HEARD_IN = 'en-IN';

/** Loudness from a block of samples' RMS, 0 (room noise) to 1 (speaking up), on a decibel scale. */
export function levelFromRms(rms: number, floorDb = -58, ceilingDb = -16): number {
  if (!(rms > 0)) return 0;
  const db = 20 * Math.log10(rms);
  return Math.min(1, Math.max(0, (db - floorDb) / (ceilingDb - floorDb)));
}

/** Follows a level the way a meter needle does: up quickly, down slowly. `dt` is in ms. */
export function follow(current: number, target: number, dt: number, attackMs = 35, releaseMs = 240): number {
  const tau = target > current ? attackMs : releaseMs;
  return current + (target - current) * (1 - Math.exp(-dt / tau));
}

/**
 * Whether there is sound like talking: on once the level has stayed up for a moment, off once it has
 * stayed down for longer, so the gaps between words don't count as silence. It drives the rings and the
 * meter, never the words.
 */
export class TalkDetector {
  talking = false;
  private loud = 0;
  private quiet = 0;

  constructor(
    private readonly on = 0.24,
    private readonly off = 0.12,
    private readonly startMs = 70,
    private readonly stopMs = 420,
  ) {}

  update(level: number, dt: number): boolean {
    if (level >= this.on) {
      this.loud += dt;
      this.quiet = 0;
      if (this.loud >= this.startMs) this.talking = true;
    } else if (level < this.off) {
      this.quiet += dt;
      this.loud = 0;
      if (this.quiet >= this.stopMs) this.talking = false;
    }
    return this.talking;
  }
}

export interface Mic extends LevelSource {
  close(): void;
}

/** Your microphone's loudness. Asks for the microphone once; the browser remembers the answer for this address. */
export async function openMic(): Promise<Mic> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
  const level = levelOf(stream);
  return {
    level: () => level.level(),
    close() {
      level.close();
      for (const track of stream.getTracks()) track.stop();
    },
  };
}

/** How loud a stream of sound is, read when asked: a microphone, or a voice coming in over the network. */
export function levelOf(stream: MediaStream): Mic {
  const context = new AudioContext();
  // A browser keeps sound off until the page has been touched: the first press or key turns it on.
  const resume = () => {
    if (context.state === 'suspended') void context.resume();
  };
  resume();
  window.addEventListener('pointerdown', resume, true);
  window.addEventListener('keydown', resume, true);
  const analyser = context.createAnalyser();
  analyser.fftSize = 1024;
  context.createMediaStreamSource(stream).connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  let value = 0;
  let readAt = 0;
  return {
    level() {
      const now = performance.now();
      if (now - readAt < 10) return value;
      const dt = readAt === 0 ? 16 : Math.min(100, now - readAt);
      readAt = now;
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (let index = 0; index < samples.length; index += 1) sum += samples[index]! * samples[index]!;
      value = follow(value, levelFromRms(Math.sqrt(sum / samples.length)), dt);
      return value;
    },
    close() {
      window.removeEventListener('pointerdown', resume, true);
      window.removeEventListener('keydown', resume, true);
      void context.close();
    },
  };
}

/** A made-up talker: about four seconds of talking, then a pause, over and over. */
export function fakeMic(started = performance.now()): Mic {
  return {
    level() {
      const t = (performance.now() - started) % 6500;
      if (t > 4000) return 0.02;
      const syllables = Math.abs(Math.sin(t * 0.0115));
      const phrase = 0.55 + 0.45 * Math.sin(t * 0.0021 + 0.6);
      return Math.min(1, 0.12 + 0.75 * syllables * phrase);
    },
    close() {},
  };
}

/** What has been heard of your line: the words settled on, then those still being made out. */
export interface Heard {
  final: string;
  tentative: string;
}

const join = (...parts: string[]) => parts.map((part) => part.trim()).filter(Boolean).join(' ');

/** Turns speech into words, a line at a time. */
export interface Ears {
  start(heard: (words: Heard) => void, trouble: (reason: string) => void): void;
  /** A new line starts: what was heard before doesn't count toward it. `expected` is for made-up ears only. */
  newLine(expected: string): void;
  /** Lets the words still being made out settle (briefly), then returns everything heard of the line. */
  settle(waitMs: number): Promise<Heard>;
  close(): void;
}

/** The browser's speech recognition, as far as the ears need it. */
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: { results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
}

function recognitionClass(): (new () => Recognition) | null {
  const scope = globalThis as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

/**
 * The browser's own ears. One recognition session runs for as long as the voice mode is on; when the
 * browser ends it (it does, after a while), another starts, and what was already heard of the line is
 * kept.
 */
export class BrowserEars implements Ears {
  private recognition: Recognition | null = null;
  private on = false;
  /** Results before this one belong to an earlier line. */
  private from = 0;
  private count = 0;
  /** What this line heard in sessions that have ended. */
  private carried = '';
  private now: Heard = { final: '', tentative: '' };
  private waiting: (() => void)[] = [];
  private heard: (words: Heard) => void = () => undefined;

  constructor(private readonly lang = HEARD_IN) {}

  start(heard: (words: Heard) => void, trouble: (reason: string) => void): void {
    const Recognition = recognitionClass();
    if (!Recognition) {
      trouble('This browser has no speech recognition (Chrome has).');
      return;
    }
    this.heard = heard;
    const recognition = new Recognition();
    recognition.lang = this.lang;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.onresult = (event) => {
      this.count = event.results.length;
      let final = '';
      let tentative = '';
      for (let index = this.from; index < event.results.length; index += 1) {
        const result = event.results[index]!;
        if (result.isFinal) final = join(final, result[0].transcript);
        else tentative = join(tentative, result[0].transcript);
      }
      this.now = { final: join(this.carried, final), tentative };
      this.heard(this.now);
      if (!tentative) this.release();
    };
    recognition.onerror = (event) => {
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        this.on = false;
        trouble('Speech recognition isn’t allowed here.');
      } else if (event.error === 'network') trouble('Speech recognition needs the network.');
      // "no-speech" and "aborted" are part of listening: it simply starts again.
    };
    recognition.onend = () => {
      // Whatever was still being made out counts: the session that heard it is over.
      this.carried = join(this.now.final, this.now.tentative);
      this.now = { final: this.carried, tentative: '' };
      this.from = 0;
      this.count = 0;
      this.release();
      if (this.on) setTimeout(() => this.on && this.begin(), 120);
    };
    this.recognition = recognition;
    this.on = true;
    this.begin();
  }

  private begin(): void {
    try {
      this.recognition?.start();
    } catch {
      // Already listening.
    }
  }

  private release(): void {
    for (const resolve of this.waiting.splice(0)) resolve();
  }

  newLine(): void {
    this.from = this.count;
    this.carried = '';
    this.now = { final: '', tentative: '' };
  }

  async settle(waitMs: number): Promise<Heard> {
    if (this.now.tentative && this.recognition) {
      // Stopping makes the browser settle what it has; the session then starts again by itself.
      const settled = new Promise<void>((resolve) => this.waiting.push(resolve));
      this.recognition.stop();
      await Promise.race([settled, new Promise((resolve) => setTimeout(resolve, waitMs))]);
    }
    return { ...this.now };
  }

  close(): void {
    this.on = false;
    this.recognition?.abort();
    this.recognition = null;
    this.release();
  }
}

/**
 * Made-up ears for `?voice=fake`, to check the screen without a talker: while the made-up talker talks,
 * the expected line comes up a word at a time, its last two words still being made out.
 */
export class FakeEars implements Ears {
  private words: string[] = [];
  private said = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private heard: (words: Heard) => void = () => undefined;

  constructor(private readonly mic: LevelSource) {}

  start(heard: (words: Heard) => void): void {
    this.heard = heard;
    this.timer = setInterval(() => {
      if (this.said >= this.words.length || this.mic.level() < 0.2) return;
      this.said += 1;
      this.report(2);
    }, 380);
  }

  private report(tentative: number): void {
    const final = this.words.slice(0, Math.max(0, this.said - tentative)).join(' ');
    const rest = this.words.slice(Math.max(0, this.said - tentative), this.said).join(' ');
    this.heard({ final, tentative: rest });
  }

  newLine(expected: string): void {
    this.words = wordsOf(expected);
    this.said = 0;
  }

  async settle(): Promise<Heard> {
    this.report(0);
    const said = this.words.slice(0, this.said).join(' ');
    return { final: said, tentative: '' };
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

/**
 * Listens between presses: what you say comes up on the call as it is heard, and the press takes the
 * line as heard. The meter and the rings follow the microphone's level all the while.
 */
export class Listener {
  private open = false;
  private expected: string | null = null;
  private frame = 0;
  private last = 0;
  private wasTalking = false;
  private readonly detector = new TalkDetector();

  constructor(
    private readonly call: Call,
    private readonly mic: LevelSource,
    private readonly ears: Ears,
  ) {
    ears.start(
      (heard) => this.show(heard),
      (reason) => {
        console.warn(`The voice mode can’t make out words: ${reason}`);
        call.set({ mic: 'deaf' });
      },
    );
    this.frame = requestAnimationFrame(this.tick);
  }

  /** Listens for the next line. `expected` is the printed line, which only made-up ears use. */
  listen(expected: string): void {
    if (this.open && this.expected === expected) return;
    this.ears.newLine(expected);
    this.expected = expected;
    this.open = true;
  }

  /** Stops showing words (a step is running, or no line comes next). What was heard stays for `take`. */
  stop(): void {
    this.open = false;
    this.expected = null;
  }

  /** The line as heard, once the last words have settled. Empty if nothing was heard. */
  async take(waitMs = 1200): Promise<string> {
    const heard = await this.ears.settle(waitMs);
    return join(heard.final, heard.tentative);
  }

  close(): void {
    cancelAnimationFrame(this.frame);
    this.ears.close();
    this.open = false;
  }

  private show(heard: Heard): void {
    if (!this.open) return;
    const text = join(heard.final, heard.tentative);
    if (text) this.call.showHeard(text, wordsOf(heard.tentative).length);
  }

  private readonly tick = (now: number) => {
    const dt = this.last ? Math.min(100, now - this.last) : 16;
    this.last = now;
    const talking = this.detector.update(this.mic.level(), dt);
    if (talking !== this.wasTalking) this.call.set({ youTalking: talking });
    this.wasTalking = talking;
    this.frame = requestAnimationFrame(this.tick);
  };
}

export interface Voice {
  listener: Listener;
  close(): void;
}

/** Turns the voice mode on for this call: the microphone and the browser's ears (or a made-up talker). */
export async function startVoice(call: Call, kind: 'mic' | 'fake'): Promise<Voice> {
  call.set({ mic: 'starting' });
  let mic: Mic;
  try {
    mic = kind === 'fake' ? fakeMic() : await openMic();
  } catch (error) {
    call.set({ mic: 'blocked' });
    throw error;
  }
  call.you = mic;
  call.set({ mic: 'on' });
  const listener = new Listener(call, mic, kind === 'fake' ? new FakeEars(mic) : new BrowserEars());
  return {
    listener,
    close() {
      listener.close();
      mic.close();
      call.you = null;
      call.set({ mic: 'none', youTalking: false });
    },
  };
}
