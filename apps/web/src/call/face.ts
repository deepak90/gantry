/**
 * Remy's face on the call bar (and over the 3D view, through mirrorCall), kept in step with the real
 * call: she arrives when her worker joins and goes when it leaves, her aura breathes with her own voice as
 * this tab hears it, it listens while anyone talks, the orbs turn while she thinks, and the captions beside
 * the faces are the call's own: what her ears made of each person's words, and her words as she says them,
 * under the speaker's name in their color (yours too: the film is watched by people who aren't you). A
 * speaker's lines run together until someone else speaks (subtitles.ts). Whoever starts talking takes the
 * caption at once, their name with dots until their first words are in, so nobody's words sit under someone
 * else's name. Each finished line is handed to `onFinal` for screen readers: a person's once their transcript is
 * final, Remy's once her voice stops.
 *
 * It moves only on what changes on the call, so a walkthrough driving the same face keeps its say.
 */
import type { Call, LevelSource } from '../rails/call';
import { wordsOf } from '../rails/call';
import { REMY } from './protocol';
import type { CallSession, Caption } from './session';
import { captionWords, Subtitles } from './subtitles';
import { firstNameOf, humansOf } from './view';

/** A caption stays this long after the last word, unless someone speaks again. */
const CAPTION_HOLD_MS = 7000;
/** Someone took the floor and none of their words came: their name goes this long after they stop. */
const FLOOR_HOLD_MS = 4000;
/** Remy's line is final this long after her voice stops: its last caption may still be on its way. */
const REMY_FINAL_MS = 400;
/** Words at the end of a caption still being made out, shown fainter. */
const TENTATIVE = 2;

/** A finished line: who said it and their words. */
export interface FinalLine {
  name: string;
  text: string;
}

export interface FollowOptions {
  /** Each finished line, once (for a live region that screen readers read without stuttering on interim words). */
  onFinal?(line: FinalLine): void;
}

export function followRemy(call: Call, session: CallSession, { onFinal }: FollowOptions = {}): () => void {
  const priorYou = call.you;
  const priorVoice = call.voice;
  let remyHere = false;
  let remyDoing: string | null = null;
  let inCall = false;
  let captionTimer: ReturnType<typeof setTimeout> | null = null;
  let lastCaption: string | null = null;
  const subtitles = new Subtitles();
  /** Who was talking at the last look, so a start is seen. */
  let talking = new Set<string>();
  /** Remy's line being said, until it is handed on as final; the segments already handed on. */
  let remyLine: { segmentId: string; text: string } | null = null;
  let remyFinalTimer: ReturnType<typeof setTimeout> | null = null;
  const finished = new Set<string>();

  // Remy's voice is her track's level as this tab hears it; "you", on a call, is whoever is talking.
  const voice: LevelSource = { level: () => session.level(REMY) };
  const room: LevelSource = {
    level: () => {
      let loudest = 0;
      for (const person of humansOf(session.snapshot.people)) loudest = Math.max(loudest, session.level(person.identity));
      return loudest;
    },
  };

  const nameOf = (identity: string): { name: string; color: string | undefined } => {
    const person = session.snapshot.people.find((candidate) => candidate.identity === identity);
    return { name: firstNameOf(person?.name ?? 'Someone'), color: person?.color };
  };

  /** A line is finished: handed on once. */
  const finish = (segmentId: string, name: string, text: string) => {
    if (!text || finished.has(segmentId)) return;
    finished.add(segmentId);
    if (finished.size > 200) finished.delete(finished.values().next().value!);
    onFinal?.({ name, text });
  };

  const finishRemy = () => {
    if (remyFinalTimer) clearTimeout(remyFinalTimer);
    remyFinalTimer = null;
    if (remyLine) finish(remyLine.segmentId, call.name, remyLine.text);
    remyLine = null;
  };

  /** The caption stays while anyone is talking, then goes `ms` after the call went quiet. */
  const hold = (ms: number) => {
    if (captionTimer) clearTimeout(captionTimer);
    captionTimer = setTimeout(function clear() {
      captionTimer = null;
      if (call.state.speaking || call.state.youTalking || session.peopleTalking?.()) {
        captionTimer = setTimeout(clear, 1000);
        return;
      }
      clearCaption();
    }, ms);
  };

  /** The call's last caption goes, unless something else has taken its place. */
  const clearCaption = () => {
    if (captionTimer) clearTimeout(captionTimer);
    captionTimer = null;
    if (lastCaption !== null && call.state.words?.text === lastCaption) call.clearWords();
    lastCaption = null;
    subtitles.clear();
  };

  const sync = () => {
    const snapshot = session.snapshot;
    const nowInCall = session.inCall;
    if (nowInCall !== inCall) {
      inCall = nowInCall;
      call.you = inCall ? room : priorYou;
      // Off the call, its words go with it.
      if (!inCall) clearCaption();
    }
    const here = inCall && snapshot.remy !== null;
    if (here !== remyHere) {
      remyHere = here;
      call.voice = here ? voice : priorVoice;
      if (here) void call.join().catch(() => undefined);
      else {
        remyDoing = null;
        void call.leave().catch(() => undefined);
      }
    }
    // Someone starts talking while Remy's ears are on the call (they write everyone's words): the caption is
    // theirs at once, dots until their words are in.
    const now = new Set(humansOf(snapshot.people).filter((person) => person.speaking).map((person) => person.identity));
    if (here) {
      for (const identity of now) {
        if (talking.has(identity) || subtitles.current()?.identity === identity) continue;
        subtitles.floor(identity);
        const { name, color } = nameOf(identity);
        call.showHeard('', 0, name, color);
        lastCaption = '';
        hold(FLOOR_HOLD_MS);
      }
    }
    talking = now;
    if (!here) return;
    const doing = snapshot.remy;
    if (doing === remyDoing) return;
    const was = remyDoing;
    remyDoing = doing;
    if (doing === 'speaking') call.set({ speaking: true });
    else if (was === 'speaking') {
      call.set({ speaking: false });
      // Her line is finished once her voice stops (its captions say "not final" until the stream ends).
      if (remyFinalTimer) clearTimeout(remyFinalTimer);
      remyFinalTimer = setTimeout(finishRemy, REMY_FINAL_MS);
    }
    if (doing === 'thinking') {
      if (call.state.activity !== 'working') call.doing('thinking');
    } else if (was === 'thinking' && call.state.activity === 'thinking') call.doing('idle');
  };

  const show = (caption: Caption) => {
    const words = captionWords(caption.text);
    if (!words) return;
    // Finished lines, for screen readers: a person's when their transcript is final, Remy's when her next line
    // starts or her voice stops.
    if (caption.identity === REMY) {
      if (remyLine && remyLine.segmentId !== caption.segmentId) finishRemy();
      remyLine = { segmentId: caption.segmentId, text: words };
    } else if (caption.final) finish(caption.segmentId, nameOf(caption.identity).name, words);
    const line = subtitles.take(caption);
    if (!line?.text) return;
    if (line.identity === REMY) call.showSpeech(line.text, call.state.speaking);
    else {
      const { name, color } = nameOf(line.identity);
      call.showHeard(line.text, line.final ? 0 : Math.min(TENTATIVE, wordsOf(line.last).length), name, color);
    }
    lastCaption = line.text;
    // Once the call goes quiet, the last line clears.
    hold(CAPTION_HOLD_MS);
  };

  const stopSession = session.subscribe(sync);
  const stopCaptions = session.onCaption(show);
  sync();
  return () => {
    stopSession();
    stopCaptions();
    if (remyFinalTimer) clearTimeout(remyFinalTimer);
    clearCaption();
    call.you = priorYou;
    call.voice = priorVoice;
    if (remyHere) void call.leave().catch(() => undefined);
  };
}
