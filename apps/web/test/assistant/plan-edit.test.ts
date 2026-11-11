/**
 * Applying a plan edit the assistant drafted: the operations land as one change for everyone (one
 * revision; both clients agree), new tasks named by ref can be linked and given crews in the same
 * edit, a library piece can be dropped by an operation, and an edit that no longer fits the live plan
 * changes nothing. The preview tries the edit on a copy and says what moves, leaving the plan alone.
 */
import type { AssignmentModel, ResourceModel, TaskModel } from '@bryntum/gantt';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanEditOp, Snippet } from '@collab/shared';
import { starterSnippet } from '@collab/shared/library-starter';
import { PlanEditError, applyPlanEdit, previewPlanEdit, tasksTouched } from '../../src/assistant/plan-edit';
import { setPaymentLocks } from '../../src/gantt/payment-lock';
import { Session, projection } from '../library/harness';

let session: Session;
let warnings: string[];

beforeEach(() => {
  session = new Session();
  warnings = [];
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  });
});

afterEach(() => {
  session.dispose();
  vi.restoreAllMocks();
});

const library = (id: string): Snippet | undefined => {
  const found = starterSnippet(id);
  if (!found) return undefined;
  const { starterKey, ...draft } = found;
  return { id: starterKey, ...draft };
};

const MOISTURE: PlanEditOp[] = [
  { op: 'add_task', ref: 'moisture', name: 'Moisture test the floor topping', parent: { id: 460 }, days: 1 },
  { op: 'link', from: { id: 322 }, to: { ref: 'moisture' }, type: 'FS', lag_days: 0 },
  { op: 'link', from: { ref: 'moisture' }, to: { id: 461 }, type: 'FS', lag_days: 2 },
  { op: 'assign_crew', task: { ref: 'moisture' }, crew: 'general contractor', units: 50 },
  { op: 'update_task', task: 216, days: 9, note: 'Cold weather: two extra days' },
];

describe('applying a drafted edit', () => {
  it('adds, links, staffs and changes tasks in one revision that every client agrees on', async () => {
    const { A, B } = await session.start();
    const before = session.relay.revisionCount;
    await applyPlanEdit(A.project, 'Add a moisture test before the vinyl', MOISTURE, library);
    const view = await session.converge(warnings);
    expect(session.relay.revisionCount - before).toBe(1);
    const moisture = view.tasks.find((task) => task.name === 'Moisture test the floor topping')!;
    expect(moisture).toMatchObject({ parentId: 460, duration: 1 });
    expect(view.dependencies.filter((link) => link.to === moisture.id)).toEqual([expect.objectContaining({ from: 322, type: 2, lag: 0 })]);
    expect(view.dependencies.filter((link) => link.from === moisture.id)).toEqual([expect.objectContaining({ to: 461, lag: 2 })]);
    expect(view.assignments.filter((assignment) => assignment.event === moisture.id).map((assignment) => assignment.units)).toEqual([50]);
    expect(view.tasks.find((task) => task.id === 216)).toMatchObject({ duration: 9 });
    expect((B.project.taskStore.getById(216) as TaskModel).note).toBe('Cold weather: two extra days');
  });

  it('leaves a new task to its links even with its row on screen, and pins one with no links', async () => {
    const { A } = await session.start();
    // What a drawn row does to its task as it goes in: see test/library/insert-sync.test.ts.
    const stop = A.project.taskStore.on({ add: ({ records }: { records: TaskModel[] }) => records.forEach((task) => task.set({ constraintDate: task.startDate, constraintType: 'startnoearlierthan' })) }) as unknown as () => void;
    const alone: PlanEditOp = { op: 'add_task', ref: 'walk', name: 'Walk the floor with the tenant', parent: { id: 460 }, days: 1 };
    await applyPlanEdit(A.project, 'Add a moisture test and a walk', [...MOISTURE, alone], library);
    stop();
    const view = await session.converge(warnings);
    expect(view.tasks.find((task) => task.name === 'Moisture test the floor topping')).toMatchObject({ constraintType: null, constraintDate: null });
    expect(view.tasks.find((task) => task.name === 'Walk the floor with the tenant')).toMatchObject({ constraintType: 'startnoearlierthan' });
  });

  it('drops a library piece by operation, and changes nothing when the edit no longer fits', async () => {
    const { A } = await session.start();
    await applyPlanEdit(A.project, 'Add a pad', [{ op: 'add_snippet', snippet_id: 'pad-foundation', after: 216, mode: 'fit', repeats: 2 }], library);
    let view = await session.converge(warnings);
    expect(view.tasks.filter((task) => task.name.startsWith('Spread footing – pad')).map((task) => task.name)).toEqual(['Spread footing – pad 1', 'Spread footing – pad 2']);

    const count = session.relay.revisionCount;
    const broken: PlanEditOp[] = [
      { op: 'update_task', task: 411, name: 'Renamed' },
      { op: 'link', from: { id: 999999 }, to: { id: 411 }, type: 'FS', lag_days: 0 },
    ];
    await expect(applyPlanEdit(A.project, 'Broken', broken, library)).rejects.toThrow(PlanEditError);
    view = await session.converge(warnings);
    expect(session.relay.revisionCount).toBe(count);
    expect(view.tasks.find((task) => task.id === 411)?.name).toBe('Hang, tape & finish drywall partitions');
  });
});

describe('a piece on the other floors, without the work done once for the whole building', () => {
  // A lighting package with an order, a delivery, an install and a test, and what each costs.
  const LIGHTS: Snippet = {
    id: 'lights',
    name: 'Light fixtures package',
    summary: 'Order, deliver, install and test light fixtures.',
    icon: 'lightbulb',
    unit: 'floor',
    children: [
      { key: 'order', name: 'Order light fixtures', duration: 1, costs: [{ label: 'Light fixtures', payee: 'Lumen & Co Lighting', amount: 8250, due: 'on_order' }] },
      { key: 'deliver', name: 'Deliver light fixtures', duration: 1 },
      { key: 'install', name: 'Install light fixtures', duration: 4, crews: [{ name: 'General contractor' }], costs: [{ label: 'Install labor', payee: 'Calloway Construction', amount: 6000, due: 'on_completion' }] },
      { key: 'test', name: 'Test light fixtures', duration: 1, crews: [{ name: 'General contractor' }] },
    ],
    links: [
      { from: 'order', to: 'deliver' },
      { from: 'deliver', to: 'install' },
      { from: 'install', to: 'test' },
    ],
  } as unknown as Snippet;
  const lights = (id: string) => (id === 'lights' ? LIGHTS : library(id));

  it('adds just the install and testing, waiting for the one delivery, and the one order buys for both places', async () => {
    const { A } = await session.start();
    await applyPlanEdit(A.project, 'Lights on the first floor', [{ op: 'add_snippet', snippet_id: 'lights', after: 216, mode: 'push', repeats: 1 }], lights);
    let view = await session.converge(warnings);
    const named = (name: string) => view.tasks.filter((task) => task.name === name).map((task) => task.id as number);
    const [order] = named('Order light fixtures');
    const [deliver] = named('Deliver light fixtures');

    await applyPlanEdit(
      A.project,
      'Lights on the second floor',
      [
        { op: 'add_snippet', snippet_id: 'lights', after: 411, mode: 'push', repeats: 1, leave_out: ['Order light fixtures', 'deliver light fixtures'], waits_for: deliver! },
        { op: 'set_cost', task: order!, amount: 16500, label: 'Light fixtures, both floors' },
      ],
      lights,
    );
    view = await session.converge(warnings);
    expect(named('Order light fixtures')).toHaveLength(1);
    expect(named('Deliver light fixtures')).toHaveLength(1);
    const installs = named('Install light fixtures');
    expect(installs).toHaveLength(2);
    expect(named('Test light fixtures')).toHaveLength(2);
    // The second place already comes after the delivery through the plan: no extra link, no long arrow.
    expect(view.dependencies.some((link) => link.from === deliver && link.to === installs[1])).toBe(false);
    const bought = A.project.taskStore.getById(order!) as TaskModel & { costLines: { label: string; amount_minor: number }[]; budgetMinor: number; forecastMinor: number };
    expect(bought.costLines).toEqual([expect.objectContaining({ label: 'Light fixtures, both floors', amount_minor: 1_650_000, payee: 'Lumen & Co Lighting' })]);
    expect([bought.budgetMinor, bought.forecastMinor]).toEqual([1_650_000, 1_650_000]);
  });

  it('adds a firm, gives it the order and pays it, keeping the amount, as one change for everyone', async () => {
    const { A } = await session.start();
    await applyPlanEdit(A.project, 'Lights on the first floor', [{ op: 'add_snippet', snippet_id: 'lights', after: 216, mode: 'push', repeats: 1 }], lights);
    await session.converge(warnings);
    const order = (A.project.taskStore.allRecords as TaskModel[]).find((task) => task.name === 'Order light fixtures')!;

    await applyPlanEdit(
      A.project,
      'The fixtures come from Brightline',
      [
        { op: 'add_crew', name: 'Brightline Fixtures', trade: 'Lighting supply' },
        { op: 'assign_crew', task: { id: order.id as number }, crew: 'Brightline Fixtures', units: 100 },
        { op: 'set_cost', task: order.id as number, payee: 'Brightline Fixtures' },
      ],
      lights,
    );
    await session.converge(warnings);
    const firm = (A.project.resourceStore.allRecords as (ResourceModel & { trade?: string; kind?: string })[]).find((resource) => resource.name === 'Brightline Fixtures');
    expect(firm).toMatchObject({ trade: 'Lighting supply', kind: 'labor' });
    expect((A.project.assignmentStore.allRecords as AssignmentModel[]).some((assignment) => assignment.event === order && assignment.resource === firm)).toBe(true);
    const bought = order as TaskModel & { costLines: { payee: string; amount_minor: number }[] };
    expect(bought.costLines).toEqual([expect.objectContaining({ payee: 'Brightline Fixtures', amount_minor: 825_000 })]);

    // A second time, the firm is already there: nothing changes.
    await expect(applyPlanEdit(A.project, 'Again', [{ op: 'add_crew', name: 'brightline fixtures', trade: 'Lighting supply' }], lights)).rejects.toThrow('already on this project');
  });

  it('won’t change a cost a task doesn’t have, or one already paid', async () => {
    const { A } = await session.start();
    await expect(applyPlanEdit(A.project, 'No cost here', [{ op: 'set_cost', task: 216, amount: 100 }], lights)).rejects.toThrow('no cost to change');
  });
});

describe('every chart edit, drafted', () => {
  it('indents a task into the group above it and outdents one out of its group, as one change for everyone', async () => {
    const { A } = await session.start();
    const level = (A.project.taskStore.getById(210) as unknown as { parent: { orderedChildren: TaskModel[] } }).parent.orderedChildren;
    const next = level[level.findIndex((child) => child.id === 210) + 1]!;
    let before = session.relay.revisionCount;
    await applyPlanEdit(A.project, 'Indent', [{ op: 'indent_task', task: next.id as number }], library);
    await session.converge(warnings);
    expect(session.relay.revisionCount - before).toBe(1);
    before = session.relay.revisionCount;
    await applyPlanEdit(A.project, 'Outdent', [{ op: 'outdent_task', task: 216 }], library);
    const view = await session.converge(warnings);
    expect(session.relay.revisionCount - before).toBe(1);
    // In at the end of "Spread footings"; "Cure spread footings" out of it, to just after it.
    const group = view.tasks.find((task) => task.id === 210)!;
    expect(group.children.at(-1)).toBe(next.id);
    const cure = view.tasks.find((task) => task.id === 216)!;
    expect(cure.parentId).toBe(group.parentId);
    expect(cure.orderedParentIndex).toBe(group.orderedParentIndex + 1);
    expect(group.children).not.toContain(216);
  });

  it('indents a task into the task above it, which becomes a group; not one it is linked to', async () => {
    const { A } = await session.start();
    // "Excavate spread footings" waits for the saw-cut above it: a group can't wait for a task inside it.
    await expect(applyPlanEdit(A.project, 'Indent', [{ op: 'indent_task', task: 212 }], library)).rejects.toThrow('are linked');
    // With the link taken off in the same change, it goes in.
    await applyPlanEdit(A.project, 'Indent', [{ op: 'unlink', from: 211, to: 212 }, { op: 'indent_task', task: 212 }], library);
    await session.settle();
    const view = projection(A.project);
    expect(view.tasks.find((task) => task.id === 212)).toMatchObject({ parentId: 211, wbs: '2.2.1.1' });
    expect(view.tasks.find((task) => task.id === 213)).toMatchObject({ parentId: 210, wbs: '2.2.2' });
    // Everyone's plan has it there too.
    const theirs = projection(session.peers[1]!.project);
    expect(theirs.tasks.find((task) => task.id === 212)).toMatchObject({ parentId: 211 });
  });

  it('won’t indent the first task of a group, or outdent one at the top', async () => {
    const { A } = await session.start();
    await expect(applyPlanEdit(A.project, 'Indent', [{ op: 'indent_task', task: 211 }], library)).rejects.toThrow('first in its group');
    const top = (A.project.taskStore.rootNode.children as TaskModel[])[0]!;
    await expect(applyPlanEdit(A.project, 'Outdent', [{ op: 'outdent_task', task: top.id as number }], library)).rejects.toThrow('already at the top level');
  });

  it('copies a group with its tasks, links and crews just after it, starting fresh', async () => {
    const { A } = await session.start();
    const original = projection(A.project);
    await applyPlanEdit(A.project, 'Copy the footings', [{ op: 'duplicate_task', task: 210, ref: 'east', name: 'Spread footings, east' }], library);
    const view = await session.converge(warnings);
    const copy = view.tasks.find((task) => task.name === 'Spread footings, east')!;
    const group = view.tasks.find((task) => task.id === 210)!;
    expect(copy.parentId).toBe(group.parentId);
    expect(copy.orderedParentIndex).toBe(group.orderedParentIndex + 1);
    expect(copy.children).toHaveLength(group.children.length);
    const inside = view.tasks.filter((task) => task.parentId === copy.id);
    expect(inside.map((task) => task.name)).toEqual(group.children.map((id) => original.tasks.find((task) => task.id === id)!.name));
    expect(inside.every((task) => task.percentDone === 0)).toBe(true);
    const ids = new Set(inside.map((task) => task.id));
    expect(view.dependencies.filter((link) => ids.has(link.from as number) && ids.has(link.to as number)).length).toBe(
      original.dependencies.filter((link) => group.children.includes(link.from as number) && group.children.includes(link.to as number)).length,
    );
  });

  it('lengthens a task to the last day asked for, its working days following', async () => {
    const { A } = await session.start();
    const cure = A.project.taskStore.getById(216) as TaskModel;
    const days = cure.duration as number;
    const last = new Date((cure.endDate as Date).getTime());
    // The same weekday a week on: five working days more.
    last.setDate(last.getDate() + 6);
    const iso = `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, '0')}-${String(last.getDate()).padStart(2, '0')}`;
    await applyPlanEdit(A.project, 'Cure longer', [{ op: 'update_task', task: 216, last_day: iso }], library);
    const view = await session.converge(warnings);
    expect(view.tasks.find((task) => task.id === 216)!.duration).toBe(days + 5);
  });

  it('knows which tasks a change touches, a deleted one by the group it was in', async () => {
    const { A } = await session.start();
    expect(
      tasksTouched(A.project, [
        { op: 'update_task', task: 216, name: 'Cure' },
        { op: 'delete_task', task: 212 },
        { op: 'link', from: { id: 215 }, to: { id: 216 }, type: 'FS', lag_days: 0 },
        { op: 'add_task', ref: 'new', name: 'New', days: 1 },
      ]),
    ).toEqual([216, 210]);
  });
});

describe('previewing a drafted edit', () => {
  it('says how the handover moves and which tasks move, without touching the plan', async () => {
    const { A } = await session.start();
    const before = projection(A.project);
    const preview = await previewPlanEdit(A.project, [{ op: 'update_task', task: 242, days: 6 }], library);
    expect(preview.error).toBeNull();
    expect(preview.handoverAfter!.getTime()).toBeGreaterThan(preview.handoverBefore!.getTime());
    expect(preview.moved.length).toBeGreaterThan(10);
    expect(preview.moved.some((task) => task.id === 42)).toBe(true);
    expect(projection(A.project)).toEqual(before);

    const calm = await previewPlanEdit(A.project, MOISTURE.slice(0, 2), library);
    expect(calm).toMatchObject({ error: null, added: 1, removed: 0 });
    const failing = await previewPlanEdit(A.project, [{ op: 'delete_task', task: 999999 }], library);
    expect(failing.error).toBe('Task 999999 is no longer in the plan.');
  });
});

describe('an edit that would move a task PayPal is paying for', () => {
  it('cannot be applied, says which task, and changes nothing', async () => {
    const { A } = await session.start();
    const paid = (await previewPlanEdit(A.project, MOISTURE, library)).moved[0]!;
    setPaymentLocks(A.project, [paid.id]);
    const preview = await previewPlanEdit(A.project, MOISTURE, library);
    expect(preview.error).toContain(paid.name);
    expect(preview.error).toContain('PayPal');
    const plan = projection(A.project);
    await expect(applyPlanEdit(A.project, 'Add a moisture test', MOISTURE, library)).rejects.toThrow(PlanEditError);
    expect(projection(A.project)).toEqual(plan);
  });
});
