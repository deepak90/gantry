/**
 * The project workspace: a toolbar, a Bryntum Gantt bound to a shared ProjectModel and, in a
 * collapsible pane below it, two linked views of the crews on the same project: a ResourceHistogram
 * (workload) and a Scheduler Pro (the crew schedule, see CrewSchedule.ts). The component is a pure view over the project
 * it is given; data loading and revision sync live outside it. Everything it adds (phase colors,
 * the idle-equipment band, workflow badges, search, filters, grouping, the viewer's columns) is
 * presentation only: filters and groups act on the Gantt's display store and never change a record,
 * and the column layout is kept per viewer in the browser (column-layout.ts).
 */
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react';
import { BryntumGantt } from '@bryntum/gantt-react';
import type { BryntumGanttProps } from '@bryntum/gantt-react';
import { DateHelper, ResourceHistogram, StringHelper, TaskModel, Toast } from '@bryntum/gantt';
import type { Gantt, Model, ProjectModel, ResourceModel, Store, TimeSpan } from '@bryntum/gantt';
import type { LatePaymentEffect, CurrencyCode, OddsSummary } from '@collab/shared';
import type { RentalEdit } from '../workflow/rental';
import { closeCellEditor, openMoneyEditor, openRentalEditor, openScheduleEditor } from './cell-editors';
import { clearCells, describeCellOp, fillCells, isCollapsedColumn, type CellOpReport, type CellRef } from './cell-ops';
import { PICKER_COLUMN_ID, PICKER_COLUMN_WIDTH, applyColumnLayout, buildGanttColumns, crewBadge, visibleColumnOrder, type LiveColumnStore } from './columns';
import {
  TASK_COLUMN_ID,
  browserStorage,
  columnDefinition,
  columnLayoutStorageKey,
  fitTaskColumnToGrid,
  hasVisibleMoneyColumn,
  hideColumn,
  loadColumnLayout,
  lockedGridWidth,
  normalizeColumnLayout,
  orderVisibleColumns,
  saveColumnLayout,
  setColumnWidth,
  showColumn as showLayoutColumn,
  type ColumnLayout,
} from './column-layout';
import { ColumnEditor, ColumnPicker, type LayoutChange } from './ColumnPanels';
import { queueMenuItems } from './menu-actions';
import { prepareCopiedTasks } from './project';
import { latePaymentEffect } from './late-payment-effect';
import { hasHeldTasks, holdTasks, pasteHeldTasks } from './task-clipboard';
import { GanttToolbar } from './GanttToolbar';
import { createCrewSchedule, revealTaskInGantt } from './CrewSchedule';
import {
  NO_DECORATIONS,
  baselineOnPlan,
  compareGroups,
  crewOf,
  groupKey,
  groupStats,
  rentalIndicator,
  isGeneratedParent,
  needsAttention,
  original,
  renderAfterLabel,
  renderDependencyTooltip,
  renderGroupRow,
  renderTaskBar,
  renderTaskTooltip,
  statusOf,
  type ColorBy,
  type Decorations,
  type GroupBy,
  type GroupStats,
  type LookState,
  type QuickFilter,
  type TaskRenderData,
} from './look';
import type { LookBridge, ToolbarLook } from '../presence/gantt-adapter';
import { attachBands, renderBandTooltip } from '../library/bands';
import { whenFiltersBack } from './filters';
import { firstLockedWithin, lockMessage, lockMessageHtml, setPaymentLocks } from './payment-lock';
import { flashRows } from '../library/drag';
import { wasHereIndicator } from '../library/was-here';
import { payLateIndicator, drawPayLateOn } from './pay-late-preview';
import { drawHoldOn, holdLinkRenderer } from './hold-look';
import { drawOddsOn, oddsChipIndicator, oddsTailIndicator, oddsWhiskerIndicator } from '../odds/chart-odds';
import { OddsController } from '../odds/odds-controller';
import { OddsPanel } from '../odds/OddsPanel';
import { oddsSummary } from '../odds/odds-summary';
import type { PayPolicy } from './monte-carlo';
import { CURRENT_TIME_LINE, dayHeader, nameProjectLines, showPlanToday } from './axis-marks';
import { addPayGate, gateFor } from './pay-gates';
import { showOpeningView } from './opening-view';
import { HOSTED } from '../hosted';
import { whenSaved } from '../scenario/publish';
import { redo, rentalsInNextStep, undo, undoKey, undoState, watchUndo, type UndoState } from './undo';
import { attachBarTheater, type Theater } from './fx3d';
import { keepsTask, type PlanFilter } from './screen';
import type { PanelTab } from './fx3d/side-panel';
import '../styles/gantt.css';
import '../styles/gantt-overlays.css';
import '../styles/crew-schedule.css';
import { ASSISTANT_NAME, REMY_GLYPH } from '../assistant/identity';

/** The two views of the crews in the bottom pane. */
type CrewPaneTab = 'workload' | 'schedule';

/** The open column pop-over: the selector, or the editor of one column. */
type ColumnPanel = { kind: 'picker' } | { kind: 'editor'; columnId: string } | null;

const CREW_PANE_TABS: { id: CrewPaneTab; label: string; icon: string; hint: string }[] = [
  { id: 'workload', label: 'Crew workload', icon: 'chart-simple', hint: 'who is busy when, and who is double-booked' },
  { id: 'schedule', label: 'Crew schedule', icon: 'calendar-week', hint: 'drag a task sideways to move it, or onto another crew to hand it over' },
];

export interface GanttWorkspaceProps {
  project: ProjectModel;
  /** Whether this viewer may see commercial figures at all (membership `can_view_costs`); money columns exist only then. */
  canViewCosts: boolean;
  /** Whose column layout this is (e.g. the signed-in user's id): each viewer keeps their own columns in this browser. */
  layoutKey?: string;
  /** What the workflow knows about tasks (idle equipment, proposal and payment state). */
  decorations?: Decorations;
  /** The last applied project revision: data under the same records changed. */
  revision?: number;
  /** A quieter toolbar. */
  quiet?: boolean;
  /** Columns left out until the viewer chooses otherwise (no layout stored in this browser yet). */
  hideColumns?: readonly string[];
  onSelectionChange?: (taskIds: number[]) => void;
  /** Double-click on a task, or "Edit task…": the side panel's task tab edits it (no pop-up editor). */
  onEditTask?: (taskId: number) => void;
  /** Opens a task's rentals and payment; only the 3D view asks for it. */
  onOpenRentals?: (taskId: number) => void;
  /** Opens what there is to pay for this task, from the 3D view; the fix panel if this isn't given. */
  onOpenPayment?: (taskId: number) => void;
  /** Brings a tab of the side panel forward, from the 3D view; says false when this person doesn't have it. */
  onShowPanelTab?: (tab: PanelTab) => boolean;
  /** Whether this person has an assistant, for the 3D view. */
  hasAssistant?: boolean;
  /** "Save to library…" on a task or group: the library opens its builder on that piece of the plan. */
  /** "Save to library…": the task right-clicked, or the whole selection when it is part of it. */
  onSaveToLibrary?: (taskIds: number[]) => void;
  /** "Watch…" in the task menu: the task, or the selected tasks it is one of. */
  onWatchTasks?: (taskIds: number[]) => void;
  /** "Ask the assistant about it" in the task menu. */
  onAskAssistant?: (taskId: number) => void;
  /** The rentals the Equipment cells edit. */
  rentals?: RentalEditing;
  /** Currency of the `*Minor` task fields. */
  currency?: CurrencyCode;
  /** Whether the histogram pane starts open. */
  histogramOpen?: boolean;
  /** Imperative access for the rest of the workspace (the contextual editor opens a booking's activity). */
  apiRef?: Ref<GanttWorkspaceApi>;
  /** The odds panel has an answer: a run went to the end ("Try these" on the hosted site). */
  onOddsAnswered?: () => void;
}

export interface RentalEditing {
  /** The rental a task's Equipment cell stands for, read when the cell is opened. */
  rentalFor(taskId: number): RentalEdit | null;
  /** Why a machine's dates on a task cannot change right now, or null: an undo that would change them waits too. */
  lockOf(taskId: number, resourceId: number): string | null;
}

export interface GanttWorkspaceApi {
  /** Selects the task's row and scrolls its bar into view; false when the task is not in the project. */
  selectTask(taskId: number): boolean;
  /** Selects several tasks (opening the groups they are in), brings the first into view and flashes their rows. */
  focusTasks(taskIds: readonly number[]): number;
  /** Brings the 3D view to these tasks if it is open, and leaves the chart as it is: for what a card is about, not a request to look. */
  followTasks(taskIds: readonly number[]): void;
  /** Fills the toolbar search (e.g. "show this crew's tasks"). */
  setSearch(text: string): void;
  /** The Bryntum Gantt, for side panels that drag onto it (crews, the task library). */
  instance(): Gantt | undefined;
  /** How the toolbar draws the plan, read and set by follow mode. */
  look: LookBridge;
  /**
   * Opens the odds panel and runs the plan a thousand times there, the board pouring on screen (for Remy, through
   * the assistant's command channel), paid by `pay` when given. Resolves with what the runs gave.
   */
  runOdds(pay?: PayPolicy): Promise<OddsSummary>;
  /** What waiting for the Friday pay run would do, drawn on the chart. */
  latePaymentEffect(): Promise<LatePaymentEffect | null>;
  /** What Remy's screen actions reach on the chart (assistant/remy-ui.ts), read fresh each time. */
  screen(): GanttScreen;
}

/** The chart's view, for Remy's cursor: the 3D view's buttons, the toolbar's filters and zoom, open groups, undo. */
export interface GanttScreen {
  instance(): Gantt | undefined;
  /** The 3D site view, as its buttons work it; null before it has loaded (or where there is no 3D). */
  site(): Theater | null;
  /** Sets the toolbar's search (it keeps tasks with these words, or crews), the Show filter and Remy's filter, then waits for the chart to be filtered. */
  setView(change: { search?: string; quickFilter?: QuickFilter; filter?: PlanFilter | null }): Promise<void>;
  /** What the filters show now: leaf tasks kept, of all of them; whether anything is filtered. */
  counts(): { visible: number; total: number; filtered: boolean };
  zoom(how: 'in' | 'out' | 'fit'): Promise<void>;
  /** The timeline over these days, both included. */
  zoomToDates(first: Date, last: Date): void;
  /** Every group, or one, opened or closed. */
  expand(open: boolean, record?: TaskModel): Promise<void>;
  /** Undo or redo this person's last change, as the toolbar's buttons do; says what it was, or why not. */
  history(direction: 'undo' | 'redo'): Promise<{ done: true; label: string } | { done: false; why: string }>;
  /** The editor of one cell: its own pop-up for the columns that hold several fields, Bryntum's cell editor otherwise. False when the cell can't be edited. */
  editCell(record: TaskModel, columnId: string): Promise<boolean>;
  /** Selects the task's row and lights it up for a moment. */
  select(record: TaskModel): void;
  /** Adds a column to this person's chart, as the column picker does (kept in this browser); false when it can't be shown here. */
  addColumn(columnId: string): boolean;
  /** What the chart shows now: the search, the Show filter, Remy's filter, the dates in view and the zoom. */
  view(): { search: string; quickFilter: QuickFilter; filter: string | null; from: Date | null; to: Date | null; zoom: string | null; odds: boolean };
  /** Opens or closes the odds panel beside the chart, as its button does. */
  setOdds(open: boolean): void;
  /** Scrolls the timeline to a day, the zoom kept. */
  scrollToDate(date: Date): Promise<void>;
}

/** Persisted task ids only: phantom records carry string ids until the server assigns real ones. Grouped rows are linked copies. */
export function selectedTaskIds(selection: readonly Model[]): number[] {
  return selection
    .filter((record): record is TaskModel => record instanceof TaskModel)
    .map((task) => original(task).id)
    .filter((id): id is number => typeof id === 'number');
}

function matchesSearch(task: TaskModel, query: string): boolean {
  const record = original(task);
  if ((record.name ?? '').toLowerCase().includes(query)) return true;
  return crewOf(record).some((resource) => (resource.name ?? '').toLowerCase().includes(query));
}

/** The task clicked, or the whole selection when it is part of it. */
const tasksFor = (gantt: Gantt, task: TaskModel) => {
  const selected = ((gantt.selectedRecords ?? []) as TaskModel[]).map(original);
  const record = original(task);
  return selected.length > 1 && selected.includes(record) ? selected : [record];
};

const pasteTasks = (gantt: Gantt, task: TaskModel) =>
  pasteHeldTasks(gantt.project as ProjectModel, original(task)).catch((error: unknown) => {
    // Bryntum shows a toast's text as HTML, and the reason can name a task.
    Toast.show({ html: StringHelper.encodeHtml(error instanceof Error ? error.message : String(error)) });
  });

function leafTasks(project: ProjectModel): TaskModel[] {
  return (project.taskStore.leaves as TaskModel[]).filter((task) => !task.isRoot);
}

const weekOf = (start: Date) => `Week of ${DateHelper.format(start, 'MMM D, YYYY')}`;
const quarterOf = (start: Date) => `Q${Math.floor(start.getMonth() / 3) + 1} ${start.getFullYear()}`;

/**
 * The zoom levels, widest first (Bryntum's order). Bryntum's own presets mix formats ("2027 February", bare day
 * numbers); these keep one vocabulary from days to quarters.
 */
const ZOOM_PRESETS = [
  { id: 'collab-quarters', useForSmoothZoom: true, base: 'year', tickWidth: 110, headers: [{ unit: 'year', dateFormat: 'YYYY' }, { unit: 'quarter', renderer: (start: Date) => `Q${Math.floor(start.getMonth() / 3) + 1}` }] },
  { id: 'collab-months', useForSmoothZoom: true, base: 'monthAndYear', tickWidth: 84, headers: [{ unit: 'quarter', renderer: quarterOf }, { unit: 'month', dateFormat: 'MMM' }] },
  { id: 'collab-weeks', useForSmoothZoom: true, base: 'weekAndMonth', tickWidth: 64, headers: [{ unit: 'month', dateFormat: 'MMMM YYYY' }, { unit: 'week', renderer: (start: Date) => DateHelper.format(start, 'MMM D') }] },
  { id: 'collab-days', useForSmoothZoom: true, base: 'weekAndDayLetter', tickWidth: 34, headers: [{ unit: 'week', renderer: weekOf }, { unit: 'day', renderer: dayHeader('d1') }] },
  { id: 'collab-day-names', useForSmoothZoom: true, base: 'dayAndWeek', tickWidth: 64, headers: [{ unit: 'week', renderer: weekOf }, { unit: 'day', renderer: dayHeader('ddd D') }] },
];

const DEADLINE_DAY = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

/**
 * A task's deadline (a contract date on the handover), as Bryntum's own indicator draws it: a flag at the end of the
 * day it falls on. Quiet ink while the work finishes in time; red once it would finish after it, by the task
 * panel's rule (it ends after the deadline's day).
 */
function deadlineIndicator(taskRecord: TaskModel): { startDate: Date; cls: string; name: string; fillAlign: 'end' } | null {
  const task = original(taskRecord) as TaskModel & { deadlineDate?: Date | null };
  const deadline = task.deadlineDate;
  if (!(deadline instanceof Date)) return null;
  const dayAfter = new Date(deadline.getFullYear(), deadline.getMonth(), deadline.getDate() + 1);
  const missed = task.endDate instanceof Date && task.endDate > dayAfter;
  return {
    startDate: deadline,
    cls: `b-bottom b-deadline-date${missed ? ' is-missed' : ''}`,
    name: `${missed ? 'Finishes after its deadline' : 'Deadline'}: ${DEADLINE_DAY.format(deadline)}`,
    fillAlign: 'end',
  };
}

/** Opens the groups a task is in, selects it, scrolls its bar into view and flashes its row. */
function revealTask(gantt: Gantt, taskId: number | string): void {
  const task = gantt.project.taskStore.getById(taskId) as TaskModel | undefined;
  if (!task) return;
  const store = gantt.store as Store;
  void (async () => {
    await gantt.expandTo(task as never, false);
    const shown = (store.getById(taskId) as TaskModel | undefined) ?? (store.find((record: Model) => original(record as TaskModel) === task, true) as TaskModel | undefined);
    if (!shown || gantt.isDestroyed) return;
    gantt.selectRow({ record: shown, scrollIntoView: true });
    await gantt.scrollTaskIntoView(shown, { highlight: true, block: 'center', animate: true } as never);
    flashRows(gantt, [shown]);
  })().catch((error: unknown) => console.error('Could not show the task', error));
}

/** Columns whose one cell stands for several fields, with their own popup editors. */
const COLLAPSED_COLUMNS = new Set(['schedule-when', 'cost-plan', 'equipment']);

/** The task's bar when it lies in the visible part of the timeline. */
function barInView(gantt: Gantt, record: TaskModel): HTMLElement | null {
  const bar = gantt.getElementFromTaskRecord(record) as HTMLElement | null;
  const timeline = gantt.getSubGrid('normal')?.element as HTMLElement | undefined;
  if (!bar || !timeline) return null;
  const box = bar.getBoundingClientRect();
  const view = timeline.getBoundingClientRect();
  return box.right > view.left && box.left < view.right && box.bottom > view.top && box.top < view.bottom ? bar : null;
}

/**
 * Opens the popup editor of a collapsed cell. Bryntum's own cell editor is never started for these
 * columns: vetoing it from `beforeCellEditStart` would leave its feature transaction open and pause
 * the project queue, which also holds back every incoming revision.
 */
function openCollapsedCellEditor(gantt: Gantt, record: TaskModel, columnId: string | undefined, look?: LookState, openInPanel?: (task: TaskModel) => void, rentals?: RentalEditing): boolean {
  if (!columnId || !COLLAPSED_COLUMNS.has(columnId) || isGeneratedParent(record) || gantt.readOnly) return false;
  // An empty Equipment cell has no rental to edit, so no popup.
  const taskId = original(record).id;
  const rental = columnId === 'equipment' && typeof taskId === 'number' ? (rentals?.rentalFor(taskId) ?? null) : null;
  if (columnId === 'equipment' && !rental) return false;
  const column = (gantt.columns as unknown as Store).getById(columnId);
  // From the context menu the column may be hidden; the popup then points at the bar while it is in
  // view, else at the task's name.
  const shown = column && !(column as { hidden?: boolean }).hidden ? column : null;
  const taskColumn = (gantt.columns as unknown as Store).getById(TASK_COLUMN_ID);
  const cellOf = (of: unknown) => (of ? (gantt.getCell({ record, column: of } as never) as HTMLElement | null) : null);
  const element = cellOf(shown) ?? barInView(gantt, record) ?? cellOf(taskColumn);
  if (!element) return false;
  const focusCell = (gantt as Gantt & { focusCell(location: object): void }).focusCell.bind(gantt);
  const target = {
    project: gantt.project as ProjectModel,
    task: record,
    element,
    onClose: () => {
      if (!gantt.isDestroyed) focusCell({ record, column: shown ?? taskColumn });
    },
    onError: (message: string) => console.error('Could not save the change:', message),
    onOpenInPanel: openInPanel ? () => openInPanel(record) : undefined,
  };
  if (rental && rentals) {
    openRentalEditor(target, rental);
    return true;
  }
  if (columnId === 'schedule-when') {
    openScheduleEditor(target, look);
    return true;
  }
  if (look?.canViewCosts && original(record).isLeaf) {
    openMoneyEditor(target, look.currency);
    return true;
  }
  return false;
}

/** A Bryntum GridLocation, as fill and clear read it. */
interface CellLocation {
  column?: { id?: string | number; field?: string; isTimeAxisColumn?: boolean };
  record?: Model;
  rowIndex?: number;
  columnIndex?: number;
}

/** Grid cells as fill and clear take them: the timeline and the "+" column hold no task data. */
function cellRefs(locations: readonly CellLocation[]): CellRef[] {
  return locations
    .filter((location) => location.record && location.column && !location.column.isTimeAxisColumn && String(location.column.id) !== PICKER_COLUMN_ID)
    .map((location) => ({ task: location.record as TaskModel, columnId: String(location.column!.id), field: location.column!.field }));
}

/** Every cell between two corners of a range, in grid order (rows, then columns). */
function cellsInRange(gantt: Gantt, from: CellLocation, to: CellLocation): CellLocation[] {
  const store = gantt.store as Store;
  const visible = ((gantt.columns as unknown as { visibleColumns?: CellLocation['column'][] }).visibleColumns ?? []) as NonNullable<CellLocation['column']>[];
  const rows = [from.rowIndex ?? -1, to.rowIndex ?? -1].sort((a, b) => a - b) as [number, number];
  const cols = [from.columnIndex ?? -1, to.columnIndex ?? -1].sort((a, b) => a - b) as [number, number];
  const cells: CellLocation[] = [];
  if (rows[0] < 0 || cols[0] < 0) return cells;
  for (let rowIndex = rows[0]; rowIndex <= rows[1]; rowIndex++) {
    const record = store.getAt(rowIndex) as Model | undefined;
    if (!record) continue;
    for (let columnIndex = cols[0]; columnIndex <= cols[1]; columnIndex++) {
      const column = visible[columnIndex];
      if (column) cells.push({ record, column, rowIndex, columnIndex });
    }
  }
  return cells;
}

/**
 * A fill handle drag about to land. Bryntum fills plain cells itself, but writes only `column.field`
 * and reads through a cell editor, so a range with a collapsed cell (Schedule, Budget · Forecast) is
 * filled here instead, every field behind each cell, in the fill direction, as one change.
 */
function takeOverFill(gantt: Gantt, from: CellLocation | undefined, to: CellLocation | undefined, report: (kind: 'fill', outcome: Promise<CellOpReport>) => void): boolean {
  const feature = gantt.features.fillHandle as unknown as { rangeSelection?: CellLocation[] } | undefined;
  const source = feature?.rangeSelection ?? [];
  if (!from || !to || source.length === 0) return false;
  const all = cellsInRange(gantt, from, to);
  if (![...source, ...all].some((cell) => isCollapsedColumn(cell.column ? String(cell.column.id) : null))) return false;
  const key = (cell: CellLocation) => `${cell.rowIndex}:${cell.columnIndex}`;
  const inSource = new Set(source.map(key));
  const targets = all.filter((cell) => !inSource.has(key(cell)));
  if (targets.length === 0) return false;
  const first = targets[0]!;
  // As Bryntum decides: sideways when the first new cell shares a row with the source; backwards when it lies above or left.
  const horizontal = source.some((cell) => cell.record === first.record);
  const start = source[0]!;
  const negative = horizontal ? (first.columnIndex ?? 0) < (start.columnIndex ?? 0) : (first.rowIndex ?? 0) < (start.rowIndex ?? 0);
  const ordered = [...source].sort((a, b) => (a.rowIndex ?? 0) - (b.rowIndex ?? 0) || (a.columnIndex ?? 0) - (b.columnIndex ?? 0));
  const outcome = fillCells(gantt.project as ProjectModel, {
    source: cellRefs(ordered),
    targets: cellRefs(negative ? [...targets].reverse() : targets),
    horizontal,
    negative,
  });
  report('fill', outcome);
  // Keep the filled range selected, as Bryntum would (after its own cleanup of the canceled drag).
  const corners = [from, to].map((corner) => ({ record: corner.record, column: corner.column }));
  void outcome.finally(() =>
    setTimeout(() => {
      if (!gantt.isDestroyed) (gantt as Gantt & { selectCellRange(from: object, to: object): void }).selectCellRange(corners[0]!, corners[1]!);
    }, 0),
  );
  return true;
}

interface GanttCallbacks {
  rentals: RentalEditing | undefined;
  editTask(task: TaskModel): void;
  saveToLibrary(task: TaskModel, selection: readonly TaskModel[]): void;
  /** "Watch…": the task, or the selection when the task is part of it. */
  watchTasks(task: TaskModel, selection: readonly TaskModel[]): void;
  askAssistant(task: TaskModel): void;
  /** Header menu: "Edit column…", "Hide column", "Columns…". */
  editColumn(columnId: string): void;
  hideColumn(columnId: string): void;
  openColumns(): void;
}

/** Header menu items other features add that stay: sorting. Filtering, grouping and Bryntum's own column items go. */
const KEPT_HEADER_ITEMS = new Set(['sortAsc', 'sortDesc']);

function ganttConfig(
  look: { readonly current: LookState },
  stats: { readonly current: Map<string, GroupStats> },
  callbacks: { readonly current: GanttCallbacks },
  lockedWidth: number,
) {
  return {
    enableTransactionalFeatures: true,
    // The plan's columns keep their widths when the splitter moves; the timeline takes the rest.
    fillLastColumn: false,
    // Cells can be selected one by one or as a range (drag, Shift+click), copied, pasted and
    // filled down; every resulting edit is an ordinary record change, so it travels as a revision.
    selectionMode: { cell: true, dragSelect: true, multiSelect: true, selectRecordOnCell: true },
    // Clicking a task's cell brings its bar into view on the timeline (the row is already visible).
    scrollTaskIntoViewOnCellClick: { block: 'nearest', animate: 300 },
    cellCopyPasteFeature: true,
    fillHandleFeature: true,
    // Whole tasks (with their subtasks, links between them and crews) are copied from the context
    // menu: with cell selection on, Ctrl+C / Ctrl+V copy cell values instead.
    taskCopyPasteFeature: {
      rowOptionsOnCellContextMenu: true,
      copyRecordText: 'Copy',
      cutRecordText: 'Cut',
      pasteRecordText: 'Paste',
      rowSpecifierText: 'task',
      rowSpecifierTextPlural: 'tasks',
    },
    rowReorderFeature: { showGrip: true, gripOnly: true },
    // The hover card stays open while the pointer is on it (to read or select its text) and gives
    // the pointer time to travel from the bar to the card before it hides.
    taskTooltipFeature: {
      // On the bar, as Bryntum has it, and on the pill beside it that says where a fix stands.
      forSelector: ':is(.b-gantt-task, .look-status):not(.b-drag-proxy, .b-is-creating)',
      cls: 'look-tooltip',
      maxWidth: 400,
      allowOver: true,
      hoverDelay: 350,
      hideDelay: 400,
      template: ({ taskRecord }: { taskRecord: TaskModel }) => renderTaskTooltip(look.current, taskRecord),
    },
    taskMenuFeature: {
      items: {
        editInPanel: {
          text: 'Edit task…',
          icon: 'fa fa-pen-to-square',
          weight: 100,
          onItem: ({ taskRecord }: { taskRecord: TaskModel }) => callbacks.current.editTask(taskRecord),
        },
        saveToLibrary: {
          text: 'Save to library…',
          icon: 'fa fa-cubes',
          weight: 110,
          onItem: ({ taskRecord, source }: { taskRecord: TaskModel; source: Gantt }) => callbacks.current.saveToLibrary(taskRecord, (source.selectedRecords ?? []) as TaskModel[]),
        },
        askAssistant: {
          text: `Ask ${ASSISTANT_NAME} about it`,
          icon: REMY_GLYPH,
          weight: 112,
          onItem: ({ taskRecord }: { taskRecord: TaskModel }) => callbacks.current.askAssistant(taskRecord),
        },
        watchTasks: {
          text: 'Watch…',
          icon: 'fa fa-bell',
          weight: 114,
          onItem: ({ taskRecord, source }: { taskRecord: TaskModel; source: Gantt }) => callbacks.current.watchTasks(taskRecord, (source.selectedRecords ?? []) as TaskModel[]),
        },
        // A payment gate after this work: what follows waits until PayPal has paid for it (pay-gates.ts).
        holdForPayment: {
          text: 'Hold what follows until this is paid',
          icon: 'fa fa-lock',
          weight: 116,
          onItem: ({ taskRecord, source }: { taskRecord: TaskModel; source: Gantt }) => {
            const project = source.project as ProjectModel;
            addPayGate(project, original(taskRecord)).then(
              // Opened once the server has numbered it, so the panel follows the gate.
              (gate) => void whenSaved(project).then(() => callbacks.current.editTask(gate)),
              (error: unknown) => Toast.show({ html: StringHelper.encodeHtml(error instanceof Error ? error.message : String(error)), timeout: 4000 }),
            );
          },
        },
        editSchedule: {
          text: 'Edit dates & progress…',
          icon: 'fa fa-calendar-days',
          weight: 105,
          onItem: ({ taskRecord, source }: { taskRecord: TaskModel; source: Gantt }) => {
            openCollapsedCellEditor(source, taskRecord, 'schedule-when', look.current, callbacks.current.editTask);
          },
        },
        // With cell selection on, Bryntum's own row items only show for rows picked as whole rows, which
        // nothing here does: its Copy, Cut and Paste are the cell's. These are the task's, with what is under it
        // (task-clipboard.ts).
        copyTask: {
          text: 'Copy task',
          icon: 'fa fa-copy',
          weight: 120,
          onItem: ({ taskRecord, source }: { taskRecord: TaskModel; source: Gantt }) => holdTasks(source.project as ProjectModel, tasksFor(source, taskRecord), false),
        },
        cutTask: {
          text: 'Cut task',
          icon: 'fa fa-scissors',
          weight: 121,
          onItem: ({ taskRecord, source }: { taskRecord: TaskModel; source: Gantt }) => holdTasks(source.project as ProjectModel, tasksFor(source, taskRecord), true),
        },
        pasteTask: {
          text: 'Paste task',
          icon: 'fa fa-paste',
          weight: 122,
          onItem: ({ taskRecord, source }: { taskRecord: TaskModel; source: Gantt }) => void pasteTasks(source, taskRecord),
        },
        add: { text: 'Add', icon: 'fa fa-plus' },
        convertToMilestone: { text: 'Make it a milestone', icon: 'fa fa-diamond' },
        indent: { text: 'Move into the task above', icon: 'fa fa-indent' },
        outdent: { text: 'Move out one level', icon: 'fa fa-outdent' },
        deleteTask: { text: 'Delete', icon: 'fa fa-trash-can', cls: 'look-menu-danger' },
        linkTasks: { text: 'Link in order', icon: 'fa fa-link' },
        unlinkTasks: { text: 'Remove links', icon: 'fa fa-link-slash' },
        // Filtering lives in the toolbar; the menu stays about the task.
        filterMenu: false,
      },
      // Linking needs two or more tasks: with one, the link items are noise.
      processItems: ({ items, selection, taskRecord }: { items: Record<string, unknown>; selection?: unknown[]; taskRecord?: TaskModel }) => {
        if (taskRecord) queueMenuItems(original(taskRecord).project as unknown as ProjectModel, items);
        // A gate goes after work that has money in it and later work waiting for it, once.
        if (taskRecord) {
          const record = original(taskRecord);
          const project = record.project as unknown as ProjectModel;
          const leadsOn = [...((record as unknown as { outgoingDeps?: Set<{ toEvent?: TaskModel }> }).outgoingDeps ?? [])].some((link) => !gateFor(project, link.toEvent ?? null));
          const gatedAlready = record.isLeaf ? false : ((record.children as TaskModel[] | undefined) ?? []).some((child) => gateFor(project, child));
          if (record.isMilestone || gatedAlready || (record.isLeaf && !leadsOn)) items.holdForPayment = false;
        }
        if ((selection?.length ?? 0) < 2) {
          items.linkTasks = false;
          items.unlinkTasks = false;
        }
        const pasteItem = items.pasteTask;
        if (pasteItem && typeof pasteItem === 'object' && taskRecord) Object.assign(pasteItem, { disabled: !hasHeldTasks(original(taskRecord).project as unknown as ProjectModel) });
        // While PayPal pays for a task, nothing may delete or move it (or the group holding it).
        const locked = firstLockedWithin([taskRecord, ...((selection ?? []) as TaskModel[])]);
        if (locked) {
          for (const key of ['deleteTask', 'indent', 'outdent', 'convertToMilestone', 'cut', 'cutTask']) {
            const item = items[key];
            if (item && typeof item === 'object') Object.assign(item, { disabled: true, tooltip: lockMessageHtml(locked) });
          }
          items.paymentLock = { text: 'Locked while PayPal pays', icon: 'fa fa-lock', disabled: true, weight: 1 };
        }
      },
    },
    // Tasks are edited in the side panel, which applies each change as it is made. Bryntum's pop-up
    // editor holds the project queue while it is open, which a panel that stays open must not do.
    taskEditFeature: false,
    // Readable time axis at every zoom level, in the same words: weeks start on Monday.
    weekStartDay: 1,
    presets: ZOOM_PRESETS,
    viewPreset: 'collab-days',
    // Zooming scales the timeline between the levels instead of jumping from one to the next, and stops
    // at the widest and closest of them.
    smoothZoom: true,
    minZoomLevel: 'collab-quarters',
    maxZoomLevel: 'collab-day-names',
    rowHeight: 46,
    barMargin: 9,
    subGridConfigs: { locked: { width: lockedWidth } },
    // Columns are chosen in the column selector ("+" in the header row) and edited from the header
    // menu; Bryntum's own column picker would change columns behind the viewer's layout.
    columnPickerFeature: false,
    headerMenuFeature: {
      processItems: ({ items, column }: { items: Record<string, unknown>; column?: { id?: string | number } }) => {
        for (const key of Object.keys(items)) {
          if (!KEPT_HEADER_ITEMS.has(key)) delete items[key];
        }
        const id = String(column?.id ?? '');
        if (!columnDefinition(id)) return;
        const fixed = id === TASK_COLUMN_ID;
        items.editColumn = { text: 'Edit column…', icon: 'fa fa-pen', weight: 10, onItem: () => callbacks.current.editColumn(id) };
        items.hideColumn = {
          text: 'Hide column',
          icon: 'fa fa-eye-slash',
          weight: 20,
          disabled: fixed,
          onItem: () => callbacks.current.hideColumn(id),
        };
        items.chooseColumns = { text: 'Columns…', icon: 'fa fa-table-columns', weight: 30, onItem: () => callbacks.current.openColumns() };
        const sortAsc = items.sortAsc as Record<string, unknown> | undefined;
        if (sortAsc && typeof sortAsc === 'object') sortAsc.separator = true;
      },
    },
    taskRenderer: (context: TaskRenderData) => renderTaskBar(look.current, context),
    // "Planned dates": a thin line under a bar where the task was first planned, drawn only where
    // the plan has moved (a baseline that matches the bar would be a second copy of it).
    baselinesFeature: {
      renderer: ({ baselineRecord, taskRecord, renderData }: { baselineRecord: TimeSpan; taskRecord: TaskModel; renderData: { className: Record<string, unknown> } }) => {
        if (baselineOnPlan(baselineRecord, taskRecord)) renderData.className['look-baseline-on-plan'] = 1;
        return '';
      },
    },
    // Bands from library pieces (e.g. "Floor topping drying: keep foot traffic off"); library/bands.ts fills
    // the store from the tasks, so it is never edited here.
    timeRangesFeature: {
      showHeaderElements: true,
      enableResizing: false,
      // Where today falls: what is behind it was reported, what is ahead is the plan. With the plan's date pinned
      // (plan-clock.ts), the line is drawn on that day instead (axis-marks.ts, showPlanToday).
      showCurrentTimeLine: CURRENT_TIME_LINE,
      showTooltip: true,
      tooltipTemplate: ({ timeRange }: { timeRange: TimeSpan }) => renderBandTooltip(timeRange),
    },
    criticalPathsFeature: { disabled: true },
    dependenciesFeature: {
      tooltip: { cls: 'look-tooltip look-dep-tooltip' },
      tooltipTemplate: renderDependencyTooltip,
      // A link out of a payment not yet made is drawn blocked, with a stop mark; it lifts once PayPal pays (hold-look.ts).
      renderer: holdLinkRenderer,
    },
    percentBarFeature: true,
    // A task marked "Rollup" in the task panel also shows as a small bar on its phase's bar.
    rollupsFeature: true,
    filterFeature: true,
    labelsFeature: {
      after: { renderer: (context: { taskRecord: TaskModel }) => renderAfterLabel(look.current, context) },
    },
    // Shows the constraint a published booking change puts on its activity (and deadlines), plus
    // rented equipment's time on site around the work that uses it.
    indicatorsFeature: {
      items: {
        earlyDates: false,
        lateDates: false,
        constraintDate: true,
        deadlineDate: deadlineIndicator,
        rentedEquipment: (task: TaskModel) => rentalIndicator(look.current, task),
        // Where work a library drop moved used to be, for a few seconds (library/was-here.ts).
        wasHere: wasHereIndicator,
        // Where work would land if a payment came late, while a pay day is pointed at (pay-late-preview.ts).
        payLate: payLateIndicator,
        // The odds, while the odds panel has an answer (odds/chart-odds.ts): each bar's P80 tail, a chip on the
        // tasks that move the handover most, and the handover's P10 to P90 whisker.
        oddsTail: oddsTailIndicator,
        oddsChip: oddsChipIndicator,
        oddsWhisker: oddsWhiskerIndicator,
      },
    },
    // New rows slide in and moved bars slide to their new dates (a drop, an undo, another person's change).
    transition: { insertRecord: true, removeRecord: true, changeEvent: true },
    transitionDuration: 450,
    treeGroupFeature: {
      levels: [],
      parentRenderer: ({ value }: { value: unknown }) => renderGroupRow(String(value), stats.current.get(String(value))),
      parentSortFn: (a: { name?: unknown }, b: { name?: unknown }) => compareGroups(String(a.name ?? ''), String(b.name ?? '')),
    },
    // Enter commits and closes the editor. The default moves the editor to the next row and keeps
    // it open, and an open editor pauses the project queue (transactional features), which would
    // hold back every incoming revision until the user noticed.
    cellEditFeature: { editNextOnEnterPress: false },
  } satisfies BryntumGanttProps;
}

export function GanttWorkspace({
  project,
  canViewCosts,
  layoutKey = 'default',
  decorations = NO_DECORATIONS,
  revision = 0,
  quiet = false,
  hideColumns,
  onSelectionChange,
  currency = 'USD',
  histogramOpen: initiallyOpen = false,
  apiRef,
  onEditTask,
  onOpenRentals,
  onOpenPayment,
  onShowPanelTab,
  hasAssistant = false,
  rentals,
  onSaveToLibrary,
  onWatchTasks,
  onAskAssistant,
  onOddsAnswered,
}: GanttWorkspaceProps) {
  const ganttRef = useRef<BryntumGantt>(null);
  const oddsAnsweredRef = useRef(onOddsAnswered);
  oddsAnsweredRef.current = onOddsAnswered;
  const openRentalsRef = useRef(onOpenRentals);
  openRentalsRef.current = onOpenRentals;
  const openPaymentRef = useRef(onOpenPayment);
  openPaymentRef.current = onOpenPayment;
  const showPanelTabRef = useRef(onShowPanelTab);
  showPanelTabRef.current = onShowPanelTab;
  const hasAssistantRef = useRef(hasAssistant);
  hasAssistantRef.current = hasAssistant;
  const theaterRef = useRef<Theater | null>(null);
  /** The odds panel's controller (see below), for runOdds. */
  const oddsRef = useRef<OddsController | null>(null);
  const gantt = (): Gantt | undefined => ganttRef.current?.instance;

  // Time ranges from library pieces, kept in step with their tasks.
  useEffect(() => attachBands(project), [project]);
  useEffect(() => showPlanToday(project), [project]);

  // The viewer's columns: restored from this browser on mount, stored whenever the viewer changes them.
  const access = useMemo(() => ({ canViewCosts }), [canViewCosts]);
  const storageKey = columnLayoutStorageKey(layoutKey);
  const [storedLayout, setStoredLayout] = useState<ColumnLayout>(() => loadColumnLayout(browserStorage(), storageKey, access));
  const layout = useMemo(() => normalizeColumnLayout(storedLayout, access), [storedLayout, access]);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const storageKeyRef = useRef(storageKey);
  useEffect(() => {
    if (storageKeyRef.current === storageKey) return;
    storageKeyRef.current = storageKey;
    setStoredLayout(loadColumnLayout(browserStorage(), storageKey, access));
  }, [storageKey, access]);

  const hiddenKey = hideColumns?.join() ?? '';
  useEffect(() => {
    if (!hiddenKey || browserStorage()?.getItem(storageKey) != null) return;
    setStoredLayout((current) => hiddenKey.split(',').reduce((next, id) => hideColumn(next, id), current));
  }, [hiddenKey, storageKey]);

  const updateLayout = useCallback((change: LayoutChange) => {
    const current = layoutRef.current;
    const next = change(current);
    if (next === current) return;
    layoutRef.current = next;
    setStoredLayout(next);
    saveColumnLayout(browserStorage(), storageKeyRef.current, next);
  }, []);

  // The column region is as wide as its columns, bounded by a share of the workspace (column-layout.ts);
  // the crew pane mirrors it so the two timelines line up.
  const mainRef = useRef<HTMLDivElement>(null);
  const [mainWidth, setMainWidth] = useState(0);
  const mainWidthRef = useRef(mainWidth);
  mainWidthRef.current = mainWidth;
  const gridWidthOf = (current: ColumnLayout, workspaceWidth: number) => lockedGridWidth(current, { extra: PICKER_COLUMN_WIDTH, workspaceWidth });

  /** Brings the live columns and the column region in line with the current layout (idempotent). */
  const syncGrid = useCallback(() => {
    const instance = ganttRef.current?.instance;
    if (!instance || instance.isDestroyed) return;
    const current = layoutRef.current;
    const locked = instance.getSubGrid('locked') as unknown as { width: number; collapsed?: boolean; header?: { cachePositions?(): void } };
    // The region's width first, so a column shown or hidden lays out at the final width.
    const width = gridWidthOf(current, mainWidthRef.current);
    const resized = !locked.collapsed && Math.abs(locked.width - width) >= 1;
    if (resized) locked.width = width;
    const { changed, realigned } = applyColumnLayout(instance.columns as unknown as LiveColumnStore, current);
    if (realigned) instance.refreshRows();
    // Cells are placed from the header positions, which Bryntum re-reads when a header resizes; a
    // column change and a region resize in the same frame can leave every header its old size.
    if (resized || changed) {
      locked.header?.cachePositions?.();
      (instance as unknown as { rowManager?: { positionCells?(): void } }).rowManager?.positionCells?.();
    }
  }, []);
  const layoutActions = useRef({ change: updateLayout, sync: syncGrid, workspaceWidth: () => mainWidthRef.current });
  layoutActions.current = { change: updateLayout, sync: syncGrid, workspaceWidth: () => mainWidthRef.current };

  const [columnPanel, setColumnPanel] = useState<ColumnPanel>(null);

  const [search, setSearch] = useState('');
  const [quickFilter, setQuickFilter] = useState<QuickFilter>('all');
  /** Remy's filter (a crew's work, a span of days), named on a chip above the chart where it is cleared. */
  const [planFilter, setPlanFilter] = useState<PlanFilter | null>(null);
  /** The attention rule taken from a leader while following (null: this viewer's own, by cost access). */
  const [attentionRule, setAttentionRule] = useState<boolean | null>(null);
  const attentionCosts = attentionRule ?? canViewCosts;
  const [groupBy, setGroupBy] = useState<GroupBy>('phase');
  const [criticalPath, setCriticalPath] = useState(false);
  const [planned, setPlanned] = useState(true);
  const [colorBy, setColorBy] = useState<ColorBy>('phase');

  // The toolbar look, lent to follow mode: read as it is now, set from a leader's frame, and reported
  // once the plan has been regrouped and refiltered (`settled` chains that work, see the effects below).
  const toolbarLook: ToolbarLook = { groupBy, colorBy, filter: quickFilter, search, criticalPath, planned, attentionCosts };
  const toolbarLookRef = useRef(toolbarLook);
  toolbarLookRef.current = toolbarLook;
  const canViewCostsRef = useRef(canViewCosts);
  canViewCostsRef.current = canViewCosts;
  const settled = useRef<Promise<void>>(Promise.resolve());
  const afterCommit = useRef<(() => void)[]>([]);
  const lookListeners = useRef(new Set<() => void>());
  const emitLook = useCallback(() => {
    for (const listener of [...lookListeners.current]) listener();
  }, []);
  const [lookBridge] = useState<LookBridge>(() => ({
    read: () => ({ ...toolbarLookRef.current }),
    async apply(wanted) {
      // Budget groups are for cost viewers: someone else following a cost manager keeps their phases.
      const look = wanted.groupBy === 'budget' && !canViewCostsRef.current ? { ...wanted, groupBy: 'phase' as const } : wanted;
      const current = toolbarLookRef.current;
      const same = (Object.keys(look) as (keyof ToolbarLook)[]).every((key) => current[key] === look[key]);
      if (!same) {
        setGroupBy(look.groupBy);
        setColorBy(look.colorBy);
        setQuickFilter(look.filter);
        setSearch(look.search);
        setCriticalPath(look.criticalPath);
        setPlanned(look.planned);
        setAttentionRule(look.attentionCosts === canViewCostsRef.current ? null : look.attentionCosts);
        await new Promise<void>((resolve) => afterCommit.current.push(resolve));
      }
      await settled.current;
    },
    onChange(listener) {
      lookListeners.current.add(listener);
      return () => {
        lookListeners.current.delete(listener);
      };
    },
  }));

  // Renderers are configured once and read the latest view state through these refs.
  const moneyColumns = canViewCosts && hasVisibleMoneyColumn(layout);
  const look = useRef<LookState>({ decorations, canViewCosts, moneyColumns, currency, groupBy, colorBy });
  look.current = { decorations, canViewCosts, moneyColumns, currency, groupBy, colorBy };
  const stats = useRef(new Map<string, GroupStats>());
  const callbacks = useRef<GanttCallbacks>({
    rentals: undefined,
    editTask: () => undefined,
    saveToLibrary: () => undefined,
    watchTasks: () => undefined,
    askAssistant: () => undefined,
    editColumn: () => undefined,
    hideColumn: () => undefined,
    openColumns: () => undefined,
  });
  callbacks.current = {
    rentals,
    editTask: (task) => {
      const id = original(task).id;
      if (typeof id === 'number') onEditTask?.(id);
    },
    saveToLibrary: (task, selection) => {
      const ids = (selection.some((picked) => original(picked) === original(task)) ? selection : [task]).map((picked) => original(picked).id).filter((id): id is number => typeof id === 'number');
      if (ids.length) onSaveToLibrary?.(ids);
    },
    watchTasks: (task, selection) => {
      const ids = (selection.some((picked) => original(picked) === original(task)) ? selection : [task]).map((picked) => original(picked).id).filter((id): id is number => typeof id === 'number');
      if (ids.length) onWatchTasks?.(ids);
    },
    askAssistant: (task) => {
      const id = original(task).id;
      if (typeof id === 'number') onAskAssistant?.(id);
    },
    editColumn: (columnId) => setColumnPanel({ kind: 'editor', columnId }),
    hideColumn: (columnId) => updateLayout((current) => hideColumn(current, columnId)),
    openColumns: () => setColumnPanel({ kind: 'picker' }),
  };
  const [config] = useState(() => ganttConfig(look, stats, callbacks, gridWidthOf(layout, 0)));

  // Remy's screen actions, made fresh each render (below) so they read the view as it is now.
  const screenRef = useRef<GanttScreen | null>(null);
  useImperativeHandle(
    apiRef,
    () => ({
      screen: () => screenRef.current!,
      selectTask(taskId: number): boolean {
        const instance = gantt();
        const task = instance?.project.taskStore.getById(taskId) as TaskModel | undefined;
        if (!instance || !task) {
          return false;
        }
        // While grouped the Gantt shows linked copies; select the copy of this task.
        const store = instance.store as Store;
        const shown = (store.getById(taskId) as TaskModel | undefined) ?? (store.find((record: Model) => original(record as TaskModel) === task, true) as TaskModel | undefined);
        if (!shown) {
          return false;
        }
        instance.selectRow({ record: shown, scrollIntoView: true });
        void instance.scrollTaskIntoView(shown, { highlight: true, block: 'center' });
        theaterRef.current?.show([taskId]);
        return true;
      },
      focusTasks(taskIds: readonly number[]): number {
        const instance = gantt();
        if (!instance) return 0;
        const store = instance.store as Store;
        const shown = taskIds
          .map((taskId) => {
            const task = instance.project.taskStore.getById(taskId) as TaskModel | undefined;
            return task ? ((store.getById(taskId) as TaskModel | undefined) ?? (store.find((record: Model) => original(record as TaskModel) === task, true) as TaskModel | undefined)) : undefined;
          })
          .filter((task): task is TaskModel => task !== undefined);
        if (shown.length === 0) return 0;
        theaterRef.current?.show(taskIds);
        void (async () => {
          for (const task of shown) await instance.expandTo(task as never, false);
          instance.selectedRecords = shown as never;
          await instance.scrollTaskIntoView(shown[0]!, { highlight: true, block: 'center', animate: true } as never);
          flashRows(instance, shown);
        })().catch((error: unknown) => console.error('Could not show the tasks', error));
        return shown.length;
      },
      followTasks(taskIds: readonly number[]): void {
        theaterRef.current?.show(taskIds);
      },
      setSearch(text: string): void {
        setQuickFilter('all');
        setSearch(text);
      },
      instance: () => gantt(),
      look: lookBridge,
      latePaymentEffect: () => latePaymentEffect(project),
      async runOdds(pay?: PayPolicy): Promise<OddsSummary> {
        setOddsOpen(true);
        // A frame for the panel to come up and its plot to take the dots.
        await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
        const controller = oddsRef.current;
        if (!controller) throw new Error('The plan is not open here.');
        return oddsSummary(await controller.answerFresh(pay));
      },
    }),
    [lookBridge],
  );
  const histogramHostRef = useRef<HTMLDivElement>(null);
  const [histogramOpen, setHistogramOpen] = useState(initiallyOpen);
  const [paneTab, setPaneTab] = useState<CrewPaneTab>('workload');

  // The odds panel beside the chart. Its controller lives as long as the project is on show (it keeps the last
  // answer while the panel is closed, and only listens until then): made and let go by the same effect.
  const [oddsOpen, setOddsOpen] = useState(false);
  const [odds, setOdds] = useState<{ project: ProjectModel; controller: OddsController } | null>(null);
  oddsRef.current = odds?.project === project ? odds.controller : null;
  useEffect(() => {
    const controller = new OddsController(project);
    setOdds({ project, controller });
    // A run that went to the end, for whoever is told (the hosted site's "Try these").
    let answered = false;
    const stopListening = controller.subscribe(() => {
      const { phase, complete } = controller.getState();
      const done = phase === 'done' && complete;
      if (done && !answered) oddsAnsweredRef.current?.();
      answered = done;
    });
    return () => {
      stopListening();
      controller.dispose();
      setOdds(null);
    };
  }, [project]);

  // The Bryntum listener is registered once; it reads the latest callback through this ref.
  const selectionCallback = useRef(onSelectionChange);
  selectionCallback.current = onSelectionChange;
  const [listeners] = useState(() => ({
    // In cell selection mode the event carries cells; the rows behind them are the selected tasks.
    onSelectionChange: (event: { source: unknown }) => {
      selectionCallback.current?.(selectedTaskIds((event.source as Gantt).selectedRecords as Model[]));
    },
    onTaskDblClick: (event: { taskRecord: unknown }) => {
      callbacks.current.editTask(event.taskRecord as TaskModel);
    },
    // The collapsed columns open their own editors (Bryntum's cell editor is off for them).
    onCellDblClick: (event: { grid: unknown; record: Model; column: unknown }) => {
      const columnId = (event.column as { id?: string | number }).id;
      openCollapsedCellEditor(event.grid as Gantt, event.record as TaskModel, columnId === undefined ? undefined : String(columnId), look.current, callbacks.current.editTask, callbacks.current.rentals);
    },
    // Delete over several cells is handled by the key handler below (every field of a collapsed cell,
    // one change); Bryntum's own clear would set each editor field to null and unschedule tasks.
    onBeforeCellRangeDelete: () => false,
    onFillHandleBeforeDragFinalize: (event: { from: unknown; to: unknown }) => {
      // Every Bryntum event carries its source; the typings of this one leave it out.
      const instance = ((event as { source?: Gantt }).source ?? ganttRef.current?.instance) as Gantt | undefined;
      return !instance || !takeOverFill(instance, event.from as CellLocation, event.to as CellLocation, (kind, outcome) => cellOps.current(kind, outcome));
    },
    // Pasted copies of tasks start fresh: nothing of the original's progress, spending or payments.
    onBeforePaste: (event: { entityName?: string; isCut?: boolean }) => {
      const { records } = event as { records?: TaskModel[] };
      if (event.entityName === 'task' && !event.isCut && records) prepareCopiedTasks(records);
      return true;
    },
    // Header drags reorder the shown columns; the task column stays first and the "+" last, and
    // nothing moves into the timeline's region.
    onBeforeColumnDropFinalize: (event: { column: unknown; insertBefore?: unknown; region?: string }) => {
      const id = String((event.column as { id?: unknown }).id);
      const before = (event.insertBefore as { id?: unknown } | null | undefined)?.id;
      return event.region === 'locked' && id !== PICKER_COLUMN_ID && id !== TASK_COLUMN_ID && String(before) !== TASK_COLUMN_ID;
    },
    onColumnDrop: (event: { source: unknown; valid?: boolean }) => {
      if (event.valid) {
        const store = (event.source as Gantt).columns as unknown as LiveColumnStore;
        layoutActions.current.change((current) => orderVisibleColumns(current, visibleColumnOrder(store)));
      }
      layoutActions.current.sync();
    },
    // Dragging a header edge: the new width is the column's; the grid widens with it.
    onColumnResize: (event: { column: unknown }) => {
      const column = event.column as { id?: unknown; width?: unknown };
      const id = String(column.id);
      const { width } = column;
      if (typeof width === 'number') layoutActions.current.change((current) => setColumnWidth(current, id, width));
      layoutActions.current.sync();
    },
    // Dragging the splitter: the task column takes what the other columns leave of the new width.
    onSplitterDragEnd: (event: { source: unknown }) => {
      const { width } = (event.source as Gantt).getSubGrid('locked') as unknown as { width: unknown };
      const workspaceWidth = layoutActions.current.workspaceWidth();
      if (typeof width === 'number') layoutActions.current.change((current) => fitTaskColumnToGrid(current, width, { extra: PICKER_COLUMN_WIDTH, workspaceWidth }));
      layoutActions.current.sync();
    },
  }));

  useEffect(() => closeCellEditor, []);

  // What a fill or a clear did, said in one line under the plan for a few seconds.
  const [cellNotice, setCellNotice] = useState<{ text: string; tone: 'ok' | 'error' } | null>(null);
  const cellOps = useRef<(kind: 'fill' | 'clear', outcome: Promise<CellOpReport>) => void>(() => undefined);
  cellOps.current = (kind, outcome) => {
    outcome.then(
      (report) => {
        const text = describeCellOp(kind, report);
        setCellNotice(text ? { text, tone: 'ok' } : null);
      },
      (error: unknown) => setCellNotice({ text: `Not ${kind === 'fill' ? 'filled' : 'cleared'}: ${error instanceof Error ? error.message : String(error)}`, tone: 'error' }),
    );
  };
  useEffect(() => {
    if (!cellNotice) return undefined;
    const timer = setTimeout(() => setCellNotice(null), 5_000);
    return () => clearTimeout(timer);
  }, [cellNotice]);

  // A menu open on a task someone else just removed would act on a record that is gone: it closes.
  useEffect(() => {
    const instance = gantt();
    if (!instance) return undefined;
    return project.taskStore.on({
      remove: ({ records }: { records: TaskModel[] }) => {
        const feature = instance.features.taskMenu as unknown as { menu?: { isVisible?: boolean; hide(): void }; menuContext?: { taskRecord?: TaskModel } };
        const target = feature.menuContext?.taskRecord;
        if (!feature.menu?.isVisible || !target) return;
        if (records.some((record) => record === target || (record as unknown as { contains(child: TaskModel): boolean }).contains(target))) feature.menu.hide();
      },
    }) as unknown as () => void;
  }, [project]);

  // Enter or F2 on a focused collapsed cell opens its editor, as they would start a cell edit elsewhere.
  // Delete or Backspace clears the selected cells (or a collapsed focused cell) here, as one change.
  useEffect(() => {
    const instance = gantt();
    const element = instance?.element;
    if (!instance || !element) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      // Indent, outdent and cut would move or remove a task PayPal is paying for (or its group).
      const structural = (event.altKey && event.shiftKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) || ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'x');
      if (structural && !(event.target as HTMLElement | null)?.closest('input, textarea, [contenteditable="true"]')) {
        const locked = firstLockedWithin((instance.selectedRecords ?? []) as TaskModel[]);
        if (locked) {
          event.preventDefault();
          event.stopImmediatePropagation();
          setCellNotice({ text: lockMessage(locked), tone: 'error' });
          return;
        }
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && !event.altKey && !event.ctrlKey && !event.metaKey) {
        const target = event.target as HTMLElement | null;
        const editing = (instance.features.cellEdit as unknown as { isEditing?: boolean } | undefined)?.isEditing;
        if (editing || instance.readOnly || !target?.closest('.b-grid-cell') || target.closest('input, textarea, [contenteditable="true"]')) return;
        const selected = ((instance as Gantt & { selectedCells?: CellLocation[] }).selectedCells ?? []) as CellLocation[];
        const focused = (instance as Gantt & { focusedCell?: CellLocation | null }).focusedCell;
        const cells = cellRefs(selected.length > 0 ? selected : focused ? [focused] : []);
        // One plain cell: Bryntum's editor opens empty, ready for a new value, as elsewhere. The Equipment cell has no such editor.
        if (cells.length === 0 || (cells.length === 1 && !isCollapsedColumn(cells[0]!.columnId) && cells[0]!.columnId !== 'equipment')) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        cellOps.current('clear', clearCells(instance.project as ProjectModel, cells));
        return;
      }
      if ((event.key !== 'Enter' && event.key !== 'F2') || event.altKey || event.ctrlKey || event.metaKey) return;
      const focused = (instance as Gantt & { focusedCell?: { record?: Model; column?: { id?: string } } | null }).focusedCell;
      const target = event.target as HTMLElement | null;
      if (!focused?.record || !target?.closest('.b-grid-cell')) return;
      if (openCollapsedCellEditor(instance, focused.record as TaskModel, focused.column?.id, look.current, callbacks.current.editTask, callbacks.current.rentals)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    element.addEventListener('keydown', onKeyDown, true);
    return () => element.removeEventListener('keydown', onKeyDown, true);
  }, []);

  // Built with the layout of the moment; later layout changes are applied to the live columns.
  const columns = useMemo(
    () =>
      buildGanttColumns({
        canViewCosts,
        currency,
        layout: layoutRef.current,
        renderGroup: (key) => renderGroupRow(key, stats.current.get(key)),
        rentalOf: (taskId) => look.current.decorations.get(taskId)?.rental,
      }),
    [canViewCosts, currency],
  );

  // Counts for the toolbar, over the original leaves (filters and groups do not change them).
  const query = search.trim().toLowerCase();
  const counts = useMemo(() => {
    const leaves = leafTasks(project);
    const state = { ...look.current, canViewCosts: attentionCosts };
    const quick = (task: TaskModel) =>
      quickFilter === 'all' ? true : quickFilter === 'active' ? statusOf(task) === 'active' : needsAttention(task, state);
    return {
      total: leaves.length,
      attention: leaves.filter((task) => needsAttention(task, state)).length,
      visible: leaves.filter((task) => (!query || matchesSearch(task, query)) && quick(task) && (!planFilter || keepsTask(planFilter, task))).length,
    };
    // `revision` and `decorations` change what the same records say.
  }, [project, revision, decorations, attentionCosts, query, quickFilter, planFilter]);
  const countsRef = useRef(counts);
  countsRef.current = counts;

  // Search and quick filter act on the display store (the grouped store while grouped). With
  // neither active, nothing is re-filtered, so recalculations never disturb an open editor.
  const filtered = useRef(false);
  const applyFilters = useCallback(async () => {
    const instance = gantt();
    if (!instance || instance.isDestroyed) return;
    const active = Boolean(query) || quickFilter !== 'all' || planFilter !== null;
    if (!active && !filtered.current) return;
    filtered.current = active;
    // A change running on the whole plan puts the filters back itself, and these go on top of that.
    await whenFiltersBack(project);
    const store = instance.store as Store;
    await store.removeFilter('look-search', true);
    await store.removeFilter('look-quick', true);
    await store.removeFilter('look-remy', true);
    if (planFilter) {
      const kept = planFilter;
      await store.addFilter({ id: 'look-remy', filterBy: (record: Model) => keepsTask(kept, record as TaskModel) }, true);
    }
    if (query) {
      await store.addFilter({ id: 'look-search', filterBy: (record: Model) => !(record as TaskModel).isLeaf || matchesSearch(record as TaskModel, query) }, true);
    }
    if (quickFilter !== 'all') {
      const state = { ...look.current, canViewCosts: attentionCosts };
      await store.addFilter(
        {
          id: 'look-quick',
          filterBy: (record: Model) => {
            const task = record as TaskModel;
            if (!task.isLeaf) return true;
            return quickFilter === 'active' ? statusOf(task) === 'active' : needsAttention(task, state);
          },
        },
        true,
      );
    }
    await store.filter();
  }, [query, quickFilter, attentionCosts, planFilter]);

  // Grouping replaces the display store, so filters are re-applied afterwards. The feature is looked up
  // when the step runs, not when the effect does: steps wait for the ones before them, and by then the
  // Gantt may have been destroyed and drawn again (React's development double mount, a hot reload,
  // signing out). Bryntum strips a destroyed object of its prototype, so the old feature has no
  // methods left ("clearGroups is not a function").
  useEffect(() => {
    if (!gantt()) return;
    let cancelled = false;
    settled.current = settled.current
      .then(async () => {
        const instance = gantt();
        const feature = instance && !instance.isDestroyed ? (instance.features.treeGroup as { isDestroyed?: boolean; isGrouped?: boolean; group(levels: unknown[]): Promise<void>; clearGroups(): Promise<void> } | undefined) : undefined;
        if (cancelled || !feature || feature.isDestroyed) return;
        if (groupBy === 'phase') {
          // The plan opens ungrouped: nothing to clear then.
          if (feature.isGrouped) await feature.clearGroups();
        } else {
          stats.current = groupStats(groupBy, leafTasks(project));
          await feature.group([(task: TaskModel) => groupKey(groupBy, task)]);
        }
        // The new display store starts unfiltered.
        filtered.current = true;
        if (!cancelled) await applyFilters();
      })
      .catch((error: unknown) => console.warn('Could not group the plan:', error))
      .finally(emitLook);
    return () => {
      cancelled = true;
    };
    // applyFilters is re-run by its own effect; grouping only needs the current one.
  }, [groupBy, project]);

  useEffect(() => {
    // After any regrouping still under way: a filter applied to the store being replaced would be lost.
    settled.current = settled.current
      .then(applyFilters)
      .catch((error: unknown) => console.warn('Could not filter the plan:', error))
      .finally(emitLook);
  }, [applyFilters, revision, decorations, emitLook]);

  // The hosted site opens where the film does: on the payment hold not yet paid, the work it holds, today and the
  // inspector's away week (gantt/opening-view.ts). After the first grouping and filtering, once per plan.
  useEffect(() => {
    if (!HOSTED) return;
    settled.current = settled.current
      .then(() => {
        const instance = gantt();
        return instance && !instance.isDestroyed ? showOpeningView(instance, project).then(() => undefined) : undefined;
      })
      .catch((error: unknown) => console.warn('Could not open the chart on the payment hold:', error));
  }, [project]);

  // Colors, critical path and planned dates change no rows: they are reported straight away.
  useEffect(emitLook, [colorBy, criticalPath, planned, emitLook]);

  // Last of the effects: whoever waits for this render's work to have started is let through.
  useEffect(() => {
    for (const resolve of afterCommit.current.splice(0)) resolve();
  });

  // Decorations, money beside the bars and group totals are drawn by renderers: redraw the rows when they change.
  useEffect(() => {
    // Tasks whose money is with PayPal are read-only until it settles (gantt/payment-lock.ts).
    setPaymentLocks(project, [...decorations].filter(([, decoration]) => decoration.tracker?.paying).map(([taskId]) => taskId));
    const instance = gantt();
    if (!instance) return;
    if (groupBy !== 'phase') stats.current = groupStats(groupBy, leafTasks(project));
    instance.refreshRows();
  }, [decorations, moneyColumns, currency, revision, groupBy, colorBy, project]);

  useEffect(() => {
    const element = mainRef.current;
    if (!element) return undefined;
    const observer = new ResizeObserver(() => setMainWidth(element.clientWidth));
    observer.observe(element);
    setMainWidth(element.clientWidth);
    return () => observer.disconnect();
  }, []);

  // The layout (or a rebuilt column set) reaches the grid.
  useEffect(syncGrid, [layout, columns, mainWidth, syncGrid]);

  // The "+" at the right end of the header row opens the column selector (click, Enter or Space).
  useEffect(() => {
    const element = gantt()?.element;
    if (!element) return undefined;
    const onPickerHeader = (target: EventTarget | null) => Boolean((target as Element | null)?.closest?.(`.b-grid-header[data-column-id="${PICKER_COLUMN_ID}"]`));
    const onClick = (event: MouseEvent) => {
      if (!onPickerHeader(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      setColumnPanel((panel) => (panel?.kind === 'picker' ? null : { kind: 'picker' }));
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.key !== 'Enter' && event.key !== ' ') || !onPickerHeader(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      setColumnPanel({ kind: 'picker' });
    };
    element.addEventListener('click', onClick, true);
    element.addEventListener('keydown', onKeyDown, true);
    return () => {
      element.removeEventListener('click', onClick, true);
      element.removeEventListener('keydown', onKeyDown, true);
    };
  }, []);

  // The "+" shows whether the selector is open; an editor whose column was hidden closes.
  useEffect(() => {
    const button = gantt()?.element?.querySelector('[data-testid="column-picker-button"]');
    button?.classList.toggle('is-open', columnPanel?.kind === 'picker');
    button?.setAttribute('aria-expanded', String(columnPanel?.kind === 'picker'));
    if (columnPanel?.kind === 'editor' && !layout.visible.includes(columnPanel.columnId)) setColumnPanel(null);
  }, [columnPanel, layout]);

  useEffect(() => {
    const feature = gantt()?.features.criticalPaths;
    if (feature) feature.disabled = !criticalPath;
  }, [criticalPath]);

  useEffect(() => {
    const feature = gantt()?.features.baselines;
    if (feature) feature.disabled = !planned;
  }, [planned]);

  // The 3D view (gantt/fx3d).
  useEffect(() => {
    const instance = gantt();
    if (!instance) return;
    drawPayLateOn(instance);
    drawOddsOn(instance);
    const stopHold = drawHoldOn(instance);
    nameProjectLines(instance);
    const theater = attachBarTheater({
      gantt: instance,
      look: () => look.current,
      editTask: (task) => callbacks.current.editTask(task),
      openFix: (task) => {
        const id = original(task).id;
        if (typeof id === 'number') (openPaymentRef.current ?? openRentalsRef.current)?.(id);
      },
      showPanelTab: (tab) => showPanelTabRef.current?.(tab) ?? false,
      hasAssistant: () => hasAssistantRef.current,
      // Quietly: the chart isn't on show, and what is selected goes along with what the assistant is asked.
      selectTask: (task) => {
        const store = instance.store as Store;
        const shown = (store.getById(task.id) as TaskModel | undefined) ?? (store.find((record: Model) => original(record as TaskModel) === task, true) as TaskModel | undefined);
        if (shown) instance.selectRow({ record: shown, scrollIntoView: false });
      },
    });
    theaterRef.current = theater;
    return () => {
      theaterRef.current = null;
      theater.destroy();
      drawOddsOn(null);
      stopHold();
    };
  }, []);

  // What is on show in 3D follows the plan and what is known about it, from whoever changed it.
  useEffect(() => {
    theaterRef.current?.planChanged();
  }, [decorations, revision]);

  // Undo and redo of this person's own changes: the toolbar buttons and Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z.
  const [history, setHistory] = useState<UndoState>(() => undoState(project));
  useEffect(() => {
    setHistory(undoState(project));
    return watchUndo(project, setHistory);
  }, [project]);
  const stepHistory = useCallback(
    (direction: 'undo' | 'redo') => {
      if (gantt()?.readOnly) return;
      // The server would refuse this step and leave this browser out of sync, so say why here instead.
      const lock = rentalsInNextStep(project, direction).map((machine) => callbacks.current.rentals?.lockOf(machine.taskId, machine.resourceId)).find(Boolean);
      if (lock) {
        setCellNotice({ text: lock, tone: 'error' });
        return;
      }
      (direction === 'undo' ? undo(project) : redo(project)).catch((error: unknown) =>
        setCellNotice({ text: `Could not ${direction} that: ${error instanceof Error ? error.message : String(error)}`, tone: 'error' }),
      );
    },
    [project],
  );
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const direction = undoKey(event);
      if (!direction) return;
      event.preventDefault();
      stepHistory(direction);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [stepHistory]);

  const zoom = (direction: 'in' | 'out' | 'fit') => {
    const instance = gantt();
    if (!instance) return;
    if (direction === 'in') void instance.zoomIn(1, { animate: true });
    else if (direction === 'out') void instance.zoomOut(1, { animate: true });
    else void instance.zoomToFit({ leftMargin: 24, rightMargin: 160, animate: true });
  };

  // How far work moved from its first dates is there for whoever turns on Planned dates in the View menu.
  useEffect(() => {
    if (quiet) setPlanned(false);
  }, [quiet]);

  const expand = (open: boolean) => {
    const instance = gantt();
    if (!instance) return;
    void (open ? instance.expandAll() : instance.collapseAll());
  };

  screenRef.current = {
    instance: () => gantt(),
    site: () => theaterRef.current,
    async setView(change) {
      if (change.search !== undefined) setSearch(change.search);
      if (change.quickFilter !== undefined) setQuickFilter(change.quickFilter);
      if (change.filter !== undefined) setPlanFilter(change.filter);
      // As follow mode does: once this render's effects have started, the chart is refiltered in turn.
      await new Promise<void>((resolve) => afterCommit.current.push(resolve));
      await settled.current;
    },
    counts: () => ({ visible: countsRef.current.visible, total: countsRef.current.total, filtered: countsRef.current.visible < countsRef.current.total }),
    async zoom(how) {
      const instance = gantt();
      if (!instance) return;
      if (how === 'in') await instance.zoomIn(1, { animate: true } as never);
      else if (how === 'out') await instance.zoomOut(1, { animate: true } as never);
      else await instance.zoomToFit({ leftMargin: 24, rightMargin: 160, animate: true });
    },
    zoomToDates(first, last) {
      const instance = gantt();
      if (!instance) return;
      const end = new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1);
      instance.zoomToSpan({ startDate: first, endDate: end, leftMargin: 16, rightMargin: 16 });
    },
    async expand(open, record) {
      const instance = gantt();
      if (!instance) return;
      if (!record) await (open ? instance.expandAll() : instance.collapseAll());
      else await (open ? instance.expand(record as never) : instance.collapse(record as never));
    },
    async history(direction) {
      if (gantt()?.readOnly) return { done: false, why: 'The plan is read only here.' };
      const state = undoState(project);
      const label = direction === 'undo' ? state.undoLabel : state.redoLabel;
      if (!label) return { done: false, why: direction === 'undo' ? 'There is nothing to undo from this screen: undo takes back only the changes made here since the page opened.' : 'There is nothing to redo.' };
      // The server would refuse this step and leave this browser out of sync, so say why instead.
      const lock = rentalsInNextStep(project, direction).map((machine) => callbacks.current.rentals?.lockOf(machine.taskId, machine.resourceId)).find(Boolean);
      if (lock) {
        setCellNotice({ text: lock, tone: 'error' });
        return { done: false, why: lock };
      }
      await (direction === 'undo' ? undo(project) : redo(project));
      return { done: true, label };
    },
    async editCell(record, columnId) {
      const instance = gantt();
      if (!instance || instance.readOnly || record.readOnly) return false;
      // The columns that hold several fields open their own pop-ups: Bryntum's cell editor is never started for them.
      if (COLLAPSED_COLUMNS.has(columnId)) return openCollapsedCellEditor(instance, record, columnId, look.current, callbacks.current.editTask, callbacks.current.rentals);
      const column = (instance.columns as unknown as Store).getById(columnId) as { editor?: unknown; readOnly?: boolean; hidden?: boolean } | undefined;
      if (!column || column.hidden || column.editor === false || column.readOnly) return false;
      const started = await instance.startEditing({ record, column } as never);
      return started !== false;
    },
    select(record) {
      const instance = gantt();
      if (!instance) return;
      instance.selectRow({ record, scrollIntoView: false });
      flashRows(instance, [record]);
    },
    addColumn(columnId) {
      updateLayout((current) => showLayoutColumn(current, columnId, access));
      syncGrid();
      const column = (gantt()?.columns as unknown as Store | undefined)?.getById(columnId) as { hidden?: boolean } | undefined;
      return Boolean(column && !column.hidden);
    },
    view() {
      const instance = gantt();
      const range = (instance as unknown as { visibleDateRange?: { startDate?: Date; endDate?: Date } } | undefined)?.visibleDateRange;
      const preset = (instance as unknown as { viewPreset?: { id?: string } } | undefined)?.viewPreset?.id;
      return {
        search,
        quickFilter,
        filter: planFilter?.label ?? null,
        from: range?.startDate instanceof Date ? range.startDate : null,
        to: range?.endDate instanceof Date ? range.endDate : null,
        zoom: typeof preset === 'string' ? preset.replace(/^collab-/, '').replace(/-/g, ' ') : null,
        odds: oddsOpen,
      };
    },
    setOdds: (open) => setOddsOpen(open),
    async scrollToDate(date) {
      const instance = gantt();
      if (!instance) return;
      await instance.scrollToDate(date, { block: 'center', animate: true } as never);
    },
  };

  useEffect(() => {
    const instance = gantt();
    const host = histogramHostRef.current;
    if (!histogramOpen || !instance || !host) {
      return undefined;
    }
    const lockedElement = instance.getSubGrid('locked').element;
    // The crew schedule: Scheduler Pro on this same project, partnered with the Gantt's time axis.
    const view = paneTab === 'schedule'
      ? createCrewSchedule({
          appendTo: host,
          project,
          partner: instance,
          lockedWidth: lockedElement.offsetWidth || gridWidthOf(layoutRef.current, mainWidthRef.current),
          readOnly: Boolean(instance.readOnly),
          tooltip: (task) => renderTaskTooltip(look.current, task),
          onSelectTask: (task) => {
            revealTaskInGantt(instance, task);
          },
          onOpenTask: (task) => callbacks.current.editTask(task),
        })
      : new ResourceHistogram({
      appendTo: host,
      project,
      partner: instance,
      hideHeaders: true,
      rowHeight: 38,
      showBarTip: true,
      showMaxEffort: true,
      subGridConfigs: { locked: { width: lockedElement.offsetWidth || gridWidthOf(layoutRef.current, mainWidthRef.current) } },
      columns: [
        {
          field: 'name',
          text: 'Crew',
          flex: 1,
          renderer: ({ record }: { record: Model }) => ({
            tag: 'span',
            className: 'look-histogram-crew',
            children: [crewBadge(record as ResourceModel), { tag: 'span', text: (record as ResourceModel).name ?? '' }],
          }),
        },
      ],
      features: { scheduleTooltip: false },
    });
    // `partner` syncs the time axis and scrolling; the column region is kept the same width
    // by hand so the two timelines stay aligned when the Gantt splitter is dragged.
    const observer = new ResizeObserver(() => {
      view.getSubGrid('locked').width = lockedElement.offsetWidth;
    });
    observer.observe(lockedElement);
    return () => {
      observer.disconnect();
      view.destroy();
    };
  }, [project, histogramOpen, paneTab]);

  return (
    <div className={`collab-gantt-workspace${quiet && !planned ? ' hides-slips' : ''}`}>
      <GanttToolbar
        quiet={quiet}
        search={search}
        onSearch={setSearch}
        quickFilter={quickFilter}
        onQuickFilter={(value) => {
          // Picking a filter yourself goes back to your own idea of what needs attention.
          setAttentionRule(null);
          setQuickFilter(value);
        }}
        groupBy={groupBy}
        onGroupBy={setGroupBy}
        canViewCosts={canViewCosts}
        criticalPath={criticalPath}
        onCriticalPath={setCriticalPath}
        planned={planned}
        onPlanned={setPlanned}
        colorBy={colorBy}
        onColorBy={setColorBy}
        attentionCount={counts.attention}
        visibleCount={counts.visible}
        totalCount={counts.total}
        planFilter={planFilter?.label ?? null}
        onClearPlanFilter={() => setPlanFilter(null)}
        onZoom={zoom}
        onExpand={expand}
        history={history}
        onUndo={() => stepHistory('undo')}
        onRedo={() => stepHistory('redo')}
        crewPane={histogramOpen ? paneTab : null}
        onCrewPane={(pane) => {
          if (pane) setPaneTab(pane);
          setHistogramOpen(pane !== null);
        }}
        odds={oddsOpen}
        onOdds={setOddsOpen}
      />
      <div className="collab-gantt-body">
        <div className="collab-gantt-main" ref={mainRef}>
          <BryntumGantt ref={ganttRef} project={project} columns={columns} {...listeners} {...config} />
          {cellNotice && (
            <p className={`gantt-cell-notice is-${cellNotice.tone}`} role="status" data-testid="gantt-cell-notice">
              <i className={`fa fa-${cellNotice.tone === 'ok' ? 'circle-check' : 'circle-exclamation'}`} aria-hidden="true" />
              <span>{cellNotice.text}</span>
              <button type="button" aria-label="Dismiss" onClick={() => setCellNotice(null)}>
                <i className="fa fa-xmark" aria-hidden="true" />
              </button>
            </p>
          )}
        </div>
        {oddsOpen && odds?.project === project && (
          <OddsPanel
            controller={odds.controller}
            canViewCosts={canViewCosts}
            currency={currency}
            onClose={() => setOddsOpen(false)}
            onReviewPayment={(gateId) => {
              const gate = project.taskStore.getById(gateId) as TaskModel | undefined;
              if (gate) callbacks.current.editTask(gate);
            }}
            onShowTask={(taskId) => {
              const instance = gantt();
              if (instance) revealTask(instance, taskId);
            }}
            chartSide={() => {
              // The board at hero size covers the chart's side: from the bars' region to the frame's right edge.
              const frame = mainRef.current;
              const side = (gantt() as unknown as { subGrids?: { normal?: { element?: HTMLElement } } } | undefined)?.subGrids?.normal?.element ?? null;
              return frame ? { frame, side } : null;
            }}
          />
        )}
      </div>
      {columnPanel?.kind === 'picker' && (
        <ColumnPicker
          layout={layout}
          access={access}
          onChange={updateLayout}
          onEdit={(columnId) => setColumnPanel({ kind: 'editor', columnId })}
          onClose={() => setColumnPanel(null)}
          grid={gantt()?.element}
          anchorColumnId={PICKER_COLUMN_ID}
        />
      )}
      {columnPanel?.kind === 'editor' && (
        <ColumnEditor
          key={columnPanel.columnId}
          columnId={columnPanel.columnId}
          layout={layout}
          onChange={updateLayout}
          onClose={() => setColumnPanel(null)}
          onShowAll={() => setColumnPanel({ kind: 'picker' })}
          grid={gantt()?.element}
        />
      )}
      {/* Crew workload and Crew schedule open from the View menu; nothing sits under the plan otherwise. */}
      {histogramOpen && (
        <section className={`collab-histogram-pane is-open is-${paneTab}`} aria-label="Crews">
          <header className="collab-pane-header">
            <div className="crew-pane-tabs" role="tablist" aria-label="Crew views">
              {CREW_PANE_TABS.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  className={`crew-pane-tab${paneTab === tab.id ? ' is-active' : ''}`}
                  aria-selected={paneTab === tab.id}
                  data-testid={`crew-pane-${tab.id}`}
                  onClick={() => {
                    setPaneTab(tab.id);
                    setHistogramOpen(true);
                  }}
                >
                  <i className={`fa fa-${tab.icon}`} aria-hidden="true" />
                  {tab.label}
                </button>
              ))}
            </div>
            <span className="collab-pane-hint">{CREW_PANE_TABS.find((tab) => tab.id === paneTab)?.hint}</span>
            <button
              type="button"
              className="button is-quiet is-sm is-icon crew-pane-close"
              aria-label="Close the crew view"
              title="Close (open it again from View)"
              data-testid="close-crew-pane"
              onClick={() => setHistogramOpen(false)}
            >
              <i className="fa fa-xmark" aria-hidden="true" />
            </button>
          </header>
          <div className="collab-histogram-host" ref={histogramHostRef} role="tabpanel" />
        </section>
      )}
    </div>
  );
}
