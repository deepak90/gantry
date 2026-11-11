/**
 * Carrying out a plan edit the assistant drafted, in this browser, when a person presses "Apply":
 * the operations exactly as the card shows them, in one transaction (one revision for everyone),
 * checked again against the live plan first. Before that, the card previews the edit on a throwaway
 * copy of the project (the same operations, scheduled by the engine) to say what moves, the handover
 * date included. Nothing here talks to the assistant; the panel reports the outcome in the thread.
 */
import type { AssignmentModel, DependencyModel, ProjectModel, ResourceModel, TaskModel } from '@bryntum/gantt';
import { addDays, DEPENDENCY_TYPE_CODES, defaultTweaks, normalName, planSnippet, snippetWithout, type PlanEditOp, type Snippet, type TaskCostLine, type TaskRef } from '@collab/shared';
import { scheduleChanges, scheduleDraftFor, setRentalDates, writeScheduleChange } from '../gantt/cell-editors';
import { copyTasks } from '../gantt/task-clipboard';
import { withoutFilters } from '../gantt/filters';
import { movedLockMessage, paymentLocks } from '../gantt/payment-lock';
import { createProjectModel, loadProjectInlineData, readProjectInlineData } from '../gantt/project';
import { handoverDate } from '../library/describe';
import { clashWords, crewMatcher, insertSteps, placementFor, unpin } from '../library/insert';
import { freeCrewColor } from '../inspector/crew-palette';
import { runProjectTransaction } from '../scenario/publish';

export class PlanEditError extends Error {}

/** What a day of this machine on this task costs, when the person applying the edit may see it. */
export type RentalRate = (taskId: number, resourceId: number) => number | null;

interface TreeTask {
  isLeaf: boolean;
  isRoot?: boolean;
  isMilestone?: boolean;
  parent: TaskModel | null;
  orderedChildren?: TaskModel[] | null;
  nextSibling: TaskModel | null;
  nextOrderedSibling: TaskModel | null;
  children?: TaskModel[] | boolean;
  insertChild(child: unknown, before?: unknown, silent?: boolean, options?: { orderedBeforeNode?: unknown }): unknown;
  appendChild(child: unknown): unknown;
  contains(child: TaskModel, skipSelf?: boolean): boolean;
  refreshWbs(options: { deep: boolean; useOrderedTree: boolean }): void;
  remove(): void;
}

const tree = (task: TaskModel) => task as unknown as TreeTask;
const dateOf = (value: unknown): Date | null => (value instanceof Date ? value : null);

/**
 * Applies the operations to `project` (no transaction: callers wrap it). Throws PlanEditError with a
 * plain reason. Returns the second step of every library piece added with "push later work back", and
 * what takes the pin off new tasks that were linked (`unpin`), to run once the rest is scheduled (see
 * `InsertSteps`).
 */
export async function applyOperations(project: ProjectModel, operations: readonly PlanEditOp[], library: (id: string) => Snippet | undefined, rateOf?: RentalRate): Promise<(() => void)[]> {
  const pushes: (() => void)[] = [];
  const store = project.taskStore;
  const root = (project.taskStore as unknown as { rootNode: TaskModel }).rootNode;
  const refs = new Map<string, TaskModel>();
  const led = new Set<TaskModel>();
  // Read again after a firm is added, so the edit's later operations can give it work.
  let matchCrew = crewMatcher(project);
  const taskOf = (ref: TaskRef): TaskModel => {
    const task = 'id' in ref ? (store.getById(ref.id) as TaskModel | undefined) : refs.get(ref.ref);
    if (!task) throw new PlanEditError('id' in ref ? `Task ${ref.id} is no longer in the plan.` : `The new task "${ref.ref}" was not added.`);
    return task;
  };
  const byId = (id: number) => taskOf({ id });
  const linkBetween = (from: number, to: number) =>
    (project.dependencyStore.allRecords as DependencyModel[]).find(
      (link) => (link.fromEvent as unknown as TaskModel | null)?.id === from && (link.toEvent as unknown as TaskModel | null)?.id === to,
    );

  for (const op of operations) {
    switch (op.op) {
      case 'add_task': {
        const parent = op.parent ? taskOf(op.parent) : root;
        const after = op.after ? taskOf(op.after) : null;
        const start = dateOf(after?.endDate) ?? dateOf(parent.startDate) ?? dateOf(project.startDate);
        const record = store.createRecord({ name: op.name, duration: op.days, durationUnit: 'day', ...(start ? { startDate: start } : {}), ...(op.note ? { note: op.note } : {}) }) as TaskModel;
        if (after) tree(parent).insertChild(record, tree(after).nextSibling, false, { orderedBeforeNode: tree(after).nextOrderedSibling });
        else tree(parent).insertChild(record, null, false, { orderedBeforeNode: null });
        tree(parent).refreshWbs({ deep: true, useOrderedTree: true });
        refs.set(op.ref, record);
        break;
      }
      case 'update_task': {
        const task = byId(op.task);
        const values: Record<string, unknown> = {};
        if (op.name !== undefined) values.name = op.name;
        if (op.days !== undefined) {
          if (!task.isLeaf) throw new PlanEditError(`“${task.name}” is a group; its dates come from its tasks.`);
          values.duration = op.days;
          values.durationUnit = 'day';
        }
        if (op.percent_done !== undefined) values.percentDone = op.percent_done;
        if (op.note !== undefined) values.note = op.note;
        if (op.start_no_earlier_than !== undefined) {
          values.constraintType = op.start_no_earlier_than ? 'startnoearlierthan' : null;
          values.constraintDate = op.start_no_earlier_than ? new Date(`${op.start_no_earlier_than}T00:00:00`) : null;
        }
        if (op.manually_scheduled !== undefined) values.manuallyScheduled = op.manually_scheduled;
        if (op.inactive !== undefined) values.inactive = op.inactive;
        task.set(values);
        if (op.last_day !== undefined) {
          if (!task.isLeaf) throw new PlanEditError(`“${task.name}” is a group; its dates come from its tasks.`);
          // As the task panel sets a finish: the last working day on the task's own calendar, its days following.
          const opened = scheduleDraftFor(project, task);
          const draft = scheduleDraftFor(project, task);
          draft.setLastDay(new Date(`${op.last_day}T00:00:00`));
          writeScheduleChange(project, task, scheduleChanges(opened, draft));
        }
        break;
      }
      case 'indent_task': {
        const task = byId(op.task);
        const parent = tree(task).parent ?? root;
        const inGroup = (tree(parent).orderedChildren ?? (Array.isArray(tree(parent).children) ? (tree(parent).children as TaskModel[]) : [])) as TaskModel[];
        const above = inGroup[inGroup.indexOf(task) - 1];
        if (!above) throw new PlanEditError(`“${task.name}” is first in its group: there is nothing above it to go into.`);
        if (tree(above).isMilestone) throw new PlanEditError(`“${above.name}” is a milestone: it can’t hold tasks.`);
        // A task can't wait for the group it is in, nor a group for a task inside it: the engine would refuse it.
        if (linkBetween(Number(above.id), Number(task.id)) || linkBetween(Number(task.id), Number(above.id))) {
          throw new PlanEditError(`“${task.name}” and “${above.name}” are linked: unlink them first, or it can’t go into it.`);
        }
        // As Indent does: into the task above, at its end.
        tree(above).insertChild(task, null, false, { orderedBeforeNode: null });
        tree(parent).refreshWbs({ deep: true, useOrderedTree: true });
        break;
      }
      case 'outdent_task': {
        const task = byId(op.task);
        const parent = tree(task).parent;
        if (!parent || tree(parent).isRoot) throw new PlanEditError(`“${task.name}” is already at the top level.`);
        // As Outdent does: just after the group it leaves; the tasks after it stay in the group.
        const grand = tree(parent).parent ?? root;
        tree(grand).insertChild(task, tree(parent).nextSibling, false, { orderedBeforeNode: tree(parent).nextOrderedSibling });
        tree(grand).refreshWbs({ deep: true, useOrderedTree: true });
        break;
      }
      case 'duplicate_task': {
        const task = byId(op.task);
        const after = op.after ? taskOf(op.after) : task;
        const copied = copyTasks(project, [task], after, op.name);
        if (op.ref && copied.tops[0]) refs.set(op.ref, copied.tops[0]);
        pushes.push(copied.settle);
        break;
      }
      case 'delete_task':
        tree(byId(op.task)).remove();
        break;
      case 'move_task': {
        const task = byId(op.task);
        const parent = op.parent ? taskOf(op.parent) : root;
        if (parent === task || tree(task).contains(parent)) throw new PlanEditError(`“${task.name}” cannot go inside itself.`);
        const after = op.after ? taskOf(op.after) : null;
        if (after) tree(parent).insertChild(task, tree(after).nextSibling, false, { orderedBeforeNode: tree(after).nextOrderedSibling });
        else tree(parent).insertChild(task, null, false, { orderedBeforeNode: null });
        tree(parent).refreshWbs({ deep: true, useOrderedTree: true });
        break;
      }
      case 'link': {
        const from = taskOf(op.from);
        const to = taskOf(op.to);
        if (typeof from.id === 'number' && typeof to.id === 'number' && linkBetween(from.id, to.id)) {
          throw new PlanEditError(`“${to.name}” already waits for “${from.name}”.`);
        }
        project.dependencyStore.add({ fromEvent: from.id, toEvent: to.id, type: DEPENDENCY_TYPE_CODES[op.type], lag: op.lag_days, lagUnit: 'day' } as never);
        led.add(to);
        break;
      }
      case 'unlink': {
        const link = linkBetween(op.from, op.to);
        if (!link) throw new PlanEditError(`“${byId(op.to).name}” no longer waits for “${byId(op.from).name}”.`);
        project.dependencyStore.remove(link);
        break;
      }
      case 'set_link': {
        const link = linkBetween(op.from, op.to);
        if (!link) throw new PlanEditError(`“${byId(op.to).name}” no longer waits for “${byId(op.from).name}”.`);
        link.set({ ...(op.type ? { type: DEPENDENCY_TYPE_CODES[op.type] } : {}), ...(op.lag_days !== undefined ? { lag: op.lag_days, lagUnit: 'day' } : {}) });
        break;
      }
      case 'set_rental': {
        const task = byId(op.task);
        const machine = matchCrew(op.machine);
        const assignment = ((task.assignments ?? []) as AssignmentModel[]).find((candidate) => (candidate.resource as ResourceModel | null)?.id === machine?.id);
        if (!assignment) throw new PlanEditError(`${op.machine} is not on “${task.name}”.`);
        if (op.last_day < op.first_day) throw new PlanEditError('A rental cannot end before it starts.');
        const current = assignment as AssignmentModel & { rentalStart?: string | null; rentalEnd?: string | null };
        const end = addDays(op.last_day, 1);
        setRentalDates(assignment, { start: op.first_day, end }, { start: current.rentalStart ?? op.first_day, end: current.rentalEnd ?? end }, rateOf?.(op.task, machine!.id as number) ?? null);
        break;
      }
      case 'add_crew': {
        const resources = project.resourceStore.allRecords as ResourceModel[];
        if (resources.some((resource) => normalName(resource.name ?? '') === normalName(op.name))) throw new PlanEditError(`${op.name} is already on this project.`);
        // `kind`, `company` and `trade` are CollabResource fields the ResourceModel config type does not know.
        project.resourceStore.add({
          name: op.name,
          kind: 'labor',
          company: op.name,
          trade: op.trade,
          eventColor: freeCrewColor(resources.map((resource) => resource.eventColor as string | undefined)),
          iconCls: 'fa fa-helmet-safety',
        } as object);
        matchCrew = crewMatcher(project);
        break;
      }
      case 'assign_crew': {
        const task = taskOf(op.task);
        const crew = matchCrew(op.crew);
        if (!crew) throw new PlanEditError(`There is no crew called “${op.crew}” on this project.`);
        const existing = (project.assignmentStore.allRecords as AssignmentModel[]).find((assignment) => assignment.event === task && assignment.resource === (crew as ResourceModel));
        if (existing) existing.set({ units: op.units });
        else project.assignmentStore.add({ event: task.id, resource: crew.id, units: op.units } as never);
        break;
      }
      case 'unassign_crew': {
        const task = byId(op.task);
        const crew = matchCrew(op.crew);
        const existing = (project.assignmentStore.allRecords as AssignmentModel[]).find((assignment) => assignment.event === task && crew && assignment.resource === (crew as ResourceModel));
        if (!existing) throw new PlanEditError(`“${task.name}” has no crew called “${op.crew}”.`);
        project.assignmentStore.remove(existing);
        break;
      }
      case 'add_snippet': {
        const whole = library(op.snippet_id);
        if (!whole) throw new PlanEditError('That piece is no longer in the library.');
        // Work done once for the whole building (ordering, delivery) stays where the piece first went.
        const snippet = op.leave_out ? snippetWithout(whole, op.leave_out) : whole;
        if (snippet.children.length === 0) throw new PlanEditError(`Nothing of “${whole.name}” is left to add.`);
        const plan = planSnippet(snippet, { ...defaultTweaks(snippet), ...(op.name ? { name: op.name } : {}), repeats: op.repeats });
        const placement =
          op.after !== undefined ? placementFor(byId(op.after), 'after') : op.inside !== undefined ? placementFor(byId(op.inside), 'inside') : op.before !== undefined ? placementFor(byId(op.before), 'before') : null;
        if (!placement) throw new PlanEditError('The library piece has no place.');
        const before = op.waits_for !== undefined ? byId(op.waits_for) : null;
        const steps = insertSteps(project, placement, plan, op.mode);
        steps.add();
        if (before) {
          // The piece's first tasks also wait for that one (the delivery where it first went).
          const created = new Set(steps.result.created);
          const links = project.dependencyStore.allRecords as DependencyModel[];
          const firsts = steps.result.created.filter(
            (task) => task.isLeaf && !links.some((link) => link.toEvent === (task as unknown) && created.has(link.fromEvent as unknown as TaskModel)),
          );
          for (const first of firsts) {
            // Floors one after another already come after it: a link would only draw a long arrow.
            if (follows(links, before, first)) continue;
            project.dependencyStore.add({ fromEvent: before, toEvent: first, type: DEPENDENCY_TYPE_CODES.FS, lag: 0, lagUnit: 'day' } as never);
            led.add(first);
          }
        }
        pushes.push(steps.push);
        break;
      }
      case 'set_cost': {
        const task = byId(op.task) as TaskModel & { costLines?: TaskCostLine[] | null };
        if (!task.isLeaf) throw new PlanEditError(`“${task.name}” is a group; what it costs comes from its tasks.`);
        const lines = task.costLines ?? [];
        if (lines.some((line) => line.paid_ref)) throw new PlanEditError(`“${task.name}” is already paid for.`);
        if (lines.length !== 1) throw new PlanEditError(`“${task.name}” has ${lines.length === 0 ? 'no cost' : 'several costs'} to change; change it in its Costs tab.`);
        const line = { ...lines[0]!, ...(op.label ? { label: op.label } : {}), ...(op.payee ? { payee: op.payee } : {}) };
        if (op.amount === undefined) {
          task.set({ costLines: [line] });
          break;
        }
        const amountMinor = op.amount * 100;
        task.set({ costLines: [{ ...line, amount_minor: amountMinor }], budgetMinor: amountMinor, forecastMinor: amountMinor });
        break;
      }
    }
  }
  pushes.push(() => unpin([...refs.values()].filter((task) => led.has(task))));
  return pushes;
}

/**
 * The tasks already in the plan that a change touches, in the order it touches them: what to show once it is applied
 * (the rows it adds are found after). A task it deletes is shown by the group it was in. Read before applying.
 */
export function tasksTouched(project: ProjectModel, operations: readonly PlanEditOp[]): number[] {
  const ids: number[] = [];
  const add = (id: unknown) => {
    if (typeof id === 'number' && !ids.includes(id)) ids.push(id);
  };
  for (const op of operations) {
    switch (op.op) {
      case 'update_task':
      case 'move_task':
      case 'indent_task':
      case 'outdent_task':
      case 'set_rental':
      case 'set_cost':
      case 'unassign_crew':
        add(op.task);
        break;
      case 'delete_task': {
        const parent = tree(project.taskStore.getById(op.task) as TaskModel).parent;
        if (parent && !tree(parent).isRoot) add(parent.id);
        break;
      }
      case 'link':
        if ('id' in op.to) add(op.to.id);
        break;
      case 'unlink':
      case 'set_link':
        add(op.to);
        break;
      case 'assign_crew':
        if ('id' in op.task) add(op.task.id);
        break;
      default:
        break;
    }
  }
  return ids;
}

/** Whether `to` already waits for `from` through the plan's links, however many steps away. */
function follows(links: readonly DependencyModel[], from: TaskModel, to: TaskModel): boolean {
  const next = new Map<unknown, unknown[]>();
  for (const link of links) next.set(link.fromEvent, [...(next.get(link.fromEvent) ?? []), link.toEvent]);
  const seen = new Set<unknown>([from]);
  const queue: unknown[] = [from];
  while (queue.length > 0) {
    for (const after of next.get(queue.shift()) ?? []) {
      if (after === to) return true;
      if (!seen.has(after)) {
        seen.add(after);
        queue.push(after);
      }
    }
  }
  return false;
}

/** Applies the chosen operations in this browser as one change for everyone. */
export async function applyPlanEdit(project: ProjectModel, title: string, operations: readonly PlanEditOp[], library: (id: string) => Snippet | undefined, rateOf?: RentalRate): Promise<void> {
  if ((project as ProjectModel & { readOnly?: boolean }).readOnly) throw new PlanEditError('This plan is read only here.');
  if (paymentLocks(project).size > 0) {
    const preview = await previewPlanEdit(project, operations, library);
    if (preview.movesLocked) throw new PlanEditError(preview.error!);
  }
  let pushes: (() => void)[] = [];
  await withoutFilters(project, () =>
    runProjectTransaction(project, title, [
      async () => {
        pushes = await applyOperations(project, operations, library, rateOf);
      },
      () => pushes.forEach((push) => push()),
    ]),
  );
}

export interface EditPreview {
  handoverBefore: Date | null;
  handoverAfter: Date | null;
  /** Tasks already in the plan whose dates change. */
  moved: { id: number; name: string; days: number }[];
  added: number;
  removed: number;
  error: string | null;
  /** It would move a task PayPal is paying for, and `error` says which. */
  movesLocked?: boolean;
}

/** The edit tried on a copy of the project (scheduled by the engine): what would move. The live plan is untouched. */
export async function previewPlanEdit(project: ProjectModel, operations: readonly PlanEditOp[], library: (id: string) => Snippet | undefined): Promise<EditPreview> {
  const copy = createProjectModel();
  try {
    await loadProjectInlineData(copy, readProjectInlineData(project));
    const dates = new Map((copy.taskStore.allRecords as TaskModel[]).map((task) => [task.id, { start: dateOf(task.startDate)?.getTime(), end: dateOf(task.endDate)?.getTime(), name: task.name }]));
    const handoverBefore = handoverDate(copy);
    const before = copy.taskStore.allRecords.length;
    let error: string | null = null;
    try {
      const pushes = await applyOperations(copy, operations, library);
      const applied = (await copy.commitAsync()) as { rejectedWith?: unknown } | undefined;
      if (!applied?.rejectedWith) pushes.forEach((push) => push());
      const refusal = applied?.rejectedWith ?? ((await copy.commitAsync()) as { rejectedWith?: unknown } | undefined)?.rejectedWith;
      if (refusal) error = clashWords(refusal);
    } catch (reason) {
      error = reason instanceof Error ? reason.message : String(reason);
    }
    const moved: EditPreview['moved'] = [];
    for (const task of copy.taskStore.allRecords as TaskModel[]) {
      const was = dates.get(task.id);
      const end = dateOf(task.endDate)?.getTime();
      if (!was || typeof task.id !== 'number' || !task.isLeaf || was.end === undefined || end === undefined) continue;
      if (was.end !== end || was.start !== dateOf(task.startDate)?.getTime()) {
        moved.push({ id: task.id, name: task.name, days: Math.round((end - was.end) / 86_400_000) });
      }
    }
    moved.sort((a, b) => Math.abs(b.days) - Math.abs(a.days));
    const locked = moved.find((task) => paymentLocks(project).has(task.id));
    if (locked && !error) error = movedLockMessage(locked.name);
    const removed = [...dates.keys()].filter((id) => !copy.taskStore.getById(id as number)).length;
    return { handoverBefore, handoverAfter: error ? handoverBefore : handoverDate(copy), moved, added: Math.max(0, copy.taskStore.allRecords.length - before + removed), removed, error, movesLocked: Boolean(locked) };
  } finally {
    copy.destroy();
  }
}
