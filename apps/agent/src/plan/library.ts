/**
 * The task library as the agent sees it: a compact list of what is in it (for list_library and for
 * checking the snippets an edit drops in), and work already in the plan turned into a snippet draft
 * (for find_repeating_work). Pure functions over the library rows and the plan snapshot.
 */
import { leavesOf, linkTypeOfCode, snippetFromOutline, snippetFromRow, snippetSpan, crewNamesOf, type OutlineLink, type OutlineTask, type Snippet, type SnippetDraft } from '@collab/shared';
import { countWorkingDays } from '@collab/shared/seed';
import type { LibraryRows } from '../data/store';
import type { PlanSnapshot, PlanTask } from './snapshot';

export interface LibraryItem {
  id: string;
  name: string;
  /** Folder path, outermost first, e.g. "Build-out › Clinical rooms". */
  folder: string;
  summary: string;
  tasks: number;
  span_days: number;
  crews: string[];
  /** e.g. "room" / "rooms". */
  unit: string;
  time_ranges: string[];
  origin: string;
}

export function libraryItems(rows: LibraryRows): { item: LibraryItem; snippet: Snippet }[] {
  const folders = new Map(rows.folders.map((folder) => [folder.id, folder]));
  const pathOf = (id: string | null): string => {
    const names: string[] = [];
    const seen = new Set<string>();
    for (let at = id ? folders.get(id) : undefined; at && !seen.has(at.id); at = at.parent_id ? folders.get(at.parent_id) : undefined) {
      seen.add(at.id);
      names.unshift(at.name);
    }
    return names.join(' › ');
  };
  const out: { item: LibraryItem; snippet: Snippet }[] = [];
  for (const row of rows.snippets) {
    const snippet = snippetFromRow(row);
    if (!snippet) continue;
    out.push({
      snippet,
      item: {
        id: snippet.id,
        name: snippet.name,
        folder: pathOf(row.folder_id),
        summary: snippet.summary,
        tasks: leavesOf(snippet.children).length,
        span_days: snippetSpan(snippet),
        crews: crewNamesOf(snippet.children),
        unit: `${snippet.unit.one} / ${snippet.unit.many}`,
        time_ranges: (snippet.timeRanges ?? []).map((range) => range.name),
        origin: row.origin,
      },
    });
  }
  return out;
}

const childrenOf = (plan: PlanSnapshot, id: number): PlanTask[] =>
  plan.tasks.filter((task) => task.parentId === id).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

const workingDays = (task: PlanTask): number =>
  task.segments ? task.segments.reduce((sum, segment) => sum + countWorkingDays(segment.start, segment.end, task.calendar), 0) : countWorkingDays(task.start, task.end, task.calendar);

/** The snippet a group of the plan (or a single task) makes: its tasks, crews, notes and inside links. */
export function snippetFromPlan(plan: PlanSnapshot, taskId: number): SnippetDraft | null {
  const top = plan.tasks.find((task) => task.id === taskId);
  if (!top) return null;
  const resources = new Map(plan.resources.map((resource) => [resource.id, resource]));
  const outline = (task: PlanTask): OutlineTask => {
    const kids = childrenOf(plan, task.id);
    return {
      id: task.id,
      name: task.name,
      days: kids.length > 0 ? 0 : task.isMilestone ? 0 : workingDays(task),
      crews: plan.assignments
        .filter((assignment) => assignment.taskId === task.id)
        .map((assignment) => ({ name: resources.get(assignment.resourceId)?.name ?? '', units: assignment.units }))
        .filter((crew) => crew.name),
      note: task.note ?? null,
      children: kids.map(outline),
    };
  };
  const links: OutlineLink[] = plan.dependencies
    .filter((link) => link.active !== false)
    .map((link) => ({ from: link.from, to: link.to, type: linkTypeOfCode(link.type), lag: Math.round(link.lag) }));
  const draft = snippetFromOutline(outline(top), links);
  return { ...draft, summary: `Saved from “${top.name}” in the plan (${top.phase}).`.slice(0, 400) };
}
