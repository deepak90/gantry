import { describe, expect, it } from 'vitest';
import { FakeDb } from '../src/dev/fake';
import { CEDAR_IDS, cedarParkClinic } from '@collab/shared/seed';
import { taskDetail } from '../src/plan/analysis';
import { doubleBooked, findIssues } from '../src/plan/detectors';
import { planFromRows, type PlanRows } from '../src/plan/rows';
import type { PlanSnapshot } from '../src/plan/snapshot';
import { overbookedDays } from '../src/plan/watch';
import { rentalChoices } from '../src/plan/whatif';

function seedPlan(mutate?: (db: FakeDb) => void) {
  const db = new FakeDb();
  mutate?.(db);
  return planFromRows(db.plan);
}

describe('plan from database rows', () => {
  it('reads the seed snapshot: tasks, members with names, the crane booking', () => {
    const plan = seedPlan();
    expect(plan.tasks.find((task) => task.id === 15)?.start).toBe('2026-12-11');
    // One role for everyone: both are full members who see costs, labeled "Member".
    expect(plan.members.map((member) => `${member.name}:${member.roleLabel}:${member.canViewCosts}:${member.approvalLimitMinor}`)).toEqual(['Chris Hale:Member:true:25000000', 'Deepak Jayaram:Member:true:25000000']);
    expect(plan.bookings[0]).toMatchObject({ taskId: 15, rentalRateMinor: 60000, billableStart: '2026-12-07', billableEnd: '2026-12-18' });
    expect(plan.statusDate).toBe('2026-11-11');
  });

  it('lays later revisions over the snapshot (updated and added tasks, removed ones dropped)', () => {
    const plan = seedPlan((db) => {
      db.plan.revisions = [
        { revision_no: 1, changes: { tasks: { updated: [{ id: 15, startDate: '2026-12-14T00:00:00', endDate: '2026-12-21T00:00:00' }] } } },
        { revision_no: 2, changes: { tasks: { added: [{ id: 999, name: 'Extra inspection', parentId: 240, startDate: '2026-12-21', endDate: '2026-12-22' }], removed: [{ id: 243 }] } } },
      ];
    });
    expect(plan.tasks.find((task) => task.id === 15)).toMatchObject({ start: '2026-12-14', end: '2026-12-21' });
    expect(plan.tasks.find((task) => task.id === 999)?.name).toBe('Extra inspection');
    expect(plan.tasks.some((task) => task.id === 243)).toBe(false);
  });
});

describe('issues and the what-if', () => {
  it('finds the idle crane, worth raising, with the $2,400 overrun explained by it', () => {
    const issues = findIssues(seedPlan());
    const top = issues[0]!;
    // Nothing is paid yet: all four idle days can still be dropped from the rental.
    expect(top).toMatchObject({ kind: 'idle_equipment', worth_raising: true, at_stake_minor: 240000, avoidable_minor: 240000 });
    expect(top.remedy).toMatch(/^Cut the rental to the work and a sensible cover around it; nothing is paid yet/);
    expect(top.facts).toMatchObject({ idle_days_before_start: 4, idle_days_after_finish: 0, rental_rate_minor: 60000 });
    expect(issues.find((issue) => issue.kind === 'over_budget' && issue.task_ids[0] === 15)?.explained_by).toBe(top.id);
  });

  it('is quiet when the booking already starts with the work (the fix is in the plan)', () => {
    const plan = seedPlan((db) => {
      db.plan.bookings[0]!.billable_start = '2026-12-11';
    });
    expect(findIssues(plan).filter((issue) => issue.worth_raising)).toEqual([]);
  });

  it('is quiet about a working day of cover either side: that is how a machine should be booked', () => {
    const plan = seedPlan((db) => {
      db.plan.bookings[0]!.billable_start = '2026-12-10';
      db.plan.bookings[0]!.billable_end = '2026-12-19';
    });
    expect(findIssues(plan).filter((issue) => issue.kind === 'idle_equipment')).toEqual([]);
  });

  it('works out what the rental could be, by the calendar day, with what each option does to the money', () => {
    const choices = rentalChoices(seedPlan());
    expect(choices.now).toMatchObject({ first_day: '2026-12-07', last_day: '2026-12-17', days: 11, cost_minor: 660000, idle_days_before: 4, idle_days_after: 0 });
    // A working day either side: Thu, Dec 10 to Fri, Dec 18.
    expect(choices.recommended).toMatchObject({
      first_day: '2026-12-10',
      last_day: '2026-12-18',
      days: 9,
      cost_minor: 540000,
      saving_minor: 120000,
      covers_the_work: true,
      op: { op: 'set_rental', task: 15, machine: 'Crane', first_day: '2026-12-10', last_day: '2026-12-18' },
    });
    expect(choices.recommended!.text.change).toBe('saves $1,200.00');
    expect(choices.alternatives.map((option) => [option.label, option.days])).toEqual([
      ['Just the days of the work', 7],
      ['A working day after', 8],
      ['A working day before', 8],
    ]);
    expect(choices.activity).toMatchObject({ task_id: 15, first_day: '2026-12-11', last_day: '2026-12-17' });
    expect(choices.asked).toBeNull();
  });

  it('works out what someone asked for, in working days or named dates', () => {
    const plan = seedPlan();
    // Two working days ahead of a Friday start: Wed, Dec 9.
    expect(rentalChoices(plan, { padBefore: 2, padAfter: 0 }).asked).toMatchObject({ first_day: '2026-12-09', last_day: '2026-12-17', days: 9 });
    const longer = rentalChoices(plan, { firstDay: '2026-12-07', lastDay: '2026-12-18' }).asked!;
    expect(longer).toMatchObject({ days: 12, cost_minor: 720000, saving_minor: -60000 });
    expect(longer.text.change).toBe('costs $600.00 more');
    expect(rentalChoices(plan, { firstDay: '2026-12-14', lastDay: '2026-12-16' }).asked!.covers_the_work).toBe(false);
  });

  it('counts the cover in calendar days when that is how it was asked for ("a day either side")', () => {
    const plan = seedPlan();
    // The work runs Fri, Dec 11 to Thu, Dec 17, on the site calendar (Saturdays worked, Sundays off). Three days after:
    // Sun, Dec 20 as calendar days; Mon, Dec 21 as working days (Fri, Sat, then Monday). Working days unless said.
    expect(rentalChoices(plan, { padBefore: 0, padAfter: 3, padIn: 'calendar' }).asked).toMatchObject({ first_day: '2026-12-11', last_day: '2026-12-20', days: 10 });
    expect(rentalChoices(plan, { padBefore: 0, padAfter: 3, padIn: 'working' }).asked).toMatchObject({ last_day: '2026-12-21', days: 11 });
    expect(rentalChoices(plan, { padBefore: 0, padAfter: 3 }).asked).toMatchObject({ last_day: '2026-12-21' });
  });
});

describe('a machine booked twice, as the assistant and the rules read it', () => {
  const PUMP = 2;
  const EAST_POUR = 113;
  const WEST_POUR = 114;
  const cedarRows = (revisions: PlanRows['revisions'] = []): PlanRows => ({
    project: { id: CEDAR_IDS.project, name: 'Cedar Park Clinic', currency: 'USD', current_revision: revisions.length, handover_task_id: cedarParkClinic.handover_task_id, snapshot: cedarParkClinic.inlineData as unknown as PlanRows['project']['snapshot'] },
    revisions,
    bookings: [],
    members: [],
    profiles: [],
  });
  const pumpOnEast = (cedarParkClinic.inlineData.assignmentsData as { id: number; event: number; resource: number }[]).find((row) => row.event === EAST_POUR && row.resource === PUMP)!.id;
  const narrowed = (end: string): PlanRows['revisions'] => [{ revision_no: 1, changes: { assignments: { updated: [{ id: pumpOnEast, rentalStart: '2027-01-20', rentalEnd: end }] } } }];
  const pumpIssues = (plan: PlanSnapshot) => doubleBooked(plan).filter((issue) => issue.id.startsWith(`double_booked:${PUMP}:`));
  const pumpClashes = (plan: PlanSnapshot) => overbookedDays(plan).filter((clash) => clash.crewId === PUMP);

  it('finds both pours needing the pump on the same days, and says the ways out', () => {
    const plan = planFromRows(cedarRows());
    const [issue] = pumpIssues(plan);
    expect(issue).toMatchObject({ kind: 'double_booked', title: 'Concrete pump needed twice on 2 days', worth_raising: true, task_ids: [EAST_POUR, WEST_POUR] });
    expect(issue!.why).toMatch(/change the dates of the machine on one of them, or rent a second machine/);
    expect(pumpClashes(plan)).toEqual([{ crewId: PUMP, firstDay: '2027-01-21', days: 2, taskIds: [EAST_POUR, WEST_POUR] }]);
  });

  it('sees when one pour’s dates no longer overlap', () => {
    const plan = planFromRows(cedarRows(narrowed('2027-01-21')));
    expect(pumpIssues(plan)).toEqual([]);
    expect(pumpClashes(plan)).toEqual([]);
  });

  it('still sees a partial overlap', () => {
    const plan = planFromRows(cedarRows(narrowed('2027-01-22')));
    expect(pumpIssues(plan)[0]).toMatchObject({ title: 'Concrete pump needed twice on 1 day' });
    expect(pumpClashes(plan)).toEqual([{ crewId: PUMP, firstDay: '2027-01-21', days: 1, taskIds: [EAST_POUR, WEST_POUR] }]);
  });

  it('can read a machine’s own dates on a task', () => {
    const plan = planFromRows(cedarRows(narrowed('2027-01-22')));
    const crew = (id: number) => taskDetail(plan, id)?.crews.find((row) => row.name === 'Concrete pump');
    expect(crew(EAST_POUR)?.on_site).toEqual({ from: '2027-01-20', last_day: '2027-01-21' });
    expect(crew(WEST_POUR)?.on_site).toEqual({ from: '2027-01-21', last_day: '2027-01-25' });
  });
});
