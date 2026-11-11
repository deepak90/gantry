/**
 * The Gantt adapter's arithmetic against a stand-in Gantt (jsdom has no layout, so the real widget
 * would report zero-sized rows): reading the view, applying a frame, and turning a pointer event into
 * a task-and-date position. Placement on a real screen is covered by tests/e2e/presence.spec.ts.
 */
import type { Gantt } from '@bryntum/gantt';
import { describe, expect, it, vi } from 'vitest';
import { applyView, pointFromEvent, readView, shownRecord } from '../../src/presence/gantt-adapter';
import { VIEW } from './helpers';

const ROW_HEIGHT = 46;

interface FakeRecord {
  id: number | string;
  generatedParent?: boolean;
  $original?: FakeRecord;
}

function fakeGantt(options: { records?: FakeRecord[]; preset?: string; center?: Date; scrollY?: number; height?: number; selected?: FakeRecord[] } = {}) {
  const records = options.records ?? [{ id: 100 }, { id: 15 }, { id: 242 }, { id: 311 }];
  const element = document.createElement('div');
  document.body.appendChild(element);
  const timeAxisElement = document.createElement('div');
  element.appendChild(timeAxisElement);
  const scrolls: { target: string; x: number | null; y: number | null }[] = [];
  const zooms: unknown[] = [];
  // Scroll positions are set directly (follow mode moves them every screen frame); each write is recorded.
  const scroller = (target: string, size: { clientWidth: number; clientHeight: number }, y = 0) => {
    let x = 0;
    return {
      ...size,
      get x() {
        return x;
      },
      set x(value: number) {
        x = value;
        scrolls.push({ target, x: value, y: null });
      },
      get y() {
        return y;
      },
      set y(value: number) {
        y = value;
        scrolls.push({ target, x: null, y: value });
      },
    };
  };
  const timeline = scroller('timeline', { clientWidth: 600, clientHeight: 0 });
  const vertical = scroller('vertical', { clientWidth: 0, clientHeight: options.height ?? 460 }, options.scrollY ?? 0);
  // Rows sit from the top of the page, ROW_HEIGHT apart, unscrolled.
  const row = (index: number) => ({
    id: records[index]!.id,
    top: index * ROW_HEIGHT,
    height: ROW_HEIGHT,
    getElement: () => {
      const rowElement = document.createElement('div');
      const top = index * ROW_HEIGHT;
      rowElement.getBoundingClientRect = () => ({ top, height: ROW_HEIGHT, left: 0, width: 800, bottom: top + ROW_HEIGHT, right: 800, x: 0, y: top, toJSON: () => ({}) });
      return rowElement;
    },
    getCell: () => undefined,
  });
  const gantt = {
    element,
    store: {
      getById: (id: unknown) => records.find((record) => record.id === id),
      find: (fn: (record: FakeRecord) => boolean) => records.find(fn),
      indexOf: (record: FakeRecord) => records.indexOf(record),
    },
    rowManager: {
      getRowAt: (y: number) => {
        const index = Math.floor(y / ROW_HEIGHT);
        return index >= 0 && index < records.length ? row(index) : undefined;
      },
      getRowFor: (record: FakeRecord) => row(records.indexOf(record)),
      getRecordCoords: (record: FakeRecord) => {
        const index = records.indexOf(record);
        return index === -1 ? null : { y: index * ROW_HEIGHT, height: ROW_HEIGHT };
      },
    },
    scrollable: vertical,
    timeAxisSubGrid: { element: timeAxisElement, scrollable: timeline },
    subGrids: {},
    viewPreset: { id: options.preset ?? 'collab-days' },
    viewportCenterDate: options.center ?? new Date(2026, 11, 11, 12, 0, 0),
    presets: { getById: (id: string) => (['collab-days', 'collab-weeks', 'collab-months'].includes(id) ? { id } : undefined) },
    selectedRecords: options.selected ?? [],
    getCoordinateFromDate: (date: Date) => (date.getTime() - new Date(2026, 10, 2).getTime()) / 86_400_000 * 34,
    getDateFromDomEvent: vi.fn(() => new Date(2026, 11, 14, 9, 0, 0)),
    getRecordFromElement: (rowElement: Element) => records.find((record) => String(record.id) === (rowElement as HTMLElement).dataset.id),
    zoomTo: vi.fn((config: unknown) => zooms.push(config)),
    scrollToDate: vi.fn(async () => undefined),
    on: () => () => undefined,
  };
  return { gantt: gantt as unknown as Gantt, raw: gantt, scrolls, zooms, element, timeAxisElement };
}

describe('readView', () => {
  it('reads the zoom level, the date in the middle and the task row in the middle', () => {
    const { gantt } = fakeGantt({ scrollY: 0, height: 120, selected: [{ id: 242 }] });
    // Middle at y = 60: the second row (46-92), 30% down it.
    expect(readView(gantt)).toEqual({ preset: 'collab-days', center: '2026-12-11T12:00:00', anchor: { taskId: 15, dy: (60 - 46) / 46 }, selected: [242] });
  });

  it('reads ids through linked copies and skips group rows', () => {
    const original = { id: 15 };
    const records = [{ id: 'group-crane', generatedParent: true }, { id: '_copy_15', $original: original }];
    const { gantt } = fakeGantt({ records, height: 46, selected: [records[0]!, records[1]!] });
    const view = readView(gantt);
    expect(view?.anchor).toBeNull(); // the middle row is a group row
    expect(view?.selected).toEqual([15]);
    expect(shownRecord(gantt, 15)).toBe(records[1]);
  });

  it('reads nothing from a Gantt that is gone', () => {
    const { gantt, element } = fakeGantt();
    element.remove();
    expect(readView(gantt)).toBeNull();
  });
});

describe('applyView', () => {
  it('zooms to the leader’s level around their date when the levels differ', () => {
    const { gantt, zooms } = fakeGantt({ preset: 'collab-days' });
    applyView(gantt, { ...VIEW, preset: 'collab-weeks', center: '2027-01-20T12:00:00' });
    expect(zooms).toEqual([{ preset: 'collab-weeks', centerDate: new Date(2027, 0, 20, 12, 0, 0) }]);
  });

  it('only scrolls when the level is the same, putting the date in the middle of the timeline', () => {
    const { gantt, zooms, scrolls } = fakeGantt({ preset: 'collab-days' });
    applyView(gantt, { ...VIEW, center: '2026-11-12T00:00:00' });
    expect(zooms).toHaveLength(0);
    // 10 days after the axis start at 34 px a day = 340 px, minus half of the 600 px timeline.
    expect(scrolls.find((s) => s.target === 'timeline')).toEqual({ target: 'timeline', x: 40, y: null });
    applyView(gantt, { ...VIEW, center: '2026-11-04T00:00:00' });
    // Near the start of the axis the scroll stops at 0.
    expect(scrolls.filter((s) => s.target === 'timeline').at(-1)?.x).toBe(0);
    applyView(gantt, { ...VIEW, center: '2026-12-12T00:00:00' });
    expect(scrolls.filter((s) => s.target === 'timeline').at(-1)?.x).toBe(40 * 34 - 300);
  });

  it('ignores a zoom level this plan does not have', () => {
    const { gantt, zooms } = fakeGantt();
    applyView(gantt, { ...VIEW, preset: 'someone-elses-preset' });
    expect(zooms).toHaveLength(0);
  });

  it('puts the leader’s middle task in the middle of this plan, whatever its height', () => {
    const { gantt, scrolls } = fakeGantt({ height: 100 });
    expect(applyView(gantt, { ...VIEW, anchor: { taskId: 311, dy: 0.5 } })).toBe('applied');
    // Row 4 starts at 138; its middle is 161; minus half the 100 px viewport = 111.
    expect(scrolls.find((s) => s.target === 'vertical')).toEqual({ target: 'vertical', x: null, y: 111 });
  });

  it('reports a middle task this plan does not show', () => {
    const { gantt, scrolls } = fakeGantt();
    expect(applyView(gantt, { ...VIEW, anchor: { taskId: 999, dy: 0.5 } })).toBe('missing-anchor');
    expect(scrolls.some((s) => s.target === 'vertical')).toBe(false);
  });

  it('selects what the leader selected, and leaves an unchanged selection alone', () => {
    const { gantt, raw } = fakeGantt();
    applyView(gantt, { ...VIEW, selected: [242, 999] });
    expect(raw.selectedRecords.map((record) => record.id)).toEqual([242]);
    const same = raw.selectedRecords;
    applyView(gantt, { ...VIEW, selected: [242] });
    expect(raw.selectedRecords).toBe(same);
    applyView(gantt, { ...VIEW, selected: [] });
    expect(raw.selectedRecords).toEqual([]);
  });
});

describe('pointFromEvent', () => {
  function rowElement(id: number, parent: HTMLElement, top: number) {
    const rowEl = document.createElement('div');
    rowEl.className = 'b-grid-row';
    rowEl.dataset.id = String(id);
    rowEl.getBoundingClientRect = () => ({ top, height: ROW_HEIGHT, left: 0, width: 800, bottom: top + ROW_HEIGHT, right: 800, x: 0, y: top, toJSON: () => ({}) });
    parent.appendChild(rowEl);
    return rowEl;
  }

  const pointer = (target: Element, clientX: number, clientY: number) => ({ target, clientX, clientY }) as unknown as PointerEvent;

  it('over the timeline: the row under the pointer (bars are drawn above the rows), the date and how far down the row', () => {
    const { gantt, timeAxisElement } = fakeGantt();
    // A bar on the canvas over the timeline, not inside any row element.
    const barEl = document.createElement('div');
    timeAxisElement.appendChild(barEl);
    expect(pointFromEvent(gantt, pointer(barEl, 300, ROW_HEIGHT + 23))).toEqual({ kind: 'timeline', taskId: 15, date: '2026-12-14T09:00:00', dy: 0.5 });
    expect(pointFromEvent(gantt, pointer(barEl, 300, 10 * ROW_HEIGHT))).toBeNull();
  });

  it('over a grid cell: the task row, the column and where in the cell', () => {
    const { gantt, element } = fakeGantt();
    const locked = document.createElement('div');
    element.appendChild(locked);
    const rowEl = rowElement(242, locked, 0);
    const cell = document.createElement('div');
    cell.className = 'b-grid-cell';
    cell.dataset.columnId = 'schedule-when';
    cell.getBoundingClientRect = () => ({ top: 0, height: ROW_HEIGHT, left: 200, width: 200, bottom: ROW_HEIGHT, right: 400, x: 200, y: 0, toJSON: () => ({}) });
    rowEl.appendChild(cell);
    expect(pointFromEvent(gantt, pointer(cell, 250, 46))).toEqual({ kind: 'grid', taskId: 242, column: 'schedule-when', dx: 0.25, dy: 1 });
  });

  it('nothing over headers, group rows or outside the plan', () => {
    const records = [{ id: 'crew-group', generatedParent: true }];
    const { gantt, element, timeAxisElement } = fakeGantt({ records });
    const header = document.createElement('div');
    element.appendChild(header);
    expect(pointFromEvent(gantt, pointer(header, 10, 10))).toBeNull();
    const groupRow = document.createElement('div');
    groupRow.className = 'b-grid-row';
    groupRow.dataset.id = 'crew-group';
    timeAxisElement.appendChild(groupRow);
    expect(pointFromEvent(gantt, pointer(groupRow, 10, 10))).toBeNull();
    const elsewhere = document.createElement('div');
    elsewhere.className = 'b-grid-row';
    document.body.appendChild(elsewhere);
    expect(pointFromEvent(gantt, pointer(elsewhere, 10, 10))).toBeNull();
  });
});
