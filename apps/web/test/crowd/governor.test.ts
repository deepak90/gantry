import type { ProjectModel, TaskModel } from '@bryntum/gantt';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { editPlan, restorePlan, type BrainContext } from '../../src/crowd/brain';
import { ContentBook } from '../../src/crowd/content';
import { Governor, isMilestone, type GovernedChange } from '../../src/crowd/governor';
import { PERSONAS } from '../../src/crowd/personas';
import { runProjectTransaction } from '../../src/scenario/publish';
import { Random } from '../../src/crowd/random';
import { FakeClock } from '../presence/helpers';
import { seededProject, SEED } from './helpers';

const LENA = { id: PERSONAS[1]!.person.id, name: PERSONAS[1]!.person.displayName };

describe('the governor', () => {
  let project: ProjectModel;
  let clock: FakeClock;
  let governor: Governor;
  let revisions: number;
  const task = (id: number) => project.taskStore.getById(id) as TaskModel & Record<string, unknown>;
  const leaves = () => project.taskStore.leaves as TaskModel[];
  const projectEnd = () => ((project as unknown as { endDate: Date }).endDate).getTime();

  beforeEach(async () => {
    project = await seededProject();
    clock = new FakeClock();
    governor = new Governor({ clock, random: new Random(1), handoverTaskId: SEED.handover_task_id, offLimits: () => new Set([SEED.booking.task_id]) });
    revisions = 0;
    project.on({ revisionNotification: () => revisions++ });
  });
  afterEach(() => project.destroy());

  const context = (overrides: Partial<BrainContext> = {}): BrainContext => ({
    persona: PERSONAS[1]!,
    who: LENA,
    project,
    governor,
    content: new ContentBook(governor, new Random(4)),
    area: [],
    pool: [],
    busy: () => false,
    intent: null,
    random: new Random(9),
    now: clock.now(),
    ...overrides,
  });

  it('keeps out of phases, milestones, the handover and booked tasks', () => {
    const phase = (project.taskStore.rootNode.children as TaskModel[])[0]!;
    expect(governor.refusal(phase)).toBe('a phase');
    expect(governor.refusal(task(SEED.handover_task_id))).toMatch(/milestone|handover/);
    expect(governor.refusal(task(SEED.booking.task_id))).toBe('booked or being paid');
    const milestone = leaves().find((leaf) => isMilestone(leaf) && leaf.id !== SEED.handover_task_id);
    if (milestone) expect(governor.refusal(milestone)).toBe('a milestone');
    expect(leaves().filter((leaf) => !governor.refusal(leaf)).length).toBeGreaterThan(40);
  });

  it('lets through renames that keep the meaning, and plain short notes', () => {
    expect(governor.vetRename('Construction fence, gates & site signs', 'Construction fence, gates and site signs')).toBeNull();
    expect(governor.vetRename('Pour spread footings', 'Pour spread footings (hold point)')).toBeNull();
    expect(governor.vetRename('Pour spread footings', 'Order the scaffolding')).toBe('changes the meaning');
    expect(governor.vetRename('Pour spread footings', `Pour spread footings ${'and more '.repeat(10)}`)).toBe('length');
    expect(governor.vetNote('Riser inspection booked for Tuesday.')).toBeNull();
    expect(governor.vetNote('<script>alert(1)</script>')).toBe('not plain text');
    expect(governor.vetNote('x')).toBe('length');
  });

  it('moves a task only within its float, never the handover or the critical path', async () => {
    const handoverEnd = (task(SEED.handover_task_id).endDate as Date).getTime();
    const end = projectEnd();
    const floaty = leaves().filter((leaf) => !governor.refusal(leaf) && governor.room(leaf) >= 3);
    const critical = leaves().filter((leaf) => !governor.refusal(leaf) && governor.room(leaf) === 0);
    expect(floaty.length).toBeGreaterThan(3);
    // No room, no move.
    for (const leaf of critical) expect(editPlan(context(), leaf, 'move')).toBeNull();

    const target = floaty[0]!;
    const start = (target.startDate as Date).getTime();
    const plan = editPlan(context(), target, 'move')!;
    expect(plan.kind).toBe('move');
    const outcome = await governor.apply(project, plan.change, LENA);
    expect(outcome.ok).toBe(true);
    expect((target.startDate as Date).getTime()).toBeGreaterThan(start);
    expect((task(SEED.handover_task_id).endDate as Date).getTime()).toBe(handoverEnd);
    expect(projectEnd()).toBe(end);
    // It is in the ledger, due to be brought back later.
    const entry = governor.ledger.get(target.id as number, 'start')!;
    expect(entry.by).toBe(LENA.id);
    expect(entry.dueAt).toBeGreaterThan(clock.now() + 100_000);

    // Brought back: the task is where it was, and the ledger is clear.
    const back = restorePlan({ project, random: new Random(2) }, entry)!;
    expect((await governor.apply(project, back.change, LENA)).ok).toBe(true);
    expect((target.startDate as Date).getTime()).toBe(start);
    expect(governor.ledger.size).toBe(0);
  });

  it('rolls back a change that would move the handover, before anything is sent', async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const before = revisions;
    const handoverEnd = (task(SEED.handover_task_id).endDate as Date).getTime();
    const critical = leaves().find((leaf) => !governor.refusal(leaf) && governor.room(leaf) === 0 && Number(leaf.duration) > 1)!;
    const duration = Number(critical.duration);
    const push: GovernedChange = {
      title: 'Too long',
      taskId: critical.id as number,
      field: 'duration',
      movesDates: true,
      read: (record) => Number(record.duration),
      write: (record) => {
        void record.setDuration(duration + 5);
      },
    };
    const outcome = await governor.apply(project, push, LENA);
    expect(outcome).toEqual({ ok: false, reason: 'the handover would move' });
    expect(Number(critical.duration)).toBe(duration);
    expect((task(SEED.handover_task_id).endDate as Date).getTime()).toBe(handoverEnd);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(revisions).toBe(before);
    expect(governor.ledger.size).toBe(0);
    expect(governor.stats.vetoed).toBe(1);
  });

  it('refuses an edit that should not move dates when it does', async () => {
    const leaf = leaves().find((candidate) => !governor.refusal(candidate) && governor.room(candidate) >= 3)!;
    const sneaky: GovernedChange = {
      title: 'Notes (and a little more)',
      taskId: leaf.id as number,
      field: 'note',
      movesDates: false,
      read: (record) => String((record as unknown as { note?: string }).note ?? ''),
      write: (record) => {
        (record as unknown as { note: string }).note = 'Fine';
        void record.setDuration(Number(record.duration) + 1);
      },
    };
    expect(await governor.apply(project, sneaky, LENA)).toEqual({ ok: false, reason: 'the task’s dates would move' });
    expect(String((leaf as unknown as { note?: string }).note ?? '')).not.toBe('Fine');
  });

  it('keeps the drift bounded: a few displacements per person, two date changes for everyone', async () => {
    const ids = leaves()
      .filter((leaf) => !governor.refusal(leaf))
      .map((leaf) => leaf.id as number);
    for (const id of ids.slice(0, governor.perPerson)) governor.ledger.record({ taskId: id, taskName: '', field: 'note', before: '', after: 'x', by: LENA.id, byName: LENA.name });
    expect(governor.mayDisplace(LENA.id, ids[5]!, 'progress')).toBe(false);
    // Changing one already out is still fine (it is theirs).
    expect(governor.mayDisplace(LENA.id, ids[0]!, 'note')).toBe(true);
    // Nobody else touches a displacement that is not theirs.
    expect(governor.mayDisplace(PERSONAS[0]!.person.id, ids[0]!, 'note')).toBe(false);
    for (const id of ids.slice(6, 6 + governor.dateDisplacements)) governor.ledger.record({ taskId: id, taskName: '', field: 'duration', before: 2, after: 3, by: PERSONAS[2]!.person.id, byName: '' });
    expect(governor.mayDisplace(PERSONAS[3]!.person.id, ids[9]!, 'start')).toBe(false);
    // Back to where it was: the entry is gone.
    governor.ledger.record({ taskId: ids[0]!, taskName: '', field: 'note', before: 'x', after: '', by: PERSONAS[4]!.person.id, byName: '' });
    expect(governor.ledger.get(ids[0]!, 'note')).toBeUndefined();
  });

  it('swaps a crew for another of the same trade without moving the task, and puts it back', async () => {
    const leaf = leaves().find((candidate) => !governor.refusal(candidate) && ((candidate as unknown as { assignments: unknown[] }).assignments ?? []).length > 0)!;
    const assignment = (leaf as unknown as { assignments: { resource: { trade: string; kind: string; name: string; id: number } }[] }).assignments[0]!;
    const original = assignment.resource;
    // A second firm of the same trade on site.
    await runProjectTransaction(project, 'Add crew', () => {
      project.resourceStore.add({ id: 900, name: 'Second firm', trade: original.trade, kind: original.kind } as object);
    });
    const dates = [(leaf.startDate as Date).getTime(), (leaf.endDate as Date).getTime()];
    const plan = editPlan(context({ random: new Random(1) }), leaf, 'crew')!;
    expect(plan.summary).toContain('Second firm');
    expect((await governor.apply(project, plan.change, LENA)).ok).toBe(true);
    expect(assignment.resource.id).toBe(900);
    expect([(leaf.startDate as Date).getTime(), (leaf.endDate as Date).getTime()]).toEqual(dates);
    const entry = governor.ledger.get(leaf.id as number, 'crew')!;
    const back = restorePlan({ project, random: new Random(2) }, entry)!;
    expect((await governor.apply(project, back.change, LENA)).ok).toBe(true);
    expect(assignment.resource.id).toBe(original.id);
    expect(governor.ledger.size).toBe(0);
  });

  it('never makes a task miss its deadline, float or not', async () => {
    const target = leaves().find((leaf) => !governor.refusal(leaf) && governor.room(leaf) >= 3)!;
    // Somebody set a deadline on its finish day.
    await runProjectTransaction(project, 'Set deadline', () => {
      (target as unknown as { deadlineDate: Date }).deadlineDate = new Date((target.endDate as Date).getTime());
    });
    const start = (target.startDate as Date).getTime();
    const plan = editPlan(context(), target, 'move')!;
    expect(await governor.apply(project, plan.change, LENA)).toEqual({ ok: false, reason: 'a task would miss its deadline' });
    expect((target.startDate as Date).getTime()).toBe(start);
  });
});
