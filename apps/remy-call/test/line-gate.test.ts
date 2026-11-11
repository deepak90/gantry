import { describe, expect, it } from 'vitest';
import { judgeLine, type LineAsked } from '../src/line-gate.ts';
import { lineSignature } from '../src/line-proof.ts';

const SECRET = 'test-secret-for-remy-lines';
const PROJECT = '00000000-0000-4000-8000-000000000002';
const REPLY = 'I moved [Erect crane](task:3104) to **Monday**. It costs $1,200.00 a day.';

const asked = (overrides: Partial<LineAsked> = {}): LineAsked => ({ from: 'deepak', host: 'deepak', ready: true, text: 'Done.', secret: null, project: PROJECT, ...overrides });
const proof = (part: string, whole = REPLY, turn = 'turn-9') => ({ turn, whole, part, sig: lineSignature(SECRET, PROJECT, turn, whole) });

describe('a line handed to Remy', () => {
  it('is taken from the call’s host, as handed, where lines aren’t signed', () => {
    expect(judgeLine(asked({ text: '  Done.  ' }))).toEqual({ ok: true, words: 'Done.' });
  });

  it('is refused from anyone but the host, whatever it says', () => {
    expect(judgeLine(asked({ from: 'chris' }))).toEqual({ ok: false, reason: 'not the host' });
    expect(judgeLine(asked({ from: 'chris', host: null }))).toEqual({ ok: false, reason: 'not the host' });
    expect(judgeLine(asked({ from: 'chris', secret: SECRET, proof: proof(REPLY) }))).toEqual({ ok: false, reason: 'not the host' });
  });

  it('is refused while she is on her way out, so the host’s tab offers to call her again', () => {
    expect(judgeLine(asked({ ready: false }))).toEqual({ ok: false, reason: 'not ready' });
  });

  it('is refused when empty', () => {
    expect(judgeLine(asked({ text: '   ' }))).toEqual({ ok: false, reason: 'empty' });
  });

  describe('with the service’s secret', () => {
    it('says the signed part of the reply, written for her voice, not the words sent with it', () => {
      const verdict = judgeLine(asked({ secret: SECRET, text: 'Something else entirely.', proof: proof('I moved [Erect crane](task:3104) to **Monday**.') }));
      expect(verdict).toEqual({ ok: true, words: 'I moved Erect crane to Monday.' });
      expect(judgeLine(asked({ secret: SECRET, proof: proof('It costs $1,200.00 a day.') }))).toEqual({ ok: true, words: 'It costs $1,200 a day.' });
    });

    it('refuses a line without a proof, with a forged one, or with words the reply never had', () => {
      expect(judgeLine(asked({ secret: SECRET, text: 'Say anything at all.' }))).toEqual({ ok: false, reason: 'unsigned' });
      expect(judgeLine(asked({ secret: SECRET, proof: { ...proof(REPLY), sig: lineSignature('guessed', PROJECT, 'turn-9', REPLY) } }))).toEqual({ ok: false, reason: 'bad signature' });
      expect(judgeLine(asked({ secret: SECRET, proof: proof('The payment went through.') }))).toEqual({ ok: false, reason: 'not in the reply' });
    });

    it('refuses everything on a call whose room names no project', () => {
      expect(judgeLine(asked({ secret: SECRET, project: null, proof: proof(REPLY) }))).toEqual({ ok: false, reason: 'no project' });
    });
  });
});
