/**
 * Two live clients on the Riverside Clinic seed, syncing through RevisionSync and the InMemoryRelay
 * (the reference `submit_revision`), and the convergence check of the edit-path suite: every client
 * holds the same project, nobody fell out of sync or logged a warning, every id is real, and a reload
 * from the log and a boot from a live snapshot reproduce the project without emitting revisions.
 */
import type { ProjectModel } from '@bryntum/gantt';
import { expect } from 'vitest';
import type { ProjectInlineData } from '@collab/shared';
import { riversideClinic } from '@collab/shared/seed';
import { InMemoryRelay } from '../../src/sync/in-memory-relay';
import { PROJECT_ID, loadResult } from '../sync/helpers';
import { dispose, join, settlePeers, type Peer } from '../sync/peers';

export function seedSnapshot(): ProjectInlineData {
  return structuredClone(riversideClinic.inlineData) as ProjectInlineData;
}

export class Session {
  readonly relay = new InMemoryRelay({ projectId: PROJECT_ID, snapshot: seedSnapshot() });
  readonly peers: Peer[] = [];
  private reloads = 0;

  async start(): Promise<{ A: Peer; B: Peer }> {
    const A = await join(this.relay, 'A', loadResult(seedSnapshot()));
    const B = await join(this.relay, 'B', loadResult(seedSnapshot()));
    this.peers.push(A, B);
    return { A, B };
  }

  dispose(): void {
    this.peers.forEach(dispose);
  }

  /** Waits until every client applied the whole log, has nothing to send and nothing recording, and the relay stayed quiet. */
  settle(clients: Peer[] = this.peers, timeoutMs = 15_000): Promise<void> {
    return settlePeers(this.relay, clients, timeoutMs);
  }

  /** Settles, checks every client and two reloads agree, and returns the agreed projection. */
  async converge(engineWarnings: string[]): Promise<Projection> {
    await this.settle();
    const { relay } = this;
    const [first, ...rest] = this.peers;
    if (!first) throw new Error('no clients');
    const reference = projection(first.project);
    for (const peer of rest) {
      expect(projection(peer.project), `${peer.id} matches ${first.id}`).toEqual(reference);
    }
    this.peers.forEach((peer) => this.expectHealthy(peer));
    expectRealIds(reference);
    expect(engineWarnings, 'warnings from the engine').toEqual([]);

    const head = relay.currentRevisionNo;
    this.reloads++;
    const fromLog = await join(relay, `reload-log-${this.reloads}`, loadResult(seedSnapshot(), 0, relay.allRows()));
    const fromSnapshot = await join(relay, `reload-snapshot-${this.reloads}`, relay.loadResultFor(PROJECT_ID, first.project, head));
    try {
      await this.settle([...this.peers, fromLog, fromSnapshot]);
      expect(projection(fromLog.project), 'reload from the base snapshot and the full log').toEqual(reference);
      expect(projection(fromSnapshot.project), 'boot from a live snapshot').toEqual(reference);
      expect(relay.currentRevisionNo, 'a reload emits no revisions').toBe(head);
      this.expectHealthy(fromLog);
      this.expectHealthy(fromSnapshot);
    } finally {
      dispose(fromLog);
      dispose(fromSnapshot);
    }
    return reference;
  }

  expectHealthy(peer: Peer): void {
    expect(peer.sync.state, `${peer.id} sync state`).toMatchObject({ status: 'synced', pending: 0, lastRevision: this.relay.currentRevisionNo });
    expect(peer.states.filter((state) => state.status === 'error'), `${peer.id} never errored`).toEqual([]);
    expect(peer.warnings, `${peer.id} warnings`).toEqual([]);
  }
}

const pad = (n: number) => String(n).padStart(2, '0');
export const stamp = (value: unknown): string | null =>
  value instanceof Date ? `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}` : null;
const round = (value: unknown) => (typeof value === 'number' ? Math.round(value * 1e4) / 1e4 : value);
const byId = <T extends { id: unknown }>(a: T, b: T) => String(a.id).localeCompare(String(b.id), 'en', { numeric: true });

interface TaskLike {
  id: number | string;
  name: string;
  parent: TaskLike;
  isRoot: boolean;
  children?: TaskLike[] | boolean;
  orderedParentIndex: number;
  wbsValue: unknown;
  startDate: Date | null;
  endDate: Date | null;
  duration: number;
  percentDone: number;
  constraintType: string | null;
  constraintDate: Date | null;
  note: string | null;
  budgetMinor: number;
  incurredMinor: number;
  paidMinor: number;
}

interface LinkLike {
  id: number | string;
  fromEvent: { id: unknown } | null;
  toEvent: { id: unknown } | null;
  type: number;
  lag: number;
}

interface AssignmentLike {
  id: number | string;
  event: { id: unknown } | null;
  resource: { id: unknown } | null;
  units: number;
}

/** Everything a user can see or a reload must reproduce, comparable between projects. */
export function projection(project: ProjectModel) {
  const tasks = (project.taskStore.allRecords as unknown as TaskLike[]).map((task) => ({
    id: task.id,
    parentId: task.parent?.isRoot ? null : (task.parent?.id ?? null),
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
    note: task.note ?? null,
    budgetMinor: task.budgetMinor,
    incurredMinor: task.incurredMinor,
    paidMinor: task.paidMinor,
  }));
  const dependencies = (project.dependencyStore.allRecords as unknown as LinkLike[]).map((link) => ({
    id: link.id,
    from: link.fromEvent?.id ?? null,
    to: link.toEvent?.id ?? null,
    type: link.type,
    lag: link.lag,
  }));
  const assignments = (project.assignmentStore.allRecords as unknown as AssignmentLike[]).map((assignment) => ({
    id: assignment.id,
    event: assignment.event?.id ?? null,
    resource: assignment.resource?.id ?? null,
    units: assignment.units,
  }));
  return {
    roots: (project.taskStore.rootNode.children as unknown as TaskLike[]).map((task) => task.id),
    end: stamp(project.endDate),
    tasks: tasks.sort(byId),
    dependencies: dependencies.sort(byId),
    assignments: assignments.sort(byId),
  };
}

export type Projection = ReturnType<typeof projection>;

export function expectRealIds(view: Projection): void {
  const ids = [...view.tasks, ...view.dependencies, ...view.assignments].map((record) => record.id);
  expect(ids.filter((id) => typeof id !== 'number'), 'records still carrying a phantom id').toEqual([]);
}
