/**
 * The scenario adapter against the real scheduling engine and the Riverside Clinic seed: the rental cut
 * to the days the work needs and a longer one (the cost tables), handover preservation, a later
 * arrival that slips the handover and leaves the crane needed off rent, and isolation from the live
 * project.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectModel, TaskModel } from '@bryntum/gantt';
import { toDateOnly, type ProjectInlineData, type ProposalAssumption, type ProposalInputs } from '@collab/shared';
import { riversideClinic } from '@collab/shared/seed';
import { createProjectModel, loadCollaborativeProject, loadProjectInlineData } from '../../src/gantt/project';
import { defaultRevisedInterval, readBookingFacts } from '../../src/scenario/booking';
import { captureProjectState, evaluateScenario, type EvaluationBooking } from '../../src/scenario/evaluate';

const seed = riversideClinic;
const booking: EvaluationBooking = {
  taskId: seed.booking.task_id,
  resourceId: seed.booking.resource_id,
  billableStart: seed.booking.billable_start,
  billableEnd: seed.booking.billable_end,
  rentalRateMinor: seed.booking.rental_rate_minor,
  currency: 'USD',
};

const initialInputs: ProposalInputs = { new_start: '2026-12-11', new_end: '2026-12-18' };
const answered: ProposalAssumption[] = [
  { key: 'delivery_date', question: 'Can Northgate deliver on Fri, Dec 11?', answer: 'Yes', resolved_by: 'human' },
];
const NOW = () => new Date('2026-11-10T14:00:00Z');

let live: ProjectModel | undefined;

afterEach(() => {
  live?.destroy();
  live = undefined;
});

async function liveSeedProject(): Promise<ProjectModel> {
  live = createProjectModel();
  await loadProjectInlineData(live, structuredClone(seed.inlineData));
  return live;
}

function evaluate(data: ProjectInlineData, inputs: ProposalInputs, assumptions = answered) {
  return evaluateScenario({
    data,
    sourceRevision: 7,
    handoverTaskId: seed.handover_task_id,
    booking,
    inputs,
    assumptions,
    now: NOW,
  });
}

describe('evaluateScenario on the Riverside Clinic seed', () => {
  it('the idle days cut from the rental: handover kept, $4,200 paid instead of $6,600', async () => {
    const evaluation = await evaluate(structuredClone(seed.inlineData), initialInputs);
    expect(evaluation.source_revision).toBe(7);
    expect(evaluation.schedule_impact).toEqual({
      handover: { published_end: '2027-04-28', proposed_end: '2027-04-28', delta_days: 0 },
      affected_tasks: [],
      over_allocations: [],
    });
    expect(evaluation.booking_days).toEqual({
      published_billable_days: 11,
      revised_billable_days: 7,
      avoided_billable_days: 4,
      revised_idle_days: 0,
    });
    expect(evaluation.cost_comparison).toEqual({ currency: 'USD', booked_rental_minor: 660_000, supplier_payment_minor: 420_000, saving_minor: 240_000 });
    expect(evaluation.unresolved_assumptions).toEqual([]);
    expect(evaluation.evaluated_at).toBe('2026-11-10T14:00:00.000Z');
  });

  it('a rental longer than booked pays the extra days: the saving is negative', async () => {
    const evaluation = await evaluate(structuredClone(seed.inlineData), { ...initialInputs, new_end: '2026-12-24' });
    const days = evaluation.booking_days;
    expect(days.revised_billable_days).toBeGreaterThan(days.published_billable_days);
    expect(days.avoided_billable_days).toBe(0);
    expect(evaluation.cost_comparison).toEqual({
      currency: 'USD',
      booked_rental_minor: 660_000,
      supplier_payment_minor: days.revised_billable_days * 60_000,
      saving_minor: 660_000 - days.revised_billable_days * 60_000,
    });
    expect(evaluation.cost_comparison.saving_minor).toBeLessThan(0);
  });

  it('lists open assumptions as unresolved', async () => {
    const open: ProposalAssumption[] = [{ ...answered[0]!, answer: null, resolved_by: null }];
    const evaluation = await evaluate(structuredClone(seed.inlineData), initialInputs, open);
    expect(evaluation.unresolved_assumptions).toEqual(['delivery_date']);
    expect(evaluation.assumptions).toEqual(open);
  });

  it('a later arrival slips the handover and leaves the crane needed off rent', async () => {
    const evaluation = await evaluate(structuredClone(seed.inlineData), { ...initialInputs, new_start: '2026-12-14' });
    const { handover, affected_tasks, over_allocations } = evaluation.schedule_impact;
    expect(handover.published_end).toBe('2027-04-28');
    expect(handover.proposed_end > handover.published_end).toBe(true);
    expect(handover.delta_days).toBeGreaterThan(0);
    const erection = affected_tasks.find((task) => task.task_id === seed.booking.task_id);
    expect(erection).toMatchObject({
      published_start: '2026-12-11',
      published_end: '2026-12-18',
      proposed_start: '2026-12-14',
      proposed_end: '2026-12-20',
    });
    expect(affected_tasks.length).toBeGreaterThan(1);
    // Six site days from Monday, December 14 run to Saturday 19; the crane is booked until the 18th.
    expect(over_allocations).toContainEqual({
      resource_id: seed.booking.resource_id,
      intervals: [{ start: '2026-12-18', end: '2026-12-20' }],
    });
    expect(evaluation.booking_days.revised_billable_days).toBe(4);
  });

  it('never touches the live project', async () => {
    const project = await liveSeedProject();
    const erection = project.taskStore.getById(seed.booking.task_id) as TaskModel;
    const before = erection.constraintType;
    const { data } = { data: structuredClone(seed.inlineData) };
    await evaluate(data, { ...initialInputs, new_start: '2026-12-14' });
    expect(erection.constraintType).toBe(before);
    expect(toDateOnly(erection.startDate as Date)).toBe('2026-12-11');
  });
});

describe('booking facts from the engine', () => {
  it('reads every day on rent, the idle days around the work and its activities', async () => {
    const project = await liveSeedProject();
    expect(readBookingFacts(project, booking)).toEqual({
      taskName: 'Erect structural steel frame',
      taskStart: '2026-12-11',
      taskEnd: '2026-12-18',
      resourceName: 'Crane',
      calendarName: 'Site (Mon-Sat)',
      billableDays: 11,
      idleDays: 4,
      idleBefore: 4,
      idleAfter: 0,
      buffered: false,
      activities: [{ taskId: 15, name: 'Erect structural steel frame', start: '2026-12-11', end: '2026-12-18' }],
    });
    expect(defaultRevisedInterval(project, booking)).toEqual({ newStart: '2026-12-11', newEnd: '2026-12-18' });
  });
});

describe('captureProjectState', () => {
  it('reports the revision the server confirmed, and refuses while local changes are unsent', async () => {
    live = createProjectModel();
    await loadCollaborativeProject(live, structuredClone(seed.inlineData), 'client-a', '3');
    const state = await captureProjectState(live);
    expect(state.revision).toBe(3);
    expect(state.data.tasksData.length).toBeGreaterThan(0);

    (live.taskStore.getById(111) as TaskModel).name = 'Renamed locally';
    await live.commitAsync();
    await new Promise((resolve) => setTimeout(resolve, 200));
    await expect(captureProjectState(live)).rejects.toThrow(/still being saved/);
  });
});
