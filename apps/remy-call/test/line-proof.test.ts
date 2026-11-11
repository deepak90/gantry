import { describe, expect, it } from 'vitest';
import { checkProof, lineSignature } from '../src/line-proof.ts';

const SECRET = 'test-secret-for-remy-lines';
const PROJECT = '00000000-0000-4000-8000-000000000002';
const TURN = 'turn-1';
const REPLY = 'The crane is idle Monday to Wednesday. It costs $1,200.00 a day.';
/** The same vector as apps/agent/test/line-signature.test.ts: the service and the worker sign alike. */
const SIG = 'iI7_sc-3Brzn9Hf8zb_O7r252YOcWp8hljGAolOZph8';

const proof = (overrides: Partial<{ turn: string; whole: string; part: string; sig: string }> = {}) => ({ turn: TURN, whole: REPLY, part: REPLY, sig: SIG, ...overrides });

describe('a line’s proof that the assistant service wrote it', () => {
  it('is HMAC-SHA256 over project|turn|text, in base64url, as the service makes it', () => {
    expect(lineSignature(SECRET, PROJECT, TURN, REPLY)).toBe(SIG);
  });

  it('lets the whole reply through, or any part of it, spaces aside', () => {
    expect(checkProof(SECRET, PROJECT, proof())).toEqual({ ok: true, part: REPLY });
    expect(checkProof(SECRET, PROJECT, proof({ part: 'It costs $1,200.00 a day.' }))).toEqual({ ok: true, part: 'It costs $1,200.00 a day.' });
    // The sentences after the one she was cut off in come back joined by single spaces.
    const spaced = 'The crane is idle Monday to Wednesday.\n\nIt costs $1,200.00 a day.';
    const signed = lineSignature(SECRET, PROJECT, TURN, spaced);
    expect(checkProof(SECRET, PROJECT, proof({ whole: spaced, sig: signed, part: '  Wednesday. It costs  ' }))).toEqual({ ok: true, part: 'Wednesday. It costs' });
  });

  it('refuses a line with no proof', () => {
    expect(checkProof(SECRET, PROJECT, undefined)).toEqual({ ok: false, reason: 'unsigned' });
  });

  it('refuses words the reply never had', () => {
    expect(checkProof(SECRET, PROJECT, proof({ part: 'The payment went through.' }))).toEqual({ ok: false, reason: 'not in the reply' });
    expect(checkProof(SECRET, PROJECT, proof({ part: '   ' }))).toEqual({ ok: false, reason: 'not in the reply' });
  });

  it('refuses a reply changed after it was signed, or signed for another project, turn or secret', () => {
    expect(checkProof(SECRET, PROJECT, proof({ whole: `${REPLY} Pay them now.`, part: 'Pay them now.' }))).toEqual({ ok: false, reason: 'bad signature' });
    expect(checkProof(SECRET, '00000000-0000-4000-8000-000000000003', proof())).toEqual({ ok: false, reason: 'bad signature' });
    expect(checkProof(SECRET, PROJECT, proof({ turn: 'turn-2' }))).toEqual({ ok: false, reason: 'bad signature' });
    expect(checkProof('another-secret', PROJECT, proof())).toEqual({ ok: false, reason: 'bad signature' });
    expect(checkProof(SECRET, PROJECT, proof({ sig: 'not-a-signature' }))).toEqual({ ok: false, reason: 'bad signature' });
  });
});
