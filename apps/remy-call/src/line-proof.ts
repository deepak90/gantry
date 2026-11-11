/**
 * Remy says only what the assistant service wrote, when the worker has the secret it shares with the service
 * (`REMY_LINE_SECRET`, the hosted worker). The service signs each reply as it streams it, as far as it has written it,
 * and each reply it stores: HMAC-SHA256, keyed with that secret, over `project|turn|text`, in base64url
 * (apps/agent/src/realtime/line-signature.ts makes the same). The host's tab hands a line with its proof: the reply as
 * it was signed (`whole`), the part of it this line says (`part`), and the signature. The worker checks the signature,
 * and that the part is in the reply, spaces aside; then it says the part, written for her voice (for-voice.ts), and not
 * the words the tab sent with it. Her own lines (fillers, notices) need no proof.
 *
 * A part can be any stretch of a reply: what was written before a tool started, the rest once the reply is stored, the
 * sentences after the one she was cut off in. Whoever holds a proof can have her say that reply again, or a piece of it,
 * within the call's limits (line-limits.ts); never words of their own.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface LineProof {
  /** The assistant's turn that wrote the reply. */
  turn: string;
  /** The reply as it was signed. */
  whole: string;
  /** What this line says of it. */
  part: string;
  /** base64url HMAC-SHA256 over `project|turn|whole`. */
  sig: string;
}

export type ProofCheck = { ok: true; part: string } | { ok: false; reason: 'unsigned' | 'bad signature' | 'not in the reply' };

/** The signature the assistant service puts on a reply: base64url HMAC-SHA256 over `project|turn|text`. */
export function lineSignature(secret: string, project: string, turn: string, text: string): string {
  return createHmac('sha256', secret).update(`${project}|${turn}|${text}`, 'utf8').digest('base64url');
}

const squeezed = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** Whether a line may be said: signed by the service for this project, and a part of the reply it signed. */
export function checkProof(secret: string, project: string, proof: LineProof | undefined): ProofCheck {
  if (!proof) return { ok: false, reason: 'unsigned' };
  const expected = Buffer.from(lineSignature(secret, project, proof.turn, proof.whole), 'utf8');
  const given = Buffer.from(proof.sig, 'utf8');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: 'bad signature' };
  const part = squeezed(proof.part);
  if (!part || !squeezed(proof.whole).includes(part)) return { ok: false, reason: 'not in the reply' };
  return { ok: true, part };
}
