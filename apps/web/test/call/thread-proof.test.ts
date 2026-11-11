/**
 * Remy's answers go to her voice with the proof that the assistant service wrote them, where it signs (the hosted
 * site): what an answer says before a tool goes with the answer as signed at that tool, the stored answer with the
 * signature of the stored text, and the rest of a cut-off line with the proof of the line it came from. A stored answer
 * that comes in before its turn's end waits for the end, which brings its signature.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessageRow } from '@collab/shared';
import { REMY, type LineProof, type RemyMessage } from '../../src/call/protocol';
import { linkThread, type CallPort, type LiveAnswer, type ThreadPort } from '../../src/call/thread';

const PROJECT = '00000000-0000-4000-8000-000000000002';
const SIG_1 = 'a'.repeat(43);
const SIG_2 = 'b'.repeat(43);
const SIG_STORED = 'c'.repeat(43);
let counter = 0;
const row = (overrides: Partial<AgentMessageRow> = {}): AgentMessageRow => {
  counter += 1;
  return { id: `20000000-0000-4000-8000-${String(counter).padStart(12, '0')}`, project_id: PROJECT, turn_id: null, role: 'assistant', author_id: null, channel: 'voice', text: '', cards: [], action: null, created_at: new Date(Date.now() + 1000).toISOString(), ...overrides };
};

function harness({ resume = false, cutFirst = false } = {}) {
  const listeners = new Set<() => void>();
  const captionListeners = new Set<(caption: { identity: string; text: string; final: boolean }) => void>();
  const said: { text: string; proof: LineProof | null | undefined }[] = [];
  let cuts = cutFirst ? 1 : 0;
  const call: CallPort = {
    me: 'deepak-tab',
    inCall: true,
    isHost: true,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onMessage: () => () => undefined,
    onCaption: (listener) => {
      captionListeners.add(listener);
      return () => captionListeners.delete(listener);
    },
    say: vi.fn(async (text: string, options?: { to?: string | null; proof?: LineProof | null }) => {
      said.push({ text, proof: options?.proof });
      if (cuts > 0) {
        cuts -= 1;
        captionListeners.forEach((listener) => listener({ identity: REMY, text: text.split(' ').slice(0, 4).join(' '), final: true }));
        return { id: `line-${said.length}`, interrupted: true };
      }
      return { id: `line-${said.length}`, interrupted: false };
    }),
  };
  const threadListeners = new Set<() => void>();
  const sigs = new Map<string, string>();
  const snapshot: { threadId: string | null; draft: boolean; sending: boolean; messages: AgentMessageRow[]; live: LiveAnswer | null } = { threadId: null, draft: false, sending: false, messages: [], live: null };
  const thread: ThreadPort = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      threadListeners.add(listener);
      return () => threadListeners.delete(listener);
    },
    openThread: () => undefined,
    send: async () => true,
    replySignature: (turnId) => sigs.get(turnId) ?? null,
  };
  const changed = () => threadListeners.forEach((listener) => listener());
  const link = linkThread(call, thread, { resume, resumeQuietMs: 50 });
  return {
    said,
    link,
    stream(live: LiveAnswer | null) {
      snapshot.live = live;
      changed();
    },
    /** The stored answer comes in; its turn still live unless `ended`. */
    land(message: AgentMessageRow, { ended = true }: { ended?: boolean } = {}) {
      snapshot.messages = [...snapshot.messages, message];
      if (ended) snapshot.live = null;
      changed();
    },
    /** The turn's end: its stored answer's signature, and the turn no longer live. */
    end(turnId: string, sig: string | null) {
      if (sig) sigs.set(turnId, sig);
      snapshot.live = snapshot.live && snapshot.live.turnId === turnId ? { ...snapshot.live, ending: true } : snapshot.live;
      changed();
    },
    sign(turnId: string, sig: string) {
      sigs.set(turnId, sig);
    },
  };
}

beforeEach(() => {
  counter = 0;
});
afterEach(() => vi.useRealTimers());

describe('an answer said with its proof', () => {
  it('hands what came before each tool with the answer as signed at that tool', async () => {
    const h = harness();
    h.stream({ turnId: 't1', threadId: null, text: 'Sure, one second.', tools: [{ id: 'draft' }], ending: false, signed: { text: 'Sure, one second.', sig: SIG_1 } });
    await vi.waitFor(() => expect(h.said).toHaveLength(1));
    expect(h.said[0]).toEqual({ text: 'Sure, one second.', proof: { turn: 't1', whole: 'Sure, one second.', sig: SIG_1 } });
    h.stream({ turnId: 't1', threadId: null, text: 'Sure, one second. Here it is.', tools: [{ id: 'draft' }, { id: 'card' }], ending: false, signed: { text: 'Sure, one second. Here it is.', sig: SIG_2 } });
    await vi.waitFor(() => expect(h.said).toHaveLength(2));
    expect(h.said[1]).toEqual({ text: 'Here it is.', proof: { turn: 't1', whole: 'Sure, one second. Here it is.', sig: SIG_2 } });
    h.link.stop();
  });

  it('hands the rest of the stored answer, or all of it, with the stored text’s signature', async () => {
    const h = harness();
    h.stream({ turnId: 't2', threadId: null, text: 'Sure.', tools: [{ id: 'odds' }], ending: false, signed: { text: 'Sure.', sig: SIG_1 } });
    await vi.waitFor(() => expect(h.said).toHaveLength(1));
    h.sign('t2', SIG_STORED);
    const stored = 'Sure. The odds of handing over on time are three in four.';
    h.land(row({ turn_id: 't2', text: stored }));
    await vi.waitFor(() => expect(h.said).toHaveLength(2));
    expect(h.said[1]).toEqual({ text: 'The odds of handing over on time are three in four.', proof: { turn: 't2', whole: stored, sig: SIG_STORED } });

    h.sign('t3', SIG_2);
    h.land(row({ turn_id: 't3', text: 'Anytime.' }));
    await vi.waitFor(() => expect(h.said).toHaveLength(3));
    expect(h.said[2]).toEqual({ text: 'Anytime.', proof: { turn: 't3', whole: 'Anytime.', sig: SIG_2 } });
    h.link.stop();
  });

  it('hands a line with no proof where the service signs nothing, as on the owner’s machine', async () => {
    const h = harness();
    h.stream({ turnId: 't4', threadId: null, text: 'Checking.', tools: [{ id: 'x' }], ending: false });
    h.land(row({ turn_id: 't5', text: 'Done.' }));
    await vi.waitFor(() => expect(h.said).toHaveLength(2));
    expect(h.said.map((line) => line.proof)).toEqual([null, null]);
    h.link.stop();
  });

  it('waits for the turn’s end when its stored answer comes in first, then says it with the signature the end brought', async () => {
    const h = harness();
    h.stream({ turnId: 't6', threadId: null, text: '', tools: [], ending: false });
    h.land(row({ turn_id: 't6', text: 'The crane is idle three days.' }), { ended: false });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(h.said).toEqual([]);
    h.end('t6', SIG_STORED);
    await vi.waitFor(() => expect(h.said).toHaveLength(1));
    expect(h.said[0]).toEqual({ text: 'The crane is idle three days.', proof: { turn: 't6', whole: 'The crane is idle three days.', sig: SIG_STORED } });
    h.link.stop();
  });

  it('says a stored answer anyway when its turn’s end never comes', async () => {
    vi.useFakeTimers();
    const h = harness();
    h.stream({ turnId: 't7', threadId: null, text: '', tools: [], ending: false });
    h.land(row({ turn_id: 't7', text: 'Done.' }), { ended: false });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.said).toEqual([]);
    await vi.advanceTimersByTimeAsync(600);
    expect(h.said).toEqual([{ text: 'Done.', proof: null }]);
    h.link.stop();
  });

  it('finishes a cut-off line with the proof of the line it came from', async () => {
    const h = harness({ resume: true, cutFirst: true });
    const stored = 'The crane sits idle seven days. That costs four thousand two hundred. It can come off the plan.';
    h.sign('t8', SIG_STORED);
    h.land(row({ turn_id: 't8', text: stored }));
    await vi.waitFor(() => expect(h.said).toHaveLength(2), { timeout: 4000 });
    expect(h.said[1]).toEqual({ text: 'That costs four thousand two hundred. It can come off the plan.', proof: { turn: 't8', whole: stored, sig: SIG_STORED } });
    h.link.stop();
  });
});
