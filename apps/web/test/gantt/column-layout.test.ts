import { describe, expect, it } from 'vitest';
import {
  COLUMN_CATALOG,
  DEFAULT_GRID_SHARE,
  DEFAULT_VISIBLE_COLUMNS,
  MAX_COLUMN_WIDTH,
  MAX_GRID_SHARE,
  MAX_TITLE_LENGTH,
  MIN_COLUMN_WIDTH,
  MIN_GRID_WIDTH,
  TASK_COLUMN_ID,
  availableColumns,
  columnAlign,
  columnLayoutStorageKey,
  columnTitle,
  columnWidth,
  defaultColumnLayout,
  fitTaskColumnToGrid,
  hasVisibleMoneyColumn,
  hiddenColumns,
  hideColumn,
  isColumnAllowed,
  isDefaultColumnLayout,
  loadColumnLayout,
  lockedGridWidth,
  matchesColumnSearch,
  moveColumn,
  moveColumnBy,
  normalizeColumnLayout,
  orderVisibleColumns,
  parseColumnLayout,
  resetColumnLayout,
  saveColumnLayout,
  serializeColumnLayout,
  setColumnAlign,
  setColumnTitle,
  setColumnWidth,
  showColumn,
  type ColumnLayout,
} from '../../src/gantt/column-layout';
import { PICKER_COLUMN_ID, applyColumnLayout, buildGanttColumns, visibleColumnOrder, type LiveColumn, type LiveColumnStore } from '../../src/gantt/columns';

const CM = { canViewCosts: true };
const PM = { canViewCosts: false };
const MONEY_IDS = COLUMN_CATALOG.filter((column) => column.money).map((column) => column.id);

const layoutWith = (visible: string[], rest: Partial<ColumnLayout> = {}): ColumnLayout => ({ ...defaultColumnLayout(), visible, ...rest });

describe('the column catalog', () => {
  it('has unique ids, the task column first and fixed, and money columns flagged', () => {
    const ids = COLUMN_CATALOG.map((column) => column.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(COLUMN_CATALOG[0]).toMatchObject({ id: TASK_COLUMN_ID, fixed: true });
    expect(MONEY_IDS).toEqual(['cost-plan', 'cost-actual', 'budget', 'expected', 'spent', 'paid', 'cost-code']);
    for (const column of COLUMN_CATALOG) {
      expect(column.width).toBeGreaterThanOrEqual(column.minWidth ?? MIN_COLUMN_WIDTH);
    }
  });

  it('offers money columns to cost viewers only', () => {
    expect(availableColumns(CM).map((column) => column.id)).toEqual(expect.arrayContaining(MONEY_IDS));
    expect(availableColumns(PM).some((column) => column.money)).toBe(false);
    expect(isColumnAllowed('cost-plan', PM)).toBe(false);
    expect(isColumnAllowed('cost-plan', CM)).toBe(true);
    expect(isColumnAllowed('no-such-column', CM)).toBe(false);
  });
});

describe('defaults', () => {
  it('shows Task, Crew, Equipment and Schedule for everyone, with default widths, headers and alignment', () => {
    const layout = defaultColumnLayout();
    expect(layout.visible).toEqual(['task', 'schedule-crew', 'equipment', 'schedule-when']);
    expect(DEFAULT_VISIBLE_COLUMNS).toEqual(layout.visible);
    expect(isDefaultColumnLayout(layout)).toBe(true);
    expect(columnTitle(layout, 'duration')).toBe('Days');
    expect(columnTitle(layout, 'wbs')).toBe('#');
    expect(columnWidth(layout, 'schedule-when')).toBe(214);
    expect(columnAlign(layout, 'budget')).toBe('end');
    expect(columnAlign(layout, 'start')).toBe('start');
    expect(hasVisibleMoneyColumn(layout)).toBe(false);
  });

  it('lists what is not shown, in catalog order', () => {
    const hidden = hiddenColumns(defaultColumnLayout(), PM).map((column) => column.id);
    expect(hidden[0]).toBe('start');
    expect(hidden).not.toContain('task');
    expect(hidden).not.toContain('cost-plan');
  });
});

describe('showing and hiding', () => {
  it('appends a shown column at the right end, or at an index after the task column', () => {
    const layout = showColumn(defaultColumnLayout(), 'start', PM);
    expect(layout.visible).toEqual(['task', 'schedule-crew', 'equipment', 'schedule-when', 'start']);
    expect(showColumn(layout, 'finish', PM, 0).visible).toEqual(['task', 'finish', 'schedule-crew', 'equipment', 'schedule-when', 'start']);
    expect(showColumn(layout, 'finish', PM, 2).visible).toEqual(['task', 'schedule-crew', 'finish', 'equipment', 'schedule-when', 'start']);
  });

  it('returns the same layout when nothing changes', () => {
    const layout = defaultColumnLayout();
    expect(showColumn(layout, 'schedule-crew', PM)).toBe(layout);
    expect(showColumn(layout, 'nope', CM)).toBe(layout);
    expect(hideColumn(layout, 'start')).toBe(layout);
  });

  it('never shows a money column to a viewer who cannot see costs', () => {
    const layout = defaultColumnLayout();
    expect(showColumn(layout, 'cost-plan', PM)).toBe(layout);
    expect(showColumn(layout, 'budget', PM)).toBe(layout);
    const cm = showColumn(layout, 'cost-plan', CM);
    expect(cm.visible).toContain('cost-plan');
    expect(hasVisibleMoneyColumn(cm)).toBe(true);
  });

  it('never hides the task column', () => {
    const layout = defaultColumnLayout();
    expect(hideColumn(layout, TASK_COLUMN_ID)).toBe(layout);
  });

  it('shows and hides again, and keeps a hidden column’s width, header and alignment for next time', () => {
    let layout = showColumn(defaultColumnLayout(), 'notes', PM);
    layout = setColumnWidth(layout, 'notes', 260);
    layout = setColumnTitle(layout, 'notes', 'Site notes');
    layout = setColumnAlign(layout, 'notes', 'center');
    layout = hideColumn(layout, 'notes');
    expect(layout.visible).not.toContain('notes');
    layout = showColumn(layout, 'notes', PM);
    expect(columnWidth(layout, 'notes')).toBe(260);
    expect(columnTitle(layout, 'notes')).toBe('Site notes');
    expect(columnAlign(layout, 'notes')).toBe('center');
  });
});

describe('reordering', () => {
  const four = layoutWith(['task', 'schedule-crew', 'schedule-when', 'start']);

  it('moves a column to an index, never before the task column', () => {
    expect(moveColumn(four, 'start', 1).visible).toEqual(['task', 'start', 'schedule-crew', 'schedule-when']);
    expect(moveColumn(four, 'start', 0).visible).toEqual(['task', 'start', 'schedule-crew', 'schedule-when']);
    expect(moveColumn(four, 'schedule-crew', 99).visible).toEqual(['task', 'schedule-when', 'start', 'schedule-crew']);
    expect(moveColumn(four, TASK_COLUMN_ID, 2)).toBe(four);
    expect(moveColumn(four, 'finish', 1)).toBe(four);
    expect(moveColumn(four, 'start', 3)).toBe(four);
    expect(moveColumn(four, 'start', Number.NaN)).toBe(four);
  });

  it('moves a column left and right one place at a time', () => {
    expect(moveColumnBy(four, 'schedule-when', -1).visible).toEqual(['task', 'schedule-when', 'schedule-crew', 'start']);
    expect(moveColumnBy(four, 'schedule-when', 1).visible).toEqual(['task', 'schedule-crew', 'start', 'schedule-when']);
    expect(moveColumnBy(four, 'schedule-crew', -1)).toBe(four);
    expect(moveColumnBy(four, 'start', 1)).toBe(four);
  });

  it('takes the order from the grid after a header drag, keeping the task column first', () => {
    expect(orderVisibleColumns(four, ['start', 'task', 'schedule-crew', 'schedule-when']).visible).toEqual(['task', 'start', 'schedule-crew', 'schedule-when']);
    // Ids the layout does not show are ignored; shown ids the grid left out stay, at the end.
    expect(orderVisibleColumns(four, ['schedule-when', 'notes', 'schedule-when']).visible).toEqual(['task', 'schedule-when', 'schedule-crew', 'start']);
    expect(orderVisibleColumns(four, ['task', 'schedule-crew', 'schedule-when', 'start'])).toBe(four);
  });
});

describe('widths, headers and alignment', () => {
  it('clamps widths and forgets a width equal to the default', () => {
    const layout = defaultColumnLayout();
    expect(columnWidth(setColumnWidth(layout, 'schedule-crew', 120.4), 'schedule-crew')).toBe(120);
    expect(columnWidth(setColumnWidth(layout, 'schedule-crew', 1), 'schedule-crew')).toBe(MIN_COLUMN_WIDTH);
    expect(columnWidth(setColumnWidth(layout, 'schedule-crew', 99_999), 'schedule-crew')).toBe(MAX_COLUMN_WIDTH);
    expect(columnWidth(setColumnWidth(layout, 'schedule-when', 10), 'schedule-when')).toBe(160);
    expect(setColumnWidth(layout, 'schedule-crew', 88)).toBe(layout);
    expect(setColumnWidth(setColumnWidth(layout, 'schedule-crew', 120), 'schedule-crew', 88).widths).toEqual({});
    expect(setColumnWidth(layout, 'schedule-crew', Number.NaN)).toBe(layout);
    expect(setColumnWidth(layout, 'nope', 100)).toBe(layout);
  });

  it('renames a header, and an empty or default name restores the default', () => {
    let layout = setColumnTitle(defaultColumnLayout(), 'schedule-crew', '  Who   does it ');
    expect(columnTitle(layout, 'schedule-crew')).toBe('Who does it');
    expect(setColumnTitle(layout, 'schedule-crew', 'Who does it')).toBe(layout);
    layout = setColumnTitle(layout, 'schedule-crew', '   ');
    expect(columnTitle(layout, 'schedule-crew')).toBe('Crew');
    expect(layout.titles).toEqual({});
    expect(setColumnTitle(defaultColumnLayout(), 'duration', 'Days').titles).toEqual({});
    expect(columnTitle(setColumnTitle(defaultColumnLayout(), 'notes', 'x'.repeat(200)), 'notes')).toHaveLength(MAX_TITLE_LENGTH);
  });

  it('aligns a column and forgets the default alignment', () => {
    const layout = setColumnAlign(defaultColumnLayout(), 'budget', 'start');
    expect(columnAlign(layout, 'budget')).toBe('start');
    expect(setColumnAlign(layout, 'budget', 'end').aligns).toEqual({});
    expect(setColumnAlign(layout, 'budget', 'sideways' as never)).toBe(layout);
  });

  it('resets to the default layout', () => {
    const changed = setColumnTitle(setColumnWidth(showColumn(defaultColumnLayout(), 'notes', PM), 'notes', 300), 'task', 'Activity');
    expect(isDefaultColumnLayout(changed)).toBe(false);
    expect(resetColumnLayout()).toEqual(defaultColumnLayout());
  });
});

describe('the width of the column region', () => {
  it('is the shown columns side by side, plus the selector column, bounded by the workspace share', () => {
    const layout = defaultColumnLayout();
    expect(lockedGridWidth(layout)).toBe(290 + 88 + 150 + 214);
    expect(lockedGridWidth(layout, { extra: 40 })).toBe(782);
    // Adding a column widens the region rather than squashing the others ...
    expect(lockedGridWidth(showColumn(layout, 'start', PM), { extra: 40, workspaceWidth: 2000 })).toBe(782 + 116);
    // ... up to the default share, past which the task column gives way and the region scrolls.
    expect(lockedGridWidth(showColumn(layout, 'start', PM), { extra: 40, workspaceWidth: 1000 })).toBe(1000 * DEFAULT_GRID_SHARE);
    expect(lockedGridWidth(layoutWith(['task'], { widths: { task: 30 } }), { workspaceWidth: 100 })).toBe(MIN_GRID_WIDTH);
  });

  it('gives the task column what a splitter drag leaves of the region', () => {
    const layout = defaultColumnLayout();
    const wider = fitTaskColumnToGrid(layout, 700, { extra: 40, workspaceWidth: 2000 });
    expect(columnWidth(wider, TASK_COLUMN_ID)).toBe(700 - 40 - 88 - 150 - 214);
    expect(wider.gridShare).toBeUndefined();
    expect(lockedGridWidth(wider, { extra: 40, workspaceWidth: 2000 })).toBe(700);
    // Narrower than the task column's minimum: the region keeps the dragged width (the grid scrolls).
    const narrow = fitTaskColumnToGrid(layoutWith(['task', 'schedule-crew', 'schedule-when']), 400, { extra: 40 });
    expect(lockedGridWidth(narrow, { extra: 40 })).toBe(400);
    expect(fitTaskColumnToGrid(layout, 782, { extra: 40 })).toBe(layout);
    expect(fitTaskColumnToGrid(layout, Number.NaN)).toBe(layout);
  });

  it('raises the bound when the splitter is dragged past the default share, and lowers it again', () => {
    const many = showColumn(showColumn(defaultColumnLayout(), 'start', PM), 'finish', PM);
    expect(lockedGridWidth(many, { extra: 40, workspaceWidth: 1000 })).toBe(1000 * DEFAULT_GRID_SHARE);
    const dragged = fitTaskColumnToGrid(many, 800, { extra: 40, workspaceWidth: 1000 });
    expect(dragged.gridShare).toBe(0.8);
    expect(lockedGridWidth(dragged, { extra: 40, workspaceWidth: 1000 })).toBe(800);
    // A wider workspace keeps the columns' own width (no stretching to the share).
    expect(lockedGridWidth(dragged, { extra: 40, workspaceWidth: 2000 })).toBe(800);
    expect(fitTaskColumnToGrid(many, 990, { extra: 40, workspaceWidth: 1000 }).gridShare).toBe(MAX_GRID_SHARE);
    const back = fitTaskColumnToGrid(dragged, 500, { extra: 40, workspaceWidth: 1000 });
    expect(back.gridShare).toBeUndefined();
    expect(isDefaultColumnLayout(dragged)).toBe(false);
    expect(parseColumnLayout(serializeColumnLayout(dragged), PM)).toEqual(dragged);
    expect(normalizeColumnLayout({ ...dragged, gridShare: 3 }, PM).gridShare).toBeUndefined();
    expect(normalizeColumnLayout({ ...dragged, gridShare: 0.1 }, PM).gridShare).toBeUndefined();
  });
});

describe('search', () => {
  it('matches the name, the renamed header, the hint and the group', () => {
    const layout = setColumnTitle(defaultColumnLayout(), 'notes', 'Daily log');
    const notes = COLUMN_CATALOG.find((column) => column.id === 'notes')!;
    const float = COLUMN_CATALOG.find((column) => column.id === 'total-slack')!;
    expect(matchesColumnSearch(layout, notes, '')).toBe(true);
    expect(matchesColumnSearch(layout, notes, 'NOTES')).toBe(true);
    expect(matchesColumnSearch(layout, notes, 'daily')).toBe(true);
    expect(matchesColumnSearch(layout, float, 'slip handover')).toBe(true);
    expect(matchesColumnSearch(layout, float, 'schedule')).toBe(true);
    expect(matchesColumnSearch(layout, float, 'money')).toBe(false);
  });
});

describe('normalizing and restoring a stored layout', () => {
  it('round-trips through serialize and parse', () => {
    let layout = showColumn(defaultColumnLayout(), 'cost-plan', CM);
    layout = setColumnWidth(moveColumn(layout, 'cost-plan', 1), 'cost-plan', 200);
    layout = setColumnTitle(setColumnAlign(layout, 'cost-plan', 'center'), 'cost-plan', 'Money');
    expect(parseColumnLayout(serializeColumnLayout(layout), CM)).toEqual(layout);
  });

  it('drops money columns (and their settings) for a viewer who cannot see costs', () => {
    const stored = serializeColumnLayout(
      layoutWith(['task', 'cost-plan', 'schedule-crew', 'budget'], { widths: { 'cost-plan': 220, budget: 90 }, titles: { budget: 'Agreed' }, aligns: { budget: 'start' } }),
    );
    expect(parseColumnLayout(stored, PM)).toEqual(layoutWith(['task', 'schedule-crew']));
    expect(parseColumnLayout(stored, CM).visible).toEqual(['task', 'cost-plan', 'schedule-crew', 'budget']);
  });

  it('drops unknown ids and duplicates, and puts the task column first', () => {
    const layout = normalizeColumnLayout({ visible: ['schedule-crew', 'gone', 'schedule-crew', 42, 'task', 'start'], widths: { gone: 100 }, titles: { gone: 'x' }, aligns: { gone: 'end' } }, PM);
    expect(layout).toEqual(layoutWith(['task', 'schedule-crew', 'start']));
  });

  it('keeps an explicit empty choice (only the task column)', () => {
    expect(normalizeColumnLayout({ visible: [] }, PM).visible).toEqual(['task']);
  });

  it('cleans out-of-range and wrongly typed values', () => {
    const layout = normalizeColumnLayout(
      {
        visible: ['task', 'notes'],
        widths: { notes: 'wide', start: Number.POSITIVE_INFINITY, finish: -5, 'schedule-crew': 88, wbs: 5000, task: 3 },
        titles: { notes: '   ', start: 12, finish: 'End', duration: 'Days' },
        aligns: { notes: 'middle', start: 'end', budget: 'start' },
      },
      PM,
    );
    expect(layout.widths).toEqual({ finish: MIN_COLUMN_WIDTH, wbs: MAX_COLUMN_WIDTH, task: 24 });
    expect(layout.titles).toEqual({ finish: 'End' });
    expect(layout.aligns).toEqual({ start: 'end' });
  });

  it('falls back to the default layout on garbage', () => {
    for (const garbage of [null, undefined, '', '{', 'null', '42', '"text"', '[]', '{"visible":["task"]}', '{"v":2,"visible":["task"]}', 17, {}]) {
      expect(parseColumnLayout(garbage, CM)).toEqual(defaultColumnLayout());
    }
    expect(normalizeColumnLayout('not an object', PM)).toEqual(defaultColumnLayout());
    expect(normalizeColumnLayout({ visible: 'task' }, PM).visible).toEqual(DEFAULT_VISIBLE_COLUMNS);
  });
});

describe('storage', () => {
  class MemoryStorage {
    items = new Map<string, string>();
    getItem(key: string): string | null {
      return this.items.get(key) ?? null;
    }
    setItem(key: string, value: string): void {
      this.items.set(key, value);
    }
  }
  const throwing = {
    getItem(): string | null {
      throw new Error('SecurityError');
    },
    setItem(): void {
      throw new Error('QuotaExceededError');
    },
  };

  it('keys the layout by viewer', () => {
    expect(columnLayoutStorageKey('user-1')).not.toBe(columnLayoutStorageKey('user-2'));
    expect(columnLayoutStorageKey('')).toBe(columnLayoutStorageKey('default'));
  });

  it('saves and loads a layout', () => {
    const storage = new MemoryStorage();
    const key = columnLayoutStorageKey('cm');
    const layout = setColumnWidth(showColumn(defaultColumnLayout(), 'cost-actual', CM), 'cost-actual', 190);
    expect(saveColumnLayout(storage, key, layout)).toBe(true);
    expect(loadColumnLayout(storage, key, CM)).toEqual(layout);
    expect(loadColumnLayout(storage, columnLayoutStorageKey('pm'), PM)).toEqual(defaultColumnLayout());
  });

  it('survives missing, blocked and full storage', () => {
    const key = columnLayoutStorageKey('x');
    expect(loadColumnLayout(null, key, CM)).toEqual(defaultColumnLayout());
    expect(loadColumnLayout(undefined, key, CM)).toEqual(defaultColumnLayout());
    expect(loadColumnLayout(throwing, key, CM)).toEqual(defaultColumnLayout());
    expect(saveColumnLayout(null, key, defaultColumnLayout())).toBe(false);
    expect(saveColumnLayout(throwing, key, defaultColumnLayout())).toBe(false);
  });

  it('restores garbage in storage as the default layout', () => {
    const storage = new MemoryStorage();
    const key = columnLayoutStorageKey('x');
    storage.setItem(key, '{"v":1,"visible":');
    expect(loadColumnLayout(storage, key, CM)).toEqual(defaultColumnLayout());
  });
});

// -----------------------------------------------------------------------------------------
// Bryntum side: building the columns and applying a layout to a live column store
// -----------------------------------------------------------------------------------------

/** A ColumnStore stand-in: a root with ordered children and Bryntum's flex/width exclusivity. */
function fakeStore(configs: { id: string; hidden?: boolean; width?: number; flex?: number; text?: string; align?: string }[]) {
  const children: LiveColumn[] = configs.map((config) => {
    const data: Record<string, unknown> = { ...config };
    return {
      get id() {
        return config.id;
      },
      get hidden() {
        return Boolean(data.hidden);
      },
      set hidden(value) {
        data.hidden = value;
      },
      get width() {
        return data.width as number | undefined;
      },
      set width(value) {
        data.width = value;
        if (value) data.flex = null;
      },
      get flex() {
        return data.flex as number | undefined;
      },
      set flex(value) {
        data.flex = value;
        if (value) data.width = null;
      },
      get text() {
        return data.text as string | undefined;
      },
      set text(value) {
        data.text = value;
      },
      get align() {
        return data.align as string | undefined;
      },
      set align(value) {
        data.align = value;
      },
    };
  });
  let moves = 0;
  const store: LiveColumnStore & { moves(): number } = {
    getById: (id) => children.find((column) => column.id === id) ?? null,
    rootNode: {
      get children() {
        return children;
      },
      insertChild(child, before) {
        moves += 1;
        children.splice(children.indexOf(child), 1);
        children.splice(before ? children.indexOf(before) : children.length, 0, child);
      },
    },
    moves: () => moves,
  };
  return store;
}

const renderGroup = () => ({ tag: 'span' });

describe('building the Gantt columns', () => {
  it('builds every catalog column once, in layout order, with the "+" column last', () => {
    const layout = showColumn(moveColumn(defaultColumnLayout(), 'schedule-when', 1), 'cost-plan', CM);
    const columns = buildGanttColumns({ canViewCosts: true, currency: 'USD', renderGroup, layout }) as { id: string; hidden: boolean; text: string }[];
    const ids = columns.map((column) => column.id);
    expect(ids.slice(0, 5)).toEqual(['task', 'schedule-when', 'schedule-crew', 'equipment', 'cost-plan']);
    expect(ids.at(-1)).toBe(PICKER_COLUMN_ID);
    expect(new Set(ids).size).toBe(COLUMN_CATALOG.length + 1);
    expect(columns.filter((column) => !column.hidden).map((column) => column.id)).toEqual(['task', 'schedule-when', 'schedule-crew', 'equipment', 'cost-plan', PICKER_COLUMN_ID]);
    expect(columns.find((column) => column.id === 'duration')?.text).toBe('Days');
  });

  it('never builds a money column for a viewer who cannot see costs', () => {
    const layout = layoutWith(['task', 'cost-plan']);
    const ids = buildGanttColumns({ canViewCosts: false, currency: 'USD', renderGroup, layout }).map((column) => (column as { id: string }).id);
    for (const id of MONEY_IDS) expect(ids).not.toContain(id);
  });
});

describe('applying a layout to the live columns', () => {
  const store = () =>
    fakeStore([
      { id: 'task', flex: 1, text: 'Task' },
      { id: 'schedule-crew', width: 88, text: 'Crew' },
      { id: 'schedule-when', width: 214, text: 'Schedule' },
      { id: 'start', width: 116, text: 'Start', hidden: true },
      { id: 'notes', width: 200, text: 'Notes', hidden: true },
      { id: PICKER_COLUMN_ID, width: 40, text: '' },
      { id: 'timeAxis' },
    ]);

  it('shows, hides, sizes, renames, aligns and orders the columns, with the "+" last', () => {
    const live = store();
    let layout = showColumn(defaultColumnLayout(), 'notes', PM);
    layout = moveColumn(layout, 'notes', 1);
    layout = hideColumn(layout, 'schedule-crew');
    layout = setColumnWidth(setColumnTitle(layout, 'notes', 'Diary'), 'notes', 240);
    layout = setColumnAlign(layout, 'schedule-when', 'center');
    expect(applyColumnLayout(live, layout)).toEqual({ changed: true, realigned: true });
    expect(visibleColumnOrder(live)).toEqual(['task', 'notes', 'schedule-when']);
    const ids = (live.rootNode.children as LiveColumn[]).map((column) => column.id);
    expect(ids.indexOf(PICKER_COLUMN_ID)).toBeGreaterThan(ids.indexOf('schedule-when'));
    expect(live.getById('notes')).toMatchObject({ hidden: false, width: 240, text: 'Diary' });
    expect(live.getById('schedule-crew')?.hidden).toBe(true);
    expect(live.getById('schedule-when')?.align).toBe('center');
  });

  it('is idempotent: a second apply moves and realigns nothing', () => {
    const live = store();
    const layout = moveColumn(showColumn(defaultColumnLayout(), 'start', PM), 'start', 1);
    applyColumnLayout(live, layout);
    const moves = live.moves();
    expect(applyColumnLayout(live, layout)).toEqual({ changed: false, realigned: false });
    expect(live.moves()).toBe(moves);
  });

  it('gives the task column its flex back after a header resize fixed its width', () => {
    const live = store();
    live.getById('task')!.width = 300;
    applyColumnLayout(live, defaultColumnLayout());
    expect(live.getById('task')).toMatchObject({ flex: 1, width: null });
  });

  it('skips columns the store does not have (money for a project manager)', () => {
    const live = store();
    expect(() => applyColumnLayout(live, layoutWith(['task', 'cost-plan', 'schedule-crew']))).not.toThrow();
    expect(visibleColumnOrder(live)).toEqual(['task', 'schedule-crew']);
  });
});
