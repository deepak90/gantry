/**
 * Rows lit by flashRows: a row lit again by a later flash stays lit until that flash ends, whatever an earlier flash's
 * timer says, and once nothing is lit every row is cleared.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Gantt, TaskModel } from '@bryntum/gantt';
import { flashRows } from '../../src/library/drag';

function chart() {
  const lit = new Map<number, boolean>();
  const row = (id: number) => ({
    addCls: () => lit.set(id, true),
    removeCls: () => lit.set(id, false),
  });
  const gantt = {
    isDestroyed: false,
    getRowFor: (task: { id: number }) => row(task.id),
    rowManager: { rows: [1, 2, 3, 4].map(row) },
  };
  return { gantt: gantt as unknown as Gantt, lit };
}
const task = (id: number) => ({ id }) as unknown as TaskModel;

describe('flashRows', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('leaves lit what a later flash lit again, and clears the rest when each flash ends', () => {
    const { gantt, lit } = chart();
    flashRows(gantt, [task(1), task(2), task(3), task(4)], 1200);
    vi.advanceTimersByTime(900);
    flashRows(gantt, [task(1), task(2), task(3)], 2400);
    vi.advanceTimersByTime(300);
    // The first flash has ended: only the row the second one didn't light goes off.
    expect([lit.get(1), lit.get(2), lit.get(3), lit.get(4)]).toEqual([true, true, true, false]);
    vi.advanceTimersByTime(2100);
    expect([lit.get(1), lit.get(2), lit.get(3), lit.get(4)]).toEqual([false, false, false, false]);
  });
});
