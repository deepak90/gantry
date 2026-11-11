/**
 * The service signs Remy's replies for her voice on a call: each tool event carries the signature of the reply as the
 * tabs have it so far, and turn_end that of the reply as stored. The call worker checks the same signature
 * (apps/remy-call/test/line-proof.test.ts has the same vector).
 */
import { describe, expect, it } from 'vitest';
import { AgentStreamEvent } from '@collab/shared';
import type { BrainEvent, TurnResult } from '../src/agent/brain';
import { lineSignature, lineSigner, MAX_SIGNED_CHARS } from '../src/realtime/line-signature';
import { StreamBatcher, type Timers } from '../src/realtime/stream';

const SECRET = 'test-secret-for-remy-lines';
const PROJECT = '00000000-0000-4000-8000-000000000002';
const TURN = 'turn-1';
const REPLY = 'The crane is idle Monday to Wednesday. It costs $1,200.00 a day.';
const SIG = 'iI7_sc-3Brzn9Hf8zb_O7r252YOcWp8hljGAolOZph8';

/** Timers that never fire on their own: every delta goes out at once (the first of a burst) or on a flush. */
const still: Timers = { now: () => 0, set: () => 1, clear: () => undefined };

const result = (say: string, overrides: Partial<TurnResult> = {}): TurnResult => ({
  turnId: TURN,
  kind: 'utterance',
  threadId: null,
  channel: 'voice',
  model: 'm',
  speakerId: null,
  say,
  cards: [],
  toolCalls: [],
  quiet: false,
  stopReason: 'end_turn',
  steps: 1,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 },
  ms: 0,
  firstTextMs: null,
  firstCardMs: null,
  warnings: [],
  ...overrides,
});

function stream(sign = lineSigner(SECRET, PROJECT)) {
  const sent: AgentStreamEvent[] = [];
  const batcher = new StreamBatcher((event) => sent.push(event), { timers: still, sign });
  const handle = (event: BrainEvent) => batcher.handle(event);
  handle({ type: 'turn_start', turnId: TURN, kind: 'utterance', model: 'm', speakerId: null, threadId: null });
  return { sent, handle };
}

describe('a reply’s signature', () => {
  it('is HMAC-SHA256 over project|turn|text, in base64url, as the call worker checks it', () => {
    expect(lineSignature(SECRET, PROJECT, TURN, REPLY)).toBe(SIG);
    expect(lineSigner(SECRET, PROJECT)!(TURN, REPLY)).toBe(SIG);
  });

  it('is made only with a secret, for words, and for a reply short enough to hand her', () => {
    expect(lineSigner(null, PROJECT)).toBeNull();
    expect(lineSigner('  ', PROJECT)).toBeNull();
    const sign = lineSigner(SECRET, PROJECT)!;
    expect(sign(TURN, '   ')).toBeNull();
    expect(sign(TURN, 'w'.repeat(MAX_SIGNED_CHARS))).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sign(TURN, 'w'.repeat(MAX_SIGNED_CHARS + 1))).toBeNull();
  });
});

describe('the stream, signed', () => {
  it('signs what was written before each tool, as the tabs have it', () => {
    const { sent, handle } = stream();
    handle({ type: 'text_delta', turnId: TURN, text: 'Sure, ' });
    handle({ type: 'text_delta', turnId: TURN, text: 'checking the crane.' });
    handle({ type: 'tool', turnId: TURN, toolId: 'toolu_1', name: 'get_booking', state: 'start' });
    handle({ type: 'tool', turnId: TURN, toolId: 'toolu_1', name: 'get_booking', state: 'ok' });
    handle({ type: 'text_delta', turnId: TURN, text: ' It is idle.' });
    handle({ type: 'tool', turnId: TURN, toolId: 'toolu_2', name: 'schedule_odds', state: 'start' });
    const streamed = sent
      .filter((event) => event.type === 'text_delta')
      .map((event) => (event as { text: string }).text)
      .join('');
    expect(streamed).toBe('Sure, checking the crane. It is idle.');
    const tools = sent.filter((event) => event.type === 'tool') as Extract<AgentStreamEvent, { type: 'tool' }>[];
    expect(tools.map((event) => event.sig)).toEqual([
      lineSignature(SECRET, PROJECT, TURN, 'Sure, checking the crane.'),
      lineSignature(SECRET, PROJECT, TURN, 'Sure, checking the crane.'),
      lineSignature(SECRET, PROJECT, TURN, 'Sure, checking the crane. It is idle.'),
    ]);
    // Every signed event still fits the contract the tabs read.
    for (const event of sent) expect(AgentStreamEvent.safeParse(event).success).toBe(true);
  });

  it('leaves a tool unsigned while nothing has been written', () => {
    const { sent, handle } = stream();
    handle({ type: 'tool', turnId: TURN, toolId: 'toolu_1', name: 'get_booking', state: 'start' });
    expect(sent.at(-1)).not.toHaveProperty('sig');
  });

  it('signs the reply as stored when the turn ends, whatever was streamed', () => {
    const { sent, handle } = stream();
    handle({ type: 'text_delta', turnId: TURN, text: 'Thinking out loud first. ' });
    handle({ type: 'turn_end', turnId: TURN, result: result(REPLY), messageId: '00000000-0000-4000-8000-0000000000aa' });
    expect(sent.at(-1)).toEqual({ type: 'turn_end', turn_id: TURN, message_id: '00000000-0000-4000-8000-0000000000aa', sig: SIG });
  });

  it('signs nothing for a turn that stayed quiet or stored no reply', () => {
    for (const [say, quiet, messageId] of [
      ['', true, null],
      [REPLY, false, null],
      ['', false, '00000000-0000-4000-8000-0000000000aa'],
    ] as const) {
      const { sent, handle } = stream();
      handle({ type: 'turn_end', turnId: TURN, result: result(say, { quiet }), messageId });
      expect(sent.at(-1)).not.toHaveProperty('sig');
    }
  });

  it('signs nothing without a secret, so the owner’s machine streams as it always did', () => {
    const { sent, handle } = stream(null);
    handle({ type: 'text_delta', turnId: TURN, text: 'Checking the crane.' });
    handle({ type: 'tool', turnId: TURN, toolId: 'toolu_1', name: 'get_booking', state: 'start' });
    handle({ type: 'turn_end', turnId: TURN, result: result(REPLY), messageId: '00000000-0000-4000-8000-0000000000aa' });
    expect(sent.some((event) => 'sig' in event)).toBe(false);
  });
});
