import { TaskModel } from '@bryntum/gantt';
import type { Model, ModelFieldConfig, ProjectModel } from '@bryntum/gantt';
import type { PayGate, TaskBand, TaskCostLine } from '@collab/shared';
import { installPaymentLock } from '../payment-lock';
import { recordsSplitWrite } from '../revisions/split-tasks';
import { CollabBaseline } from './CollabBaseline';
import type { RecordFilter } from './CollabSegment';
import { COLLAB_DATE_FORMAT, TZ_LESS_DATE_FIELDS } from './date-format';
import { ignored, safeColor } from './safe-fields';

/**
 * Partway through a paste the engine can report a task as split before its segments are there, and
 * Bryntum's progress bar then reads them while drawing the bar: the error took the whole plan off the
 * screen. Bryntum's own accessor is wrapped, so the engine goes on reading and writing it as before.
 */
function guardSplitReads(taskClass: typeof TaskModel): void {
  for (let proto = taskClass.prototype as object | null; proto; proto = Object.getPrototypeOf(proto)) {
    const accessor = Object.getOwnPropertyDescriptor(proto, 'isSegmented');
    if (!accessor?.get) continue;
    Object.defineProperty(taskClass.prototype, 'isSegmented', {
      configurable: true,
      get(this: TaskModel) {
        return Boolean(accessor.get!.call(this)) && Boolean((this.segments as unknown as unknown[] | null | undefined)?.length);
      },
      ...(accessor.set ? { set: accessor.set } : {}),
    });
    return;
  }
}

/** Commercial figures carried on every task, in integer minor units of the project currency. */
export const COST_FIELDS = ['budgetMinor', 'forecastMinor', 'incurredMinor', 'paidMinor'] as const;
export type CostField = (typeof COST_FIELDS)[number];

export class CollabTask extends TaskModel {
  static override $name = 'CollabTask';

  static override fields: ModelFieldConfig[] = [
    ...TZ_LESS_DATE_FIELDS,
    // Checked as they load (safe-fields.ts): a color goes into the bar's style; a `href` (or its `target`) would make
    // the name in the tree column a link, so the plan never sets one.
    { name: 'eventColor', convert: safeColor },
    { name: 'href', convert: ignored, persist: false },
    { name: 'target', convert: ignored, persist: false },
    { name: 'constraintDate', type: 'date', format: COLLAB_DATE_FORMAT },
    // Edited in the task panel; travels like every other task date.
    { name: 'deadlineDate', type: 'date', format: COLLAB_DATE_FORMAT },
    // Re-declaring the store field keeps TaskModel's store class and lazy loading; only the model changes.
    { name: 'baselines', type: 'store', modelClass: CollabBaseline },
    // Persisted so every client agrees on task order within a parent and on WBS (guide "Synchronizing WBS").
    { name: 'parentIndex', persist: true },
    { name: 'orderedParentIndex', persist: true },
    { name: 'budgetMinor', type: 'integer', defaultValue: 0 },
    { name: 'forecastMinor', type: 'integer', defaultValue: 0 },
    { name: 'incurredMinor', type: 'integer', defaultValue: 0 },
    { name: 'paidMinor', type: 'integer', defaultValue: 0 },
    { name: 'costCode', type: 'string', defaultValue: '' },
    // The publication (publications.id) whose approved change was last applied to this task. Set in
    // the same transaction as the change, so every published revision links back to its decision.
    { name: 'decisionRef', type: 'string', defaultValue: null },
    // On the top task of a piece dropped from the library: the library snippet it came from, and the
    // snippet's time ranges, tied to positions inside this task (see library/bands.ts). Travels in
    // revisions like any task field; the bands drawn on the timeline are derived from it.
    { name: 'libraryRef', type: 'string', defaultValue: null },
    { name: 'bands', type: 'array', defaultValue: null },
    // What the task costs and who is paid (TaskCostLine in packages/shared/src/payables.ts), from the
    // library piece it came from; its total is the task's budget.
    { name: 'costLines', type: 'array', defaultValue: null },
    // On a payment milestone: the progress payment the work after it waits for (PayGate in
    // packages/shared/src/progress-payments.ts; gantt/pay-gates.ts). Travels in revisions like any task field.
    { name: 'payGate', type: 'object', defaultValue: null },
  ];

  declare budgetMinor: number;
  declare forecastMinor: number;
  declare incurredMinor: number;
  declare paidMinor: number;
  declare costCode: string;
  declare decisionRef: string | null;
  declare libraryRef: string | null;
  declare bands: TaskBand[] | null;
  declare costLines: TaskCostLine[] | null;
  declare payGate: PayGate | null;

  /** The engine's own rewrite of `segments` is not recorded; see `recordsSplitWrite`. */
  shouldRecordFieldChange(fieldName: string, oldValue: unknown, newValue: unknown): boolean {
    if (fieldName === 'segments' && !recordsSplitWrite(this)) {
      return false;
    }
    return (TaskModel.prototype as unknown as RecordFilter).shouldRecordFieldChange.call(this, fieldName, oldValue, newValue);
  }

  /**
   * Bryntum redoes this client's unconfirmed revisions on top of each revision it applies. Redoing a
   * move into a group (or an add under it) that the applied revision deleted put the task into the
   * deleted group: this client lost the task, while every other client, applying the deletion first,
   * ignores the move and keeps it. While the STM restores, nothing is inserted into a task that is no
   * longer in the project; the task stays where it was, and the revision's input is reconciled the same
   * way when it comes back (`reconcileInput`). Nor does a task go under itself, which is what redoing a
   * move would do once someone else's has put the target group inside the task being moved.
   */
  override insertChild(childRecord: Model | Model[] | object | object[], before?: Model, silent?: boolean, ...rest: unknown[]): Model | Model[] | null {
    // A deleted task has left the project; the task being moved in still knows it.
    const moved = (Array.isArray(childRecord) ? childRecord : [childRecord]) as { project?: unknown; contains?(child: unknown): boolean }[];
    const project = ((this.project as unknown) ?? moved.find((child) => child?.project)?.project) as ProjectModel | undefined;
    const stm = project?.stm as unknown as { isRestoringState?: boolean; isCheckingOut?: boolean } | undefined;
    if ((stm?.isRestoringState || stm?.isCheckingOut) && !this.isRoot && (project?.taskStore.getById(this.id) !== this || moved.some((child) => child?.contains?.(this)))) {
      return null;
    }
    return (TaskModel.prototype as unknown as InsertChild).insertChild.call(this, childRecord, before, silent, ...rest);
  }
}

// Read-only in the UI while PayPal pays for the task (gantt/payment-lock.ts); not a stored change.
installPaymentLock(CollabTask);
guardSplitReads(CollabTask);

interface InsertChild {
  insertChild(this: unknown, childRecord: unknown, before?: unknown, silent?: boolean, ...rest: unknown[]): Model | Model[] | null;
}
