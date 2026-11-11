/**
 * The screen a simulated person "sees": the app's Gantt laid out in pixels the way a 1600 x 900 window
 * shows it with the default columns (Task, Crew, Equipment, Schedule, then the timeline at the day
 * zoom), rows in the plan's tree order with the folded phases folded. There is no DOM: the hand moves
 * in these pixels, and every position goes out as what it is over (a task and a column, or a task and
 * a date), so each viewer draws it on their own layout. Its scroll position is the view that follow
 * mode streams.
 */
import type { ProjectModel, TaskModel } from '@bryntum/gantt';
import { toLocalDateTime, type CursorPoint, type RowCells, type ViewBody, type ViewLook } from '../presence/protocol';
import type { Bounds, Vec } from './motion';
import { planClock } from '../plan-clock';

const DAY_MS = 86_400_000;

/** The default grid (column-layout.ts DEFAULT_VISIBLE_COLUMNS) at its default widths, then the column picker. */
export const SCREEN_COLUMNS: readonly { id: string; width: number }[] = [
  { id: 'task', width: 290 },
  { id: 'schedule-crew', width: 88 },
  { id: 'equipment', width: 128 },
  { id: 'schedule-when', width: 214 },
];
const PICKER_WIDTH = 40;
const SPLITTER = 6;

/**
 * The grid columns a viewer opening the project has, as the workspace shows them (Workspace.tsx,
 * `hideColumns`): a listed project with floors ("Level 1"... groups at the top) hides Equipment and
 * Schedule, another listed project hides Crew and Schedule, any other shows the default four. A pointer
 * over a column the viewer does not have is drawn at the edge of their grid, so a screen laid out like
 * theirs keeps the pointer where it looks right.
 */
export function viewerColumns(listed: boolean, topNames: readonly string[]): string[] {
  const floors = topNames.filter((name) => /^(level|floor)\s*\d+/i.test(name)).length >= 2;
  const hidden = !listed ? [] : floors ? ['equipment', 'schedule-when'] : ['schedule-crew', 'schedule-when'];
  return SCREEN_COLUMNS.map((column) => column.id).filter((id) => !hidden.includes(id));
}

/** The Gantt's own settings (GanttWorkspace: `collab-days`, 34 px a day, 46 px rows). */
export const SCREEN_PRESET = 'collab-days';
export const PX_PER_DAY = 34;
export const ROW_HEIGHT = 46;

export interface ScreenOptions {
  width?: number;
  height?: number;
  /** The grid's columns, in order (ids of SCREEN_COLUMNS, task first); default: all of them. */
  columns?: readonly string[];
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface TreeTask {
  id: unknown;
  isLeaf: boolean;
  children?: TreeTask[] | null;
  expanded?: boolean;
  startDate?: Date | null;
  endDate?: Date | null;
}

const numericId = (id: unknown): number | null => (typeof id === 'number' && Number.isInteger(id) && id >= 0 ? id : null);
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export class VirtualScreen {
  readonly width: number;
  readonly height: number;
  readonly rowHeight = ROW_HEIGHT;
  readonly pxPerDay = PX_PER_DAY;
  readonly columns: readonly { id: string; left: number; width: number }[];
  readonly gridWidth: number;
  readonly timelineLeft: number;
  /** Where the pointer can be: the rows of the plan, grid and timeline. */
  readonly bounds: Bounds;

  private rows: number[] = [];
  private index = new Map<number, number>();
  private folded = new Set<number>();
  private axisStart = new Date(2026, 0, 1);
  private axisEnd = new Date(2027, 0, 1);
  private scrollX = 0;
  private scrollY = 0;
  private selected: number | null = null;
  private dirty = true;
  private readonly listeners = new Set<() => void>();
  private readonly detach: () => void;

  constructor(
    private readonly project: ProjectModel,
    options: ScreenOptions = {},
  ) {
    this.width = options.width ?? 1600;
    this.height = options.height ?? 720;
    let left = 0;
    const shown = options.columns ? SCREEN_COLUMNS.filter((column) => options.columns!.includes(column.id)) : SCREEN_COLUMNS;
    this.columns = shown.map((column) => {
      const placed = { id: column.id, left, width: column.width };
      left += column.width;
      return placed;
    });
    this.gridWidth = left + PICKER_WIDTH;
    this.timelineLeft = this.gridWidth + SPLITTER;
    this.bounds = { left: 4, top: 2, right: this.width - 14, bottom: this.height - 4 };
    // The folds a fresh viewer starts with: the phases the seed folds.
    this.project.taskStore.traverse((record) => {
      const task = record as unknown as TreeTask;
      const id = numericId(task.id);
      if (id !== null && !task.isLeaf && task.expanded === false) this.folded.add(id);
    });
    const onChange = () => {
      this.dirty = true;
    };
    const store = this.project.taskStore as unknown as { on(config: object): () => void };
    this.detach = store.on({ change: onChange, refresh: onChange });
    this.refresh();
    this.scrollX = clamp(this.xOfDate(new Date(this.axisStart.getTime() + 7 * DAY_MS)) - 40, 0, this.maxScrollX());
  }

  dispose(): void {
    this.detach();
    this.listeners.clear();
  }

  /** Scroll or selection changed (follow mode streams it). */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private changed(): void {
    for (const listener of [...this.listeners]) listener();
  }

  /** Rows in tree order (folded phases hide their tasks), and the time axis around the project. */
  refresh(): void {
    if (!this.dirty) return;
    this.dirty = false;
    const rows: number[] = [];
    const visit = (nodes: readonly TreeTask[] | null | undefined) => {
      for (const node of nodes ?? []) {
        const id = numericId(node.id);
        if (id === null) continue;
        rows.push(id);
        if (!node.isLeaf && !this.folded.has(id)) visit(node.children);
      }
    };
    visit((this.project.taskStore.rootNode as unknown as TreeTask).children);
    this.rows = rows;
    this.index = new Map(rows.map((id, index) => [id, index]));
    const project = this.project as unknown as { startDate?: Date; endDate?: Date };
    const start = project.startDate instanceof Date ? project.startDate : planClock.now();
    const end = project.endDate instanceof Date ? project.endDate : new Date(start.getTime() + 90 * DAY_MS);
    // A week before the start to two weeks after the end, as the Gantt pads its axis.
    this.axisStart = new Date(start.getFullYear(), start.getMonth(), start.getDate() - 7);
    this.axisEnd = new Date(end.getFullYear(), end.getMonth(), end.getDate() + 14);
    this.scrollY = clamp(this.scrollY, 0, this.maxScrollY());
    this.scrollX = clamp(this.scrollX, 0, this.maxScrollX());
  }

  get rowIds(): readonly number[] {
    this.refresh();
    return this.rows;
  }

  get folds(): readonly number[] {
    return [...this.folded];
  }

  /** Unfolds the phases above a task, so its row shows. */
  reveal(taskId: number): void {
    let parent = (this.project.taskStore.getById(taskId) as TaskModel | undefined)?.parent as TaskModel | undefined;
    let changed = false;
    while (parent && !parent.isRoot) {
      const id = numericId(parent.id);
      if (id !== null && this.folded.delete(id)) changed = true;
      parent = parent.parent as TaskModel | undefined;
    }
    if (changed) {
      this.dirty = true;
      this.refresh();
      this.changed();
    }
  }

  get scroll(): Vec {
    return { x: this.scrollX, y: this.scrollY };
  }

  get timelineWidth(): number {
    return this.width - this.timelineLeft;
  }

  maxScrollX(): number {
    return Math.max(0, this.xOfDate(this.axisEnd) - this.timelineWidth);
  }

  maxScrollY(): number {
    return Math.max(0, this.rows.length * this.rowHeight - this.height);
  }

  setScroll(x: number, y: number): void {
    this.refresh();
    const nextX = clamp(x, 0, this.maxScrollX());
    const nextY = clamp(y, 0, this.maxScrollY());
    if (Math.abs(nextX - this.scrollX) < 0.01 && Math.abs(nextY - this.scrollY) < 0.01) return;
    this.scrollX = nextX;
    this.scrollY = nextY;
    this.changed();
  }

  setSelected(taskId: number | null): void {
    if (taskId === this.selected) return;
    this.selected = taskId;
    this.changed();
  }

  get selectedTask(): number | null {
    return this.selected;
  }

  /** Content x of a date on the timeline (0 at the axis start). */
  xOfDate(date: Date): number {
    return ((date.getTime() - this.axisStart.getTime()) / DAY_MS) * this.pxPerDay;
  }

  /** The date under a content x. */
  dateOfX(x: number): Date {
    return new Date(this.axisStart.getTime() + (x / this.pxPerDay) * DAY_MS);
  }

  /** Screen x of a date (may be outside the visible timeline). */
  screenXOfDate(date: Date): number {
    return this.timelineLeft + this.xOfDate(date) - this.scrollX;
  }

  rowOf(taskId: number): number {
    this.refresh();
    return this.index.get(taskId) ?? -1;
  }

  /** Screen y of the top of a task's row, or null when its row is not shown. */
  rowTop(taskId: number): number | null {
    const row = this.rowOf(taskId);
    return row < 0 ? null : row * this.rowHeight - this.scrollY;
  }

  column(id: string): { id: string; left: number; width: number } | undefined {
    return this.columns.find((column) => column.id === id);
  }

  /** A grid cell on this screen (it may be scrolled out of view), or null when its row is not shown. */
  cellRect(taskId: number, columnId: string): Rect | null {
    const top = this.rowTop(taskId);
    const column = this.column(columnId);
    if (top === null || !column) return null;
    return { x: column.left, y: top, width: column.width, height: this.rowHeight };
  }

  /** The task's bar on this screen: from its start to its end, at its row's height. */
  barRect(task: TaskModel): Rect | null {
    const id = numericId(task.id);
    const top = id === null ? null : this.rowTop(id);
    if (top === null || !(task.startDate instanceof Date) || !(task.endDate instanceof Date)) return null;
    const x0 = this.screenXOfDate(task.startDate);
    const x1 = this.screenXOfDate(task.endDate);
    return { x: x0, y: top + 9, width: Math.max(4, x1 - x0), height: this.rowHeight - 18 };
  }

  /** Whether a screen point is inside the visible plan. */
  inView(point: Vec): boolean {
    return point.x >= this.bounds.left && point.x <= this.bounds.right && point.y >= this.bounds.top && point.y <= this.bounds.bottom;
  }

  /** The scroll that shows `taskId`'s row comfortably (and, when given, the dates `from`..`to`); the current one when it already shows. */
  scrollToShow(taskId: number, dates?: { from: Date; to: Date }): Vec {
    this.refresh();
    let { x, y } = this.scroll;
    const row = this.rowOf(taskId);
    if (row >= 0) {
      const top = row * this.rowHeight;
      const margin = this.rowHeight * 2;
      if (top < this.scrollY + margin || top + this.rowHeight > this.scrollY + this.height - margin) {
        // Not at the very edge: people scroll a target to somewhere in the upper middle.
        y = top - this.height * 0.4;
      }
    }
    if (dates) {
      const from = this.xOfDate(dates.from);
      const to = this.xOfDate(dates.to);
      const margin = this.pxPerDay * 3;
      if (from < this.scrollX + margin || to > this.scrollX + this.timelineWidth - margin) {
        x = (from + to) / 2 - this.timelineWidth * 0.45;
      }
    }
    return { x: clamp(x, 0, this.maxScrollX()), y: clamp(y, 0, this.maxScrollY()) };
  }

  /** What a screen point is over, as presence sends it: a task and a column, or a task and a date. */
  pointAt(point: Vec): CursorPoint | null {
    this.refresh();
    if (!this.inView(point)) return null;
    const rowPosition = (this.scrollY + point.y) / this.rowHeight;
    const taskId = this.rows[Math.floor(rowPosition)];
    if (taskId === undefined) return null;
    const dy = clamp(rowPosition - Math.floor(rowPosition), 0, 1);
    if (point.x >= this.timelineLeft) {
      const date = this.dateOfX(this.scrollX + point.x - this.timelineLeft);
      if (date < this.axisStart || date > this.axisEnd) return null;
      return { kind: 'timeline', taskId, date: toLocalDateTime(date), dy };
    }
    const column = this.columns.find((candidate) => point.x >= candidate.left && point.x < candidate.left + candidate.width);
    // Over the column picker or the splitter: nothing with data under it.
    if (!column) return null;
    return { kind: 'grid', taskId, column: column.id, dx: clamp((point.x - column.left) / column.width, 0, 1), dy };
  }

  /** The look a fresh viewer has (GanttWorkspace's defaults), with this screen's folds. */
  look(): ViewLook {
    return {
      groupBy: 'phase',
      colorBy: 'phase',
      filter: 'all',
      search: '',
      criticalPath: false,
      planned: true,
      sort: [],
      collapsed: [...this.folded].map((id) => `t:${id}`).slice(0, 400),
      attentionCosts: false,
    };
  }

  /** The view as a follower takes it: the zoom, the date and row in the middle, the selection and the look. */
  view(): ViewBody {
    this.refresh();
    const middle = this.scrollY + this.height / 2;
    const row = Math.min(this.rows.length - 1, Math.floor(middle / this.rowHeight));
    const taskId = this.rows[Math.max(0, row)];
    return {
      preset: SCREEN_PRESET,
      center: toLocalDateTime(this.dateOfX(this.scrollX + this.timelineWidth / 2)),
      anchor: taskId === undefined ? null : { taskId, dy: clamp(middle / this.rowHeight - row, 0, 1) },
      selected: this.selected === null ? [] : [this.selected],
      look: this.look(),
    };
  }
}

/** One selected cell, as presence shares a selection. */
export function singleCell(taskId: number, column: string): RowCells[] {
  return [{ taskId, columns: [column] }];
}
