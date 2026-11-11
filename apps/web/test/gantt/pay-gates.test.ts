/**
 * Payment holds on Harbor Street Offices, with the real scheduling engine and two browsers on one relay. The seed's
 * hold after the footings keeps the slab from starting until the footings are paid for; the payment is worked out
 * from percent complete; the engine, branched, says what paying late costs without sending anything to anyone;
 * setting the payment for a later day moves the plan for everyone; paying records what each task got. A hold can
 * also be added after any part of the plan.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DateHelper, type CalendarModel, type ProjectModel, type TaskModel } from '@bryntum/gantt';
import { HARBOR_FOOTINGS_PAID, harborOffices } from '@collab/shared/seed';
import { dueDay, forecastLatePayment, handoverTask, onWorkingTime } from '../../src/gantt/late-payment';
import { addPayGate, gateFor, gateIndex, heldBy, payOn, paymentOf, recordPaid, recordPartlyPaid, scheduledPayDay } from '../../src/gantt/pay-gates';
import { runProjectTransaction } from '../../src/scenario/publish';
import { InMemoryRelay } from '../../src/sync/in-memory-relay';
import { PROJECT_ID, disposeAll, joinClient, loadResult, settle, type Client } from '../sync/helpers';

const FOOTINGS = 20;
const SLAB = 30;
const GRAVEL_BASE = 31;
const STRIP_AND_BACKFILL = 24;
const LEVEL_1 = 100;
const LEVEL_2 = 200;
const LAY_OUT_LEVEL_2 = 211;

let clients: Client[] = [];
afterEach(() => {
  disposeAll(clients);
  clients = [];
});

async function twoBrowsers(): Promise<{ relay: InMemoryRelay; a: Client; b: Client }> {
  const snapshot = structuredClone(harborOffices.inlineData) as never;
  const relay = new InMemoryRelay({ projectId: PROJECT_ID, snapshot });
  const a = await joinClient(relay, 'client-a', loadResult(structuredClone(snapshot)));
  const b = await joinClient(relay, 'client-b', loadResult(structuredClone(snapshot)));
  clients = [a, b];
  await settle(clients, relay);
  return { relay, a, b };
}

const taskOf = (project: ProjectModel, id: number | string) => project.taskStore.getById(id) as TaskModel;
const day = (value: unknown) => (value instanceof Date ? DateHelper.format(value, 'ddd YYYY-MM-DD') : String(value));
const footingsGate = (project: ProjectModel) => gateFor(project, taskOf(project, HARBOR_FOOTINGS_PAID))!;
const calendarOf = (project: ProjectModel) => (project as unknown as { calendar: CalendarModel }).calendar;
const footingsWork = (project: ProjectModel) => (taskOf(project, FOOTINGS).children as TaskModel[]).filter((task) => task.isLeaf && !task.isMilestone);

describe('the hold after the footings', () => {
  it('holds the slab until the footings are paid for, and owes each firm its reported work less 10% kept back', async () => {
    const { a, b } = await twoBrowsers();
    for (const { project } of [a, b]) {
      const gate = footingsGate(project);
      expect(gate.task.name).toBe('Footings paid');
      expect(gate.pays.map((row) => row.id)).toEqual([FOOTINGS]);
      expect(gate.holds.map((row) => row.id)).toEqual([SLAB]);
      expect(heldBy(project, taskOf(project, GRAVEL_BASE))?.id).toBe(HARBOR_FOOTINGS_PAID);
      expect(heldBy(project, taskOf(project, STRIP_AND_BACKFILL))).toBeNull();
      expect(day(dueDay(gate))).toBe('Tue 2026-11-10');
      // Paid on time, the slab starts the next morning and the keys change hands on May 27.
      expect(day(taskOf(project, GRAVEL_BASE).startDate)).toBe('Wed 2026-11-11');
      expect(day(handoverTask(project)?.startDate)).toBe('Thu 2027-05-27');
    }
    // The footings are reported done: $42,000 of work, $4,200 kept back. October's payment for the site work isn't in it.
    const payment = paymentOf(footingsGate(a.project));
    expect(payment.valueMinor).toBe(4_200_000);
    expect(payment.retainedMinor).toBe(420_000);
    expect(payment.paidBeforeMinor).toBe(0);
    expect(payment.dueMinor).toBe(3_780_000);
    expect(payment.firms.map((firm) => [firm.firm, firm.dueMinor])).toEqual([
      ['Granite Ridge Concrete', 3_132_000],
      ['Pinecrest Sitework', 648_000],
    ]);
  });

  it('owes the same with a search in the chart that hides the footings’ work', async () => {
    const { a } = await twoBrowsers();
    const { project } = a;
    const before = paymentOf(footingsGate(project));
    expect(before.dueMinor).toBe(3_780_000);
    // A search for something else: the footings' tasks are filtered out of the chart, not out of the plan.
    project.taskStore.filter({ id: 'search', filterBy: (task: TaskModel) => /^Pour slab/i.test(task.name ?? '') });
    try {
      // The chart shows none of the footings' tasks now...
      expect(footingsWork(project)).toEqual([]);
      // ...and the payment still owes all of them.
      expect(paymentOf(footingsGate(project))).toEqual(before);
      expect(heldBy(project, taskOf(project, GRAVEL_BASE))?.id).toBe(HARBOR_FOOTINGS_PAID);
    } finally {
      project.taskStore.clearFilters();
    }
  });

  it('asks a branch of the engine what paying late costs, and the plan and the relay never hear of it', async () => {
    const { relay, a } = await twoBrowsers();
    const revisions = relay.revisionCount;
    const datesBefore = (a.project.taskStore.allRecords as TaskModel[]).map((task) => `${task.id}:${day(task.startDate)}:${day(task.endDate)}`);

    const forecast = (await forecastLatePayment(a.project, footingsGate(a.project), [1, 2, 3]))!;
    expect(forecast.method).toBe('branch');
    expect(day(forecast.dueOn)).toBe('Tue 2026-11-10');
    expect(day(forecast.onTime.handover)).toBe('Thu 2027-05-27');
    const rows = forecast.cases.map((late) => [day(late.payOn), day(late.heldStart), day(late.handover), late.handoverSlip, late.workingDaysLost]);
    expect(rows).toEqual([
      // A day late, the rebar is still ready for the inspector before she leaves: one working day.
      ['Wed 2026-11-11', 'Thu 2026-11-12', 'Fri 2027-05-28', 1, 1],
      // Two or three days late, the rebar finishes on or after Fri, Nov 20, too late for her: she is away until Mon, Nov 30.
      // Seven working days either way.
      ['Thu 2026-11-12', 'Fri 2026-11-13', 'Tue 2027-06-08', 12, 7],
      ['Fri 2026-11-13', 'Mon 2026-11-16', 'Tue 2027-06-08', 12, 7],
    ]);
    expect(forecast.cases[0]!.holidays).toEqual([]);
    // The cost is the inspector's week; the slip also runs over Memorial Day, so the holiday is named.
    expect(forecast.cases[1]!.holidays).toEqual(['Memorial Day']);
    // Everything from the slab to the handover, the inspection included.
    expect(forecast.cases[1]!.moved).toBe(48);

    await settle(clients, relay);
    expect(relay.revisionCount).toBe(revisions);
    expect((a.project.taskStore.allRecords as TaskModel[]).map((task) => `${task.id}:${day(task.startDate)}:${day(task.endDate)}`)).toEqual(datesBefore);
    expect(a.project.taskStore.changes).toBeNull();
  });

  it('says when working Saturdays on the slab would win the days back', async () => {
    const { a } = await twoBrowsers();
    const late = (await forecastLatePayment(a.project, footingsGate(a.project), [2]))!.cases[0]!;
    expect(day(late.handover)).toBe('Tue 2027-06-08');
    // Two days late, the slab on the plan's Monday-to-Saturday calendar has the rebar ready on Thu, Nov 19, so the
    // inspector still comes on Fri, Nov 20, before she leaves. Three Saturdays win back the two days and one more: a
    // day ahead of the plan. (The same date with her on her own calendar: she is in that Friday either way.)
    expect(late.recovery).toMatchObject({ calendar: 'Site (Mon-Sat)', handoverSlip: -1 });
    expect(day(late.recovery!.handover)).toBe('Wed 2027-05-26');
    // Asked on a branch: the live tasks keep their own calendar.
    expect((taskOf(a.project, GRAVEL_BASE) as unknown as { calendar: { id: unknown } | null }).calendar?.id ?? null).not.toBe('site');
  });

  it('still answers when a contractual finish date downstream is broken by the late payment', async () => {
    const { relay, a } = await twoBrowsers();
    // The lease says the tenant moves in by Fri, May 28.
    await runProjectTransaction(a.project, 'Contract handover', () => handoverTask(a.project)!.set({ constraintType: 'finishnolaterthan', constraintDate: new Date(2027, 4, 28) }));
    await settle(clients, relay);
    const forecast = (await forecastLatePayment(a.project, footingsGate(a.project), [3]))!;
    expect(forecast.method).toBe('branch');
    expect(forecast.cases[0]!.handoverSlip).toBeGreaterThan(0);
    expect(day(forecast.onTime.handover)).toBe('Thu 2027-05-27');
  });

  it('moves the plan for everyone when the payment is set for a later day, and back when it is paid', async () => {
    const { relay, a, b } = await twoBrowsers();
    await payOn(a.project, HARBOR_FOOTINGS_PAID, new Date(2026, 10, 12));
    await settle(clients, relay);
    for (const { project } of [a, b]) {
      expect(day(taskOf(project, GRAVEL_BASE).startDate)).toBe('Fri 2026-11-13');
      // The inspection waits for her return on Mon, Nov 30; the final clean ends on Monday evening, Jun 7, and the keys
      // change hands on Tuesday morning, a working day.
      expect(day(handoverTask(project)?.startDate)).toBe('Tue 2027-06-08');
      expect(day(onWorkingTime(calendarOf(project), handoverTask(project)!.startDate as Date))).toBe('Tue 2027-06-08');
      const held = footingsGate(project);
      expect(day(dueDay(held))).toBe('Tue 2026-11-10');
      expect(day(scheduledPayDay(held))).toBe('Thu 2026-11-12');
    }

    await recordPaid(a.project, HARBOR_FOOTINGS_PAID, paymentOf(footingsGate(a.project)), 'BATCH-TEST-1', new Date(2026, 10, 10, 12, 0));
    await settle(clients, relay);
    for (const { project } of [a, b]) {
      const paid = footingsGate(project);
      expect(paid.payGate).toMatchObject({ state: 'paid', batchId: 'BATCH-TEST-1', amountMinor: 3_780_000 });
      expect(paid.holding).toBe(false);
      expect(heldBy(project, taskOf(project, GRAVEL_BASE))).toBeNull();
      expect(gateIndex(project).held.size).toBe(0);
      // Paid now: the slab is back on its dates, and so is the handover.
      expect(day(taskOf(project, GRAVEL_BASE).startDate)).toBe('Wed 2026-11-11');
      expect(day(handoverTask(project)?.startDate)).toBe('Thu 2027-05-27');
      const paidSum = footingsWork(project).reduce((sum, task) => sum + ((task as unknown as { paidMinor: number }).paidMinor ?? 0), 0);
      expect(paidSum).toBe(3_780_000);
      // Nothing more is due on the footings until handover releases what is kept back.
      expect(paymentOf(paid).dueMinor).toBe(0);
    }
  });

  it('when PayPal pays one firm and refuses the other, keeps the hold and leaves only the other firm to pay', async () => {
    const { relay, a, b } = await twoBrowsers();
    const payment = paymentOf(footingsGate(a.project));
    expect(payment.firms.map((firm) => [firm.firm, firm.dueMinor])).toEqual([
      ['Granite Ridge Concrete', 3_132_000],
      ['Pinecrest Sitework', 648_000],
    ]);

    await recordPartlyPaid(a.project, HARBOR_FOOTINGS_PAID, payment, new Set(['Granite Ridge Concrete']), 'Pinecrest Sitework: failed at PayPal.');
    await settle(clients, relay);
    for (const { project } of [a, b]) {
      const gate = footingsGate(project);
      expect(gate.payGate).toMatchObject({ state: 'failed', batchKey: null, error: 'Pinecrest Sitework: failed at PayPal.', partPaidMinor: 3_132_000 });
      expect(gate.holding).toBe(true);
      expect(heldBy(project, taskOf(project, GRAVEL_BASE))?.id).toBe(HARBOR_FOOTINGS_PAID);
      const left = paymentOf(gate);
      expect(left.dueMinor).toBe(648_000);
      expect(left.firms.filter((firm) => firm.dueMinor > 0).map((firm) => firm.firm)).toEqual(['Pinecrest Sitework']);
    }

    await recordPaid(a.project, HARBOR_FOOTINGS_PAID, paymentOf(footingsGate(a.project)), 'BATCH-TEST-2', new Date(2026, 10, 10, 12, 0));
    await settle(clients, relay);
    for (const { project } of [a, b]) {
      const paid = footingsGate(project);
      expect(paid.payGate).toMatchObject({ state: 'paid', batchId: 'BATCH-TEST-2', amountMinor: 3_780_000 });
      expect(paid.payGate.partPaidMinor ?? null).toBeNull();
      expect(paid.holding).toBe(false);
      expect(paymentOf(paid).dueMinor).toBe(0);
    }
  });
});

describe('adding a hold', () => {
  it('goes in after level 1 as one revision both browsers apply, holds level 2, and moves nothing', async () => {
    const { relay, a, b } = await twoBrowsers();
    const before = relay.revisionCount;
    const layOutBefore = day(taskOf(a.project, LAY_OUT_LEVEL_2).startDate);
    const added = await addPayGate(a.project, taskOf(a.project, LEVEL_1));
    await settle(clients, relay);
    expect(relay.revisionCount - before).toBeGreaterThanOrEqual(1);
    // Numbered by the server once saved.
    const gateId = added.id;
    expect(typeof gateId).toBe('number');
    for (const { project } of [a, b]) {
      const gate = gateFor(project, taskOf(project, gateId))!;
      expect(gate.task.name).toBe('Level 1 build-out paid');
      expect(gate.task.parent?.id).toBe(LEVEL_1);
      expect(gate.holds.map((row) => row.id)).toEqual([LEVEL_2]);
      expect(heldBy(project, taskOf(project, LAY_OUT_LEVEL_2))?.id).toBe(gateId);
      expect(day(taskOf(project, LAY_OUT_LEVEL_2).startDate)).toBe(layOutBefore);
      expect(day(handoverTask(project)?.startDate)).toBe('Thu 2027-05-27');
      expect(gate.task.constraintType ?? null).toBeNull();
      // Nothing on level 1 is reported done yet, so nothing is due.
      expect(paymentOf(gate).dueMinor).toBe(0);
    }
  });
});
