/**
 * Column definitions for the collaborative Gantt. Every column the grid can show (column-layout.ts
 * lists them) is built once, with a stable id, and shown, hidden, ordered, sized and renamed by the
 * viewer's column layout (`applyColumnLayout`); replacing the column set would rebuild the tree
 * column. The Schedule column holds dates, working days and progress in one cell, the two collapsed
 * money columns hold budget against expected and spent against paid; the single-field columns
 * (Start, Finish, Days, Budget, ...) are there for typing and sorting. Money columns render the
 * integer minor-unit task fields and are only built when the viewer may see costs, so a PM-only
 * session never has them in its column store. The last column is the column selector's "+".
 */
import { DateHelper } from '@bryntum/gantt';
import type { DomConfig, GridColumnConfig, Model, TaskModel } from '@bryntum/gantt';
import { format, money } from '@collab/shared';
import type { CurrencyCode } from '@collab/shared';
import { compact, compactMoney, crewColor, crewIcon, equipmentOf, isGeneratedParent, laborOf, type RentalSpan, lastWorkingDay, phaseClass, rolledUpMoney, statusOf, taskIcon, wholeMoney, original } from './look';
import type { ResourceModel } from '@bryntum/gantt';
import type { CostField } from './project';
import { COLUMN_CATALOG, columnAlign, columnTitle, columnWidth, columnDefinition, defaultColumnLayout, TASK_COLUMN_ID, type ColumnLayout } from './column-layout';

/** Column ids of the single-field money columns (their headers are in column-layout.ts). */
const COST_FIELD_COLUMN_IDS: Readonly<Record<CostField, string>> = {
  budgetMinor: 'budget',
  forecastMinor: 'expected',
  incurredMinor: 'spent',
  paidMinor: 'paid',
};

/** The column selector's own column: a "+" at the right end of the grid's header row. */
export const PICKER_COLUMN_ID = 'column-picker';
export const PICKER_COLUMN_WIDTH = 40;

/** Formats a minor-unit field value; anything that is not a safe integer renders empty rather than wrong. */
export function formatMinorUnits(value: unknown, currency: CurrencyCode): string {
  return typeof value === 'number' && Number.isSafeInteger(value)
    ? format(money(value, currency))
    : '';
}

/** `Thu Nov 12`: the project spans a few months, so the weekday says more than the year. */
export const CELL_DATE_FORMAT = 'ddd MMM D';
/** Typing a date needs a format Bryntum can parse back, with the year: `Nov 12, 2026`. */
export const EDIT_DATE_FORMAT = 'MMM D, YYYY';

const asDate = (value: unknown): Date | null => (value instanceof Date && !Number.isNaN(value.getTime()) ? value : null);

/**
 * Pasted dates: a cell copied from this grid carries the year (`Nov 12, 2026`, or a Schedule cell's
 * `Nov 2, 2026 → Nov 4, 2026 (3d), 0% done`, whose first date is used); anything that does not
 * parse keeps the current value instead of clearing the date, which would unschedule the task.
 */
function dateFromClipboard(field: 'startDate' | 'endDate') {
  return ({ string, record }: { string: string | null; record: Model }): Date | null => {
    const current = asDate((record as TaskModel)[field]);
    const text = string?.split('→')[0]?.trim();
    if (!text) return current;
    return asDate(DateHelper.parse(text, EDIT_DATE_FORMAT)) ?? asDate(DateHelper.parse(text)) ?? current;
  };
}

const dateToClipboard = (field: 'startDate' | 'endDate') => ({ record }: { record: Model }): string => {
  const value = asDate((record as TaskModel)[field]);
  return value ? DateHelper.format(value, EDIT_DATE_FORMAT) : '';
};

/** Pasted money (`$98,400`, `98400.50`) in minor units; anything else keeps the current value. */
function moneyFromClipboard(field: CostField) {
  return ({ string, record }: { string: string | null; record: Model }): number => {
    const current = Number((record as unknown as Record<string, unknown>)[field]) || 0;
    const text = string?.split(/ of |,? spent/)[0]?.replace(/[^0-9.-]/g, '');
    const value = text ? Number(text) : Number.NaN;
    return Number.isFinite(value) && value >= 0 ? Math.round(value * 100) : current;
  };
}

const dateColumn = (field: 'startDate' | 'endDate') =>
  ({
    format: CELL_DATE_FORMAT,
    editor: { format: EDIT_DATE_FORMAT },
    toClipboardString: dateToClipboard(field),
    fromClipboardString: dateFromClipboard(field),
  }) as const;

export interface GanttColumnOptions {
  /** Whether this viewer may see money at all; without it no cost column is built. */
  canViewCosts: boolean;
  currency: CurrencyCode;
  /** Draws a generated group row (Group by crew / status / budget) in the task column. */
  renderGroup: GroupRenderer;
  /** The viewer's column layout when the columns are built (later changes go through `applyColumnLayout`). */
  layout?: ColumnLayout;
  /** When the task's rented equipment is on site (from its booking), read at render time. */
  rentalOf?: (taskId: number) => RentalSpan | null | undefined;
}

/** The parts of Bryntum's cell renderer context these columns read; every row is a task. */
interface CellContext {
  record: Model;
  value: unknown;
  row?: { assignCls(classes: Record<string, boolean>): void } | null;
}

const taskOf = (record: Model): TaskModel => original(record as TaskModel);

type GroupRenderer = (key: string) => DomConfig;

function renderTaskName(renderGroup: GroupRenderer, { record, value, row }: CellContext): DomConfig | string {
  const task = taskOf(record);
  const generated = isGeneratedParent(record);
  row?.assignCls({
    'look-row-phase': !task.isLeaf && !generated && task.parent?.isRoot === true,
    'look-row-package': !task.isLeaf && !generated && task.parent?.isRoot !== true,
    'look-row-group': generated,
    'look-row-done': task.isLeaf && statusOf(task) === 'done',
  });
  const name = typeof value === 'string' ? value : '';
  if (generated) {
    return renderGroup(String((record as TaskModel).name ?? name));
  }
  if (!task.isLeaf) {
    return {
      tag: 'span',
      className: `look-name look-name-phase ${phaseClass(task)}`,
      children: [{ tag: 'span', className: 'look-phase-dot' }, { tag: 'span', text: name }],
    };
  }
  return {
    tag: 'span',
    className: `look-name ${phaseClass(task)}`,
    children: [{ tag: 'i', className: `fa fa-${taskIcon(task)} look-name-icon` }, { tag: 'span', text: name }],
  };
}

/**
 * The rented equipment on a task: its badge and name, and when it is on site (delivered → collected,
 * from its booking) or who rents it out. Facts only: whether the dates fit the work is for the
 * viewer, and the assistant when asked.
 */
function renderEquipment(rentalOf: GanttColumnOptions['rentalOf'], { record }: CellContext): DomConfig | string {
  if (isGeneratedParent(record)) return '';
  const task = taskOf(record);
  const [first, ...more] = equipmentOf(task);
  if (!first) return '';
  const rental = typeof task.id === 'number' ? rentalOf?.(task.id) : null;
  const company = (first as ResourceModel & { company?: string }).company;
  const firstDay = rental ? dateOnly(rental.start) : null;
  const lastDay = rental ? new Date(dateOnly(rental.end).getTime() - 86_400_000) : null;
  const onSite = firstDay && lastDay ? dayRange(firstDay, lastDay) : company ?? '';
  return {
    tag: 'span',
    className: 'look-equipment-cell',
    title:
      rental && firstDay && lastDay
        ? `${first.name ?? ''} on site ${shortDate(firstDay)} → ${shortDate(lastDay)}, ${rental.booked ? `from ${rental.supplier}` : 'no rental booked for this task'}`
        : company
          ? `${first.name ?? ''} from ${company}`
          : (first.name ?? ''),
    children: compact([
      crewBadge(first),
      {
        tag: 'span',
        className: 'look-equipment-text',
        children: compact([
          { tag: 'span', className: 'look-equipment-name', text: more.length > 0 ? `${first.name ?? ''} +${more.length}` : (first.name ?? '') },
          onSite ? { tag: 'span', className: 'look-equipment-when', text: onSite } : null,
        ]),
      },
    ]),
  };
}

/** `Dec 11–17`, or `Nov 30–Dec 3` across a month. */
export function dayRange(from: Date, to: Date): string {
  if (from.getTime() === to.getTime()) return shortDate(from);
  return from.getMonth() === to.getMonth() ? `${shortDate(from)}–${to.getDate()}` : `${shortDate(from)}–${shortDate(to)}`;
}

const dateOnly = (value: string): Date => {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1);
};

/** `Nov 2`: the Schedule cell holds two dates and the length; the weekday is in the tooltip. */
const SCHEDULE_DATE_FORMAT = 'MMM D';
const shortDate = (date: Date) => DateHelper.format(date, SCHEDULE_DATE_FORMAT);

/**
 * A crew as a badge: its company logo (`imageUrl`) when it has one, else its icon in its own color;
 * name and company on hover. The logo lies over the colored icon, so a logo that fails to load
 * (an image with empty alt text draws nothing) still shows the icon.
 */
export function crewBadge(resource: ResourceModel, className = 'look-avatar'): DomConfig {
  const company = (resource as ResourceModel & { company?: string }).company;
  const logo = typeof resource.imageUrl === 'string' && resource.imageUrl ? resource.imageUrl : null;
  return {
    tag: 'span',
    className: logo ? `${className} has-logo` : className,
    title: company ? `${resource.name ?? ''} · ${company}` : (resource.name ?? ''),
    style: logo ? { '--crew': crewColor(resource), position: 'relative', overflow: 'hidden' } : { '--crew': crewColor(resource) },
    children: compact([
      { tag: 'i', className: `fa fa-${crewIcon(resource)}` },
      logo
        ? {
            tag: 'img',
            className: 'look-avatar-logo',
            src: logo,
            alt: '',
            draggable: 'false',
            style: { position: 'absolute', inset: '0', width: '100%', height: '100%', objectFit: 'cover', borderRadius: 'inherit' },
          }
        : null,
    ]),
  };
}

const MAX_BADGES = 3;

/** The crews of a task as overlapping badges (Bryntum's avatars ignore a hex crew color on icon avatars). */
function renderCrew({ record }: CellContext): DomConfig | string {
  if (isGeneratedParent(record)) return '';
  const crew = laborOf(taskOf(record));
  if (crew.length === 0) return '';
  return {
    tag: 'span',
    className: 'look-avatars',
    children: compact([
      ...crew.slice(0, MAX_BADGES).map((resource) => crewBadge(resource)),
      crew.length > MAX_BADGES ? { tag: 'span', className: 'look-avatar look-avatar-more', text: `+${crew.length - MAX_BADGES}` } : null,
    ]),
  };
}

/** `3d`, `½d`, `12d`: working days in the task's own calendar. */
export function formatDays(task: TaskModel): string {
  const days = typeof task.duration === 'number' ? task.duration : 0;
  const unit = task.durationUnit ?? 'day';
  if (unit !== 'day' && unit !== 'd') return `${Math.round(days * 10) / 10}${unit.charAt(0)}`;
  return `${Math.round(days * 10) / 10}d`;
}

function progressBar(done: number): DomConfig {
  return {
    tag: 'span',
    className: `look-when-progress${done >= 100 ? ' is-done' : done === 0 ? ' is-zero' : ''}`,
    children: [
      { tag: 'span', className: 'look-progress-track', children: [{ tag: 'span', className: 'look-progress-fill', style: { width: `${done}%` } }] },
      done >= 100
        ? { tag: 'span', className: 'look-progress-value', children: [{ tag: 'i', className: 'fa fa-circle-check' }, { tag: 'span', text: 'Done' }] }
        : { tag: 'span', className: 'look-progress-value', text: `${done}%` },
    ],
  };
}

/** `Mon Nov 2 → Wed Nov 4 · 3d` over a progress bar; a milestone shows its one date. */
function renderSchedule({ record }: CellContext): DomConfig | string {
  if (isGeneratedParent(record)) return '';
  const task = taskOf(record);
  const start = asDate(task.startDate);
  const end = asDate(task.endDate);
  if (!start || !end) {
    return { tag: 'span', className: 'look-when look-when-empty', text: 'Not scheduled' };
  }
  const done = Math.round(task.percentDone ?? 0);
  const split = Array.isArray((task as TaskModel & { segments?: unknown[] }).segments) && ((task as TaskModel & { segments?: unknown[] }).segments?.length ?? 0) > 1;
  if (task.isMilestone) {
    return {
      tag: 'span',
      className: 'look-when is-milestone',
      children: [
        {
          tag: 'span',
          className: 'look-when-dates',
          children: [{ tag: 'i', className: 'fa fa-diamond look-when-diamond' }, { tag: 'span', className: 'look-when-start', text: shortDate(start) }, { tag: 'span', className: 'look-when-days', text: 'Milestone' }],
        },
        progressBar(done),
      ],
    };
  }
  return {
    tag: 'span',
    className: `look-when${task.isLeaf ? '' : ' is-rollup'}`,
    children: [
      {
        tag: 'span',
        className: 'look-when-dates',
        children: compact([
          { tag: 'span', className: 'look-when-start', text: shortDate(start) },
          { tag: 'i', className: 'fa fa-arrow-right-long look-when-arrow' },
          { tag: 'span', className: 'look-when-end', text: shortDate(lastWorkingDay(task)) },
          {
            tag: 'span',
            className: 'look-when-days',
            title: split ? 'Working days, done in separate parts' : 'Working days',
            children: compact([split ? { tag: 'i', className: 'fa fa-scissors' } : null, { tag: 'span', text: formatDays(task) }]),
          },
        ]),
      },
      progressBar(done),
    ],
  };
}

/** Copying a Schedule cell gives a readable sentence; pasting one moves the task to its start. */
function scheduleToClipboard({ record }: { record: Model }): string {
  const task = taskOf(record);
  const start = asDate(task.startDate);
  if (!start || !asDate(task.endDate)) return '';
  const range = task.isMilestone
    ? DateHelper.format(start, EDIT_DATE_FORMAT)
    : `${DateHelper.format(start, EDIT_DATE_FORMAT)} → ${DateHelper.format(lastWorkingDay(task), EDIT_DATE_FORMAT)} (${formatDays(task)})`;
  return `${range}, ${Math.round(task.percentDone ?? 0)}% done`;
}

/** Sorts by start date, then finish. */
function compareSchedule(a: Model, b: Model): number {
  const time = (record: Model, field: 'startDate' | 'endDate') => asDate(taskOf(record)[field])?.getTime() ?? 0;
  return time(a, 'startDate') - time(b, 'startDate') || time(a, 'endDate') - time(b, 'endDate');
}

/** Money cells on phase and group rows show the totals of the tasks under them, in bold. */
const rollupCls = (record: Model) => (taskOf(record).isLeaf ? '' : 'is-rollup');

/** The money columns by id (built only for viewers who may see costs). Text, width and order come from the layout. */
function costColumns(currency: CurrencyCode): Record<string, object> {
  const shared = { filterable: false, groupable: false } as const;
  return {
    'cost-plan': {
      ...shared,
      type: 'column',
      field: 'forecastMinor',
      // Not Bryntum's cell editor: double-click / Enter opens the money editor (cell-editors.ts).
      editor: false,
      fromClipboardString: moneyFromClipboard('forecastMinor'),
      toClipboardString: ({ record }: { record: Model }) => {
        const { budget, expected } = rolledUpMoney(record as TaskModel);
        return `${wholeMoney(expected, currency)} of ${wholeMoney(budget, currency)}`;
      },
      renderer: ({ record }: CellContext) => {
        if (isGeneratedParent(record) && rolledUpMoney(record as TaskModel).budget === 0) return '';
        const { budget, expected } = rolledUpMoney(record as TaskModel);
        const over = expected - budget;
        return {
          tag: 'span',
          className: `look-cost ${rollupCls(record)}`,
          children: [
            {
              tag: 'span',
              className: 'look-cost-main',
              children: compact([
                over > 0 ? { tag: 'span', className: 'look-pill look-tone-alert', text: `+${compactMoney(over, currency)}` } : null,
                over < 0 ? { tag: 'span', className: 'look-pill look-tone-ok', text: `−${compactMoney(-over, currency)}` } : null,
                { tag: 'span', className: 'look-cost-value', text: wholeMoney(expected, currency) },
              ]),
            },
            { tag: 'span', className: 'look-cost-sub', text: `of ${wholeMoney(budget, currency)} budget` },
          ],
        };
      },
    },
    'cost-actual': {
      ...shared,
      type: 'column',
      field: 'incurredMinor',
      // Spent and paid come from the work done and from PayPal, never from typing.
      editor: false,
      readOnly: true,
      toClipboardString: ({ record }: { record: Model }) => {
        const { spent, paid } = rolledUpMoney(record as TaskModel);
        return `${wholeMoney(spent, currency)} spent, ${wholeMoney(paid, currency)} paid`;
      },
      renderer: ({ record }: CellContext) => {
        const { expected, spent, paid } = rolledUpMoney(record as TaskModel);
        if (expected === 0 && spent === 0) return '';
        const scale = Math.max(expected, spent, 1);
        const settled = spent > 0 && paid >= spent;
        return {
          tag: 'span',
          className: `look-cost ${rollupCls(record)}${settled ? ' is-settled' : ''}`,
          children: [
            {
              tag: 'span',
              className: 'look-cost-main',
              children: compact([
                settled ? { tag: 'i', className: 'fa fa-circle-check' } : null,
                { tag: 'span', className: 'look-cost-value', text: wholeMoney(spent, currency) },
                { tag: 'span', className: 'look-cost-sub', text: `· ${compactMoney(paid, currency)} paid` },
              ]),
            },
            {
              tag: 'span',
              className: 'look-cost-bar',
              title: `${Math.round((spent / scale) * 100)}% of the expected cost spent`,
              children: [
                { tag: 'span', className: 'look-cost-spent', style: { width: `${Math.min(100, (spent / scale) * 100)}%` } },
                { tag: 'span', className: 'look-cost-paid', style: { width: `${Math.min(100, (paid / scale) * 100)}%` } },
              ],
            },
          ],
        };
      },
    },
    ...Object.fromEntries(
      (['budgetMinor', 'forecastMinor', 'incurredMinor', 'paidMinor'] as const).map((field) => [
        COST_FIELD_COLUMN_IDS[field],
        {
          ...shared,
          type: 'number',
          field,
          renderer: ({ record }: CellContext) => formatMinorUnits((taskOf(record) as unknown as Record<string, unknown>)[field], currency),
          // Budget and expected are edited in the money editor and the task panel; spent and paid are never typed.
          editor: false,
          readOnly: true,
        },
      ]),
    ),
    'cost-code': { ...shared, type: 'column', field: 'costCode', editor: false, readOnly: true, renderer: ({ value }: CellContext) => (typeof value === 'string' ? value : '') },
  };
}

/** Dates the engine works out from the links: shown, never typed. */
const calculatedDate = (type: string) => ({ type, format: CELL_DATE_FORMAT, editor: false, readOnly: true, filterable: false, groupable: false });

/** Bryntum column configs by column id; every id is one of COLUMN_CATALOG's. */
function columnConfigs({ canViewCosts, currency, renderGroup, rentalOf }: GanttColumnOptions): Record<string, object> {
  return {
    // The task column takes whatever width the grid leaves it; its layout width sets the grid's width.
    [TASK_COLUMN_ID]: { type: 'name', flex: 1, minWidth: 200, draggable: false, hideable: false, renderer: (context: CellContext) => renderTaskName(renderGroup, context) },
    // Bryntum's crew picker edits the cell; the renderer draws the crews in their own colors.
    'schedule-crew': { type: 'resourceassignment', renderer: renderCrew },
    // Assigned like crews (the crew picker); drawn with when the equipment is on site. Its field names
    // no task field: the cell is drawn from the assignments and the bookings, and it must not pass for
    // the task's name (`data-column="name"`) in the page. Double-click, Enter or F2 open the rental
    // editor (cell-editors.ts, wired in GanttWorkspace); Delete takes the machine off the task.
    equipment: { type: 'column', field: 'equipment', editor: false, readOnly: true, filterable: false, groupable: false, sortable: false, renderer: (context: CellContext) => renderEquipment(rentalOf, context), toClipboardString: () => '' },
    'schedule-when': {
      type: 'column',
      // The cell stands for start, finish, working days and progress. Its field is the start date, so
      // pasting and the fill handle move tasks. Bryntum's single-input cell editor is off; double-click,
      // Enter or F2 open the schedule editor instead (cell-editors.ts, wired in GanttWorkspace).
      field: 'startDate',
      editor: false,
      fromClipboardString: dateFromClipboard('startDate'),
      filterable: false,
      groupable: false,
      sortable: compareSchedule,
      renderer: renderSchedule,
      toClipboardString: scheduleToClipboard,
    },
    start: { type: 'startdate', ...dateColumn('startDate') },
    finish: { type: 'enddate', ...dateColumn('endDate') },
    duration: { type: 'duration' },
    progress: { type: 'percentdone' },
    effort: { type: 'effort' },
    'constraint-type': { type: 'constrainttype' },
    'constraint-date': { type: 'constraintdate', format: CELL_DATE_FORMAT, editor: { format: EDIT_DATE_FORMAT } },
    deadline: { type: 'deadlinedate', format: CELL_DATE_FORMAT, editor: { format: EDIT_DATE_FORMAT } },
    manual: { type: 'manuallyscheduled' },
    calendar: { type: 'calendar' },
    'scheduling-mode': { type: 'schedulingmodecolumn' },
    'total-slack': { type: 'totalslack', editor: false, readOnly: true, filterable: false, groupable: false },
    'early-start': calculatedDate('earlystartdate'),
    'early-finish': calculatedDate('earlyenddate'),
    'late-start': calculatedDate('latestartdate'),
    'late-finish': calculatedDate('lateenddate'),
    predecessors: { type: 'predecessor' },
    successors: { type: 'successor' },
    ...(canViewCosts ? costColumns(currency) : {}),
    wbs: { type: 'wbs' },
    notes: { type: 'note' },
    milestone: { type: 'milestone' },
    inactive: { type: 'inactive' },
  };
}

/** The "+" in the header row that opens the column selector; its cells stay empty. */
const PICKER_BUTTON_HTML =
  '<button type="button" class="look-column-add" data-testid="column-picker-button" aria-label="Columns" aria-haspopup="dialog" title="Show, hide and order columns"><i class="fa fa-plus" aria-hidden="true"></i></button>';

function pickerColumn(): object {
  return {
    type: 'column',
    id: PICKER_COLUMN_ID,
    field: null,
    text: '',
    ariaLabel: 'Columns',
    width: PICKER_COLUMN_WIDTH,
    minWidth: PICKER_COLUMN_WIDTH,
    cls: 'look-column-add-header',
    cellCls: 'look-column-add-cell',
    resizable: false,
    draggable: false,
    sortable: false,
    groupable: false,
    filterable: false,
    hideable: false,
    exportable: false,
    editor: false,
    readOnly: true,
    enableHeaderContextMenu: false,
    headerRenderer: () => PICKER_BUTTON_HTML,
    renderer: () => '',
    toClipboardString: () => '',
  };
}

/**
 * Every column this viewer can show, built once with the layout's visibility, width, header text,
 * alignment and order, followed by the selector's "+" column.
 */
export function buildGanttColumns(options: GanttColumnOptions): GridColumnConfig[] {
  const layout = options.layout ?? defaultColumnLayout();
  const configs = columnConfigs(options);
  const available = COLUMN_CATALOG.filter((definition) => definition.id in configs);
  const shown = layout.visible.filter((id) => id in configs);
  const order = [...shown, ...available.map((definition) => definition.id).filter((id) => !shown.includes(id))];
  // Clipboard hooks are Column members the config typings leave out.
  return ([
    ...order.map((id) => ({
      ...configs[id],
      id,
      text: columnTitle(layout, id),
      align: columnAlign(layout, id),
      hidden: !shown.includes(id),
      ...(id === TASK_COLUMN_ID ? {} : { width: columnWidth(layout, id), minWidth: columnDefinition(id)?.minWidth ?? 48 }),
    })),
    pickerColumn(),
  ] as object[]) as GridColumnConfig[];
}

/** The parts of a live Bryntum column `applyColumnLayout` reads and sets. */
export interface LiveColumn {
  id: string | number;
  hidden?: boolean;
  width?: number | string | null;
  flex?: number | string | null;
  text?: string;
  align?: string | null;
}

/** The parts of Bryntum's ColumnStore (a tree store) `applyColumnLayout` uses. */
export interface LiveColumnStore {
  getById(id: string): LiveColumn | null | undefined;
  rootNode: { children?: LiveColumn[] | boolean | null; insertChild(child: LiveColumn, before?: LiveColumn | null): unknown };
}

const childrenOf = (store: LiveColumnStore): LiveColumn[] => (Array.isArray(store.rootNode.children) ? store.rootNode.children : []);

/** What `applyColumnLayout` touched. */
export interface AppliedColumnLayout {
  /** Any column was shown, hidden, resized, renamed, realigned or moved. */
  changed: boolean;
  /** An alignment changed: the rows need a redraw. */
  realigned: boolean;
}

/**
 * Brings the live columns in line with the layout: visibility, widths (the task column flexes),
 * header texts, alignment and the order of the shown columns, with the "+" column last. Only what
 * differs is touched, so applying the same layout twice changes nothing.
 */
export function applyColumnLayout(store: LiveColumnStore, layout: ColumnLayout): AppliedColumnLayout {
  let changed = false;
  let realigned = false;
  for (const definition of COLUMN_CATALOG) {
    const column = store.getById(definition.id);
    if (!column) continue;
    const { id } = definition;
    const hidden = !layout.visible.includes(id);
    if (Boolean(column.hidden) !== hidden) {
      column.hidden = hidden;
      changed = true;
    }
    if (definition.fixed) {
      // A header resize next to it fixes its width; it goes back to taking what the grid leaves.
      if (!column.flex) {
        column.flex = 1;
        changed = true;
      }
    } else if (column.width !== columnWidth(layout, id)) {
      column.width = columnWidth(layout, id);
      changed = true;
    }
    const title = columnTitle(layout, id);
    if (column.text !== title) {
      column.text = title;
      changed = true;
    }
    const align = columnAlign(layout, id);
    if ((column.align || 'start') !== align) {
      column.align = align;
      changed = true;
      realigned = true;
    }
  }

  const wanted = [...layout.visible, PICKER_COLUMN_ID].map((id) => store.getById(id)).filter((column): column is LiveColumn => Boolean(column));
  const wantedSet = new Set(wanted);
  for (let index = 0; index < wanted.length; index += 1) {
    const current = childrenOf(store).filter((column) => wantedSet.has(column));
    const at = current[index];
    if (at && at !== wanted[index]) {
      store.rootNode.insertChild(wanted[index]!, at);
      changed = true;
    }
  }
  return { changed, realigned };
}

/** The ids of the shown layout columns, left to right, as the grid has them (after a header drag). */
export function visibleColumnOrder(store: LiveColumnStore): string[] {
  return childrenOf(store)
    .filter((column) => !column.hidden && columnDefinition(String(column.id)) !== undefined)
    .map((column) => String(column.id));
}
