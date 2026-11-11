/**
 * The watch list's rules on a small plan: scopes (the plan, a group and everything under it, a date
 * window, a crew), each condition, many hits folding into one alert, fingerprints that change when a
 * situation gets worse while its situation key stays, money hidden from people who may not see it,
 * disabled rules staying quiet, the rule sentence (when / then) and the recipes.
 */
import { describe, expect, it } from 'vitest';
import { WATCH_RECIPES, WatchAction, WatchCondition, WatchRuleRow, WatchScope, WatchTrigger, clockTime, describeAction, describeRule, describeTrigger, evaluateWatch, tasksInScope, type WatchPlan, type WatchTask } from '../src/watch';

const task = (id: number, overrides: Partial<WatchTask> = {}): WatchTask => ({
  id,
  name: `Task ${id}`,
  wbs: `1.${id}`,
  parentId: 1,
  isLeaf: true,
  isMilestone: false,
  start: '2026-11-02',
  end: '2026-11-07',
  startSlipDays: 0,
  finishSlipDays: 0,
  slackDays: 5,
  percentDone: 0,
  budgetMinor: 100_000,
  forecastMinor: 100_000,
  spentMinor: 0,
  crewIds: [],
  idle: null,
  ...overrides,
});

function plan(tasks: WatchTask[], overbooked: WatchPlan['overbooked'] = []): WatchPlan {
  return { today: '2026-10-30', tasks: [task(1, { parentId: null, isLeaf: false, name: 'Spread footings' }), ...tasks], crews: [{ id: 7, name: 'Concrete crew' }], overbooked };
}

const rule = (scope: WatchScope, condition: WatchCondition, enabled = true) => ({ id: '00000000-0000-4000-8000-00000000e001', name: 'A rule', scope, condition, enabled });
const options = { canViewCosts: true, currency: 'USD' as const };

describe('scopes', () => {
  it('covers the plan, a group with everything under it, a date window and a crew', () => {
    const p = plan([task(2), task(3, { parentId: 2 }), task(4, { parentId: null, start: '2026-12-01', end: '2026-12-03', crewIds: [7] })]);
    expect(tasksInScope({ kind: 'plan' }, p)).toHaveLength(4);
    expect(tasksInScope({ kind: 'tasks', task_ids: [1] }, p).map((t) => t.id)).toEqual([1, 2, 3]);
    expect(tasksInScope({ kind: 'dates', from: '2026-12-02', to: '2026-12-10' }, p).map((t) => t.id)).toEqual([4]);
    // The end is exclusive: a task ending (exclusive) on the window's first day has no work in it.
    expect(tasksInScope({ kind: 'dates', from: '2026-12-03', to: '2026-12-10' }, p)).toHaveLength(0);
    expect(tasksInScope({ kind: 'crew', resource_ids: [7] }, p).map((t) => t.id)).toEqual([4]);
  });
});

describe('conditions', () => {
  it('flags late finishes (milestones are urgent), with a fingerprint that moves when the slip grows', () => {
    const late = plan([task(2, { finishSlipDays: 3, isMilestone: true, name: 'Handover' })]);
    const [alert] = evaluateWatch([rule({ kind: 'plan' }, { kind: 'finish_slip', days: 0 })], late, options);
    expect(alert).toMatchObject({ severity: 'high', title: '1.2 Handover finishes 3 days later than planned', taskIds: [2] });
    const later = evaluateWatch([rule({ kind: 'plan' }, { kind: 'finish_slip', days: 0 })], plan([task(2, { finishSlipDays: 5, isMilestone: true, name: 'Handover' })]), options)[0]!;
    expect(later.fingerprint).not.toBe(alert!.fingerprint);
    expect(later.situation).toBe(alert!.situation);
    expect(evaluateWatch([rule({ kind: 'plan' }, { kind: 'finish_slip', days: 3 })], late, options)).toHaveLength(0);
    // Finished work has nothing left to slip.
    expect(evaluateWatch([rule({ kind: 'plan' }, { kind: 'finish_slip', days: 0 })], plan([task(2, { finishSlipDays: 3, percentDone: 100 })]), options)).toHaveLength(0);
  });

  it('folds many hits into one alert that lists the worst first', () => {
    const many = plan([2, 3, 4, 5, 6, 7].map((id) => task(id, { startSlipDays: id })));
    const alerts = evaluateWatch([rule({ kind: 'plan' }, { kind: 'start_slip', days: 1 })], many, options);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.title).toBe('6 tasks start later than planned');
    expect(alerts[0]!.taskIds[0]).toBe(7);
    expect(alerts[0]!.detail).toContain('and 3 more');
  });

  it('checks slack, budget, spending ahead of the work, and dates', () => {
    const p = plan([
      task(2, { slackDays: 1 }),
      task(3, { forecastMinor: 125_000 }),
      task(4, { spentMinor: 80_000, percentDone: 30 }),
      task(5, { start: '2026-12-21', end: '2026-12-23' }),
    ]);
    expect(evaluateWatch([rule({ kind: 'plan' }, { kind: 'slack_below', days: 2 })], p, options).map((a) => a.title)).toEqual(['1.2 Task 2 has only 1 day of slack']);
    expect(evaluateWatch([rule({ kind: 'plan' }, { kind: 'over_budget', percent: 10 })], p, options)[0]!.title).toBe('1.3 Task 3 is 25% over budget ($250.00)');
    expect(evaluateWatch([rule({ kind: 'plan' }, { kind: 'over_budget', percent: 10 })], p, { ...options, canViewCosts: false })[0]!.title).toBe('1.3 Task 3 is 25% over budget');
    expect(evaluateWatch([rule({ kind: 'plan' }, { kind: 'spent_ahead', points: 40 })], p, options)[0]!.title).toBe('1.4 Task 4: 80% of the money spent, 30% of the work done');
    expect(evaluateWatch([rule({ kind: 'plan' }, { kind: 'in_window', from: '2026-12-22', to: '2026-12-31' })], p, options).map((a) => a.taskIds)).toEqual([[5]]);
  });

  it('raises idle rentals and double-booked crews, and stays quiet when a rule is off', () => {
    const p = plan([task(2, { name: 'Erect steel frame', idle: { days: 4, costMinor: 240_000, equipment: 'Crane' } })], [{ crewId: 7, firstDay: '2026-11-19', days: 2, taskIds: [2, 3] }]);
    expect(evaluateWatch([rule({ kind: 'plan' }, { kind: 'idle_rental' })], p, options)[0]).toMatchObject({ severity: 'high', title: 'Crane booked 4 days with no work planned on Erect steel frame ($2,400.00)' });
    expect(evaluateWatch([rule({ kind: 'crew', resource_ids: [7] }, { kind: 'crew_overbooked' })], p, options)[0]!.title).toBe('Concrete crew booked twice from Thu, Nov 19 (2 days)');
    expect(evaluateWatch([rule({ kind: 'plan' }, { kind: 'idle_rental' }, false)], p, options)).toHaveLength(0);
  });

  it('lists unstarted work starting within a few days of today', () => {
    const p = plan([task(2, { start: '2026-10-30' }), task(3, { start: '2026-11-02' }), task(4, { start: '2026-11-02', percentDone: 10 }), task(5, { start: '2026-11-20' })]);
    const alerts = evaluateWatch([rule({ kind: 'plan' }, { kind: 'starts_soon', days: 3 })], p, options);
    expect(alerts.map((alert) => alert.title)).toEqual(['1.2 Task 2 starts today', '1.3 Task 3 starts in 3 days']);
    expect(alerts[0]!.severity).toBe('low');
  });
});

describe('describeRule', () => {
  it('says what is watched and when it speaks up', () => {
    const names = { task: (id: number) => (id === 42 ? 'Handover' : null), crew: () => 'Concrete crew' };
    expect(describeRule({ scope: { kind: 'tasks', task_ids: [42] }, condition: { kind: 'finish_slip', days: 0 } }, names)).toBe('Handover: finishes later than planned');
    expect(describeRule({ scope: { kind: 'plan' }, condition: { kind: 'idle_rental' } }, names)).toBe('the whole plan: rented equipment paid while idle');
    expect(describeTrigger({ kind: 'change' })).toBe('Every time the plan changes');
    expect(describeTrigger({ kind: 'daily', at: '07:00' })).toBe('Every day at 7:00 AM');
    expect(['00:15', '12:00', '18:30'].map(clockTime)).toEqual(['12:15 AM', '12:00 PM', '6:30 PM']);
    expect(describeAction({ kind: 'ask_assistant' })).toBe('Ask the assistant for alternatives');
  });

  it('reads older rules as "every change, show it", and keeps its recipes valid and switched off', () => {
    const row = WatchRuleRow.parse({ id: '00000000-0000-4000-8000-00000000e001', project_id: '00000000-0000-4000-8000-000000000001', name: 'Old', scope: { kind: 'plan' }, condition: { kind: 'idle_rental' }, enabled: true, created_by: null, created_at: '2026-10-25T00:00:00Z', updated_at: '2026-10-25T00:00:00Z' });
    expect([row.trigger, row.action]).toEqual([{ kind: 'change' }, { kind: 'alert' }]);
    expect(WatchTrigger.safeParse({ kind: 'daily', at: '24:00' }).success).toBe(false);
    for (const recipe of WATCH_RECIPES) {
      expect([WatchScope.safeParse(recipe.scope).success, WatchCondition.safeParse(recipe.condition).success, WatchTrigger.safeParse(recipe.trigger).success, WatchAction.safeParse(recipe.action).success]).toEqual([true, true, true, true]);
    }
  });
});

describe('rules made of blocks', () => {
  const machines = (overbooked: { crewId: number; firstDay: string; days: number; taskIds: number[] }[]) => ({
    today: '2027-01-01',
    tasks: [task(2, { name: 'Erect steel frame', idle: { days: 3, costMinor: 180_000, equipment: 'Crane' } }), task(3, { name: 'Pour, east' }), task(4, { name: 'Pour, west' })],
    crews: [
      { id: 1, name: 'Concrete pump', equipment: true },
      { id: 7, name: 'Concrete crew' },
    ],
    overbooked,
  });
  const any: WatchCondition = { kind: 'any', of: [{ kind: 'idle_rental' }, { kind: 'crew_overbooked', equipment_only: true }] };

  it('raises what any of its conditions raises, and keeps a task raised twice apart', () => {
    const alerts = evaluateWatch([rule({ kind: 'plan' }, any)], machines([{ crewId: 1, firstDay: '2027-01-21', days: 2, taskIds: [3, 4] }]), options);
    expect(alerts.map((alert) => alert.condition).sort()).toEqual(['crew_overbooked', 'idle_rental']);
    expect(new Set(alerts.map((alert) => alert.situation)).size).toBe(2);
  });

  it('leaves crews out when it is about equipment', () => {
    const alerts = evaluateWatch([rule({ kind: 'plan' }, any)], machines([{ crewId: 7, firstDay: '2027-01-21', days: 2, taskIds: [3, 4] }]), options);
    expect(alerts.map((alert) => alert.condition)).toEqual(['idle_rental']);
  });

  it('raises for all of its conditions only where they meet', () => {
    const all: WatchCondition = { kind: 'all', of: [{ kind: 'idle_rental' }, { kind: 'crew_overbooked' }] };
    expect(evaluateWatch([rule({ kind: 'plan' }, all)], machines([{ crewId: 1, firstDay: '2027-01-21', days: 2, taskIds: [3, 4] }]), options)).toHaveLength(0);
    expect(evaluateWatch([rule({ kind: 'plan' }, all)], machines([{ crewId: 1, firstDay: '2027-01-21', days: 2, taskIds: [2, 4] }]), options)).toHaveLength(1);
  });

  it('says a floor is finished once, when every task of the scope under it is done', () => {
    const floors = {
      today: '2027-01-01',
      tasks: [
        task(200, { name: 'Level 2', isLeaf: false, parentId: null }),
        task(21, { parentId: 200, percentDone: 100 }),
        task(22, { parentId: 200, percentDone: 100 }),
        task(300, { name: 'Level 3', isLeaf: false, parentId: null }),
        task(31, { parentId: 300, percentDone: 100 }),
        task(32, { parentId: 300, percentDone: 50 }),
      ],
      crews: [],
      overbooked: [],
    };
    const alerts = evaluateWatch([rule({ kind: 'tasks', task_ids: [21, 22, 31, 32] }, { kind: 'all_done' })], floors, options);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ condition: 'all_done', taskIds: [21, 22], title: '2 tasks finished on Level 2' });
  });

  it('reads as a sentence', () => {
    expect(describeRule({ scope: { kind: 'plan' }, condition: any }, { task: () => null, crew: () => null })).toBe('the whole plan: rented equipment is sitting idle or equipment is booked twice');
  });
});
