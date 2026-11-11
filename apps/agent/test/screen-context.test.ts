/**
 * What Remy knows without asking: the person's screen as one short <screen> line with each message (the 3D view's day
 * and whether it plays, the side panel, what is open over the page, the library card, the filter, the dates in view),
 * and where the plan stands today (what is late, what each payment hold holds and why, the days off ahead, the city
 * inspector's away week among them).
 */
import { describe, expect, it } from 'vitest';
import { AgentMessageContext, ScreenContext } from '@collab/shared';
import { harborOffices } from '@collab/shared/seed';
import { describeContext, describeScreen } from '../src/agent/prompts';
import { runDataTool, type ToolContext } from '../src/agent/tools';
import { FakeDb } from '../src/dev/fake';
import { planState } from '../src/plan/facts';
import { calendarBreaksOf, planFromRows } from '../src/plan/rows';
import type { PlanSnapshot } from '../src/plan/snapshot';

describe('the screen line', () => {
  it('says what was on screen in a few hundred characters', () => {
    const line = describeScreen({
      view: 'site',
      site_day: '2026-11-25',
      playing: false,
      crane_ride: false,
      panel: 'assistant',
      modal: 'payment_review',
      modal_about: 'Progress payment · Footings · 2 trade partners',
      call: 'host',
    });
    expect(line).toBe('<screen view="3D site view" day="2026-11-25" playing="no" panel="assistant" open="the payment review: Progress payment · Footings · 2 trade partners" call="host"/>');
    expect(line.length).toBeLessThan(400);
  });

  it('keeps the chart’s dates and filter, and quotes what the person typed safely', () => {
    const line = describeScreen({ view: 'chart', search: 'say "hi" <b>', filter: 'Halden Electrical · Dec 1 to Dec 31', from: '2026-11-16', to: '2026-12-04', zoom: 'weeks', snippet: 'Light fixtures' });
    expect(line).toContain('view="chart"');
    expect(line).toContain('search="say &quot;hi&quot; &lt;b&gt;"');
    expect(line).toContain('dates="2026-11-16 to 2026-12-04"');
    expect(line).toContain('library_card="Light fixtures"');
    expect(line).not.toContain('playing');
  });

  it('comes with the message, after the selection, and nothing comes when there is no screen', () => {
    const plan = planFromRows(new FakeDb().plan);
    const context = AgentMessageContext.parse({ selected_tasks: [], approval_mode: 'ask', screen: { view: 'chart', panel: 'library' } });
    expect(describeContext(plan, context)).toMatch(/<selected_tasks count="0"\/>\n<approval_mode>[^<]+<\/approval_mode>\n<screen view="chart" panel="library"\/>$/);
    expect(describeContext(plan, { selected_tasks: [] })).not.toContain('<screen');
  });

  it('drops fields it doesn’t know, and leaves out a screen that doesn’t fit, never the message', () => {
    expect(AgentMessageContext.parse({ screen: { view: 'chart', extra: 'x' } }).screen).toEqual({ view: 'chart' });
    expect(ScreenContext.safeParse({ view: 'moon' }).success).toBe(false);
    expect(ScreenContext.safeParse({ view: 'chart', filter: 'x'.repeat(121) }).success).toBe(false);
    const kept = AgentMessageContext.parse({ selected_tasks: [{ id: 7, name: 'Pour footings', wbs: '1.2.3' }], screen: { view: 'moon' } });
    expect(kept).toEqual({ selected_tasks: [{ id: 7, name: 'Pour footings', wbs: '1.2.3' }] });
    expect(AgentMessageContext.safeParse({ approval_mode: 'sometimes' }).success).toBe(false);
  });
});

/** Harbor as the plan has it, with its calendars. */
function harbor(): PlanSnapshot {
  const db = new FakeDb();
  const rows = db.plan;
  return planFromRows({ ...rows, project: { ...rows.project, name: harborOffices.name, snapshot: harborOffices.inlineData as never, handover_task_id: harborOffices.handover_task_id } });
}

describe('where the plan stands today', () => {
  it('reads the days off that fall on dates from the calendars, the city inspector’s week among them', () => {
    const breaks = calendarBreaksOf(harborOffices.inlineData as never);
    expect(breaks).toContainEqual({ calendar: 'inspector', name: 'City inspector away', first_day: '2026-11-23', last_day: '2026-11-27' });
    expect(breaks.every((brk) => brk.last_day >= brk.first_day)).toBe(true);
  });

  it('names the inspector’s away week with the inspection it holds up, and the shutdown on every calendar', () => {
    const state = planState(harbor(), '2026-11-10');
    const away = state.daysOff.find((entry) => entry.name === 'City inspector away')!;
    expect(away).toMatchObject({ first_day: '2026-11-23', last_day: '2026-11-27', calendars: ['City inspector'] });
    expect(away.tasks).toContain('City inspection, slab');
    const shutdown = state.daysOff.find((entry) => entry.name === 'Holiday shutdown')!;
    expect(shutdown.calendars.length).toBeGreaterThan(1);
    expect(shutdown.tasks).toEqual([]);
    expect(state.today).toBe('2026-11-10');
  });

  it('says what each payment hold pays for, what waits for it and why', () => {
    const plan = harbor();
    const state = planState(plan, '2026-11-10');
    const footings = state.holds.find((hold) => /footings/i.test(hold.name));
    expect(footings).toBeDefined();
    expect(footings!.pays_for.length).toBeGreaterThan(0);
    expect(footings!.why).toMatch(/can't start until .* is paid for \(due [A-Z][a-z]{2}, [A-Z][a-z]{2} \d+\)/);
  });

  it('lists work that should have finished by today and isn’t done', () => {
    const plan = harbor();
    const leaf = plan.tasks.find((task) => task.isLeaf && !task.isMilestone && task.percentDone < 100)!;
    const later = planState(plan, '2030-01-01');
    expect(later.late.count).toBeGreaterThan(0);
    expect(later.late.tasks.some((task) => task.id === leaf.id) || later.late.count > later.late.tasks.length).toBe(true);
    expect(planState(plan, '2000-01-01').late.count).toBe(0);
  });

  it('is in the overview, from the plan’s own today', async () => {
    const db = new FakeDb();
    const plan = harbor();
    const ctx: ToolContext = {
      plan,
      workflow: db.workflow,
      issues: new Map(),
      speaker: plan.members[0] ?? null,
      present: plan.members,
      library: db.library,
      drafts: new Map(),
      edits: new Map(),
      history: { rows: null, decisions: [] },
      watch: { rules: [], open: [] },
      refresh: async () => undefined,
      planDate: '2026-11-10',
    };
    const overview = (await runDataTool('get_plan_overview', {}, ctx)) as Record<string, any>;
    expect(overview.today).toBe('2026-11-10');
    expect(overview.days_off.some((entry: { name: string }) => entry.name === 'City inspector away')).toBe(true);
    expect(overview.payment_holds.length).toBe(plan.tasks.filter((task) => task.payGate).length);
    expect(overview.late).toHaveProperty('count');
  });
});
