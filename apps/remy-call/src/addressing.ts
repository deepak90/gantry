/**
 * Who a turn is for. Remy answers only lines meant for her, the way people address each other on
 * a call:
 *
 * - **By name, as an address:** "Remy, …", "Hey Remy, …", "Wait, Remy, …", "…, Remy?", or the
 *   name opening a question ("Remy can you…"). Saying the name in passing is not an address:
 *   "Remy's got it on hold" or "I'll ask Remy". "Remi" and "Remmy" count as the name. "Remy's" opening a
 *   question or request counts ("Remy's the slab still on hold?" is how a quick "Remy, is…" gets
 *   written down).
 * - **Following up:** the same person's next turn within 8 s of Remy answering them. A summons,
 *   a bare "Remy?" or a check-in like "Remy, you on?", opens the same 8 s for that person. Within
 *   the window, a plain "okay" or "thanks" is not a question for Remy (unless Remy's answer asked
 *   one), and a line that names someone else ("Nora, …") is for them. Someone else asking the
 *   others a question in between closes it: the next words answer them.
 * - **Alone with her:** with one person on the call, there is nobody else to talk to, so every line
 *   is for Remy, name or not. A plain "okay" or "thanks" still isn't a question; it is for her only
 *   when her answer asked them something (a "yes" to "Want me to prepare it?"), within 30 s.
 *
 * Everything else is people talking to each other, and Remy stays quiet.
 */
import { ALONE_ANSWER_MS, FOLLOW_UP_MS } from './config.ts';

const NAME = '(?:remy|remi|remmy)';
const INTERJECTION = '(?:hey|hi|hello|okay|ok|so|well|wait|alright|right|um|uh|oh|yo|now|sorry|thanks|thank you)';
/** Before a name set off by punctuation: the start, punctuation, a dash, or an interjection. */
const BEFORE_SET_OFF = String.raw`(?:^|[.?!;:,—–…]\s*|\s-+\s*|\b(?:${INTERJECTION}|and|but)\b,?\s+)`;
const AFTER_SET_OFF = String.raw`(?=\s*(?:[,.?!;:—–…]|-(?!\w)|$))`;
/** Before a name that opens a sentence. */
const SENTENCE_START = String.raw`(?:^|[.?!;:—–…]\s*|\b${INTERJECTION}\b,?\s+)`;
const WH = "(?:what|what's|whats|when|where|how|why|who|which)";
const REQUEST = "(?:please|tell|show|check|give|send|move|find|pull|put|add|remind|look|let's|lets)";
const AUX = '(?:can|could|would|will|do|does|did|are|is|have|has|should)';
const REQUEST_IN_SENTENCE = /\b(?:(?:can|could|would|will)\s+you|please|let's)\b/i;

function normalize(text: string): string {
  return text.replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function vocativePatterns(name: string): RegExp[] {
  return [
    // "Remy, …" / "…, Remy?" / "Hey Remy." / "Wait— wait, Remy, …"
    new RegExp(`${BEFORE_SET_OFF}${name}${AFTER_SET_OFF}`, 'i'),
    // No comma written: "Remy what's…", "Okay Remy, check…", "Remy can you…"
    new RegExp(String.raw`${SENTENCE_START}${name}\s+(?:${WH}|${REQUEST})\b`, 'i'),
    new RegExp(String.raw`${SENTENCE_START}${name}\s+${AUX}\s+you\b`, 'i'),
    // "Remy is the slab on hold?": an auxiliary opening a question.
    new RegExp(String.raw`${SENTENCE_START}${name}\s+(?:${AUX}|you)\b[^.?!]*\?`, 'i'),
  ];
}

const REMY_VOCATIVE = vocativePatterns(NAME);
const REMY_POSSESSIVE = new RegExp(String.raw`${SENTENCE_START}${NAME}'s\b([^.?!]*)([.?!]|$)`, 'gi');
const OPENER = String.raw`(?:(?:hey|hi|hello|okay|ok|so|um|uh|oh|yo|well)\W+)*`;
/** What people say to see if someone is there, or to get their attention. */
const CHECK_IN = String.raw`(?:(?:are\s+)?you\s+(?:on|there|here|around|with\s+us|listening|awake)|quick\s+question|(?:you\s+)?got\s+a\s+(?:sec|second|minute|moment))`;
const SUMMONS = [
  new RegExp(String.raw`^\W*${OPENER}${NAME}(?:\W+${CHECK_IN})?\W*$`, 'i'),
  new RegExp(String.raw`^\W*${OPENER}${CHECK_IN}\W+${NAME}\W*$`, 'i'),
];
/** Trailing off: "Remy, can you—", "…the crane, um…". */
const TRAILING = /(?:\.\.\.|…|—|–|-|,|:)\s*$/;
const DANGLING = /\b(?:um|uh|so|and|but|or|the|a|an|to|of|for|with|if|because|like|(?:can|could|would|will)\s+you)\W*$/i;
const NOT_CONTENT = new RegExp(String.raw`^(?:remy|remi|remmy|remy's|hey|hi|hello|okay|ok|so|um|uh|oh|yo|well|wait|right|alright)$`, 'i');

/** True when the text uses Remy's name as an address (see the module comment). */
export function addressesRemy(text: string): boolean {
  const t = normalize(text);
  if (REMY_VOCATIVE.some((pattern) => pattern.test(t))) return true;
  for (const match of t.matchAll(REMY_POSSESSIVE)) {
    const rest = match[1] ?? '';
    if (match[2] === '?' || REQUEST_IN_SENTENCE.test(rest)) return true;
  }
  return false;
}

/** "Remy?", "Hey Remy, you there?", "Remy, quick question.": a summons, with the question still to come. */
export function isSummons(text: string): boolean {
  const t = normalize(text);
  return SUMMONS.some((pattern) => pattern.test(t));
}

/**
 * An address that may not be over: a summons, a line trailing off, or one or two words besides the
 * name. The turn waits a little longer for the person to go on, so the question arrives whole.
 * `alone`: one person on the call, whose every line is for Remy: one trailing off waits too, name or not.
 */
export function mayContinue(text: string, alone = false): boolean {
  const t = normalize(text);
  if (isSummons(t)) return true;
  if (!addressesRemy(t)) return alone && (TRAILING.test(t) || DANGLING.test(t));
  if (TRAILING.test(t) || DANGLING.test(t)) return true;
  const words = t.split(/[^\p{L}\p{N}'-]+/u).filter((word) => word && !NOT_CONTENT.test(word));
  return words.length <= 2;
}

/** True when the text addresses one of these people by (first) name: "Nora, …", "…, Tony?". */
export function addressesSomeoneElse(text: string, names: readonly string[]): boolean {
  const t = normalize(text);
  for (const name of names) {
    const clean = name.trim();
    if (clean.length < 2 || /^(?:remy|remi|remmy)$/i.test(clean)) continue;
    if (vocativePatterns(escapeRegExp(clean)).some((pattern) => pattern.test(t))) return true;
  }
  return false;
}

const BACKCHANNEL = new Set([
  'mm', 'mmm', 'mhm', 'mmhm', 'mm-hm', 'mm-hmm', 'mhmm', 'hmm', 'hm', 'uh-huh', 'uh', 'um', 'ah', 'oh',
  'okay', 'ok', 'kay', 'yeah', 'yep', 'yup', 'yes', 'right', 'sure', 'cool', 'great', 'nice', 'perfect', 'good',
  'alright', 'all', 'got', 'it', 'gotcha', 'thanks', 'thank', 'you', 'sounds', 'makes', 'sense', 'fine',
]);

/** "Okay." "Mm-hm." "Got it, thanks." A turn that only acknowledges what was said. */
export function isBackchannel(text: string): boolean {
  const words = normalize(text)
    .toLowerCase()
    .split(/[^a-z'-]+/)
    .map((word) => word.replace(/^['-]+|['-]+$/g, ''))
    .filter(Boolean);
  return words.length > 0 && words.every((word) => BACKCHANNEL.has(word));
}

/**
 * Whether the speaker is alone with Remy: nobody else among the people on the call now (Remy and any other agent are
 * not people). Counted again for each turn, so the rule follows people as they join and leave.
 */
export function aloneOnCall(speaker: string, people: readonly string[]): boolean {
  return people.every((identity) => identity === speaker);
}

/** The first word of a display name ("Tony (Granite Ridge)" → "Tony"). */
export function firstName(name: string): string {
  return name.trim().split(/[\s(]+/)[0] ?? '';
}

export type AddressReason = 'name' | 'follow-up' | 'summons' | 'alone';
export interface TurnFacts {
  identity: string;
  text: string;
  /** ms since the epoch */
  startedAt: number;
  endedAt: number;
}
export interface Decision {
  addressed: boolean;
  reason: AddressReason | null;
  /** "Remy?" or "Remy, you on?": addressed, but the question is still to come. */
  summons: boolean;
}

interface Window {
  from: number;
  until: number;
  /** Remy's answer asked something, so a bare "yes" is an answer too. */
  question: boolean;
  kind: 'follow-up' | 'summons';
}

const NOT_ADDRESSED: Decision = { addressed: false, reason: null, summons: false };
/** A turn that began this little before the window opened (cutting in on the answer's last words) still counts. */
const EARLY_START_MS = 1000;

/** A question or a request in a turn: words that ask something of whoever hears them. */
const ASKS = /\?|\b(?:can|could|would|will)\s+(?:you|we)\b|\b(?:please|let's|lets)\b/i;

/** The addressing rule with its per-person follow-up windows. One per call. */
export class Addressing {
  #windows = new Map<string, Window>();
  /** When each person last started speaking (their voice, before any transcript). */
  #speechAt = new Map<string, number>();
  #followUpMs: number;
  #aloneAnswerMs: number;

  constructor(followUpMs: number = FOLLOW_UP_MS, aloneAnswerMs: number = ALONE_ANSWER_MS) {
    this.#followUpMs = followUpMs;
    this.#aloneAnswerMs = aloneAnswerMs;
  }

  /**
   * Decides one finished turn. Others' first names tell a line for Nora from a follow-up for Remy. `alone`: the
   * speaker is the only person on the call (counted again for every turn, as people join and leave).
   */
  decide(turn: TurnFacts, otherNames: readonly string[] = [], { alone = false }: { alone?: boolean } = {}): Decision {
    // Someone else asking the others something since Remy answered a person ("Wait, over Thanksgiving? Who booked
    // it?") hands them the floor: that person's next words answer the question, not follow up with Remy.
    if (/\?/.test(turn.text) && !addressesRemy(turn.text)) {
      for (const [identity, window] of this.#windows) if (identity !== turn.identity && turn.startedAt >= window.from) this.#windows.delete(identity);
    }
    if (isSummons(turn.text)) {
      this.#windows.set(turn.identity, { from: turn.endedAt, until: turn.endedAt + this.#followUpMs, question: true, kind: 'summons' });
      return { addressed: true, reason: 'name', summons: true };
    }
    if (addressesRemy(turn.text)) {
      this.#windows.delete(turn.identity);
      return { addressed: true, reason: 'name', summons: false };
    }
    if (alone) return this.#decideAlone(turn);
    const window = this.#windows.get(turn.identity);
    if (!window) return NOT_ADDRESSED;
    if (turn.startedAt > window.until) {
      this.#windows.delete(turn.identity);
      return NOT_ADDRESSED;
    }
    if (turn.startedAt < window.from - EARLY_START_MS) return NOT_ADDRESSED;
    if (addressesSomeoneElse(turn.text, otherNames)) {
      this.#windows.delete(turn.identity);
      return NOT_ADDRESSED;
    }
    if (!window.question && isBackchannel(turn.text)) return NOT_ADDRESSED; // the window stays open
    // Someone else started talking since Remy answered (their words may not be in yet): a remark that asks Remy
    // nothing ("Uh, we did, apparently.") answers them, not her.
    const otherSpoke = [...this.#speechAt].some(([identity, at]) => identity !== turn.identity && at >= window.from - EARLY_START_MS && at < turn.startedAt);
    if (otherSpoke && !window.question && !ASKS.test(turn.text)) {
      this.#windows.delete(turn.identity);
      return NOT_ADDRESSED;
    }
    this.#windows.delete(turn.identity);
    return { addressed: true, reason: window.kind, summons: false };
  }

  /**
   * One person on the call: every line is for Remy, except a plain "okay" or "thanks", which is for her only as the
   * answer to something she asked them (her answer ended with a question, or they summoned her), within 30 s.
   */
  #decideAlone(turn: TurnFacts): Decision {
    const window = this.#windows.get(turn.identity);
    if (isBackchannel(turn.text)) {
      if (!window?.question || turn.startedAt < window.from - EARLY_START_MS || turn.startedAt > window.from + this.#aloneAnswerMs) return NOT_ADDRESSED;
      this.#windows.delete(turn.identity);
      return { addressed: true, reason: window.kind, summons: false };
    }
    this.#windows.delete(turn.identity);
    return { addressed: true, reason: 'alone', summons: false };
  }

  /** Someone started speaking: what they say may take the floor from a follow-up (see decide). */
  heardSpeech(identity: string, at: number): void {
    this.#speechAt.set(identity, at);
  }

  /** Remy finished (or was cut off) answering this person: their next turn may follow up. */
  answered(identity: string, at: number, askedQuestion: boolean): void {
    this.#windows.set(identity, { from: at, until: at + this.#followUpMs, question: askedQuestion, kind: 'follow-up' });
  }

  forget(identity: string): void {
    this.#windows.delete(identity);
  }
}

/** True when Remy's line ends by asking something. */
export function endsWithQuestion(text: string): boolean {
  return /\?["')\]]*\s*$/.test(text.trim());
}
