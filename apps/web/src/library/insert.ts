/**
 * Dropping a snippet into the live plan. Everything happens in ONE transaction (one revision for
 * every client): the copies of the snippet are inserted into the tree with their links and crews,
 * tied to the work they were dropped next to the way the person chose (`DropMode`), and the
 * snippet's time ranges are stored on each copy's top task (`bands`) together with the library
 * snippet it came from (`libraryRef`).
 *
 * Where it goes (`Placement`):
 * - `after`: a sibling right after a task (or a whole group); the new work follows it.
 * - `inside`: the last child of a group (phase or work package); the new work follows the group's
 *   last-finishing task.
 * - `first`: the first child of a group (or the first top-level row), before a task.
 *
 * How it is tied in (`DropMode`):
 * - `push`: it starts when that task finishes, and the links that made later work wait for that
 *   task are moved onto the new work, so the later work moves back by the new work's length.
 * - `fit`: it starts when that task finishes; nothing already in the plan moves.
 * - `alongside`: it starts when that task starts (a start-to-start link); nothing else moves.
 * - `unlinked`: no links; it is pinned to the date it would have started after that task.
 *
 * Before the drop, `previewDrop` works out on a throwaway copy what each way would move (the drop card
 * shows those numbers); after it, `undoDrop` takes the piece back out and puts moved links back.
 */
import type { DependencyModel, ProjectModel, ResourceModel, TaskModel } from '@bryntum/gantt';
import { DEPENDENCY_TYPE_CODES, normalName, type PlannedTask, type SnippetPlan, type TaskBand } from '@collab/shared';
import { withoutFilters } from '../gantt/filters';
import { movedLockMessage, paymentLocks } from '../gantt/payment-lock';
import { createProjectModel, loadProjectInlineData, prepareCopiedTasks, readProjectInlineData } from '../gantt/project';
import { runProjectTransaction } from '../scenario/publish';
import { handoverDate } from './describe';

export type Placement =
  | { kind: 'after'; anchor: TaskModel }
  | { kind: 'inside'; parent: TaskModel; anchor: TaskModel | null }
  | { kind: 'first'; parent: TaskModel; before: TaskModel };

/** Where the pointer is on a row: the top or bottom edge, the middle of a group row, or just under an open group row. */
export type DropZone = 'before' | 'after' | 'inside' | 'first-child';

export type DropMode = 'push' | 'fit' | 'alongside' | 'unlinked';

/** The ways a dropped piece can be tied in, in the order the drop card offers them (the first two up front). */
export const DROP_MODES: readonly { mode: DropMode; label: string; icon: string }[] = [
  { mode: 'push', label: 'Push later work back', icon: 'arrows-left-right-to-line' },
  { mode: 'fit', label: 'Fit in, nothing moves', icon: 'link' },
  { mode: 'alongside', label: 'Run alongside', icon: 'bars-staggered' },
  { mode: 'unlinked', label: 'Place it, no links', icon: 'link-slash' },
];

/** Who does a snippet crew's work when the person picked it on the drop card: a resource, or nobody (null). */
export type CrewChoices = ReadonlyMap<string, ResourceModel | null>;

const DEPENDENCY_TYPE = DEPENDENCY_TYPE_CODES;

/** The tree and link API of a task the typings leave out or type loosely. */
interface TreeTask {
  isLeaf: boolean;
  isRoot?: boolean;
  parent: TaskModel;
  children: TaskModel[] | boolean | undefined;
  /** The children a filter is hiding too. */
  unfilteredOrChildren: TaskModel[] | boolean | undefined;
  previousSibling: TaskModel | null;
  nextSibling: TaskModel | null;
  nextOrderedSibling: TaskModel | null;
  successors: DependencyModel[];
  traverse(fn: (node: TaskModel) => void, skipSelf?: boolean, includeFilteredOutRecords?: boolean): void;
  contains(child: TaskModel, skipSelf?: boolean): boolean;
  insertChild(child: unknown, before?: unknown, silent?: boolean, options?: { orderedBeforeNode?: unknown }): unknown;
  appendChild(child: unknown, silent?: boolean): unknown;
  refreshWbs(options: { deep: boolean; useOrderedTree: boolean }): void;
}

const tree = (task: TaskModel) => task as unknown as TreeTask;

const childList = (task: TaskModel): TaskModel[] => {
  const children = tree(task).unfilteredOrChildren;
  return Array.isArray(children) ? children : [];
};

const dateOf = (value: unknown): Date | null => (value instanceof Date ? value : null);

const taskOf = (value: unknown): TaskModel | null => (value != null && typeof value === 'object' ? (value as TaskModel) : null);

/** Leaves under a task (the task itself when it is a leaf). */
function leavesUnder(task: TaskModel): TaskModel[] {
  const leaves: TaskModel[] = [];
  tree(task).traverse(
    (node) => {
      if (node.isLeaf) leaves.push(node);
    },
    false,
    true,
  );
  return leaves;
}

/** The task of a group that finishes last (the later one in the plan on a tie); null for an empty group. */
export function lastFinishing(group: TaskModel): TaskModel | null {
  let best: TaskModel | null = null;
  for (const leaf of leavesUnder(group)) {
    if (leaf === group) continue;
    const end = dateOf(leaf.endDate)?.getTime() ?? Number.NEGATIVE_INFINITY;
    const bestEnd = dateOf(best?.endDate)?.getTime() ?? Number.NEGATIVE_INFINITY;
    if (!best || end >= bestEnd) best = leaf;
  }
  return best;
}

/** Where a drop on `task`'s row at `zone` puts the new work. */
export function placementFor(task: TaskModel, zone: DropZone): Placement {
  const node = tree(task);
  if (zone === 'inside' && !node.isLeaf) {
    return { kind: 'inside', parent: task, anchor: lastFinishing(task) };
  }
  if (zone === 'first-child' && childList(task).length > 0) {
    return { kind: 'first', parent: task, before: childList(task)[0]! };
  }
  if (zone === 'before') {
    const previous = node.previousSibling;
    return previous ? { kind: 'after', anchor: previous } : { kind: 'first', parent: node.parent, before: task };
  }
  return { kind: 'after', anchor: task };
}

/** The group the new work goes into (the project's root node for top-level rows). */
export function parentOf(placement: Placement): TaskModel {
  return placement.kind === 'after' ? tree(placement.anchor).parent : placement.parent;
}

/** The task the new work follows in time, if any. */
export function anchorOf(placement: Placement): TaskModel | null {
  return placement.kind === 'first' ? null : placement.anchor;
}

/**
 * The links that make later work wait for the anchor: finish-to-start and finish-to-finish links from
 * the anchor (or from anything inside it, for a group dropped after) to tasks outside it. These are
 * the links "push later work back" moves onto the new work. Links into the group the new work goes
 * into, or one of its parents, are left alone (a task cannot be linked to its own parent).
 */
export function linksToMove(placement: Placement): DependencyModel[] {
  const anchor = anchorOf(placement);
  if (!anchor) return [];
  const scope = new Set<TaskModel>();
  tree(anchor).traverse(
    (node) => {
      scope.add(node);
    },
    false,
    true,
  );
  const parent = parentOf(placement);
  const moved: DependencyModel[] = [];
  for (const from of scope) {
    for (const dependency of tree(from).successors ?? []) {
      const to = taskOf(dependency.toEvent);
      if (!to || scope.has(to)) continue;
      if (dependency.type !== DEPENDENCY_TYPE.FS && dependency.type !== DEPENDENCY_TYPE.FF) continue;
      if (dependency.active === false) continue;
      if (to === parent || (!tree(to).isLeaf && tree(to).contains(parent))) continue;
      moved.push(dependency);
    }
  }
  return moved;
}

/** Distinct tasks the moved links point at: the later work that will wait for the new work. */
export function tasksPushedBack(placement: Placement, mode: DropMode): TaskModel[] {
  if (mode !== 'push') return [];
  if (placement.kind === 'first') return [placement.before];
  return [...new Set(linksToMove(placement).map((dependency) => taskOf(dependency.toEvent)!))];
}

/** When the new work starts before its links are scheduled: the anchor's finish (its start when running alongside), or the start of the task it goes before. */
export function startDateFor(placement: Placement, mode: DropMode = 'push'): Date | null {
  if (placement.kind === 'first') return dateOf(placement.before.startDate);
  if (mode === 'alongside') return dateOf(placement.anchor?.startDate) ?? (placement.kind === 'inside' ? dateOf(placement.parent.startDate) : null);
  return dateOf(placement.anchor?.endDate) ?? dateOf(placement.anchor?.startDate) ?? (placement.kind === 'inside' ? dateOf(placement.parent.startDate) : null);
}

/**
 * A snippet's crew to a project resource, compared without case or extra spaces: by the crew's name
 * (a crew saved from this plan), else by trade (the library names crews by trade, e.g. "Electrical",
 * and a site may have several firms of one trade: the first one in the plan is taken).
 */
export function crewMatcher(project: ProjectModel): (name: string) => ResourceModel | undefined {
  const byName = new Map<string, ResourceModel>();
  const byTrade = new Map<string, ResourceModel>();
  for (const resource of project.resourceStore.allRecords as ResourceModel[]) {
    const key = normalName(resource.name ?? '');
    if (key && !byName.has(key)) byName.set(key, resource);
    const trade = normalName((resource as ResourceModel & { trade?: string }).trade ?? '');
    if (trade && !byTrade.has(trade)) byTrade.set(trade, resource);
  }
  return (name) => byName.get(normalName(name)) ?? byTrade.get(normalName(name));
}

/** A snippet crew the drop card asks about: no crew of that name, and none or several firms of that trade. */
export interface CrewQuestion {
  name: string;
  /** What the drop does if the person does not choose (the first firm of the trade), if anything. */
  matched: ResourceModel | null;
  /** The firms to choose from: those of the trade first, then everyone else. */
  options: ResourceModel[];
}

/** The snippet crews worth asking about before a drop: unknown ones, and trades several firms cover. */
export function crewQuestions(project: ProjectModel, names: readonly string[]): CrewQuestion[] {
  const resources = project.resourceStore.allRecords as ResourceModel[];
  const match = crewMatcher(project);
  const questions: CrewQuestion[] = [];
  for (const name of names) {
    const key = normalName(name);
    if (resources.some((resource) => normalName(resource.name ?? '') === key)) continue;
    const ofTrade = resources.filter((resource) => normalName((resource as ResourceModel & { trade?: string }).trade ?? '') === key);
    if (ofTrade.length === 1) continue;
    questions.push({ name, matched: match(name) ?? null, options: [...ofTrade, ...resources.filter((resource) => !ofTrade.includes(resource))] });
  }
  return questions;
}

/** Positions (child indexes from the copy's top task down) of every planned task under it. */
function pathsUnder(top: PlannedTask): Map<string, number[]> {
  const paths = new Map<string, number[]>();
  const walk = (tasks: readonly PlannedTask[], prefix: number[]) =>
    tasks.forEach((task, index) => {
      const path = [...prefix, index];
      paths.set(task.key, path);
      walk(task.children, path);
    });
  walk(top.children, []);
  return paths;
}

/** The time ranges of one copy, tied to positions inside its top task. */
export function bandsFor(plan: SnippetPlan, top: PlannedTask): TaskBand[] {
  const paths = pathsUnder(top);
  const bands: TaskBand[] = [];
  for (const range of plan.timeRanges) {
    const from = paths.get(range.from.task);
    const to = paths.get(range.to.task);
    if (!from || !to) continue;
    bands.push({ name: range.name, tone: range.tone, from: { path: from, edge: range.from.edge }, to: { path: to, edge: range.to.edge }, ...(range.note ? { note: range.note } : {}) });
  }
  return bands;
}

/** A link as it was before a drop took it off (to put it back on Undo). */
export interface LinkData {
  fromEvent: number | string;
  toEvent: number | string;
  type: number;
  lag: number;
  lagUnit: string;
}

export interface InsertResult {
  /** The top task of every copy, in order. */
  tops: TaskModel[];
  /** Every task created, top tasks and groups included. */
  created: TaskModel[];
  /** Links moved onto the new work (later work that now waits for it). */
  moved: number;
  /** The links taken off the plan to make later work wait for the new work instead. */
  removedLinks: LinkData[];
  /** Crew names not on the project: those tasks were left without that crew. */
  unknownCrews: string[];
  mode: DropMode;
}

/**
 * The drop in two steps, each to be scheduled before the next: `add` puts the new work in, tied to
 * the work before it; `push` then takes the pin off what links now place (`unpin`) and, with "push later
 * work back", hands later work's links over to it. In one step, a split task further down the plan (one with segments) moved by the push made the
 * engine report a scheduling cycle between the segment's duration and end in the browser: Bryntum
 * reads the segments while it works out the moved task's dates, before it has worked them out.
 */
export interface InsertSteps {
  add(): void;
  push(): void;
  readonly result: InsertResult;
}

/** The two steps of a drop (see `InsertSteps`). The links to hand over are read before anything changes. */
export function insertSteps(project: ProjectModel, placement: Placement, plan: SnippetPlan, mode: DropMode, crews: CrewChoices = new Map()): InsertSteps {
  const handOver = mode === 'push' && placement.kind !== 'first' ? linksToMove(placement) : [];
  const result: InsertResult = { tops: [], created: [], moved: 0, removedLinks: [], unknownCrews: [], mode };
  let led: TaskModel[] = [];
  return {
    result,
    add: () => {
      led = addSnippet(project, placement, plan, mode, crews, result);
    },
    push: () => {
      unpin(led);
      pushLaterWork(project, placement, mode, handOver, result);
    },
  };
}

/**
 * Leaves new tasks to their links, once those are scheduled (cleared any sooner, the pin stays). A row
 * on screen is drawn as its task goes in, and the constraint indicator reads the constraint right
 * then: the engine works it out before the links exist and pins the task (`autoSetConstraints`), so
 * only tasks whose rows are drawn get it. A task nothing leads to keeps its pin, like one added by hand.
 */
export function unpin(tasks: Iterable<TaskModel>): void {
  for (const task of tasks) task.set({ constraintType: null, constraintDate: null });
}

/** Puts the new work in; returns the new tasks that links lead to. */
function addSnippet(project: ProjectModel, placement: Placement, plan: SnippetPlan, mode: DropMode, crews: CrewChoices, result: InsertResult): TaskModel[] {
  const store = project.taskStore;
  const records = new Map<string, TaskModel>();
  const created: TaskModel[] = [];
  const startAt = startDateFor(placement, mode);

  // Built off the store first, the way pasted copies are, then inserted in one go.
  const build = (task: PlannedTask, top: boolean): TaskModel => {
    const data: Record<string, unknown> = { name: task.name };
    if (task.children.length === 0) {
      data.duration = task.duration ?? 0;
      data.durationUnit = 'day';
      // Every task starts where the new work starts; its links then move it into place. A task without
      // a date would sit at the project start until the commit, stretching the group it is dropped into,
      // and that stretch would travel in the revision as if the user had moved the group. A first task
      // with nothing before it (dropped at the start of a group, or placed without links) stays pinned
      // there, like a task added by hand.
      if (startAt) data.startDate = startAt;
    } else {
      data.expanded = true;
    }
    if (task.note) data.note = task.note;
    if (task.costs.length > 0) {
      // Whole dollars in the snippet, minor units in the plan; the lines add up to the task's budget.
      const lines = task.costs.map((cost) => ({ label: cost.label, payee: cost.payee, amount_minor: cost.amount * 100, due: cost.due, paid_ref: null }));
      const total = lines.reduce((sum, line) => sum + line.amount_minor, 0);
      data.costLines = lines;
      data.budgetMinor = total;
      data.forecastMinor = total;
    }
    if (top) {
      data.libraryRef = plan.snippet.id;
      const bands = bandsFor(plan, task);
      if (bands.length > 0) data.bands = bands;
    }
    const record = store.createRecord(data) as TaskModel;
    for (const child of task.children) {
      tree(record).appendChild(build(child, false), true);
    }
    records.set(task.key, record);
    created.push(record);
    return record;
  };
  const tops = plan.copies.map((copy) => build(copy, true));
  // New work starts fresh: no progress, spending or payments (the same reset as pasted copies).
  prepareCopiedTasks(tops);

  const parent = tree(parentOf(placement));
  if (placement.kind === 'after') {
    const anchor = tree(placement.anchor);
    parent.insertChild(tops, anchor.nextSibling, false, { orderedBeforeNode: anchor.nextOrderedSibling });
  } else if (placement.kind === 'first') {
    parent.insertChild(tops, placement.before, false, { orderedBeforeNode: placement.before });
  } else {
    parent.insertChild(tops, null, false, { orderedBeforeNode: null });
  }
  // Renumber the whole group the work went into: the groups after the new work move down, and their
  // own tasks must follow (refreshing only the new rows left those numbers stale on this client).
  parent.refreshWbs({ deep: true, useOrderedTree: true });

  const idOf = (key: string) => {
    const record = records.get(key);
    if (!record) throw new Error(`Snippet task ${key} was not created`);
    return record.id;
  };
  const dependencies: Record<string, unknown>[] = plan.links.map((link) => ({
    fromEvent: idOf(link.from),
    toEvent: idOf(link.to),
    type: DEPENDENCY_TYPE[link.type],
    lag: link.lag,
    lagUnit: 'day',
  }));

  // What the new work follows: the anchor (or, at the start of a group, the task it goes before when running alongside).
  const anchor = anchorOf(placement) ?? (mode === 'alongside' && placement.kind === 'first' ? placement.before : null);
  if (anchor && mode !== 'unlinked') {
    const type = mode === 'alongside' ? DEPENDENCY_TYPE.SS : DEPENDENCY_TYPE.FS;
    for (const key of plan.entryKeys) {
      dependencies.push({ fromEvent: anchor.id, toEvent: idOf(key), type, lag: 0, lagUnit: 'day' });
    }
  }

  const led = new Set(dependencies.map((dependency) => dependency.toEvent));
  project.dependencyStore.add(dependencies as never);

  const matchCrew = crewMatcher(project);
  const unknownCrews: string[] = [];
  const assignments: Record<string, unknown>[] = [];
  const assign = (task: PlannedTask) => {
    for (const crew of task.crews) {
      const chosen = crews.get(crew.name);
      if (chosen === null) continue;
      const resource = chosen ?? matchCrew(crew.name);
      if (resource) {
        assignments.push({ event: idOf(task.key), resource: resource.id, units: crew.units ?? 100 });
      } else if (!unknownCrews.includes(crew.name)) {
        unknownCrews.push(crew.name);
      }
    }
    task.children.forEach(assign);
  };
  plan.copies.forEach(assign);
  if (assignments.length > 0) project.assignmentStore.add(assignments as never);

  result.tops = tops;
  result.created = created;
  result.unknownCrews = unknownCrews;
  return created.filter((task) => led.has(task.id));
}

/**
 * "Push later work back": the work that waited for the anchor (the links read before the drop) waits
 * for the new work's last copy instead; at the start of a group, the task it goes before does.
 */
function pushLaterWork(project: ProjectModel, placement: Placement, mode: DropMode, links: readonly DependencyModel[], result: InsertResult): void {
  if (mode !== 'push') return;
  const exit = result.tops.at(-1);
  if (!exit) return;
  if (placement.kind === 'first') {
    project.dependencyStore.add({ fromEvent: exit.id, toEvent: placement.before.id, type: DEPENDENCY_TYPE.FS, lag: 0, lagUnit: 'day' } as never);
    result.moved = 1;
    return;
  }
  const live = links.filter((link) => project.dependencyStore.includes(link as never));
  // One link per later task and type, keeping the longest lag (several tasks of a group may lead to it).
  const replacements = new Map<string, Record<string, unknown>>();
  for (const link of live) {
    const to = taskOf(link.toEvent)!.id;
    const key = `${String(to)}:${link.type}`;
    const lag = typeof link.lag === 'number' ? link.lag : 0;
    const existing = replacements.get(key);
    if (!existing || (existing.lag as number) < lag) {
      replacements.set(key, { fromEvent: exit.id, toEvent: to, type: link.type, lag, lagUnit: link.lagUnit ?? 'day' });
    }
    result.removedLinks.push({ fromEvent: taskOf(link.fromEvent)!.id as number, toEvent: to as number, type: link.type as number, lag, lagUnit: String(link.lagUnit ?? 'day') });
  }
  if (live.length > 0) project.dependencyStore.remove(live as never);
  project.dependencyStore.add([...replacements.values()] as never);
  result.moved = replacements.size;
}

/** Drops the snippet as one transaction (one revision) and resolves once the project is rescheduled. */
export function dropSnippet(project: ProjectModel, placement: Placement, plan: SnippetPlan, mode: DropMode, crews?: CrewChoices): Promise<InsertResult> {
  return withoutFilters(project, async () => {
    if (!placementInPlan(project, placement)) throw new Error('Not added: someone has just removed that place from the plan. Nothing was changed.');
    if (paymentLocks(project).size > 0) {
      const preview = await previewDrop(project, placement, plan, mode);
      if (preview.movesLocked) throw new Error(`${preview.error} Nothing was added.`);
    }
    const steps = insertSteps(project, placement, plan, mode, crews);
    let refused = false;
    let detach: (() => void) | undefined;
    try {
      await runProjectTransaction(project, `Add ${titleOf(plan)} from the library`, [
        () => {
          // Attached in the queued step, so only this drop's commits are watched.
          detach = project.on('commitRejected', () => {
            refused = true;
          }) as unknown as () => void;
          steps.add();
        },
        steps.push,
      ]);
    } finally {
      detach?.();
    }
    if (refused) {
      // The rollback leaves the outline numbers of the rows after it as they were with the piece in.
      tree(parentOf(placement)).refreshWbs({ deep: true, useOrderedTree: true });
      throw new Error('Not added: it clashes with a fixed date in the plan. Nothing was changed.');
    }
    if (steps.result.tops.length === 0) throw new Error('The snippet was not added');
    return steps.result;
  });
}

/** Whether what a placement names is still in the plan (someone may have removed it since). */
function placementInPlan(project: ProjectModel, placement: Placement): boolean {
  const here = (task: TaskModel | null) => !task || tree(task).isRoot || project.taskStore.getById(task.id) === task;
  return placement.kind === 'after' ? here(placement.anchor) : placement.kind === 'inside' ? here(placement.parent) && here(placement.anchor) : here(placement.parent) && here(placement.before);
}

/** Why the scheduler would refuse a change, in plain words (its own description is all dates and links). */
export function clashWords(refusal: unknown): string {
  const description = (refusal as { reason?: { getDescription?(): string } } | null)?.reason?.getDescription?.() ?? '';
  const name = /Task "([^"]+)"/.exec(description)?.[1];
  return name ? `Can’t push this: “${name}” has a fixed date.` : 'Can’t push this: it clashes with a fixed date in the plan.';
}

const titleOf = (plan: SnippetPlan) => `${plan.tweaks.name}${!plan.flat && plan.copies.length > 1 ? ` ×${plan.copies.length}` : ''}`;

/**
 * Takes a drop back out, as one transaction: the tasks it added (those still in the plan, with their
 * links and crews) go, and the links it moved onto the new work go back where they were (when both
 * ends are still there and no such link has been made since). Work changed after the drop stays.
 */
export function undoDrop(project: ProjectModel, plan: SnippetPlan, result: InsertResult): Promise<void> {
  return withoutFilters(project, () =>
    runProjectTransaction(project, `Take out ${titleOf(plan)}`, () => {
      const store = project.taskStore;
      const tops = result.tops.filter((top) => store.getById(top.id) === top);
      const parents = new Set(tops.map((top) => tree(top).parent).filter(Boolean));
      if (tops.length > 0) store.remove(tops as never);
      for (const parent of parents) if (store.getById(parent.id) === parent || tree(parent).isRoot) tree(parent).refreshWbs({ deep: true, useOrderedTree: true });
      const existing = new Set(
        (project.dependencyStore.allRecords as DependencyModel[]).map((link) => `${String(taskOf(link.fromEvent)?.id)}:${String(taskOf(link.toEvent)?.id)}:${String(link.type)}`),
      );
      const restore = result.removedLinks.filter((link) => store.getById(link.fromEvent) && store.getById(link.toEvent) && !existing.has(`${String(link.fromEvent)}:${String(link.toEvent)}:${String(link.type)}`));
      if (restore.length > 0) project.dependencyStore.add(restore.map((link) => ({ ...link })) as never);
    }),
  );
}

/** What a drop would do, worked out on a throwaway copy of the plan (nothing live changes). */
export interface DropPreview {
  handoverBefore: Date | null;
  handoverAfter: Date | null;
  /** When the new work would run. */
  start: Date | null;
  end: Date | null;
  /** Work already in the plan that would move, the furthest move first (calendar days, + is later). */
  moved: { id: number; name: string; days: number }[];
  error: string | null;
  /** It would move a task PayPal is paying for, and `error` says which. */
  movesLocked?: boolean;
}

const dayMs = 86_400_000;

/** The same placement in another copy of the project (tasks matched by id). */
function placementIn(copy: ProjectModel, placement: Placement): Placement | null {
  const root = (copy.taskStore as unknown as { rootNode: TaskModel }).rootNode;
  const find = (task: TaskModel | null): TaskModel | null => (!task ? null : tree(task).isRoot ? root : ((copy.taskStore.getById(task.id) as TaskModel | undefined) ?? null));
  switch (placement.kind) {
    case 'after': {
      const anchor = find(placement.anchor);
      return anchor ? { kind: 'after', anchor } : null;
    }
    case 'inside': {
      const parent = find(placement.parent);
      return parent ? { kind: 'inside', parent, anchor: find(placement.anchor) } : null;
    }
    case 'first': {
      const parent = find(placement.parent);
      const before = find(placement.before);
      return parent && before ? { kind: 'first', parent, before } : null;
    }
  }
}

/** Drops the snippet into a copy of the plan, lets the engine schedule it and says what moved. */
export async function previewDrop(project: ProjectModel, placement: Placement, plan: SnippetPlan, mode: DropMode): Promise<DropPreview> {
  const copy = createProjectModel();
  try {
    await loadProjectInlineData(copy, readProjectInlineData(project));
    const before = new Map<number, { start: number; end: number; name: string }>();
    for (const task of copy.taskStore.allRecords as TaskModel[]) {
      if (typeof task.id === 'number' && task.isLeaf && dateOf(task.startDate) && dateOf(task.endDate)) {
        before.set(task.id, { start: dateOf(task.startDate)!.getTime(), end: dateOf(task.endDate)!.getTime(), name: task.name ?? '' });
      }
    }
    const handoverBefore = handoverDate(copy);
    const at = placementIn(copy, placement);
    if (!at) return { handoverBefore, handoverAfter: handoverBefore, start: null, end: null, moved: [], error: 'That place is no longer in the plan' };
    const steps = insertSteps(copy, at, plan, mode);
    steps.add();
    const added = (await copy.commitAsync()) as { rejectedWith?: unknown } | undefined;
    if (!added?.rejectedWith) steps.push();
    const refusal = added?.rejectedWith ?? ((await copy.commitAsync()) as { rejectedWith?: unknown } | undefined)?.rejectedWith;
    if (refusal) return { handoverBefore, handoverAfter: handoverBefore, start: null, end: null, moved: [], error: clashWords(refusal) };
    const { result } = steps;
    const moved: DropPreview['moved'] = [];
    for (const [id, was] of before) {
      const task = copy.taskStore.getById(id) as TaskModel | undefined;
      const start = dateOf(task?.startDate)?.getTime();
      const end = dateOf(task?.endDate)?.getTime();
      if (start === undefined || end === undefined || (start === was.start && end === was.end)) continue;
      moved.push({ id, name: was.name, days: Math.round((end - was.end) / dayMs) });
    }
    moved.sort((a, b) => Math.abs(b.days) - Math.abs(a.days));
    const locked = moved.find((task) => paymentLocks(project).has(task.id));
    const starts = result.tops.map((top) => dateOf(top.startDate)).filter((date): date is Date => date !== null);
    const ends = result.tops.map((top) => dateOf(top.endDate)).filter((date): date is Date => date !== null);
    return {
      handoverBefore,
      handoverAfter: handoverDate(copy),
      start: starts.length > 0 ? new Date(Math.min(...starts.map((date) => date.getTime()))) : null,
      end: ends.length > 0 ? new Date(Math.max(...ends.map((date) => date.getTime()))) : null,
      moved,
      error: locked ? movedLockMessage(locked.name) : null,
      movesLocked: Boolean(locked),
    };
  } catch (reason) {
    return { handoverBefore: null, handoverAfter: null, start: null, end: null, moved: [], error: reason instanceof Error ? reason.message : String(reason) };
  } finally {
    copy.destroy();
  }
}
