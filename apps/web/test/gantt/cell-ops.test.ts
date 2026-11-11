/**
 * The fill handle and Delete on every column, the collapsed ones included, on the real scheduling
 * engine: a Schedule cell fills its start, length and progress (copied from one cell, continued as a
 * series from several, backwards when dragged up), a money cell fills both its amounts, links still
 * win over a filled start, and clearing takes back what was entered. Each fill or clear is one revision.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectModel, TaskModel } from '@bryntum/gantt';
import type { ProjectInlineData } from '@collab/shared';
import { clearCells, describeCellOp, fillCells, fillSeries, isCollapsedColumn, type CellRef } from '../../src/gantt/cell-ops';
import { createProjectModel, loadCollaborativeProject } from '../../src/gantt/project';

/**
 * Mon–Fri, 24-hour days like the seed; Monday, November 2, 2026 is day one. Tasks that do not start
 * at the project start are pinned there with a constraint, as in a real plan.
 */
const DATA: ProjectInlineData = {
  project: { calendar: 'standard', startDate: '2026-11-02', hoursPerDay: 24, daysPerWeek: 5, daysPerMonth: 20 },
  calendarsData: [
    {
      id: 'standard',
      name: 'Standard (Mon-Fri)',
      unspecifiedTimeIsWorking: true,
      intervals: [{ recurrentStartDate: 'on Sat', recurrentEndDate: 'on Mon', isWorking: false }],
    },
  ],
  tasksData: [
    {
      id: 10,
      name: 'Build-out',
      expanded: true,
      children: [
        { id: 1, name: 'Pour slab', startDate: '2026-11-02', duration: 3, durationUnit: 'day', percentDone: 50, budgetMinor: 100_000, forecastMinor: 120_000, note: 'Pump booked' },
        { id: 2, name: 'Frame walls', startDate: '2026-11-04', duration: 2, durationUnit: 'day', constraintType: 'startnoearlierthan', constraintDate: '2026-11-04' },
        { id: 3, name: 'Hang doors', startDate: '2026-11-06', duration: 1, durationUnit: 'day', constraintType: 'startnoearlierthan', constraintDate: '2026-11-06', budgetMinor: 5_000, forecastMinor: 5_000 },
        { id: 4, name: 'Paint', startDate: '2026-11-09', duration: 4, durationUnit: 'day', constraintType: 'startnoearlierthan', constraintDate: '2026-11-09', percentDone: 10 },
        { id: 5, name: 'Clean', startDate: '2026-11-02', duration: 1, durationUnit: 'day' },
      ],
    },
  ],
  // Clean waits for Paint.
  dependenciesData: [{ id: 1, fromEvent: 4, toEvent: 5, type: 2, lag: 0, lagUnit: 'day' }],
  resourcesData: [{ id: 1, name: 'Painters' }],
  assignmentsData: [{ id: 1, event: 4, resource: 1, units: 100 }],
};

const projects: ProjectModel[] = [];

async function load(): Promise<{ project: ProjectModel; revisions: unknown[] }> {
  const project = createProjectModel();
  projects.push(project);
  await loadCollaborativeProject(project, structuredClone(DATA), 'client-1');
  const revisions: unknown[] = [];
  project.on('revisionNotification', (event: unknown) => revisions.push(event));
  return { project, revisions };
}

afterEach(() => {
  projects.splice(0).forEach((project) => project.destroy());
});

const day = (iso: string) => {
  const [year, month, date] = iso.split('-').map(Number);
  return new Date(year!, month! - 1, date!);
};
const iso = (date: unknown) => (date instanceof Date ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}` : String(date));
const task = (project: ProjectModel, id: number) => project.taskStore.getById(id) as TaskModel & Record<string, unknown>;
const cells = (project: ProjectModel, columnId: string, ids: number[], field?: string): CellRef[] => ids.map((id) => ({ task: task(project, id), columnId, field }));
const schedule = (project: ProjectModel, id: number) => {
  const record = task(project, id);
  return [iso(record.startDate), record.duration, Math.round(record.percentDone ?? 0)];
};

describe('fillSeries (Bryntum’s fill rule)', () => {
  it('copies one value, continues an even step, repeats anything else', () => {
    const copy = fillSeries([5], false);
    expect([copy(), copy()]).toEqual([5, 5]);
    const step = fillSeries([2, 4], false);
    expect([step(), step(), step()]).toEqual([6, 8, 10]);
    const repeat = fillSeries([1, 5, 2], false);
    expect([repeat(), repeat(), repeat(), repeat()]).toEqual([1, 5, 2, 1]);
    const dates = fillSeries([day('2026-11-02'), day('2026-11-04')], false);
    expect([iso(dates()), iso(dates())]).toEqual(['2026-11-06', '2026-11-08']);
    const text = fillSeries(['a', 'b'], false);
    expect([text(), text(), text()]).toEqual(['a', 'b', 'a']);
  });

  it('runs backwards from the first value when dragged up or left', () => {
    const up = fillSeries([6, 8], true);
    expect([up(), up()]).toEqual([4, 2]);
    const repeat = fillSeries([1, 5, 2], true);
    expect([repeat(), repeat(), repeat()]).toEqual([2, 5, 1]);
    const one = fillSeries([day('2026-11-09')], true);
    expect(iso(one())).toBe('2026-11-09');
  });
});

describe('fillCells', () => {
  it('fills a Schedule cell’s start, length and progress from one cell, as one revision', async () => {
    const { project, revisions } = await load();
    const report = await fillCells(project, { source: cells(project, 'schedule-when', [1]), targets: cells(project, 'schedule-when', [2, 3]), horizontal: false, negative: false });
    expect(report).toEqual({ changed: 2, skipped: 0, heldByLinks: 0 });
    expect(schedule(project, 2)).toEqual(['2026-11-02', 3, 50]);
    expect(schedule(project, 3)).toEqual(['2026-11-02', 3, 50]);
    // The filled start pins the task, like a start typed by hand.
    expect(task(project, 3).constraintType).toBe('startnoearlierthan');
    expect(revisions).toHaveLength(1);
  });

  it('continues a series of starts, lengths and progress from several cells', async () => {
    const { project } = await load();
    // Starts Nov 2 → Nov 4 (2 days apart), lengths 3 → 2, progress 50 → 0.
    await fillCells(project, { source: cells(project, 'schedule-when', [1, 2]), targets: cells(project, 'schedule-when', [3, 4]), horizontal: false, negative: false });
    expect(schedule(project, 3)).toEqual(['2026-11-06', 1, 0]);
    // The series reaches length 0, a milestone: the engine keeps a milestone at the very start of Sunday Nov 8.
    expect(schedule(project, 4)).toEqual(['2026-11-08', 0, 0]);
    expect(task(project, 4).isMilestone).toBe(true);
  });

  it('runs the series backwards when dragged up', async () => {
    const { project } = await load();
    await fillCells(project, { source: cells(project, 'schedule-when', [3, 4]), targets: cells(project, 'schedule-when', [2, 1]), horizontal: false, negative: true });
    // Starts Nov 6 → Nov 9 step back 3 days from the first: Nov 3, then Oct 31, before the project start (Nov 2).
    expect(schedule(project, 2)[0]).toBe('2026-11-03');
    expect(schedule(project, 1)[0]).toBe('2026-11-02');
    // Lengths 1 → 4 step back 3 to −2 and −5: no task has a negative length, so they stay as they were.
    expect(schedule(project, 2)[1]).toBe(2);
    expect(schedule(project, 1)[1]).toBe(3);
  });

  it('says when links keep a filled task later', async () => {
    const { project } = await load();
    const report = await fillCells(project, { source: cells(project, 'schedule-when', [1]), targets: cells(project, 'schedule-when', [5]), horizontal: false, negative: false });
    // Clean waits for Paint (Nov 9-12): it cannot start on Nov 2, but takes the length and progress.
    expect(report.heldByLinks).toBe(1);
    expect(schedule(project, 5)).toEqual(['2026-11-13', 3, 50]);
    expect(describeCellOp('fill', report)).toBe('Filled 1 cell · 1 task stays later: it waits for earlier work');
  });

  it('fills both amounts of a money cell, and leaves phases and read-only cells alone', async () => {
    const { project } = await load();
    const report = await fillCells(project, { source: cells(project, 'cost-plan', [1]), targets: cells(project, 'cost-plan', [3, 10]), horizontal: false, negative: false });
    expect([task(project, 3).budgetMinor, task(project, 3).forecastMinor]).toEqual([100_000, 120_000]);
    expect(report).toMatchObject({ changed: 1, skipped: 1 });
    const actual = await fillCells(project, { source: cells(project, 'cost-actual', [1]), targets: cells(project, 'cost-actual', [3]), horizontal: false, negative: false });
    expect(actual).toMatchObject({ changed: 0, skipped: 1 });
  });

  it('fills plain columns field by field, and never puts a collapsed cell sideways into another column', async () => {
    const { project } = await load();
    await fillCells(project, { source: cells(project, 'progress', [4], 'percentDone'), targets: cells(project, 'progress', [3], 'percentDone'), horizontal: false, negative: false });
    expect(Math.round(task(project, 3).percentDone ?? 0)).toBe(10);
    const sideways = await fillCells(project, {
      source: [{ task: task(project, 1), columnId: 'schedule-when' }],
      targets: [{ task: task(project, 1), columnId: 'start', field: 'startDate' }, { task: task(project, 1), columnId: 'cost-plan' }],
      horizontal: true,
      negative: false,
    });
    expect(sideways.changed).toBe(0);
    expect(schedule(project, 1)).toEqual(['2026-11-02', 3, 50]);
  });
});

describe('clearCells', () => {
  it('takes back what was entered in a Schedule cell: progress and date pins, as one revision', async () => {
    const { project, revisions } = await load();
    const report = await clearCells(project, [...cells(project, 'schedule-when', [1, 2, 5])]);
    // Clean (5) had nothing to take back: no progress, no pin.
    expect(report).toEqual({ changed: 2, skipped: 1, heldByLinks: 0 });
    expect(schedule(project, 1)).toEqual(['2026-11-02', 3, 0]);
    // Frame walls loses its "start no earlier than" and returns to the project start; its length stays.
    expect(task(project, 2).constraintType ?? null).toBeNull();
    expect(schedule(project, 2)).toEqual(['2026-11-02', 2, 0]);
    expect(revisions).toHaveLength(1);
  });

  it('zeroes a money cell, empties notes, removes crews and links, and leaves plan-made values alone', async () => {
    const { project } = await load();
    const report = await clearCells(project, [
      { task: task(project, 1), columnId: 'cost-plan' },
      { task: task(project, 1), columnId: 'cost-actual' },
      { task: task(project, 1), columnId: 'notes', field: 'note' },
      { task: task(project, 4), columnId: 'schedule-crew' },
      { task: task(project, 4), columnId: 'successors' },
      { task: task(project, 4), columnId: 'task', field: 'name' },
      { task: task(project, 4), columnId: 'duration', field: 'duration' },
      { task: task(project, 10), columnId: 'schedule-when' },
    ]);
    expect(report).toMatchObject({ changed: 4, skipped: 4 });
    expect([task(project, 1).budgetMinor, task(project, 1).forecastMinor, task(project, 1).note]).toEqual([0, 0, '']);
    expect(task(project, 4).assignments).toHaveLength(0);
    expect(project.dependencyStore.count).toBe(0);
    expect(task(project, 4).name).toBe('Paint');
    expect(task(project, 4).duration).toBe(4);
    expect(describeCellOp('clear', report)).toBe('Cleared 4 cells · 4 cells unchanged (worked out by the plan, read-only or already empty)');
  });

  it('knows its collapsed columns', () => {
    expect(isCollapsedColumn('schedule-when')).toBe(true);
    expect(isCollapsedColumn('cost-plan')).toBe(true);
    expect(isCollapsedColumn('start')).toBe(false);
    expect(isCollapsedColumn(undefined)).toBe(false);
  });
});

describe('clearing the Equipment cell', () => {
  async function withMachine() {
    const project = createProjectModel();
    projects.push(project);
    await loadCollaborativeProject(
      project,
      {
        ...structuredClone(DATA),
        resourcesData: [{ id: 1, name: 'Painters', kind: 'labor' }, { id: 2, name: 'Scissor lift', kind: 'equipment' }],
        assignmentsData: [{ id: 1, event: 4, resource: 1, units: 100 }, { id: 2, event: 4, resource: 2, units: 100 }],
      } as unknown as ProjectInlineData,
      'client-1',
    );
    return project;
  }
  const crewOn = (project: ProjectModel, id: number) => ((project.taskStore.getById(id) as TaskModel).assignments as { resource: { name: string } }[]).map((assignment) => assignment.resource.name);

  it('takes the machine off the task and leaves the crew', async () => {
    const project = await withMachine();
    const report = await clearCells(project, [{ task: project.taskStore.getById(4) as TaskModel, columnId: 'equipment' }]);
    expect(report).toMatchObject({ changed: 1, skipped: 0 });
    expect(crewOn(project, 4)).toEqual(['Painters']);
  });

  it('changes nothing on a task with no machine', async () => {
    const project = await withMachine();
    const report = await clearCells(project, [{ task: project.taskStore.getById(1) as TaskModel, columnId: 'equipment' }]);
    expect(report).toMatchObject({ changed: 0, skipped: 1 });
  });
});
