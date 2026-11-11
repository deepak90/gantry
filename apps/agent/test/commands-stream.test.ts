import { describe, expect, it } from 'vitest';
import type { AgentStreamEvent } from '@collab/shared';
import { CommandRunner } from '../src/agent/commands';
import { partialStringField, type BrainEvent, type TurnResult } from '../src/agent/brain';
import { FakeDb } from '../src/dev/fake';
import { StreamBatcher, type Timers } from '../src/realtime/stream';
import { peersFromPresence, presenceTrigger, presentMembers } from '../src/realtime/presence';
import { planFromRows } from '../src/plan/rows';
import { SEED_IDS } from '@collab/shared/seed';

describe('commands through a person’s browser', () => {
  it('resolves as soon as the command broadcast arrives', async () => {
    const db = new FakeDb();
    const runner = new CommandRunner(db, db.projectId, { pollMs: 10_000, timeoutMs: 30_000 });
    db.onCommandInserted = (row) =>
      setTimeout(() => {
        row.status = 'succeeded';
        row.result = { version_no: 1 };
        runner.notify(row.id);
      }, 5);
    const outcome = await runner.run('propose_fix', {}, SEED_IDS.pmUser, 0);
    expect(outcome.status).toBe('succeeded');
    expect(db.commands[0]).toMatchObject({ type: 'propose_fix', requested_by: SEED_IDS.pmUser, required_revision: 0 });
  });

  it('falls back to polling when no broadcast comes, and reports the browser’s failure message', async () => {
    const db = new FakeDb();
    const runner = new CommandRunner(db, db.projectId, { pollMs: 10, timeoutMs: 5_000 });
    db.onCommandInserted = (row) =>
      setTimeout(() => {
        row.status = 'failed';
        row.result = { message: 'The plan moved on; check again.' };
      }, 20);
    const outcome = await runner.run('revise_fix', {}, SEED_IDS.cmUser, 3);
    expect(outcome).toMatchObject({ status: 'failed', message: 'The plan moved on; check again.' });
  });

  it('withdraws a command nobody claimed after the timeout', async () => {
    const db = new FakeDb();
    const runner = new CommandRunner(db, db.projectId, { pollMs: 10, timeoutMs: 60 });
    const outcome = await runner.run('propose_fix', {}, SEED_IDS.pmUser, 0);
    expect(outcome.status).toBe('timeout');
    expect(db.commands[0]!.status).toBe('cancelled');
  });

  it('does not withdraw a command a browser is still running', async () => {
    const db = new FakeDb();
    const runner = new CommandRunner(db, db.projectId, { pollMs: 10, timeoutMs: 60 });
    db.onCommandInserted = (row) => {
      row.status = 'running';
    };
    const outcome = await runner.run('propose_fix', {}, SEED_IDS.pmUser, 0);
    expect(outcome).toMatchObject({ status: 'timeout', message: expect.stringMatching(/still working/) });
    expect(db.commands[0]!.status).toBe('running');
  });
});

class FakeTimers implements Timers {
  t = 0;
  private queue: { at: number; run: () => void; id: number }[] = [];
  private next = 1;
  now = () => this.t;
  set = (run: () => void, ms: number) => {
    const id = this.next++;
    this.queue.push({ at: this.t + ms, run, id });
    return id;
  };
  clear = (handle: unknown) => {
    this.queue = this.queue.filter((item) => item.id !== handle);
  };
  advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      const due = this.queue.filter((item) => item.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.queue = this.queue.filter((item) => item !== due);
      this.t = due.at;
      due.run();
    }
    this.t = end;
  }
}

const result = (turnId: string): TurnResult => ({
  turnId,
  kind: 'utterance',
  threadId: null,
  channel: 'text',
  model: 'm',
  speakerId: null,
  say: '',
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
});

describe('stream batching', () => {
  const turn = '0e0f2b6e-8d1a-4b5e-9c38-5f3a1c2b4d6e';
  it('sends the first delta at once, then at most one text event per 100 ms, in order with tool events', () => {
    const timers = new FakeTimers();
    const sent: AgentStreamEvent[] = [];
    const batcher = new StreamBatcher((event) => sent.push(event), { timers });
    const event = (e: BrainEvent) => batcher.handle(e);
    event({ type: 'turn_start', turnId: turn, kind: 'utterance', model: 'm', speakerId: null, threadId: null });
    event({ type: 'text_delta', turnId: turn, text: 'Hel' });
    for (const piece of ['lo', ' the', ' crane', ' is', ' idle']) {
      timers.advance(10);
      event({ type: 'text_delta', turnId: turn, text: piece });
    }
    expect(sent.filter((e) => e.type === 'text_delta')).toHaveLength(1);
    timers.advance(100);
    const texts = sent.filter((e) => e.type === 'text_delta');
    expect(texts.map((e) => (e as { text: string }).text).join('')).toBe('Hello the crane is idle');
    expect(texts.map((e) => (e as { seq: number }).seq)).toEqual([0, 1]);

    event({ type: 'text_delta', turnId: turn, text: ' now' });
    event({ type: 'text_delta', turnId: turn, text: '.' });
    event({ type: 'tool', turnId: turn, toolId: 'toolu_1', name: 'propose_fix', state: 'start' });
    expect(sent.slice(-2).map((e) => e.type)).toEqual(['text_delta', 'tool']);
    event({ type: 'turn_end', turnId: turn, result: result(turn), messageId: null });
    expect(sent.at(-1)).toEqual({ type: 'turn_end', turn_id: turn, message_id: null });
  });

  it('sends card drafts at most every 200 ms per card, and the checked card at once', () => {
    const timers = new FakeTimers();
    const sent: AgentStreamEvent[] = [];
    const batcher = new StreamBatcher((event) => sent.push(event), { timers });
    for (let index = 0; index < 20; index++) {
      batcher.handle({ type: 'ui_partial', turnId: turn, cardId: 'toolu_card', component: 'show_issue_card', props: { title: `v${index}` } });
      timers.advance(20);
    }
    const drafts = sent.filter((e) => e.type === 'ui_partial');
    expect(drafts.length).toBeLessThanOrEqual(3);
    batcher.handle({ type: 'card', turnId: turn, card: { id: 'toolu_card', component: 'show_issue_card', props: { title: 'final' } }, status: 'final' });
    expect(sent.at(-1)).toMatchObject({ type: 'ui_partial', card_id: 'toolu_card', props: { title: 'final' } });
  });

  it('drops an event that does not fit the contract instead of sending it', () => {
    const sent: AgentStreamEvent[] = [];
    const invalid: string[] = [];
    const batcher = new StreamBatcher((event) => sent.push(event), { onInvalid: (reason) => invalid.push(reason) });
    batcher.handle({ type: 'turn_start', turnId: '', kind: 'utterance', model: 'm', speakerId: null, threadId: null });
    expect(sent).toEqual([]);
    expect(invalid).toHaveLength(1);
  });

  it('streams a reply that is still being written, decoding escapes', () => {
    expect(partialStringField('{"text":"Hello wor', 'text')).toBe('Hello wor');
    expect(partialStringField('{"text":"Line\\nTwo \\"quoted\\" \\u00e9', 'text')).toBe('Line\nTwo "quoted" é');
    expect(partialStringField('{"text":"Half an escape \\', 'text')).toBe('Half an escape ');
    expect(partialStringField('{"te', 'text')).toBe('');
  });
});

describe('presence', () => {
  const db = new FakeDb();
  const plan = planFromRows(db.plan);
  const pm = plan.members[0]!;
  const cm = plan.members[1]!;
  it('reads tabs, ignores forged metas, and maps them to members', () => {
    const state = {
      's-1': [{ session: 's-1', user: SEED_IDS.pmUser, name: 'Chris Hale', role: 'pm', since: 1 }],
      's-2': [{ session: 'someone-else', user: SEED_IDS.cmUser, name: 'Deepak Jayaram', role: 'cm', since: 2 }],
      's-3': [{ session: 's-3', user: SEED_IDS.pmUser, name: 'Chris Hale', role: 'pm', since: 3 }],
    };
    const peers = peersFromPresence(state);
    expect(peers.map((peer) => peer.session)).toEqual(['s-1', 's-3']);
    expect(presentMembers(plan, peers).map((member) => member.name)).toEqual(['Chris Hale']);
  });

  it('starts the meeting when a second person arrives and someone present sees costs', () => {
    expect(presenceTrigger([], [pm])).toMatchObject({ kind: 'person_joined' });
    expect(presenceTrigger([pm], [pm, cm])).toMatchObject({ kind: 'meeting_started' });
    expect(presenceTrigger([pm, cm], [pm, cm])).toBeNull();
    // A reload opens a new session: the person counts as joining again.
    expect(presenceTrigger([pm, cm], [pm, cm], [cm])).toMatchObject({ kind: 'person_joined', member: { userId: cm.userId } });
    // One role for everyone: what makes a meeting is two people, one of whom could approve a fix.
    const sam = { ...pm, userId: 'sam', name: 'Sam Ortiz', canViewCosts: false };
    const kim = { ...sam, userId: 'kim', name: 'Kim Lee' };
    expect(presenceTrigger([sam], [sam, kim])).toMatchObject({ kind: 'person_joined' });
    expect(presenceTrigger([sam, kim], [sam, kim, cm])).toMatchObject({ kind: 'meeting_started' });
  });
});
