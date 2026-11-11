/**
 * Feasibility of dropping a library snippet into the live plan: the whole piece (copies, groups,
 * tasks, internal links, crews) arrives in one transaction, is linked after the task it was dropped
 * after and, with "push later work back", takes over the links that made later work wait, so the
 * downstream work and the handover move later. Two clients sync through the in-memory relay; both,
 * a reload from the log and a boot from a live snapshot must end identical with real ids and no errors.
 */
import type { CalendarModel, DependencyModel, TaskModel } from '@bryntum/gantt';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultTweaks, planSnippet, type Snippet } from '@collab/shared';
import { starterSnippet } from '@collab/shared/library-starter';
import { setPaymentLocks } from '../../src/gantt/payment-lock';
import { attachBands, bandRanges } from '../../src/library/bands';
import { dropSnippet, lastFinishing, linksToMove, placementFor, previewDrop, tasksPushedBack, undoDrop, type Placement } from '../../src/library/insert';
import { groupTasks } from '../../src/library/placement';
import { runProjectTransaction } from '../../src/scenario/publish';
import type { Peer } from '../sync/peers';
import { Session, projection, stamp, type Projection } from './harness';

/** Seed ids (packages/shared/src/seed). */
const SEED = {
  buildOut: 400,
  partitions: 410,
  board: 411,
  xray: 412,
  ceilings: 413,
  decoration: 421,
  tiling: 422,
  lighting: 441,
  grilles: 442,
  sanitaryware: 451,
  completion: 620,
  punchList: 621,
  handover: 42,
  carpenters: 6,
} as const;

let session: Session;
let engineWarnings: string[];

beforeEach(() => {
  session = new Session();
  engineWarnings = [];
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    engineWarnings.push(args.map(String).join(' '));
  });
});

afterEach(() => {
  session.dispose();
  vi.restoreAllMocks();
});

const taskOf = (peer: Peer, id: number) => {
  const task = peer.project.taskStore.getById(id) as TaskModel | undefined;
  if (!task) throw new Error(`task ${id} missing in ${peer.id}`);
  return task;
};

const row = (view: Projection, id: unknown) => {
  const found = view.tasks.find((task) => task.id === id);
  if (!found) throw new Error(`task ${String(id)} not in the projection`);
  return found;
};

const named = (view: Projection, name: string, underWbs = '') => {
  const found = view.tasks.find((task) => task.name === name && task.wbs.startsWith(underWbs));
  if (!found) throw new Error(`no task named ${name}`);
  return found;
};

const snippet = (id: string): Snippet => {
  const found = starterSnippet(id);
  if (!found) throw new Error(`no snippet ${id}`);
  const { starterKey, ...draft } = found;
  return { id: starterKey, ...draft };
};

/** A placement with task ids instead of models (a failing comparison of Bryntum models takes forever to print). */
const ids = (placement: Placement) =>
  Object.fromEntries(Object.entries(placement).map(([key, value]) => [key, typeof value === 'string' || value == null ? value : (value as TaskModel).id]));

const linkIds = (view: Projection, from: unknown, to: unknown) => view.dependencies.filter((link) => link.from === from && link.to === to);

/** The first working day at or after a (exclusive) finish date: where a finish-to-start successor starts. */
function workStart(peer: Peer, day: string | null): string | null {
  if (!day) return null;
  const [y, m, d] = day.split('-').map(Number);
  const calendar = peer.project.calendar as CalendarModel & { skipNonWorkingTime(date: Date, forward?: boolean): Date };
  return stamp(calendar.skipNonWorkingTime(new Date(y!, m! - 1, d!), true));
}

const queue = (peer: Peer, step: () => unknown) => (peer.project as unknown as { queue(step: () => unknown): Promise<unknown> }).queue(step);

describe('dropping a snippet into the live plan', () => {
  it('adds two numbered exam rooms after a task and pushes the work that waited for it back', async () => {
    const { A, B } = await session.start();
    const before = projection(B.project);
    const plan = planSnippet(snippet('consulting-room'), { ...defaultTweaks(snippet('consulting-room')), repeats: 2 });
    const placement = placementFor(taskOf(A, SEED.board), 'after');
    expect(ids(placement)).toEqual({ kind: 'after', anchor: SEED.board });
    const movedBefore = linksToMove(placement).map((link) => (link.toEvent as unknown as TaskModel).id);
    expect(movedBefore.sort()).toEqual([SEED.ceilings, SEED.decoration, SEED.tiling].sort());

    const revisionsBefore = session.relay.revisionCount;
    const result = await dropSnippet(A.project, placement, plan, 'push');
    expect(result.tops.length).toBe(2);
    expect(result.created.length).toBe(plan.taskCount);
    expect(result.moved).toBe(3);
    expect(result.unknownCrews).toEqual([]);
    const view = await session.converge(engineWarnings);
    // One user action, one revision, and nobody needed to send a correction afterwards.
    expect(session.relay.revisionCount - revisionsBefore).toBe(1);
    // No existing task is moved by hand: the drop's input touches existing tasks only to make room in
    // the row order (Bryntum also lists the receiving work package's rolled-up duration).
    const input = session.relay.allRows().at(-1)!.changes.tasks?.$input as { updated?: Record<string, unknown>[] } | undefined;
    const handEdits = (input?.updated ?? [])
      .filter((entry) => entry.id !== SEED.partitions)
      .map((entry) => Object.keys(entry).filter((key) => !['id', 'parentIndex', 'orderedParentIndex'].includes(key)));
    expect(handEdits.flat(), 'fields of existing tasks the drop sends as input').toEqual([]);

    const [room1, room2] = result.tops.map((top) => row(view, top.id));
    expect(room1).toMatchObject({ parentId: SEED.partitions, wbs: '4.1.2', name: 'Exam room build-out – room 1', percentDone: 0 });
    expect(room2).toMatchObject({ parentId: SEED.partitions, wbs: '4.1.3', name: 'Exam room build-out – room 2' });
    expect(row(view, SEED.partitions).children).toEqual([SEED.board, room1!.id, room2!.id, SEED.xray, SEED.ceilings]);
    expect(row(view, SEED.ceilings).wbs).toBe('4.1.5');
    // Nested three levels: room > group > task, with the internal links and crews.
    const groups = room1!.children.map((id) => row(view, id));
    expect(groups.map((group) => group.name)).toEqual(['Walls & rough-in', 'Close up', 'Trim-out & finishes', 'Punch list & clean the room']);
    const studs = row(view, groups[0]!.children[1]);
    expect(studs).toMatchObject({ name: 'Metal stud walls & door frames', duration: 2, wbs: '4.1.2.1.2', budgetMinor: 0, incurredMinor: 0, paidMinor: 0 });
    expect(view.assignments.filter((assignment) => assignment.event === studs.id).map((assignment) => assignment.resource)).toEqual([SEED.carpenters]);
    const newIds = new Set(result.created.map((task) => task.id));
    expect(view.dependencies.filter((link) => newIds.has(link.from as number) && newIds.has(link.to as number))).toHaveLength(plan.links.length);

    // In after the board task; the links that made later work wait for it now come from the last room.
    const setOut = row(view, groups[0]!.children[0]);
    expect(linkIds(view, SEED.board, setOut.id)).toHaveLength(1);
    for (const later of [SEED.ceilings, SEED.decoration, SEED.tiling]) {
      expect(linkIds(view, SEED.board, later), `board -> ${later} moved`).toEqual([]);
      expect(linkIds(view, room2!.id, later), `room 2 -> ${later}`).toHaveLength(1);
    }
    // New work starts when the board task ends; later work starts when the last room ends.
    expect(setOut.start).toBe(workStart(A, row(view, SEED.board).end));
    expect(row(view, SEED.ceilings).start).toBe(workStart(A, room2!.end));
    // The handover moves later; the task the work follows does not.
    expect(row(view, SEED.handover).start! > row(before, SEED.handover).start!).toBe(true);
    expect(view.end! > before.end!).toBe(true);
    expect(row(view, SEED.board)).toMatchObject({ start: row(before, SEED.board).start, end: row(before, SEED.board).end });
    // Everything new is linked: no task pinned by a constraint.
    expect(view.tasks.filter((task) => newIds.has(task.id as number) && task.constraintType)).toEqual([]);
  });

  describe('with the plan filtered', () => {
    /** A search that shows only the suspended ceilings among the plan's tasks (groups always show). */
    const search = async (peer: Peer) => {
      const store = peer.project.taskStore as unknown as { addFilter(filter: unknown, silent?: boolean): unknown; filter(): unknown };
      store.addFilter({ id: 'probe', filterBy: (record: TaskModel) => !record.isLeaf || record.name === 'Suspended ceilings' }, true);
      await store.filter();
    };

    /** The comparison reads each task's children, which a filter hides: it needs the whole plan showing. */
    const lift = async (peer: Peer) => {
      const store = peer.project.taskStore as unknown as { clearFilters(): unknown };
      await store.clearFilters();
    };

    it('still reads the whole group: the assistant is told about hidden tasks, and the end of a group is its real end', async () => {
      const { A } = await session.start();
      const before = lastFinishing(taskOf(A, SEED.partitions))!.id;
      await search(A);
      expect(groupTasks(taskOf(A, SEED.partitions)).map((task) => task.id).sort()).toEqual([SEED.board, SEED.xray, SEED.ceilings].sort());
      expect(lastFinishing(taskOf(A, SEED.partitions))!.id).toBe(before);
    });

    it('sends a piece with groups whole, every client agrees, and Undo takes all of it out', async () => {
      const { A, B } = await session.start();
      const clean = projection(B.project);
      await search(A);
      const plan = planSnippet(snippet('consulting-room'), defaultTweaks(snippet('consulting-room')));
      const result = await dropSnippet(A.project, placementFor(taskOf(A, SEED.ceilings), 'after'), plan, 'push');
      // The search is back: it never got in the way of the change.
      const filters = (A.project.taskStore as unknown as { filters: { count: number } }).filters;
      expect(filters.count).toBe(1);
      expect(result.created.length).toBe(plan.taskCount);
      const undone = () => undoDrop(A.project, plan, result);
      await lift(A);
      const view = await session.converge(engineWarnings);
      expect(view.tasks.length).toBe(clean.tasks.length + plan.taskCount);

      await search(A);
      await undone();
      await lift(A);
      const after = await session.converge(engineWarnings);
      expect(after.tasks.length).toBe(clean.tasks.length);
      expect(after.dependencies.length).toBe(clean.dependencies.length);
    });
  });

  describe('facing a fixed date further down the plan', () => {
    const fixed = async (peer: Peer) => {
      const ceilings = taskOf(peer, SEED.ceilings);
      ceilings.set({ constraintDate: ceilings.startDate, constraintType: 'muststarton' });
      await peer.project.commitAsync();
    };
    const fixtures = () => planSnippet(snippet('accessible-restroom'), defaultTweaks(snippet('accessible-restroom')));

    it('the preview says the push cannot work, and which task is in the way; fitting in is still fine', async () => {
      const { A } = await session.start();
      await fixed(A);
      const placement = placementFor(taskOf(A, SEED.board), 'after');
      const push = await previewDrop(A.project, placement, fixtures(), 'push');
      expect(push.error).toContain('Suspended ceilings');
      expect(push.moved).toEqual([]);
      const fit = await previewDrop(A.project, placement, fixtures(), 'fit');
      expect(fit.error).toBeNull();
    });

    it('a refused drop leaves nothing behind, on any client', async () => {
      const { A, B } = await session.start();
      await fixed(A);
      await session.settle();
      const before = projection(B.project);
      await expect(dropSnippet(A.project, placementFor(taskOf(A, SEED.board), 'after'), fixtures(), 'push')).rejects.toThrow(/fixed date|could not fit/i);
      const view = await session.converge(engineWarnings);
      expect(view.tasks.length).toBe(before.tasks.length);
      expect(view.dependencies.length).toBe(before.dependencies.length);
    });

    it('a push that would move a task PayPal is paying for is refused before anything changes; fitting in still works', async () => {
      const { A } = await session.start();
      const at = placementFor(taskOf(A, SEED.ceilings), 'after');
      const paid = (await previewDrop(A.project, at, fixtures(), 'push')).moved[0]!;
      setPaymentLocks(A.project, [paid.id]);
      const refused = await previewDrop(A.project, at, fixtures(), 'push');
      expect(refused.error).toContain(paid.name);
      expect(refused.error).toContain('PayPal');
      const [revisions, plan] = [session.relay.revisionCount, projection(A.project)];
      await expect(dropSnippet(A.project, at, fixtures(), 'push')).rejects.toThrow(/PayPal/);
      await session.settle();
      expect(session.relay.revisionCount).toBe(revisions);
      expect(projection(A.project)).toEqual(plan);
      expect((await previewDrop(A.project, at, fixtures(), 'fit')).error).toBeNull();
    });

    it('a lock on a task the push does not reach changes nothing', async () => {
      const { A } = await session.start();
      const at = placementFor(taskOf(A, SEED.ceilings), 'after');
      const moved = new Set((await previewDrop(A.project, at, fixtures(), 'push')).moved.map((task) => task.id));
      const elsewhere = (A.project.taskStore.leaves as TaskModel[]).find((task) => typeof task.id === 'number' && !moved.has(task.id))!;
      setPaymentLocks(A.project, [elsewhere.id as number]);
      expect((await previewDrop(A.project, at, fixtures(), 'push')).error).toBeNull();
      await expect(dropSnippet(A.project, at, fixtures(), 'push')).resolves.toBeDefined();
    });
  });

  describe('with its rows on screen', () => {
    /**
     * What a drawn row does to its task as it goes in, before the drop adds the links: the constraint
     * indicator reads the constraint, and the engine pins the task it finds no links on. No Gantt draws
     * rows here, so this does the pinning itself, for as long as `drop` runs (the revision coming back
     * adds the tasks again, which pins nothing); tests/e2e/demos.spec.ts checks the real thing.
     */
    const withRowsDrawn = async <T>(peer: Peer, drop: () => Promise<T>): Promise<T> => {
      const stop = peer.project.taskStore.on({
        add: ({ records }: { records: TaskModel[] }) =>
          records.forEach((record) =>
            (record as unknown as { traverse(visit: (node: TaskModel) => void): void }).traverse((node) => {
              if (node.isLeaf) node.set({ constraintDate: node.startDate, constraintType: 'startnoearlierthan' });
            }),
          ),
      }) as unknown as () => void;
      try {
        return await drop();
      } finally {
        stop();
      }
    };

    it('leaves linked work to its links: no date is pinned, and it comes back when the work before it finishes sooner', async () => {
      const { A, B } = await session.start();
      const fixtures: Snippet = {
        id: 'light-fixtures',
        name: 'Light fixtures',
        summary: 'Order, install and test',
        icon: 'lightbulb',
        unit: { one: 'floor', many: 'floors' },
        children: [
          { key: 'order', name: 'Order light fixtures', duration: 1 },
          { key: 'install', name: 'Install light fixtures', duration: 4 },
          { key: 'test', name: 'Test light fixtures', duration: 1 },
        ],
        links: [
          { from: 'order', to: 'install' },
          { from: 'install', to: 'test' },
        ],
      };
      const result = await withRowsDrawn(A, () => dropSnippet(A.project, placementFor(taskOf(A, SEED.board), 'after'), planSnippet(fixtures, defaultTweaks(fixtures)), 'push'));
      let view = await session.converge(engineWarnings);
      const added = new Set(result.created.map((task) => task.id));
      expect(view.tasks.filter((task) => added.has(task.id as number) && task.constraintType).map((task) => task.name)).toEqual([]);

      const start = row(view, result.tops[0]!.id).start!;
      await queue(A, async () => {
        const board = taskOf(A, SEED.board);
        board.duration = (board.duration as number) - 2;
        await A.project.commitAsync();
      });
      view = await session.converge(engineWarnings);
      expect(row(view, result.tops[0]!.id).start! < start).toBe(true);
      expect(row(projection(B.project), result.tops[0]!.id).start).toBe(row(view, result.tops[0]!.id).start);
    });

    it('still pins the work nothing leads to, and only that', async () => {
      const { A } = await session.start();
      await withRowsDrawn(A, () => dropSnippet(A.project, placementFor(taskOf(A, SEED.ceilings), 'after'), planSnippet(snippet('accessible-restroom'), defaultTweaks(snippet('accessible-restroom'))), 'unlinked'));
      const view = await session.converge(engineWarnings);
      const led = new Set(view.dependencies.map((link) => link.to));
      const inPiece = view.tasks.filter((task) => task.wbs.startsWith(named(view, 'Accessible restroom build-out').wbs) && task.children.length === 0);
      expect(inPiece.length).toBeGreaterThan(3);
      for (const task of inPiece) expect([task.name, task.constraintType]).toEqual([task.name, led.has(task.id) ? null : 'startnoearlierthan']);
    });
  });

  it('adds work at the end of a work package without moving anything else ("Fit in, nothing moves")', async () => {
    const { A, B } = await session.start();
    const before = projection(B.project);
    const plan = planSnippet(snippet('fire-stopping'), defaultTweaks(snippet('fire-stopping')));
    const placement = placementFor(taskOf(A, SEED.partitions), 'inside');
    expect(ids(placement)).toEqual({ kind: 'inside', parent: SEED.partitions, anchor: SEED.ceilings });
    expect(tasksPushedBack(placement, 'fit')).toHaveLength(0);

    const result = await dropSnippet(A.project, placement, plan, 'fit');
    // No crew on the project does fire stopping: those tasks stay without a crew.
    expect(result.unknownCrews).toEqual(['Firestopping']);
    const view = await session.converge(engineWarnings);
    const top = row(view, result.tops[0]!.id);
    expect(top).toMatchObject({ parentId: SEED.partitions, wbs: '4.1.4', name: 'Firestopping & inspection package' });
    expect(named(view, 'Survey penetrations & mark up drawings').start).toBe(workStart(A, row(view, SEED.ceilings).end));
    const penetrations = named(view, 'Seal pipe & cable penetrations in fire walls');
    expect(view.assignments.filter((assignment) => assignment.event === penetrations.id)).toEqual([]);
    // Every task that was there keeps its dates (the groups around the new work grow).
    for (const task of before.tasks) {
      if (task.id === SEED.partitions || task.id === SEED.buildOut) continue;
      expect({ id: task.id, start: row(view, task.id).start, end: row(view, task.id).end }).toEqual({ id: task.id, start: task.start, end: task.end });
    }
    expect(view.end).toBe(before.end);
  });

  it('brings each task\'s costs: the lines travel to the other client and add up to the task\'s budget', async () => {
    const { A, B } = await session.start();
    const fixtures: Snippet = {
      id: 'light-fixtures',
      name: 'Light fixtures',
      summary: 'Order, install and pay for the light fixtures of a floor',
      icon: 'lightbulb',
      unit: { one: 'floor', many: 'floors' },
      children: [
        { key: 'order', name: 'Order light fixtures', duration: 1, costs: [{ label: 'LED panels, 48', payee: 'Lumen & Co Lighting', amount: 18_400, due: 'on_order' }] },
        {
          key: 'install',
          name: 'Install light fixtures',
          duration: 4,
          costs: [
            { label: 'Installation labor', payee: 'Halden Electrical', amount: 6_200, due: 'on_completion' },
            { label: 'Fasteners and drivers', payee: 'Lumen & Co Lighting', amount: 450, due: 'on_delivery' },
          ],
        },
      ],
      links: [{ from: 'order', to: 'install', lag: 5 }],
    };
    const result = await dropSnippet(A.project, placementFor(taskOf(A, SEED.partitions), 'inside'), planSnippet(fixtures, defaultTweaks(fixtures)), 'fit');
    await session.converge(engineWarnings);
    const byName = (name: string) => (B.project.taskStore.allRecords as TaskModel[]).find((task) => task.name === name) as TaskModel & { costLines: unknown; budgetMinor: number; forecastMinor: number };
    const install = byName('Install light fixtures');
    expect(install.costLines).toEqual([
      { label: 'Installation labor', payee: 'Halden Electrical', amount_minor: 620_000, due: 'on_completion', paid_ref: null },
      { label: 'Fasteners and drivers', payee: 'Lumen & Co Lighting', amount_minor: 45_000, due: 'on_delivery', paid_ref: null },
    ]);
    expect([install.budgetMinor, install.forecastMinor]).toEqual([665_000, 665_000]);
    expect(byName('Order light fixtures').budgetMinor).toBe(1_840_000);
    // The top task carries no costs of its own.
    expect((B.project.taskStore.getById(result.tops[0]!.id) as TaskModel & { costLines: unknown }).costLines).toBeNull();
  });

  it('adds work at the start of a work package and makes its first task wait for it', async () => {
    const { A, B } = await session.start();
    const before = projection(B.project);
    const plan = planSnippet(snippet('handover-pack'), { name: 'Closeout package (east wing)', scale: 0.5, repeats: 1 });
    const placement = placementFor(taskOf(A, SEED.punchList), 'before');
    expect(ids(placement)).toEqual({ kind: 'first', parent: SEED.completion, before: SEED.punchList });
    expect(tasksPushedBack(placement, 'push').map((task) => task.id)).toEqual([SEED.punchList]);

    const result = await dropSnippet(A.project, placement, plan, 'push');
    const view = await session.converge(engineWarnings);
    const top = row(view, result.tops[0]!.id);
    expect(top).toMatchObject({ parentId: SEED.completion, wbs: '6.2.1', name: 'Closeout package (east wing)' });
    expect(row(view, SEED.punchList).wbs).toBe('6.2.2');
    // The first task starts where punch list started (pinned there, like a task added by hand)...
    const certs = named(view, 'Gather test certificates from every trade');
    expect(certs).toMatchObject({ start: row(before, SEED.punchList).start, constraintType: 'startnoearlierthan', duration: 2 });
    // ...and punch list, then the handover, wait for the new work.
    expect(linkIds(view, top.id, SEED.punchList)).toHaveLength(1);
    expect(row(view, SEED.punchList).start).toBe(workStart(A, top.end));
    expect(row(view, SEED.handover).start! > row(before, SEED.handover).start!).toBe(true);
  });

  it('runs alongside a task (start-to-start) or sits pinned with no links, and nothing else moves either way', async () => {
    const { A, B } = await session.start();
    const before = projection(B.project);
    const alongside = await dropSnippet(A.project, placementFor(taskOf(A, SEED.board), 'after'), planSnippet(snippet('nurse-call-data'), defaultTweaks(snippet('nurse-call-data'))), 'alongside');
    const pinned = await dropSnippet(A.project, placementFor(taskOf(A, SEED.ceilings), 'after'), planSnippet(snippet('accessible-restroom'), defaultTweaks(snippet('accessible-restroom'))), 'unlinked');
    const view = await session.converge(engineWarnings);
    const tray = named(view, 'Install cable tray & basket');
    expect(view.dependencies.filter((link) => link.to === tray.id)).toEqual([expect.objectContaining({ from: SEED.board, type: 0 })]);
    expect(tray.start).toBe(row(view, SEED.board).start);
    const setOut = named(view, 'Lay out fixtures & grab-bar locations');
    expect(view.dependencies.filter((link) => link.to === setOut.id)).toEqual([]);
    expect(setOut).toMatchObject({ start: workStart(A, row(view, SEED.ceilings).end), constraintType: 'startnoearlierthan' });
    const added = new Set([...alongside.created, ...pinned.created].map((task) => task.id));
    expect(view.dependencies.filter((link) => added.has(link.from as number) && !added.has(link.to as number))).toEqual([]);
    expect(view.end).toBe(before.end);
  });

  it('brings leads, finish-to-finish links, part-time crews and time ranges that follow their tasks', async () => {
    const { A, B } = await session.start();
    // Both clients draw the bands, as the Gantt does; the drawn ranges must never travel in a revision.
    const detach = [attachBands(A.project), attachBands(B.project)];
    const pad = snippet('pad-foundation');
    const result = await dropSnippet(A.project, placementFor(taskOf(A, SEED.ceilings), 'after'), planSnippet(pad, defaultTweaks(pad)), 'fit');
    // The panel lets the next drop through once the server has the first (two unconfirmed inserts into
    // one group can come back in a different order on another client).
    await session.converge(engineWarnings);
    const floor = snippet('floor-topping-and-floor');
    await dropSnippet(A.project, placementFor(taskOf(A, SEED.board), 'after'), planSnippet(floor, { ...defaultTweaks(floor), repeats: 2 }), 'fit');
    const view = await session.converge(engineWarnings);
    const cure = named(view, 'Cure the concrete');
    const backfill = named(view, 'Backfill & compact around the footing');
    expect(view.dependencies.filter((link) => link.from === cure.id && link.to === backfill.id)).toEqual([expect.objectContaining({ type: 2, lag: -2 })]);
    expect(view.assignments.filter((assignment) => assignment.event === cure.id).map((assignment) => assignment.units)).toEqual([20]);
    const decorate = view.tasks.filter((task) => task.name === 'Paint walls & ceilings');
    expect(decorate).toHaveLength(2);
    expect(view.dependencies.some((link) => link.to === decorate[0]!.id && link.type === 3)).toBe(true);

    // The top task carries where it came from and its bands; every client draws the same bands.
    const top = taskOf(B, result.tops[0]!.id as number) as TaskModel & { libraryRef: string; bands: unknown[] };
    expect(top.libraryRef).toBe('pad-foundation');
    expect(top.bands).toEqual([{ name: 'Curing: no loads on the footing', tone: 'sky', from: { path: [1, 2], edge: 'end' }, to: { path: [1, 3], edge: 'end' } }]);
    const bands = bandRanges(B.project);
    expect(bands.map((band) => band.name).sort()).toEqual([
      'Curing: no loads on the footing',
      'Floor topping drying: keep foot traffic off – area 1',
      'Floor topping drying: keep foot traffic off – area 2',
    ]);
    const curing = bands.find((band) => band.name.startsWith('Curing'))!;
    const pour = taskOf(B, named(view, 'Pour the footing').id as number);
    expect(curing.startDate.getTime()).toBe((pour.endDate as Date).getTime());
    expect(curing.endDate.getTime()).toBe((taskOf(B, cure.id as number).endDate as Date).getTime());
    expect(bandRanges(A.project).map((band) => band.id).sort()).toEqual(bands.map((band) => band.id).sort());
    expect((B.project as unknown as { timeRangeStore: { count: number } }).timeRangeStore.count).toBe(3);
    expect(session.relay.allRows().some((row) => 'timeRanges' in row.changes)).toBe(false);
    expect(session.relay.allRows().filter((row) => Object.keys(row.changes).length === 0), 'no revision is made for the drawn ranges alone').toEqual([]);
    detach.forEach((stop) => stop());
  });

  it('converges when the other client changes the task the drop follows at the same time', async () => {
    const { A, B } = await session.start();
    const plan = planSnippet(snippet('medical-gas-zone'), { ...defaultTweaks(snippet('medical-gas-zone')), repeats: 3 });
    const dropping = dropSnippet(A.project, placementFor(taskOf(A, SEED.ceilings), 'after'), plan, 'push');
    const resizing = queue(B, async () => {
      void (taskOf(B, SEED.ceilings) as TaskModel & { setDuration(days: number): Promise<void> }).setDuration(9);
      await B.project.commitAsync();
    });
    await Promise.all([dropping, resizing]);
    const view = await session.converge(engineWarnings);
    expect(row(view, SEED.ceilings).duration).toBe(9);
    const zones = view.tasks.filter((task) => task.name.startsWith('Medical gas zone (one floor) – floor'));
    expect(zones.map((zone) => zone.name)).toEqual([1, 2, 3].map((n) => `Medical gas zone (one floor) – floor ${n}`));
    expect(named(view, 'Install copper piping: oxygen, vacuum & air', zones[0]!.wbs).start).toBe(workStart(A, row(view, SEED.ceilings).end));
    for (const later of [SEED.lighting, SEED.grilles, SEED.sanitaryware]) {
      expect(linkIds(view, zones[2]!.id, later), `floor 3 -> ${later}`).toHaveLength(1);
    }
    expect(row(view, SEED.lighting).start! >= workStart(A, zones[2]!.end)!).toBe(true);
  });

  it('converges when another client deleted a task the drop re-links, before the drop reached the server', async () => {
    const { A, B } = await session.start();
    session.relay.pause();
    taskOf(B, SEED.decoration).remove();
    await vi.waitFor(() => expect(session.relay.revisionCount).toBe(1));
    const plan = planSnippet(snippet('nurse-call-data'), defaultTweaks(snippet('nurse-call-data')));
    await dropSnippet(A.project, placementFor(taskOf(A, SEED.board), 'after'), plan, 'push');
    await vi.waitFor(() => expect(session.relay.revisionCount).toBe(2));
    session.relay.resume();
    const view = await session.converge(engineWarnings);
    expect(view.tasks.some((task) => task.id === SEED.decoration)).toBe(false);
    const top = named(view, 'Nurse call & data (one floor)');
    expect(linkIds(view, top.id, SEED.ceilings)).toHaveLength(1);
    expect(view.dependencies.some((link) => link.from === null || link.to === null || link.to === SEED.decoration)).toBe(false);
  });
});

/**
 * Conflicts of the sync layer the library ran into, reproduced WITHOUT library code (a plain
 * dependency added in a transaction); the edit-path suite (test/sync/edit-paths.test.ts) covers them
 * on its own fixture too.
 */
describe('sync-layer conflicts (no library code involved)', () => {
  const addLink = (peer: Peer, from: number, to: number) =>
    runProjectTransaction(peer.project, 'Link', () => {
      peer.project.dependencyStore.add({ fromEvent: from, toEvent: to, type: 2 } as never);
    });

  it('a link to a task reaches the server first while another client deletes that task: the deletion wins everywhere', async () => {
    const { A, B } = await session.start();
    const linking = addLink(A, SEED.ceilings, SEED.decoration);
    taskOf(B, SEED.decoration).remove();
    await linking;
    const view = await session.converge(engineWarnings);
    expect(view.tasks.some((task) => task.id === SEED.decoration)).toBe(false);
    expect(view.dependencies.some((link) => link.to === SEED.decoration || link.from === null || link.to === null)).toBe(false);
  });

  it('a link into a split task while another client resizes a predecessor of it: the clients agree on the split task', async () => {
    const { A, B } = await session.start();
    const linking = addLink(A, SEED.ceilings, SEED.decoration);
    const resizing = queue(B, async () => {
      void (taskOf(B, SEED.board) as TaskModel & { setDuration(days: number): Promise<void> }).setDuration(9);
      await B.project.commitAsync();
    });
    await Promise.all([linking, resizing]);
    const view = await session.converge(engineWarnings);
    expect(row(view, SEED.board).duration).toBe(9);
    expect(linkIds(view, SEED.ceilings, SEED.decoration)).toHaveLength(1);
    expect(row(view, SEED.decoration).start).toBe(workStart(A, row(view, SEED.ceilings).end));
  });
});

describe('what a drop will do (shown while dragging)', () => {
  it('works out the placement for each zone of a row', async () => {
    const { A } = await session.start();
    const board = taskOf(A, SEED.board);
    expect(ids(placementFor(taskOf(A, SEED.ceilings), 'before'))).toEqual({ kind: 'after', anchor: SEED.xray });
    expect(ids(placementFor(board, 'before'))).toEqual({ kind: 'first', parent: SEED.partitions, before: SEED.board });
    expect(ids(placementFor(taskOf(A, SEED.partitions), 'first-child'))).toEqual({ kind: 'first', parent: SEED.partitions, before: SEED.board });
    // A task cannot take children: "inside" a task lands after it.
    expect(ids(placementFor(board, 'inside'))).toEqual({ kind: 'after', anchor: SEED.board });
    // Dropped after a whole work package: every link leaving it moves onto the new work.
    const afterGroup = linksToMove(placementFor(taskOf(A, SEED.partitions), 'after')) as DependencyModel[];
    expect(afterGroup.length).toBeGreaterThan(3);
    expect(afterGroup.every((link) => ((link.fromEvent as unknown as TaskModel).parent as TaskModel).id === SEED.partitions)).toBe(true);
    expect(afterGroup.every((link) => ((link.toEvent as unknown as TaskModel).parent as TaskModel).id !== SEED.partitions)).toBe(true);
  });
});
