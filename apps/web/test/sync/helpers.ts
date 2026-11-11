import type { ProjectModel } from '@bryntum/gantt';
import type { LoadProjectResult, ProjectInlineData, ProjectRevisionRow } from '@collab/shared';
import { createProjectModel } from '../../src/gantt/project';
import { InMemoryRelay } from '../../src/sync/in-memory-relay';
import { RevisionSync, type SyncState } from '../../src/sync/revision-sync';
import type { RevisionTransport } from '../../src/sync/transport';

export const PROJECT_ID = '00000000-0000-4000-8000-0000000000aa';

/** Small fixture in the shape of the seed: tasks, one FS dependency, resources and an assignment. */
export function baseSnapshot(): ProjectInlineData {
  return {
    tasksData: [
      { id: 1, name: 'Site setup', startDate: '2026-11-02', duration: 2 },
      { id: 2, name: 'Foundations', duration: 3 },
      { id: 3, name: 'Crane erection', duration: 1 },
    ],
    dependenciesData: [{ id: 1, fromEvent: 1, toEvent: 2 }],
    resourcesData: [
      { id: 1, name: 'Site crew' },
      { id: 2, name: 'Mobile crane' },
    ],
    assignmentsData: [{ id: 1, event: 1, resource: 1 }],
  };
}

/** The production model (CollabTask, TZ-less dates, ordered WBS, auto constraints); the fixture's undated tasks need the project start. */
export function newProject(): ProjectModel {
  return createProjectModel({ config: { startDate: '2026-11-02' } });
}

export function loadResult(
  snapshot: ProjectInlineData,
  snapshotRevision = 0,
  revisions: ProjectRevisionRow[] = [],
): LoadProjectResult {
  return {
    project: { id: PROJECT_ID, name: 'Riverside Clinic build-out', currency: 'USD', handover_task_id: null },
    membership: { role: 'pm', can_view_costs: false, approval_limit_minor: 0 },
    snapshot,
    snapshot_revision: snapshotRevision,
    current_revision: snapshotRevision + revisions.length,
    revisions,
  };
}

export interface Client {
  id: string;
  project: ProjectModel;
  sync: RevisionSync;
  states: SyncState[];
  /** revision_no of every revision applied, in application order. */
  applied: number[];
}

export async function joinClient(
  relay: InMemoryRelay,
  id: string,
  load: LoadProjectResult,
  transport: RevisionTransport = relay.connect(id),
): Promise<Client> {
  const project = newProject();
  const states: SyncState[] = [];
  const applied: number[] = [];
  const sync = new RevisionSync(project, transport, {
    sessionId: id,
    projectId: PROJECT_ID,
    onState: (state) => states.push(state),
    onRevisionApplied: (row) => applied.push(row.revision_no),
    backoff: { initialMs: 20, maxMs: 100 },
  });
  await sync.init(load);
  return { id, project, sync, states, applied };
}

export function disposeAll(clients: Client[]): void {
  for (const client of clients) {
    client.sync.dispose();
    client.project.destroy();
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Waits until every client has applied every relay revision, has an empty outbox and nothing is in
 * flight for two consecutive quiet rounds (follow-up revisions such as DATA_CORRECTION are recorded
 * by the STM 100 ms after a change). Returns the elapsed time in ms.
 */
export async function settle(
  clients: Client[],
  relay: InMemoryRelay,
  { timeoutMs = 20_000, quietRounds = 2 }: { timeoutMs?: number; quietRounds?: number } = {},
): Promise<number> {
  const started = performance.now();
  let quiet = 0;
  let seenRevisions = -1;
  while (performance.now() - started < timeoutMs) {
    await Promise.all(clients.map((client) => client.sync.whenApplied()));
    await Promise.all(clients.map((client) => client.project.commitAsync()));
    await sleep(130);
    const idle =
      relay.inFlight === 0 &&
      relay.heldCount === 0 &&
      relay.revisionCount === seenRevisions &&
      clients.every(
        (client) =>
          client.sync.state.pending === 0 &&
          !client.sync.hasBufferedRevisions &&
          client.sync.state.lastRevision === relay.currentRevisionNo,
      );
    seenRevisions = relay.revisionCount;
    quiet = idle ? quiet + 1 : 0;
    if (quiet >= quietRounds) {
      await Promise.all(clients.map((client) => client.sync.whenApplied()));
      return performance.now() - started;
    }
  }
  throw new Error(
    `settle() timed out; relay at ${relay.currentRevisionNo} (${relay.inFlight} in flight, ${relay.heldCount} held); ` +
      `states: ${JSON.stringify(clients.map((client) => [client.id, client.sync.state]))}`,
  );
}

export function report(label: string, ms: number): void {
  console.log(`settle ${label}: ${ms.toFixed(0)} ms`);
}

export interface TaskRecord {
  id: string | number;
  name: string;
  duration: number;
  startDate: Date;
  endDate: Date;
  percentDone: number;
  parentId: string | number | null;
  setStartDate(date: Date): Promise<void>;
  remove(): void;
}

export function task(client: Client, id: string | number): TaskRecord {
  const record = client.project.taskStore.getById(id);
  if (!record) {
    throw new Error(`task ${id} is missing in ${client.id}`);
  }
  return record as unknown as TaskRecord;
}

export function addTask(client: Client, data: Record<string, unknown>): TaskRecord[] {
  return client.project.taskStore.add(data) as unknown as TaskRecord[];
}

export function localDate(date: Date | null | undefined): string | null {
  if (!date) {
    return null;
  }
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

interface RefLike {
  id: string | number;
}

interface DependencyLike {
  id: string | number;
  fromEvent?: RefLike | null;
  toEvent?: RefLike | null;
  type: number;
  lag: number;
  active: boolean;
}

interface AssignmentLike {
  id: string | number;
  event?: RefLike | null;
  resource?: RefLike | null;
  units: number;
}

const byId = <T extends { id: string | number }>(a: T, b: T) => String(a.id).localeCompare(String(b.id));

/** Deterministic JSON of the three synchronized stores, for comparing clients. */
export function storeJson(project: ProjectModel): string {
  const tasks = (project.taskStore.query(() => true) as unknown as TaskRecord[])
    .map((t) => ({
      id: t.id,
      name: t.name,
      start: localDate(t.startDate),
      end: localDate(t.endDate),
      duration: t.duration,
      percentDone: t.percentDone,
      parentId: t.parentId ?? null,
    }))
    .sort(byId);
  const dependencies = (project.dependencyStore.query(() => true) as unknown as DependencyLike[])
    .map((d) => ({ id: d.id, from: d.fromEvent?.id ?? null, to: d.toEvent?.id ?? null, type: d.type, lag: d.lag, active: d.active }))
    .sort(byId);
  const assignments = (project.assignmentStore.query(() => true) as unknown as AssignmentLike[])
    .map((a) => ({ id: a.id, event: a.event?.id ?? null, resource: a.resource?.id ?? null, units: a.units }))
    .sort(byId);
  return JSON.stringify({ tasks, dependencies, assignments }, null, 1);
}
