/**
 * The assistant and the library through the whole service (mock model, in-memory database): after a
 * library piece is dropped on one floor, the assistant offers it on the floors laid out the same way
 * as one change with one operation per floor for a person to apply, stays quiet when nothing else fits, and
 * says nothing back when a draft is dismissed. Questions about the plan come back as cards drawn from
 * the plan (tasks to show in the asker's plan, schedule findings, the workload chart).
 */
import { describe, expect, it } from 'vitest';
import { FakeBrowser, FakeDb, FakeTransport, presenceOf } from '../src/dev/fake';
import { makeClient } from '../src/llm/client';
import { silentLogger } from '../src/log';
import { ProjectAgent } from '../src/project-agent';
import type { TurnResult } from '../src/agent/brain';

function setup(withFloors: boolean) {
  const db = new FakeDb();
  if (withFloors) {
    const day = (offset: number) => new Date(Date.UTC(2027, 1, 1 + offset)).toISOString().slice(0, 19);
    const added: Record<string, unknown>[] = [];
    let id = 9000;
    for (const level of [1, 2, 3]) {
      const group = ++id;
      added.push({ id: group, name: `Level ${level} rooms`, parentId: 400, startDate: day(level * 10), endDate: day(level * 10 + 8), orderedParentIndex: 10 + level });
      ['corridor rough-in', 'exam rooms 1-4'].forEach((what, index) => {
        added.push({ id: ++id, name: `Level ${level} ${what}`, parentId: group, startDate: day(level * 10 + index * 2), endDate: day(level * 10 + index * 2 + 2), orderedParentIndex: index });
      });
    }
    added.push({ id: 9100, name: 'Accessible restroom build-out', parentId: 9001, startDate: day(12), endDate: day(21), orderedParentIndex: 1 });
    added.push({ id: 9101, name: 'Lay out fixtures & grab-bar locations', parentId: 9100, startDate: day(12), endDate: day(13) });
    db.plan.revisions = [{ revision_no: 1, changes: { tasks: { added } } }];
    db.plan.project.current_revision = 1;
  }
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
    openingDelayMs: 0,
    raiseIssues: true,
    onTurn: (result) => turns.push(result),
  });
  return { db, transport, browser, agent, turns };
}

const drop = { snippet_id: 'accessible-restroom', name: 'Accessible restroom build-out', top_ids: [9100], anchor_id: 9002, parent_id: 9001, mode: 'push' as const };

describe('the assistant after a library drop', () => {
  it('puts the piece on the floors laid out the same way, one operation each', async () => {
    const { agent, browser, transport, db, turns } = setup(true);
    await agent.start();
    transport.presence(db.projectId, presenceOf('pm'));
    await agent.idle();
    browser.say('pm', 'I added “Accessible restroom build-out” from the library after “Level 1 corridor rough-in”.', 'text', { kind: 'library_drop', detail: drop });
    await agent.idle();
    const turn = turns.at(-1)!;
    expect(turn.model).toBe('claude-opus-5-5');
    expect(turn.toolCalls.map((call) => call.name)).toEqual(['find_similar_places', 'reply', 'draft_plan_edit', 'show_plan_edit']);
    const card = turn.cards.find((candidate) => candidate.component === 'show_plan_edit')!;
    expect(card.props).toMatchObject({
      selectable: false,
      operations: [
        { op: 'add_snippet', snippet_id: 'accessible-restroom', mode: 'push', after: 9005 },
        { op: 'add_snippet', snippet_id: 'accessible-restroom', mode: 'push', after: 9008 },
      ],
      lines: [
        'Add “Accessible restroom build-out” from the library after “Level 2 corridor rough-in” (later work waits for it)',
        'Add “Accessible restroom build-out” from the library after “Level 3 corridor rough-in” (later work waits for it)',
      ],
    });
    // The stored message carries the filled-in card for every browser.
    expect(db.messages.at(-1)?.cards[0]?.props).toMatchObject({ operations: expect.any(Array) });

    // Dismissing it needs no answer.
    const before = turns.length;
    browser.say('pm', 'Not this change.', 'text', { kind: 'dismiss_edit', card_id: card.id });
    await agent.idle();
    expect(turns.length).toBe(before);
    await agent.stop();
  });

  it('stays quiet when nothing else in the plan looks like where it went', async () => {
    const { agent, browser, transport, db, turns } = setup(false);
    await agent.start();
    transport.presence(db.projectId, presenceOf('pm'));
    await agent.idle();
    browser.say('pm', 'I added “Spread footing” from the library after “Cure spread footings”.', 'text', {
      kind: 'library_drop',
      detail: { snippet_id: 'pad-foundation', name: 'Spread footing', top_ids: [216], anchor_id: 215, parent_id: 210, mode: 'fit' },
    });
    await agent.idle();
    const turn = turns.at(-1)!;
    expect(turn.quiet).toBe(true);
    expect(db.messages.filter((message) => message.role === 'assistant')).toHaveLength(0);
    await agent.stop();
  });
});

describe('questions about the plan', () => {
  it('answers with cards the browser draws from the live plan', async () => {
    const { agent, browser, transport, db, turns } = setup(false);
    await agent.start();
    transport.presence(db.projectId, presenceOf('pm'));
    await agent.idle();
    browser.say('pm', 'What sets the handover date?');
    await agent.idle();
    const tasks = turns.at(-1)!.cards.find((card) => card.component === 'show_tasks')!;
    // The crane erection (task 15) is on the chain that sets the handover.
    expect(tasks.props).toMatchObject({ show_in_plan: true, task_ids: expect.arrayContaining([15]) });
    browser.say('cm', 'Check the schedule for problems');
    await agent.idle();
    expect(turns.at(-1)!.cards.map((card) => card.component)).toEqual(['show_findings']);
    browser.say('cm', 'Who is overbooked next month?');
    await agent.idle();
    expect(turns.at(-1)!.cards.map((card) => card.component)).toEqual(['show_chart']);
    await agent.stop();
  });
});
