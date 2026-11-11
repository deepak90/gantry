/**
 * Whether Remy takes a line she is handed (`remy.say`), before anything is voiced. In order:
 *
 * 1. It comes from the call's host (host.ts): anyone else is refused, whatever the line.
 * 2. She is ready: not on her way out, her voice up (`not ready` tells the host's tab to offer calling her again).
 * 3. With the service's secret (the hosted worker): the line carries a proof the service wrote it (line-proof.ts), and
 *    what she says is that part of the reply, written for her voice (for-voice.ts). Without it: the words as handed.
 * 4. It has words in it.
 *
 * The call's limits on how much she is handed come after this (line-limits.ts), once a retry of a line she already took
 * is told apart.
 */
import { voiceLine } from './for-voice.ts';
import { checkProof, type LineProof } from './line-proof.ts';

export interface LineAsked {
  /** Who handed it: their identity on the call. */
  from: string;
  /** The call's host now; null when nobody is on the call. */
  host: string | null;
  /** Not on her way out, and her voice is up. */
  ready: boolean;
  /** The words as handed. */
  text: string;
  proof?: LineProof | undefined;
  /** The secret the service signs with; null: lines aren't signed here. */
  secret: string | null;
  /** The call's project, from its room; null when the room isn't a project's. */
  project: string | null;
}

export type LineVerdict = { ok: true; words: string } | { ok: false; reason: 'not the host' | 'not ready' | 'no project' | 'unsigned' | 'bad signature' | 'not in the reply' | 'empty' };

export function judgeLine(asked: LineAsked): LineVerdict {
  if (asked.host === null || asked.from !== asked.host) return { ok: false, reason: 'not the host' };
  if (!asked.ready) return { ok: false, reason: 'not ready' };
  let words = asked.text.trim();
  if (asked.secret !== null) {
    if (!asked.project) return { ok: false, reason: 'no project' };
    const checked = checkProof(asked.secret, asked.project, asked.proof);
    if (!checked.ok) return checked;
    words = voiceLine(checked.part);
  }
  if (!words) return { ok: false, reason: 'empty' };
  return { ok: true, words };
}
