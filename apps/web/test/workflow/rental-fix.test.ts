/**
 * Accepting what the review card suggests, and taking it back: ordinary changes for everyone, with the forecast following
 * the days and the work following the machine when a double booking is what got fixed.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AssignmentModel, ResourceModel, TaskModel } from '@bryntum/gantt';
import { toDateOnly, type EquipmentBookingRow } from '@collab/shared';
import { riversideClinic } from '@collab/shared/seed';
import { InMemoryRelay } from '../../src/sync/in-memory-relay';
import { applyRentalFix, undoRentalFix } from '../../src/workflow/rental-fix';
import type { RentalFix } from '../../src/workflow/review';
import { PROJECT_ID, disposeAll, joinClient, loadResult, settle, type Client } from '../sync/helpers';

const { booking } = riversideClinic;
const TASK = booking.task_id;
const row = { ...booking, id: '00000000-0000-4000-8000-000000000101', project_id: PROJECT_ID, quoted_start: booking.billable_start, quoted_end: booking.billable_end } as unknown as EquipmentBookingRow;

let clients: Client[] = [];
afterEach(() => {
  disposeAll(clients);
  clients = [];
});

async function twoClients(): Promise<{ relay: InMemoryRelay; a: Client; b: Client }> {
  const snapshot = structuredClone(riversideClinic.inlineData);
  const relay = new InMemoryRelay({ projectId: PROJECT_ID, snapshot });
  const a = await joinClient(relay, 'client-a', loadResult(structuredClone(snapshot)));
  const b = await joinClient(relay, 'client-b', loadResult(structuredClone(snapshot)));
  clients = [a, b];
  await settle(clients, relay);
  return { relay, a, b };
}

const task = (client: Client) => client.project.taskStore.getById(TASK) as TaskModel & { forecastMinor?: number | null; constraintType: string | null; constraintDate: Date | null };
const machine = (client: Client) => ((task(client).assignments ?? []) as AssignmentModel[]).find((assignment) => (assignment.resource as ResourceModel | null)?.id === booking.resource_id) as AssignmentModel & { rentalStart: string; rentalEnd: string };

const fix: RentalFix = { label: 'A working day either side', start: '2026-12-10', end: '2026-12-19', days: 9, costMinor: 540_000, savingMinor: 120_000, moveWorkTo: null };

describe('accepting a rental fix', () => {
  it('puts the dates on the machine for everyone, leaves the work where it is, and takes what it saves off the forecast', async () => {
    const { relay, a, b } = await twoClients();
    const start = task(b).startDate;
    const forecast = task(b).forecastMinor!;
    await applyRentalFix(a.project, row, fix);
    await settle(clients, relay);
    expect([machine(b).rentalStart, machine(b).rentalEnd]).toEqual(['2026-12-10', '2026-12-19']);
    expect(task(b).startDate).toEqual(start);
    expect(task(b).constraintType).toBeNull();
    // 11 days down to 9, at $600.
    expect(task(b).forecastMinor).toBe(forecast - 120_000);
  });

  it('makes the work wait for the machine when that is the fix, and one Undo takes it all back', async () => {
    const { relay, a, b } = await twoClients();
    const start = toDateOnly(task(b).startDate as Date);
    const forecast = task(b).forecastMinor!;
    const moved = { ...fix, start: '2026-12-14', end: '2026-12-22', moveWorkTo: '2026-12-14' };
    await applyRentalFix(a.project, row, moved);
    await settle(clients, relay);
    expect(toDateOnly(task(b).startDate as Date)).toBe('2026-12-14');
    expect(task(b).constraintType).toBe('startnoearlierthan');

    await undoRentalFix(a.project, { ...row, billable_start: moved.start, billable_end: moved.end }, );
    await settle(clients, relay);
    expect(toDateOnly(task(b).startDate as Date)).toBe(start);
    expect(task(b).constraintType).toBeNull();
    expect([machine(b).rentalStart, machine(b).rentalEnd]).toEqual([booking.billable_start, booking.billable_end]);
    expect(task(b).forecastMinor).toBe(forecast);
  });

  it('is one step of the toolbar undo', async () => {
    const { relay, a, b } = await twoClients();
    const forecast = task(b).forecastMinor!;
    await applyRentalFix(a.project, row, fix);
    await settle(clients, relay);
    (a.project.stm as unknown as { undo(): void }).undo();
    await settle(clients, relay);
    expect(machine(b).rentalStart).not.toBe('2026-12-10');
    expect(task(b).forecastMinor).toBe(forecast);
  });

  it('says so when the task or the machine has gone', () => {
    return twoClients().then(({ a }) => {
      expect(() => applyRentalFix(a.project, { ...row, task_id: 999_999 }, fix)).toThrow(/no longer in the plan/);
      expect(() => applyRentalFix(a.project, { ...row, resource_id: 999_999 }, fix)).toThrow(/no longer on the task/);
    });
  });
});
