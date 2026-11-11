/**
 * The real ProjectAgent with the scripted model, an in-memory database and fake browsers: the whole
 * loop from people joining to the receipt, checked against the contract the browser codes against.
 */
import { describe, expect, it } from 'vitest';
import { AgentStreamEvent, parseCardProps, threadTopic } from '@collab/shared';
import { SEED_IDS } from '@collab/shared/seed';
import { runDataTool, ToolRefusal, type ToolContext } from '../src/agent/tools';
import { FakeBrowser, FakeDb, FakeTransport, presenceAt, presenceOf } from '../src/dev/fake';
import { makeClient } from '../src/llm/client';
import { silentLogger } from '../src/log';
import { planFromRows } from '../src/plan/rows';
import { ProjectAgent } from '../src/project-agent';
import type { TurnResult } from '../src/agent/brain';

function setup(options: { openingDelayMs?: number; raiseIssues?: boolean; db?: (db: FakeDb) => void } = {}) {
  const db = new FakeDb();
  options.db?.(db);
  const transport = new FakeTransport();
  const browser = new FakeBrowser(db, transport, { commandDelayMs: 5 });
  const turns: TurnResult[] = [];
  const agent = new ProjectAgent({
    projectId: db.projectId,
    store: db,
    transport,
    client: makeClient('mock', { delayMs: 0 }),
    models: { analysis: 'claude-opus-5-5', chat: 'claude-sonnet-5-5' },
    log: silentLogger,
    debounce: { presence: 0, workflow: 5, plan: 5 },
    openingDelayMs: options.openingDelayMs ?? 0,
    raiseIssues: options.raiseIssues ?? true,
    onTurn: (result) => turns.push(result),
  });
  return { db, transport, browser, agent, turns };
}

async function step(agent: ProjectAgent, act: () => unknown) {
  act();
  await agent.idle();
}

describe('the agent end to end (scripted model)', () => {
  it('waits to be asked; "what is wrong with this task?" is about the selection, and a thread is answered in that thread', async () => {
    const { db, transport, browser, agent, turns } = setup({ raiseIssues: false });
    await agent.start();
    await step(agent, () => transport.presence(db.projectId, presenceOf('pm', 'cm')));
    await step(agent, () => transport.revision(db.projectId));
    expect(turns).toHaveLength(0);

    const plan = planFromRows(db.plan);
    const rented = plan.tasks.find((task) => task.id === plan.bookings[0]!.taskId)!;
    const elsewhere = plan.tasks.find((task) => task.isLeaf && task.phase !== rented.phase && !task.isMilestone)!;
    await step(agent, () => browser.say('pm', 'What is wrong with this task?', 'text', null, { context: { selected_tasks: [{ id: elsewhere.id, name: elsewhere.name, wbs: null }] } }));
    expect(db.messages.at(-1)!.text).toMatch(/nothing wrong with them/);
    await step(agent, () => browser.say('pm', 'What is wrong with this task?', 'text', null, { context: { selected_tasks: [{ id: rented.id, name: rented.name, wbs: null }] } }));
    const answer = db.messages.at(-1)!;
    expect(answer.cards.map((card) => card.component)).toEqual(['show_issue_card']);
    // The card says which task it is about, from the service's own records, so a 3D view can go there.
    expect((parseCardProps('show_issue_card', answer.cards[0]!.props) as { task_ids: number[] }).task_ids).toEqual([rented.id]);
    expect(answer.text).toMatch(/want me to prepare it\?$/);
    const findCall = turns.at(-1)!.toolCalls.find((call) => call.name === 'find_issues')!;
    expect(findCall.input).toEqual({ task_ids: [rented.id] });

    const threadId = '00000000-0000-4000-8000-00000000a001';
    db.threads.push({ id: threadId, project_id: db.projectId, title: 'Handover', created_by: SEED_IDS.cmUser, created_at: new Date().toISOString(), last_message_at: new Date().toISOString(), title_source: 'person', visibility: 'project', costs_shared_by: null, costs_shared_at: null });
    transport.sent.length = 0;
    await step(agent, () => browser.say('cm', 'What sets the handover date?', 'text', null, { thread_id: threadId }));
    expect(db.messages.at(-1)).toMatchObject({ role: 'assistant', thread_id: threadId });
    expect(transport.sent.find((event) => event.type === 'turn_start')).toMatchObject({ thread_id: threadId });
    // The new thread's conversation starts fresh; the main thread's goes on.
    expect(agent.brain.thread.length).toBeGreaterThan(0);
  });

  it('keeps a private thread to the people in it: its own topic, amounts while only people who see costs read, withheld once a teammate who cannot joins, until Chris shares the costs', async () => {
    // One role for everyone; Sam is a teammate without cost access (like the crowd's simulated people).
    let sam = '';
    const { db, transport, browser, agent } = setup({ raiseIssues: false, db: (fake) => void (sam = fake.addMember({ display_name: 'Sam Ortiz' })) });
    await agent.start();
    const plan = planFromRows(db.plan);
    const rented = plan.tasks.find((task) => task.id === plan.bookings[0]!.taskId)!;
    const selected = { context: { selected_tasks: [{ id: rented.id, name: rented.name, wbs: null }] } };
    const threadId = '00000000-0000-4000-8000-00000000a002';
    const at = new Date().toISOString();
    db.threads.push({ id: threadId, project_id: db.projectId, title: 'What is wrong with this task?', created_by: SEED_IDS.cmUser, created_at: at, last_message_at: at, title_source: 'auto', visibility: 'private', costs_shared_by: null, costs_shared_at: null });
    // Priya sees costs too: inviting her changes nothing about the money.
    db.threadMembers.push({ thread_id: threadId, user_id: SEED_IDS.pmUser, added_by: SEED_IDS.cmUser, added_at: at });

    transport.sent.length = 0;
    transport.topics.length = 0;
    await step(agent, () => browser.say('cm', 'What is wrong with this task?', 'text', null, { thread_id: threadId, ...selected }));
    const privately = db.messages.at(-1)!;
    expect(privately).toMatchObject({ role: 'assistant', thread_id: threadId });
    expect((parseCardProps('show_issue_card', privately.cards[0]!.props) as { money: unknown }).money).not.toBeNull();
    expect(privately.text).toMatch(/\$\d/);
    // Every event of the reply went on the thread's own topic, none on the project's agent topic.
    expect(transport.topics.length).toBeGreaterThan(0);
    expect(new Set(transport.topics)).toEqual(new Set([threadTopic(db.projectId, threadId)]));

    // Sam is in the thread but nobody shared the costs (an invitation from before sharing had to be
    // confirmed): the thread gets no amounts.
    db.threadMembers.push({ thread_id: threadId, user_id: sam, added_by: SEED_IDS.cmUser, added_at: at });
    transport.thread(db.projectId, threadId, 'update');
    await new Promise((resolve) => setTimeout(resolve, 250));
    await step(agent, () => browser.say(sam, 'What is wrong with this task?', 'text', null, { thread_id: threadId, ...selected }));
    const withheld = db.messages.at(-1)!;
    expect((parseCardProps('show_issue_card', withheld.cards[0]!.props) as { money: unknown }).money).toBeNull();
    expect(withheld.text).not.toMatch(/\$\d/);

    // Chris shares the costs in the conversation (the warning he accepted when inviting Sam): amounts again, for everyone in it.
    db.threads.find((thread) => thread.id === threadId)!.costs_shared_by = SEED_IDS.cmUser;
    transport.thread(db.projectId, threadId, 'update');
    await new Promise((resolve) => setTimeout(resolve, 250));
    await step(agent, () => browser.say(sam, 'What is wrong with this task?', 'text', null, { thread_id: threadId, ...selected }));
    const shared = db.messages.at(-1)!;
    expect((parseCardProps('show_issue_card', shared.cards[0]!.props) as { money: unknown }).money).not.toBeNull();
    expect(shared.text).toMatch(/\$\d/);
  });

  it('raises the crane once, and drafts new rental dates as a change a person applies', async () => {
    const { db, transport, browser, agent, turns } = setup();
    await agent.start();
    await step(agent, () => transport.presence(db.projectId, presenceOf('pm')));
    expect(turns).toHaveLength(0);
    await step(agent, () => transport.presence(db.projectId, presenceOf('pm', 'cm')));
    expect(turns).toHaveLength(1);
    const opening = db.messages.at(-1)!;
    expect(opening).toMatchObject({ role: 'assistant', channel: 'app', author_id: null });
    expect(opening.text).toMatch(/want me to prepare it\?$/);
    expect(opening.cards.map((card) => card.component)).toEqual(['show_issue_card']);
    expect(turns[0]!.steps).toBe(1);

    // A plan edit does not bring the same issue up again.
    await step(agent, () => transport.revision(db.projectId));
    expect(turns).toHaveLength(1);

    const issueId = (parseCardProps('show_issue_card', opening.cards[0]!.props) as { issue_id: string }).issue_id;
    await step(agent, () => browser.say('pm', 'Yes, prepare the fix.', 'text', { kind: 'prepare_fix', issue_id: issueId }));
    const prepared = db.messages.at(-1)!;
    expect(prepared.channel).toBe('text');
    // A change to the plan a person applies: nothing to approve, and nothing done yet.
    expect(prepared.cards.map((card) => card.component)).toEqual(['show_plan_edit']);
    expect(parseCardProps('show_plan_edit', prepared.cards[0]!.props)).toMatchObject({ operations: [{ op: 'set_rental', task: 15, machine: 'Crane', first_day: '2026-12-10', last_day: '2026-12-18' }] });
    expect(prepared.text).toMatch(/9 days, \$5,400, and it saves \$1,200/);
    expect(db.workflow.proposals).toHaveLength(0);

    await step(agent, () => browser.say('cm', 'Who pays the supplier?'));
    expect(db.messages.at(-1)!.text).toMatch(/^Anyone who sees costs pays with one press/);

    // In their own words, out loud: the dates come from the tool, on the machine's calendar.
    await step(agent, () => browser.say('cm', 'Keep the crane one spare day at the end, in case the frame runs over.', 'voice'));
    const asked = db.messages.at(-1)!;
    expect(asked.channel).toBe('voice');
    expect(asked.text).toMatch(/\$4,800/);
    expect(parseCardProps('show_plan_edit', asked.cards[0]!.props)).toMatchObject({ operations: [{ op: 'set_rental', first_day: '2026-12-11', last_day: '2026-12-18' }] });
    await step(agent, () => browser.say('cm', 'Two days before and one day after.'));
    expect(parseCardProps('show_plan_edit', db.messages.at(-1)!.cards[0]!.props)).toMatchObject({ operations: [{ op: 'set_rental', first_day: '2026-12-09', last_day: '2026-12-18' }] });
    // The agent never approved or paid anything itself.
    expect(db.workflow.approvals).toHaveLength(0);

    // Every stream event fits the contract; text deltas count up per turn; each turn_end names its stored reply.
    for (const event of transport.sent) expect(AgentStreamEvent.safeParse(event).success).toBe(true);
    const ends = transport.sent.filter((event) => event.type === 'turn_end');
    expect(ends).toHaveLength(turns.length);
    for (const end of ends) expect(db.messages.some((message) => message.id === end.message_id)).toBe(true);
    for (const turn of turns) {
      const seqs = transport.sent.filter((event) => event.type === 'text_delta' && event.turn_id === turn.turnId).map((event) => (event as { seq: number }).seq);
      expect(seqs).toEqual(seqs.map((_, index) => index));
    }
    const personTurn = transport.sent.find((event) => event.type === 'turn_start' && event.kind === 'utterance');
    expect(personTurn).toMatchObject({ speaker_id: SEED_IDS.pmUser });
    await agent.stop();
  });

  it('withholds amounts in the main thread while a member who cannot see costs is on the project', async () => {
    const { db, transport, browser, agent } = setup({ db: (fake) => void fake.addMember({ display_name: 'Sam Ortiz' }) });
    await agent.start();
    await step(agent, () => transport.presence(db.projectId, presenceOf('pm', 'cm')));
    const opening = db.messages.at(-1)!;
    expect((parseCardProps('show_issue_card', opening.cards[0]!.props) as { money: unknown }).money).toBeNull();
    expect(opening.text).not.toMatch(/\$\s?\d/);

    await step(agent, () => browser.say('pm', 'Yes, prepare the fix.'));
    // The change says what happens in days and dates; what it comes to is for those who see costs, in their own browser.
    const prepared = db.messages.at(-1)!;
    expect(prepared.cards.map((card) => card.component)).toEqual(['show_plan_edit']);
    expect(JSON.stringify(prepared.cards[0]!.props)).not.toMatch(/\$\s?\d/);
    for (const message of db.messages.filter((row) => row.role === 'assistant')) expect(message.text).not.toMatch(/\$\s?\d/);
    const deltas = transport.sent.filter((event) => event.type === 'text_delta').map((event) => (event as { text: string }).text).join('');
    expect(deltas).not.toMatch(/\$\s?\d/);
    await agent.stop();
  });

  it('"Not now" snoozes the issue without a turn', async () => {
    const { db, transport, browser, agent, turns } = setup();
    await agent.start();
    await step(agent, () => transport.presence(db.projectId, presenceOf('pm', 'cm')));
    const issueId = agent.brain.gate.openIssueId!;
    await step(agent, () => browser.say('cm', 'Not now.', 'text', { kind: 'not_now', issue_id: issueId }));
    expect(turns).toHaveLength(1);
    expect(agent.brain.gate.openIssueId).toBeNull();
    await agent.stop();
  });

  it('when the reply cannot be stored, turn_end says so and names no message', async () => {
    const { db, transport, agent } = setup();
    db.messagesTableMissing = true;
    await agent.start();
    await step(agent, () => transport.presence(db.projectId, presenceOf('pm', 'cm')));
    expect(transport.sent.at(-1)).toMatchObject({ type: 'turn_end', message_id: null, error: expect.stringMatching(/could not store the reply/) });
    await agent.stop();
  });
});

describe('tool policy', () => {
  function context(speaker: boolean, mutate?: (db: FakeDb) => void): ToolContext {
    const db = new FakeDb();
    mutate?.(db);
    const plan = planFromRows(db.plan);
    return {
      plan,
      workflow: db.workflow,
      issues: new Map(),
      speaker: speaker ? plan.members[0]! : null,
      present: plan.members,
      library: db.library,
      drafts: new Map(),
      edits: new Map(),
      history: { rows: null, decisions: [] },
      watch: { rules: [], open: [] },
      refresh: async () => undefined,
    };
  }

  it('works out rental dates only from dates it can read, and finds the rental from its task', async () => {
    const ctx = context(false);
    await expect(runDataTool('rental_options', { first_day: 'next Friday' }, ctx)).rejects.toThrow(/Invalid arguments/);
    await expect(runDataTool('rental_options', { task_id: 999 }, ctx)).rejects.toBeInstanceOf(ToolRefusal);
    expect(await runDataTool('rental_options', { task_id: 15, pad_before_days: 1, pad_after_days: 1 }, ctx)).toMatchObject({ asked: { first_day: '2026-12-10', last_day: '2026-12-18' } });
  });

  it('says where each rental stands', async () => {
    expect(await runDataTool('get_payment_status', {}, context(true))).toMatchObject({ rentals: [{ task_id: 15, days: 11, cost_minor: 660000, payment: 'not paid', text: { cost: '$6,600.00' } }] });
  });

  it('reads the documents newest first with the quote cited by name', async () => {
    const result = (await runDataTool('read_documents', { kind: 'quote' }, context(true))) as { documents: { name: string; summary: string; task: { name: string } }[] };
    expect(result.documents[0]).toMatchObject({ name: expect.stringMatching(/Quotation/), task: { name: 'Erect structural steel frame' } });
  });
});
