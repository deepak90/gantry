/**
 * Where the assistant is, for anything that draws it outside the call bar (the 3D view's floating face): its mood on
 * the call, how loud its voice is, and where its cursor is. A call writes it, the walkthrough's or the spoken one;
 * the scene reads it. One call at a time owns it.
 */
import type { Call, CallState } from '../rails/call';
import type { Hand } from '../rails/hand';

export type AssistantMood = 'away' | 'joining' | 'leaving' | 'idle' | 'listening' | 'thinking' | 'working' | 'speaking';

/** The assistant's cursor: where it is, whether it is at work (not resting in the header), and whether it is pressing. */
export interface AssistantPointer {
  x: number;
  y: number;
  shown: boolean;
  pressing: boolean;
}

type Listener = (mood: AssistantMood) => void;

const SILENT = (): number => 0;
const NOWHERE = (): AssistantPointer | null => null;

let mood: AssistantMood = 'away';
let voice: () => number = SILENT;
let yours: () => number = SILENT;
let pointer: () => AssistantPointer | null = NOWHERE;
/** Remy's own cursor (remy-cursor.ts), when she shows someone something without the call's walkthrough cursor. */
let lent: () => AssistantPointer | null = NOWHERE;
let owner: object | null = null;
const listeners = new Set<Listener>();

function setMood(next: AssistantMood): void {
  if (next === mood) return;
  mood = next;
  for (const listener of listeners) listener(mood);
}

/** The call's state in one word, as its face on the call bar shows it. */
export function moodOf(state: Pick<CallState, 'presence' | 'speaking' | 'activity' | 'youTalking'>): AssistantMood {
  if (state.presence === 'away') return 'away';
  if (state.presence === 'joining') return 'joining';
  if (state.presence === 'leaving') return 'leaving';
  if (state.speaking) return 'speaking';
  if (state.activity === 'listening' || state.youTalking) return 'listening';
  if (state.activity === 'thinking') return 'thinking';
  if (state.activity === 'working') return 'working';
  return 'idle';
}

export const attention = {
  get mood(): AssistantMood {
    return mood;
  },
  /** How loud the assistant's voice is now, 0 to 1: its real voice on a spoken call, its words' rhythm otherwise. */
  voice: (): number => voice(),
  /** How loud you are now, 0 to 1 (0 without a microphone). */
  yours: (): number => yours(),
  /** The call's cursor while it is at work, else Remy's own cursor while she shows someone something. */
  pointer: (): AssistantPointer | null => {
    const own = pointer();
    if (own?.shown) return own;
    const borrowed = lent();
    return borrowed?.shown ? borrowed : own;
  },
  /** Hears every change of mood, and the mood as it is now. */
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    listener(mood);
    return () => {
      listeners.delete(listener);
    };
  },
};

/** Lends Remy's own cursor to what the scene reads (the face follows it over the 3D view), until the returned function is called. */
export function lendPointer(source: () => AssistantPointer | null): () => void {
  lent = source;
  return () => {
    if (lent === source) lent = NOWHERE;
  };
}

/** Mirrors a call and its cursor into what the scene reads, until the returned function is called. */
export function mirrorCall(call: Pick<Call, 'state' | 'subscribe' | 'assistantLevel' | 'yourLevel'>, hand: Pick<Hand, 'pointer'> | null): () => void {
  const token = {};
  owner = token;
  voice = () => call.assistantLevel();
  yours = () => call.yourLevel();
  pointer = hand ? () => hand.pointer : NOWHERE;
  setMood(moodOf(call.state));
  const stop = call.subscribe((state) => {
    if (owner === token) setMood(moodOf(state));
  });
  return () => {
    stop();
    if (owner !== token) return;
    owner = null;
    voice = SILENT;
    yours = SILENT;
    pointer = NOWHERE;
    setMood('away');
  };
}
