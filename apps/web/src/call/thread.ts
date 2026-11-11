/**
 * The call and the assistant's thread. What you say to Remy on the call goes to the thread from your own
 * tab, as your message said aloud, so it is yours, in your words as heard. Claude answers in the thread as
 * always, and the host's tab hands each spoken answer to Remy's voice, word for word.
 *
 * The call's conversation is one thread everyone on it can read: the project's General thread unless told
 * otherwise. A tab on the call keeps that thread open in its panel, so the people on the call see the same
 * conversation and the host's tab sees each answer as it lands.
 *
 * An answer is said as it is written, not only once it has landed: Claude says a few words first ("Sure, one
 * second.") and then works (drafts, runs the odds), so whatever it has said before it starts working is handed to
 * Remy's voice at once, and the rest when the answer lands. The words are the same; only when they are said moves.
 *
 * With `resume`, an answer someone cut in on (not to ask Remy something new, but talking among themselves) is
 * finished once the floor is free: Remy picks up at the sentence after the one she was cut off in, as a person on a
 * call would. Her words are still the answer's own; nothing is asked again.
 *
 * When a slow answer has her worker say a filler first ("Let me look."), an answer's first words that only hold the
 * floor too ("Checking the crane.", "Sure, one second.") are left unsaid: she'd say the same thing twice. Claude can't
 * know a filler was said (it plays while Claude is already writing), so the host's tab, which hears of it, decides.
 *
 * Each line goes with the proof of the reply it comes from (the assistant service's signature, where it signs): the
 * answer as streamed up to the tool, or the stored message. The hosted worker says only what such a proof covers.
 */
import type { AgentMessageRow } from '@collab/shared';
import { REMY, postsHeard, type LineProof, type RemyMessage } from './protocol';

/** The answer being written now, as the assistant session streams it: its words so far and the tools it started. */
export interface LiveAnswer {
  turnId: string;
  threadId: string | null;
  text: string;
  tools: readonly { id: string; name?: string }[];
  /** The answer is written; its stored message is on its way. */
  ending: boolean;
  /** The answer as streamed up to its last tool, signed by the service; null or absent where it signs nothing. */
  signed?: { text: string; sig: string } | null;
}


/**
 * A note of what it is about to do, before any work ("Checking the crane.", "Drafting the fixtures for one floor."):
 * narration a filmed call does without. Only such a note is held back. An answer written before a tool is said
 * whatever the tool is: an offer ("…want me to add them?") written whole before a quick `calculate` is no "Checking…".
 * A short acknowledgement ("Sure, one second.") is no note either: it is said. Nor is what comes before the odds: it
 * tells the people on the call what the board filling their screen is.
 */
export const PROGRESS_NOTE =
  /^(?:(?:ok(?:ay)?|sure|right|alright|got it|one sec(?:ond)?|just a sec(?:ond)?)[,.!]?\s+)?(?:i'?m\s+|let me\s+|i'?ll\s+)?(?:drafting|draft|checking|check|looking|look|pulling|pull|putting|working|finding|find|pricing|price|adding|add|getting|get|running|run|reading|read|counting|count|building|build|preparing|prepare|setting|set|see)\b[^.?!]{0,90}[.…!]?$/i;

const ACKNOWLEDGES = String.raw`(?:ok(?:ay)?|sure|right|alright|all right|got it|yes|yeah|of course|no problem)`;
const ASKS_TO_WAIT = String.raw`(?:(?:one|a|just a|give me a)\s+(?:sec(?:ond)?|moment|minute)|hang on|hold on|bear with me)`;
/** Words that only hold the floor: "Sure, one second.", "One moment.", "Okay." */
export const HOLDING_THE_FLOOR = new RegExp(String.raw`^(?:${ACKNOWLEDGES}[,.!]?\s+)*(?:${ACKNOWLEDGES}|${ASKS_TO_WAIT})[.!…]?$`, 'i');

/** An answer's first words that a filler already said, in effect: a note of what she's about to do, or a "one second". */
export const saysWhatAFillerSaid = (text: string): boolean => PROGRESS_NOTE.test(text.trim()) || HOLDING_THE_FLOOR.test(text.trim());

/** The slice of the assistant session the call uses (AssistantSession has it). */
export interface ThreadPort {
  getSnapshot(): { threadId: string | null; draft: boolean; sending: boolean; messages: readonly AgentMessageRow[]; live?: LiveAnswer | null };
  subscribe(listener: () => void): () => void;
  openThread(threadId: string | null): void;
  send(text: string, action: null, channel: 'voice'): Promise<boolean>;
  /** The service's signature on a turn's stored reply; null when it signed none (AssistantSession has it). */
  replySignature?(turnId: string): string | null;
}

/** The slice of the call the link uses (CallSession has it). */
export interface CallPort {
  readonly me: string;
  /** Connected to the call (or getting back to it). */
  readonly inCall: boolean;
  readonly isHost: boolean;
  subscribe(listener: () => void): () => void;
  onMessage(listener: (message: RemyMessage, from: string | null) => void): () => void;
  say(text: string, options?: { to?: string | null; proof?: LineProof | null }): Promise<{ id: string; interrupted: boolean }>;
  /** The call's live captions (CallSession has them): Remy's words as she says them, and everyone else's. */
  onCaption?(listener: (caption: { identity: string; text: string; final: boolean }) => void): () => void;
  /** Whether anyone but Remy is making a sound now (their voice as this tab hears it). */
  peopleTalking?(): boolean;
}

/** Remy's spoken answers in the thread written since `since` (ms since the epoch), not yet said. */
export function repliesToSay(messages: readonly AgentMessageRow[], { since, done }: { since: number; done: ReadonlySet<string> }): AgentMessageRow[] {
  return messages.filter((row) => row.role === 'assistant' && row.channel === 'voice' && !done.has(row.id) && row.text.trim().length > 0 && Date.parse(row.created_at) >= since);
}

/** A line said to Remy, as heard: who said it and their words. */
export interface Asked {
  identity: string;
  text: string;
}

/**
 * Whose words an answer answers: the person's message said aloud just before it in the thread, matched to
 * the line Remy heard (the message is that line, posted as heard). Null when that can't be told.
 */
export function answerTo(messages: readonly AgentMessageRow[], reply: AgentMessageRow, asked: readonly Asked[]): string | null {
  const at = Date.parse(reply.created_at);
  let question: AgentMessageRow | null = null;
  for (const row of messages) {
    if (row.role !== 'person' || row.channel !== 'voice' || Date.parse(row.created_at) > at) continue;
    if (!question || Date.parse(row.created_at) >= Date.parse(question.created_at)) question = row;
  }
  if (!question) return null;
  const words = question.text.trim();
  return [...asked].reverse().find((line) => line.text.trim() === words)?.identity ?? null;
}

/**
 * The words of `full` after `spoken`, its first part already said (whitespace aside); null when `spoken` isn't its
 * start. What was said can stop short of its sentence's closing mark (the stream holds a trailing "." back until it
 * knows it ends no amount): that mark belongs to what was said, never to the start of the rest.
 */
export function remainderAfter(full: string, spoken: string): string | null {
  const said = spoken.replace(/\s+/g, '');
  let matched = 0;
  let at = 0;
  for (; at < full.length && matched < said.length; at += 1) {
    if (/\s/.test(full[at]!)) continue;
    if (full[at] !== said[matched]) return null;
    matched += 1;
  }
  return matched === said.length ? full.slice(at).replace(/^[\s.,;:!?…"'”’)\]]+/, '').trim() : null;
}

/** Sentences, each with its closing mark: "It's idle. Seven days." is "It's idle." and "Seven days.". */
export function sentencesOf(text: string): string[] {
  return (text.match(/[^.!?]+(?:[.!?]+["'”’)\]]*|$)/g) ?? []).map((sentence) => sentence.trim()).filter(Boolean);
}

const wordsIn = (text: string) => text.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word));

/**
 * What is left to say of a line cut off after `spoken` (the words she got out, as her captions wrote them): the
 * sentences after the one she was cut off in. Empty when she was cut off in the last one, or got nothing out.
 */
export function restAfterCut(text: string, spoken: string): string {
  const got = wordsIn(spoken).length;
  if (got === 0) return '';
  let count = 0;
  const sentences = sentencesOf(text);
  for (let index = 0; index < sentences.length; index += 1) {
    count += wordsIn(sentences[index]!).length;
    if (count >= got) return sentences.slice(index + 1).join(' ');
  }
  return '';
}

export interface ThreadLinkOptions {
  /** The call's thread: null is the project's General thread. */
  threadId?: string | null;
  /** How long a send waits for the one before it, between tries. */
  retryMs?: number;
  /** Finish an answer someone cut in on, once the floor is free (see the module comment). Off unless asked. */
  resume?: boolean;
  /** How long nobody may speak before a cut-off answer is picked up again. */
  resumeQuietMs?: number;
  /**
   * Leave unsaid what an answer writes before a quick look-up ("Checking the crane."); what it writes before anything
   * else (a draft, a card, the odds) is said at once, as always. The thread still shows it all.
   */
  quietLookups?: boolean;
  log?(event: string, data?: Record<string, unknown>): void;
}

export interface ThreadLink {
  /** Whether the host's tab says Remy's answers by itself (on until the walkthrough takes the lines over). */
  speakReplies(on: boolean): void;
  stop(): void;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** How long a stored answer that came in before its turn's end waits for the end (and its signature) before it is said. */
const END_WAIT_MS = 1500;

/** Whose words the answer being written answers: the latest question said aloud in the thread, matched to a heard line. */
function answerToNow(messages: readonly AgentMessageRow[], asked: readonly Asked[]): string | null {
  const question = [...messages].reverse().find((row) => row.role === 'person' && row.channel === 'voice');
  if (!question) return null;
  const words = question.text.trim();
  return [...asked].reverse().find((line) => line.text.trim() === words)?.identity ?? null;
}

export function linkThread(call: CallPort, thread: ThreadPort, { threadId = null, retryMs = 250, resume = false, resumeQuietMs = 1200, quietLookups = false, log = () => undefined }: ThreadLinkOptions = {}): ThreadLink {
  let stopped = false;
  let speaking = true;
  /** The call's thread was opened for this time on the call. */
  let opened = false;
  /** Since when this tab has hosted the call: answers from before then aren't its to say. */
  let hostSince: number | null = null;
  const said = new Set<string>();
  /** Lines said to Remy lately, for telling whose words an answer answers. */
  let asked: Asked[] = [];
  let posts: Promise<void> = Promise.resolve();
  let lines: Promise<void> = Promise.resolve();
  /** Answers being written: how much of their words were taken already (said, or left unsaid before a look-up). */
  const streamed = new Map<string, { handed: number; tools: number; seen: Set<string>; taken: string }>();
  /** Remy's words as she says the current line (her captions), and when anyone else last made a sound. */
  let remyWords = '';
  let othersAt = 0;
  /** When someone last said something to Remy: a cut-off answer isn't picked up over a new question. */
  let askedAt = 0;
  /** When her worker last started a filler: the answer's first words that say the same are left unsaid. */
  let fillerAt = 0;
  /** Stored answers that came in before their turn's end, and since when: their signature comes with the end. */
  const early = new Map<string, number>();
  let recheck: ReturnType<typeof setTimeout> | null = null;
  const keyOf = (id: string | null | undefined) => id ?? '';

  /** The call's thread, open in this tab's panel. */
  const keepOpen = () => {
    const snapshot = thread.getSnapshot();
    if (snapshot.draft || snapshot.threadId !== threadId) thread.openThread(threadId);
  };

  const post = (text: string) => {
    posts = posts.then(async () => {
      for (let attempt = 0; attempt < 40 && !stopped; attempt += 1) {
        keepOpen();
        if (await thread.send(text, null, 'voice')) {
          log('posted', { text });
          return;
        }
        // Another message from this tab is still on its way; anything else is a failure the panel shows.
        if (!thread.getSnapshot().sending) break;
        await sleep(retryMs);
      }
      log('post_failed', { text });
    });
  };

  /**
   * Remy says `text` once the lines before it are said; a line cut off may be finished later (`resume`). `proof`: the
   * signed reply it is part of.
   */
  const queueLine = (text: string, to: string | null, what: Record<string, unknown>, proof: LineProof | null) => {
    lines = lines.then(async () => {
      if (stopped || !call.isHost) return;
      try {
        remyWords = '';
        const outcome = await call.say(text, { to, proof });
        log('reply_said', { ...what, interrupted: outcome.interrupted });
        if (outcome.interrupted && resume) await pickUp(text, proof);
      } catch (error) {
        log('reply_not_said', { ...what, error: error instanceof Error ? error.message : String(error) });
      }
    });
  };

  /** The proof that goes with a stored reply's words: its signature, when this tab has one. */
  const proofOf = (row: AgentMessageRow): LineProof | null => {
    const sig = row.turn_id ? (thread.replySignature?.(row.turn_id) ?? null) : null;
    return sig && row.turn_id ? { turn: row.turn_id, whole: row.text, sig } : null;
  };

  /**
   * A line was cut off: once nobody has made a sound for a moment (and nobody asked her anything), the rest of it. Not
   * when the line asked them something: whoever cut in was answering it.
   */
  const pickUp = async (text: string, proof: LineProof | null) => {
    const cutAt = Date.now();
    if (/\?/.test(text)) {
      log('resume_none', { reason: 'it asked them something' });
      return;
    }
    // Her captions end where her voice stopped; they may come in a moment after the line's end.
    await sleep(350);
    const rest = restAfterCut(text, remyWords);
    if (!rest) {
      log('resume_none', { spoken: remyWords });
      return;
    }
    log('resume_waiting', { spoken: remyWords, rest });
    // Whoever cut in is talking now: their voice, then their words as heard, must both have stopped a while.
    let soundAt = Date.now();
    for (;;) {
      await sleep(100);
      if (stopped || !call.isHost) return;
      if (call.peopleTalking?.()) soundAt = Date.now();
      if (askedAt > cutAt) {
        log('resume_dropped', { reason: 'asked', rest });
        return;
      }
      if (Date.now() - cutAt > 20_000) {
        log('resume_dropped', { reason: 'no pause', rest });
        return;
      }
      const quietFor = Date.now() - Math.max(soundAt, othersAt);
      if (quietFor >= resumeQuietMs && Date.now() - cutAt >= 1500) break;
    }
    try {
      remyWords = '';
      const outcome = await call.say(rest, { to: null, proof });
      log('resume_said', { rest, interrupted: outcome.interrupted });
    } catch (error) {
      log('resume_not_said', { rest, error: error instanceof Error ? error.message : String(error) });
    }
  };

  const sayReplies = () => {
    if (stopped || !speaking || hostSince === null) return;
    const snapshot = thread.getSnapshot();
    if (snapshot.draft || snapshot.threadId !== threadId) return;
    // What the answer being written has said before starting a tool: said now, while the tool works.
    const live = snapshot.live;
    if (live && keyOf(live.threadId) === keyOf(threadId) && !live.ending) {
      const turn = streamed.get(live.turnId) ?? { handed: 0, tools: 0, seen: new Set<string>(), taken: '' };
      streamed.set(live.turnId, turn);
      if (live.tools.length > turn.tools) {
        const started = live.tools.filter((tool) => !turn.seen.has(tool.id));
        for (const tool of started) turn.seen.add(tool.id);
        turn.tools = live.tools.length;
        const fresh = live.text.slice(turn.handed).trim();
        if (fresh) {
          const opening = turn.taken === '';
          turn.handed = live.text.length;
          turn.taken = `${turn.taken} ${fresh}`.trim();
          // What comes before the odds is said: it tells the people on the call what the board filling their screen is.
          const odds = started.some((tool) => tool.name === 'schedule_odds');
          // The answer as the service signed it at this tool: the words written so far, these among them.
          const proof = live.signed ? { turn: live.turnId, whole: live.signed.text, sig: live.signed.sig } : null;
          if (quietLookups && PROGRESS_NOTE.test(fresh) && !odds) log('reply_unsaid', { turn: live.turnId, text: fresh, before: started.map((tool) => tool.name ?? '?') });
          else if (opening && fillerAt > askedAt && saysWhatAFillerSaid(fresh) && !odds) log('reply_unsaid', { turn: live.turnId, text: fresh, after: 'filler' });
          else queueLine(fresh, answerToNow(snapshot.messages, asked), { turn: live.turnId, part: 'before-tools' }, proof);
        }
      }
    }
    for (const row of repliesToSay(snapshot.messages, { since: hostSince, done: said })) {
      // The stored answer came in before its turn's end, which follows at once with its signature: said then (or after
      // END_WAIT_MS all the same, should the end never come).
      if (live && row.turn_id === live.turnId && !live.ending) {
        const since = early.get(row.id) ?? Date.now();
        early.set(row.id, since);
        if (Date.now() - since < END_WAIT_MS) {
          recheck ??= setTimeout(() => {
            recheck = null;
            sayReplies();
          }, END_WAIT_MS);
          continue;
        }
      }
      early.delete(row.id);
      said.add(row.id);
      const to = answerTo(snapshot.messages, row, asked);
      const turn = row.turn_id ? streamed.get(row.turn_id) : undefined;
      if (turn?.taken) {
        streamed.delete(row.turn_id!);
        // Its first words were taken while it worked (said, or left unsaid before a look-up): the rest now. If the
        // stored words don't start with them, all of it.
        const rest = remainderAfter(row.text, turn.taken);
        if (rest === '') continue;
        queueLine(rest ?? row.text, to, { id: row.id, part: rest === null ? 'all' : 'rest' }, proofOf(row));
        continue;
      }
      queueLine(row.text, to, { id: row.id }, proofOf(row));
    }
  };

  const onCall = () => {
    if (call.inCall && !opened) {
      opened = true;
      keepOpen();
    } else if (!call.inCall) opened = false;
    if (call.isHost && hostSince === null) {
      hostSince = Date.now();
      keepOpen();
      log('hosting');
    } else if (!call.isHost && hostSince !== null) {
      hostSince = null;
      log('not_hosting');
    }
  };

  const stopCall = call.subscribe(onCall);
  const stopCaptions =
    call.onCaption?.((caption) => {
      if (caption.identity === REMY) remyWords = caption.text;
      else othersAt = Date.now();
    }) ?? (() => undefined);
  const stopMessages = call.onMessage((message, from) => {
    if (message.kind === 'filler' && from === REMY) fillerAt = Date.now();
    if (message.kind !== 'heard') return;
    if (from === REMY) othersAt = Date.now();
    if (from === REMY && message.addressed) {
      askedAt = Date.now();
      asked = [...asked, { identity: message.identity, text: message.text }].slice(-20);
    }
    if (postsHeard(message, { from, me: call.me })) post(message.text);
    // Something was said to Remy: her answer lands in the call's thread, which the host keeps open to hear it.
    else if (call.isHost && message.addressed && from === REMY) keepOpen();
  });
  const stopThread = thread.subscribe(sayReplies);
  onCall();

  return {
    speakReplies(on) {
      if (on && !speaking) {
        // From now on: what was answered meanwhile was the walkthrough's to say.
        for (const row of repliesToSay(thread.getSnapshot().messages, { since: hostSince ?? 0, done: said })) said.add(row.id);
      }
      speaking = on;
    },
    stop() {
      stopped = true;
      if (recheck) clearTimeout(recheck);
      stopCall();
      stopCaptions();
      stopMessages();
      stopThread();
    },
  };
}
