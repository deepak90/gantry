/**
 * A snippet as a small Bryntum project, so the builder can edit it in a real Gantt (WBS, names,
 * durations, crews, links with lags and leads, indent and outdent, the task editor) and let the
 * scheduling engine lay it out. A snippet has no dates: the project starts on a fixed Monday
 * (`ANCHOR`) with a Monday-to-Friday calendar, and the builder labels the time axis in working days
 * from there ("Day 1", "Week 2"). Tasks keep their snippet keys as ids; tasks added in the builder get
 * a key from their name when the snippet is read back.
 */
import { TaskModel, type AssignmentModel, type DependencyModel, type ModelFieldConfig, type ProjectModel, type ResourceModel } from '@bryntum/gantt';
import { DEPENDENCY_TYPE_CODES, SnippetCost, crewNamesOf, freshKey, linkTypeOfCode, normalName, type SnippetCrew, type SnippetDraft, type SnippetLink, type SnippetTask } from '@collab/shared';
import { workingDays } from './from-plan';

/** Day 1 of every snippet: a Monday far from any real plan. */
export const ANCHOR = new Date(2029, 0, 1);

const DAY_MS = 86_400_000;

/** Working days (Mon-Fri) from ANCHOR to `date`: 0 for Day 1. */
export function workingDayIndex(date: Date): number {
  const whole = Math.round((Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) - Date.UTC(ANCHOR.getFullYear(), ANCHOR.getMonth(), ANCHOR.getDate())) / DAY_MS);
  const weeks = Math.floor(whole / 7);
  const rest = whole - weeks * 7;
  return weeks * 5 + Math.min(rest, 5);
}

/** The date `index` working days after ANCHOR (Day 1 is index 0). */
export function dateOfWorkingDay(index: number): Date {
  const weeks = Math.floor(index / 5);
  return new Date(ANCHOR.getFullYear(), ANCHOR.getMonth(), ANCHOR.getDate() + weeks * 7 + (index - weeks * 5));
}

/** A builder task: a snippet task's costs ride along as data, so they survive edits in the Gantt. */
export class SnippetTaskModel extends TaskModel {
  static override $name = 'SnippetTaskModel';
  static override fields: ModelFieldConfig[] = [{ name: 'costs', type: 'array', defaultValue: null }];
  declare costs: SnippetCost[] | null;
}

/** A task's costs as the builder holds them (only well-formed lines). */
export function costsOf(record: TaskModel): SnippetCost[] {
  const raw = (record as SnippetTaskModel).costs;
  return Array.isArray(raw) ? raw.filter((cost) => SnippetCost.safeParse(cost).success) : [];
}

export interface BuilderCrewColor {
  name: string;
  color: string;
}

const crewId = (name: string) => `crew:${normalName(name)}`;

/** Inline data for a ProjectModel holding the snippet. */
export function projectDataOf(draft: Pick<SnippetDraft, 'children' | 'links'>, crews: readonly BuilderCrewColor[]) {
  const known = new Map(crews.map((crew) => [normalName(crew.name), crew]));
  const extra = crewNamesOf(draft.children).filter((name) => !known.has(normalName(name)));
  const resources = [...crews.map((crew) => ({ id: crewId(crew.name), name: crew.name, eventColor: crew.color })), ...extra.map((name) => ({ id: crewId(name), name, eventColor: '#94a3b8' }))];
  const assignments: Record<string, unknown>[] = [];
  const task = (item: SnippetTask): Record<string, unknown> => {
    const children = item.children ?? [];
    for (const crew of item.crews ?? []) assignments.push({ id: `${item.key}|${crewId(crew.name)}`, event: item.key, resource: crewId(crew.name), units: crew.units ?? 100 });
    return {
      id: item.key,
      name: item.name,
      ...(item.note ? { note: item.note } : {}),
      ...(children.length > 0 ? { expanded: true, children: children.map(task) } : { duration: item.duration ?? 0, durationUnit: 'day', ...(item.costs?.length ? { costs: item.costs } : {}) }),
    };
  };
  return {
    project: { startDate: ANCHOR, calendar: 'weekdays', hoursPerDay: 24, daysPerWeek: 5, daysPerMonth: 20 },
    calendars: [
      {
        id: 'weekdays',
        name: 'Monday to Friday',
        unspecifiedTimeIsWorking: true,
        intervals: [{ recurrentStartDate: 'on Sat at 0:00', recurrentEndDate: 'on Mon at 0:00', isWorking: false }],
      },
    ],
    tasks: draft.children.map(task),
    dependencies: draft.links.map((link) => ({
      fromEvent: link.from,
      toEvent: link.to,
      type: DEPENDENCY_TYPE_CODES[link.type ?? 'FS'],
      lag: link.lag ?? 0,
      lagUnit: 'day',
    })),
    resources,
    assignments,
  };
}

interface TreeTask {
  children?: TaskModel[] | boolean;
  hasGeneratedId?: boolean;
}

/**
 * The snippet's tasks and links as the builder's project holds them now. `keys` remembers the key
 * given to each task added in the builder (by its record id), so a task keeps its key while edited.
 */
export function snippetBodyOf(project: ProjectModel, keys: Map<unknown, string>): Pick<SnippetDraft, 'children' | 'links'> {
  const root = (project.taskStore as unknown as { rootNode: TaskModel }).rootNode;
  const taken = new Set<string>();
  const keyOf = (record: TaskModel): string => {
    const remembered = keys.get(record.id);
    if (remembered) return remembered;
    const id = record.id;
    // A task loaded from the snippet keeps its key (record ids are unique); a new one gets a fresh key.
    const own = typeof id === 'string' && !(record as unknown as TreeTask).hasGeneratedId && /^[A-Za-z0-9_.-]{1,40}$/.test(id) ? id : null;
    const key = own ?? freshKey([], record.name || 'task', taken);
    taken.add(key);
    keys.set(record.id, key);
    return key;
  };
  // Keys already in use first, so a new task never takes an existing task's key.
  const all = project.taskStore.allRecords as TaskModel[];
  for (const record of all) {
    const key = keys.get(record.id) ?? (typeof record.id === 'string' && !(record as unknown as TreeTask).hasGeneratedId ? record.id : null);
    if (key) taken.add(key);
  }
  const hours = (project as ProjectModel & { hoursPerDay?: number }).hoursPerDay ?? 24;
  const convert = (record: TaskModel): SnippetTask => {
    const key = keyOf(record);
    const children = Array.isArray((record as unknown as TreeTask).children) ? ((record as unknown as TreeTask).children as TaskModel[]) : [];
    const note = typeof record.note === 'string' && record.note.trim() ? { note: record.note.trim().slice(0, 600) } : {};
    if (children.length > 0) return { key, name: record.name || 'Untitled group', children: children.map(convert), ...note };
    // In the order the crews were given (the assignment store keeps it; a task's own list does not).
    const crews: SnippetCrew[] = (project.assignmentStore.allRecords as AssignmentModel[])
      .filter((assignment) => assignment.event === (record as unknown))
      .map((assignment) => ({ name: (assignment.resource as ResourceModel | null)?.name ?? '', units: Math.round(assignment.units ?? 100) }))
      .filter((crew) => crew.name)
      .map((crew) => (crew.units === 100 ? { name: crew.name } : crew));
    const costs = costsOf(record);
    return {
      key,
      name: record.name || 'Untitled task',
      duration: record.isMilestone ? 0 : Math.max(0, Math.round(workingDays(record.duration, record.durationUnit, hours))),
      ...(crews.length > 0 ? { crews } : {}),
      ...(costs.length > 0 ? { costs } : {}),
      ...note,
    };
  };
  const rootChildren = Array.isArray((root as unknown as TreeTask).children) ? ((root as unknown as TreeTask).children as TaskModel[]) : [];
  const children = rootChildren.map(convert);
  const links: SnippetLink[] = [];
  for (const dependency of project.dependencyStore.allRecords as DependencyModel[]) {
    const from = dependency.fromEvent as unknown as TaskModel | null;
    const to = dependency.toEvent as unknown as TaskModel | null;
    if (!from || !to || dependency.active === false) continue;
    const type = linkTypeOfCode(dependency.type as number);
    const lag = Math.round(workingDays(dependency.lag, dependency.lagUnit, hours));
    links.push({ from: keyOf(from), to: keyOf(to), ...(type !== 'FS' ? { type } : {}), ...(lag !== 0 ? { lag } : {}) });
  }
  return { children, links };
}
