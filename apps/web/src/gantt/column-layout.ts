/**
 * Which columns the Gantt grid shows, in what order, how wide, under which header and with which
 * alignment: one viewer's column layout. It is pure view state, never record data, so it is kept per
 * viewer in the browser (localStorage) and never travels as a revision.
 *
 * Everything here is a pure function over plain data; columns.ts turns a layout into Bryntum column
 * configs and applies it to a live column store. Money columns exist only for viewers who may see
 * costs: every function that takes `ColumnAccess` drops them for everyone else, so a stored layout
 * cannot smuggle a money column into a project manager's grid.
 */

export type ColumnGroup = 'schedule' | 'links' | 'people' | 'money' | 'other';
export type ColumnAlign = 'start' | 'center' | 'end';

export interface ColumnDefinition {
  id: string;
  /** Name in the column selector. */
  label: string;
  /** Default header text (the label when absent). */
  header?: string;
  /** One line under the label in the column selector. */
  hint?: string;
  group: ColumnGroup;
  /** Default width in pixels. */
  width: number;
  /** Narrowest width the column editor allows. */
  minWidth?: number;
  align?: ColumnAlign;
  /** Shows commercial figures: only built for, and only shown to, viewers who may see costs. */
  money?: boolean;
  /** The task column: always shown, always first. */
  fixed?: boolean;
}

/** What the viewer may see. */
export interface ColumnAccess {
  canViewCosts: boolean;
}

export interface ColumnLayout {
  /** Shown columns, left to right; the task column is always first. */
  readonly visible: readonly string[];
  /** Custom widths in pixels, kept while a column is hidden. */
  readonly widths: Readonly<Record<string, number>>;
  /** Custom header texts. */
  readonly titles: Readonly<Record<string, string>>;
  /** Custom alignments. */
  readonly aligns: Readonly<Record<string, ColumnAlign>>;
  /**
   * Largest share of the workspace the column region may take, when the viewer dragged the splitter
   * past the default share; absent means `DEFAULT_GRID_SHARE`.
   */
  readonly gridShare?: number;
}

export const TASK_COLUMN_ID = 'task';
export const MIN_COLUMN_WIDTH = 48;
export const MAX_COLUMN_WIDTH = 640;
export const MAX_TITLE_LENGTH = 60;
/** The column region is never narrower than this. */
export const MIN_GRID_WIDTH = 200;
/** Columns widen the region up to this share of the workspace; past it the task column gives way, then the region scrolls. */
export const DEFAULT_GRID_SHARE = 0.65;
/** Dragging the splitter can give the region up to this share. */
export const MAX_GRID_SHARE = 0.9;
/** Smallest share of the grid the task column keeps after a splitter drag (it scrolls below its min width). */
const MIN_TASK_SHARE = 24;

export const COLUMN_GROUPS: readonly { id: ColumnGroup; label: string }[] = [
  { id: 'schedule', label: 'Schedule' },
  { id: 'links', label: 'Links' },
  { id: 'people', label: 'People' },
  { id: 'money', label: 'Costs' },
  { id: 'other', label: 'Other' },
];

/** Every column the grid can show, in the order the selector lists them. */
export const COLUMN_CATALOG: readonly ColumnDefinition[] = [
  { id: TASK_COLUMN_ID, label: 'Task', group: 'other', width: 290, minWidth: 200, fixed: true },
  { id: 'schedule-crew', label: 'Crew', hint: 'Who does the work', group: 'people', width: 88 },
  { id: 'equipment', label: 'Equipment', hint: 'Rented equipment on the task, and when it is on site', group: 'people', width: 150 },
  { id: 'schedule-when', label: 'Schedule', hint: 'Dates, working days and progress in one', group: 'schedule', width: 214, minWidth: 160 },
  { id: 'start', label: 'Start', hint: 'First working day', group: 'schedule', width: 116 },
  { id: 'finish', label: 'Finish', hint: 'Last working day', group: 'schedule', width: 116 },
  { id: 'duration', label: 'Days', hint: 'Length in working days', group: 'schedule', width: 80 },
  { id: 'progress', label: 'Progress', hint: 'How much is done', group: 'schedule', width: 110 },
  { id: 'effort', label: 'Effort', hint: 'Hours of work in the task', group: 'schedule', width: 104 },
  { id: 'constraint-type', label: 'Constraint type', hint: 'Start no earlier than, finish no later than…', group: 'schedule', width: 160 },
  { id: 'constraint-date', label: 'Constraint date', hint: 'The date the constraint holds to', group: 'schedule', width: 116 },
  { id: 'deadline', label: 'Deadline', hint: 'Flagged when the finish goes past it', group: 'schedule', width: 116 },
  { id: 'manual', label: 'Manually scheduled', hint: 'Its links do not move it', group: 'schedule', width: 140, align: 'center' },
  { id: 'calendar', label: 'Calendar', hint: 'Which working days and hours apply', group: 'schedule', width: 130 },
  { id: 'scheduling-mode', label: 'Scheduling mode', hint: 'Fixed duration, fixed effort…', group: 'schedule', width: 140 },
  { id: 'total-slack', label: 'Total slack', hint: 'Float: how far it can slip without moving the handover', group: 'schedule', width: 90 },
  { id: 'early-start', label: 'Early start', hint: 'Earliest start the links allow', group: 'schedule', width: 116 },
  { id: 'early-finish', label: 'Early finish', hint: 'Earliest finish the links allow', group: 'schedule', width: 116 },
  { id: 'late-start', label: 'Late start', hint: 'Latest start that keeps the handover', group: 'schedule', width: 116 },
  { id: 'late-finish', label: 'Late finish', hint: 'Latest finish that keeps the handover', group: 'schedule', width: 116 },
  { id: 'predecessors', label: 'Waits for', hint: 'Tasks that come first', group: 'links', width: 120 },
  { id: 'successors', label: 'Leads to', hint: 'Tasks that wait for this one', group: 'links', width: 120 },
  { id: 'cost-plan', label: 'Budget · Forecast', hint: 'Forecast final cost against the budget', group: 'money', width: 170, minWidth: 120, align: 'end', money: true },
  { id: 'cost-actual', label: 'Spent · Paid', hint: 'Work done and money paid out', group: 'money', width: 170, minWidth: 120, align: 'end', money: true },
  { id: 'budget', label: 'Budget', hint: 'Agreed budget', group: 'money', width: 110, align: 'end', money: true },
  { id: 'expected', label: 'Forecast', hint: 'Forecast final cost', group: 'money', width: 110, align: 'end', money: true },
  { id: 'spent', label: 'Spent', hint: 'Value of the work done', group: 'money', width: 110, align: 'end', money: true },
  { id: 'paid', label: 'Paid', hint: 'Paid out through PayPal', group: 'money', width: 110, align: 'end', money: true },
  { id: 'cost-code', label: 'Cost code', hint: 'Line in the cost plan', group: 'money', width: 100, money: true },
  { id: 'wbs', label: 'Outline number', header: '#', hint: 'Position in the plan (WBS)', group: 'other', width: 64 },
  { id: 'notes', label: 'Notes', hint: 'Free text on the task', group: 'other', width: 200 },
  { id: 'milestone', label: 'Milestone', hint: 'A moment rather than work', group: 'other', width: 96, align: 'center' },
  { id: 'inactive', label: 'Inactive', hint: 'Left out of the schedule', group: 'other', width: 90, align: 'center' },
];

const BY_ID = new Map(COLUMN_CATALOG.map((column) => [column.id, column]));

/** Task, Crew and Schedule: what everyone sees first. */
export const DEFAULT_VISIBLE_COLUMNS: readonly string[] = [TASK_COLUMN_ID, 'schedule-crew', 'equipment', 'schedule-when'];

const ALIGNS: readonly ColumnAlign[] = ['start', 'center', 'end'];

export function columnDefinition(id: string): ColumnDefinition | undefined {
  return BY_ID.get(id);
}

/** Whether the viewer may have this column at all (it exists, and money only for cost viewers). */
export function isColumnAllowed(id: string, access: ColumnAccess): boolean {
  const definition = BY_ID.get(id);
  return definition !== undefined && (access.canViewCosts || !definition.money);
}

/** The columns this viewer can choose from, in catalog order. */
export function availableColumns(access: ColumnAccess): ColumnDefinition[] {
  return COLUMN_CATALOG.filter((column) => access.canViewCosts || !column.money);
}

export function defaultColumnLayout(): ColumnLayout {
  return { visible: [...DEFAULT_VISIBLE_COLUMNS], widths: {}, titles: {}, aligns: {} };
}

const clampWidth = (value: number, min: number) => Math.round(Math.min(MAX_COLUMN_WIDTH, Math.max(min, value)));
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const minWidthOf = (definition: ColumnDefinition) => definition.minWidth ?? MIN_COLUMN_WIDTH;

function withoutKey<T>(map: Readonly<Record<string, T>>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(map).filter(([entry]) => entry !== key));
}

/**
 * Any value (a parsed stored layout, a layout from an older build) as a valid layout for this viewer:
 * unknown ids, duplicates, money columns the viewer may not see and out-of-range values are dropped,
 * and the task column is put first. Values equal to the column's default are not kept.
 */
export function normalizeColumnLayout(value: unknown, access: ColumnAccess): ColumnLayout {
  if (!isRecord(value)) return defaultColumnLayout();
  const allowed = (id: unknown): id is string => typeof id === 'string' && isColumnAllowed(id, access);

  const visible = Array.isArray(value.visible)
    ? [TASK_COLUMN_ID, ...new Set(value.visible.filter(allowed).filter((id) => id !== TASK_COLUMN_ID))]
    : [...DEFAULT_VISIBLE_COLUMNS].filter((id) => isColumnAllowed(id, access));

  const widths: Record<string, number> = {};
  if (isRecord(value.widths)) {
    for (const [id, width] of Object.entries(value.widths)) {
      if (!allowed(id) || typeof width !== 'number' || !Number.isFinite(width)) continue;
      const definition = BY_ID.get(id)!;
      // The task column's share can be smaller than its min width after a splitter drag (it scrolls).
      const clamped = clampWidth(width, definition.fixed ? MIN_TASK_SHARE : minWidthOf(definition));
      if (clamped !== definition.width) widths[id] = clamped;
    }
  }

  const titles: Record<string, string> = {};
  if (isRecord(value.titles)) {
    for (const [id, title] of Object.entries(value.titles)) {
      if (!allowed(id) || typeof title !== 'string') continue;
      const text = cleanTitle(title);
      if (text && text !== defaultTitle(BY_ID.get(id)!)) titles[id] = text;
    }
  }

  const aligns: Record<string, ColumnAlign> = {};
  if (isRecord(value.aligns)) {
    for (const [id, align] of Object.entries(value.aligns)) {
      if (!allowed(id) || !ALIGNS.includes(align as ColumnAlign)) continue;
      if (align !== (BY_ID.get(id)!.align ?? 'start')) aligns[id] = align as ColumnAlign;
    }
  }

  const share = value.gridShare;
  const gridShare = typeof share === 'number' && share > DEFAULT_GRID_SHARE && share <= MAX_GRID_SHARE ? share : undefined;

  return gridShare === undefined ? { visible, widths, titles, aligns } : { visible, widths, titles, aligns, gridShare };
}

const cleanTitle = (title: string) => title.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_LENGTH);
const defaultTitle = (definition: ColumnDefinition) => definition.header ?? definition.label;

// -----------------------------------------------------------------------------------------
// Reading a layout
// -----------------------------------------------------------------------------------------

/** The column's width in this layout (its default unless changed). */
export function columnWidth(layout: ColumnLayout, id: string): number {
  return layout.widths[id] ?? BY_ID.get(id)?.width ?? MIN_COLUMN_WIDTH;
}

/** The header text in this layout (the default header unless renamed). */
export function columnTitle(layout: ColumnLayout, id: string): string {
  const definition = BY_ID.get(id);
  return layout.titles[id] ?? (definition ? defaultTitle(definition) : id);
}

/** The default header text of a column. */
export function defaultColumnTitle(id: string): string {
  const definition = BY_ID.get(id);
  return definition ? defaultTitle(definition) : id;
}

export function columnAlign(layout: ColumnLayout, id: string): ColumnAlign {
  return layout.aligns[id] ?? BY_ID.get(id)?.align ?? 'start';
}

/** Columns the viewer can choose from but does not show, in catalog order. */
export function hiddenColumns(layout: ColumnLayout, access: ColumnAccess): ColumnDefinition[] {
  return availableColumns(access).filter((column) => !layout.visible.includes(column.id));
}

/** Whether any money column is shown (bars then also carry the expected cost). */
export function hasVisibleMoneyColumn(layout: ColumnLayout): boolean {
  return layout.visible.some((id) => BY_ID.get(id)?.money === true);
}

export function isDefaultColumnLayout(layout: ColumnLayout): boolean {
  return (
    layout.visible.length === DEFAULT_VISIBLE_COLUMNS.length &&
    layout.visible.every((id, index) => id === DEFAULT_VISIBLE_COLUMNS[index]) &&
    Object.keys(layout.widths).length === 0 &&
    Object.keys(layout.titles).length === 0 &&
    Object.keys(layout.aligns).length === 0 &&
    layout.gridShare === undefined
  );
}

/** Whether a column matches the selector's search (its name, its header in this layout, its hint or its group). */
export function matchesColumnSearch(layout: ColumnLayout, definition: ColumnDefinition, query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const group = COLUMN_GROUPS.find((entry) => entry.id === definition.group)?.label ?? '';
  const haystack = [definition.label, columnTitle(layout, definition.id), definition.hint ?? '', group].join(' ').toLowerCase();
  return words.every((word) => haystack.includes(word));
}

interface GridSize {
  /** Width of the grid's own columns outside the layout (the selector's "+"). */
  extra?: number;
  /** Width of the workspace the grid and the timeline share; 0 or absent when not known yet. */
  workspaceWidth?: number;
}

/**
 * Width of the column region: the shown columns side by side (plus `extra`), bounded to a share of
 * the workspace (`gridShare`, else `DEFAULT_GRID_SHARE`), so adding columns widens the grid instead
 * of squashing it, until the timeline would get too little room.
 */
export function lockedGridWidth(layout: ColumnLayout, { extra = 0, workspaceWidth = 0 }: GridSize = {}): number {
  const content = layout.visible.reduce((sum, id) => sum + columnWidth(layout, id), extra);
  const max = workspaceWidth > 0 ? workspaceWidth * (layout.gridShare ?? DEFAULT_GRID_SHARE) : Number.POSITIVE_INFINITY;
  return Math.round(Math.max(MIN_GRID_WIDTH, Math.min(content, Math.max(max, MIN_GRID_WIDTH))));
}

// -----------------------------------------------------------------------------------------
// Changing a layout (each returns the same object when nothing changes)
// -----------------------------------------------------------------------------------------

/** Shows a column at the right end, or at `index` among the shown columns. */
export function showColumn(layout: ColumnLayout, id: string, access: ColumnAccess, index?: number): ColumnLayout {
  if (!isColumnAllowed(id, access) || layout.visible.includes(id)) return layout;
  const visible = [...layout.visible];
  const at = index === undefined ? visible.length : Math.max(1, Math.min(visible.length, Math.round(index)));
  visible.splice(at, 0, id);
  return { ...layout, visible };
}

/** Hides a column; the task column always stays. Width, header and alignment are kept for next time. */
export function hideColumn(layout: ColumnLayout, id: string): ColumnLayout {
  if (id === TASK_COLUMN_ID || !layout.visible.includes(id)) return layout;
  return { ...layout, visible: layout.visible.filter((visibleId) => visibleId !== id) };
}

/** Moves a shown column to `index` among the shown columns (never before the task column). */
export function moveColumn(layout: ColumnLayout, id: string, index: number): ColumnLayout {
  const from = layout.visible.indexOf(id);
  if (from < 1 || !Number.isFinite(index)) return layout;
  const to = Math.max(1, Math.min(layout.visible.length - 1, Math.round(index)));
  if (to === from) return layout;
  const visible = layout.visible.filter((visibleId) => visibleId !== id);
  visible.splice(to, 0, id);
  return { ...layout, visible };
}

/** Moves a shown column one or more places left (negative) or right (positive). */
export function moveColumnBy(layout: ColumnLayout, id: string, delta: number): ColumnLayout {
  const from = layout.visible.indexOf(id);
  return from < 1 ? layout : moveColumn(layout, id, from + delta);
}

/**
 * Takes the order of the shown columns from the grid (after a header drag): ids the layout does not
 * show are ignored, shown columns missing from `order` keep their place at the end, the task column
 * stays first.
 */
export function orderVisibleColumns(layout: ColumnLayout, order: readonly string[]): ColumnLayout {
  const shown = new Set(layout.visible);
  const ordered = [...new Set(order.filter((id) => shown.has(id) && id !== TASK_COLUMN_ID))];
  const rest = layout.visible.filter((id) => id !== TASK_COLUMN_ID && !ordered.includes(id));
  const visible = [TASK_COLUMN_ID, ...ordered, ...rest];
  return visible.every((id, index) => id === layout.visible[index]) ? layout : { ...layout, visible };
}

export function setColumnWidth(layout: ColumnLayout, id: string, width: number): ColumnLayout {
  const definition = BY_ID.get(id);
  if (!definition || !Number.isFinite(width)) return layout;
  const next = clampWidth(width, minWidthOf(definition));
  if (next === columnWidth(layout, id)) return layout;
  return { ...layout, widths: next === definition.width ? withoutKey(layout.widths, id) : { ...layout.widths, [id]: next } };
}

/**
 * After the splitter between grid and timeline is dragged: the task column takes whatever the other
 * shown columns (and `extra`) leave of the new grid width, and a drag past the default share of the
 * workspace raises the region's bound to it (up to `MAX_GRID_SHARE`).
 */
export function fitTaskColumnToGrid(layout: ColumnLayout, gridWidth: number, { extra = 0, workspaceWidth = 0 }: GridSize = {}): ColumnLayout {
  if (!Number.isFinite(gridWidth)) return layout;
  const others = layout.visible.reduce((sum, id) => (id === TASK_COLUMN_ID ? sum : sum + columnWidth(layout, id)), extra);
  const task = clampWidth(gridWidth - others, MIN_TASK_SHARE);
  const ratio = workspaceWidth > 0 ? Math.round((gridWidth / workspaceWidth) * 1000) / 1000 : null;
  const gridShare = ratio === null ? layout.gridShare : ratio > DEFAULT_GRID_SHARE ? Math.min(MAX_GRID_SHARE, ratio) : undefined;
  if (task === columnWidth(layout, TASK_COLUMN_ID) && gridShare === layout.gridShare) return layout;
  const { width } = BY_ID.get(TASK_COLUMN_ID)!;
  const widths = task === width ? withoutKey(layout.widths, TASK_COLUMN_ID) : { ...layout.widths, [TASK_COLUMN_ID]: task };
  const next = { visible: layout.visible, widths, titles: layout.titles, aligns: layout.aligns };
  return gridShare === undefined ? next : { ...next, gridShare };
}

/** Renames a column's header; an empty name (or the default) restores the default header. */
export function setColumnTitle(layout: ColumnLayout, id: string, title: string): ColumnLayout {
  const definition = BY_ID.get(id);
  if (!definition) return layout;
  const text = cleanTitle(title);
  if (!text || text === defaultTitle(definition)) {
    return id in layout.titles ? { ...layout, titles: withoutKey(layout.titles, id) } : layout;
  }
  return layout.titles[id] === text ? layout : { ...layout, titles: { ...layout.titles, [id]: text } };
}

export function setColumnAlign(layout: ColumnLayout, id: string, align: ColumnAlign): ColumnLayout {
  const definition = BY_ID.get(id);
  if (!definition || !ALIGNS.includes(align)) return layout;
  if (align === (definition.align ?? 'start')) {
    return id in layout.aligns ? { ...layout, aligns: withoutKey(layout.aligns, id) } : layout;
  }
  return layout.aligns[id] === align ? layout : { ...layout, aligns: { ...layout.aligns, [id]: align } };
}

export function resetColumnLayout(): ColumnLayout {
  return defaultColumnLayout();
}

// -----------------------------------------------------------------------------------------
// Persistence
// -----------------------------------------------------------------------------------------

const FORMAT_VERSION = 1;

export function serializeColumnLayout(layout: ColumnLayout): string {
  return JSON.stringify({ v: FORMAT_VERSION, visible: layout.visible, widths: layout.widths, titles: layout.titles, aligns: layout.aligns, gridShare: layout.gridShare });
}

/** A stored layout back, for this viewer; anything unreadable gives the default layout. */
export function parseColumnLayout(text: unknown, access: ColumnAccess): ColumnLayout {
  if (typeof text !== 'string' || text === '') return normalizeColumnLayout(null, access);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return normalizeColumnLayout(null, access);
  }
  if (!isRecord(value) || value.v !== FORMAT_VERSION) return normalizeColumnLayout(null, access);
  return normalizeColumnLayout(value, access);
}

/** One layout per viewer (and per browser). */
export function columnLayoutStorageKey(viewerKey: string): string {
  return `collab.gantt.columns.v${FORMAT_VERSION}:${viewerKey || 'default'}`;
}

type ReadableStorage = Pick<Storage, 'getItem'>;
type WritableStorage = Pick<Storage, 'setItem'>;

/** Reads the stored layout; a missing, blocked or throwing storage gives the default layout. */
export function loadColumnLayout(storage: ReadableStorage | null | undefined, key: string, access: ColumnAccess): ColumnLayout {
  let text: string | null = null;
  try {
    text = storage?.getItem(key) ?? null;
  } catch {
    text = null;
  }
  return parseColumnLayout(text, access);
}

/** Stores the layout; false when the storage is missing, full or blocked (the layout then lasts for this visit only). */
export function saveColumnLayout(storage: WritableStorage | null | undefined, key: string, layout: ColumnLayout): boolean {
  if (!storage) return false;
  try {
    storage.setItem(key, serializeColumnLayout(layout));
    return true;
  } catch {
    return false;
  }
}

/** `window.localStorage`, or null where reading it throws (blocked site data, sandboxed frames). */
export function browserStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}
