/**
 * The fact tools on the seed plan: exact arithmetic (and what it refuses), cost totals that add up
 * whichever way they are split, working days on both calendars across a weekend and the shutdown,
 * milestones, time ranges, the change history replayed from revisions with before and after values,
 * the watch list (rules as sentences, what they raise now, what is open), and the selection a person
 * sends with a message, checked against the plan.
 */
import { describe, expect, it, vi } from 'vitest';
import { describeContext } from '../src/agent/prompts';
import { runDataTool, ToolRefusal, type ToolContext } from '../src/agent/tools';
import { FakeDb } from '../src/dev/fake';
import { calculate } from '../src/plan/calc';
import { planFromRows } from '../src/plan/rows';

function context(mutate?: (db: FakeDb) => void): ToolContext {
  const db = new FakeDb();
  mutate?.(db);
  const rows = db.plan;
  const plan = planFromRows(rows);
  return {
    plan,
    workflow: db.workflow,
    issues: new Map(),
    speaker: plan.members[0]!,
    present: plan.members,
    library: db.library,
    drafts: new Map(),
    edits: new Map(),
    history: { rows, decisions: [] },
    watch: { rules: [], open: [] },
    refresh: async () => undefined,
  };
}

const run = (ctx: ToolContext, name: string, args: unknown) => runDataTool(name as never, args, ctx) as Promise<Record<string, any>>;

describe('calculate', () => {
  it('does decimal math exactly, with percentages, rounding and functions', () => {
    expect(calculate('0.1 + 0.2').value).toBe('0.3');
    expect(calculate('15% * 2400').rounded).toBe('360.00');
    expect(calculate('(forecast - budget) / budget * 100', { forecast: 5200, budget: 4800 }, 1).rounded).toBe('8.3');
    expect(calculate('1/3*3').value).toBe('1');
    expect(calculate('$1,200 + 300').rounded).toBe('1500.00');
    expect(calculate('sqrt(2)', {}, 4).rounded).toBe('1.4142');
    expect(calculate('median([3, 1, 2]) + mean(1, 2, 3, 4)').value).toBe('4.5');
    expect(calculate('2.345', {}, 2).rounded).toBe('2.35');
    expect(calculate('-2.345', {}, 2).rounded).toBe('-2.35');
  });

  it('refuses assignments, code, non-numbers and division by zero', () => {
    expect(() => calculate('x = 3')).toThrow(/assignments/);
    expect(() => calculate('import({})')).toThrow(/import\(\)/);
    expect(() => calculate('evaluate("1+1")')).toThrow(/evaluate\(\)/);
    expect(() => calculate('"text"')).toThrow(/not words or text/);
    expect(() => calculate('[1, 2] + [3, 4]')).toThrow(/tables \(matrices\)/);
    expect(() => calculate('1 / 0')).toThrow(/finite/);
    expect(() => calculate('2 +', {})).toThrow(/Could not work out/);
  });

  it('works out the sums the assistant is asked for: money, days and percentages', () => {
    expect(calculate('sum(31320, 6480)').rounded).toBe('37800.00');
    expect(calculate('days * rate', { days: 11, rate: 600 }).rounded).toBe('6600.00');
    expect(calculate('50 * 700').rounded).toBe('35000.00');
    expect(calculate('100 + 3%').rounded).toBe('103.00');
    expect(calculate('7.5% * rate * days', { rate: '$600', days: 11 }).rounded).toBe('495.00');
    expect(calculate('round(37800 / 2)').rounded).toBe('18900.00');
    expect(calculate('max(0, budget - spent)', { budget: '4,800', spent: 5200 }).rounded).toBe('0.00');
    expect(calculate('min(4, 9) + abs(-5) + 10 % 3 + 2^10').rounded).toBe('1034.00');
    expect(calculate('sqrt(16) + log(100, 10)').rounded).toBe('6.00');
    expect(calculate('(paid / forecast) * 100', { paid: 3780000, forecast: 6600000 }, 1).rounded).toBe('57.3');
    expect(calculate('1e12 - 1').rounded).toBe('999999999999.00');
  });

  it('as a tool, gives money an amount in minor units the grounding check accepts', async () => {
    const ctx = context();
    const result = await run(ctx, 'calculate', { expression: '4 * 600', money: true });
    expect(result).toMatchObject({ rounded: '2400.00', amount_minor: 240000, text: '$2,400.00' });
    const cents = await run(ctx, 'calculate', { expression: '1.005 * 100', money: true, decimals: 0 });
    expect(cents.amount_minor).toBe(10050);
    await expect(run(ctx, 'calculate', { expression: 'x = 3' })).rejects.toBeInstanceOf(ToolRefusal);
  });
});

/** Hostile expressions (and their cousins): refused in plain words before any math. */
describe('calculate refuses anything but plain arithmetic', () => {
  const refused = (expression: string, values: Record<string, number | string> = {}) => {
    const started = performance.now();
    let message = '';
    try {
      calculate(expression, values);
    } catch (error) {
      message = (error as Error).message;
    }
    return { message, ms: performance.now() - started };
  };

  it('refuses the matrix and factorial attack at once, with nothing worked out', () => {
    const { message, ms } = refused('sum(ones(2000,2000)) + factorial(20000)');
    expect(message).toMatch(/^That isn’t a calculation I do: I only work out plain arithmetic on the project’s figures/);
    expect(message).toMatch(/not ones\(\)/);
    expect(ms).toBeLessThan(50);
  });

  it.each([
    ['factorial(100000)', /not factorial\(\)/],
    ['20000!', /not factorials \(!\)/],
    ['gamma(171)', /not gamma\(\)/],
    ['combinations(1000, 500)', /not combinations\(\)/],
    ['ones(10000, 10000)', /not ones\(\)/],
    ['zeros(3, 3)', /not zeros\(\)/],
    ['matrix([1, 2])', /not matrix\(\)/],
    ['sum(1:1000000)', /not ranges \(a:b\)/],
    ['1:3', /not ranges \(a:b\)/],
    ['sum([[1, 2], [3, 4]])', /tables \(matrices\)/],
    ['[1, 2] * 3', /tables \(matrices\)/],
    ['det([1])', /not det\(\)/],
    ['a ? 1 : 2', /not conditions/],
    ['2 > 1', /not comparisons/],
    ["v'", /not transposes/],
    ['true + 1', /not true or false/],
    ['5 inch to cm', /not unit conversions/],
    ['5 inch', /There is no figure called "inch"/],
    ['1 and 0', /not logic/],
    ['pi * 2', /There is no figure called "pi"/],
  ])('refuses %s', (expression, why) => {
    const { message, ms } = refused(expression, { v: 1, a: 1 });
    expect(message).toMatch(why);
    expect(ms).toBeLessThan(50);
  });

  it('refuses numbers over a trillion, given or named, and answers of 16 digits or more', () => {
    expect(refused('1e13').message).toMatch(/^Figures in a calculation go up to 1,000,000,000,000 \(a trillion\)/);
    expect(refused('x * 2', { x: 2e12 }).message).toMatch(/x is bigger than that/);
    expect(refused('x * 2', { x: '2,000,000,000,000' }).message).toMatch(/x is bigger than that/);
    expect(refused('999999999999 * 999999').message).toMatch(/16 digits or more/);
    expect(calculate('999999999999 * 999').rounded).toBe('998999999999001.00');
    for (const huge of ['9^9^9', '1e12^1e12', '1.0000000001^1e12']) expect(refused(huge).message).toMatch(/16 digits or more/);
    expect(refused('2^2^2^2^2^2').message).toMatch(/no finite value/);
  });

  it('refuses what has no real answer, and rounding past 10 places', () => {
    expect(refused('sqrt(-1)').message).toMatch(/no answer in real numbers/);
    expect(refused('log(-1)').message).toMatch(/no answer in real numbers/);
    expect(refused('log(0)').message).toMatch(/no finite value/);
    expect(refused('round(1.5, 11)').message).toMatch(/whole number from 0 to 10/);
    expect(refused('round(1.5, 1e9)').message).toMatch(/whole number from 0 to 10/);
  });

  it('works out the slowest expression it allows well inside the 200 ms budget', () => {
    // 400 characters of fractional powers, the slowest kind of step there is.
    const slowest = `1.0000001${'^1.3'.repeat(97)}`;
    expect(slowest.length).toBeLessThanOrEqual(400);
    const started = performance.now();
    expect(calculate(slowest).rounded).toBe('1.00');
    expect(performance.now() - started).toBeLessThan(200);
  });

  it('stops working once the 200 ms budget is spent', () => {
    let now = 1_000;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => (now += 60));
    try {
      expect(() => calculate('1 + 2 + 3 + 4 + 5 + 6')).toThrow(/took too long to work out, so I stopped/);
    } finally {
      clock.mockRestore();
    }
  });

  it('as a tool, refuses in words the assistant can pass on, and returns no huge number', async () => {
    const ctx = context();
    const refusal = await run(ctx, 'calculate', { expression: 'sum(ones(2000,2000)) + factorial(20000)' }).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ToolRefusal);
    expect((refusal as Error).message.length).toBeLessThan(300);
    await expect(run(ctx, 'calculate', { expression: '10^14 * 10' })).rejects.toThrow(/16 digits or more/);
  });
});

describe('sum_costs', () => {
  it('adds the leaf tasks, and the groups add up to the totals however they are split', async () => {
    const ctx = context();
    const leaves = ctx.plan.tasks.filter((task) => task.isLeaf && !task.inactive);
    const all = await run(ctx, 'sum_costs', {});
    expect(all.totals.budget_minor).toBe(leaves.reduce((sum, task) => sum + task.budgetMinor, 0));
    expect(all.totals.forecast_minor).toBe(leaves.reduce((sum, task) => sum + task.forecastMinor, 0));
    expect(all.totals.over_budget_minor).toBe(all.totals.forecast_minor - all.totals.budget_minor);
    for (const groupBy of ['phase', 'group', 'task']) {
      const split = await run(ctx, 'sum_costs', { group_by: groupBy });
      const listed = split.groups.reduce((sum: number, group: { forecast_minor: number }) => sum + group.forecast_minor, 0);
      // Long splits list the 25 biggest groups and say so.
      if (split.truncated) expect(listed).toBeLessThan(all.totals.forecast_minor);
      else expect(listed).toBe(all.totals.forecast_minor);
    }
    expect((await run(ctx, 'sum_costs', { group_by: 'task' })).truncated).toBe(true);
    const byCrew = await run(ctx, 'sum_costs', { group_by: 'crew' });
    // Shared tasks are split by units, so the crews add up to the total within a cent per task.
    const crewTotal = byCrew.groups.reduce((sum: number, group: { forecast_minor: number }) => sum + group.forecast_minor, 0);
    expect(Math.abs(crewTotal - all.totals.forecast_minor)).toBeLessThanOrEqual(leaves.length);
  });

  it('limits to picked tasks and everything under them', async () => {
    const ctx = context();
    const phase = ctx.plan.tasks.find((task) => task.parentId === null && !task.isLeaf)!;
    const under = ctx.plan.tasks.filter((task) => task.isLeaf && task.phase === phase.name && !task.inactive);
    const result = await run(ctx, 'sum_costs', { task_ids: [phase.id] });
    expect(result.totals.tasks).toBe(under.length);
    expect(result.totals.budget_minor).toBe(under.reduce((sum, task) => sum + task.budgetMinor, 0));
    expect(result.totals.text.budget).toMatch(/^\$/);
  });
});

describe('working time', () => {
  it('counts working days on each calendar, both days included', async () => {
    const ctx = context();
    // Mon, Nov 2 to Sat, Nov 7, 2026: five weekdays, six days on the site calendar.
    expect((await run(ctx, 'count_working_days', { op: 'working_days_between', from: '2026-11-02', to: '2026-11-07' })).working_days).toBe(5);
    const site = await run(ctx, 'count_working_days', { op: 'working_days_between', from: '2026-11-02', to: '2026-11-07', calendar: 'site' });
    expect(site).toMatchObject({ calendar: 'site', working_days: 6, calendar_days: 6 });
  });

  it('knows the shutdown, adds and subtracts working days, and finds the next one', async () => {
    const ctx = context();
    const shutdown = await run(ctx, 'count_working_days', { op: 'working_days_between', from: '2026-12-21', to: '2027-01-08' });
    expect(shutdown.working_days).toBe(8);
    expect(shutdown.days_off['holiday shutdown']).toBe(11);
    expect(await run(ctx, 'count_working_days', { op: 'is_working_day', date: '2026-12-28' })).toMatchObject({ working: false, why_not: 'holiday shutdown' });
    expect(await run(ctx, 'count_working_days', { op: 'next_working_day', date: '2026-12-24' })).toMatchObject({ date: '2027-01-04' });
    // Five working days from Thu, Nov 19: Thu, Fri, Mon, Tue, Wed.
    expect(await run(ctx, 'count_working_days', { op: 'add_working_days', from: '2026-11-19', days: 5 })).toMatchObject({ first_day: '2026-11-19', last_day: '2026-11-25' });
    expect(await run(ctx, 'count_working_days', { op: 'subtract_working_days', from: '2026-11-23', days: 1 })).toMatchObject({ date: '2026-11-20' });
    await expect(run(ctx, 'count_working_days', { op: 'add_working_days', from: '2026-11-19' })).rejects.toThrow(/needs days/);
  });

  it('takes the calendar of a crew or a task', async () => {
    const ctx = context();
    const siteCrew = ctx.plan.resources.find((resource) => resource.calendar === 'site');
    if (!siteCrew) return;
    const result = await run(ctx, 'count_working_days', { op: 'is_working_day', date: '2026-11-07', calendar: siteCrew.name });
    expect(result).toMatchObject({ calendar: 'site', working: true });
  });
});

describe('calendars, milestones and time ranges', () => {
  it('lists both calendars, the shutdown, and the milestones with the handover marked', async () => {
    const ctx = context();
    const calendars = await run(ctx, 'get_calendars', {});
    expect(calendars.calendars.map((calendar: { id: string }) => calendar.id)).toEqual(['standard', 'site']);
    expect(calendars.holidays[0]).toMatchObject({ first_day: '2026-12-24', last_day: '2027-01-03' });
    const found = await run(ctx, 'get_milestones', {});
    expect(found.count).toBeGreaterThan(0);
    expect(found.milestones.filter((row: { is_handover: boolean }) => row.is_handover)).toHaveLength(1);
    const dates = found.milestones.map((row: { date: string }) => row.date);
    expect([...dates].sort()).toEqual(dates);
    const ranges = await run(ctx, 'get_time_ranges', {});
    expect(ranges.ranges[0]).toMatchObject({ kind: 'holiday' });
    expect((await run(ctx, 'get_time_ranges', { to: '2026-12-01' })).count).toBe(0);
  });
});

describe('the change history', () => {
  it('replays revisions with before and after values, newest first, and filters by task', async () => {
    let moved = 0;
    const ctx = context((db) => {
      const plan = planFromRows(db.plan);
      const task = plan.tasks.find((candidate) => candidate.isLeaf && !candidate.isMilestone)!;
      moved = task.id;
      db.plan.revisions = [
        { revision_no: 1, created_at: '2026-10-23T09:00:00Z', actor_user_id: plan.members[0]!.userId, origin: 'human', changes: { tasks: { updated: [{ id: task.id, name: `${task.name} (revised)` }] } } },
        { revision_no: 2, created_at: '2026-10-24T10:00:00Z', actor_user_id: plan.members[1]!.userId, origin: 'agent', changes: { tasks: { updated: [{ id: task.id, percentDone: 50 }] } } },
      ];
      db.plan.project.current_revision = 2;
    });
    const result = await run(ctx, 'get_plan_changes', {});
    expect(result.count).toBe(2);
    expect(result.changes[0]).toMatchObject({ revision: 2, origin: 'assistant', by: ctx.plan.members[1]!.name });
    expect(result.changes[0].lines[0]).toMatch(/50% done \(was \d+%\)/);
    expect(result.changes[1].lines[0]).toMatch(/renamed to “.+\(revised\)”/);
    expect((await run(ctx, 'get_plan_changes', { task_ids: [moved] })).count).toBe(2);
    expect((await run(ctx, 'get_plan_changes', { task_ids: [999_999] })).count).toBe(0);
    expect((await run(ctx, 'get_plan_changes', { since: '2026-10-24' })).count).toBe(1);
  });
});

describe('the selection sent with a message', () => {
  it('names the selected tasks from the plan, flags the ones that are gone, and says how changes apply', () => {
    const ctx = context();
    const task = ctx.plan.tasks.find((candidate) => candidate.isLeaf && !candidate.isMilestone)!;
    const text = describeContext(ctx.plan, {
      selected_tasks: [
        { id: task.id, name: 'an old name', wbs: null },
        { id: 999_999, name: 'Deleted task', wbs: '9.9' },
      ],
      approval_mode: 'ask',
    });
    expect(text).toContain('<selected_tasks count="2">');
    expect(text).toContain(`"name":${JSON.stringify(task.name)}`);
    expect(text).toContain('"gone":true');
    expect(text).toContain('<approval_mode>ask:');
    expect(describeContext(ctx.plan, { selected_tasks: [] })).toContain('<selected_tasks count="0"/>');
    expect(describeContext(ctx.plan, null)).toBe('');
  });
});

describe('the watch list', () => {
  it('reads each rule as a sentence with what it raises now (no amounts) and the open situations', async () => {
    const ctx = context();
    expect((await run(ctx, 'get_watch_list', {})).note).toContain('Nothing is watched yet');
    const rule = {
      id: '00000000-0000-4000-8000-00000000e001',
      project_id: '00000000-0000-4000-8000-000000000001',
      name: 'Idle crane',
      scope: { kind: 'plan' as const },
      condition: { kind: 'idle_rental' as const },
      trigger: { kind: 'change' as const },
      action: { kind: 'ask_assistant' as const, note: 'Suggest how to stop paying for idle days.' },
      enabled: true,
      created_by: null,
      thread_id: null,
      created_at: '2026-10-25T09:00:00Z',
      updated_at: '2026-10-25T09:00:00Z',
    };
    ctx.watch = {
      rules: [rule],
      open: [
        {
          id: '00000000-0000-4000-8000-00000000f001',
          project_id: rule.project_id,
          rule_id: rule.id,
          situation: `${rule.id}:15`,
          fingerprint: `${rule.id}:15:4`,
          severity: 'high',
          title: 'Crane booked 4 days before Erect structural steel frame can start',
          detail: 'Idle crane',
          task_ids: [15],
          revision: 2,
          thread_id: '00000000-0000-4000-8000-00000000a001',
          fired_at: '2026-10-25T09:01:00Z',
          resolved_at: null,
        },
      ],
    };
    const list = await run(ctx, 'get_watch_list', {});
    expect(list.rules[0]).toMatchObject({ name: 'Idle crane', on: true, when: 'Every time the plan changes', watches: 'the whole plan: rented equipment paid while idle', then: 'Ask the assistant for alternatives', asks_you_to: 'Suggest how to stop paying for idle days.' });
    expect(list.rules[0].raises_now).toHaveLength(1);
    expect(list.rules[0].raises_now[0].title).toMatch(/^Crane booked \d+ days with no work planned on Erect structural steel frame$/);
    expect(list.open).toEqual([{ rule: 'Idle crane', title: 'Crane booked 4 days before Erect structural steel frame can start', since: '2026-10-25T09:01:00Z', task_ids: [15], conversation: true }]);
  });
});
