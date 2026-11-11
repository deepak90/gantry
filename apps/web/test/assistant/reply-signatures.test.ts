/**
 * The service's signatures on Remy's replies, as a tab keeps them for her voice on a call: the reply as streamed up to
 * each tool, and each stored reply by its turn, even one this tab didn't see stream.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AgentStreamEvent } from '@collab/shared';
import { AssistantSession, type AssistantTransport } from '../../src/assistant/session';

const PRIYA = '00000000-0000-4000-8000-000000000011';
const SIG_1 = 'a'.repeat(43);
const SIG_2 = 'b'.repeat(43);
const SIG_STORED = 'c'.repeat(43);

function fake() {
  let handlers: Parameters<AssistantTransport['subscribe']>[0] | null = null;
  const transport: AssistantTransport = {
    loadThread: vi.fn(async () => []),
    post: vi.fn(async () => {
      throw new Error('not posting here');
    }),
    subscribe: (next) => {
      handlers = next;
      return () => {
        handlers = null;
      };
    },
  };
  return { transport, emit: (event: AgentStreamEvent) => handlers?.onStream(event) };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function opened() {
  const { transport, emit } = fake();
  const session = new AssistantSession(transport);
  session.start();
  session.openThread(null);
  await flush();
  return { session, emit };
}

describe('the signatures a tab keeps', () => {
  it('pairs each tool’s signature with the reply as this tab had it then', async () => {
    const { session, emit } = await opened();
    emit({ type: 'turn_start', turn_id: 't1', kind: 'utterance', speaker_id: PRIYA });
    emit({ type: 'text_delta', turn_id: 't1', seq: 0, text: 'Sure, ' });
    emit({ type: 'text_delta', turn_id: 't1', seq: 1, text: 'one second.' });
    expect(session.getSnapshot().live?.signed).toBeNull();
    emit({ type: 'tool', turn_id: 't1', tool_id: 'a', name: 'schedule_odds', state: 'start', sig: SIG_1 });
    expect(session.getSnapshot().live?.signed).toEqual({ text: 'Sure, one second.', sig: SIG_1 });
    emit({ type: 'text_delta', turn_id: 't1', seq: 2, text: ' Here it is.' });
    // A tool event without one keeps the last.
    emit({ type: 'tool', turn_id: 't1', tool_id: 'a', name: 'schedule_odds', state: 'ok' });
    expect(session.getSnapshot().live?.signed).toEqual({ text: 'Sure, one second.', sig: SIG_1 });
    emit({ type: 'tool', turn_id: 't1', tool_id: 'b', name: 'show_odds', state: 'start', sig: SIG_2 });
    expect(session.getSnapshot().live?.signed).toEqual({ text: 'Sure, one second. Here it is.', sig: SIG_2 });
  });

  it('keeps each stored reply’s signature by its turn, the turns it didn’t see stream too', async () => {
    const { session, emit } = await opened();
    emit({ type: 'turn_start', turn_id: 't2', kind: 'utterance', speaker_id: PRIYA });
    emit({ type: 'turn_end', turn_id: 't2', message_id: '00000000-0000-4000-8000-0000000000a1', sig: SIG_STORED });
    expect(session.replySignature('t2')).toBe(SIG_STORED);
    emit({ type: 'turn_end', turn_id: 'never-seen', message_id: '00000000-0000-4000-8000-0000000000a2', sig: SIG_1 });
    expect(session.replySignature('never-seen')).toBe(SIG_1);
    expect(session.replySignature('unknown')).toBeNull();
  });

  it('keeps only the latest fifty', async () => {
    const { session, emit } = await opened();
    for (let index = 0; index < 60; index += 1) emit({ type: 'turn_end', turn_id: `t${index}`, message_id: null, sig: SIG_1 });
    expect(session.replySignature('t0')).toBeNull();
    expect(session.replySignature('t9')).toBeNull();
    expect(session.replySignature('t10')).toBe(SIG_1);
    expect(session.replySignature('t59')).toBe(SIG_1);
  });
});
