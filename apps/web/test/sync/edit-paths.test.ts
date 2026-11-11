/**
 * Every way the Gantt edits a project, end to end through the sync layer. Two live clients edit
 * through RevisionSync and an InMemoryRelay that behaves like `submit_revision` (one ordered log,
 * dedupe, every phantom id replaced in every string of the payload). After each scenario all
 * clients must agree on a canonical projection of the project (tree and order, WBS, schedule,
 * segments, cost fields, dependencies, assignments, crews) without any of them falling out of
 * sync, and two fresh clients must reload the same project: one from the base snapshot plus the
 * full revision log, one from a live client's snapshot (what `save_snapshot` stores).
 *
 * The edits call the model APIs the Gantt features call (TaskDrag `putStartDate`, TaskResize
 * `setDuration`, RowReorder `tryInsertChild`, TaskCopyPaste's copy and insert, ...), wrapped the
 * way `enableTransactionalFeatures` wraps them: one STM transaction inside the project queue.
 */
import type { ProjectModel, TaskModel } from '@bryntum/gantt';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COPY_RESET_VALUES, prepareCopiedTasks } from '../../src/gantt/project';
import { InMemoryRelay } from '../../src/sync/in-memory-relay';
import type { RevisionTransport } from '../../src/sync/transport';
import { EDIT_IDS as ID, editPathsData } from '../fixtures/edit-paths-data';
import { PROJECT_ID, loadResult } from './helpers';
import { dispose, join, settlePeers, type Peer } from './peers';

// ---- clients ------------------------------------------------------------------------------------

/** Holds every submit until `release()`, so the client keeps editing records the server has not seen. */
function gatedTransport(inner: RevisionTransport): RevisionTransport & { release(): void } {
  let open = false;
  const waiting: Array<() => void> = [];
  return {
    async submit(rev) {
      if (!open) {
        await new Promise<void>((resolve) => waiting.push(resolve));
      }
      return inner.submit(rev);
    },
    fetchAfter: (revisionNo) => inner.fetchAfter(revisionNo),
    subscribe: (handlers) => inner.subscribe(handlers),
    release() {
      open = true;
      for (const resume of waiting.splice(0)) {
        resume();
      }
    },
  };
}

let relay: InMemoryRelay;
let peers: Peer[];
let engineWarnings: string[];
let reloads = 0;

async function start(transportA?: (inner: RevisionTransport) => RevisionTransport): Promise<{ A: Peer; B: Peer }> {
  const A = await join(relay, 'A', loadResult(editPathsData()), transportA?.(relay.connect('A')));
  const B = await join(relay, 'B', loadResult(editPathsData()));
  peers.push(A, B);
  return { A, B };
}

beforeEach(() => {
  relay = new InMemoryRelay({ projectId: PROJECT_ID, snapshot: editPathsData() });
  peers = [];
  engineWarnings = [];
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    engineWarnings.push(args.map(String).join(' '));
  });
});

afterEach(() => {
  peers.forEach(dispose);
  vi.restoreAllMocks();
});

// ---- settling and convergence ---------------------------------------------------------------------

/** Settles the clients (all of them by default) through the relay of this test. */
const settle = (clients: Peer[] = peers, timeoutMs = 8_000) => settlePeers(relay, clients, timeoutMs);

const pad = (n: number) => String(n).padStart(2, '0');
const stamp = (value: unknown): string | null =>
  value instanceof Date
    ? `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}T${pad(value.getHours())}:${pad(value.getMinutes())}`
    : null;
const round = (value: unknown) => (typeof value === 'number' ? Math.round(value * 1e4) / 1e4 : value);
const byId = <T extends { id: unknown }>(a: T, b: T) => String(a.id).localeCompare(String(b.id), 'en', { numeric: true });

interface Segment {
  startDate: Date;
  endDate: Date;
  duration: number;
}

interface Task {
  id: number | string;
  name: string;
  parent: Task;
  isRoot: boolean;
  children?: Task[] | boolean;
  parentIndex: number;
  orderedParentIndex: number;
  wbsValue: unknown;
  startDate: Date | null;
  endDate: Date | null;
  duration: number;
  percentDone: number;
  constraintType: string | null;
  constraintDate: Date | null;
  segments: Segment[] | null;
  note: string | null;
  costCode: string;
  budgetMinor: number;
  forecastMinor: number;
  incurredMinor: number;
  paidMinor: number;
  decisionRef: string | null;
  set(data: Record<string, unknown>): void;
}

interface Dependency {
  id: number | string;
  fromEvent: unknown;
  toEvent: unknown;
  type: number;
  lag: number;
  lagUnit: string;
  active: boolean;
  data: Record<string, unknown>;
  set(data: Record<string, unknown>): void;
  remove(): void;
}

interface Assignment {
  id: unknown;
  event: Task | null;
  resource: { id: unknown } | null;
  resourceId: unknown;
  units: number;
  persistableData: Record<string, unknown>;
  set(data: Record<string, unknown>): void;
  remove(): void;
}

const endpoint = (event: unknown) => (event as Task | null)?.id ?? null;

/** Everything a user can see or a reload must reproduce, in a form two projects can be compared on. */
function projection(project: ProjectModel) {
  const tasks = (project.taskStore.allRecords as unknown as Task[]).map((task) => ({
    id: task.id,
    parentId: task.parent?.isRoot ? null : (task.parent?.id ?? null),
    parentIndex: task.parentIndex,
    orderedParentIndex: task.orderedParentIndex,
    wbs: String(task.wbsValue),
    children: Array.isArray(task.children) ? task.children.map((child) => child.id) : [],
    name: task.name,
    start: stamp(task.startDate),
    end: stamp(task.endDate),
    duration: round(task.duration),
    percentDone: round(task.percentDone),
    constraintType: task.constraintType ?? null,
    constraintDate: stamp(task.constraintDate),
    segments: task.segments?.map((segment) => [stamp(segment.startDate), stamp(segment.endDate), round(segment.duration)]) ?? null,
    note: task.note ?? null,
    costCode: task.costCode,
    budgetMinor: task.budgetMinor,
    forecastMinor: task.forecastMinor,
    incurredMinor: task.incurredMinor,
    paidMinor: task.paidMinor,
    decisionRef: task.decisionRef,
  }));
  const dependencies = (project.dependencyStore.allRecords as unknown as Dependency[]).map((dependency) => ({
    id: dependency.id,
    from: endpoint(dependency.fromEvent),
    to: endpoint(dependency.toEvent),
    type: dependency.type,
    lag: dependency.lag,
    lagUnit: dependency.lagUnit,
    active: dependency.active,
  }));
  const assignments = (project.assignmentStore.allRecords as unknown as Assignment[]).map(
    (assignment) => ({ id: assignment.id, event: assignment.event?.id ?? null, resource: assignment.resource?.id ?? null, units: assignment.units }),
  );
  const resources = (project.resourceStore.allRecords as unknown as { id: unknown; name: string; kind: string; company: string; eventColor: string | null }[]).map(
    (resource) => ({ id: resource.id, name: resource.name, kind: resource.kind, company: resource.company, eventColor: resource.eventColor ?? null }),
  );
  return {
    roots: (project.taskStore.rootNode.children as unknown as Task[]).map((task) => task.id),
    end: stamp(project.endDate),
    tasks: tasks.sort(byId),
    dependencies: dependencies.sort(byId),
    assignments: assignments.sort(byId),
    resources: resources.sort(byId),
  };
}

type Projection = ReturnType<typeof projection>;

function expectHealthy(peer: Peer): void {
  expect(peer.sync.state, `${peer.id} sync state`).toMatchObject({ status: 'synced', pending: 0, lastRevision: relay.currentRevisionNo });
  expect(peer.states.filter((state) => state.status === 'error'), `${peer.id} never errored`).toEqual([]);
  expect(peer.warnings, `${peer.id} warnings`).toEqual([]);
}

function expectRealIds(view: Projection): void {
  const ids = [...view.tasks, ...view.dependencies, ...view.assignments, ...view.resources].map((record) => record.id);
  expect(ids.filter((id) => typeof id !== 'number'), 'records still carrying a phantom id').toEqual([]);
}

/**
 * Settles, then asserts every live client holds the same project and is healthy, and that a reload
 * (base snapshot + full log) and a boot from a live snapshot reproduce it without emitting revisions.
 */
async function converge(): Promise<Projection> {
  await settle();
  const [first, ...rest] = peers;
  if (!first) {
    throw new Error('no clients');
  }
  const reference = projection(first.project);
  for (const peer of rest) {
    expect(projection(peer.project), `${peer.id} matches ${first.id}`).toEqual(reference);
  }
  peers.forEach(expectHealthy);
  expectRealIds(reference);
  expect(engineWarnings, 'warnings from the engine').toEqual([]);

  const head = relay.currentRevisionNo;
  reloads++;
  const fromLog = await join(relay, `reload-log-${reloads}`, loadResult(editPathsData(), 0, relay.allRows()));
  const fromSnapshot = await join(relay, `reload-snapshot-${reloads}`, relay.loadResultFor(PROJECT_ID, first.project, head));
  try {
    await settle([...peers, fromLog, fromSnapshot]);
    expect(projection(fromLog.project), 'reload from the base snapshot and the full log').toEqual(reference);
    expect(projection(fromSnapshot.project), 'boot from a live snapshot').toEqual(reference);
    expect(relay.currentRevisionNo, 'a reload emits no revisions').toBe(head);
    expectHealthy(fromLog);
    expectHealthy(fromSnapshot);
  } finally {
    dispose(fromLog);
    dispose(fromSnapshot);
  }
  return reference;
}

const view = (peer: Peer, id: unknown) => {
  const record = projection(peer.project).tasks.find((task) => task.id === id);
  if (!record) {
    throw new Error(`task ${String(id)} is not in ${peer.id}`);
  }
  return record;
};

// ---- edits the way the Gantt makes them ------------------------------------------------------------

interface Stm {
  isRecording: boolean;
  autoRecord: boolean;
  startTransaction(title?: string): void;
  stopTransaction(title?: string): void;
  rejectTransaction(): void;
  undo(): Promise<void>;
  redo(): Promise<void>;
  canUndo: boolean;
  canRedo: boolean;
}

interface Queued {
  queue(step: () => unknown): Promise<unknown>;
}

const stmOf = (peer: Peer) => peer.project.stm as unknown as Stm;
const queue = (peer: Peer, step: () => unknown) => (peer.project as unknown as Queued).queue(step);

/** A feature edit with `enableTransactionalFeatures` (cell edit, task editor, drag, paste): one STM transaction in the queue. */
async function transaction(peer: Peer, change: () => unknown): Promise<void> {
  const stm = stmOf(peer);
  await queue(peer, async () => {
    if (stm.isRecording) {
      stm.stopTransaction();
    }
    const { autoRecord } = stm;
    stm.autoRecord = false;
    stm.startTransaction();
    try {
      await change();
      await peer.project.commitAsync();
      stm.stopTransaction();
    } catch (error) {
      if (stm.isRecording) {
        stm.rejectTransaction();
      }
      throw error;
    } finally {
      stm.autoRecord = autoRecord;
    }
  });
}

const task = (peer: Peer, id: unknown) => {
  const record = peer.project.taskStore.getById(id as number);
  if (!record) {
    throw new Error(`task ${String(id)} is missing in ${peer.id}`);
  }
  return record as unknown as Task & TreeOps;
};

interface TreeOps {
  insertChild(child: unknown, before?: unknown, silent?: boolean, options?: { orderedBeforeNode?: unknown }): Task | Task[];
  appendChild(child: unknown, silent?: boolean): Task | Task[];
  tryInsertChild(child: unknown, before?: unknown): Promise<boolean>;
  nextSibling: Task | null;
  nextOrderedSibling: Task | null;
  firstChild: Task | null;
  remove(): void;
  traverse(fn: (node: Task) => void): void;
  copy(): Task & TreeOps;
  sortOrderedChildren(deep: boolean, silent: boolean): void;
  refreshWbs(options: { deep: boolean; useOrderedTree: boolean }): void;
  assignments: Assignment[];
  predecessors: Dependency[];
  successors: Dependency[];
  allChildren: Task[];
  setStartDate(date: Date, keepDuration?: boolean): Promise<void>;
  putStartDate(date: Date, keepDuration?: boolean): void;
  setEndDate(date: Date, keepDuration?: boolean): Promise<void>;
  setDuration(duration: number): Promise<void>;
  splitToSegments(from: Date, lag?: number): Promise<void>;
  mergeSegments(): Promise<void>;
}

const first = <T>(added: T | T[]): T => (Array.isArray(added) ? (added[0] as T) : added);

/** GanttBase.addTask below a reference task (the new task takes the reference's dates). */
function addTaskBelow(peer: Peer, referenceId: unknown, data: Record<string, unknown>): Task {
  const reference = task(peer, referenceId);
  const record = peer.project.taskStore.createRecord({ startDate: reference.startDate ?? undefined, duration: reference.duration, ...data });
  return first(
    (reference.parent as unknown as TreeOps).insertChild(record, reference.nextSibling, false, { orderedBeforeNode: reference.nextOrderedSibling }),
  );
}

/** GanttBase.addSubtask: the new task becomes the first child. */
function addSubtask(peer: Peer, parentId: unknown, data: Record<string, unknown>): Task {
  const parent = task(peer, parentId);
  const record = peer.project.taskStore.createRecord({ startDate: parent.startDate, duration: 1, ...data });
  return first(parent.insertChild(record, parent.firstChild)) as Task;
}

/** The Gantt's indent/outdent: queued, the store runs its own transaction. */
const indent = (peer: Peer, id: unknown) =>
  queue(peer, () => (peer.project.taskStore as unknown as { indent(r: unknown): Promise<boolean> }).indent([task(peer, id)]));
const outdent = (peer: Peer, id: unknown) =>
  queue(peer, () => (peer.project.taskStore as unknown as { outdent(r: unknown): Promise<boolean> }).outdent([task(peer, id)]));

/** RowReorder drop: `parent.tryInsertChild(records, before)` queues and records its own transaction. */
const dropRow = (peer: Peer, id: unknown, parentId: unknown, beforeId: unknown) =>
  task(peer, parentId).tryInsertChild(task(peer, id), beforeId == null ? null : task(peer, beforeId));

interface Clipboard {
  originals: (Task & TreeOps)[];
}

/**
 * TaskCopyPaste: copies are deep (a copied parent brings its children), only dependencies between
 * copied tasks are copied, and every copied task's assignments are copied. `beforePaste` gets the
 * copies before they are inserted below the reference row; the app resets them there.
 */
async function paste(peer: Peer, clipboard: Clipboard, referenceId: unknown): Promise<Task[]> {
  const idMap = new Map<unknown, Task & TreeOps>();
  const all: (Task & TreeOps)[] = [];
  for (const root of clipboard.originals) {
    root.traverse((node) => {
      if (!all.includes(node as Task & TreeOps)) {
        all.push(node as Task & TreeOps);
      }
    });
  }
  const tops: (Task & TreeOps)[] = [];
  for (const node of all) {
    const copy = node.copy();
    copy.name = `${node.name} (copy)`;
    idMap.set(node.id, copy);
    const parent = idMap.get(node.parent.id);
    if (parent && all.includes(node.parent as Task & TreeOps)) {
      parent.appendChild(copy, true);
    } else {
      tops.push(copy);
    }
  }
  tops.forEach((top) => top.sortOrderedChildren(true, true));

  const dependencies = new Map<unknown, Record<string, unknown>>();
  for (const node of all) {
    for (const dependency of [...node.predecessors, ...node.successors]) {
      const from = endpoint(dependency.fromEvent);
      const to = endpoint(dependency.toEvent);
      if (idMap.has(from) && idMap.has(to) && !dependencies.has(dependency.id)) {
        dependencies.set(dependency.id, {
          ...dependency.data,
          id: undefined,
          from: undefined,
          to: undefined,
          fromTask: undefined,
          toTask: undefined,
          fromEvent: idMap.get(from)!.id,
          toEvent: idMap.get(to)!.id,
        });
      }
    }
  }
  const assignments = all.flatMap((node) =>
    node.assignments.map((assignment) => ({
      ...assignment.persistableData,
      eventId: idMap.get(node.id)!.id,
      resourceId: assignment.resourceId,
      event: undefined,
      resource: undefined,
      id: undefined,
    })),
  );

  // beforePaste
  prepareCopiedTasks(tops as unknown as TaskModel[]);

  const reference = task(peer, referenceId);
  await transaction(peer, async () => {
    (reference.parent as unknown as TreeOps).insertChild(tops, reference.nextSibling, false, { orderedBeforeNode: reference.nextOrderedSibling });
    tops.forEach((top) => top.refreshWbs({ deep: true, useOrderedTree: true }));
    peer.project.dependencyStore.add([...dependencies.values()]);
    peer.project.assignmentStore.add(assignments as never);
    await peer.project.commitAsync();
  });
  return tops;
}

/** Cut and paste below the reference row moves the originals (TaskCopyPaste with `isCut`). */
const cutPaste = (peer: Peer, ids: unknown[], referenceId: unknown) =>
  transaction(peer, () => {
    const reference = task(peer, referenceId);
    (reference.parent as unknown as TreeOps).insertChild(
      ids.map((id) => task(peer, id)),
      reference.nextSibling,
      false,
      { orderedBeforeNode: reference.nextOrderedSibling },
    );
  });

/** The undo/redo widget with revisions on: queued, followed by a commit. */
const undo = (peer: Peer) =>
  queue(peer, () => {
    void stmOf(peer).undo();
    return peer.project.commitAsync();
  });
const redo = (peer: Peer) =>
  queue(peer, () => {
    void stmOf(peer).redo();
    return peer.project.commitAsync();
  });

const day = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y!, m! - 1, d!);
};

const dependency = (peer: Peer, from: unknown, to: unknown) =>
  (peer.project.dependencyStore.allRecords as unknown as Dependency[]).find(
    (record) => endpoint(record.fromEvent) === from && endpoint(record.toEvent) === to,
  );

const assignment = (peer: Peer, event: unknown, resource: unknown) =>
  (peer.project.assignmentStore.allRecords as unknown as Assignment[]).find(
    (record) => record.event?.id === event && record.resource?.id === resource,
  );

// =====================================================================================================

describe('task CRUD', () => {
  it('adds a task as a sibling below another', async () => {
    const { A } = await start();
    const added = addTaskBelow(A, ID.columnBases, { name: 'Anchor bolts' });
    const view0 = await converge();
    const row = view0.tasks.find((candidate) => candidate.id === added.id)!;
    expect(row).toMatchObject({ parentId: ID.columns, name: 'Anchor bolts', wbs: '2.1.1.2', parentIndex: 1 });
    expect(view0.tasks.find((candidate) => candidate.id === ID.columnErection)?.wbs).toBe('2.1.1.3');
  });

  it('adds a task as the first child of a level-3 parent, and a child under a leaf with assignments', async () => {
    const { A, B } = await start();
    const child = addSubtask(A, ID.columns, { name: 'Layout', duration: 1 });
    const underLeaf = addSubtask(B, ID.stripOut, { name: 'Selective demolition', duration: 2 });
    const result = await converge();
    expect(result.tasks.find((row) => row.id === child.id)).toMatchObject({ parentId: ID.columns, wbs: '2.1.1.1', parentIndex: 0 });
    expect(view(A, ID.columnBases).wbs).toBe('2.1.1.2');
    expect(result.tasks.find((row) => row.id === underLeaf.id)).toMatchObject({ parentId: ID.stripOut, wbs: '1.2.1' });
    expect(view(B, ID.stripOut).children).toEqual([underLeaf.id]);
  });

  it('adds a whole subtree in one transaction: parent, children and the dependencies between them', async () => {
    const { A } = await start();
    let ids: unknown[] = [];
    await transaction(A, () => {
      const phase = first(task(A, ID.structure).insertChild({ name: 'Cladding', expanded: true }, task(A, ID.roofDeck))) as Task & TreeOps;
      const rails = first(phase.appendChild({ name: 'Rails', duration: 2 })) as Task & TreeOps;
      const sub = first(phase.appendChild({ name: 'Panels', expanded: true })) as Task & TreeOps;
      const panels = first(sub.appendChild({ name: 'Panel install', duration: 3 })) as Task;
      A.project.dependencyStore.add([
        { fromEvent: ID.beams, toEvent: rails.id },
        { fromEvent: rails.id, toEvent: panels.id },
      ]);
      A.project.assignmentStore.add({ event: panels.id, resource: ID.steelErectors, units: 50 });
      ids = [phase.id, rails.id, sub.id, panels.id];
    });
    const result = await converge();
    const [phase, rails, sub, panels] = ids.map((id) => {
      const real = relay.realIdFor(String(id));
      expect(real, `phantom ${String(id)} was mapped`).toBeTypeOf('number');
      return result.tasks.find((row) => row.id === real)!;
    });
    expect(phase).toMatchObject({ parentId: ID.structure, wbs: '2.3', children: [rails!.id, sub!.id] });
    expect(panels).toMatchObject({ parentId: sub!.id, wbs: '2.3.2.1', start: rails!.end });
    expect(result.dependencies.filter((row) => row.to === rails!.id || row.to === panels!.id)).toHaveLength(2);
    expect(result.assignments.find((row) => row.event === panels!.id)).toMatchObject({ resource: ID.steelErectors, units: 50 });
  });

  it('adds a child under a parent the server has not seen yet, and under one it has not acknowledged', async () => {
    let gate!: ReturnType<typeof gatedTransport>;
    const { A } = await start((inner) => (gate = gatedTransport(inner)));
    const unseen = addSubtask(A, ID.completion, { name: 'Punch list' });
    await vi.waitFor(() => expect(A.sync.state.pending).toBe(1));
    const child = first((unseen as unknown as TreeOps).appendChild({ name: 'Punch walk', startDate: unseen.startDate, duration: 1 })) as Task;
    await vi.waitFor(() => expect(A.sync.state.pending).toBe(2));
    expect(relay.revisionCount).toBe(0);
    gate.release();
    let result = await converge();
    expect(result.tasks.find((row) => row.id === child.id)).toMatchObject({ parentId: unseen.id, wbs: '3.1.1' });

    // Accepted by the server, response lost: the client still holds the phantom when it adds the child.
    relay.failNextSubmits(1, 'after');
    relay.pause();
    const unacknowledged = addSubtask(A, ID.enabling, { name: 'Site fence' });
    await vi.waitFor(() => expect(relay.revisionCount).toBeGreaterThan(0));
    const phantom = unacknowledged.id;
    expect(String(phantom)).toMatch(/^_generated/);
    const grandchild = first(
      (unacknowledged as unknown as TreeOps).appendChild({ name: 'Site fence panels', startDate: unacknowledged.startDate, duration: 1 }),
    ) as Task;
    relay.resume();
    result = await converge();
    expect(unacknowledged.id).toBe(relay.realIdFor(String(phantom)));
    expect(result.tasks.find((row) => row.id === grandchild.id)).toMatchObject({ parentId: unacknowledged.id, wbs: '1.1.1' });
  });

  it('renames a task', async () => {
    const { A } = await start();
    await transaction(A, () => {
      task(A, ID.columnErection).name = 'Column erection (level 1)';
    });
    await converge();
    expect(view(peers[1]!, ID.columnErection).name).toBe('Column erection (level 1)');
  });

  it('edits notes and cost fields', async () => {
    const { A, B } = await start();
    await transaction(A, () => {
      task(A, ID.beams).set({ note: 'Grade S355', budgetMinor: 1_250_000, forecastMinor: 1_300_000, costCode: 'ST-13A' });
    });
    task(B, ID.stripOut).set({ incurredMinor: 900_000, paidMinor: 450_000 });
    await converge();
    expect(view(B, ID.beams)).toMatchObject({ note: 'Grade S355', budgetMinor: 1_250_000, forecastMinor: 1_300_000, costCode: 'ST-13A' });
    expect(view(A, ID.stripOut)).toMatchObject({ incurredMinor: 900_000, paidMinor: 450_000 });
  });

  it('deletes a leaf with its dependencies and assignments', async () => {
    const { A } = await start();
    task(A, ID.stripOut).remove();
    const result = await converge();
    expect(result.tasks.some((row) => row.id === ID.stripOut)).toBe(false);
    expect(result.dependencies.some((row) => row.from === ID.stripOut || row.to === ID.stripOut)).toBe(false);
    expect(result.assignments.some((row) => row.event === ID.stripOut)).toBe(false);
  });

  it('deletes a parent whose descendants have dependencies and assignments', async () => {
    const { B } = await start();
    task(B, ID.frame).remove();
    const result = await converge();
    for (const id of [ID.frame, ID.columns, ID.columnBases, ID.columnErection, ID.beams]) {
      expect(result.tasks.some((row) => row.id === id)).toBe(false);
    }
    expect(result.dependencies.map((row) => row.id)).toEqual([1, 2, 8, 9]);
    expect(result.assignments.map((row) => row.id)).toEqual([1, 2, 3, 4, 9]);
    expect(view(B, ID.crane).wbs).toBe('2.1');
  });
});

describe('scheduling from the timeline', () => {
  it('moves a task by date (task drag): constraint set, successors follow', async () => {
    const { A } = await start();
    await transaction(A, () => task(A, ID.crane).putStartDate(day('2026-11-11'), true));
    await converge();
    expect(view(peers[1]!, ID.crane)).toMatchObject({ start: '2026-11-11T00:00', constraintType: 'startnoearlierthan', constraintDate: '2026-11-11T00:00' });
    expect(view(peers[1]!, ID.columnErection).start).toBe('2026-11-13T00:00');
  });

  it('resizes a task (duration) and sets its end date', async () => {
    const { A, B } = await start();
    await transaction(A, () => task(A, ID.columnBases).setDuration(4));
    await converge();
    expect(view(B, ID.columnBases).duration).toBe(4);
    await transaction(B, () => task(B, ID.commissioning).setEndDate(day('2026-12-01'), false));
    await converge();
    expect(view(A, ID.commissioning)).toMatchObject({ end: '2026-12-01T00:00', duration: 3 });
  });

  it('drags percent done and rolls it up', async () => {
    const { A } = await start();
    await transaction(A, () => {
      task(A, ID.columnBases).percentDone = 50;
    });
    await converge();
    expect(view(peers[1]!, ID.columnBases).percentDone).toBe(50);
    expect(view(peers[1]!, ID.columns).percentDone).toBeGreaterThan(0);
  });
});

describe('tree structure', () => {
  it('indents a task under its previous sibling', async () => {
    const { A } = await start();
    await indent(A, ID.crane);
    const result = await converge();
    expect(view(A, ID.crane)).toMatchObject({ parentId: ID.frame, wbs: '2.1.3' });
    expect(view(A, ID.roofDeck).wbs).toBe('2.2');
    expect(result.tasks.find((row) => row.id === ID.frame)?.children).toEqual([ID.columns, ID.beams, ID.crane]);
  });

  it('outdents a task out of a level-3 parent', async () => {
    const { B } = await start();
    await outdent(B, ID.columnErection);
    const result = await converge();
    expect(view(B, ID.columnErection)).toMatchObject({ parentId: ID.frame, wbs: '2.1.2' });
    expect(result.tasks.find((row) => row.id === ID.frame)?.children).toEqual([ID.columns, ID.columnErection, ID.beams]);
    expect(view(B, ID.beams).wbs).toBe('2.1.3');
  });

  it('reorders a task within its parent (row drag)', async () => {
    const { A } = await start();
    await dropRow(A, ID.roofDeck, ID.structure, ID.frame);
    const result = await converge();
    expect(result.tasks.find((row) => row.id === ID.structure)?.children).toEqual([ID.roofDeck, ID.frame, ID.crane]);
    expect(view(A, ID.roofDeck).wbs).toBe('2.1');
    expect(view(A, ID.beams).wbs).toBe('2.2.2');
  });

  it('moves a task to another parent at a deeper level (row drag-drop)', async () => {
    const { A } = await start();
    await dropRow(A, ID.commissioning, ID.columns, ID.columnErection);
    const result = await converge();
    expect(result.tasks.find((row) => row.id === ID.columns)?.children).toEqual([ID.columnBases, ID.commissioning, ID.columnErection]);
    expect(view(A, ID.commissioning).wbs).toBe('2.1.1.2');
    expect(view(A, ID.handover).wbs).toBe('3.1');
  });

  it('moves a subtree to the end of another parent', async () => {
    const { B } = await start();
    await dropRow(B, ID.columns, ID.completion, null);
    await converge();
    expect(view(B, ID.columns)).toMatchObject({ parentId: ID.completion, wbs: '3.3' });
    expect(view(B, ID.columnErection).wbs).toBe('3.3.2');
  });
});

describe('copy and paste', () => {
  it('pastes a deep copy with its internal dependencies and assignments, progress and payments reset', async () => {
    const { A } = await start();
    task(A, ID.columnBases).set({ percentDone: 60, incurredMinor: 300_000, paidMinor: 100_000, decisionRef: '00000000-0000-4000-8000-00000000d001' });
    await converge();

    const tops = await paste(A, { originals: [task(A, ID.frame)] }, ID.roofDeck);
    const result = await converge();
    const copy = result.tasks.find((row) => row.id === tops[0]!.id)!;
    expect(copy).toMatchObject({ parentId: ID.structure, wbs: '2.4', name: 'Frame (copy)' });
    const copies = result.tasks.filter((row) => row.wbs.startsWith('2.4'));
    expect(copies.map((row) => row.name)).toEqual(
      expect.arrayContaining(['Columns (copy)', 'Column bases (copy)', 'Column erection (copy)', 'Beams (copy)']),
    );
    expect(copies).toHaveLength(5);
    const bases = copies.find((row) => row.name === 'Column bases (copy)')!;
    expect(bases).toMatchObject({ ...COPY_RESET_VALUES, budgetMinor: 900_000, costCode: 'ST-11' });
    const copyIds = new Set(copies.map((row) => row.id));
    // Internal links (bases -> erection -> beams) are copied; links to tasks outside the copy are not.
    const copiedDependencies = result.dependencies.filter((row) => copyIds.has(row.from as number) || copyIds.has(row.to as number));
    expect(copiedDependencies).toHaveLength(2);
    expect(copiedDependencies.every((row) => copyIds.has(row.from as number) && copyIds.has(row.to as number))).toBe(true);
    const copiedAssignments = result.assignments.filter((row) => copyIds.has(row.event as number));
    expect(copiedAssignments.map((row) => [result.tasks.find((t) => t.id === row.event)!.name, row.resource, row.units]).sort()).toEqual(
      [
        ['Beams (copy)', ID.steelErectors, 100],
        ['Column bases (copy)', ID.steelErectors, 100],
        ['Column erection (copy)', ID.mobileCrane, 50],
        ['Column erection (copy)', ID.steelErectors, 100],
      ].sort(),
    );
    // The original keeps its figures.
    expect(view(A, ID.columnBases)).toMatchObject({ percentDone: 60, incurredMinor: 300_000, paidMinor: 100_000 });
  });

  it('pastes a copy of a split task', async () => {
    const { B } = await start();
    const [copy] = await paste(B, { originals: [task(B, ID.roofDeck)] }, ID.handover);
    const result = await converge();
    const row = result.tasks.find((candidate) => candidate.id === copy!.id)!;
    expect(row).toMatchObject({ parentId: ID.completion, wbs: '3.3' });
    expect(row.segments).toHaveLength(2);
  });

  it('cuts and pastes a subtree (a move)', async () => {
    const { A } = await start();
    await cutPaste(A, [ID.columns], ID.commissioning);
    const result = await converge();
    expect(result.tasks.find((row) => row.id === ID.completion)?.children).toEqual([ID.commissioning, ID.columns, ID.handover]);
    expect(view(A, ID.columnErection).wbs).toBe('3.2.2');
    expect(result.dependencies.find((row) => row.id === 4)).toMatchObject({ from: ID.columnBases, to: ID.columnErection });
  });
});

describe('split tasks', () => {
  it('splits a task', async () => {
    const { A } = await start();
    await transaction(A, () => task(A, ID.columnErection).splitToSegments(day('2026-11-12'), 1));
    await converge();
    expect(view(peers[1]!, ID.columnErection).segments).toHaveLength(2);
  });

  it('merges the segments of a split task: one revision, the merged task spans the gap', async () => {
    const { B } = await start();
    const before = view(B, ID.roofDeck);
    await transaction(B, () => task(B, ID.roofDeck).mergeSegments());
    await converge();
    expect(relay.revisionCount).toBe(1);
    expect(view(peers[0]!, ID.roofDeck)).toMatchObject({ segments: null, start: before.start, end: before.end, duration: 5 });
  });

  it('moves and resizes a segment', async () => {
    const { A, B } = await start();
    await transaction(A, () => (task(A, ID.roofDeck).segments![1] as unknown as TreeOps).setStartDate(day('2026-11-23'), true));
    await converge();
    expect(view(B, ID.roofDeck).segments?.[1]?.[0]).toBe('2026-11-23T00:00');
    await transaction(B, () => (task(B, ID.roofDeck).segments![0] as unknown as TreeOps).setDuration(3));
    await converge();
    expect(view(A, ID.roofDeck).segments?.[0]?.[2]).toBe(3);
  });
});

describe('dependencies', () => {
  it('adds a dependency', async () => {
    const { A } = await start();
    A.project.dependencyStore.add({ fromEvent: ID.crane, toEvent: ID.commissioning, type: 2, lag: 2 });
    await converge();
    expect(dependency(peers[1]!, ID.crane, ID.commissioning)).toMatchObject({ type: 2, lag: 2 });
  });

  it('removes a dependency', async () => {
    const { B } = await start();
    dependency(B, ID.stripOut, ID.crane)!.remove();
    await converge();
    expect(dependency(peers[0]!, ID.stripOut, ID.crane)).toBeUndefined();
  });

  it('changes the type and lag of a dependency', async () => {
    const { A } = await start();
    await transaction(A, () => dependency(A, ID.beams, ID.roofDeck)!.set({ type: 2, lag: 3 }));
    await converge();
    expect(dependency(peers[1]!, ID.beams, ID.roofDeck)).toMatchObject({ type: 2, lag: 3 });
  });
});

describe('assignments', () => {
  it('adds, changes the units of and removes assignments', async () => {
    const { A, B } = await start();
    A.project.assignmentStore.add({ event: ID.commissioning, resource: ID.siteCrew, units: 100 });
    await transaction(B, () => assignment(B, ID.columnErection, ID.mobileCrane)!.set({ units: 75 }));
    await converge();
    expect(assignment(B, ID.commissioning, ID.siteCrew)?.units).toBe(100);
    expect(assignment(A, ID.columnErection, ID.mobileCrane)?.units).toBe(75);

    assignment(A, ID.crane, ID.riggers)!.remove();
    await converge();
    expect(assignment(B, ID.crane, ID.riggers)).toBeUndefined();
  });
});

describe('crews', () => {
  it('adds a crew and assigns it in the same transaction', async () => {
    const { A } = await start();
    let phantom = '';
    await transaction(A, () => {
      const [crew] = A.project.resourceStore.add({
        name: 'Glaziers',
        kind: 'labor',
        company: 'Clearview Glass',
        eventColor: 'cyan',
      } as never) as unknown as { id: string }[];
      phantom = crew!.id;
      A.project.assignmentStore.add({ event: ID.roofDeck, resource: crew!.id, units: 100 });
    });
    const result = await converge();
    const real = relay.realIdFor(phantom);
    expect(result.resources.find((row) => row.id === real)).toMatchObject({ name: 'Glaziers', company: 'Clearview Glass', eventColor: 'cyan' });
    expect(result.assignments.find((row) => row.resource === real)).toMatchObject({ event: ID.roofDeck });
  });

  it('renames, recolors and changes the company of a crew', async () => {
    const { B } = await start();
    await transaction(B, () =>
      B.project.resourceStore.getById(ID.riggers)!.set({ name: 'Rigging crew', eventColor: 'red', company: 'Liftright Inc.' }),
    );
    const result = await converge();
    expect(result.resources.find((row) => row.id === ID.riggers)).toMatchObject({ name: 'Rigging crew', eventColor: 'red', company: 'Liftright Inc.' });
  });

  it('deletes a crew that has assignments', async () => {
    const { A } = await start();
    A.project.resourceStore.getById(ID.steelErectors)!.remove();
    const result = await converge();
    expect(result.resources.map((row) => row.id)).toEqual([ID.siteCrew, ID.riggers, ID.mobileCrane]);
    expect(result.assignments.some((row) => row.resource === ID.steelErectors)).toBe(false);
  });
});

describe('undo and redo', () => {
  it('undoes and redoes a rename while another client edits the same task', async () => {
    const { A, B } = await start();
    await transaction(A, () => {
      task(A, ID.columnBases).name = 'Spread footings';
    });
    await converge();
    await transaction(B, () => task(B, ID.columnBases).setDuration(3));
    await converge();
    await undo(A);
    await converge();
    expect(view(B, ID.columnBases)).toMatchObject({ name: 'Column bases', duration: 3 });
    await redo(A);
    await converge();
    expect(view(B, ID.columnBases)).toMatchObject({ name: 'Spread footings', duration: 3 });
  });

  it('undoes the deletion of a parent with dependencies and assignments, then redoes it', async () => {
    const { A } = await start();
    const before = await converge();
    task(A, ID.frame).remove();
    await converge();
    await undo(A);
    const restored = await converge();
    expect(restored).toEqual(before);
    await redo(A);
    const removed = await converge();
    expect(removed.tasks.some((row) => row.id === ID.frame)).toBe(false);
  });

  it('undoes an added task after the server gave it a real id, then redoes it', async () => {
    const { B } = await start();
    const added = addTaskBelow(B, ID.crane, { name: 'Crane test lift' });
    await converge();
    const real = added.id;
    expect(typeof real).toBe('number');
    await undo(B);
    let result = await converge();
    expect(result.tasks.some((row) => row.id === real)).toBe(false);
    await redo(B);
    result = await converge();
    expect(result.tasks.find((row) => row.id === real)).toMatchObject({ name: 'Crane test lift', parentId: ID.structure });
  });
});

describe('concurrent edits', () => {
  it('two clients edit the same task at once', async () => {
    const { A, B } = await start();
    task(A, ID.beams).name = 'Beams (A)';
    task(A, ID.beams).duration = 3;
    task(B, ID.beams).name = 'Beams (B)';
    task(B, ID.beams).percentDone = 25;
    const result = await converge();
    const last = relay
      .allRows()
      .filter((row) => (row.changes.tasks?.$input?.updated ?? []).some((record) => record.id === ID.beams && 'name' in record))
      .at(-1)!;
    const winner = last.client_id === 'A' ? 'Beams (A)' : 'Beams (B)';
    expect(result.tasks.find((row) => row.id === ID.beams)).toMatchObject({ name: winner, duration: 3, percentDone: 25 });
  });

  it('one client deletes a parent while the other adds a child under it', async () => {
    const { A, B } = await start();
    task(A, ID.columns).remove();
    const orphan = addSubtask(B, ID.columns, { name: 'Grouting', duration: 1 });
    B.project.dependencyStore.add({ fromEvent: ID.columnBases, toEvent: orphan.id });
    const result = await converge();
    expect(result.tasks.some((row) => row.id === ID.columns)).toBe(false);
    expect(result.tasks.some((row) => row.id === ID.columnBases)).toBe(false);
  });

  it('links, assignments and moves made against records another client deletes at the same time are dropped everywhere', async () => {
    const { A, B } = await start();
    task(A, ID.beams).remove();
    A.project.resourceStore.getById(ID.riggers)!.remove();
    task(A, ID.completion).remove();
    B.project.dependencyStore.add({ fromEvent: ID.siteSetup, toEvent: ID.beams });
    B.project.assignmentStore.add({ event: ID.columnBases, resource: ID.riggers, units: 100 });
    await dropRow(B, ID.crane, ID.completion, ID.handover);
    const result = await converge();
    expect(result.dependencies.some((row) => row.to === ID.beams || row.from === null || row.to === null)).toBe(false);
    expect(result.assignments.some((row) => row.resource === ID.riggers)).toBe(false);
    expect(result.tasks.find((row) => row.id === ID.crane)).toMatchObject({ parentId: ID.structure });
    expect(result.tasks.some((row) => row.id === ID.completion || row.id === ID.handover)).toBe(false);
  });

  /**
   * Holds broadcasts so that each client's edit is still unconfirmed when the other's arrives: the
   * first client's revision is accepted (the relay answers submits while paused), then the second's.
   */
  async function inOrder(firstPeer: Peer, first: () => unknown, secondPeer: Peer, second: () => unknown): Promise<void> {
    const accepted = async (peer: Peer, edit: () => unknown) => {
      const before = relay.revisionCount;
      await edit();
      await vi.waitFor(() => {
        expect(stmOf(peer).isRecording).toBe(false);
        expect(peer.sync.state.pending).toBe(0);
        expect(relay.revisionCount).toBeGreaterThan(before);
      });
    };
    relay.pause();
    await accepted(firstPeer, first);
    await accepted(secondPeer, second);
    relay.resume();
  }

  it('a link to a split task reaches the server first while another client deletes the task', async () => {
    const { A, B } = await start();
    await inOrder(
      A,
      () => transaction(A, () => A.project.dependencyStore.add({ fromEvent: ID.crane, toEvent: ID.roofDeck })),
      B,
      () => task(B, ID.roofDeck).remove(),
    );
    const result = await converge();
    expect(result.tasks.some((row) => row.id === ID.roofDeck)).toBe(false);
    expect(result.dependencies.some((row) => row.to === ID.roofDeck || row.from === null || row.to === null)).toBe(false);
  });

  it('a child added under, and a crew assigned to, records another client deletes reach the server first', async () => {
    const { A, B } = await start();
    let child!: Task;
    await inOrder(
      A,
      () =>
        transaction(A, () => {
          child = first(task(A, ID.columns).appendChild({ name: 'Grouting', startDate: day('2026-11-09'), duration: 1 })) as Task;
          A.project.assignmentStore.add({ event: ID.columnBases, resource: ID.riggers, units: 100 } as never);
        }),
      B,
      () => {
        task(B, ID.columns).remove();
        B.project.resourceStore.getById(ID.riggers)!.remove();
      },
    );
    const result = await converge();
    expect(result.tasks.some((row) => row.id === ID.columns || row.id === child.id)).toBe(false);
    expect(result.assignments.some((row) => row.resource === ID.riggers)).toBe(false);
  });

  it('a task moved into a group another client deletes at the same time goes with the group', async () => {
    const { A, B } = await start();
    await inOrder(
      A,
      () => dropRow(A, ID.crane, ID.completion, ID.handover),
      B,
      () => task(B, ID.completion).remove(),
    );
    const result = await converge();
    expect(result.tasks.some((row) => row.id === ID.crane || row.id === ID.completion)).toBe(false);
    expect(result.dependencies.some((row) => row.from === ID.crane || row.to === ID.crane)).toBe(false);
  });

  it('a task moved into a group another client deleted first stays where it was', async () => {
    const { A, B } = await start();
    await inOrder(
      B,
      () => task(B, ID.completion).remove(),
      A,
      () => dropRow(A, ID.crane, ID.completion, ID.handover),
    );
    const result = await converge();
    expect(result.tasks.find((row) => row.id === ID.crane)).toMatchObject({ parentId: ID.structure, wbs: '2.2' });
  });

  it('a link into a split task while another client resizes one of its predecessors', async () => {
    const { A, B } = await start();
    await Promise.all([
      transaction(A, () => A.project.dependencyStore.add({ fromEvent: ID.crane, toEvent: ID.roofDeck })),
      queue(B, async () => {
        void task(B, ID.beams).setDuration(6);
        await B.project.commitAsync();
      }),
    ]);
    const result = await converge();
    expect(result.tasks.find((row) => row.id === ID.beams)?.duration).toBe(6);
    expect(result.tasks.find((row) => row.id === ID.roofDeck)?.segments).toHaveLength(2);
    expect(dependency(A, ID.crane, ID.roofDeck)).toBeDefined();
  });

  it('one client edits offline while the other restructures, then reconnects', async () => {
    const { A, B } = await start();
    relay.disconnect('B');
    await vi.waitFor(() => expect(B.sync.state.connection).toBe('reconnecting'));
    await transaction(B, () => {
      task(B, ID.columnErection).name = 'Column erection (offline)';
    });
    await transaction(B, () => task(B, ID.columnErection).putStartDate(day('2026-11-16'), true));
    const offlineChild = addSubtask(B, ID.beams, { name: 'Beam splices', duration: 1 });
    await vi.waitFor(() => expect(B.sync.state.pending).toBeGreaterThanOrEqual(3));

    await indent(A, ID.crane);
    await outdent(A, ID.columnErection);
    task(A, ID.stripOut).remove();
    await dropRow(A, ID.roofDeck, ID.structure, ID.frame);
    await settle([A]);

    relay.reconnect('B');
    const result = await converge();
    expect(view(A, ID.columnErection)).toMatchObject({ name: 'Column erection (offline)', parentId: ID.frame, constraintDate: '2026-11-16T00:00' });
    expect(result.tasks.find((row) => row.id === offlineChild.id)).toMatchObject({ parentId: ID.beams });
    expect(view(B, ID.crane).parentId).toBe(ID.frame);
    expect(result.tasks.some((row) => row.id === ID.stripOut)).toBe(false);
  });
});

