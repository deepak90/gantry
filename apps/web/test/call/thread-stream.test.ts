/**
 * Remy's answers on a call, said as Claude writes them: what an answer says before it starts working (drafting, the
 * odds) is said at once, and only the rest when the answer lands. And with `resume`, an answer someone cut in on is
 * finished from the next sentence once the floor is free, unless someone asked her something new.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AgentMessageRow } from '@collab/shared';
import { REMY, type RemyMessage } from '../../src/call/protocol';
import { HOLDING_THE_FLOOR, linkThread, PROGRESS_NOTE, remainderAfter, restAfterCut, saysWhatAFillerSaid, sentencesOf, type CallPort, type LiveAnswer, type ThreadPort } from '../../src/call/thread';

const PROJECT = '00000000-0000-4000-8000-000000000002';
let counter = 0;
const row = (overrides: Partial<AgentMessageRow> = {}): AgentMessageRow => {
  counter += 1;
  return { id: `10000000-0000-4000-8000-${String(counter).padStart(12, '0')}`, project_id: PROJECT, turn_id: null, role: 'assistant', author_id: null, channel: 'voice', text: '', cards: [], action: null, created_at: new Date(Date.now() + 1000).toISOString(), ...overrides };
};

function harness({ resume = false, cutFirst = false, quietLookups = false } = {}) {
  const listeners = new Set<() => void>();
  const messageListeners = new Set<(message: RemyMessage, from: string | null) => void>();
  const captionListeners = new Set<(caption: { identity: string; text: string; final: boolean }) => void>();
  const said: string[] = [];
  let cuts = cutFirst ? 1 : 0;
  const call: CallPort = {
    me: 'deepak-tab',
    inCall: true,
    isHost: true,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onMessage: (listener) => {
      messageListeners.add(listener);
      return () => messageListeners.delete(listener);
    },
    onCaption: (listener) => {
      captionListeners.add(listener);
      return () => captionListeners.delete(listener);
    },
    say: vi.fn(async (text: string) => {
      said.push(text);
      if (cuts > 0) {
        cuts -= 1;
        // She got her first words out before someone cut in.
        captionListeners.forEach((listener) => listener({ identity: REMY, text: text.split(' ').slice(0, 9).join(' '), final: true }));
        return { id: `line-${said.length}`, interrupted: true };
      }
      return { id: `line-${said.length}`, interrupted: false };
    }),
  };
  const threadListeners = new Set<() => void>();
  const snapshot: { threadId: string | null; draft: boolean; sending: boolean; messages: AgentMessageRow[]; live: LiveAnswer | null } = { threadId: null, draft: false, sending: false, messages: [], live: null };
  const thread: ThreadPort = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      threadListeners.add(listener);
      return () => threadListeners.delete(listener);
    },
    openThread: () => undefined,
    send: async () => true,
  };
  const changed = () => threadListeners.forEach((listener) => listener());
  const link = linkThread(call, thread, { resume, resumeQuietMs: 50, quietLookups });
  return {
    said,
    link,
    stream(live: LiveAnswer | null) {
      snapshot.live = live;
      changed();
    },
    land(message: AgentMessageRow) {
      snapshot.messages = [...snapshot.messages, message];
      snapshot.live = null;
      changed();
    },
    hear(message: RemyMessage) {
      messageListeners.forEach((listener) => listener(message, REMY));
    },
    caption(identity: string, text: string) {
      captionListeners.forEach((listener) => listener({ identity, text, final: false }));
    },
  };
}

describe('an answer said as it is written', () => {
  it('says what came before a tool at once, and only the rest when it lands', async () => {
    const h = harness();
    h.stream({ turnId: 't1', threadId: null, text: 'Sure, one second.', tools: [], ending: false });
    expect(h.said).toEqual([]);
    h.stream({ turnId: 't1', threadId: null, text: 'Sure, one second.', tools: [{ id: 'draft' }], ending: false });
    await vi.waitFor(() => expect(h.said).toEqual(['Sure, one second.']));
    h.stream({ turnId: 't1', threadId: null, text: 'Sure, one second. Here it is.', tools: [{ id: 'draft' }, { id: 'card' }], ending: false });
    await vi.waitFor(() => expect(h.said).toEqual(['Sure, one second.', 'Here it is.']));
    h.land(row({ turn_id: 't1', text: 'Sure, one second. Here it is. Fixtures come to about $12,000 a floor.' }));
    await vi.waitFor(() => expect(h.said).toEqual(['Sure, one second.', 'Here it is.', 'Fixtures come to about $12,000 a floor.']));
    h.link.stop();
  });

  it('says nothing more when the answer was all said before its tools, and all of it when it was never streamed', async () => {
    const h = harness();
    h.stream({ turnId: 't2', threadId: null, text: 'Running it now.', tools: [{ id: 'odds' }], ending: false });
    await vi.waitFor(() => expect(h.said).toEqual(['Running it now.']));
    h.land(row({ turn_id: 't2', text: 'Running it now.' }));
    h.land(row({ turn_id: 't3', text: 'Anytime.' }));
    await vi.waitFor(() => expect(h.said).toEqual(['Running it now.', 'Anytime.']));
    h.link.stop();
  });

  it('with quiet look-ups, leaves unsaid what comes before a quick look-up, and says what comes before slow work', async () => {
    const h = harness({ quietLookups: true });
    h.stream({ turnId: 't8', threadId: null, text: 'Checking the crane.', tools: [{ id: 'c1', name: 'get_rentals' }], ending: false });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.said).toEqual([]);
    h.land(row({ turn_id: 't8', text: 'Checking the crane. It sits idle seven days, $4,200.' }));
    await vi.waitFor(() => expect(h.said).toEqual(['It sits idle seven days, $4,200.']));
    h.stream({ turnId: 't9', threadId: null, text: 'Sure, one second.', tools: [{ id: 'd1', name: 'draft_snippet' }], ending: false });
    await vi.waitFor(() => expect(h.said).toEqual(['It sits idle seven days, $4,200.', 'Sure, one second.']));
    h.link.stop();
  });

  it('with quiet look-ups, leaves unsaid a note of what it is about to do, even before slow work', async () => {
    const h = harness({ quietLookups: true });
    h.stream({ turnId: 't12', threadId: null, text: 'Drafting the fixtures for one floor.', tools: [{ id: 'd2', name: 'draft_snippet' }], ending: false });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.said).toEqual([]);
    h.land(row({ turn_id: 't12', text: 'Drafting the fixtures for one floor. Here you go. Fixtures come to about $12,000 a floor.' }));
    await vi.waitFor(() => expect(h.said).toEqual(['Here you go. Fixtures come to about $12,000 a floor.']));
    h.link.stop();
  });

  it('with quiet look-ups, says what comes before the odds: it tells the call what the board is', async () => {
    const h = harness({ quietLookups: true });
    h.stream({ turnId: 't14', threadId: null, text: 'Let me run the schedule a thousand different ways.', tools: [{ id: 'o1', name: 'schedule_odds' }], ending: false });
    await vi.waitFor(() => expect(h.said).toEqual(['Let me run the schedule a thousand different ways.']));
    h.link.stop();
  });

  it('with quiet look-ups, says an answer written whole before a quick look-up (an offer for the other floors before a calculation)', async () => {
    const h = harness({ quietLookups: true });
    const offer = 'It goes in with the ceiling tiles on level 1, so nothing moves. Levels 2 and 3 look the same; want me to add them?';
    h.stream({ turnId: 't13', threadId: null, text: offer, tools: [{ id: 'k1', name: 'calculate' }], ending: false });
    await vi.waitFor(() => expect(h.said).toEqual([offer]));
    h.land(row({ turn_id: 't13', text: offer }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.said).toEqual([offer]);
    h.link.stop();
  });

  it('knows a progress note from an answer', () => {
    for (const note of ['Drafting the fixtures for one floor.', 'Checking the crane.', "I'm pulling up the rental.", 'Okay, pricing it now.', 'Let me check the other floors.', 'One sec, checking the other floors.'])
      expect(PROGRESS_NOTE.test(note), note).toBe(true);
    for (const answer of ['Sure, one second.', 'Levels 2 and 3 fit too. Add them?', 'Invoice is ready, $124,800.', 'Here you go. Fixtures come to about $12,000 a floor.', 'Done. One order for all three comes to $105,000.'])
      expect(PROGRESS_NOTE.test(answer), answer).toBe(false);
  });

  it('with quiet look-ups, still says an answer written before its card or its draft', async () => {
    const h = harness({ quietLookups: true });
    h.stream({ turnId: 't10', threadId: null, text: '', tools: [{ id: 'f1', name: 'find_similar_places' }], ending: false });
    h.stream({ turnId: 't10', threadId: null, text: 'Levels 2 and 3 fit too. Add them?', tools: [{ id: 'f1', name: 'find_similar_places' }, { id: 'e1', name: 'draft_plan_edit' }], ending: false });
    await vi.waitFor(() => expect(h.said).toEqual(['Levels 2 and 3 fit too. Add them?']));
    h.stream({ turnId: 't11', threadId: null, text: 'Invoice is ready, $124,800.', tools: [{ id: 's1', name: 'show_change_invoice' }], ending: false });
    await vi.waitFor(() => expect(h.said).toEqual(['Levels 2 and 3 fit too. Add them?', 'Invoice is ready, $124,800.']));
    h.link.stop();
  });

  it('never hands on the rest of an answer starting with the mark that closed what was already said', () => {
    expect(remainderAfter('Checking the crane. The crane is on rent Nov 25 to Dec 13.', 'Checking the crane')).toBe('The crane is on rent Nov 25 to Dec 13.');
    expect(remainderAfter('Sure, one second. Here it is.', 'Sure, one second.')).toBe('Here it is.');
    expect(remainderAfter('Here it is.', 'Elsewhere')).toBeNull();
  });

  it('leaves another thread’s answer alone', async () => {
    const h = harness();
    h.stream({ turnId: 't4', threadId: 'someone-elses', text: 'Elsewhere.', tools: [{ id: 'x' }], ending: false });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.said).toEqual([]);
    h.link.stop();
  });
});

describe('after one of her fillers', () => {
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  /** Someone asks her something, and a moment later her worker says a filler ("Let me look."). */
  async function askedThenFiller(h: ReturnType<typeof harness>, filler = true) {
    h.hear({ kind: 'heard', identity: 'ana-tab', text: 'What is the crane costing us while it waits?', addressed: true, final: true, at: Date.now() });
    await pause(5);
    if (filler) h.hear({ kind: 'filler', text: 'Let me look.' });
  }

  it('leaves unsaid an opening that only says what the filler said, and says the answer', async () => {
    const h = harness();
    await askedThenFiller(h);
    h.stream({ turnId: 'f1', threadId: null, text: "Pulling up the crane's dates.", tools: [{ id: 'b1', name: 'get_booking' }], ending: false });
    await pause(20);
    expect(h.said).toEqual([]);
    h.land(row({ turn_id: 'f1', text: "Pulling up the crane's dates. It sits fourteen days with nothing to lift; that's $8,400." }));
    await vi.waitFor(() => expect(h.said).toEqual(["It sits fourteen days with nothing to lift; that's $8,400."]));
    h.link.stop();
  });

  it('leaves unsaid a "one second" too', async () => {
    const h = harness();
    await askedThenFiller(h);
    h.stream({ turnId: 'f2', threadId: null, text: 'Sure, one second.', tools: [{ id: 'd1', name: 'draft_snippet' }], ending: false });
    await pause(20);
    expect(h.said).toEqual([]);
    h.land(row({ turn_id: 'f2', text: 'Sure, one second. At four thousand square feet, that’s about fifty fixtures a floor.' }));
    await vi.waitFor(() => expect(h.said).toEqual(['At four thousand square feet, that’s about fifty fixtures a floor.']));
    h.link.stop();
  });

  it('says the opening when no filler was said for this question', async () => {
    const h = harness();
    await askedThenFiller(h, false);
    h.stream({ turnId: 'f3', threadId: null, text: "Pulling up the crane's dates.", tools: [{ id: 'b2', name: 'get_booking' }], ending: false });
    await vi.waitFor(() => expect(h.said).toEqual(["Pulling up the crane's dates."]));
    // A filler for that question, then a new question: its opening is said.
    h.hear({ kind: 'filler', text: 'One moment.' });
    await pause(5);
    await askedThenFiller(h, false);
    h.stream({ turnId: 'f4', threadId: null, text: 'Looking at the footings.', tools: [{ id: 'p1', name: 'get_progress_payments' }], ending: false });
    await vi.waitFor(() => expect(h.said).toEqual(["Pulling up the crane's dates.", 'Looking at the footings.']));
    h.link.stop();
  });

  it('says an opening that has something in it, what comes before the odds, and what comes after the opening', async () => {
    const h = harness();
    await askedThenFiller(h);
    const offer = 'At four thousand square feet, that’s about fifty fixtures a floor.';
    h.stream({ turnId: 'f5', threadId: null, text: offer, tools: [{ id: 'd2', name: 'draft_snippet' }], ending: false });
    await vi.waitFor(() => expect(h.said).toEqual([offer]));

    await askedThenFiller(h);
    const odds = 'Let me run the schedule a thousand different ways.';
    h.stream({ turnId: 'f6', threadId: null, text: odds, tools: [{ id: 'o1', name: 'schedule_odds' }], ending: false });
    await vi.waitFor(() => expect(h.said).toEqual([offer, odds]));

    await askedThenFiller(h);
    h.stream({ turnId: 'f7', threadId: null, text: 'Pulling up the crane.', tools: [{ id: 'b3', name: 'get_booking' }], ending: false });
    h.stream({ turnId: 'f7', threadId: null, text: 'Pulling up the crane. Checking the slab too.', tools: [{ id: 'b3', name: 'get_booking' }, { id: 't1', name: 'get_task' }], ending: false });
    await vi.waitFor(() => expect(h.said).toEqual([offer, odds, 'Checking the slab too.']));
    h.link.stop();
  });

  it('knows words that only hold the floor', () => {
    for (const text of ['Sure, one second.', 'One moment.', 'Okay.', 'Got it, one sec.', 'Give me a moment.', 'Hang on.', "Pulling up the crane's dates.", 'Let me see what we owe on the footings.', 'Looking at the slab.'])
      expect(saysWhatAFillerSaid(text), text).toBe(true);
    for (const text of ['It sits fourteen days idle.', 'Sure. At four thousand square feet, that’s about fifty fixtures a floor.', 'Done. That saves us $4,200.', 'Anytime.'])
      expect(saysWhatAFillerSaid(text), text).toBe(false);
    expect(HOLDING_THE_FLOOR.test('Sure, one second.')).toBe(true);
    expect(HOLDING_THE_FLOOR.test('Sure, checking.')).toBe(false);
  });
});

describe('an answer someone cut in on', () => {
  const answer = "Let me show you. We're renting it from the day before Thanksgiving through December 9. It sits for seven days with nothing to lift. That's $4,200.";

  it('is finished from the next sentence once the floor is free', async () => {
    const h = harness({ resume: true, cutFirst: true });
    h.land(row({ turn_id: 't5', text: answer }));
    await vi.waitFor(() => expect(h.said).toEqual([answer, "It sits for seven days with nothing to lift. That's $4,200."]), { timeout: 3000 });
    h.link.stop();
  });

  it('is dropped when someone asks her something new', async () => {
    const h = harness({ resume: true, cutFirst: true });
    h.land(row({ turn_id: 't6', text: answer }));
    await vi.waitFor(() => expect(h.said).toEqual([answer]));
    h.hear({ kind: 'heard', identity: 'chris-tab', text: 'Remy, who booked it?', addressed: true, final: true, at: Date.now() });
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(h.said).toEqual([answer]);
    h.link.stop();
  });

  it('is not finished without resume', async () => {
    const h = harness({ resume: false, cutFirst: true });
    h.land(row({ turn_id: 't7', text: answer }));
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(h.said).toEqual([answer]);
    h.link.stop();
  });
});

describe('the words left to say', () => {
  it('are the stored words after the part already said, whitespace aside', () => {
    expect(remainderAfter('Sure, one second. Here it is.', 'Sure, one  second.')).toBe('Here it is.');
    expect(remainderAfter('Sure.', 'Sure.')).toBe('');
    expect(remainderAfter('Something else entirely.', 'Sure, one second.')).toBeNull();
  });

  it('after a cut are the sentences after the one she was cut off in', () => {
    expect(sentencesOf('One. Two two! Three?')).toEqual(['One.', 'Two two!', 'Three?']);
    expect(restAfterCut('Let me show you. We rent it through December 9. It sits idle.', "Let me show you. We rent it through Decem")).toBe('It sits idle.');
    expect(restAfterCut('One sentence only, cut here.', 'One sentence')).toBe('');
    expect(restAfterCut('Anything.', '')).toBe('');
  });
});
