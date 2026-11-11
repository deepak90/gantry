/**
 * Bryntum's VersionGrid over the project's changelog store, dressed for people who are not schedulers:
 * each transaction row reads as a sentence with who did it and when, and expands into what changed
 * (Bryntum's own property-update rows, with the Gantt's column names as labels).
 *
 * Versions are not shown, and the grid's version menu (Restore, Compare, Rename) and cell editing are
 * switched off: restoring a version would replace the project's data outside the revision stream and
 * leave every other browser out of step.
 */
import { StringHelper, VersionGrid } from '@bryntum/gantt';
import type { DomConfig, Model, ProjectModel } from '@bryntum/gantt';
import { fullTime, relativeTime } from './format';
import { resolveActor, type ChangelogKind, type CollabChangeLogTransaction, type People, type TextPart } from './model';
import { fieldLabel } from './revisions';

/** A kind of entry, or every entry that moved money (`costs`). */
export type ChangelogFilter = 'all' | ChangelogKind | 'costs';

interface EntityLike {
  type: string;
  name: string;
  fromTask?: EntityLike;
  toTask?: EntityLike;
  event?: EntityLike;
  resource?: EntityLike;
}

interface ActionLike {
  actionType: 'add' | 'remove' | 'update' | 'move';
  entity: EntityLike;
  propertyUpdates?: unknown[];
  isUser?: boolean;
}

interface PropertyUpdateLike {
  property: string;
  before?: unknown;
  after: unknown;
}

/** VersionGrid's row model: one row per transaction, per action and per property update. */
interface GridRow extends Model {
  transactionModel?: CollabChangeLogTransaction;
  action?: ActionLike;
  propertyUpdate?: PropertyUpdateLike;
  parent: GridRow;
}

const span = (className: string, text: string, extra: DomConfig = {}): DomConfig => ({ tag: 'span', className, text, ...extra });

/** The kind of row the action describes, in plain words with the names highlighted. */
function actionParts(action: ActionLike): TextPart[] {
  const { entity, actionType } = action;
  const name = { name: entity.name };
  switch (entity.type) {
    case 'DependencyModel': {
      const ends: TextPart[] = [{ name: entity.fromTask?.name ?? '?' }, ' → ', { name: entity.toTask?.name ?? '?' }];
      return actionType === 'add' ? ['Linked ', ...ends] : actionType === 'remove' ? ['Unlinked ', ...ends] : ['Changed the link ', ...ends];
    }
    case 'AssignmentModel': {
      const crew = { name: entity.resource?.name ?? 'a crew' };
      const task = { name: entity.event?.name ?? 'a task' };
      return actionType === 'add' ? ['Put ', crew, ' on ', task] : actionType === 'remove' ? ['Took ', crew, ' off ', task] : ['Changed ', crew, ' on ', task];
    }
    case 'ResourceModel':
      return actionType === 'add' ? ['Added the crew ', name] : actionType === 'remove' ? ['Removed the crew ', name] : ['Edited the crew ', name];
    case 'ProjectModel':
      return ['The whole project'];
    case 'TaskModel':
      if (actionType === 'add') return ['Added ', name];
      if (actionType === 'remove') return ['Removed ', name];
      return action.isUser ? ['Changed ', name] : [name, ' moved as a result'];
    default:
      return [name];
  }
}

function highlighted(parts: readonly TextPart[]): DomConfig[] {
  return parts
    .filter((part) => part !== '')
    .map((part) =>
      typeof part === 'string'
        ? span('changelog-text', part)
        : span(`b-version-grid-highlighted-entity${part.taskId !== undefined ? ' changelog-link' : ''}`, part.name, part.taskId !== undefined ? { dataset: { taskId: String(part.taskId) }, title: 'Show on the plan' } : {}),
    );
}

const KIND_LABELS: Readonly<Record<ChangelogKind, string>> = { plan: 'Plan', fix: 'Fix', payment: 'Payment' };

export class ChangelogGrid extends VersionGrid {
  static override $name = 'ChangelogGrid';

  /** Set after construction: rows rendered while Bryntum constructs the grid fall back to "Someone". */
  declare people: People | undefined;
  declare now: (() => Date) | undefined;

  /** The tree column renders every row kind through here. */
  renderDescription({ record }: { record: GridRow }): DomConfig | string {
    if (record.propertyUpdate) {
      return this.renderPropertyUpdate(record.propertyUpdate, record.parent?.action?.entity);
    }
    if (record.action) {
      return { children: [{ className: 'changelog-action', children: highlighted(actionParts(record.action)) }] };
    }
    const transaction = record.transactionModel;
    return transaction ? this.renderTransaction(transaction) : StringHelper.encodeHtml(String(record.get('description') ?? ''));
  }

  renderTransaction(transaction: CollabChangeLogTransaction): DomConfig {
    const actor = resolveActor(transaction.actor ?? { type: 'system' }, this.people ?? new Map());
    const occurredAt = transaction.occurredAt instanceof Date ? transaction.occurredAt.toISOString() : String(transaction.occurredAt);
    // Who, with what kind of change as a badge on the avatar.
    const badge: DomConfig = { tag: 'i', className: `changelog-badge ${transaction.icon ?? 'fa fa-circle'}`, 'aria-hidden': 'true' };
    const face: DomConfig = actor.icon
      ? { tag: 'i', className: actor.icon }
      : actor.initials
        ? { tag: 'span', text: actor.initials }
        : { tag: 'i', className: 'fa fa-clipboard-list' };
    const avatar: DomConfig = {
      className: `changelog-avatar${actor.icon || !actor.initials ? ' is-icon' : ''}${actor.label ? '' : ' is-system'}`,
      style: actor.label ? { background: actor.color } : {},
      title: actor.title,
      children: [face, badge],
    };
    const parts = transaction.parts ?? [String(transaction.description ?? '')];
    const line: DomConfig[] = [
      ...(actor.label ? [span('changelog-actor', actor.label), span('changelog-text', ' ')] : []),
      ...highlighted(actor.label ? parts : capitalized(parts)),
    ];
    const meta: DomConfig[] = [
      { tag: 'time', className: 'changelog-time', text: relativeTime(occurredAt, this.now?.() ?? new Date()), title: fullTime(occurredAt) },
      span('changelog-kind', KIND_LABELS[transaction.kind] ?? ''),
      ...(actor.onBehalfOf ? [span('changelog-behalf', `for ${actor.onBehalfOf}`)] : []),
      ...(transaction.revisionNo ? [span('changelog-ref', `change #${transaction.revisionNo}`)] : []),
    ];
    // A root config would be merged onto Bryntum's own cell element; the entry is its child instead.
    return {
      children: [
        {
          className: `changelog-entry changelog-kind-${transaction.kind} changelog-tone-${transaction.tone}`,
          dataset: { entryId: String(transaction.id) },
          children: [
            avatar,
            {
              className: 'changelog-body',
              children: [
                { className: 'changelog-line', children: line },
                ...(transaction.note ? [{ className: 'changelog-note', text: transaction.note }] : []),
                { className: 'changelog-meta', children: meta },
              ],
            },
          ],
        },
      ],
    };
  }

  /** Bryntum's property-update row; a fact (no before value) shows the value alone. */
  renderPropertyUpdate(propertyUpdate: PropertyUpdateLike, entity?: EntityLike): DomConfig {
    if (propertyUpdate.before === undefined) {
      return {
        children: [
          {
            tag: 'div',
            className: 'b-version-grid-property-update-desc changelog-fact',
            children: [span('b-version-grid-property-name', fieldLabel(propertyUpdate.property)), span('b-version-grid-property-after', String(propertyUpdate.after))],
          },
        ],
      };
    }
    // VersionGrid's own rendering; the typings leave the method out.
    const base = (VersionGrid.prototype as unknown as { renderPropertyUpdate(update: PropertyUpdateLike, entity?: EntityLike): DomConfig }).renderPropertyUpdate;
    return base.call(this, propertyUpdate, entity);
  }

  /** Bryntum's default turns `camelCase` into "Camel case"; the changelog uses the Gantt's own names. */
  formatPropertyName(property: string): string {
    return StringHelper.encodeHtml(fieldLabel(property));
  }

  /** Values arrive formatted; Bryntum inserts them as HTML, so they are encoded here. */
  formatValueString(value: unknown): string {
    return StringHelper.encodeHtml(typeof value === 'string' ? value : JSON.stringify(value) ?? '');
  }

  /**
   * VersionGrid nests transaction → action → property rows. Rows without details become leaves (no
   * expander), and an entry with a single action skips that level, so its details open in one step.
   */
  getGridRows(version: unknown, transactions: unknown[]): unknown {
    const base = (VersionGrid.prototype as unknown as { getGridRows(version: unknown, transactions: unknown[]): RowData | RowData[] }).getGridRows;
    const rows = base.call(this, version, transactions);
    for (const row of Array.isArray(rows) ? rows : [rows]) tidyRow(row);
    return rows;
  }

  /**
   * VersionGrid replaces the rows of changed transactions on the next frame, but a removed transaction
   * would be rendered again from the change event's records. Removals (an approved fix now listed as
   * the revision that carried it out, entries past the limit) take their rows away directly instead.
   */
  onTransactionStoreChange(event: { action: string; records?: Model[] }): void {
    const internals = this as unknown as {
      _rowsByUnderlyingRecord: WeakMap<Model, Model[]>;
      _transactionChanges: { action: string; records: Model[] }[];
    };
    const base = (VersionGrid.prototype as unknown as { onTransactionStoreChange(event: object): void }).onTransactionStoreChange;
    if (event.action === 'removeall' || event.action === 'clear') {
      internals._transactionChanges = [];
      (this.store as unknown as { removeAll(): void }).removeAll();
      return;
    }
    if (event.action !== 'remove') {
      base.call(this, event);
      return;
    }
    const removed = new Set(event.records ?? []);
    const rows = [...removed].flatMap((record) => internals._rowsByUnderlyingRecord.get(record) ?? []);
    for (const record of removed) internals._rowsByUnderlyingRecord.delete(record);
    internals._transactionChanges = internals._transactionChanges.map((change) => ({ ...change, records: change.records.filter((record) => !removed.has(record)) }));
    if (rows.length > 0) (this.store as unknown as { remove(rows: Model[]): void }).remove(rows);
  }

  /** Shows only the entries of one kind (the whole subtree of each transaction row goes together). */
  showKind(filter: ChangelogFilter): void {
    const store = this.store as unknown as {
      filter(config: object): unknown;
      removeFilter(id: string): unknown;
      reapplyFilterOnAdd: boolean;
    };
    store.reapplyFilterOnAdd = true;
    if (filter === 'all') {
      store.removeFilter('changelog-kind');
      return;
    }
    store.filter({
      id: 'changelog-kind',
      filterBy: (row: GridRow) => {
        let node: GridRow | undefined = row;
        while (node && !node.transactionModel) node = node.parent;
        const transaction = node?.transactionModel;
        return filter === 'costs' ? transaction?.money === true : transaction?.kind === filter;
      },
    });
  }
}

/** Row data as VersionGrid builds it, before it becomes a tree record. */
interface RowData {
  transactionModel?: CollabChangeLogTransaction;
  children?: RowData[];
}

function tidyRow(row: RowData): void {
  const single = row.transactionModel && row.children?.length === 1 ? row.children[0] : undefined;
  if (single) row.children = single.children ?? [];
  for (const child of row.children ?? []) tidyRow(child);
  if (row.children?.length === 0) delete row.children;
}

function capitalized(parts: readonly TextPart[]): TextPart[] {
  const [first, ...rest] = parts;
  if (typeof first !== 'string') return [...parts];
  return [first.charAt(0).toUpperCase() + first.slice(1), ...rest];
}

export interface ChangelogGridOptions {
  appendTo: HTMLElement;
  /** A project with the 'changelogs' and 'versions' crud stores registered. */
  project: ProjectModel;
  people: People;
  onOpenTask?: (taskId: number) => void;
}

export function createChangelogGrid({ appendTo, project, people, onOpenTask }: ChangelogGridOptions): ChangelogGrid {
  const grid = new ChangelogGrid({
    appendTo,
    project,
    showVersions: false,
    showUnattachedTransactions: true,
    hideHeaders: true,
    flex: 1,
    // Detail rows stay compact; entry rows grow to their text (autoHeight).
    rowHeight: 30,
    emptyText: 'Nothing has happened yet',
    columns: [
      {
        type: 'tree',
        field: 'description',
        flex: 1,
        autoHeight: true,
        sortable: false,
        groupable: false,
        leafIconCls: null,
        expandedFolderIconCls: null,
        collapsedFolderIconCls: null,
        renderer: ({ grid, record }: { grid: ChangelogGrid; record: GridRow }) => grid.renderDescription({ record }),
      },
    ],
    // Merged over VersionGrid's own feature set: its version menu and editing go, nothing else is added.
    features: {
      cellMenu: false,
      cellEdit: false,
      group: false,
      rowCopyPaste: false,
      headerMenu: false,
      cellCopyPaste: false,
    },
    listeners: {
      cellClick({ record, event }: { record: GridRow; event: MouseEvent }) {
        const element = event.target instanceof Element ? event.target : null;
        // The expander toggles the row by itself.
        if (!element || element.closest('.b-tree-expander')) return;
        // Only a link: Bryntum reuses spans between renders and leaves a link's task id on a plain word it reuses.
        const target = element.closest('.changelog-link[data-task-id]');
        const taskId = target instanceof HTMLElement ? Number(target.dataset.taskId) : NaN;
        if (Number.isInteger(taskId)) {
          onOpenTask?.(taskId);
          return;
        }
        if (record.transactionModel && !(record as unknown as { isLeaf: boolean }).isLeaf) {
          void grid.toggleCollapse(record);
        }
      },
    },
  } as unknown as ConstructorParameters<typeof VersionGrid>[0]);
  grid.people = people;
  grid.refreshRows();
  return grid;
}
