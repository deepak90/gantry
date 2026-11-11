/**
 * The assistant's tools for the whole plan and the library (the fix tools are in tools.ts): find and
 * read tasks, trace what sets the handover date, crew workload, a check of the schedule; list the
 * library, find repeating work worth keeping, draft a snippet; find similar places for a piece just
 * dropped; and draft a plan edit. Reads are pure code over the plan snapshot (plan/analysis.ts).
 * Nothing here changes the plan or the library: drafts are kept by id for a card, and a person
 * applies or saves them from their own browser.
 */
import { PlanEditOp, SnippetDraft, checkSnippet, crewNamesOf, leavesOf, normalName, snippetSpan, type Snippet } from '@collab/shared';
import { z } from 'zod';
import { criticalPath, crewWorkload, findTasks, repeatingWork, scheduleHealth, similarPlaces, taskDetail } from '../plan/analysis';
import { day, usd } from '../plan/format';
import { BUYS } from '../plan/invoice';
import { libraryItems, snippetFromPlan } from '../plan/library';
import type { PlanSnapshot } from '../plan/snapshot';
import { checkPlanEdit, type CheckedEdit } from './edits';
import { ToolRefusal } from './refusal';
import type { ToolContext } from './tools';

/** A task that brings them to the place ("Deliver and stock fixtures"): floor by floor. */
const DELIVERS = /\b(deliver|ship|freight|haul|stock)/i;

/** A snippet draft kept for a card: what it is and where in the plan it came from. */
export interface DraftRecord {
  snippet: SnippetDraft;
  source_task_ids: number[];
}

const date = z.iso.date().describe('Calendar date YYYY-MM-DD');
const taskStatus = z.enum(['not_started', 'in_progress', 'done', 'late', 'critical', 'milestone']);

export const PlanToolSchemas = {
  find_tasks: z.object({
    text: z.string().max(120).nullish().describe('Words that must all appear in the name, note or phase'),
    crew: z.string().max(80).nullish().describe('A crew name (or part of it)'),
    phase: z.string().max(160).nullish().describe('A phase or group name (or part of it): tasks under it'),
    from: date.nullish().describe('Tasks working on or after this day'),
    to: date.nullish().describe('Tasks working on or before this day'),
    status: taskStatus.nullish(),
    leaves_only: z.boolean().nullish().describe('Only tasks, not groups'),
    limit: z.int().min(1).max(40).nullish(),
  }),
  get_task: z.object({
    task_id: z.int().positive().nullish(),
    name: z.string().max(160).nullish().describe('A task name (or part of it) when the id is not known'),
  }),
  get_critical_path: z.object({}),
  get_crew_workload: z.object({
    crew: z.string().max(80).nullish().describe('One crew (or part of its name); omit for all'),
    from: date.nullish(),
    to: date.nullish(),
  }),
  check_schedule: z.object({}),
  list_library: z.object({ query: z.string().max(120).nullish().describe('Words to look for in names, tasks and crews; omit for everything') }),
  find_repeating_work: z.object({}),
  draft_snippet: SnippetDraft,
  find_similar_places: z.object({
    top_ids: z.array(z.int().positive()).min(1).max(8).describe('The new top task(s) of the piece just dropped'),
    anchor_id: z.int().positive().nullable().describe('The task it was dropped after, or null'),
    parent_id: z.int().positive().nullable().describe('The group it went into, or null'),
  }),
  draft_plan_edit: z.object({
    title: z.string().trim().min(1).max(90).describe('What the change does, in a few words'),
    operations: z.array(PlanEditOp).min(1).max(40),
  }),
};
export type PlanToolName = keyof typeof PlanToolSchemas;

export const PLAN_TOOL_DESCRIPTIONS: Record<PlanToolName, string> = {
  find_tasks:
    'Search the plan: tasks by words in the name, note or phase, by crew, by phase, by dates they work, or by status (late, critical, in progress, ...). Returns ids, names, dates, crews, progress and whether each sets the handover date.',
  get_task:
    'Everything about one task (by id, or by name when you do not know the id): where it sits, dates, working days, progress, slip against the baseline, crews, what it waits for and what waits for it (with link types and lags), how many days it can slip, constraint, note and its money.',
  get_critical_path:
    'The chain of tasks that sets the handover date (no slack: any day lost there moves the handover), and the tasks close to it (1-3 days of slack).',
  get_crew_workload: 'Crew-days booked per week for each crew (or one crew), the busiest week, and days a crew is booked on more than it can do.',
  check_schedule:
    'A check of the schedule the way a planner would: tasks with no link in or out, leads, long lags, links other than finish-to-start, fixed dates, very long tasks, tasks with no crew, overbooked crews, slips against the baseline, negative slack. Each check passes or lists the tasks.',
  list_library: 'The team’s task library: every snippet with its id, folder, what it covers, tasks, length, crews and time ranges. Use the ids for add_snippet.',
  find_repeating_work:
    'Look through the plan for work worth keeping in the library: groups that repeat (the same tasks under different names, e.g. one per room) and groups that stand on their own. Drafts a snippet from the best ones and returns their draft_ids for show_snippets; says when the library already has one like it.',
  draft_snippet:
    'Draft a new library snippet from your own knowledge (e.g. "a template for a dental office build-out"): name, summary, icon, unit, the nested tasks (groups have children; tasks have working days, crews by the project’s crew names, notes), links between tasks (FS/SS/FF/SF with lag; negative lag is a lead) and optional time ranges tied to task starts or ends. Checked for loops and missing pieces; returns a draft_id for show_snippets. Nothing is saved: a person saves it from the card.',
  find_similar_places:
    'After someone dropped a library piece into the plan: where it went (went: the group and the task it follows), and other places it plausibly belongs (groups named like the one it went into, after tasks named like the one it followed), leaving out places that already have it. Each place says where to put the piece (after, inside or before) for add_snippet. Also the tasks just dropped (dropped), with what each costs in whole dollars, marking those that buy materials (buys: a building does that once, not once a floor) and those that deliver them (delivers: floor by floor).',
  draft_plan_edit:
    'Draft a change to the plan as operations (add, change, move, indent, outdent, copy or delete tasks; lengthen or shorten a task by working days or to a last day; link, unlink or change links; add a firm the project does not have yet, such as a supplier or a new subcontractor; give or take crews; set what a task costs and who is paid; drop a library snippet, whole or leaving out some of its tasks). Checked against the plan; returns an edit_id and one plain line per operation for show_plan_edit. Nothing changes until a person presses Apply on the card. Use task ids from tool results; name tasks the edit adds with ref and use { "ref": ... } to point at them later in the same edit.',
};

const isPlanTool = (name: string): name is PlanToolName => name in PlanToolSchemas;
export { isPlanTool };

function withoutNulls(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null && item !== undefined));
}

function librarySnippets(ctx: ToolContext): { item: ReturnType<typeof libraryItems>[number]['item']; snippet: Snippet }[] {
  return libraryItems(ctx.library);
}

/** A task found by name: exact (any case) first, then every task whose name contains all the words. */
function tasksNamed(plan: PlanSnapshot, name: string) {
  const wanted = normalName(name);
  const exact = plan.tasks.filter((task) => normalName(task.name) === wanted);
  if (exact.length > 0) return exact;
  const words = wanted.split(' ').filter(Boolean);
  return plan.tasks.filter((task) => words.every((word) => normalName(task.name).includes(word)));
}

export function runPlanTool(name: PlanToolName, rawArgs: unknown, ctx: ToolContext): unknown {
  const parsed = PlanToolSchemas[name].safeParse(rawArgs);
  if (!parsed.success) throw new ToolRefusal(`Invalid arguments: ${z.prettifyError(parsed.error)}`);
  const args = withoutNulls(parsed.data as Record<string, unknown>);
  const { plan } = ctx;
  switch (name) {
    case 'find_tasks': {
      const found = findTasks(plan, args as Parameters<typeof findTasks>[1]);
      return { plan_as_of: plan.statusDate, ...found };
    }
    case 'get_task': {
      let id = args.task_id as number | undefined;
      if (id === undefined) {
        if (!args.name) throw new ToolRefusal('Give a task_id or a name.');
        const matches = tasksNamed(plan, args.name as string);
        if (matches.length === 0) throw new ToolRefusal(`No task is called anything like "${String(args.name)}". Try find_tasks.`);
        if (matches.length > 1) return { ambiguous: true, matches: matches.slice(0, 10).map((task) => ({ id: task.id, name: task.name, phase: task.phase, start: task.start })) };
        id = matches[0]!.id;
      }
      const detail = taskDetail(plan, id);
      if (!detail) throw new ToolRefusal(`There is no task ${id} in the plan.`);
      return {
        ...detail,
        text: {
          start: day(detail.start),
          last_day: day(detail.last_day),
          budget: usd(detail.money.budget_minor),
          forecast: usd(detail.money.forecast_minor),
          spent: usd(detail.money.incurred_minor),
        },
      };
    }
    case 'get_critical_path': {
      const path = criticalPath(plan);
      return { plan_as_of: plan.statusDate, ...path, text: { finish: day(path.finish.date) } };
    }
    case 'get_crew_workload':
      return crewWorkload(plan, args as Parameters<typeof crewWorkload>[1]);
    case 'check_schedule':
      return scheduleHealth(plan);
    case 'list_library': {
      const words = normalName((args.query as string | undefined) ?? '')
        .split(' ')
        .filter(Boolean);
      const items = librarySnippets(ctx)
        .filter(({ item, snippet }) => {
          if (words.length === 0) return true;
          const text = normalName([item.name, item.summary, item.folder, ...item.crews, ...leavesOf(snippet.children).map((task) => task.name)].join(' '));
          return words.every((word) => text.includes(word));
        })
        .map(({ item }) => item);
      return { count: items.length, snippets: items.slice(0, 25), truncated: items.length > 25 };
    }
    case 'find_repeating_work': {
      const library = librarySnippets(ctx);
      const candidates = repeatingWork(plan).slice(0, 6);
      const out = candidates.map((candidate, index) => {
        const draft = index < 4 ? snippetFromPlan(plan, candidate.sample_id) : null;
        let draftId: string | null = null;
        if (draft) {
          draftId = `draft-${ctx.drafts.size + 1}`;
          ctx.drafts.set(draftId, { snippet: draft, source_task_ids: candidate.group_ids.slice(0, 8) });
        }
        const names = new Set(draft ? leavesOf(draft.children).map((task) => normalName(task.name)) : []);
        const similar = library.find(({ snippet }) => {
          const theirs = leavesOf(snippet.children).map((task) => normalName(task.name));
          const shared = theirs.filter((task) => names.has(task)).length;
          return normalName(snippet.name) === normalName(candidate.name) || (names.size > 0 && shared / Math.max(names.size, theirs.length) >= 0.6);
        });
        return { ...candidate, draft_id: draftId, already_in_library: similar ? similar.item.name : null };
      });
      return { count: out.length, candidates: out };
    }
    case 'draft_snippet': {
      const draft = parsed.data as SnippetDraft;
      // A snippet names a crew by trade or by firm; either matches when it is dropped.
      const problems = checkSnippet(draft, plan.resources.flatMap((resource) => (resource.trade ? [resource.name, resource.trade] : [resource.name])));
      const errors = problems.filter((problem) => problem.level === 'error');
      if (errors.length > 0) throw new ToolRefusal(`The snippet was not drafted:\n- ${errors.map((problem) => problem.message).join('\n- ')}`);
      const draftId = `draft-${ctx.drafts.size + 1}`;
      ctx.drafts.set(draftId, { snippet: draft, source_task_ids: [] });
      return {
        draft_id: draftId,
        tasks: leavesOf(draft.children).length,
        span_days: snippetSpan(draft),
        crews: crewNamesOf(draft.children),
        warnings: problems.filter((problem) => problem.level === 'warning').map((problem) => problem.message),
      };
    }
    case 'find_similar_places': {
      const topIds = args.top_ids as number[];
      const places = similarPlaces(plan, { added_top_ids: topIds, anchor_id: (args.anchor_id as number | undefined) ?? null, parent_id: (args.parent_id as number | undefined) ?? null });
      // The tasks just dropped, in order: buying and delivering materials is usually done once for the whole building.
      const order = (a: PlanSnapshot['tasks'][number], b: PlanSnapshot['tasks'][number]) => (a.order ?? 0) - (b.order ?? 0);
      const leavesUnder = (taskId: number): PlanSnapshot['tasks'] => {
        const task = plan.tasks.find((candidate) => candidate.id === taskId);
        if (!task) return [];
        if (task.isLeaf) return [task];
        return plan.tasks.filter((candidate) => candidate.parentId === taskId).sort(order).flatMap((child) => leavesUnder(child.id));
      };
      const dropped = topIds.flatMap(leavesUnder).map((task) => ({ id: task.id, name: task.name, cost_dollars: Math.round(task.budgetMinor / 100), buys: BUYS.test(task.name), delivers: DELIVERS.test(task.name) }));
      const firstChild = (parentId: number | null) =>
        plan.tasks.filter((task) => task.parentId === parentId).sort((a, b) => (a.order ?? 0) - (b.order ?? 0))[0]?.id ?? null;
      // Where it went, so a piece that landed in a group not for its kind of work is not copied to others.
      const nameOf = (id: unknown) => (typeof id === 'number' ? (plan.tasks.find((candidate) => candidate.id === id)?.name ?? null) : null);
      return {
        went: { group: nameOf(args.parent_id), after: nameOf(args.anchor_id) },
        count: places.length,
        places: places.map((place) => ({
          ...place,
          // Where add_snippet puts it.
          add_snippet:
            place.position === 'after' && place.anchor_id !== null
              ? { after: place.anchor_id }
              : place.position === 'start' && firstChild(place.parent_id) !== null
                ? { before: firstChild(place.parent_id) }
                : place.parent_id !== null
                  ? { inside: place.parent_id }
                  : null,
        })),
        dropped,
      };
    }
    case 'draft_plan_edit': {
      const { title, operations } = parsed.data as { title: string; operations: PlanEditOp[] };
      const editId = `edit-${ctx.edits.size + 1}`;
      const checked: CheckedEdit = checkPlanEdit(plan, librarySnippets(ctx).map(({ snippet }) => snippet), editId, title, operations);
      ctx.edits.set(editId, checked);
      return { edit_id: editId, lines: checked.lines, warnings: checked.warnings };
    }
  }
}

/** One line for the logs and the progress stream. */
export function summarizePlanTool(name: PlanToolName, value: Record<string, any>): string {
  switch (name) {
    case 'find_tasks':
      return `${value.total} task(s)`;
    case 'get_task':
      return value.ambiguous ? `${value.matches.length} tasks match` : `${value.name}`;
    case 'get_critical_path':
      return `${value.critical_count} critical task(s), finish ${value.finish?.date}`;
    case 'get_crew_workload':
      return `${value.crews?.length ?? 0} crew(s)`;
    case 'check_schedule':
      return `${value.passed}/${value.total} checks pass`;
    case 'list_library':
      return `${value.count} snippet(s)`;
    case 'find_repeating_work':
      return `${value.count} candidate(s)`;
    case 'draft_snippet':
      return `${value.draft_id}: ${value.tasks} task(s), ${value.span_days} day(s)`;
    case 'find_similar_places':
      return `${value.count} place(s)`;
    case 'draft_plan_edit':
      return `${value.edit_id}: ${value.lines.length} operation(s)`;
  }
}
