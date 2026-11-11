/**
 * Proves the Cedar Park Clinic seed with the real scheduling engine: it loads with the dates the seed
 * derived and no scheduling issue, and its rentals say what the plan's story needs: the concrete pump
 * wanted by both pours for two days, the crane and the scissor lift on rent before their work, and the
 * excavator booked from the first day it works to the last. Moving the second pour then moves the crane's
 * idle days from both sides of the work to before it, without changing what they cost.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DateHelper, ProjectModel } from '@bryntum/gantt';
import type { TaskModel } from '@bryntum/gantt';
import { rentalDays } from '@collab/shared';
import { CEDAR_IDS, cedarParkClinic, cedarParkRecords, countWorkingDays, SEED_PROJECTS } from '@collab/shared/seed';
import { readBookingFacts } from '../../src/scenario/booking';

type ProjectConfig = NonNullable<ConstructorParameters<typeof ProjectModel>[0]>;

const iso = (value: unknown): string => (value instanceof Date ? DateHelper.format(value, 'YYYY-MM-DD') : String(value));

let project: ProjectModel | undefined;
afterEach(() => {
  project?.destroy();
  project = undefined;
});

async function load(): Promise<{ project: ProjectModel; issues: string[] }> {
  const issues: string[] = [];
  const record = (kind: string) => (event: { schedulingIssue: { getDescription: Function } }) => issues.push(`${kind}: ${String(event.schedulingIssue.getDescription())}`);
  project = new ProjectModel({ listeners: { schedulingConflict: record('conflict'), cycle: record('cycle'), emptyCalendar: record('calendar') } } as never);
  await project.loadInlineData(structuredClone(cedarParkClinic.inlineData) as object as ProjectConfig);
  await project.commitAsync();
  return { project, issues };
}

const task = (model: ProjectModel, id: number) => model.taskStore.getById(id) as TaskModel;
const rentals = [cedarParkClinic.booking!, ...cedarParkClinic.moreBookings!];
const rentalOf = (taskId: number) => rentals.find((rental) => rental.task_id === taskId)!;

describe('Cedar Park Clinic seed', () => {
  it('is small enough to read, and opens by its link as the demo it plays (only Harbor is in the menu)', () => {
    expect(SEED_PROJECTS.map(({ ids }) => ids.project)).toContain(CEDAR_IDS.project);
    expect(cedarParkClinic.unlisted).toBe(true);
    expect(cedarParkClinic.template).toBe('cedar');
    expect(cedarParkRecords.tasks.length).toBeLessThanOrEqual(25);
    expect(rentals).toHaveLength(4);
  });

  it('loads on the engine with the dates the seed derived, and no scheduling issue', async () => {
    const { project: model, issues } = await load();
    expect(issues).toEqual([]);
    for (const seeded of cedarParkRecords.tasks) {
      const live = task(model, seeded.id);
      expect([iso(live.startDate), iso(live.endDate)], `task ${seeded.id} ${seeded.name}`).toEqual([seeded.startDate, seeded.endDate]);
    }
  });

  it('wants the concrete pump twice for two days', () => {
    const east = cedarParkRecords.tasks.find((record) => record.id === 113)!;
    const west = cedarParkRecords.tasks.find((record) => record.id === 114)!;
    expect(countWorkingDays(west.startDate, east.endDate, 'standard')).toBe(2);
    expect(rentalOf(114).idle_days).toBe(0);
  });

  it('has the crane on rent three days before the steel, for 15 days of which the work needs six', () => {
    const crane = rentalOf(212);
    expect(crane.idle_days).toBe(7); // Three before the steel, four after it: a weekend among them.
    expect(rentalDays(crane.billable_start, crane.billable_end)).toBe(15);
    expect(cedarParkRecords.tasks.find((record) => record.id === 212)!.duration).toBe(6);
    expect(crane.rental_rate_minor).toBe(60000);
  });

  it('finds nothing on the excavator, whose only days off are inside its work, and books the lift four days early and two days late', () => {
    const excavator = rentalOf(112);
    const work = cedarParkRecords.tasks.find((record) => record.id === 112)!;
    expect([excavator.billable_start, excavator.billable_end]).toEqual([work.startDate, work.endDate]);
    expect(excavator.idle_days).toBe(0);
    expect(rentalDays(excavator.billable_start, excavator.billable_end)).toBe(6);
    expect(rentalOf(312).idle_days).toBe(6);
  });

  it('counts the crane\'s idle days on both sides of the work', async () => {
    const { project: model } = await load();
    const crane = rentalOf(212);
    const booking = { taskId: 212, resourceId: crane.resource_id, billableStart: crane.billable_start, billableEnd: crane.billable_end };
    expect(readBookingFacts(model, booking)).toMatchObject({ idleBefore: 3, idleAfter: 4, idleDays: 7 });
  });

  it('moves the crane\'s idle days from after the work to before it when the second pour waits for the first: the total stays', async () => {
    const { project: model } = await load();
    const west = task(model, 114);
    west.constraintType = 'startnoearlierthan';
    west.constraintDate = task(model, 113).endDate as Date;
    await model.commitAsync();
    const crane = rentalOf(212);
    const start = iso(task(model, 212).startDate);
    expect(rentalDays(crane.billable_start, start)).toBe(7);
    // Idle counts both sides, so the fix's knock-on moves the crane's idle days without changing what they cost.
    const booking = { taskId: 212, resourceId: crane.resource_id, billableStart: crane.billable_start, billableEnd: crane.billable_end };
    expect(readBookingFacts(model, booking)).toMatchObject({ idleBefore: 7, idleAfter: 0, idleDays: 7 });
    // The rental then ends with the work: the whole $4,200 of idle days is what the fix saves.
    expect(iso(task(model, 212).endDate)).toBe(crane.billable_end);
  });
});
