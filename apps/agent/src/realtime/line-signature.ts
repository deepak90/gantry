/**
 * Remy's voice on a call says only what this service wrote, where her call worker has the secret it shares with the
 * service (REMY_LINE_SECRET; the call worker's src/line-proof.ts checks). The service signs each reply as it streams it,
 * on every `tool` event (the reply as far as it is written: what the host's tab hands her while a tool runs), and as it
 * stores it, on `turn_end` (stream.ts). The signature is base64url HMAC-SHA256, keyed with the secret, over
 * `project|turn|text`. The host's tab hands her a part of a signed reply with its signature, never words of its own.
 */
import { createHmac } from 'node:crypto';

/** The longest reply signed: a stored reply's length, and what fits in a call's request to her (15 KiB). */
export const MAX_SIGNED_CHARS = 4000;

export function lineSignature(secret: string, projectId: string, turnId: string, text: string): string {
  return createHmac('sha256', secret).update(`${projectId}|${turnId}|${text}`, 'utf8').digest('base64url');
}

/** Signs a turn's reply text for one project; null for text with nothing to say, or too long to hand her. */
export type LineSigner = (turnId: string, text: string) => string | null;

/** The project's signer, or null where there is no secret (local runs): nothing is signed. */
export function lineSigner(secret: string | null | undefined, projectId: string): LineSigner | null {
  const key = secret?.trim();
  if (!key) return null;
  return (turnId, text) => (text.trim() && text.length <= MAX_SIGNED_CHARS ? lineSignature(key, projectId, turnId, text) : null);
}
