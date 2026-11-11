/**
 * Remy on screen: each screen tool files one `ui_action` for the person who asked, with the task, crew, month or
 * payment hold they named already found on the plan; names that fit several tasks, or nothing, come back as words
 * and nothing is sent. A short reply and a screen action that went through end the turn without a second model
 * call; one whose result needs words gets one. A request no tab picks up is withdrawn quickly.
 */
import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { UiAction, type AgentCommandRow, type UiActionOutcome } from '@collab/shared';
import { SEED_IDS } from '@collab/shared/seed';
import { AgentBrain, TOOL_DEFINITIONS } from '../src/agent/brain';
import { CommandRunner, type CommandOutcome } from '../src/agent/commands';
import { SYSTEM_PROMPT } from '../src/agent/prompts';
import { ToolRefusal } from '../src/agent/refusal';
import { crewsMatching, keyWords, runScreenTool, tasksMatching, yearOfMonth, type ScreenCommandPort } from '../src/agent/screen-tools';
import type { ToolContext } from '../src/agent/tools';
import { FakeDb } from '../src/dev/fake';
import { sseEvents, streamingResponse, type MockTurn } from '../src/llm/sse';
import type { PlanSnapshot } from '../src/plan/snapshot';
import { planFromRows } from '../src/plan/rows';

const SPEAKER = { userId: SEED_IDS.cmUser, name: 'Deepak Jayaram' };

function row(args: unknown, ui: UiActionOutcome | null): AgentCommandRow {
  return {
    id: '00000000-0000-4000-8000-0000000000c1',
    project_id: SEED_IDS.project,
    type: 'ui_action',
    args,
    required_revision: null,
    executor_session: null,
    status: 'succeeded',
    result: ui ? { ui } : { message: 'done' },
    requested_by: SEED_IDS.cmUser,
    created_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
  };
}

/** A tab that does whatever it is asked and says so; it keeps what it was asked. */
function screen(answer: (action: UiAction) => UiActionOutcome = () => ({ did: 'Done.' })) {
  const sent: { action: UiAction; to: string; options: unknown }[] = [];
  const commands: ScreenCommandPort = {
    run: async (_type, args, requestedBy, _revision, options): Promise<CommandOutcome> => {
      const action = UiAction.parse(args);
      sent.push({ action, to: requestedBy, options });
      return { status: 'succeeded', row: row(args, answer(action)) };
    },
  };
  return { commands, sent };
}

function plan(): PlanSnapshot {
  return planFromRows(new FakeDb().plan);
}

const run = (name: string, args: unknown, ctx: { plan: PlanSnapshot; commands?: ScreenCommandPort; speaker?: typeof SPEAKER | null }) =>
  runScreenTool(name as never, args, { plan: ctx.plan, speaker: ctx.speaker === undefined ? SPEAKER : ctx.speaker, library: new FakeDb().library, ...(ctx.commands ? { commands: ctx.commands } : {}) }) as Promise<Record<string, any>>;

describe('the 3D site view’s days and levels', () => {
  it('plays named days, a length from a day, or on to the end; pauses; shows a day: never the odds', async () => {
    const { commands, sent } = screen(() => ({ did: 'Playing.' }));
    await run('play_site', { do: 'play', from: '2026-11-16', to: '2026-12-04' }, { plan: plan(), commands });
    expect(sent[0]!.action).toEqual({ action: 'site_play', from: '2026-11-16', to: '2026-12-04', days: null, seconds: null });
    await run('play_site', { do: 'play', from: '2026-11-16', days: 14 }, { plan: plan(), commands });
    expect(sent[1]!.action).toMatchObject({ action: 'site_play', from: '2026-11-16', to: '2026-11-30' });
    await run('play_site', { do: 'play', days: 14 }, { plan: plan(), commands });
    expect(sent[2]!.action).toMatchObject({ action: 'site_play', from: null, to: null, days: 14 });
    await run('play_site', { do: 'play' }, { plan: plan(), commands });
    expect(sent[3]!.action).toMatchObject({ action: 'site_play', from: null, to: null, days: null });
    await run('play_site', { do: 'pause' }, { plan: plan(), commands });
    expect(sent[4]!.action).toEqual({ action: 'site_pause' });
    await run('play_site', { do: 'go_to_day', day: '2026-11-25' }, { plan: plan(), commands });
    expect(sent[5]!.action).toEqual({ action: 'site_day', date: '2026-11-25' });
    expect(sent.some((entry) => (entry.action.action as string) === 'schedule_odds')).toBe(false);
    await expect(run('play_site', { do: 'play', from: '2026-12-04', to: '2026-11-16' }, { plan: plan(), commands })).rejects.toBeInstanceOf(ToolRefusal);
  });

  it('looks into a level, or at the whole site', async () => {
    const { commands, sent } = screen();
    await run('site_view', { open: true, look: 'level', level: 'level 2' }, { plan: plan(), commands });
    expect(sent[0]!.action).toEqual({ action: 'site_level', level: 'level 2' });
    await run('site_view', { open: true, look: 'whole' }, { plan: plan(), commands });
    expect(sent[1]!.action).toEqual({ action: 'site_level', level: null });
    await expect(run('site_view', { open: true, look: 'level' }, { plan: plan(), commands })).rejects.toBeInstanceOf(ToolRefusal);
  });
});

describe('closing, the library and the chart’s days', () => {
  it('closes what is open over the page, the side panel or the odds', async () => {
    const { commands, sent } = screen(() => ({ did: 'Closed the payment review. Nothing was paid.' }));
    expect(await run('close_view', { what: 'modal' }, { plan: plan(), commands })).toMatchObject({ done: true, said_enough: true });
    expect(sent[0]!.action).toEqual({ action: 'close', what: 'modal', panel: null });
    await run('close_view', { what: 'panel' }, { plan: plan(), commands });
    expect(sent[1]!.action).toEqual({ action: 'close', what: 'panel', panel: null });
    await run('close_view', { what: 'panel', panel: 'library' }, { plan: plan(), commands });
    expect(sent[2]!.action).toEqual({ action: 'close', what: 'panel', panel: 'library' });
  });

  it('says so when what they named wasn’t open, instead of ending on “closing it”', async () => {
    const { commands } = screen(() => ({ did: 'The task library isn’t open: our conversation is. Nothing was closed.', nothing: true }));
    expect(await run('close_view', { what: 'panel', panel: 'library' }, { plan: plan(), commands })).toMatchObject({ done: true, said_enough: false, did: expect.stringContaining('isn’t open') });
  });

  it('opens a library package by its words, and asks when they fit several or none', async () => {
    const { commands, sent } = screen();
    await run('open_library_piece', { package: 'the spread footing package' }, { plan: plan(), commands });
    expect(sent[0]!.action).toEqual({ action: 'open_snippet', snippet_id: 'pad-foundation' });
    const many = await run('open_library_piece', { package: 'build-out' }, { plan: plan(), commands });
    expect(many).toMatchObject({ done: false });
    expect(many.choices).toEqual(expect.arrayContaining(['Exam room build-out', 'Accessible restroom build-out']));
    const none = await run('open_library_piece', { package: 'helicopter pad' }, { plan: plan(), commands });
    expect(none).toMatchObject({ done: false });
    expect(none.packages.length).toBeGreaterThan(0);
    expect(sent).toHaveLength(1);
  });

  it('drags a package onto a group by its words; the card it opens is the person’s to answer', async () => {
    const p = plan();
    const { commands, sent } = screen(() => ({ did: 'Carried it there; the card asks how to tie it in.' }));
    const result = await run('drag_library_piece', { package: 'spread footing', onto: 'spread footings' }, { plan: p, commands });
    expect(sent[0]!.action).toEqual({ action: 'drag_snippet', snippet_id: 'pad-foundation', task_id: p.tasks.find((task) => task.name === 'Spread footings')!.id, zone: 'after' });
    expect(result).toMatchObject({ done: true, said_enough: true });
    await expect(run('drag_library_piece', { package: 'spread footing' }, { plan: p, commands })).rejects.toBeInstanceOf(ToolRefusal);
  });

  it('scrolls the chart to a day, and points at a task’s bar', async () => {
    const p = plan();
    const { commands, sent } = screen();
    await run('zoom_plan', { to: 'day', first_day: '2026-12-03' }, { plan: p, commands });
    expect(sent[0]!.action).toEqual({ action: 'scroll_to_date', date: '2026-12-03' });
    await run('go_to_task', { name: 'footings', bar: true }, { plan: p, commands });
    expect(sent[1]!.action).toEqual({ action: 'show_bar', target: { task_id: p.tasks.find((task) => task.name === 'Spread footings')!.id } });
  });

  it('has rules that read the screen and keep the 3D view’s play apart from the odds', () => {
    expect(SYSTEM_PROMPT).toMatch(/<screen> is what was on their screen when they spoke/);
    expect(SYSTEM_PROMPT).toMatch(/"Close that", "close it", "get rid of that": what is open over the page/);
    expect(SYSTEM_PROMPT).toMatch(/None of these is the odds: schedule_odds is only for the chances of a date/);
  });
});

describe('words to the plan', () => {
  it('keeps the words that carry meaning', () => {
    expect(keyWords("the electrician's work")).toEqual(['electrician']);
    expect(keyWords('Find the punch list')).toEqual(['find', 'punch', 'list']);
  });

  it('finds tasks by their words, a number only as itself', () => {
    const p = plan();
    const drywall = tasksMatching(p, 'the drywall partitions');
    expect(drywall.map((task) => task.name)).toContain('Hang, tape & finish drywall partitions');
    const withNumber = p.tasks.find((task) => /\d/.test(task.name));
    if (withNumber) {
      const number = withNumber.name.match(/\d+/)![0];
      for (const task of tasksMatching(p, `${withNumber.name.split(/\s+/)[0]} ${number}`)) expect(task.name.match(/\d+/g)).toContain(number);
    }
  });

  it('finds crews by firm or by trade', () => {
    const p = plan();
    const carpenters = crewsMatching(p, 'the carpenters');
    expect(carpenters.map((crew) => crew.name)).toContain('Oakmere Interiors');
    expect(crewsMatching(p, 'Oakmere Interiors').map((crew) => crew.name)).toEqual(['Oakmere Interiors']);
    expect(crewsMatching(p, 'the helicopter people')).toEqual([]);
  });

  it('puts a month in the plan’s own year', () => {
    // Work from October 2026 to May 2027, read as of November 10, 2026.
    const base = plan();
    const leaf = base.tasks.find((task) => task.isLeaf)!;
    const p: PlanSnapshot = {
      ...base,
      statusDate: '2026-11-10',
      tasks: [
        { ...leaf, id: 1, start: '2026-10-05', end: '2026-12-18' },
        { ...leaf, id: 2, start: '2027-01-04', end: '2027-05-28' },
      ],
    };
    expect(yearOfMonth(p, 12)).toBe(2026);
    expect(yearOfMonth(p, 3)).toBe(2027);
    // October has work only in 2026, already past: that October is the plan's.
    expect(yearOfMonth(p, 10)).toBe(2026);
    // June has no work in either year: the next June.
    expect(yearOfMonth(p, 6)).toBe(2027);
  });
});

describe('screen tools', () => {
  it('takes them to a task by name, outline number or row, in their own tab', async () => {
    const p = plan();
    const { commands, sent } = screen((action) => ({ did: `Showing it (${action.action}).` }));
    const drywall = p.tasks.find((task) => task.name === 'Hang, tape & finish drywall partitions')!;
    expect(await run('go_to_task', { name: 'hang, tape & finish drywall partitions' }, { plan: p, commands })).toMatchObject({ done: true, said_enough: true });
    expect(sent[0]).toMatchObject({ action: { action: 'go_to_task', target: { task_id: drywall.id } }, to: SEED_IDS.cmUser, options: { claimTimeoutMs: 6_000, timeoutMs: 30_000 } });
    await run('go_to_task', { wbs: drywall.wbs }, { plan: p, commands });
    expect(sent[1]!.action).toEqual({ action: 'go_to_task', target: { task_id: drywall.id } });
    await run('go_to_task', { row: 12 }, { plan: p, commands });
    expect(sent[2]!.action).toEqual({ action: 'go_to_task', target: { row: 12 } });
  });

  it('opens the task’s editor, or one cell and its editor', async () => {
    const p = plan();
    const { commands, sent } = screen();
    await run('go_to_task', { name: 'hang, tape', open: 'task_editor' }, { plan: p, commands });
    expect(sent[0]!.action.action).toBe('open_editor');
    await run('go_to_task', { name: 'hang, tape', column: 'start', open: 'cell_editor' }, { plan: p, commands });
    expect(sent[1]!.action).toMatchObject({ action: 'focus_cell', column: 'start', edit: true });
    await run('go_to_task', { name: 'hang, tape', column: 'days' }, { plan: p, commands });
    expect(sent[2]!.action).toMatchObject({ action: 'focus_cell', column: 'days', edit: false });
    await expect(run('go_to_task', { name: 'hang, tape', open: 'cell_editor' }, { plan: p, commands })).rejects.toBeInstanceOf(ToolRefusal);
  });

  it('takes a group over the tasks in it that share its name', async () => {
    const p = plan();
    const { commands, sent } = screen();
    await run('go_to_task', { name: 'footings' }, { plan: p, commands });
    expect(sent[0]!.action).toEqual({ action: 'go_to_task', target: { task_id: p.tasks.find((task) => task.name === 'Spread footings')!.id } });
  });

  it('takes the one task whose name starts with their words when several fit', async () => {
    const base = plan();
    const leaf = base.tasks.find((task) => task.isLeaf)!;
    const p: PlanSnapshot = {
      ...base,
      tasks: [
        { ...leaf, id: 1, parentId: null, isLeaf: false, name: 'Structure' },
        { ...leaf, id: 2, parentId: 1, isLeaf: true, name: 'Concrete deck, level 2' },
        { ...leaf, id: 3, parentId: null, isLeaf: false, name: 'Level 2 build-out' },
      ],
    };
    const { commands, sent } = screen();
    await run('expand_plan', { open: true, name: 'level 2' }, { plan: p, commands });
    expect(sent[0]!.action).toEqual({ action: 'expand', open: true, task_id: 3 });
  });

  it('asks which task when a name fits several, and says so when it fits none, sending nothing', async () => {
    const p = plan();
    const { commands, sent } = screen();
    const many = await run('go_to_task', { name: 'the pour' }, { plan: p, commands });
    expect(many).toMatchObject({ done: false, said_enough: false });
    expect(many.choices.map((choice: { name: string }) => choice.name)).toEqual(['Pour spread footings', 'Pour slab-on-grade infill']);
    const none = await run('go_to_task', { name: 'helicopter pad' }, { plan: p, commands });
    expect(none).toMatchObject({ done: false, did: expect.stringMatching(/No task/) });
    expect(await run('go_to_task', { wbs: '99.99' }, { plan: p, commands })).toMatchObject({ done: false });
    expect(sent).toHaveLength(0);
    await expect(run('go_to_task', { task_id: 999_999 }, { plan: p, commands })).rejects.toBeInstanceOf(ToolRefusal);
  });

  it('filters to a crew by its trade, naming it on the chip, and clears', async () => {
    const p = plan();
    const { commands, sent } = screen(() => ({ did: 'Showing 9 tasks.', matches: 9 }));
    const result = await run('filter_plan', { crew: 'the carpenters', from: '2026-01-01' }, { plan: p, commands });
    expect(result).toMatchObject({ done: true, said_enough: true });
    const carpenters = crewsMatching(p, 'carpentry').map((crew) => crew.id);
    expect(sent[0]!.action).toMatchObject({ action: 'filter', clear: false, crew_ids: carpenters, from: '2026-01-01' });
    await run('filter_plan', { clear: true }, { plan: p, commands });
    expect(sent[1]!.action).toEqual({ action: 'filter', clear: true });
    const nobody = await run('filter_plan', { crew: 'helicopter pilots' }, { plan: p, commands });
    expect(nobody).toMatchObject({ done: false });
    expect(nobody.crews.length).toBeGreaterThan(0);
    expect(sent).toHaveLength(2);
  });

  it('a filter that shows nothing needs words', async () => {
    const { commands } = screen(() => ({ did: 'Nothing fits.', matches: 0 }));
    expect(await run('filter_plan', { text: 'zzz' }, { plan: plan(), commands })).toMatchObject({ done: true, said_enough: false });
  });

  it('searches with the matches found on the plan, in outline order, and steps', async () => {
    const p = plan();
    const { commands, sent } = screen(() => ({ did: 'Found 2; showing the first.', matches: 2, at: 1 }));
    const result = await run('search_plan', { text: 'pour' }, { plan: p, commands });
    expect(result).toMatchObject({ done: true, said_enough: false, matches: 2, at: 1 });
    const ids = tasksMatching(p, 'pour').map((task) => task.id);
    expect(ids).toHaveLength(2);
    expect(sent[0]!.action).toMatchObject({ action: 'search', text: 'pour', task_ids: ids, step: 'first' });
    await run('search_plan', { step: 'next' }, { plan: p, commands });
    expect(sent[1]!.action).toEqual({ action: 'search', step: 'next' });
    expect(await run('search_plan', { text: 'helicopter pad' }, { plan: p, commands })).toMatchObject({ done: false });
    expect(sent).toHaveLength(2);
  });

  it('zooms to a month in the plan’s year, to dates, or to fit', async () => {
    const p = plan();
    const { commands, sent } = screen();
    await run('zoom_plan', { to: 'month', month: 2 }, { plan: p, commands });
    const year = yearOfMonth(p, 2);
    expect(sent[0]!.action).toEqual({ action: 'zoom', how: 'dates', first_day: `${year}-02-01`, last_day: `${year}-02-${year % 4 === 0 ? 29 : 28}` });
    await run('zoom_plan', { to: 'fit' }, { plan: p, commands });
    expect(sent[1]!.action).toEqual({ action: 'zoom', how: 'fit' });
    await expect(run('zoom_plan', { to: 'dates', first_day: '2026-05-02', last_day: '2026-05-01' }, { plan: p, commands })).rejects.toBeInstanceOf(ToolRefusal);
  });

  it('opens and closes the site view, the crane opening it first', async () => {
    const { commands, sent } = screen();
    await run('site_view', { open: false, look: 'crane' }, { plan: plan(), commands });
    expect(sent[0]!.action).toEqual({ action: 'site_view', open: true, look: 'crane' });
    await run('site_view', { open: false }, { plan: plan(), commands });
    expect(sent[1]!.action).toEqual({ action: 'site_view', open: false });
  });

  it('opens one group or all of them, never a task', async () => {
    const p = plan();
    const { commands, sent } = screen();
    await run('expand_plan', { open: false }, { plan: p, commands });
    expect(sent[0]!.action).toEqual({ action: 'expand', open: false });
    const group = p.tasks.find((task) => !task.isLeaf)!;
    await run('expand_plan', { open: true, task_id: group.id }, { plan: p, commands });
    expect(sent[1]!.action).toEqual({ action: 'expand', open: true, task_id: group.id });
    const leaf = p.tasks.find((task) => task.isLeaf)!;
    expect(await run('expand_plan', { open: true, task_id: leaf.id }, { plan: p, commands })).toMatchObject({ done: false });
    expect(sent).toHaveLength(2);
  });

  it('brings a payment hold up by the work it pays for, and the invoice, for review only', async () => {
    const p = plan();
    const footings = p.tasks.find((task) => /footing/i.test(task.name) && task.isLeaf)!;
    const gate = { ...p.tasks.find((task) => task.isLeaf && task.id !== footings.id)!, id: 9_001, name: 'Footings paid', isMilestone: true };
    gate.payGate = { pays: [footings.id], retainage: 0.1, state: 'waiting', batchId: null, paidAt: null, amountMinor: null };
    const held = { ...p, tasks: [...p.tasks, gate] };
    const { commands, sent } = screen();
    const result = await run('open_review', { of: 'payment', about: footings.name }, { plan: held, commands });
    expect(sent[0]!.action).toEqual({ action: 'open_payment', task_id: 9_001 });
    expect(result.hold).toMatchObject({ id: 9_001, state: 'waiting' });
    await run('open_review', { of: 'invoice' }, { plan: held, commands });
    expect(sent[1]!.action).toEqual({ action: 'open_invoice' });
    expect(await run('open_review', { of: 'payment' }, { plan: plan(), commands })).toMatchObject({ done: false, did: expect.stringMatching(/No work/) });
  });

  it('undoes and redoes with their own buttons, a step at a time unless they say', async () => {
    const { commands, sent } = screen(() => ({ did: 'Undid Rename task.' }));
    expect(await run('undo_redo', { direction: 'undo' }, { plan: plan(), commands })).toMatchObject({ done: true, did: 'Undid Rename task.' });
    expect(sent[0]!.action).toEqual({ action: 'history', direction: 'undo', steps: 1 });
  });

  it('needs the person who asked and their screen; a screen that never answers is said plainly', async () => {
    await expect(run('open_panel', { panel: 'library' }, { plan: plan(), speaker: null, commands: screen().commands })).rejects.toBeInstanceOf(ToolRefusal);
    await expect(run('open_panel', { panel: 'library' }, { plan: plan() })).rejects.toBeInstanceOf(ToolRefusal);
    await expect(run('open_panel', { panel: 'the moon' }, { plan: plan(), commands: screen().commands })).rejects.toBeInstanceOf(ToolRefusal);
    const away: ScreenCommandPort = { run: async () => ({ status: 'timeout', message: 'Their screen didn’t pick the request up.' }) };
    expect(await run('open_panel', { panel: 'library' }, { plan: plan(), commands: away })).toEqual({ done: false, said_enough: false, did: 'Their screen didn’t pick the request up.' });
  });

  it('are Remy’s tools, with rules that say to reply first and press things herself', () => {
    for (const name of ['site_view', 'go_to_task', 'filter_plan', 'search_plan', 'expand_plan', 'zoom_plan', 'open_panel', 'open_review', 'undo_redo']) {
      expect(TOOL_DEFINITIONS.some((tool) => tool.name === name)).toBe(true);
    }
    expect(SYSTEM_PROMPT).toMatch(/You have your own cursor on the screen of the person who asked/);
    expect(SYSTEM_PROMPT).toMatch(/"Zoom to June": zoom_plan month 6/);
    expect(SYSTEM_PROMPT).not.toMatch(/In writing, say Undo in the toolbar/);
  });
});

describe('a screen action no tab picks up', () => {
  it('is withdrawn at the claim deadline; one a tab took is waited for', async () => {
    const db = new FakeDb();
    let clock = 0;
    const sleep = async (ms: number) => {
      clock += ms;
    };
    const runner = new CommandRunner(db, db.projectId, { pollMs: 500, now: () => clock, sleep });
    const lost = await runner.run('ui_action', { action: 'open_invoice' }, SEED_IDS.cmUser, null, { timeoutMs: 30_000, claimTimeoutMs: 6_000 });
    expect(lost.status).toBe('timeout');
    expect(clock).toBeGreaterThanOrEqual(6_000);
    expect(clock).toBeLessThan(8_000);
    expect(db.commands[0]!.status).toBe('cancelled');

    clock = 0;
    db.onCommandInserted = (row) => {
      row.status = 'running';
    };
    const slow = new CommandRunner(db, db.projectId, {
      pollMs: 500,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
        const row = db.commands.at(-1)!;
        if (clock >= 9_000) {
          row.status = 'succeeded';
          row.result = { ui: { did: 'Opened the site view.' } };
        }
      },
    });
    const done = await slow.run('ui_action', { action: 'site_view', open: true }, SEED_IDS.cmUser, null, { timeoutMs: 30_000, claimTimeoutMs: 6_000 });
    expect(done.status).toBe('succeeded');
  });
});

/** Claude, scripted: answers each request with the next turn; counts the requests. */
function scripted(turns: MockTurn[]) {
  let calls = 0;
  const respond = async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { model: string };
    const turn = turns[Math.min(calls, turns.length - 1)]!;
    calls += 1;
    return streamingResponse(sseEvents(turn, body.model, `msg_${calls}`), 0);
  };
  return { client: new Anthropic({ apiKey: 'no-network', fetch: respond as unknown as typeof fetch, maxRetries: 0 }), calls: () => calls };
}

function brainWith(turns: MockTurn[], answer: (action: UiAction) => UiActionOutcome) {
  const db = new FakeDb();
  const p = planFromRows(db.plan);
  const { commands, sent } = screen(answer);
  const ctx: ToolContext = {
    plan: p,
    workflow: db.workflow,
    issues: new Map(),
    speaker: null,
    present: p.members,
    library: db.library,
    drafts: new Map(),
    edits: new Map(),
    history: { rows: null, decisions: [] },
    watch: { rules: [], open: [] },
    refresh: async () => undefined,
    commands: commands as ToolContext['commands'],
  };
  const model = scripted(turns);
  const brain = new AgentBrain({ client: model.client, ctx, models: { analysis: 'claude-sonnet-5-5', chat: 'claude-sonnet-5-5' } });
  return { brain, model, sent, speaker: p.members.find((member) => member.userId === SEED_IDS.cmUser) ?? p.members[0]! };
}

describe('a turn that shows something', () => {
  it('ends after "Opening the site view." and the site view opening: no second model call', async () => {
    const { brain, model, sent, speaker } = brainWith(
      [
        {
          blocks: [
            { type: 'tool_use', id: 'toolu_1', name: 'reply', input: { text: 'Opening the site view.' } },
            { type: 'tool_use', id: 'toolu_2', name: 'site_view', input: { open: true } },
          ],
          stop_reason: 'tool_use',
        },
      ],
      () => ({ did: 'Opened the site view.' }),
    );
    const result = await brain.handleUtterance('Take me to the site view', speaker);
    expect(result.say).toBe('Opening the site view.');
    expect(sent.map((entry) => entry.action)).toEqual([{ action: 'site_view', open: true }]);
    expect(model.calls()).toBe(1);
  });

  it('goes on when the result needs words: a search says how many it found', async () => {
    const { brain, model, speaker } = brainWith(
      [
        {
          blocks: [
            { type: 'tool_use', id: 'toolu_1', name: 'reply', input: { text: 'Looking for the footings.' } },
            { type: 'tool_use', id: 'toolu_2', name: 'search_plan', input: { text: 'footings' } },
          ],
          stop_reason: 'tool_use',
        },
        { blocks: [{ type: 'tool_use', id: 'toolu_3', name: 'reply', input: { text: 'Found two; here’s the first.' } }], stop_reason: 'tool_use' },
      ],
      () => ({ did: 'Found 2; showing the first.', matches: 2, at: 1 }),
    );
    const result = await brain.handleUtterance('Find the footings', speaker);
    expect(model.calls()).toBe(2);
    expect(result.say).toBe('Looking for the footings. Found two; here’s the first.');
  });
});
