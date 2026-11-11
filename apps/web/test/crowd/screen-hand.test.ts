import type { ProjectModel, TaskModel } from '@bryntum/gantt';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hand } from '../../src/crowd/hand';
import { Random } from '../../src/crowd/random';
import { VirtualScreen } from '../../src/crowd/screen';
import type { CursorPoint } from '../../src/presence/protocol';
import { viewBodySchema } from '../../src/presence/protocol';
import { FakeClock } from '../presence/helpers';
import { flush, seededProject } from './helpers';

describe('the virtual screen and the hand', () => {
  let project: ProjectModel;
  let screen: VirtualScreen;
  beforeEach(async () => {
    project = await seededProject();
    screen = new VirtualScreen(project);
  });
  afterEach(() => {
    screen.dispose();
    project.destroy();
  });

  it('says what a point is over: a task and a column in the grid, a task and a date on the timeline', () => {
    const [firstRow, secondRow] = screen.rowIds;
    const cell = screen.cellRect(secondRow!, 'schedule-when')!;
    const grid = screen.pointAt({ x: cell.x + cell.width / 2, y: cell.y + cell.height / 4 });
    expect(grid).toMatchObject({ kind: 'grid', taskId: secondRow, column: 'schedule-when' });
    expect((grid as Extract<CursorPoint, { kind: 'grid' }>).dx).toBeCloseTo(0.5, 2);
    const leaf = (project.taskStore.leaves as TaskModel[]).find((task) => screen.rowOf(task.id as number) >= 0 && screen.rowOf(task.id as number) < 10)!;
    const bar = screen.barRect(leaf)!;
    const timeline = screen.pointAt({ x: bar.x + 2, y: bar.y + bar.height / 2 });
    expect(timeline).toMatchObject({ kind: 'timeline', taskId: leaf.id });
    expect((timeline as Extract<CursorPoint, { kind: 'timeline' }>).date.slice(0, 10)).toBe((leaf.startDate as Date).toLocaleDateString('sv'));
    // Over the column picker: nothing with data under it.
    expect(screen.pointAt({ x: screen.gridWidth - 10, y: 30 })).toBeNull();
    expect(firstRow).toBeDefined();
  });

  it('streams a view a follower can apply: the date and row in the middle, the selection and the look', () => {
    const target = screen.rowIds[screen.rowIds.length - 1]!;
    screen.reveal(target);
    screen.setScroll(...(Object.values(screen.scrollToShow(target)) as [number, number]));
    screen.setSelected(target);
    const view = viewBodySchema.parse(screen.view());
    expect(view.preset).toBe('collab-days');
    expect(view.selected).toEqual([target]);
    expect(view.anchor && 'taskId' in view.anchor ? screen.rowOf(view.anchor.taskId) : -1).toBeGreaterThan(0);
    expect(view.look?.groupBy).toBe('phase');
  });

  it('sends the pointer like a browser, only less often: frequent during a reach, a keep-alive when still', async () => {
    const clock = new FakeClock();
    const sent: { at: number; point: CursorPoint | null }[] = [];
    const hand = new Hand({ screen, clock, random: new Random(4), send: (point) => sent.push({ at: clock.now(), point }), start: { x: 900, y: 120 } });
    const reach = hand.move({ x: 200, y: 600 });
    for (let elapsed = 0; elapsed < 2_000; elapsed += 33) {
      clock.advance(33);
      await flush();
    }
    await reach;
    const during = sent.filter((entry) => entry.point !== null);
    expect(during.length).toBeGreaterThanOrEqual(4);
    // Never more than about ten a second.
    for (let index = 1; index < during.length; index++) expect(during[index]!.at - during[index - 1]!.at).toBeGreaterThanOrEqual(85);
    const kinds = new Set(during.map((entry) => entry.point!.kind));
    expect(kinds).toEqual(new Set(['timeline', 'grid']));
    // Still: one update every two seconds, so the pointer does not expire elsewhere.
    const before = sent.length;
    const rest = hand.hold(6_000);
    for (let elapsed = 0; elapsed < 6_200; elapsed += 100) {
      clock.advance(100);
      await flush();
    }
    await rest;
    expect(sent.length - before).toBeGreaterThanOrEqual(2);
    expect(sent.length - before).toBeLessThanOrEqual(6);
    hand.leave();
    expect(sent[sent.length - 1]!.point).toBeNull();
    hand.dispose();
  });
});
