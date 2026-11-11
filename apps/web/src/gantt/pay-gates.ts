/**
 * Payment gates on the live plan. A gate is a milestone carrying the task field `payGate`: it follows the
 * work it pays for and leads finish-to-start into the work it holds, so the scheduling engine keeps the held
 * work from starting before the money is in. Paying it through PayPal (gantt/pay-gate-payment.ts) records
 * what each task was paid and releases the work; scheduling the payment for a later day (`payOn`) is an
 * ordinary plan edit that moves the held work, and everything after it, through weekends and holidays.
 *
 * The money is worked out from the plan itself (packages/shared/src/progress-payments.ts): each firm's
 * tasks valued at their budgets, earned by their percent complete, less what is kept back until handover.
 */
import type { AssignmentModel, DependencyModel, ProjectModel, ResourceModel, TaskModel } from '@bryntum/gantt';
import { DEPENDENCY_TYPE_CODES, newPayGate, paidAfter, progressPayment, readPayGate, type PayGate, type ProgressPayment, type ProgressTask } from '@collab/shared';
import { runProjectTransaction } from '../scenario/publish';
import { walkTree } from './walk';

interface TreeTask {
  isLeaf: boolean;
  isRoot?: boolean;
  parent: TaskModel | null;
  nextSibling: TaskModel | null;
  nextOrderedSibling: TaskModel | null;
  insertChild(child: unknown, before?: unknown, silent?: boolean, options?: { orderedBeforeNode?: unknown }): unknown;
  contains(child: TaskModel, skipSelf?: boolean): boolean;
  refreshWbs(options: { deep: boolean; useOrderedTree: boolean }): void;
  remove(): void;
  traverse(fn: (node: TaskModel) => void): void;
}

const tree = (task: TaskModel) => task as unknown as TreeTask;
type Id = number | string;

export interface Gate {
  id: Id;
  task: TaskModel;
  payGate: PayGate;
  /** The rows whose work it pays for, as they are in the plan now. */
  pays: TaskModel[];
  /** The rows it holds: the group each of its successors sits in, or the successor itself. */
  holds: TaskModel[];
  /** Not paid yet: the rows it holds wait for it. */
  holding: boolean;
}

export interface GateIndex {
  gates: Map<Id, Gate>;
  /** Every row (groups and their tasks) held by a gate that isn't paid yet, and that gate. */
  held: Map<Id, Gate>;
}

// ---------------------------------------------------------------------------------------------
// Reading the plan
// ---------------------------------------------------------------------------------------------

/** The firm paid for a task: its crew's company. Machines on rent are paid as rentals, not here. */
export function firmOf(task: TaskModel): string | null {
  for (const assignment of (task.assignments ?? []) as AssignmentModel[]) {
    const resource = assignment.resource as (ResourceModel & { kind?: string; company?: string }) | null;
    if (!resource || resource.kind === 'equipment') continue;
    return resource.company || resource.name || null;
  }
  return null;
}

/** The tasks of work under these rows (a task stands for itself), each once; milestones and gates left out. */
export function workUnder(rows: readonly TaskModel[]): TaskModel[] {
  const seen = new Set<Id>();
  const work: TaskModel[] = [];
  for (const row of rows) {
    walkTree(row, (node) => {
      if (!node.isLeaf || node.isMilestone || seen.has(node.id)) return;
      seen.add(node.id);
      work.push(node);
    });
  }
  return work;
}

const minor = (task: TaskModel, field: string): number => {
  const value = (task as unknown as Record<string, unknown>)[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
};

export function progressTasks(rows: readonly TaskModel[]): ProgressTask[] {
  return workUnder(rows).map((task) => ({
    id: task.id,
    name: task.name ?? '',
    firm: firmOf(task),
    valueMinor: minor(task, 'budgetMinor'),
    percentDone: typeof task.percentDone === 'number' ? task.percentDone : 0,
    paidMinor: minor(task, 'paidMinor'),
  }));
}

/** What the gate's payment comes to now, from the plan's percent complete. */
export function paymentOf(gate: Gate): ProgressPayment {
  return progressPayment(progressTasks(gate.pays), gate.payGate.retainage);
}

const successorsOf = (task: TaskModel) => ((task as unknown as { outgoingDeps?: Set<DependencyModel> }).outgoingDeps ?? new Set<DependencyModel>());
const predecessorsOf = (task: TaskModel) => ((task as unknown as { incomingDeps?: Set<DependencyModel> }).incomingDeps ?? new Set<DependencyModel>());
const toOf = (link: DependencyModel) => link.toEvent as unknown as TaskModel | null;
const fromOf = (link: DependencyModel) => link.fromEvent as unknown as TaskModel | null;

function gateOf(project: AnyProject, task: TaskModel): Gate | null {
  const payGate = readPayGate((task as unknown as { payGate?: unknown }).payGate);
  if (!payGate) return null;
  const store = project.taskStore;
  const pays = payGate.pays.map((id) => store.getById(id) as TaskModel | undefined).filter((row): row is TaskModel => Boolean(row));
  const holds: TaskModel[] = [];
  for (const link of successorsOf(task)) {
    const next = toOf(link);
    if (!next) continue;
    const parent = tree(next).parent;
    const row = parent && !tree(parent).isRoot && !tree(parent).contains(task) ? parent : next;
    if (!holds.includes(row)) holds.push(row);
  }
  return { id: task.id, task, payGate, pays, holds, holding: payGate.state !== 'paid' };
}

/** Any project a task can belong to (the chart's, a copy, or what a task's `project` says it is). */
type AnyProject = Pick<ProjectModel, 'taskStore' | 'dependencyStore'>;

const indexes = new WeakMap<object, { index: GateIndex | null }>();

/** The plan's gates, worked out once per change of the plan. */
export function gateIndex(project: AnyProject): GateIndex {
  let entry = indexes.get(project);
  if (!entry) {
    const created: { index: GateIndex | null } = { index: null };
    const forget = () => {
      created.index = null;
    };
    project.taskStore.on({ change: forget, refresh: forget });
    project.dependencyStore.on({ change: forget, refresh: forget });
    indexes.set(project, created);
    entry = created;
  }
  if (entry.index) return entry.index;
  const gates = new Map<Id, Gate>();
  const held = new Map<Id, Gate>();
  for (const task of project.taskStore.allRecords as TaskModel[]) {
    if (!task.isMilestone) continue;
    const gate = gateOf(project, task);
    if (!gate) continue;
    gates.set(gate.id, gate);
    if (!gate.holding) continue;
    for (const row of gate.holds) walkTree(row, (node) => held.set(node.id, gate));
  }
  entry.index = { gates, held };
  return entry.index;
}

export function gateFor(project: unknown, task: TaskModel | null | undefined): Gate | null {
  const plan = project as AnyProject | null | undefined;
  if (!plan?.taskStore || !task) return null;
  return gateIndex(plan).gates.get(task.id) ?? null;
}

/** The unpaid gate holding this row, if one does. */
export function heldBy(project: unknown, task: TaskModel | null | undefined): Gate | null {
  const plan = project as AnyProject | null | undefined;
  if (!plan?.taskStore || !task) return null;
  return gateIndex(plan).held.get(task.id) ?? null;
}

// ---------------------------------------------------------------------------------------------
// Changing the plan
// ---------------------------------------------------------------------------------------------

/** The gate's name in the plan: a milestone named for what has happened when it is reached. */
export const gateName = (paid: TaskModel) => `${paid.name} paid`;

/**
 * Puts a gate after `paid` (a group or a task): the links that leave `paid` for later work now go through the
 * gate, so that work waits for the payment. Resolves to the gate's record: its id is a temporary one until
 * the server has numbered it. One undoable change.
 */
export async function addPayGate(project: ProjectModel, paid: TaskModel, retainage?: number): Promise<TaskModel> {
  const inside = (task: TaskModel | null) => Boolean(task) && (task === paid || tree(paid).contains(task!));
  const leaving = (project.dependencyStore.allRecords as DependencyModel[]).filter((link) => inside(fromOf(link)) && !inside(toOf(link)));
  if (leaving.length === 0) throw new Error(`Nothing in the plan waits for “${paid.name}”, so a payment there would hold nothing back.`);
  let gate: TaskModel | null = null;
  await runProjectTransaction(project, `Hold for payment: ${paid.name}`, () => {
    const store = project.taskStore;
    const end = paid.endDate instanceof Date ? paid.endDate : undefined;
    gate = store.createRecord({ name: gateName(paid), duration: 0, durationUnit: 'day', ...(end ? { startDate: end } : {}), payGate: newPayGate([paid.id], retainage) }) as TaskModel;
    if (tree(paid).isLeaf) {
      const parent = tree(paid).parent!;
      tree(parent).insertChild(gate, tree(paid).nextSibling, false, { orderedBeforeNode: tree(paid).nextOrderedSibling });
      tree(parent).refreshWbs({ deep: true, useOrderedTree: true });
    } else {
      tree(paid).insertChild(gate, null, false, { orderedBeforeNode: null });
      tree(paid).refreshWbs({ deep: true, useOrderedTree: true });
    }
    const sources = new Set<TaskModel>();
    for (const link of leaving) {
      const from = fromOf(link)!;
      const to = toOf(link)!;
      sources.add(from);
      project.dependencyStore.add({ fromEvent: gate.id, toEvent: to.id, type: link.type, lag: link.lag, lagUnit: link.lagUnit } as never);
      project.dependencyStore.remove(link);
    }
    for (const from of sources) project.dependencyStore.add({ fromEvent: from.id, toEvent: gate.id, type: DEPENDENCY_TYPE_CODES.FS, lag: 0, lagUnit: 'day' } as never);
  });
  // Placed by its links from now on, not pinned to the day it was put in.
  const placed = gate as TaskModel | null;
  if (!placed) throw new Error('The payment was not added to the plan.');
  await runProjectTransaction(project, `Hold for payment: ${paid.name}`, () => placed.set({ constraintType: null, constraintDate: null }));
  return placed;
}

/** Takes the gate out and joins the work before it straight to the work after it again. One undoable change. */
export function removePayGate(project: ProjectModel, gateId: Id): Promise<void> {
  const gate = project.taskStore.getById(gateId) as TaskModel | undefined;
  if (!gate) return Promise.resolve();
  return runProjectTransaction(project, `Remove the hold: ${gate.name}`, () => {
    const before = [...predecessorsOf(gate)];
    const after = [...successorsOf(gate)];
    for (const into of before) {
      for (const out of after) {
        const from = fromOf(into);
        const to = toOf(out);
        if (from && to) project.dependencyStore.add({ fromEvent: from.id, toEvent: to.id, type: out.type, lag: out.lag, lagUnit: out.lagUnit } as never);
      }
    }
    tree(gate).remove();
  });
}

/** The morning after `day`: money that lands during a day lets the work start the next working day. */
export const morningAfter = (day: Date) => new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);

/** The day the payment is set for, when it is set for a later day than it falls due. */
export function scheduledPayDay(gate: Gate): Date | null {
  const date = gate.task.constraintType === 'startnoearlierthan' && gate.task.constraintDate instanceof Date ? gate.task.constraintDate : null;
  return date ? new Date(date.getFullYear(), date.getMonth(), date.getDate() - 1) : null;
}

/**
 * When the payment will be made: the held work can't start before the next morning (the gate starts no
 * earlier than it). `null` puts it back to "as soon as the work it pays for is done". One undoable change.
 */
export function payOn(project: ProjectModel, gateId: Id, day: Date | null): Promise<void> {
  const gate = project.taskStore.getById(gateId) as TaskModel | undefined;
  if (!gate) return Promise.resolve();
  return runProjectTransaction(project, day ? `Pay ${gate.name} later` : `Pay ${gate.name} on time`, () =>
    gate.set(day ? { constraintType: 'startnoearlierthan', constraintDate: morningAfter(day) } : { constraintType: null, constraintDate: null }),
  );
}

/** Records a step of the gate's payment: sent to PayPal, or refused. */
export function markGate(project: ProjectModel, gateId: Id, patch: Partial<PayGate>): Promise<void> {
  const gate = project.taskStore.getById(gateId) as TaskModel | undefined;
  const current = gate ? readPayGate((gate as unknown as { payGate?: unknown }).payGate) : null;
  if (!gate || !current) return Promise.resolve();
  return runProjectTransaction(project, `Payment: ${gate.name}`, () => gate.set({ payGate: { ...current, ...patch } }));
}

/**
 * PayPal paid some of the firms and refused the rest. The firms it paid get their share now, so the next try asks only
 * for what is left and nobody is paid twice. The held work stays held until every firm is paid. One change.
 */
export function recordPartlyPaid(project: ProjectModel, gateId: Id, payment: ProgressPayment, firms: ReadonlySet<string>, error: string): Promise<void> {
  const gate = project.taskStore.getById(gateId) as TaskModel | undefined;
  const current = gate ? readPayGate((gate as unknown as { payGate?: unknown }).payGate) : null;
  if (!gate || !current) return Promise.resolve();
  const paidNow = payment.firms.filter((firm) => firms.has(firm.firm)).reduce((sum, firm) => sum + firm.dueMinor, 0);
  return runProjectTransaction(project, `Part paid with PayPal: ${gate.name}`, () => {
    for (const [taskId, paidMinor] of paidAfter(payment, firms)) {
      const task = project.taskStore.getById(taskId) as TaskModel | undefined;
      task?.set({ paidMinor });
    }
    gate.set({ payGate: { ...current, state: 'failed', batchKey: null, error: error.slice(0, 400), partPaidMinor: (current.partPaidMinor ?? 0) + paidNow } });
  });
}

/**
 * PayPal has paid: each task paid for gets its share, the gate records the batch, and the work it held is
 * released. If the payment was scheduled for later, that is taken off too. One change.
 */
export function recordPaid(project: ProjectModel, gateId: Id, payment: ProgressPayment, batchId: string, paidAt: Date): Promise<void> {
  const gate = project.taskStore.getById(gateId) as TaskModel | undefined;
  const current = gate ? readPayGate((gate as unknown as { payGate?: unknown }).payGate) : null;
  if (!gate || !current) return Promise.resolve();
  return runProjectTransaction(project, `Paid with PayPal: ${gate.name}`, () => {
    for (const [taskId, paidMinor] of paidAfter(payment)) {
      const task = project.taskStore.getById(taskId) as TaskModel | undefined;
      task?.set({ paidMinor });
    }
    gate.set({
      payGate: { ...current, state: 'paid', batchId, paidAt: paidAt.toISOString(), amountMinor: payment.dueMinor + (current.partPaidMinor ?? 0), error: null, partPaidMinor: null },
      percentDone: 100,
      ...(gate.constraintType ? { constraintType: null, constraintDate: null } : {}),
    });
  });
}
