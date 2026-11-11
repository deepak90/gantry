/**
 * Presence on a Bryntum Gantt: reads and applies views for follow mode, turns the pointer into a
 * task-and-date position, and turns other people's positions back into points on this screen.
 *
 * Everything goes through task ids and dates, never pixels, so the other window's size, zoom,
 * column widths and scroll position do not matter. While grouped (by crew, status...) the Gantt shows
 * linked copies of tasks; ids are read from, and looked up through, the original records.
 */
import type { Gantt, Model, TaskModel } from '@bryntum/gantt';
import { isGeneratedParent, original } from '../gantt/look';
import type { ApplyOutcome } from './follow';
import { FramePlayback, blend, type MotionSample } from './follow-motion';
import {
  FRAME_INTERVAL_MS,
  fromLocalDateTime,
  lookKey,
  toLocalDateTime,
  type Activity,
  type CellRef,
  type CursorPoint,
  type RowCells,
  type ViewAnchor,
  type ViewBody,
  type ViewFrame,
  type ViewLook,
} from './protocol';
import type { PresenceViewport } from './session';

interface RowLike {
  id: string | number;
  top: number;
  height: number;
  getElement(region: string): HTMLElement | undefined;
  getCell(columnId: string): HTMLElement | undefined;
}

interface ScrollerLike {
  x: number;
  y: number;
  maxX?: number;
  maxY?: number;
  clientWidth: number;
  clientHeight: number;
  scrollTo(x: number | null, y: number | null, options?: { animate?: boolean }): Promise<unknown>;
}

interface RectLike {
  y: number;
  height: number;
}

interface ColumnLike {
  id: string | number;
  text?: string;
  hidden?: boolean;
  isTimeAxisColumn?: boolean;
}

/** A Bryntum GridLocation, as far as presence reads it. */
interface LocationLike {
  record?: Model;
  column?: ColumnLike;
  rowIndex?: number;
  columnIndex?: number;
}

/** The parts of Bryntum's Gantt (partly undocumented in the typings) this adapter uses. */
interface GanttInternals {
  element: HTMLElement;
  bodyContainer?: HTMLElement;
  project?: { taskStore: { getById(id: unknown): Model | undefined } };
  store: {
    getById(id: unknown): Model | undefined;
    find(fn: (record: Model) => boolean, searchAll?: boolean): Model | undefined;
    indexOf(record: Model): number;
    getAt(index: number): Model | undefined;
    sorters?: { field?: unknown; ascending?: boolean }[];
    sort?(sorters: object[]): unknown;
    clearSorters?(): void;
    traverse?(fn: (record: Model & { isLeaf?: boolean; isExpanded?(store: unknown): boolean }) => void): void;
    on?(config: Record<string, unknown>): () => void;
  };
  rowManager: {
    /** The rendered rows (a few beyond the visible ones). */
    rows?: RowLike[];
    getRowAt(y: number, local?: boolean): RowLike | undefined;
    getRowFor(record: Model): RowLike | undefined;
    getRecordCoords(record: Model, local?: boolean, roughly?: boolean): RectLike | null;
  };
  scrollable: ScrollerLike;
  timeAxisSubGrid: { element: HTMLElement; scrollable: ScrollerLike };
  subGrids: { locked?: { element: HTMLElement } };
  viewPreset?: { id?: string | number } | null;
  viewportCenterDate?: Date;
  timeAxisViewModel?: { tickSize?: number };
  startDate?: Date;
  endDate?: Date;
  toggleCollapse?(record: Model, collapse: boolean): Promise<unknown>;
  presets?: { getById(id: string): unknown };
  selectedRecords: Model[];
  selectedCells?: LocationLike[];
  focusedCell?: LocationLike | null;
  columns: { visibleColumns?: ColumnLike[]; getById(id: string): ColumnLike | undefined };
  isDestroyed?: boolean;
  getCoordinateFromDate(date: Date, local?: boolean): number;
  getDateFromCoordinate(coordinate: number, roundingMethod?: string | null, local?: boolean, allowOutOfRange?: boolean): Date | null;
  getDateFromDomEvent(event: Event, roundingMethod?: string | null, allowOutOfRange?: boolean): Date | null;
  getRecordFromElement(element: Element): Model | undefined;
  zoomTo(config: { preset: string; centerDate?: Date; width?: number; startDate?: Date; endDate?: Date }): void;
  scrollToDate(date: Date, options?: { block?: string; animate?: boolean }): Promise<unknown>;
  on(config: Record<string, unknown>): () => void;
}

/** Columns that hold no task data: the timeline (by type), and the "+" that opens the column selector. */
const NOT_DATA_COLUMNS = new Set(['column-picker']);

const internals = (gantt: Gantt) => gantt as unknown as GanttInternals;
const clamp01 = (value: number) => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.5);

/** The persisted id behind a shown row, or null for group rows and phantom records. */
function taskIdOf(record: Model | undefined): number | null {
  if (!record || isGeneratedParent(record)) return null;
  const id = original(record as TaskModel).id;
  return typeof id === 'number' ? id : null;
}

/** The name of a group row (while grouped), or null for anything else. */
function groupOf(record: Model | undefined): string | null {
  if (!record || !isGeneratedParent(record)) return null;
  const { key, name } = record as unknown as { key?: unknown; name?: unknown };
  const value = typeof key === 'string' && key ? key : typeof name === 'string' ? name : '';
  return value && value.length <= 120 ? value : null;
}

/** `t:215` for a task row, `g:Crane` for a group row, null for rows that mean nothing elsewhere. */
function rowKeyOf(record: Model): string | null {
  const group = groupOf(record);
  if (group !== null) return `g:${group}`;
  const id = taskIdOf(record);
  return id === null ? null : `t:${id}`;
}

/** The row that shows `taskId`: the task itself, or its linked copy while grouped. */
export function shownRecord(gantt: Gantt, taskId: number): Model | null {
  const g = internals(gantt);
  const direct = g.store.getById(taskId);
  if (direct && !isGeneratedParent(direct) && g.store.indexOf(direct) !== -1) return direct;
  const copy = g.store.find((record) => taskIdOf(record) === taskId, true);
  return copy && g.store.indexOf(copy) !== -1 ? copy : null;
}

/** The row an anchor names, when it is on screen in this plan (not filtered out or folded away). */
function anchorRecord(gantt: Gantt, anchor: ViewAnchor): Model | null {
  if ('taskId' in anchor) return shownRecord(gantt, anchor.taskId);
  const g = internals(gantt);
  const record = g.store.find((candidate) => groupOf(candidate) === anchor.group, true);
  return record && g.store.indexOf(record) !== -1 ? record : null;
}

function selectedIds(gantt: Gantt): number[] {
  const ids = new Set<number>();
  for (const record of internals(gantt).selectedRecords ?? []) {
    const id = taskIdOf(record);
    if (id !== null) ids.add(id);
  }
  return [...ids].slice(0, 50);
}

/**
 * How the toolbar draws the plan (grouping, colors, filters, search, critical path, planned dates).
 * The Gantt workspace owns these as React state and lends them to presence through this bridge.
 */
export type ToolbarLook = Omit<ViewLook, 'sort' | 'collapsed'>;

export interface LookBridge {
  read(): ToolbarLook;
  /** Shows the plan this way; resolves once it is regrouped and refiltered. */
  apply(look: ToolbarLook): Promise<void>;
  /** The toolbar look changed (by this person or by `apply`), after the plan settled. */
  onChange(listener: () => void): () => void;
}

/** The sort order and the folded rows, read from the Gantt. */
export function readTreeLook(gantt: Gantt): Pick<ViewLook, 'sort' | 'collapsed'> {
  const g = internals(gantt);
  const sort = (g.store.sorters ?? [])
    .filter((sorter): sorter is { field: string; ascending?: boolean } => typeof sorter.field === 'string' && sorter.field.length > 0 && sorter.field.length <= 64)
    .slice(0, 4)
    .map((sorter) => ({ field: sorter.field, ascending: sorter.ascending !== false }));
  const collapsed: string[] = [];
  g.store.traverse?.((record) => {
    if (collapsed.length >= 400 || record.isLeaf || record.isExpanded?.(g.store) !== false) return;
    const key = rowKeyOf(record);
    if (key) collapsed.push(key);
  });
  return { sort, collapsed };
}

/** Sorts and folds this plan's rows like `look`. Rows this plan does not have are left alone. */
export async function applyTreeLook(gantt: Gantt, look: Pick<ViewLook, 'sort' | 'collapsed'>): Promise<void> {
  const g = internals(gantt);
  if (g.isDestroyed) return;
  const current = readTreeLook(gantt);
  if (JSON.stringify(current.sort) !== JSON.stringify(look.sort)) {
    if (look.sort.length === 0) g.store.clearSorters?.();
    // `columnOwned` lets the sort feature use the column's own comparison, as a header click would.
    else await g.store.sort?.(look.sort.map((sorter) => ({ ...sorter, columnOwned: true })));
  }
  const fold = new Set(look.collapsed);
  const toggles: [Model, boolean][] = [];
  g.store.traverse?.((record) => {
    if (record.isLeaf) return;
    const key = rowKeyOf(record);
    if (!key) return;
    const collapsed = record.isExpanded?.(g.store) === false;
    if (fold.has(key) !== collapsed) toggles.push([record, fold.has(key)]);
  });
  for (const [record, collapse] of toggles) {
    if (g.isDestroyed) return;
    await g.toggleCollapse?.(record, collapse);
  }
}

/** What this Gantt shows: zoom level and span, the date and the row in the middle, the selection and the look. */
export function readView(gantt: Gantt, bridge?: LookBridge | null): ViewBody | null {
  const g = internals(gantt);
  if (g.isDestroyed || !g.element?.isConnected) return null;
  const preset = g.viewPreset?.id;
  const center = g.viewportCenterDate;
  if ((typeof preset !== 'string' && typeof preset !== 'number') || !(center instanceof Date) || Number.isNaN(center.getTime())) return null;
  const scroller = g.scrollable;
  const middle = scroller.y + scroller.clientHeight / 2;
  const row = g.rowManager.getRowAt(middle, true);
  const record = row ? g.store.getById(row.id) : undefined;
  const dy = row ? clamp01((middle - row.top) / (row.height || 1)) : 0.5;
  const taskId = taskIdOf(record);
  const group = groupOf(record);
  const anchor: ViewAnchor | null = taskId !== null ? { taskId, dy } : group !== null ? { group, dy } : null;
  const tick = g.timeAxisViewModel?.tickSize;
  const width = g.timeAxisSubGrid.scrollable.clientWidth;
  const view: ViewBody = {
    preset: String(preset),
    center: toLocalDateTime(center),
    anchor,
    selected: selectedIds(gantt),
  };
  if (typeof tick === 'number' && tick > 0 && width > 0) {
    view.tick = Math.round(tick * 100) / 100;
    view.width = Math.round(width);
  }
  if (g.startDate instanceof Date && g.endDate instanceof Date) {
    view.axisStart = toLocalDateTime(g.startDate);
    view.axisEnd = toLocalDateTime(g.endDate);
  }
  if (bridge) {
    const toolbar = bridge.read();
    view.look = { ...toolbar, search: toolbar.search.slice(0, 120), ...readTreeLook(gantt) };
  }
  return view;
}

/** Selects what the leader selected (in this plan's rows). */
function applySelection(gantt: Gantt, selected: readonly number[]): void {
  const g = internals(gantt);
  const wanted = selected.map((id) => shownRecord(gantt, id)).filter((record): record is Model => record !== null);
  const current = selectedIds(gantt);
  if (wanted.length !== current.length || wanted.some((record) => !current.includes(taskIdOf(record) ?? -1))) {
    g.selectedRecords = wanted;
  }
}

const NAVIGATION_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', 'Tab', 'Enter', ' ', '+', '-', '=']);

export interface GanttViewport extends PresenceViewport {
  dispose(): void;
}

/** How often a look already applied is checked again, in case this plan's rows changed under it. */
const LOOK_RECHECK_MS = 2_000;

/**
 * Follow mode's player on this Gantt. A frame first brings the look and the zoom in line (grouping,
 * filters, sort, folded rows; zoom level, tick width scaled to this window so the same span of time
 * fits, the same time axis), then hands its middle date and row to the playback, which this player
 * turns into scroll positions every screen frame.
 */
class FollowPlayer {
  private readonly playback = new FramePlayback({ intervalMs: FRAME_INTERVAL_MS });
  private raf = 0;
  private zoomKey = '';
  private lookBusy = false;
  private wantedLook: ViewLook | null = null;
  private appliedLook = { key: '', at: 0 };

  constructor(
    private readonly gantt: Gantt,
    private readonly bridge: LookBridge | null,
  ) {}

  apply(frame: ViewFrame): ApplyOutcome {
    const g = internals(this.gantt);
    if (g.isDestroyed) return 'missing-anchor';
    if (frame.look && this.bridge) this.takeLook(frame.look);
    if (this.matchZoom(frame)) this.playback.snap();
    const center = fromLocalDateTime(frame.center);
    if (center) {
      this.revealDate(center);
      this.playback.push({ t: frame.t, center: center.getTime(), anchor: frame.anchor }, Date.now());
    }
    this.kick();
    applySelection(this.gantt, frame.selected);
    return frame.anchor && !anchorRecord(this.gantt, frame.anchor) ? 'missing-anchor' : 'applied';
  }

  /** Shows `view` at once, look included (no playback): coming back to one's own view after following. */
  async jumpTo(view: ViewBody): Promise<void> {
    this.reset();
    if (view.look && this.bridge) {
      await this.bridge.apply(toolbarPart(view.look));
      await applyTreeLook(this.gantt, view.look);
    }
    this.jumpNow(view);
  }

  /** Shows `view`'s zoom, middle date, middle row and selection at once. */
  jumpNow(view: ViewBody): ApplyOutcome {
    const g = internals(this.gantt);
    if (g.isDestroyed) return 'missing-anchor';
    this.reset();
    this.matchZoom(view);
    const center = fromLocalDateTime(view.center);
    if (center) {
      this.revealDate(center);
      this.playback.push({ center: center.getTime(), anchor: view.anchor }, Date.now());
      this.draw(true);
    }
    this.playback.reset();
    applySelection(this.gantt, view.selected);
    return view.anchor && !anchorRecord(this.gantt, view.anchor) ? 'missing-anchor' : 'applied';
  }

  /** A date beyond this plan's time axis (an older sender without the axis): let Bryntum widen the axis to it. */
  private revealDate(date: Date): void {
    const g = internals(this.gantt);
    if (g.getCoordinateFromDate(date, true) < 0) void g.scrollToDate(date, { block: 'center', animate: false });
  }

  reset(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.playback.reset();
    this.zoomKey = '';
    this.wantedLook = null;
    this.appliedLook = { key: '', at: 0 };
  }

  private kick(): void {
    if (!this.raf) this.raf = requestAnimationFrame(this.loop);
  }

  private readonly loop = () => {
    this.raf = 0;
    if (internals(this.gantt).isDestroyed) return;
    if (!this.draw(false)) this.raf = requestAnimationFrame(this.loop);
  };

  /** Scrolls to where the playback is now; true once it reached the newest frame. */
  private draw(final: boolean): boolean {
    const g = internals(this.gantt);
    const point = this.playback.at(final ? Number.POSITIVE_INFINITY : Date.now());
    if (!point) return true;
    const timeline = g.timeAxisSubGrid.scrollable;
    const xOf = (sample: MotionSample) => {
      const x = g.getCoordinateFromDate(new Date(sample.center), true);
      return x >= 0 ? x - timeline.clientWidth / 2 : null;
    };
    const yOf = (sample: MotionSample) => {
      const record = sample.anchor ? anchorRecord(this.gantt, sample.anchor) : null;
      const coords = record ? g.rowManager.getRecordCoords(record, true, true) : null;
      return coords && sample.anchor ? coords.y + sample.anchor.dy * coords.height - g.scrollable.clientHeight / 2 : null;
    };
    const x = blend(xOf(point.from), xOf(point.to), point.f);
    const y = blend(yOf(point.from), yOf(point.to), point.f);
    if (x !== null) setScroll(timeline, 'x', x);
    if (y !== null) setScroll(g.scrollable, 'y', y);
    return point.settled;
  }

  /** Same zoom level, time axis and span of time on screen as the frame; true when it zoomed. */
  private matchZoom(view: ViewBody): boolean {
    const g = internals(this.gantt);
    const center = fromLocalDateTime(view.center);
    if (!center || !g.presets?.getById(view.preset)) return false;
    const width = g.timeAxisSubGrid.scrollable.clientWidth;
    const tick = view.tick && view.width && width > 0 ? Math.min(5_000, Math.max(2, (view.tick * width) / view.width)) : null;
    const start = view.axisStart ? fromLocalDateTime(view.axisStart) : null;
    const end = view.axisEnd ? fromLocalDateTime(view.axisEnd) : null;
    const axis = start && end && start < end ? { startDate: start, endDate: end } : null;
    // Asked once per distinct zoom: Bryntum may round the axis to whole ticks, which must not re-zoom every frame.
    const key = [view.preset, tick === null ? '' : Math.round(tick * 2) / 2, view.axisStart ?? '', view.axisEnd ?? ''].join('|');
    if (key === this.zoomKey) return false;
    this.zoomKey = key;
    const currentTick = g.timeAxisViewModel?.tickSize ?? 0;
    const same =
      String(g.viewPreset?.id) === view.preset &&
      (tick === null || Math.abs(currentTick - tick) < 0.5) &&
      (!axis || (g.startDate?.getTime() === axis.startDate.getTime() && g.endDate?.getTime() === axis.endDate.getTime()));
    if (same) return false;
    g.zoomTo({ preset: view.preset, ...(tick !== null ? { width: tick } : {}), ...(axis ?? {}), centerDate: center });
    return true;
  }

  /** Takes the leader's look unless this plan already shows it (re-checked now and then). */
  private takeLook(look: ViewLook): void {
    this.wantedLook = look;
    const key = lookKey(look);
    if (this.lookBusy || (key === this.appliedLook.key && Date.now() - this.appliedLook.at < LOOK_RECHECK_MS)) return;
    if (key === lookKey(this.currentLook())) {
      this.appliedLook = { key, at: Date.now() };
      return;
    }
    this.lookBusy = true;
    void (async () => {
      try {
        // Regrouping takes a moment; a newer look that arrived meanwhile is applied straight after.
        for (let pass = 0; pass < 3 && this.wantedLook; pass++) {
          const target = this.wantedLook;
          await this.bridge!.apply(toolbarPart(target));
          await applyTreeLook(this.gantt, target);
          this.appliedLook = { key: lookKey(target), at: Date.now() };
          if (this.wantedLook === target || lookKey(this.wantedLook) === lookKey(target)) break;
        }
      } catch (error) {
        console.warn('[presence] could not show the plan the way the leader does', error);
      } finally {
        this.lookBusy = false;
        // Rows moved under the playback: draw again where the leader's middle row now is.
        this.kick();
      }
    })();
  }

  private currentLook(): ViewLook | null {
    if (!this.bridge) return null;
    return { ...this.bridge.read(), ...readTreeLook(this.gantt) };
  }
}

/** Shows what a view shows, at once: same zoom and span of time, same date and row in the middle, same selection. */
export function applyView(gantt: Gantt, view: ViewBody): ApplyOutcome {
  return new FollowPlayer(gantt, null).jumpNow(view);
}

function toolbarPart(look: ViewLook): ToolbarLook {
  const { sort: _sort, collapsed: _collapsed, ...toolbar } = look;
  return toolbar;
}

/** Scrolls to a whole pixel within range, leaving the scroller alone when it is already there. */
function setScroll(scroller: ScrollerLike, axis: 'x' | 'y', value: number): void {
  const max = axis === 'x' ? scroller.maxX : scroller.maxY;
  const target = Math.round(Math.max(0, typeof max === 'number' && Number.isFinite(max) ? Math.min(max, value) : value));
  if (Math.abs(scroller[axis] - target) >= 1) scroller[axis] = target;
}

/**
 * The Gantt as a presence viewport. A change is any scroll inside it, a zoom, a selection, a fold, a
 * sort, a new look in the toolbar or a resize. Taking the controls is real input only (wheel, pointer
 * down, keys) anywhere in the plan's workspace, toolbar included; frames applied by follow mode scroll
 * programmatically and produce no input events, so they never end follow mode themselves.
 */
export function createGanttViewport(gantt: Gantt, bridge: LookBridge | null = null): GanttViewport {
  const g = internals(gantt);
  const element = g.element;
  const workspace = (element.closest('.collab-gantt-workspace') as HTMLElement | null) ?? element;
  const cleanups = new Set<() => void>();
  const player = new FollowPlayer(gantt, bridge);

  return {
    read: () => readView(gantt, bridge),
    apply: (frame) => player.apply(frame),
    reset: () => player.reset(),
    restore: (view) => player.jumpTo(view),
    onChange(listener) {
      let frame = 0;
      const notify = () => {
        if (frame) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          watchStore();
          listener();
        });
      };
      // The display store is replaced while grouping: its sort events are followed to the new one.
      let store: GanttInternals['store'] | null = null;
      let detachStore: (() => void) | null = null;
      const watchStore = () => {
        if (store === g.store || g.isDestroyed) return;
        detachStore?.();
        store = g.store;
        detachStore = store.on?.({ sort: notify }) ?? null;
      };
      watchStore();
      const detach = g.on({ presetChange: notify, selectionChange: notify, toggleNode: notify, toggleAllNodes: notify });
      const detachLook = bridge?.onChange(notify);
      element.addEventListener('scroll', notify, { capture: true, passive: true });
      const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(notify) : null;
      resize?.observe(element);
      resize?.observe(g.timeAxisSubGrid.element);
      const cleanup = () => {
        if (frame) cancelAnimationFrame(frame);
        detach?.();
        detachLook?.();
        detachStore?.();
        element.removeEventListener('scroll', notify, { capture: true });
        resize?.disconnect();
        cleanups.delete(cleanup);
      };
      cleanups.add(cleanup);
      return cleanup;
    },
    onUserNavigate(listener) {
      const navigate = () => listener('navigate');
      const onKey = (event: KeyboardEvent) => {
        if (event.key === 'Escape') listener('escape');
        else if (workspace.contains(event.target as Node) && (NAVIGATION_KEYS.has(event.key) || event.key.length === 1)) listener('navigate');
      };
      // Starting to edit anywhere but the header (the task panel, say) is taking over too: the
      // leader's selection would otherwise swap the task under the person typing.
      const onFocus = (event: FocusEvent) => {
        const target = event.target as HTMLElement | null;
        if (target?.closest?.('input, textarea, select, [contenteditable="true"]') && !target.closest('.app-header')) listener('navigate');
      };
      workspace.addEventListener('wheel', navigate, { passive: true });
      workspace.addEventListener('pointerdown', navigate);
      workspace.addEventListener('touchstart', navigate, { passive: true });
      document.addEventListener('keydown', onKey);
      document.addEventListener('focusin', onFocus);
      const cleanup = () => {
        workspace.removeEventListener('wheel', navigate);
        workspace.removeEventListener('pointerdown', navigate);
        workspace.removeEventListener('touchstart', navigate);
        document.removeEventListener('keydown', onKey);
        document.removeEventListener('focusin', onFocus);
        cleanups.delete(cleanup);
      };
      cleanups.add(cleanup);
      return cleanup;
    },
    dispose() {
      player.reset();
      for (const cleanup of [...cleanups]) cleanup();
    },
  };
}

/** Where the pointer is, as a task row and a date (timeline) or a column (grid); null off the rows. */
export function pointFromEvent(gantt: Gantt, event: PointerEvent): CursorPoint | null {
  const g = internals(gantt);
  const target = event.target instanceof Element ? event.target : null;
  if (!target || !g.element.contains(target)) return null;
  // Bars, links and labels are drawn on a canvas above the timeline rows, not inside them: the row is
  // the one under the pointer's height.
  if (g.timeAxisSubGrid.element.contains(target)) {
    const row = g.rowManager.getRowAt(event.clientY);
    const taskId = row ? taskIdOf(g.store.getById(row.id)) : null;
    const rowRect = row?.getElement('normal')?.getBoundingClientRect();
    if (taskId === null || !rowRect) return null;
    const date = g.getDateFromDomEvent(event, null, true);
    const dy = clamp01((event.clientY - rowRect.top) / (rowRect.height || 1));
    return date instanceof Date && !Number.isNaN(date.getTime()) ? { kind: 'timeline', taskId, date: toLocalDateTime(date), dy } : null;
  }
  const rowElement = target.closest('.b-grid-row');
  if (!rowElement || !g.element.contains(rowElement)) return null;
  const taskId = taskIdOf(g.getRecordFromElement(rowElement));
  if (taskId === null) return null;
  const rowRect = rowElement.getBoundingClientRect();
  const dy = clamp01((event.clientY - rowRect.top) / (rowRect.height || 1));
  const cell = target.closest('.b-grid-cell') as HTMLElement | null;
  const column = cell?.dataset.columnId;
  if (!cell || !column || NOT_DATA_COLUMNS.has(column)) return null;
  const cellRect = cell.getBoundingClientRect();
  return { kind: 'grid', taskId, column, dx: clamp01((event.clientX - cellRect.left) / (cellRect.width || 1)), dy };
}

/**
 * What a pointer at (clientX, clientY) is over, as `pointFromEvent` says it, worked out from the plan's
 * layout rather than from the element under it: for a hand that is not the mouse (page-local people,
 * crowd/in-page-team.ts), which a popover over the plan must not hide. Null off the plan's rows.
 */
export function pointAt(gantt: Gantt, clientX: number, clientY: number): CursorPoint | null {
  const g = internals(gantt);
  if (g.isDestroyed) return null;
  const body = rectOf(g.bodyContainer ?? g.element);
  if (!body || clientY < body.top || clientY >= body.bottom) return null;
  const row = g.rowManager.getRowAt(clientY);
  const taskId = row ? taskIdOf(g.store.getById(row.id)) : null;
  if (!row || taskId === null) return null;
  const timeline = rectOf(g.timeAxisSubGrid.element);
  if (timeline && clientX >= timeline.left && clientX < timeline.right) {
    const rowRect = rectOf(row.getElement('normal'));
    if (!rowRect) return null;
    const date = g.getDateFromCoordinate(clientX - timeline.left + g.timeAxisSubGrid.scrollable.x, null, true, true);
    const dy = clamp01((clientY - rowRect.top) / (rowRect.height || 1));
    return date instanceof Date && !Number.isNaN(date.getTime()) ? { kind: 'timeline', taskId, date: toLocalDateTime(date), dy } : null;
  }
  for (const column of dataColumns(gantt)) {
    const cell = rectOf(row.getCell(column));
    if (!cell || cell.width <= 0 || clientX < cell.left || clientX >= cell.right) continue;
    return { kind: 'grid', taskId, column, dx: clamp01((clientX - cell.left) / cell.width), dy: clamp01((clientY - cell.top) / (cell.height || 1)) };
  }
  return null;
}

/** Where the plan's rows (grid and timeline together) and its timeline are on the page, in client pixels. */
export function planRegions(gantt: Gantt): { rows: DOMRect; timeline: DOMRect } | null {
  const g = internals(gantt);
  if (g.isDestroyed) return null;
  const rows = rectOf(g.bodyContainer ?? g.element);
  const timeline = rectOf(g.timeAxisSubGrid.element);
  return rows && timeline && rows.width > 0 && rows.height > 0 ? { rows, timeline } : null;
}

/** The ids of the grid's columns that hold task data, left to right (no timeline, no column picker). */
export function dataColumns(gantt: Gantt): string[] {
  return (internals(gantt).columns.visibleColumns ?? [])
    .filter((column) => !column.hidden && !column.isTimeAxisColumn && !NOT_DATA_COLUMNS.has(String(column.id)))
    .map((column) => String(column.id));
}

/** A task's row as it shows now: where it is on the page, and what it is. */
export interface ShownRow {
  taskId: number;
  /** Client pixels. */
  top: number;
  height: number;
  leaf: boolean;
  /** The groups above it, nearest first. */
  parents: number[];
}

/** The rows wholly on screen now, top to bottom (group rows of a grouped plan left out). */
export function shownRows(gantt: Gantt): ShownRow[] {
  const g = internals(gantt);
  if (g.isDestroyed) return [];
  const body = rectOf(g.bodyContainer ?? g.element);
  if (!body || body.height <= 0) return [];
  const shown: ShownRow[] = [];
  for (const row of g.rowManager.rows ?? []) {
    const record = row.id === null || row.id === undefined ? undefined : g.store.getById(row.id);
    const taskId = taskIdOf(record);
    const rect = rectOf(row.getElement('locked') ?? row.getElement('normal'));
    if (taskId === null || !rect || rect.height <= 0 || rect.top < body.top - 1 || rect.bottom > body.bottom + 1) continue;
    const parents: number[] = [];
    let parent = (original(record as TaskModel) as TaskModel).parent as (TaskModel & { isRoot?: boolean }) | null | undefined;
    while (parent && !parent.isRoot) {
      if (typeof parent.id === 'number') parents.push(parent.id);
      parent = parent.parent as (TaskModel & { isRoot?: boolean }) | null | undefined;
    }
    shown.push({ taskId, top: rect.top, height: rect.height, leaf: Boolean((record as TaskModel).isLeaf), parents });
  }
  return shown.sort((a, b) => a.top - b.top);
}

/** Sends this tab's pointer while it moves over the plan, and "gone" when it leaves. */
export function captureCursor(gantt: Gantt, onPoint: (point: CursorPoint | null) => void): () => void {
  const element = internals(gantt).element;
  const move = (event: PointerEvent) => onPoint(pointFromEvent(gantt, event));
  // Onto the plan's own hover card, menu or popup: the person is still on that spot of the plan.
  const leave = (event: PointerEvent) => {
    const into = event.relatedTarget instanceof Element ? event.relatedTarget : null;
    if (!into?.closest('.b-float-root, .b-tooltip, .b-menu, .b-popup')) onPoint(null);
  };
  element.addEventListener('pointermove', move, { passive: true });
  element.addEventListener('pointerleave', leave);
  return () => {
    element.removeEventListener('pointermove', move);
    element.removeEventListener('pointerleave', leave);
    onPoint(null);
  };
}

export type Edge = 'above' | 'below' | 'left' | 'right';

export interface PlacedPoint {
  /** Relative to `layer`. */
  x: number;
  y: number;
  /** Set when the point is outside the visible plan: it is pinned to that edge. */
  edge: Edge | null;
  /** The task is folded away on this screen: the point sits on the nearest row that shows, inside which it is. */
  folded: boolean;
}

/** The nearest parent of a task that is a row on this screen (the task itself is folded away or filtered out). */
function shownAncestor(gantt: Gantt, taskId: number): Model | null {
  const g = internals(gantt);
  let parent = (g.project?.taskStore.getById(taskId) as (Model & { parent?: Model & { isRoot?: boolean } }) | undefined)?.parent;
  while (parent && !parent.isRoot) {
    const id = parent.id;
    const shown = typeof id === 'number' ? shownRecord(gantt, id) : null;
    if (shown) return shown;
    parent = (parent as Model & { parent?: Model & { isRoot?: boolean } }).parent;
  }
  return null;
}

function rectOf(element: Element | undefined | null): DOMRect | null {
  return element ? element.getBoundingClientRect() : null;
}

/**
 * A remote pointer on this screen, relative to `layer`; pinned to the edge (with `edge` set) when it
 * is scrolled out of view; null when its task is not in this plan's rows (filtered out, folded away).
 */
export function placePoint(gantt: Gantt, point: CursorPoint, layer: HTMLElement): PlacedPoint | null {
  const g = internals(gantt);
  if (g.isDestroyed) return null;
  const own = shownRecord(gantt, point.taskId);
  const record = own ?? shownAncestor(gantt, point.taskId);
  if (!record) return null;
  const folded = own === null;
  // Inside a folded row: on that row, half-way down.
  const dy = folded ? 0.5 : point.dy;
  const body = rectOf(g.bodyContainer ?? g.element);
  const region = rectOf(point.kind === 'timeline' ? g.timeAxisSubGrid.element : g.subGrids.locked?.element);
  if (!body || !region) return null;
  const row = g.rowManager.getRowFor(record);

  let y: number;
  if (row) {
    const rowRect = rectOf(row.getElement(point.kind === 'timeline' ? 'normal' : 'locked')) ?? rectOf(row.getElement('normal'));
    if (!rowRect) return null;
    y = rowRect.top + dy * rowRect.height;
  } else {
    const coords = g.rowManager.getRecordCoords(record, true, true);
    if (!coords) return null;
    y = body.top + coords.y - g.scrollable.y + dy * coords.height;
  }

  let x: number;
  if (point.kind === 'timeline') {
    const date = fromLocalDateTime(point.date);
    const local = date ? g.getCoordinateFromDate(date, true) : -1;
    if (local < 0) return null;
    x = region.left + local - g.timeAxisSubGrid.scrollable.x;
  } else {
    const cellRect = rectOf(row?.getCell(point.column));
    x = cellRect && cellRect.width > 0 ? cellRect.left + point.dx * cellRect.width : region.left + 24;
  }

  const top = Math.max(body.top, region.top);
  const bottom = Math.min(body.bottom, region.bottom);
  const edge: Edge | null = y < top ? 'above' : y > bottom ? 'below' : x < region.left ? 'left' : x > region.right ? 'right' : null;
  const layerRect = layer.getBoundingClientRect();
  return {
    x: Math.min(Math.max(x, region.left), region.right) - layerRect.left,
    y: Math.min(Math.max(y, top), bottom) - layerRect.top,
    edge,
    folded,
  };
}

/** The band of a task's row across the whole plan, relative to `layer`, or null when not on screen. */
export function placeRow(gantt: Gantt, taskId: number, layer: HTMLElement): { top: number; height: number; left: number; width: number } | null {
  const g = internals(gantt);
  if (g.isDestroyed) return null;
  const record = shownRecord(gantt, taskId);
  const row = record ? g.rowManager.getRowFor(record) : undefined;
  const rowRect = rectOf(row?.getElement('locked') ?? row?.getElement('normal'));
  const body = rectOf(g.bodyContainer ?? g.element);
  if (!rowRect || !body || rowRect.bottom <= body.top || rowRect.top >= body.bottom) return null;
  const layerRect = layer.getBoundingClientRect();
  const top = Math.max(rowRect.top, body.top);
  return { top: top - layerRect.top, height: Math.min(rowRect.bottom, body.bottom) - top, left: body.left - layerRect.left, width: body.width };
}

// -----------------------------------------------------------------------------------------
// Cell selection and what the person is doing
// -----------------------------------------------------------------------------------------

/** A grid cell (not the timeline) of a persisted task, as a shared reference. */
function cellOf(location: LocationLike | null | undefined): CellRef | null {
  const column = location?.column;
  if (!location || !column || column.isTimeAxisColumn || NOT_DATA_COLUMNS.has(String(column.id))) return null;
  const taskId = taskIdOf(location.record);
  return taskId === null ? null : { taskId, column: String(column.id) };
}

/** Groups cells by row, rows in this plan's order. */
function groupCells(gantt: Gantt, cells: readonly CellRef[]): RowCells[] {
  const g = internals(gantt);
  const byTask = new Map<number, string[]>();
  for (const cell of cells) {
    const columns = byTask.get(cell.taskId) ?? [];
    if (!columns.includes(cell.column)) columns.push(cell.column);
    byTask.set(cell.taskId, columns);
  }
  const order = (taskId: number) => {
    const record = shownRecord(gantt, taskId);
    return record ? g.store.indexOf(record) : Number.MAX_SAFE_INTEGER;
  };
  return [...byTask.entries()].sort((a, b) => order(a[0]) - order(b[0])).map(([taskId, columns]) => ({ taskId, columns }));
}

/** The cells selected in the grid and the cell the keyboard is on. */
export function readCellSelection(gantt: Gantt): { cells: RowCells[]; active: CellRef | null } {
  const g = internals(gantt);
  const cells = (g.selectedCells ?? []).map(cellOf).filter((cell): cell is CellRef => cell !== null);
  return { cells: groupCells(gantt, cells), active: cellOf(g.focusedCell) };
}

/** Reports the cell selection whenever it or the keyboard's cell changes (batched to a frame). */
export function captureSelection(gantt: Gantt, onChange: (selection: { cells: RowCells[]; active: CellRef | null }) => void): () => void {
  const g = internals(gantt);
  let frame = 0;
  const notify = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (!g.isDestroyed) onChange(readCellSelection(gantt));
    });
  };
  const detach = g.on({ selectionChange: notify, navigate: notify });
  notify();
  return () => {
    if (frame) cancelAnimationFrame(frame);
    detach?.();
  };
}

/**
 * The cells between two corners of a range, in this plan's rows and visible columns. A corner may sit
 * on a column without task data (the pointer runs along the edge of the "+" column): the range is
 * taken over all visible columns and those are left out.
 */
export function cellsBetween(gantt: Gantt, from: LocationLike, to: LocationLike): RowCells[] {
  const g = internals(gantt);
  const visible = g.columns.visibleColumns ?? [];
  const indexOf = (location: LocationLike) =>
    typeof location.columnIndex === 'number' ? location.columnIndex : visible.findIndex((column) => column === location.column || String(column.id) === String(location.column?.id));
  const [c1, c2] = [indexOf(from), indexOf(to)].sort((a, b) => a - b) as [number, number];
  const rowOf = (location: LocationLike) => (typeof location.rowIndex === 'number' ? location.rowIndex : location.record ? g.store.indexOf(location.record) : -1);
  const [r1, r2] = [rowOf(from), rowOf(to)].sort((a, b) => a - b) as [number, number];
  if (c1 < 0 || r1 < 0) return [];
  const columns = visible
    .slice(c1, c2 + 1)
    .filter((column) => !column.isTimeAxisColumn && !NOT_DATA_COLUMNS.has(String(column.id)))
    .map((column) => String(column.id));
  if (columns.length === 0) return [];
  const rows: RowCells[] = [];
  for (let index = r1; index <= r2 && rows.length < 300; index++) {
    const taskId = taskIdOf(g.store.getAt(index));
    if (taskId !== null) rows.push({ taskId, columns });
  }
  return rows;
}

type Slot = 'drag' | 'fill' | 'edit' | 'popup' | 'panel';
const SLOT_ORDER: readonly Slot[] = ['drag', 'fill', 'edit', 'popup', 'panel'];

/**
 * Reports what the person is doing in the plan: editing a cell (Bryntum's editor or one of the
 * popup editors of the collapsed cells), filling with the fill handle (with the cells it will write),
 * moving or resizing a bar, drawing a link, or typing in the task panel. The most hands-on one wins.
 */
export function captureActivity(gantt: Gantt, onActivity: (activity: Activity | null) => void): () => void {
  const g = internals(gantt);
  const slots = new Map<Slot, Activity | null>();
  /** When each slot was last set (performance clock). */
  const setAt = new Map<Slot, number>();
  let last: string | null = null;
  const emit = () => {
    const current = SLOT_ORDER.map((slot) => slots.get(slot)).find((activity): activity is Activity => Boolean(activity)) ?? null;
    const key = current ? JSON.stringify(current) : null;
    if (key === last) return;
    last = key;
    onActivity(current);
  };
  const set = (slot: Slot, activity: Activity | null) => {
    slots.set(slot, activity);
    setAt.set(slot, performance.now());
    emit();
  };
  // Bryntum swallows what its listeners throw: say it instead of losing the activity silently.
  const guard =
    (handler: (event: never) => void) =>
    (event: never): void => {
      try {
        handler(event);
      } catch (error) {
        console.warn('[presence] could not read the activity', error);
      }
    };
  const onTask = (kind: Activity['kind']) => (event: { taskRecord?: Model; taskRecords?: Model[]; source?: unknown }) =>
    set('drag', { kind, taskId: taskIdOf(event.taskRecord ?? event.taskRecords?.[0]), column: null });
  const focused = () => cellOf(g.focusedCell);

  const handlers: Record<string, (event: never) => void> = {
    startCellEdit: ({ editorContext }: { editorContext?: LocationLike }) => {
      const cell = cellOf(editorContext);
      set('edit', { kind: 'editing', taskId: cell?.taskId ?? null, column: cell?.column ?? null });
    },
    finishCellEdit: () => set('edit', null),
    cancelCellEdit: () => set('edit', null),
    fillHandleDragStart: () => {
      const cell = focused();
      set('fill', { kind: 'filling', taskId: cell?.taskId ?? null, column: cell?.column ?? null, cells: [] });
    },
    fillHandleDrag: ({ from, to }: { from?: LocationLike; to?: LocationLike }) => {
      const cell = focused();
      set('fill', { kind: 'filling', taskId: cell?.taskId ?? null, column: cell?.column ?? null, cells: from && to ? cellsBetween(gantt, from, to) : [] });
    },
    fillHandleDragEnd: () => set('fill', null),
    fillHandleDragAbort: () => set('fill', null),
    taskDragStart: onTask('moving'),
    taskDrop: () => set('drag', null),
    afterTaskDrop: () => set('drag', null),
    taskDragAbort: () => set('drag', null),
    taskResizeStart: onTask('resizing'),
    taskResizeEnd: () => set('drag', null),
    dependencyCreateDragStart: ({ source }: { source?: Model }) => set('drag', { kind: 'linking', taskId: taskIdOf(source), column: null }),
    afterDependencyCreateDrop: () => set('drag', null),
    dependencyCreateDrop: () => set('drag', null),
  };
  const detach = g.on(Object.fromEntries(Object.entries(handlers).map(([name, handler]) => [name, guard(handler)])));

  // A drag whose end event never came (dropped outside the plan) does not linger: what was started
  // before a pointer was released is over a moment later. A fill started after that release is not.
  let settle: ReturnType<typeof setTimeout> | null = null;
  const onPointerUp = () => {
    const releasedAt = performance.now();
    if (settle) clearTimeout(settle);
    settle = setTimeout(() => {
      settle = null;
      for (const slot of ['drag', 'fill'] as const) {
        if (slots.get(slot) && (setAt.get(slot) ?? 0) <= releasedAt) slots.set(slot, null);
      }
      emit();
    }, 400);
  };
  document.addEventListener('pointerup', onPointerUp, true);

  // The collapsed cells' popup editors are Bryntum popups of their own (cell-editors.ts).
  const popupTimer = setInterval(() => {
    const open = [...document.querySelectorAll<HTMLElement>('.look-editor')].some((element) => element.offsetParent !== null && !element.classList.contains('b-hidden'));
    const cell = open ? focused() : null;
    set('popup', open ? { kind: 'editing', taskId: cell?.taskId ?? null, column: cell?.column ?? null } : null);
  }, 300);

  // Typing in the task panel (its root carries the task id).
  const onFocusIn = (event: FocusEvent) => {
    const target = event.target as HTMLElement | null;
    const panel = target?.closest?.<HTMLElement>('[data-testid="task-inspector"][data-task-id]');
    if (!panel || !target?.closest('input, textarea, select, [contenteditable="true"]')) return;
    const id = Number(panel.dataset.taskId);
    set('panel', { kind: 'panel', taskId: Number.isInteger(id) ? id : null, column: null });
  };
  const onFocusOut = (event: FocusEvent) => {
    const next = event.relatedTarget as HTMLElement | null;
    if (!next?.closest?.('[data-testid="task-inspector"]')) set('panel', null);
  };
  document.addEventListener('focusin', onFocusIn);
  document.addEventListener('focusout', onFocusOut);

  return () => {
    detach?.();
    clearInterval(popupTimer);
    if (settle) clearTimeout(settle);
    document.removeEventListener('pointerup', onPointerUp, true);
    document.removeEventListener('focusin', onFocusIn);
    document.removeEventListener('focusout', onFocusOut);
    onActivity(null);
  };
}

export interface CellBox {
  left: number;
  top: number;
  width: number;
  height: number;
  /** Position in this plan's grid, to tell which neighbors are selected too. */
  row: number;
  col: number;
}

/** A grid cell on this screen, relative to `layer`, or null when it is not rendered (scrolled away, column hidden). */
export function placeCell(gantt: Gantt, cell: CellRef, layer: HTMLElement, layerRect = layer.getBoundingClientRect()): CellBox | null {
  const g = internals(gantt);
  if (g.isDestroyed) return null;
  const record = shownRecord(gantt, cell.taskId);
  const row = record ? g.rowManager.getRowFor(record) : undefined;
  const element = row?.getCell(cell.column);
  if (!record || !element) return null;
  const rect = element.getBoundingClientRect();
  const body = rectOf(g.bodyContainer ?? g.element);
  if (rect.width === 0 || !body || rect.bottom <= body.top || rect.top >= body.bottom) return null;
  const visible = g.columns.visibleColumns ?? [];
  return {
    left: rect.left - layerRect.left,
    top: rect.top - layerRect.top,
    width: rect.width,
    height: rect.height,
    row: g.store.indexOf(record),
    col: visible.findIndex((column) => String(column.id) === cell.column),
  };
}

/** The bar of a task on this screen, relative to `layer` (or to `layerRect`), or null when it is not drawn. */
export function placeBar(
  gantt: Gantt,
  taskId: number,
  layer: HTMLElement,
  layerRect: { left: number; top: number } = layer.getBoundingClientRect(),
): { left: number; top: number; width: number; height: number } | null {
  const g = internals(gantt);
  if (g.isDestroyed) return null;
  const bar = g.element.querySelector<HTMLElement>(`.b-gantt-task-wrap[data-task-id="${taskId}"] .b-gantt-task`);
  const rect = bar?.getBoundingClientRect();
  const timeline = rectOf(g.timeAxisSubGrid.element);
  const body = rectOf(g.bodyContainer ?? g.element);
  if (!rect || rect.width === 0 || !timeline || !body || rect.right < timeline.left || rect.left > timeline.right || rect.bottom < body.top || rect.top > body.bottom) return null;
  return { left: rect.left - layerRect.left, top: rect.top - layerRect.top, width: rect.width, height: rect.height };
}

/** The header text of a column in this plan, for "editing Schedule". */
export function columnLabel(gantt: Gantt, columnId: string): string | null {
  const column = internals(gantt).columns.getById(columnId);
  const text = column?.text?.replace(/<[^>]*>/g, '').trim();
  return text || null;
}
