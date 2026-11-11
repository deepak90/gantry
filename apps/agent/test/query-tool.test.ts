/**
 * query_plan: a read-only look-up over the plan with fields and operators from fixed lists, for the questions no
 * other tool answers. A field or an operator that isn't listed is refused, naming the ones that are; money comes in
 * cents with its dollars beside it. The overview and get_task now carry the plan's build: outline numbers, deadlines,
 * links by type, constraints and critical tasks.
 */
import { describe, expect, it } from 'vitest';
import { TOOL_DEFINITIONS } from '../src/agent/brain';
import { SYSTEM_PROMPT } from '../src/agent/prompts';
import { ToolRefusal } from '../src/agent/refusal';
import { runDataTool, type ToolContext } from '../src/agent/tools';
import { FakeDb } from '../src/dev/fake';
import { scheduleFloat } from '../src/plan/analysis';
import { planFromRows } from '../src/plan/rows';

function context(): ToolContext {
  const db = new FakeDb();
  const plan = planFromRows(db.plan);
  return {
    plan,
    workflow: db.workflow,
    issues: new Map(),
    speaker: plan.members[0]!,
    present: plan.members,
    library: db.library,
    drafts: new Map(),
    edits: new Map(),
    history: { rows: null, decisions: [] },
    watch: { rules: [], open: [] },
    refresh: async () => undefined,
  };
}

const run = (ctx: ToolContext, name: string, args: unknown) => runDataTool(name as never, args, ctx) as Promise<Record<string, any>>;

describe('query_plan', () => {
  it('finds critical tasks in plan order, with the fields asked for', async () => {
    const ctx = context();
    const result = await run(ctx, 'query_plan', {
      entity: 'tasks',
      where: [
        { field: 'critical', op: '=', value: true },
        { field: 'kind', op: '=', value: 'task' },
      ],
      select: ['name', 'start', 'total_slack_days'],
      order_by: [{ field: 'start' }],
      limit: 5,
    });
    const critical = Object.entries(scheduleFloat(ctx.plan)).filter(([, float]) => float.critical);
    expect(result.count).toBeGreaterThan(0);
    expect(result.count).toBeLessThanOrEqual(critical.length);
    expect(result.rows).toHaveLength(Math.min(5, result.count));
    expect(Object.keys(result.rows[0])).toEqual(['name', 'start', 'total_slack_days']);
    expect(result.rows.every((row: { total_slack_days: number }) => row.total_slack_days <= 0)).toBe(true);
    const starts = result.rows.map((row: { start: string }) => row.start);
    expect([...starts].sort()).toEqual(starts);
  });

  it('reads links by type and lag, and words matching any case', async () => {
    const ctx = context();
    const all = await run(ctx, 'query_plan', { entity: 'links', aggregate: [{ fn: 'count' }], group_by: 'type' });
    expect(all.groups.map((group: { type: string }) => group.type)).toContain('FS');
    const fs = all.groups.find((group: { type: string }) => group.type === 'FS');
    const same = await run(ctx, 'query_plan', { entity: 'links', where: [{ field: 'type_words', op: '=', value: 'FINISH-TO-START' }] });
    expect(same.count).toBe(fs.count);
    const leads = await run(ctx, 'query_plan', { entity: 'links', where: [{ field: 'lag_days', op: '<', value: 0 }] });
    expect(leads.count).toBe(ctx.plan.dependencies.filter((link) => link.lag < 0).length);
  });

  it('totals money by phase, in cents with dollars beside it', async () => {
    const ctx = context();
    const result = await run(ctx, 'query_plan', { entity: 'tasks', where: [{ field: 'kind', op: 'in', value: ['task', 'milestone'] }], group_by: 'phase', aggregate: [{ fn: 'sum', field: 'forecast_minor' }] });
    const total = result.groups.reduce((sum: number, group: { sum_forecast_minor: number }) => sum + group.sum_forecast_minor, 0);
    expect(total).toBe(ctx.plan.tasks.filter((task) => task.isLeaf).reduce((sum, task) => sum + task.forecastMinor, 0));
    expect(result.groups[0].text.sum_forecast_minor).toMatch(/^\$[\d,]+(\.\d\d)?$/);
  });

  it('finds empty and filled fields, and crews and their work', async () => {
    const ctx = context();
    const pinned = await run(ctx, 'query_plan', { entity: 'tasks', where: [{ field: 'constraint_type', op: 'not_empty' }], select: ['name', 'constraint_type', 'constraint_date'] });
    expect(pinned.count).toBe(ctx.plan.tasks.filter((task) => task.constraintType).length);
    const crews = await run(ctx, 'query_plan', { entity: 'crews', where: [{ field: 'trade', op: 'contains', value: 'carp' }] });
    expect(crews.rows.map((row: { name: string }) => row.name)).toContain('Oakmere Interiors');
    const onIt = await run(ctx, 'query_plan', { entity: 'assignments', where: [{ field: 'crew', op: 'starts_with', value: 'oakmere' }], aggregate: [{ fn: 'count' }] });
    expect(onIt.totals.count).toBeGreaterThan(0);
  });

  it('refuses a field it doesn’t have, naming the ones it does, and an operator it doesn’t know', async () => {
    const ctx = context();
    await expect(run(ctx, 'query_plan', { entity: 'tasks', where: [{ field: 'weather', op: '=', value: 'rain' }] })).rejects.toThrow(/tasks has no field "weather".*Its fields: id, name, wbs/);
    await expect(run(ctx, 'query_plan', { entity: 'tasks', where: [{ field: 'name', op: 'matches_regex', value: '.*' }] })).rejects.toBeInstanceOf(ToolRefusal);
    await expect(run(ctx, 'query_plan', { entity: 'tasks', aggregate: [{ fn: 'sum' }] })).rejects.toThrow('sum needs a field');
    await expect(run(ctx, 'query_plan', { entity: 'secrets' })).rejects.toBeInstanceOf(ToolRefusal);
  });

  it('is one of Remy’s tools, and her rules say when to use it', () => {
    const tool = TOOL_DEFINITIONS.find((definition) => definition.name === 'query_plan');
    expect(tool?.description).toMatch(/Read only/);
    expect(tool?.description).toMatch(/tasks: id, name, wbs/);
    expect(SYSTEM_PROMPT).toMatch(/for anything those don't answer .*query_plan/);
  });
});

describe('the plan’s build in Remy’s reads', () => {
  it('get_task gives the outline number and the deadline; the overview gives links by type, constraints and critical tasks', async () => {
    const ctx = context();
    const task = await run(ctx, 'get_task', { task_id: 216 });
    expect(task.wbs).toBe('2.2.6');
    expect(task).toHaveProperty('deadline');
    const overview = await run(ctx, 'get_plan_overview', {});
    expect(overview.model.links.finish_to_start).toBe(ctx.plan.dependencies.filter((link) => link.type === 2).length);
    expect(overview.model.critical_tasks).toBe(Object.values(scheduleFloat(ctx.plan)).filter((float) => float.critical).length);
    expect(overview.model.groups).toBe(ctx.plan.tasks.filter((each) => !each.isLeaf).length);
    expect(overview).toHaveProperty('handover_deadline');
  });
});
