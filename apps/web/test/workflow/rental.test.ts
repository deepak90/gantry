/**
 * A machine has its own dates on each task: drawn there, edited there, double booked or not. A rental
 * belongs to one machine on one task, and only there can money lock the dates. The fix stages are the
 * tracker's.
 */
import type { ProjectModel, TaskModel } from '@bryntum/gantt';
import { addDays, type ProjectInlineData } from '@collab/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { applyRentalDates, removeEquipment } from '../../src/gantt/cell-editors';
import { createProjectModel, loadCollaborativeProject } from '../../src/gantt/project';
import { runProjectTransaction } from '../../src/scenario/publish';
import { buildDecorations } from '../../src/workflow/decorations';
import { rentalEditFor, rentalEditsFor, rentalLockOf, rentalSpanOf } from '../../src/workflow/rental';
import { CEDAR_IDS, cedarParkClinic } from '@collab/shared/seed';
import type { WorkflowSnapshot } from '../../src/workflow/api';
import { BOOKING, PROJECT, snapshotAt, type Stage } from './tracker-fixtures';

/** Mon–Fri. The crane (4) is rented for task 15 and also works on 16; 17 has only a crew, 18 a machine with no rental. */
const DATA = {
  project: { calendar: 'standard', startDate: '2026-12-07', hoursPerDay: 24, daysPerWeek: 5, daysPerMonth: 20 },
  calendarsData: [{ id: 'standard', name: 'Standard', unspecifiedTimeIsWorking: true, intervals: [{ recurrentStartDate: 'on Sat', recurrentEndDate: 'on Mon', isWorking: false }] }],
  tasksData: [
    { id: 15, name: 'Erect steel frame', startDate: '2026-12-07', duration: 5, durationUnit: 'day', constraintType: 'startnoearlierthan', constraintDate: '2026-12-11' },
    { id: 16, name: 'Lift roof trusses', startDate: '2026-12-07', duration: 2, durationUnit: 'day' },
    { id: 17, name: 'Bolt up', startDate: '2026-12-07', duration: 2, durationUnit: 'day' },
    { id: 18, name: 'Pour slab', startDate: '2026-12-07', duration: 2, durationUnit: 'day' },
  ],
  resourcesData: [
    { id: 4, name: 'Crane', kind: 'equipment' },
    { id: 5, name: 'Summit Steel', kind: 'labor' },
    { id: 6, name: 'Concrete pump', kind: 'equipment' },
  ],
  assignmentsData: [
    { id: 1, event: 15, resource: 4 },
    { id: 2, event: 16, resource: 4 },
    { id: 3, event: 17, resource: 5 },
    { id: 4, event: 18, resource: 6 },
  ],
} as unknown as ProjectInlineData;

const projects: ProjectModel[] = [];

async function load(): Promise<ProjectModel> {
  const project = createProjectModel();
  projects.push(project);
  await loadCollaborativeProject(project, structuredClone(DATA), 'client-1');
  return project;
}

afterEach(() => {
  projects.splice(0).forEach((project) => project.destroy());
});

describe('the rental a cell edits', () => {
  it('is the one booked on the task, with its dates and what they come to', async () => {
    const project = await load();
    const rental = rentalEditFor(snapshotAt('cancelled'), project, 15, true)!;
    expect(rental).toMatchObject({
      equipment: 'Crane',
      supplier: 'Northgate Equipment Rental',
      start: '2026-12-07',
      end: '2026-12-18',
      rateMinor: 60_000,
      taskName: 'Erect steel frame',
      taskStart: '2026-12-11',
      taskEnd: '2026-12-18',
    });
    // Every day on rent is paid for, a weekend too.
    expect(rental.rentalDays('2026-12-07', '2026-12-18')).toBe(11);
    expect(rental.rentalDays('2026-12-12', '2026-12-14')).toBe(2);
  });

  it('goes by the task’s own days on the machine’s other tasks, with nothing to pay and no rate', async () => {
    const project = await load();
    expect(rentalEditFor(snapshotAt('cancelled'), project, 16, true)).toMatchObject({ bookingId: null, assignmentId: 2, resourceId: 4, equipment: 'Crane', start: '2026-12-07', end: '2026-12-09', rateMinor: null, locked: null, taskName: 'Lift roof trusses' });
  });

  it('goes by the task’s own days for a machine with no rental anywhere', async () => {
    const project = await load();
    expect(rentalEditFor(snapshotAt('cancelled'), project, 18, true)).toMatchObject({ bookingId: null, resourceId: 6, equipment: 'Concrete pump', start: '2026-12-07', end: '2026-12-09', rateMinor: null, locked: null, taskName: 'Pour slab' });
  });

  it('does not exist for a crew or a task that is gone', async () => {
    const project = await load();
    const snapshot = snapshotAt('cancelled');
    expect(rentalEditFor(snapshot, project, 17, true)).toBeNull();
    expect(rentalEditFor(snapshot, project, 999, true)).toBeNull();
  });

  it('hides the rate from viewers who may not see costs', async () => {
    const project = await load();
    expect(rentalEditFor(snapshotAt('cancelled'), project, 15, false)?.rateMinor).toBeNull();
  });
});

describe('every machine on a task, for the task panel', () => {
  /** Task 15 with a second machine, which has dates of its own and no rental. */
  const withPump = async (): Promise<ProjectModel> => {
    const project = await load();
    await runProjectTransaction(project, 'Add the pump', () => {
      project.assignmentStore.add({ id: 9, event: 15, resource: 6, rentalStart: '2026-12-14', rentalEnd: '2026-12-16' } as never);
    });
    return project;
  };

  it('lists each with its own dates, the rented one with its rate and supplier', async () => {
    const project = await withPump();
    const rentals = rentalEditsFor(snapshotAt('cancelled'), project, 15, true);
    expect(rentals.map((rental) => rental.equipment).sort()).toEqual(['Concrete pump', 'Crane']);
    expect(rentals.find((rental) => rental.equipment === 'Crane')).toMatchObject({ assignmentId: 1, supplier: 'Northgate Equipment Rental', start: '2026-12-07', end: '2026-12-18', rateMinor: 60_000 });
    expect(rentals.find((rental) => rental.equipment === 'Concrete pump')).toMatchObject({ assignmentId: 9, bookingId: null, rateMinor: null, start: '2026-12-14', end: '2026-12-16', locked: null });
  });

  it('says how many days of a rental have no work planned, on each side of the work', async () => {
    const project = await load();
    const [rental] = rentalEditsFor(snapshotAt('cancelled'), project, 15, true);
    expect(rental!.idleDays('2026-12-07', '2026-12-18')).toEqual({ before: 4, after: 0 });
    expect(rental!.idleDays('2026-12-11', '2026-12-22')).toEqual({ before: 0, after: 4 });
  });

  it('counts the days off inside the work apart: they are paid, and no dates take them away', async () => {
    const project = await load();
    const [rental] = rentalEditsFor(snapshotAt('cancelled'), project, 15, true);
    expect(rental!.offDays('2026-12-07', '2026-12-18')).toBe(2);
    // A rental that stops before the weekend pays for none of it.
    expect(rental!.offDays('2026-12-11', '2026-12-12')).toBe(0);
  });

  it('locks only the machine with money behind its dates', async () => {
    const project = await withPump();
    const rentals = rentalEditsFor(snapshotAt('pending'), project, 15, true);
    expect(rentals.find((rental) => rental.equipment === 'Crane')?.locked).toMatch(/PayPal is paying/);
    expect(rentals.find((rental) => rental.equipment === 'Concrete pump')?.locked).toBeNull();
  });

  it('is empty for a task with no machine or one that is gone, and works before the workflow has loaded', async () => {
    const project = await load();
    expect(rentalEditsFor(snapshotAt('cancelled'), project, 17, true)).toEqual([]);
    expect(rentalEditsFor(snapshotAt('cancelled'), project, 999, true)).toEqual([]);
    expect(rentalEditsFor(null, project, 18, true)).toMatchObject([{ equipment: 'Concrete pump', bookingId: null }]);
  });
});

describe('the outline on the Gantt', () => {
  const task = (project: ProjectModel, id: number) => project.taskStore.getById(id) as TaskModel;
  const rental = { start: '2026-12-07', end: '2026-12-18', equipment: 'Crane', supplier: 'Northgate Equipment Rental', booked: true };

  it('is drawn on every task the machine is on, each with its own dates', async () => {
    const project = await load();
    const decorations = buildDecorations(snapshotAt('checked'), project, true, 'USD');
    expect(decorations.get(15)?.rental).toEqual(rental);
    expect(decorations.get(16)?.rental).toEqual({ start: '2026-12-07', end: '2026-12-09', equipment: 'Crane', supplier: '', booked: false });
  });

  it('gives the machine\'s daily rate only to those who may see money', async () => {
    const project = await load();
    expect(buildDecorations(snapshotAt('checked'), project, true, 'USD').get(15)?.rentalRateMinor).toBe(60_000);
    expect(buildDecorations(snapshotAt('checked'), project, false, 'USD').get(15)?.rentalRateMinor).toBeUndefined();
  });

  it('leaves the payment and the idle days to the task the rental is booked on', async () => {
    const project = await load();
    const decorations = buildDecorations(snapshotAt('pending'), project, true, 'USD');
    expect(decorations.get(15)).toMatchObject({ idle: { days: 4 }, badges: [expect.anything()] });
    expect(decorations.get(15)?.tracker).not.toBeNull();
    expect(decorations.get(16)).toMatchObject({ idle: null, tracker: null, badges: [] });
  });

  it('is drawn over the task’s own days for a machine with no rental, and says so', async () => {
    const project = await load();
    expect(buildDecorations(snapshotAt('checked'), project, true, 'USD').get(18)?.rental).toEqual({ start: '2026-12-07', end: '2026-12-09', equipment: 'Concrete pump', supplier: '', booked: false });
  });

  it('is not drawn for a crew', async () => {
    const project = await load();
    expect(buildDecorations(snapshotAt('checked'), project, true, 'USD').get(17)).toBeUndefined();
  });

  it('goes when the machine comes off the task, and stays on its other tasks', async () => {
    const project = await load();
    await removeEquipment(project, task(project, 15), 4);
    const decorations = buildDecorations(snapshotAt('pending'), project, true, 'USD');
    expect(decorations.get(15)?.rental).toBeNull();
    expect(decorations.get(15)?.tracker).not.toBeNull();
    expect(decorations.get(16)?.rental?.equipment).toBe('Crane');
    expect(rentalSpanOf(snapshotAt('checked'), task(project, 15))).toBeNull();
  });
});

describe('Cedar Park Clinic: the concrete pump both pours want', () => {
  const EAST_POUR = 113;
  const WEST_POUR = 114;

  async function cedar() {
    const project = createProjectModel();
    projects.push(project);
    await loadCollaborativeProject(project, structuredClone(cedarParkClinic.inlineData), 'client-1');
    const bookings = [{ id: CEDAR_IDS.booking, ...cedarParkClinic.booking! }, ...cedarParkClinic.moreBookings!].map((booking) => ({ ...booking, project_id: PROJECT })) as WorkflowSnapshot['bookings'];
    const snapshot: WorkflowSnapshot = { ...snapshotAt('draft'), bookings, proposals: [], versions: [], approvals: [], payments: [], publications: [], confirmations: [] };
    return { project, snapshot };
  }

  it('draws on both, each with its own dates: the rental on the west pour, its own days on the east', async () => {
    const { project, snapshot } = await cedar();
    const decorations = buildDecorations(snapshot, project, true, 'USD');
    expect(decorations.get(WEST_POUR)?.rental).toEqual({ start: '2027-01-21', end: '2027-01-26', equipment: 'Concrete pump', supplier: 'Ridgeway Concrete Pumping', booked: true });
    expect(decorations.get(EAST_POUR)?.rental).toEqual({ start: '2027-01-20', end: '2027-01-23', equipment: 'Concrete pump', supplier: 'Ridgeway Concrete Pumping', booked: false });
  });

  it('new dates on one pour leave the other alone', async () => {
    const { project, snapshot } = await cedar();
    const east = rentalEditFor(snapshot, project, EAST_POUR, true)!;
    expect(east).toMatchObject({ bookingId: null, taskName: 'Pour footings, east wing' });
    await applyRentalDates(project, east, { rentalEnd: '2027-01-29' });
    let decorations = buildDecorations(snapshot, project, true, 'USD');
    expect(decorations.get(EAST_POUR)?.rental).toMatchObject({ start: '2027-01-20', end: '2027-01-29' });
    expect(decorations.get(WEST_POUR)?.rental).toMatchObject({ start: '2027-01-21', end: '2027-01-26' });

    const west = rentalEditFor(snapshot, project, WEST_POUR, true)!;
    expect(west).toMatchObject({ bookingId: CEDAR_IDS.pumpBooking, taskName: 'Pour footings, west wing' });
    await applyRentalDates(project, west, { rentalStart: '2027-01-22' });
    decorations = buildDecorations(snapshot, project, true, 'USD');
    expect(decorations.get(WEST_POUR)?.rental).toMatchObject({ start: '2027-01-22', end: '2027-01-26' });
    expect(decorations.get(EAST_POUR)?.rental).toMatchObject({ start: '2027-01-20', end: '2027-01-29' });
  });

  it('dates set on a machine stay when its task moves; one going by the task’s days follows it', async () => {
    const { project, snapshot } = await cedar();
    const eastTask = project.taskStore.getById(EAST_POUR) as TaskModel;
    const before = rentalSpanOf(snapshot, eastTask)!;
    await runProjectTransaction(project, 'Move', () => {
      void eastTask.setStartDate(new Date(2027, 0, 25), true);
    });
    expect(rentalSpanOf(snapshot, eastTask)!.start).not.toBe(before.start);

    const east = rentalEditFor(snapshot, project, EAST_POUR, true)!;
    await applyRentalDates(project, east, { rentalEnd: addDays(east.end, 2) });
    const pinned = rentalSpanOf(snapshot, eastTask)!;
    await runProjectTransaction(project, 'Move', () => {
      void eastTask.setStartDate(new Date(2027, 1, 1), true);
    });
    expect(rentalSpanOf(snapshot, eastTask)).toEqual(pinned);
  });
});

describe('when the dates can change', () => {
  const editAt = async (stage: Stage) => rentalEditFor(snapshotAt(stage), await load(), 15, true)!;

  it.each<Stage>(['draft', 'checked', 'open-questions', 'one-approval', 'reapprove', 'stale', 'approved', 'plan-failed', 'published', 'send-failed', 'paypal-failed', 'succeeded', 'cancelled'])('%s leaves them free: only money moving holds them', async (stage) => {
    expect((await editAt(stage)).locked).toBeNull();
  });

  it.each<Stage>(['authorized', 'submitted', 'pending', 'unknown'])('PayPal paying (%s) locks them', async (stage) => {
    expect((await editAt(stage)).locked).toContain('PayPal is paying Northgate Equipment Rental');
  });

  it('only the rental’s own task is locked: the same machine elsewhere has no money behind it', async () => {
    const project = await load();
    expect(rentalEditFor(snapshotAt('pending'), project, 15, true)?.locked).toContain('PayPal is paying');
    expect(rentalEditFor(snapshotAt('pending'), project, 16, true)?.locked).toBeNull();
    expect(rentalLockOf(snapshotAt('published'), 15, 4)).toBeNull();
    expect(rentalLockOf(snapshotAt('pending'), 15, 4)).toContain('PayPal is paying');
    expect(rentalLockOf(snapshotAt('pending'), 16, 4)).toBeNull();
    expect(rentalLockOf(snapshotAt('succeeded'), 15, 4)).toBeNull();
  });
});
