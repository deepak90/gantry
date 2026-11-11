/**
 * After marking what was recorded as the person's, the engine gives the screen a turn to draw before it
 * writes its results, and marks whatever is unmarked after that as calculated. These checks act in that
 * turn: what a person does there has to reach everyone, like anything else they do.
 */
import type { TaskModel } from '@bryntum/gantt';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queueMenuItems, runInProjectQueue } from '../../src/gantt/menu-actions';
import { Session } from '../library/harness';
import type { Peer } from '../sync/peers';

const [DIG, SAW, XRAY] = [212, 211, 412];

let session: Session;
let warnings: string[];

beforeEach(() => {
  session = new Session();
  warnings = [];
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  });
});

afterEach(() => {
  session.dispose();
  vi.restoreAllMocks();
});

const task = (peer: Peer, id: number) => peer.project.taskStore.getById(id) as TaskModel;

/** Runs `act` once, in the turn the engine next leaves for the screen. */
function inTheGap(peer: Peer, act: () => void): void {
  const detach = (peer.project as unknown as { on(listeners: object): () => void }).on({
    refresh: ({ isCalculated }: { isCalculated?: boolean }) => {
      if (!isCalculated) return;
      detach();
      // Queued the way a click is: it runs in the turn, ahead of the engine's own.
      setTimeout(act);
    },
  });
}

describe('acting while the engine lets the screen draw', () => {
  it('a menu action during this client’s own recalculation reaches everyone', async () => {
    const { B } = await session.start();
    inTheGap(B, () => void runInProjectQueue(B.project, () => task(B, DIG).remove()));
    task(B, SAW).duration = 4;
    const view = await session.converge(warnings);
    expect(view.tasks.some((row) => row.id === DIG)).toBe(false);
  });

  it('a menu action while someone else’s change is applied reaches everyone', async () => {
    const { A, B } = await session.start();
    inTheGap(B, () => void runInProjectQueue(B.project, () => task(B, DIG).remove()));
    task(A, SAW).duration = 4;
    const view = await session.converge(warnings);
    expect(view.tasks.some((row) => row.id === DIG)).toBe(false);
  });

  it('an edit written straight to a record during a recalculation is still the person’s', async () => {
    const { B } = await session.start();
    inTheGap(B, () => {
      task(B, XRAY).name = 'Renamed in the gap';
    });
    task(B, SAW).duration = 4;
    const view = await session.converge(warnings);
    expect(view.tasks.find((row) => row.id === XRAY)?.name).toBe('Renamed in the gap');
  });
});

describe('the task menu in the queue', () => {
  it('reaches actions in menus under menus, and wraps each once', async () => {
    const { A } = await session.start();
    const inner = vi.fn();
    const items = { add: { menu: { below: { onItem: inner } } }, off: false };
    queueMenuItems(A.project, items);
    const once = items.add.menu.below.onItem;
    queueMenuItems(A.project, items);
    expect(items.add.menu.below.onItem).toBe(once);
    once.call(undefined, {} as never);
    await session.settle();
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('skips an action on a task someone has removed while it waited', async () => {
    const { A } = await session.start();
    const action = vi.fn();
    const items = { deleteTask: { onItem: action } };
    queueMenuItems(A.project, items);
    const held = task(A, DIG);
    await runInProjectQueue(A.project, () => held.remove());
    await session.settle();
    items.deleteTask.onItem.call(undefined, { taskRecord: held } as never);
    await session.settle();
    expect(action).not.toHaveBeenCalled();
  });
});
