/**
 * The plan and library tools on the seed plan: search and task lookup, the library list, snippet
 * drafts (checked, kept by id), repeating work, and plan edits (checked against the plan, refused
 * with reasons, each operation in plain words). Cards that name tasks, edits or drafts the tools did
 * not produce are rejected.
 */
import { describe, expect, it } from 'vitest';
import { groundCard } from '../src/agent/grounding';
import { runDataTool, ToolRefusal, type ToolContext } from '../src/agent/tools';
import { FakeDb } from '../src/dev/fake';
import { planFromRows } from '../src/plan/rows';

function context(): ToolContext {
  const db = new FakeDb();
  const plan = planFromRows(db.plan);
  return {
    plan,
    workflow: db.workflow,
    issues: new Map(),
    speaker: plan.members[0]!,
    present: plan.members,
    library: db.library,
    drafts: new Map(),
    edits: new Map(),
    history: { rows: null, decisions: [] },
    watch: { rules: [], open: [] },
    refresh: async () => undefined,
  };
}

const run = (ctx: ToolContext, name: string, args: unknown) => runDataTool(name as never, args, ctx) as Promise<Record<string, any>>;

describe('reading the plan', () => {
  it('finds tasks by crew and words, and reads one by name', async () => {
    const ctx = context();
    const found = await run(ctx, 'find_tasks', { crew: 'Carpentry', leaves_only: true });
    expect(found.tasks.map((task: { name: string }) => task.name)).toContain('Hang, tape & finish drywall partitions');
    const one = await run(ctx, 'get_task', { name: 'hang, tape' });
    expect(one).toMatchObject({ id: 411, name: 'Hang, tape & finish drywall partitions', crews: [expect.objectContaining({ name: 'Oakmere Interiors', trade: 'Carpentry' })] });
    expect(one.text.start).toMatch(/^[A-Z][a-z]{2}, [A-Z][a-z]{2} \d+$/);
    const many = await run(ctx, 'get_task', { name: 'footings' });
    expect(many.ambiguous).toBe(true);
    await expect(run(ctx, 'get_task', { name: 'helicopter pad' })).rejects.toThrow(ToolRefusal);
  });

  it('traces the critical path and checks the schedule', async () => {
    const ctx = context();
    const path = await run(ctx, 'get_critical_path', {});
    expect(path.finish.task_id).toBe(42);
    expect(path.tasks.length).toBeGreaterThan(5);
    const health = await run(ctx, 'check_schedule', {});
    expect(health.total).toBe(10);
  });
});

describe('the library', () => {
  it('lists the starter library with folders, sizes, crews and time ranges', async () => {
    const ctx = context();
    const all = await run(ctx, 'list_library', {});
    expect(all.count).toBe(9);
    expect(all.snippets.find((item: { id: string }) => item.id === 'xray-room')).toMatchObject({
      folder: 'Build-out › Clinical rooms',
      tasks: 8,
      time_ranges: ['X-ray room closed to other trades'],
    });
    const found = await run(ctx, 'list_library', { query: 'floor topping' });
    expect(found.snippets.map((item: { id: string }) => item.id)).toEqual(['floor-topping-and-floor']);
  });

  it('drafts a snippet, refuses a loop, and keeps the draft for a card', async () => {
    const ctx = context();
    const draft = {
      name: 'Dental operatory build-out',
      summary: 'One operatory.',
      icon: 'tooth',
      unit: { one: 'operatory', many: 'operatories' },
      children: [
        { key: 'walls', name: 'Stud walls', duration: 2, crews: [{ name: 'Carpentry' }] },
        { key: 'services', name: 'Dental chair services', duration: 1, crews: [{ name: 'Plumbing' }, { name: 'Dental technicians' }] },
      ],
      links: [{ from: 'walls', to: 'services', type: 'SS', lag: 1 }],
    };
    await expect(run(ctx, 'draft_snippet', { ...draft, icon: 'Tooth Icon' })).rejects.toThrow(/icon/);
    const made = await run(ctx, 'draft_snippet', draft);
    expect(made).toMatchObject({ draft_id: 'draft-1', tasks: 2, span_days: 2, crews: ['Carpentry', 'Plumbing', 'Dental technicians'] });
    expect(made.warnings).toEqual(['Not on this project yet: Dental technicians. Those tasks are added without that crew.']);
    await expect(run(ctx, 'draft_snippet', { ...draft, icon: 'cube', links: [...draft.links, { from: 'services', to: 'walls' }] })).rejects.toThrow(/loop/);
    expect(ctx.drafts.get('draft-1')?.snippet.name).toBe('Dental operatory build-out');
  });

  it('turns repeating or self-contained work into drafts and says when the library has it already', async () => {
    const ctx = context();
    const found = await run(ctx, 'find_repeating_work', {});
    expect(found.count).toBeGreaterThan(0);
    const pads = found.candidates.find((candidate: { name: string }) => candidate.name === 'Spread footings');
    expect(pads?.draft_id).toMatch(/^draft-\d$/);
    const draft = ctx.drafts.get(pads.draft_id)!;
    expect(draft.snippet.children.map((task) => task.name)).toContain('Pour spread footings');
    expect(draft.snippet.links.length).toBeGreaterThan(3);
    expect(draft.source_task_ids).toContain(210);
  });
});

describe('drafting every chart edit', () => {
  it('indents, outdents, copies and sets a last day, in plain words', async () => {
    const ctx = context();
    const cure = ctx.plan.tasks.find((task) => task.id === 216)!;
    const edit = await run(ctx, 'draft_plan_edit', {
      title: 'Rework the footings',
      operations: [
        { op: 'unlink', from: 211, to: 212 },
        { op: 'indent_task', task: 212 },
        { op: 'outdent_task', task: 216 },
        { op: 'duplicate_task', task: 210, ref: 'east', name: 'Spread footings, east' },
        { op: 'link', from: { id: 216 }, to: { ref: 'east' } },
        { op: 'update_task', task: 215, last_day: cure.start },
      ],
    });
    expect(edit.lines.slice(1, 4)).toEqual([
      'Indent “Excavate spread footings” into “Saw-cut yard slab for spread footings”',
      'Outdent “Cure spread footings”, out of “Spread footings”',
      'Copy “Spread footings” with the 6 tasks in it as “Spread footings, east”, right after it (it starts fresh: nothing done, spent or paid)',
    ]);
    expect(edit.lines[5]).toMatch(/^Change “Pour spread footings”: finishing [A-Z][a-z]{2}, [A-Z][a-z]{2} \d+$/);
    expect(edit.warnings).toContain('“Saw-cut yard slab for spread footings” becomes a group.');
  });

  it('refuses an indent with nothing above it, into a task it is linked to, or an outdent at the top', async () => {
    const ctx = context();
    const top = ctx.plan.tasks.find((task) => task.parentId === null)!;
    const refused = run(ctx, 'draft_plan_edit', {
      title: 'Broken',
      operations: [
        { op: 'indent_task', task: 211 },
        { op: 'indent_task', task: 212 },
        { op: 'outdent_task', task: top.id },
        { op: 'update_task', task: 216, days: 3, last_day: '2026-01-05' },
      ],
    });
    await expect(refused).rejects.toThrow(/first in its group/);
    await expect(refused).rejects.toThrow(/are linked: a group can’t wait for a task in it/);
    await expect(refused).rejects.toThrow(/already at the top level/);
    await expect(refused).rejects.toThrow(/either days or a last_day/);
  });
});

describe('drafting plan edits', () => {
  it('checks the operations and writes them in plain words', async () => {
    const ctx = context();
    const edit = await run(ctx, 'draft_plan_edit', {
      title: 'Add a moisture test before the vinyl',
      operations: [
        { op: 'add_task', ref: 'moisture', name: 'Moisture test the floor topping', parent: { id: 460 }, days: 1 },
        { op: 'link', from: { id: 322 }, to: { ref: 'moisture' } },
        { op: 'link', from: { ref: 'moisture' }, to: { id: 461 }, lag_days: 2 },
        { op: 'assign_crew', task: { ref: 'moisture' }, crew: 'general contractor' },
        { op: 'add_snippet', snippet_id: 'pad-foundation', after: 216, mode: 'fit' },
      ],
    });
    expect(edit.edit_id).toBe('edit-1');
    expect(edit.lines).toEqual([
      'Add “Moisture test the floor topping” (1 day) in “Floors, doors & millwork”',
      '“Moisture test the floor topping” starts after “Pumped floor topping” finishes',
      '“Safety vinyl flooring & cove base” starts after “Moisture test the floor topping” finishes, 2 days lag',
      'Give “Moisture test the floor topping” to Calloway Construction',
      'Add “Spread footing” from the library after “Cure spread footings” (nothing else moves)',
    ]);
    expect(ctx.edits.get('edit-1')?.operations).toHaveLength(5);
  });

  it('refuses unknown tasks and crews, duplicate links, loops and library pieces without a place', async () => {
    const ctx = context();
    const refused = run(ctx, 'draft_plan_edit', {
      title: 'Broken',
      operations: [
        { op: 'assign_crew', task: { id: 411 }, crew: 'Tilers' },
        { op: 'link', from: { id: 999999 }, to: { id: 411 } },
        { op: 'link', from: { id: 42 }, to: { id: 411 } },
        { op: 'add_snippet', snippet_id: 'nope' },
        { op: 'update_task', task: 410, days: 3 },
      ],
    });
    await expect(refused).rejects.toThrow(ToolRefusal);
    const message = await refused.catch((error: Error) => error.message);
    expect(message).toContain('There is no crew called "Tilers"');
    expect(message).toContain('There is no task 999999 in the plan.');
    expect(message).toContain('would make a loop');
    expect(message).toContain('There is no library snippet nope');
    expect(message).toContain('add_snippet needs exactly one of after, inside or before.');
    expect(message).toContain('is a group: it takes its dates from its tasks');
    expect(ctx.edits.size).toBe(0);
  });

  it('adds a firm the project does not have, gives it work and pays it, in the same edit', async () => {
    const ctx = context();
    const edit = await run(ctx, 'draft_plan_edit', {
      title: 'The tiles come from Brightline',
      operations: [
        { op: 'add_crew', name: 'Brightline Tile Supply', trade: 'Tile supply' },
        { op: 'assign_crew', task: { id: 411 }, crew: 'Brightline Tile Supply' },
        { op: 'set_cost', task: 411, payee: 'Brightline Tile Supply' },
      ],
    });
    expect(edit.lines).toEqual([
      'Add Brightline Tile Supply (Tile supply) to the project’s firms',
      expect.stringMatching(/^Give “.+” to Brightline Tile Supply$/),
      expect.stringMatching(/^Pay Brightline Tile Supply for “.+”$/),
    ]);
  });

  it('refuses a firm the project already has, and a cost change that changes nothing', async () => {
    const ctx = context();
    const refused = run(ctx, 'draft_plan_edit', {
      title: 'Broken',
      operations: [
        { op: 'add_crew', name: 'calloway construction', trade: 'General' },
        { op: 'set_cost', task: 411 },
      ],
    });
    const message = await refused.catch((error: Error) => error.message);
    expect(message).toContain('calloway construction is already on this project');
    expect(message).toContain('changes nothing: give an amount, a label or a payee');
  });
});

describe('a piece on the other floors, without the work done once for the whole building', () => {
  it('leaves tasks out, waits for one in the plan, and gives a task a new cost, in plain words without amounts', async () => {
    const ctx = context();
    const edit = await run(ctx, 'draft_plan_edit', {
      title: 'The footing on the other pads',
      operations: [
        { op: 'add_snippet', snippet_id: 'pad-foundation', after: 216, mode: 'fit', leave_out: ['Saw-cut & excavate the footing', 'inspect the subgrade (hold point)'], waits_for: 411 },
        { op: 'add_snippet', snippet_id: 'pad-foundation', after: 411, mode: 'fit', leave_out: ['Saw-cut & excavate the footing'], waits_for: 216 },
        { op: 'set_cost', task: 216, amount: 24750, label: 'Footings, three pads' },
      ],
    });
    expect(edit.lines).toEqual([
      'Add “Spread footing”, without “Saw-cut & excavate the footing” and “Inspect the subgrade (hold point)”, from the library after “Cure spread footings”, waiting for “Hang, tape & finish drywall partitions” (nothing else moves)',
      // Drywall already comes after the footings through the plan: no extra wait to speak of.
      'Add “Spread footing”, without “Saw-cut & excavate the footing”, from the library after “Hang, tape & finish drywall partitions” (nothing else moves)',
      'New cost for “Cure spread footings”: Footings, three pads',
    ]);
  });

  it('refuses leaving out a task the piece doesn’t have, leaving out all of it, and a cost on a group', async () => {
    const ctx = context();
    const unknown = run(ctx, 'draft_plan_edit', {
      title: 'Broken',
      operations: [
        { op: 'add_snippet', snippet_id: 'pad-foundation', after: 216, leave_out: ['Order the rebar'] },
        { op: 'set_cost', task: 410, amount: 100 },
      ],
    });
    const message = await unknown.catch((error: Error) => error.message);
    expect(message).toContain('“Spread footing” has no task called “Order the rebar”');
    expect(message).toContain('is a group; what it costs comes from its tasks.');
    const everything = [
      'Saw-cut & excavate the footing',
      'Inspect the subgrade (hold point)',
      'Mud slab',
      'Place rebar cage & anchor bolts',
      'Pour the footing',
      'Cure the concrete',
      'Backfill & compact around the footing',
    ];
    const nothing = run(ctx, 'draft_plan_edit', { title: 'Nothing', operations: [{ op: 'add_snippet', snippet_id: 'pad-foundation', after: 216, leave_out: everything }] });
    await expect(nothing).rejects.toThrow('would leave nothing of “Spread footing”');
  });

  it('says which of the dropped tasks buy or deliver materials, with what each costs', async () => {
    const ctx = context();
    const found = await run(ctx, 'find_similar_places', { top_ids: [216], anchor_id: null, parent_id: null });
    expect(found.dropped).toEqual([expect.objectContaining({ id: 216, name: 'Cure spread footings', buys: false, delivers: false })]);
    expect(typeof found.dropped[0].cost_dollars).toBe('number');
    expect(found.went).toEqual({ group: null, after: null });
  });

  it('says where the piece went, so one that landed among another trade’s work is not copied', async () => {
    const ctx = context();
    const cure = ctx.plan.tasks.find((task) => task.id === 216)!;
    const found = await run(ctx, 'find_similar_places', { top_ids: [216], anchor_id: 216, parent_id: cure.parentId });
    expect(found.went).toEqual({ group: ctx.plan.tasks.find((task) => task.id === cure.parentId)?.name ?? null, after: 'Cure spread footings' });
  });
});

describe('grounding the new cards', () => {
  it('only shows tasks, edits and drafts the tools produced', () => {
    const base = { issues: new Map(), checks: new Map(), knownMinor: new Set<number>(), taskIds: new Set([411, 42]), edits: new Set(['edit-1']), drafts: new Set(['draft-1']) };
    expect(groundCard('show_tasks', { title: 'Critical', task_ids: [411, 7], note: null, show_in_plan: false }, base)).toEqual(['task_ids: there is no task 7 in the plan']);
    expect(groundCard('show_plan_edit', { edit_id: 'edit-9', title: 'x', reason: 'y', selectable: false }, base)).toEqual(['edit_id edit-9 was not returned by draft_plan_edit']);
    expect(groundCard('show_snippets', { title: 'x', drafts: [{ draft_id: 'draft-1', why: 'a' }] }, base)).toEqual([]);
    expect(groundCard('show_task', { task_id: 42, note: 'It costs $5,000 more' }, base)).toEqual(['note: $5000.00 in the text is not an amount the tools computed']);
  });
});
