import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectModel } from '@bryntum/gantt';
import {
  CollabBaseline,
  CollabProjectModel,
  CollabResource,
  CollabTask,
  COPY_RESET_VALUES,
  createProjectModel,
  loadCollaborativeProject,
  loadProjectInlineData,
  normalizeResourceData,
  prepareCopiedTasks,
  readProjectInlineData,
} from '../../src/gantt/project';
import type { RevisionNotificationEvent } from '../../src/sync/revision-sync';
import { riversideClinic } from '@collab/shared/seed';
import { SAMPLE_IDS, SAMPLE_INLINE_DATA } from '../fixtures/sample-data';

const TZ_LESS_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

const projects: ProjectModel[] = [];

/** Bryntum derives an engine-enhanced subclass from the configured model class. */
function derivesFrom(cls: unknown, base: { prototype: object }): boolean {
  return cls === base || (typeof cls === 'function' && base.prototype.isPrototypeOf(cls.prototype));
}

const toMs = (value: string | Date | null | undefined): number | undefined =>
  value == null ? undefined : new Date(value).getTime();

function countTasks(rows: unknown[]): number {
  let count = 0;
  for (const row of rows) {
    count += 1;
    const children = (row as { children?: unknown[] }).children;
    if (Array.isArray(children)) count += countTasks(children);
  }
  return count;
}

function newProject(): ProjectModel {
  const project = createProjectModel();
  projects.push(project);
  return project;
}

interface SerializedTask {
  id?: unknown;
  startDate?: string;
  endDate?: string;
  baselines?: Array<{ startDate?: string; endDate?: string }>;
  children?: unknown[];
}

function flattenTasks(rows: unknown[]): SerializedTask[] {
  return rows.flatMap((row) => {
    const serialized = row as SerializedTask;
    return [serialized, ...flattenTasks(Array.isArray(serialized.children) ? serialized.children : [])];
  });
}

afterEach(() => {
  for (const project of projects.splice(0)) project.destroy();
});

function task(project: ProjectModel, id: number): CollabTask {
  const record = project.taskStore.getById(id);
  if (!(record instanceof CollabTask)) throw new Error(`task ${id} missing`);
  return record;
}

function nextRevision(project: ProjectModel, timeoutMs = 3000): Promise<RevisionNotificationEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no revisionNotification within timeout')), timeoutMs);
    project.on({
      revisionNotification: (event: RevisionNotificationEvent) => {
        clearTimeout(timer);
        resolve(event);
      },
      once: true,
    });
  });
}

describe('createProjectModel', () => {
  it('is configured for collaboration', () => {
    const project = newProject();
    expect(project).toBeInstanceOf(CollabProjectModel);
    expect((project.stm as { revisionsEnabled?: boolean }).revisionsEnabled).toBe(true);
    expect(project.taskStore.useOrderedTreeForWbs).toBe(true);
    expect(derivesFrom(project.taskStore.modelClass, CollabTask)).toBe(true);
    expect(derivesFrom(project.resourceStore.modelClass, CollabResource)).toBe(true);
  });

  it('loads inline data and schedules it', async () => {
    const project = newProject();
    await loadProjectInlineData(project, SAMPLE_INLINE_DATA);

    expect(project.taskStore.allRecords).toHaveLength(16);
    expect(project.dependencyStore.count).toBe(11);
    expect(project.assignmentStore.count).toBe(11);

    const siteEstablishment = task(project, SAMPLE_IDS.siteEstablishment);
    const stripOut = task(project, SAMPLE_IDS.stripOut);
    const handover = task(project, SAMPLE_IDS.handover);
    expect(siteEstablishment.startDate).toEqual(new Date(2026, 10, 2));
    expect(siteEstablishment.endDate).toEqual(new Date(2026, 10, 5));
    // Finish-to-start successor of a task ending Thursday Nov 5, five working days long.
    expect(stripOut.startDate).toEqual(new Date(2026, 10, 5));
    expect(stripOut.endDate).toEqual(new Date(2026, 10, 12));
    expect(handover.isMilestone).toBe(true);
    expect(toMs(handover.startDate)).toBeGreaterThan(toMs(stripOut.endDate) ?? Number.POSITIVE_INFINITY);

    expect(String(task(project, SAMPLE_IDS.firstPhase).wbsValue)).toBe('1');
    expect(String(siteEstablishment.wbsValue)).toBe('1.1');
    expect(String(stripOut.wbsValue)).toBe('1.2');
    expect(stripOut.orderedParentIndex).toBe(1);

    expect(stripOut.budgetMinor).toBe(2_400_000);
    expect(stripOut.forecastMinor).toBe(2_500_000);
    expect(stripOut.incurredMinor).toBe(1_500_000);
    expect(stripOut.paidMinor).toBe(1_200_000);
    expect(stripOut.costCode).toBe('EW-02');
    expect(task(project, SAMPLE_IDS.firstPhase).budgetMinor).toBe(0);
  });

  it('keeps the labor/equipment split in `kind` and leaves the engine resource type alone', async () => {
    const project = newProject();
    await loadProjectInlineData(project, SAMPLE_INLINE_DATA);
    const crane = project.resourceStore.getById(SAMPLE_IDS.crane);
    expect(crane).toBeInstanceOf(CollabResource);
    expect((crane as CollabResource).kind).toBe('equipment');
    expect((crane as CollabResource).type).toBe('work');
    expect((project.resourceStore.getById(1) as CollabResource).kind).toBe('labor');
  });

  it('loads the shared seed fixture with its labor/equipment resource kinds', async () => {
    expect(riversideClinic.inlineData.tasksData.length).toBeGreaterThan(0);
    const project = newProject();
    await loadProjectInlineData(project, riversideClinic.inlineData);

    expect(project.taskStore.allRecords.length).toBe(countTasks(riversideClinic.inlineData.tasksData));
    const handover = project.taskStore.getById(riversideClinic.handover_task_id);
    expect(handover).toBeInstanceOf(CollabTask);
    expect((handover as CollabTask).isMilestone).toBe(true);

    const crane = project.resourceStore.getById(riversideClinic.booking.resource_id);
    expect(crane).toBeInstanceOf(CollabResource);
    expect((crane as CollabResource).kind).toBe('equipment');
    expect((crane as CollabResource).type).toBe('work');
    const kinds = project.resourceStore.allRecords.map((record) => (record as CollabResource).kind);
    expect(kinds.every((kind) => kind === 'labor' || kind === 'equipment')).toBe(true);
    const equipment = project.resourceStore.allRecords.filter((record) => (record as CollabResource).kind === 'equipment');
    expect(equipment).toContain(crane);
  });

  it('moves a legacy resource `type` of labor/equipment into `kind`', () => {
    expect(normalizeResourceData({ id: 4, name: 'Crane', type: 'equipment' })).toEqual({
      id: 4,
      name: 'Crane',
      kind: 'equipment',
    });
    expect(normalizeResourceData({ id: 5, name: 'Concrete', type: 'material' })).toEqual({
      id: 5,
      name: 'Concrete',
      type: 'material',
    });
    expect(normalizeResourceData({ id: 6, kind: 'labor', type: 'equipment' })).toEqual({
      id: 6,
      kind: 'labor',
      type: 'equipment',
    });
  });

  it('serializes task dates without timezone information', async () => {
    const project = newProject();
    await loadProjectInlineData(project, SAMPLE_INLINE_DATA);
    const stripOut = task(project, SAMPLE_IDS.stripOut);
    stripOut.setConstraint('startnoearlierthan', new Date(2026, 10, 9));
    await project.commitAsync();
    const json = stripOut.toJSON() as { startDate: string; endDate: string; constraintDate: string };
    expect(json.startDate).toMatch(TZ_LESS_DATE);
    expect(json.endDate).toMatch(TZ_LESS_DATE);
    expect(json.constraintDate).toMatch(TZ_LESS_DATE);
    expect(json.startDate).toBe('2026-11-09T00:00:00');
  });

  it('serializes project and baseline dates without timezone information, like task dates', async () => {
    const project = newProject();
    await loadProjectInlineData(project, riversideClinic.inlineData);
    const snapshot = readProjectInlineData(project);
    expect(snapshot.project?.startDate).toBe('2026-11-02T00:00:00');
    expect(snapshot.project?.endDate).toBe('2027-04-28T00:00:00');

    const rows = flattenTasks(snapshot.tasksData);
    expect(rows.length).toBe(countTasks(riversideClinic.inlineData.tasksData));
    for (const row of rows) {
      expect(row.startDate, `task ${String(row.id)} startDate`).toMatch(TZ_LESS_DATE);
      expect(row.endDate, `task ${String(row.id)} endDate`).toMatch(TZ_LESS_DATE);
      for (const baseline of row.baselines ?? []) {
        expect(baseline.startDate, `task ${String(row.id)} baseline startDate`).toMatch(TZ_LESS_DATE);
        expect(baseline.endDate, `task ${String(row.id)} baseline endDate`).toMatch(TZ_LESS_DATE);
      }
    }
    const erection = task(project, riversideClinic.booking.task_id);
    const baselines = (erection.baselines as unknown as { allRecords: unknown[] }).allRecords;
    expect(baselines.length).toBeGreaterThan(0);
    expect(baselines.every((baseline) => baseline instanceof CollabBaseline)).toBe(true);
  });

  it('round-trips its snapshot into a second project', async () => {
    const source = newProject();
    await loadProjectInlineData(source, SAMPLE_INLINE_DATA);
    const snapshot = readProjectInlineData(source);
    expect(snapshot.tasksData.length).toBeGreaterThan(0);
    expect(snapshot.calendarsData?.length).toBe(2);

    const copy = newProject();
    await loadProjectInlineData(copy, snapshot);
    for (const record of source.taskStore.allRecords) {
      const twin = copy.taskStore.getById(record.id) as CollabTask;
      const original = record as CollabTask;
      expect(twin.name).toBe(original.name);
      expect(toMs(twin.startDate)).toBe(toMs(original.startDate));
      expect(toMs(twin.endDate)).toBe(toMs(original.endDate));
      expect(twin.budgetMinor).toBe(original.budgetMinor);
    }
  });
});

describe('revisions', () => {
  it('emits a revisionNotification for a programmatic rename', async () => {
    const project = newProject();
    await loadCollaborativeProject(project, SAMPLE_INLINE_DATA, 'client-A');
    expect(project.stm.disabled).toBe(false);

    const pending = nextRevision(project);
    task(project, SAMPLE_IDS.stripOut).name = 'Demolition and cleanup';
    const event = await pending;

    expect(event.clientId).toBe('client-A');
    expect(event.localRevisionId).toBeTruthy();
    const tasks = (event.changes as { tasks: { updated: { id: number; name: string }[] } }).tasks;
    expect(tasks.updated).toEqual([{ id: SAMPLE_IDS.stripOut, name: 'Demolition and cleanup' }]);

    expect(event.conflictResolutionFor).toBeUndefined();
  });

  it('carries $input and phantom ids when a task is added with a dependency', async () => {
    const project = newProject();
    await loadCollaborativeProject(project, SAMPLE_INLINE_DATA, 'client-A');

    const pending = nextRevision(project);
    const phase = task(project, SAMPLE_IDS.firstPhase);
    const added = phase.appendChild({ name: 'Site fence', duration: 1 });
    const fence = Array.isArray(added) ? added[0] : added;
    if (!(fence instanceof CollabTask)) throw new Error('appendChild did not return the task');
    project.dependencyStore.add({ fromEvent: SAMPLE_IDS.stripOut, toEvent: fence.id });
    const event = await pending;

    expect(fence.isPhantom).toBe(true);
    const changes = event.changes as {
      tasks: { added: Record<string, unknown>[]; $input: { added: Record<string, unknown>[] } };
      dependencies: { added: Record<string, unknown>[]; $input: { added: Record<string, unknown>[] } };
    };
    expect(changes.tasks.added).toHaveLength(1);
    expect(changes.tasks.added[0]?.$PhantomId).toBe(fence.id);
    expect(changes.tasks.$input.added[0]?.$PhantomId).toBe(fence.id);
    expect(changes.tasks.$input.added[0]?.name).toBe('Site fence');
    expect(changes.dependencies.added[0]?.toEvent).toBe(fence.id);
    expect(changes.dependencies.$input.added[0]?.toEvent).toBe(fence.id);
    expect(changes.dependencies.$input.added[0]?.fromEvent).toBe(SAMPLE_IDS.stripOut);
  });

  it('carries the project endDate and new baselines without an offset', async () => {
    const project = newProject();
    await loadCollaborativeProject(project, riversideClinic.inlineData, 'client-A');

    // 232 (fabricate the steel off-site) is on the critical path, so lengthening it moves the project end.
    let pending = nextRevision(project);
    task(project, 232).duration = (task(project, 232).duration ?? 0) + 3;
    let changes = (await pending).changes as { project?: { endDate?: string } };
    expect(changes.project?.endDate).toMatch(TZ_LESS_DATE);

    pending = nextRevision(project);
    task(project, 232).setBaseline(2);
    changes = await pending.then((event) => event.changes as typeof changes);
    const updated = (changes as { tasks: { updated: Array<{ id: number; baselines?: Array<{ startDate: string; endDate: string }> }> } }).tasks
      .updated;
    const baselines = updated.find((change) => change.id === 232)?.baselines;
    expect(baselines?.length).toBe(2);
    for (const baseline of baselines ?? []) {
      expect(baseline.startDate).toMatch(TZ_LESS_DATE);
      expect(baseline.endDate).toMatch(TZ_LESS_DATE);
    }
  });

  it('separates user input from engine consequences when a task is moved', async () => {
    const project = newProject();
    await loadCollaborativeProject(project, SAMPLE_INLINE_DATA, 'client-A');

    const pending = nextRevision(project);
    const steel = task(project, SAMPLE_IDS.steelDelivery);
    steel.setStartDate(new Date(2026, 10, 16), true);
    const event = await pending;

    const tasks = (event.changes as {
      tasks: { updated: { id: number }[]; $input: { updated: { id: number; constraintType?: string }[] } };
    }).tasks;
    expect(tasks.$input.updated.map((change) => change.id)).toEqual([SAMPLE_IDS.steelDelivery]);
    expect(tasks.$input.updated[0]?.constraintType).toBe('startnoearlierthan');
    // Successors moved as a consequence and appear only in the persisted changes.
    expect(tasks.updated.map((change) => change.id)).toContain(SAMPLE_IDS.craneErection);
  });
});

describe('prepareCopiedTasks', () => {
  it('resets progress, incurred and paid money and the decision reference on copies, descendants included', async () => {
    const project = newProject();
    await loadProjectInlineData(project, SAMPLE_INLINE_DATA);
    const phase = task(project, SAMPLE_IDS.firstPhase);
    task(project, SAMPLE_IDS.stripOut).set('decisionRef', '00000000-0000-4000-8000-00000000d001');
    await project.commitAsync();

    // What TaskCopyPaste hands to `beforePaste`: deep copies, not yet in the store.
    const copy = phase.copy() as CollabTask;
    for (const child of phase.children as CollabTask[]) {
      copy.appendChild(child.copy(), true);
    }
    prepareCopiedTasks([copy]);

    const [establishment, stripOut] = copy.children as CollabTask[];
    for (const leaf of [establishment!, stripOut!]) {
      expect(leaf).toMatchObject(COPY_RESET_VALUES);
    }
    expect(stripOut).toMatchObject({ budgetMinor: 2_400_000, forecastMinor: 2_500_000, costCode: 'EW-02' });
    // The originals keep their figures.
    expect(task(project, SAMPLE_IDS.stripOut)).toMatchObject({ percentDone: 60, incurredMinor: 1_500_000, paidMinor: 1_200_000 });
    expect(task(project, SAMPLE_IDS.stripOut).decisionRef).toBe('00000000-0000-4000-8000-00000000d001');
  });
});
