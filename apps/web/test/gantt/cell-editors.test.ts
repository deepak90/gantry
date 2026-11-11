import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectModel, TaskModel } from '@bryntum/gantt';
import type { ProjectInlineData } from '@collab/shared';
import { ScheduleDraft, applyMoneyChange, applyScheduleChange, moneyLineHtml, removeEquipment, rentalDatesChange, rentalFactsHtml, scheduleChanges, waitText } from '../../src/gantt/cell-editors';
import { lastWorkingDay, renderDependencyTooltip, type TaskDecoration } from '../../src/gantt/look';
import { createProjectModel, loadCollaborativeProject } from '../../src/gantt/project';

/** Mon–Fri, 24-hour days like the seed; Monday, November 2, 2026 is day one. */
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
    { id: 1, name: 'Pour slab', startDate: '2026-11-02', duration: 3, durationUnit: 'day', budgetMinor: 100_000, forecastMinor: 100_000 },
    { id: 2, name: 'Cure slab', startDate: '2026-11-05', duration: 2, durationUnit: 'day' },
    { id: 3, name: 'Install formwork', startDate: '2026-11-06', duration: 2, durationUnit: 'day', constraintType: 'startnoearlierthan', constraintDate: '2026-11-06' },
  ],
  dependenciesData: [{ id: 1, fromEvent: 1, toEvent: 2, type: 2, lag: 0, lagUnit: 'day' }],
};

const DAY = 24 * 3_600_000;
const projects: ProjectModel[] = [];

async function load(): Promise<ProjectModel> {
  const project = createProjectModel();
  projects.push(project);
  await loadCollaborativeProject(project, structuredClone(DATA), 'client-1');
  return project;
}

const day = (iso: string) => {
  const [year, month, date] = iso.split('-').map(Number);
  return new Date(year!, month! - 1, date!);
};
const iso = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const task = (project: ProjectModel, id: number) => project.taskStore.getById(id) as TaskModel;

function calendarOf(record: TaskModel) {
  return (record as TaskModel & { effectiveCalendar: ConstructorParameters<typeof ScheduleDraft>[0] }).effectiveCalendar;
}

afterEach(() => {
  projects.splice(0).forEach((project) => project.destroy());
});

describe('lastWorkingDay', () => {
  it('is the day before the exclusive end, skipping a weekend', async () => {
    const project = await load();
    expect(iso(lastWorkingDay(task(project, 1)))).toBe('2026-11-04'); // Mon-Wed
    expect(iso(lastWorkingDay(task(project, 2)))).toBe('2026-11-06'); // Thu-Fri
    expect(iso(lastWorkingDay(task(project, 3)))).toBe('2026-11-09'); // Fri + Mon
  });
});

describe('ScheduleDraft', () => {
  it('keeps the length when the start moves, over the weekend', async () => {
    const project = await load();
    const record = task(project, 1);
    const draft = new ScheduleDraft(calendarOf(record), DAY, record);
    draft.setStart(day('2026-11-05'));
    expect(draft.days).toBe(3);
    expect(iso(draft.lastDay)).toBe('2026-11-09'); // Thu, Fri, Mon
  });

  it('moves the finish with the working days and the working days with the finish', async () => {
    const project = await load();
    const record = task(project, 1);
    const draft = new ScheduleDraft(calendarOf(record), DAY, record);
    draft.setDays(5);
    expect(iso(draft.lastDay)).toBe('2026-11-06');
    draft.setLastDay(day('2026-11-10'));
    expect(draft.days).toBe(7); // Mon 2 - Tue 10, weekend excluded
  });

  it('a start on a weekend snaps to the next working day', async () => {
    const project = await load();
    const record = task(project, 1);
    const draft = new ScheduleDraft(calendarOf(record), DAY, record);
    draft.setStart(day('2026-11-07'));
    expect(iso(draft.start)).toBe('2026-11-09');
  });

  it('moving the start sends the start alone: the finish follows, it is not a change of its own', async () => {
    const project = await load();
    const record = task(project, 1);
    const opened = new ScheduleDraft(calendarOf(record), DAY, record);
    const draft = new ScheduleDraft(calendarOf(record), DAY, record);
    draft.setStart(day('2026-11-05'));
    expect(Object.keys(scheduleChanges(opened, draft))).toEqual(['start']);
  });

  it('reports only what changed', async () => {
    const project = await load();
    const record = task(project, 1);
    const opened = new ScheduleDraft(calendarOf(record), DAY, record);
    const draft = new ScheduleDraft(calendarOf(record), DAY, record);
    expect(scheduleChanges(opened, draft)).toEqual({});
    draft.setLastDay(day('2026-11-05'));
    expect(Object.keys(scheduleChanges(opened, draft))).toEqual(['days']);
    draft.progress = 40;
    expect(scheduleChanges(opened, draft)).toMatchObject({ days: 4, progress: 40 });
  });
});

describe('applying a collapsed-cell edit', () => {
  it('sends one revision for a schedule save that changes several fields', async () => {
    const project = await load();
    const revisions: { changes: { tasks?: { $input?: { updated?: Record<string, unknown>[] } } } }[] = [];
    project.on('revisionNotification', (event: (typeof revisions)[number]) => revisions.push(event));
    await applyScheduleChange(project, task(project, 1), { days: 4, progress: 50 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(revisions).toHaveLength(1);
    expect(revisions[0]!.changes.tasks?.$input?.updated).toEqual([expect.objectContaining({ id: 1, duration: 4, percentDone: 50 })]);
    // The successor follows in the same revision.
    expect(iso(task(project, 2).startDate as Date)).toBe('2026-11-06');
  });

  it('sends one revision for a money save', async () => {
    const project = await load();
    const revisions: unknown[] = [];
    project.on('revisionNotification', (event: unknown) => revisions.push(event));
    await applyMoneyChange(project, task(project, 1), { budgetMinor: 120_000, forecastMinor: 125_000 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(revisions).toHaveLength(1);
    expect((task(project, 1) as TaskModel & { forecastMinor: number }).forecastMinor).toBe(125_000);
  });

  it('sends nothing when nothing changed', async () => {
    const project = await load();
    const revisions: unknown[] = [];
    project.on('revisionNotification', (event: unknown) => revisions.push(event));
    await applyScheduleChange(project, task(project, 1), {});
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(revisions).toHaveLength(0);
  });
});

describe('dependency tooltip', () => {
  it('says in words what the link means', async () => {
    const project = await load();
    const content = JSON.stringify(renderDependencyTooltip(project.dependencyStore.first as never));
    expect(content).toContain('Finish, then start');
    expect(content).toContain('Cure slab can start once Pour slab is finished.');
  });
});

describe('link waits in words', () => {
  it('says a wait or an overlap plainly', () => {
    expect([waitText(0), waitText(1), waitText(3), waitText(-1), waitText(-2)]).toEqual(['no wait', '+1 day wait', '+3 days wait', '1 day overlap', '2 days overlap']);
  });
});

describe('schedule popup: the money line', () => {
  it('shows expected against budget, spent, paid and the workflow badges, and no verdict', async () => {
    const project = await load();
    (task(project, 1) as TaskModel & { forecastMinor: number }).forecastMinor = 112_000;
    const html = moneyLineHtml(task(project, 1), {
      canViewCosts: true,
      currency: 'USD',
      decorations: new Map<number, TaskDecoration>([
        [
          1,
          {
            idle: { start: '2026-11-02', end: '2026-11-05', days: 3, costMinor: 180_000, equipment: 'Crane' },
            tracker: null,
            badges: [{ text: 'Paid $1,200', tone: 'ok' as const, icon: 'fa-brands fa-paypal' }],
          },
        ],
      ]),
    });
    expect(html).toContain('$1,120');
    expect(html).toContain('expected of $1,000');
    expect(html).toContain('$0 spent');
    expect(html).toContain('$0 paid');
    expect(html).toContain('Paid $1,200');
    // Over budget and idle rental are for the assistant or a watch rule to raise, not the editor.
    expect(html).not.toContain('+$120');
    expect(html).not.toContain('idle');
  });
});

describe('rental popup: start and end dates', () => {
  // On rent Mon, Dec 7 through Thu, Dec 17, as the booking stores it (the end is the day after).
  const opened = { start: '2026-12-07', end: '2026-12-18' };
  const rental = {
    ...opened,
    assignmentId: 1,
    bookingId: 'b' as string | null,
    resourceId: 4,
    equipment: 'Crane',
    supplier: 'Northgate Equipment Rental',
    rateMinor: 60_000 as number | null,
    currency: 'USD' as const,
    taskName: 'Erect steel frame',
    taskStart: '2026-12-11',
    taskEnd: '2026-12-18',
    locked: null,
    rentalDays: () => 9,
    idleDays: () => ({ before: 0, after: 0 }),
    offDays: () => 0,
    isBuffer: () => false,
  };

  it('reads the end date as the last day on rent', () => {
    expect(rentalDatesChange(opened, day('2026-12-07'), day('2026-12-17'))).toEqual({});
    expect(rentalDatesChange(opened, day('2026-12-07'), day('2026-12-18'))).toEqual({ rentalEnd: '2026-12-19' });
  });

  it('asks only for the date that changed', () => {
    expect(rentalDatesChange(opened, day('2026-12-11'), day('2026-12-17'))).toEqual({ rentalStart: '2026-12-11' });
    expect(rentalDatesChange(opened, day('2026-12-11'), day('2026-12-15'))).toEqual({ rentalStart: '2026-12-11', rentalEnd: '2026-12-16' });
  });

  it('takes a one-day rental and refuses an end before the start or a missing date', () => {
    expect(rentalDatesChange(opened, day('2026-12-10'), day('2026-12-10'))).toEqual({ rentalStart: '2026-12-10', rentalEnd: '2026-12-11' });
    expect(rentalDatesChange(opened, day('2026-12-10'), day('2026-12-09'))).toBe('The end date cannot be before the start date.');
    expect(rentalDatesChange(opened, null, day('2026-12-09'))).toBe('Choose a start date and an end date.');
  });

  it('says what the dates come to, and the cost only to those who see costs', () => {
    const html = rentalFactsHtml(rental, opened.start, opened.end);
    expect(html).toContain('9 rental days');
    expect(html).toContain('$5,400');
    expect(html).toContain('Erect steel frame: Dec 11–17');
    expect(rentalFactsHtml({ ...rental, rateMinor: null }, opened.start, opened.end)).not.toContain('$');
    expect(rentalFactsHtml({ ...rental, rentalDays: () => 1 }, opened.start, opened.end)).toContain('1 rental day<');
    expect(rentalFactsHtml({ ...rental, bookingId: null, rateMinor: null }, opened.start, opened.end)).toContain('<strong>9 days</strong>');
  });
});

describe('rental popup: Remove from task', () => {
  it('takes that machine off this task only', async () => {
    const project = createProjectModel();
    projects.push(project);
    await loadCollaborativeProject(
      project,
      {
        ...structuredClone(DATA),
        resourcesData: [{ id: 1, name: 'Crane', kind: 'equipment' }, { id: 2, name: 'Summit Steel', kind: 'labor' }],
        assignmentsData: [{ id: 1, event: 1, resource: 1 }, { id: 2, event: 1, resource: 2 }, { id: 3, event: 2, resource: 1 }],
      } as unknown as ProjectInlineData,
      'client-1',
    );
    await removeEquipment(project, task(project, 1), 1);
    const on = (id: number) => (task(project, id).assignments as { resource: { name: string } }[]).map((assignment) => assignment.resource.name);
    expect(on(1)).toEqual(['Summit Steel']);
    expect(on(2)).toEqual(['Crane']);
  });
});
