/**
 * The call between you and the assistant while the walkthrough runs, as the screen shows it: whether the
 * assistant is on the plan, what it is doing, and the words on screen with who said them. How loud each
 * voice is changes every frame, so levels are read when they are drawn, never stored.
 */
import { sleep, throwIfStopped } from './wait';

/** Whether the assistant is on the plan. */
export type Presence = 'away' | 'joining' | 'here' | 'leaving';

/** What the assistant is doing while it is here. */
export type Activity = 'idle' | 'listening' | 'thinking' | 'working';

/** Words on screen, a few at a time as they are said. */
export interface Words {
  who: 'you' | 'assistant';
  /** Who said it, on a call with several people (you included, by name, on the call's captions). */
  name?: string;
  /** Their color (their cursor's), for their name on the call's captions. */
  color?: string;
  text: string;
  /** How many of its words are on screen. */
  shown: number;
  /** How many of the last words are still being made out (live transcription), shown fainter. */
  tentative?: number;
}

export interface CallState {
  presence: Presence;
  activity: Activity;
  /** While the assistant's words are coming out. */
  speaking: boolean;
  /** While you are talking (voice mode). */
  youTalking: boolean;
  words: Words | null;
  /** The step's takeaway, once everyone has stopped talking. */
  takeaway: { lead: string; text: string } | null;
  /** Your microphone: only the voice mode has one. `deaf`: its level works, but no words can be made out. */
  mic: 'none' | 'starting' | 'on' | 'blocked' | 'deaf';
}

/** Something with a loudness, 0 (silent) to 1. */
export interface LevelSource {
  level(): number;
}

export interface CallOptions {
  /** The assistant's name on screen. */
  name?: string;
  /** 1 is speech pace; 0 shows every line at once, for tests. */
  speed?: number;
}

export const wordsOf = (text: string): string[] => text.trim().split(/\s+/).filter(Boolean);

/** How long a word stays the newest one on screen: longer words take longer, and a stop or a comma adds a breath. */
export function wordTime(word: string, wordsPerSecond: number): number {
  const breath = /[.!?…]["”’)]?$/.test(word) ? 360 : /[,:;—]$/.test(word) ? 200 : 0;
  return (1000 / wordsPerSecond) * (0.7 + Math.min(word.length, 12) / 16) + breath;
}

const INITIAL: CallState = { presence: 'away', activity: 'idle', speaking: false, youTalking: false, words: null, takeaway: null, mic: 'none' };

export class Call {
  readonly name: string;
  speed: number;
  /** Your voice, when the microphone is on. */
  you: LevelSource | null = null;
  /** The assistant's voice, when it has one; otherwise a level is made up from its words. */
  voice: LevelSource | null = null;
  private current: CallState = INITIAL;
  private readonly listeners = new Set<(state: CallState) => void>();
  /** Bumped by every new line, so an older line stops revealing itself. */
  private line = 0;
  private talking: Promise<void> = Promise.resolve();
  private takeawayTimer: ReturnType<typeof setTimeout> | null = null;
  private spokeAt = 0;

  constructor({ name = 'Assistant', speed = 1 }: CallOptions = {}) {
    this.name = name;
    this.speed = speed;
  }

  get state(): CallState {
    return this.current;
  }

  subscribe(listener: (state: CallState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  set(change: Partial<CallState>): void {
    const next = { ...this.current, ...change };
    if (Object.keys(change).every((key) => next[key as keyof CallState] === this.current[key as keyof CallState])) return;
    this.current = next;
    for (const listener of this.listeners) listener(next);
  }

  private wait(ms: number, signal?: AbortSignal): Promise<void> {
    throwIfStopped(signal);
    return this.speed <= 0 ? Promise.resolve() : sleep(ms / this.speed, signal);
  }

  /** How loud the assistant is now. Without a voice of its own, speech-like bursts while its words come out. */
  assistantLevel(now = performance.now()): number {
    if (this.voice) return this.voice.level();
    if (!this.current.speaking) return 0;
    const t = now - this.spokeAt;
    const syllables = Math.abs(Math.sin(t * 0.0109));
    const phrase = 0.62 + 0.38 * Math.sin(t * 0.0029 + 1.3);
    return Math.min(1, 0.18 + 0.62 * syllables * phrase);
  }

  /** How loud you are now (0 without a microphone). */
  yourLevel(): number {
    return this.you?.level() ?? 0;
  }

  /** The assistant arrives, the way someone joins a call. */
  async join(signal?: AbortSignal): Promise<void> {
    if (this.current.presence === 'here') return;
    this.set({ presence: 'joining', activity: 'idle' });
    await this.wait(900, signal);
    this.set({ presence: 'here' });
  }

  /** The assistant leaves the call. */
  async leave(signal?: AbortSignal): Promise<void> {
    if (this.current.presence === 'away') return;
    this.line += 1;
    this.set({ presence: 'leaving', activity: 'idle', speaking: false });
    await this.wait(900, signal);
    this.set({ presence: 'away' });
  }

  /** What it is doing now, while it is here. */
  doing(activity: Activity): void {
    if (this.current.presence === 'here' || this.current.presence === 'joining') this.set({ activity });
  }

  /** Waits for `work` while the assistant thinks, then goes back to what it was doing. */
  async think<T>(work: Promise<T>): Promise<T> {
    const before = this.current.activity === 'thinking' ? 'working' : this.current.activity;
    this.doing('thinking');
    try {
      return await work;
    } finally {
      if (this.current.activity === 'thinking') this.doing(before);
    }
  }

  /**
   * The assistant says a line: its words come up a few at a time, at speech pace, while its avatar
   * speaks. Resolves when the last word is on screen. A newer line takes over from an older one.
   */
  say(text: string, signal?: AbortSignal, { wordsPerSecond = 3.2 }: { wordsPerSecond?: number } = {}): Promise<void> {
    const spoken = this.reveal('assistant', text, signal, wordsPerSecond);
    this.talking = spoken.catch(() => undefined);
    return spoken;
  }

  /**
   * Your line on screen. With `reveal`, it comes up at a reading pace, so a reviewer pressing Next isn't
   * kept waiting; heard already (the voice mode), it is all there at once.
   */
  async hear(text: string, signal?: AbortSignal, { reveal = true }: { reveal?: boolean } = {}): Promise<void> {
    if (!reveal) {
      this.line += 1;
      this.clearTakeaway();
      this.set({ words: { who: 'you', text, shown: wordsOf(text).length }, youTalking: false });
      return;
    }
    const before = this.current.activity;
    this.doing('listening');
    try {
      await this.reveal('you', text, signal, 7);
    } finally {
      if (this.current.activity === 'listening') this.doing(before === 'listening' ? 'idle' : before);
    }
  }

  /** Waits until the assistant has finished its line. */
  quiet(): Promise<void> {
    return this.talking;
  }

  /** After a pause, the step's takeaway replaces the last line, unless someone speaks first. */
  settle(takeaway: { lead: string; text: string }, afterMs = 1400): void {
    this.clearTakeaway();
    const line = this.line;
    const show = () => {
      if (this.line === line && !this.current.speaking && !this.current.youTalking) this.set({ takeaway, words: null });
    };
    if (this.speed <= 0) show();
    else this.takeawayTimer = setTimeout(show, afterMs / this.speed);
  }

  /** Puts everything away at once, as when the walkthrough goes back to its start. */
  reset(): void {
    this.line += 1;
    this.clearTakeaway();
    this.set({ ...INITIAL, mic: this.current.mic });
  }

  /** Clears the words on screen (Previous). */
  clearWords(): void {
    this.line += 1;
    this.clearTakeaway();
    this.set({ words: null, takeaway: null, speaking: false });
  }

  /**
   * Shows what you are saying as it is transcribed: `text` is everything heard of your line so far, and
   * its last `tentative` words are still being made out. While you talk, the assistant is listening. On a
   * call with several people, `name` says who is talking, and `color` is theirs.
   */
  showHeard(text: string, tentative: number, name?: string, color?: string): void {
    if (this.current.words?.who !== 'you' || this.current.words.name !== name) {
      this.line += 1;
      this.clearTakeaway();
    }
    const listening = this.current.presence === 'here' && this.current.activity === 'idle';
    this.set({
      words: { who: 'you', text, shown: wordsOf(text).length, tentative, ...(name ? { name } : {}), ...(color ? { color } : {}) },
      takeaway: null,
      ...(listening ? { activity: 'listening' as const } : {}),
    });
  }

  /** Shows the assistant's words as its voice says them (they come from the voice's own transcript). */
  showSpeech(text: string, speaking: boolean): void {
    if (this.current.words?.who !== 'assistant') {
      this.line += 1;
      this.clearTakeaway();
    }
    if (speaking && !this.current.speaking) this.spokeAt = performance.now();
    this.set({ words: { who: 'assistant', text, shown: wordsOf(text).length }, takeaway: null, speaking });
  }

  private clearTakeaway(): void {
    if (this.takeawayTimer) clearTimeout(this.takeawayTimer);
    this.takeawayTimer = null;
  }

  private async reveal(who: Words['who'], text: string, signal: AbortSignal | undefined, wordsPerSecond: number): Promise<void> {
    const words = wordsOf(text);
    const line = ++this.line;
    this.clearTakeaway();
    const speaking = who === 'assistant';
    if (speaking) this.spokeAt = performance.now();
    this.set({ words: { who, text, shown: this.speed <= 0 ? words.length : 0 }, takeaway: null, speaking, youTalking: !speaking });
    try {
      if (this.speed <= 0) return;
      for (let shown = 1; shown <= words.length; shown += 1) {
        if (this.line !== line) return;
        this.set({ words: { who, text, shown } });
        await this.wait(wordTime(words[shown - 1]!, wordsPerSecond), signal);
      }
    } finally {
      if (this.line === line) this.set(speaking ? { speaking: false } : { youTalking: false });
    }
  }
}
