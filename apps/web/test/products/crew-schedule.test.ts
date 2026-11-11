/**
 * The crew schedule (Scheduler Pro over the Gantt's own project) edits the plan through Bryntum's
 * EventDrag feature, which runs as a transactional feature: one STM transaction inside the project
 * queue per drop. These tests mount the real widget (jsdom) on a live client of an InMemoryRelay
 * and drive the feature's own drop path (`startFeatureTransaction` on drag start, `updateRecords` on
 * drop, `finishFeatureTransaction` after it, as `onBeforeDragStart` and `finalize` do), then check
 * that a drop is exactly one revision and that every client converges on it.
 */
import { Widget } from '@bryntum/gantt';
import type { AssignmentModel, ProjectModel, ResourceModel, SchedulerPro, TaskModel } from '@bryntum/gantt';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoadProjectResult } from '@collab/shared';
import { createCrewSchedule, crewMoveVerdict, dragTipHtml } from '../../src/gantt/CrewSchedule';
import { createProjectModel, toInlineDataPackage } from '../../src/gantt/project';
import { InMemoryRelay } from '../../src/sync/in-memory-relay';
import { RevisionSync, type SyncState } from '../../src/sync/revision-sync';
import { EDIT_IDS as ID, editPathsData } from '../fixtures/edit-paths-data';
import { PROJECT_ID, loadResult, sleep } from '../sync/helpers';

interface Peer {
  id: string;
  project: ProjectModel;
  sync: RevisionSync;
  states: SyncState[];
  warnings: string[];
  schedule?: SchedulerPro;
}

// jsdom has no stylesheets: skip the widget's one-off "is the theme loaded?" check (it would fetch a CDN link).
(Widget as unknown as { detectCSSIssues: boolean }).detectCSSIssues = false;

let relay: InMemoryRelay;
let peers: Peer[];
let engineWarnings: string[];

async function join(id: string, load: LoadProjectResult): Promise<Peer> {
  const project = createProjectModel();
  const states: SyncState[] = [];
  const warnings: string[] = [];
  const sync = new RevisionSync(project, relay.connect(id), {
    sessionId: id,
    projectId: PROJECT_ID,
    prepareSnapshot: toInlineDataPackage,
    onState: (state) => states.push(state),
    onWarning: (message) => warnings.push(message),
    backoff: { initialMs: 10, maxMs: 40 },
  });
  await sync.init(load);
  const peer: Peer = { id, project, sync, states, warnings };
  peers.push(peer);
  return peer;
}

/** Mounts the crew schedule on a client's live project, its time axis covering the plan. */
function mountSchedule(peer: Peer): SchedulerPro {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const schedule = createCrewSchedule({ appendTo: host, project: peer.project });
  (schedule as unknown as { setTimeSpan(start: Date, end: Date): void }).setTimeSpan(new Date(2026, 9, 26), new Date(2027, 0, 31));
  peer.schedule = schedule;
  return schedule;
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
  for (const peer of peers) {
    peer.schedule?.destroy();
    peer.sync.dispose();
    peer.project.destroy();
  }
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

// ---- settling and convergence ---------------------------------------------------------------------

/** Until every client applied the whole log, has nothing to send or record, and the relay stayed idle. */
async function settle(timeoutMs = 8_000): Promise<void> {
  const started = performance.now();
  let quietSince: number | undefined;
  let seen = -1;
  while (performance.now() - started < timeoutMs) {
    await Promise.all(peers.map((peer) => peer.sync.whenApplied()));
    await sleep(10);
    const broken = peers.find((peer) => peer.sync.state.status === 'error');
    if (broken) throw new Error(`${broken.id} fell out of sync: ${broken.sync.state.error}`);
    const idle =
      relay.inFlight === 0 &&
      relay.revisionCount === seen &&
      peers.every(
        (peer) =>
          peer.sync.state.pending === 0 &&
          !peer.sync.hasBufferedRevisions &&
          peer.sync.state.lastRevision === relay.currentRevisionNo &&
          !(peer.project.stm as unknown as { isRecording: boolean }).isRecording,
      );
    seen = relay.revisionCount;
    if (!idle) quietSince = undefined;
    else if (quietSince === undefined) quietSince = performance.now();
    else if (performance.now() - quietSince >= 40) return;
  }
  throw new Error(`settle() timed out at relay revision ${relay.currentRevisionNo}`);
}

const idOf = (record: unknown) => (record as { id?: unknown } | null | undefined)?.id ?? null;

/** Ids of the tasks on a crew's row. */
const taskIdsOf = (crew: ResourceModel) => (crew.events as unknown as TaskModel[]).map((record) => record.id);

const pad = (n: number) => String(n).padStart(2, '0');
const day = (value: unknown): string | null =>
  value instanceof Date ? `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}` : null;

/** What both views show: every task's dates, progress and constraint, and who does it. */
function projection(project: ProjectModel) {
  const tasks = (project.taskStore.allRecords as TaskModel[])
    .map((task) => ({
      id: task.id,
      start: day(task.startDate),
      end: day(task.endDate),
      duration: task.duration,
      percentDone: task.percentDone,
      constraintType: task.constraintType ?? null,
      constraintDate: day(task.constraintDate),
    }))
    .sort((a, b) => Number(a.id) - Number(b.id));
  const assignments = (project.assignmentStore.allRecords as AssignmentModel[])
    .map((assignment) => ({ id: assignment.id, task: idOf(assignment.event), crew: idOf(assignment.resource), units: assignment.units }))
    .sort((a, b) => Number(a.id) - Number(b.id));
  return { tasks, assignments };
}

/** Settles, then every client holds the same plan, is healthy and saw no engine warnings. */
async function converge(): Promise<ReturnType<typeof projection>> {
  await settle();
  const [first, ...rest] = peers;
  const reference = projection(first!.project);
  for (const peer of rest) expect(projection(peer.project), `${peer.id} matches ${first!.id}`).toEqual(reference);
  for (const peer of peers) {
    expect(peer.sync.state, `${peer.id} sync state`).toMatchObject({ status: 'synced', pending: 0, lastRevision: relay.currentRevisionNo });
    expect(peer.states.filter((state) => state.status === 'error'), `${peer.id} never errored`).toEqual([]);
    expect(peer.warnings, `${peer.id} warnings`).toEqual([]);
  }
  expect(engineWarnings, 'warnings from the engine').toEqual([]);
  // A client opening the project now (base snapshot + the whole log) sees the same plan and adds nothing.
  const head = relay.currentRevisionNo;
  const fresh = await join(`reload-${head}`, loadResult(editPathsData(), 0, relay.allRows()));
  await settle();
  expect(projection(fresh.project), 'a reload from the log').toEqual(reference);
  expect(relay.currentRevisionNo, 'a reload emits no revisions').toBe(head);
  peers.splice(peers.indexOf(fresh), 1);
  fresh.sync.dispose();
  fresh.project.destroy();
  return reference;
}

// ---- the drag, the way EventDrag runs it ------------------------------------------------------------

interface DragFeature {
  dragData: unknown;
  currentOverClient: unknown;
  startFeatureTransaction(): Promise<void>;
  rejectFeatureTransaction(): void;
  updateRecords(dragData: object): Promise<void>;
  finishFeatureTransaction(): Promise<void>;
  validatorFn(context: object, event?: Event): { valid: boolean; message: string } | boolean;
}

const dragFeature = (schedule: SchedulerPro) => (schedule.features as unknown as { eventDrag: DragFeature }).eventDrag;

const DAY_MS = 24 * 3_600_000;

const crew = (peer: Peer, id: number) => peer.project.resourceStore.getById(id) as ResourceModel;
const task = (peer: Peer, id: number) => peer.project.taskStore.getById(id) as TaskModel;
const assignmentOf = (peer: Peer, taskId: number, crewId: number) =>
  (peer.project.assignmentStore.allRecords as AssignmentModel[]).find(
    (assignment) => idOf(assignment.event) === taskId && idOf(assignment.resource) === crewId,
  )!;

/** Grabs a bar: the feature starts its transaction (the project queue waits until the drop). */
async function grab(schedule: SchedulerPro): Promise<void> {
  const started = new Promise<void>((resolve) => schedule.on({ featureTransactionStart: () => resolve(), once: true }));
  void dragFeature(schedule).startFeatureTransaction();
  await started;
}

/** Drops the bar of `assignment` on `target`'s row, `days` later (or earlier), and finishes the feature transaction. */
async function drop(schedule: SchedulerPro, assignment: AssignmentModel, target: ResourceModel, days: number): Promise<void> {
  const feature = dragFeature(schedule);
  const element = document.createElement('div');
  const event = assignment.event as TaskModel;
  const dragData = {
    valid: true,
    assignmentRecord: assignment,
    eventRecord: event,
    origStart: event.startDate,
    assignmentRecords: [assignment],
    eventRecords: [event],
    resourceRecord: assignment.resource,
    newResource: target,
    timeDiff: days * DAY_MS,
    initialAssignmentsState: [{ startDate: event.startDate, resource: assignment.resource, assignment }],
    eventBarEls: [element],
    proxyElements: [element],
    context: { element, relatedElements: [] },
  };
  feature.currentOverClient = schedule;
  feature.dragData = dragData;
  await feature.updateRecords(dragData);
  feature.dragData = null;
  await feature.finishFeatureTransaction();
}

async function drag(schedule: SchedulerPro, assignment: AssignmentModel, target: ResourceModel, days: number): Promise<void> {
  await grab(schedule);
  await drop(schedule, assignment, target, days);
}

// =====================================================================================================

describe('crew schedule widget', () => {
  it('shows the live project itself, with only the two drags switched on', async () => {
    const A = await join('A', loadResult(editPathsData()));
    const schedule = mountSchedule(A);
    const widget = schedule as unknown as {
      project: unknown;
      eventStore: unknown;
      resourceStore: unknown;
      assignmentStore: unknown;
      transactionalFeaturesEnabled: boolean;
      enableDeleteKey: boolean;
      features: Record<string, { disabled?: boolean; allowResize?: boolean; copyKey?: string } | undefined>;
    };
    expect(widget.project).toBe(A.project);
    expect(widget.eventStore).toBe(A.project.taskStore);
    expect(widget.resourceStore).toBe(A.project.resourceStore);
    expect(widget.assignmentStore).toBe(A.project.assignmentStore);
    expect(widget.transactionalFeaturesEnabled).toBe(true);
    expect(widget.enableDeleteKey).toBe(false);

    const on = (name: string) => Boolean(widget.features[name] && !widget.features[name]!.disabled);
    expect(on('eventDrag')).toBe(true);
    expect(widget.features.eventDrag?.copyKey).toBe('');
    expect(on('percentBar')).toBe(true);
    expect(widget.features.percentBar?.allowResize).toBe(false);
    for (const name of ['taskEdit', 'eventEdit', 'cellEdit', 'eventMenu', 'scheduleMenu', 'cellMenu', 'eventDragCreate', 'eventCopyPaste', 'eventResize', 'eventSegmentDrag', 'eventSegmentResize', 'dependencies', 'dependencyEdit', 'dependencyMenu']) {
      expect(on(name), `${name} is off`).toBe(false);
    }
    // One row per crew; each crew's bars are its own tasks.
    const rows = (schedule.store as unknown as { allRecords: ResourceModel[] }).allRecords.map((record) => record.id);
    expect(rows).toEqual([ID.siteCrew, ID.riggers, ID.steelErectors, ID.mobileCrane]);
    expect(taskIdsOf(crew(A, ID.mobileCrane)).sort()).toEqual([ID.crane, ID.columnErection].sort());
  });

  it('keeps up with revisions from another client (no copy of the data)', async () => {
    const A = await join('A', loadResult(editPathsData()));
    const B = await join('B', loadResult(editPathsData()));
    mountSchedule(A);
    // B hands Demolition to the riggers and moves it, the way the Gantt or the side panel would.
    const stm = B.project.stm as unknown as { startTransaction(): void; stopTransaction(): void };
    await (B.project as unknown as { queue(step: () => unknown): Promise<unknown> }).queue(async () => {
      stm.startTransaction();
      assignmentOf(B, ID.stripOut, ID.siteCrew).resource = crew(B, ID.riggers);
      await B.project.commitAsync();
      stm.stopTransaction();
    });
    await converge();
    expect(taskIdsOf(crew(A, ID.riggers))).toContain(ID.stripOut);
    expect(taskIdsOf(crew(A, ID.siteCrew))).not.toContain(ID.stripOut);
  });
});

describe('dragging a bar', () => {
  it('onto another crew hands the task over: one revision, every client agrees', async () => {
    const A = await join('A', loadResult(editPathsData()));
    const B = await join('B', loadResult(editPathsData()));
    const schedule = mountSchedule(A);
    mountSchedule(B);
    const before = relay.currentRevisionNo;
    const startBefore = day(task(A, ID.stripOut).startDate);

    await drag(schedule, assignmentOf(A, ID.stripOut, ID.siteCrew), crew(A, ID.riggers), 0);
    const view = await converge();

    expect(relay.currentRevisionNo - before, 'one drop, one revision').toBe(1);
    const row = relay.allRows().at(-1)!;
    expect(row.client_id).toBe('A');
    expect(row.changes.assignments?.$input?.updated).toEqual([expect.objectContaining({ id: 2, resource: ID.riggers })]);
    expect(row.changes.tasks?.$input?.updated ?? [], 'no task is edited by the hand-over').toEqual([]);
    expect(view.assignments.find((assignment) => assignment.id === 2)).toMatchObject({ task: ID.stripOut, crew: ID.riggers, units: 100 });
    expect(day(task(B, ID.stripOut).startDate), 'dates unchanged').toBe(startBefore);
    expect(taskIdsOf(crew(B, ID.riggers))).toContain(ID.stripOut);
  });

  it('sideways moves the task: one revision, pinned where it was dropped, successors follow', async () => {
    const A = await join('A', loadResult(editPathsData()));
    const B = await join('B', loadResult(editPathsData()));
    const schedule = mountSchedule(A);
    const before = relay.currentRevisionNo;
    const successorBefore = day(task(A, ID.stripOut).startDate);

    // Site setup: Mon Nov 2 → Wed Nov 4.
    await drag(schedule, assignmentOf(A, ID.siteSetup, ID.siteCrew), crew(A, ID.siteCrew), 2);
    const view = await converge();

    expect(relay.currentRevisionNo - before, 'one drop, one revision').toBe(1);
    const row = relay.allRows().at(-1)!;
    expect(row.changes.assignments, 'no crew change').toBeUndefined();
    expect(row.changes.tasks?.$input?.updated).toEqual([
      expect.objectContaining({ id: ID.siteSetup, constraintType: 'startnoearlierthan', constraintDate: '2026-11-04T00:00:00' }),
    ]);
    expect(view.tasks.find((record) => record.id === ID.siteSetup)).toMatchObject({ start: '2026-11-04', constraintType: 'startnoearlierthan', constraintDate: '2026-11-04' });
    expect(day(task(B, ID.stripOut).startDate), 'the successor follows').not.toBe(successorBefore);
    expect(day(task(B, ID.stripOut).startDate)).toBe('2026-11-06');
  });

  it('diagonally does both in the same single revision', async () => {
    const A = await join('A', loadResult(editPathsData()));
    const B = await join('B', loadResult(editPathsData()));
    const schedule = mountSchedule(A);
    const before = relay.currentRevisionNo;

    // Beams (steel erectors) one day later and to the riggers.
    await drag(schedule, assignmentOf(A, ID.beams, ID.steelErectors), crew(A, ID.riggers), 1);
    const view = await converge();

    expect(relay.currentRevisionNo - before).toBe(1);
    expect(view.assignments.find((assignment) => assignment.id === 8)).toMatchObject({ task: ID.beams, crew: ID.riggers });
    expect(view.tasks.find((record) => record.id === ID.beams)?.constraintType).toBe('startnoearlierthan');
    expect(projection(B.project)).toEqual(view);
  });

  it('of one crew of a shared task moves only that crew; the task keeps its other crew', async () => {
    const A = await join('A', loadResult(editPathsData()));
    await join('B', loadResult(editPathsData()));
    const schedule = mountSchedule(A);

    // Crane erection has the mobile crane and the riggers; hand the riggers' part to the site crew.
    await drag(schedule, assignmentOf(A, ID.crane, ID.riggers), crew(A, ID.siteCrew), 0);
    const view = await converge();
    const crews = view.assignments.filter((assignment) => assignment.task === ID.crane).map((assignment) => assignment.crew).sort();
    expect(crews).toEqual([ID.siteCrew, ID.mobileCrane].sort());
  });

  it('holds incoming revisions until the drop, then applies them on top of it', async () => {
    const A = await join('A', loadResult(editPathsData()));
    const B = await join('B', loadResult(editPathsData()));
    const schedule = mountSchedule(A);

    await grab(schedule);
    // While A holds a bar, B renames another task; A's queue waits.
    task(B, ID.commissioning).name = 'Commissioning and tests';
    await B.project.commitAsync();
    await sleep(250);
    expect(relay.currentRevisionNo).toBe(1);
    expect(task(A, ID.commissioning).name, 'not applied mid-drag').toBe('Commissioning');

    await drop(schedule, assignmentOf(A, ID.stripOut, ID.siteCrew), crew(A, ID.riggers), 0);
    await converge();
    expect(task(A, ID.commissioning).name).toBe('Commissioning and tests');
    expect(assignmentOf(B, ID.stripOut, ID.riggers)).toBeDefined();
    expect(relay.currentRevisionNo).toBe(2);
  });

  it('that is let go outside a row changes nothing and frees the queue', async () => {
    const A = await join('A', loadResult(editPathsData()));
    await join('B', loadResult(editPathsData()));
    const schedule = mountSchedule(A);
    await grab(schedule);
    dragFeature(schedule).rejectFeatureTransaction();
    task(A, ID.commissioning).name = 'Commissioning and tests';
    await converge();
    expect(relay.currentRevisionNo, 'only the rename').toBe(1);
  });
});

describe('drop rules and wording', () => {
  it('refuses a crew that is already on the task, in plain words', async () => {
    const A = await join('A', loadResult(editPathsData()));
    const schedule = mountSchedule(A);
    const steel = assignmentOf(A, ID.columnErection, ID.steelErectors);

    expect(crewMoveVerdict(steel, crew(A, ID.mobileCrane))).toEqual({ valid: false, message: 'Mobile crane is already on “Column erection”' });
    expect(crewMoveVerdict(steel, crew(A, ID.riggers))).toEqual({ valid: true, message: 'Hand over from Steel erectors to Riggers' });
    expect(crewMoveVerdict(steel, crew(A, ID.steelErectors))).toEqual({ valid: true, message: '' });
    expect(crewMoveVerdict(steel, null).valid).toBe(false);
    // The feature asks the same question while the bar is dragged.
    expect(dragFeature(schedule).validatorFn({ assignmentRecords: [steel], newResource: crew(A, ID.mobileCrane) })).toMatchObject({ valid: false });
  });

  it('says where the task lands and who takes it over', async () => {
    const A = await join('A', loadResult(editPathsData()));
    const strip = assignmentOf(A, ID.stripOut, ID.siteCrew);
    const html = dragTipHtml({
      eventRecord: task(A, ID.stripOut),
      newResource: crew(A, ID.riggers),
      valid: true,
      startDate: new Date(2026, 10, 9),
      endDate: new Date(2026, 10, 12),
      dragData: { assignmentRecords: [strip] },
    });
    expect(html).toContain('Demolition');
    expect(html).toContain('Mon Nov 9 → Wed Nov 11');
    expect(html).toContain('Hand over from Site crew to Riggers');

    // Over a crew already on the task, Bryntum marks the drop invalid in its own words; the tip says why plainly.
    const refused = dragTipHtml({
      eventRecord: task(A, ID.crane),
      newResource: crew(A, ID.mobileCrane),
      valid: false,
      message: 'Event cannot be assigned to the same resource multiple times',
      startDate: new Date(2026, 10, 9),
      endDate: new Date(2026, 10, 11),
      dragData: { assignmentRecords: [assignmentOf(A, ID.crane, ID.riggers)] },
    });
    expect(refused).toContain('is-invalid');
    expect(refused).toContain('Mobile crane is already on “Crane erection”');
    expect(refused).not.toContain('Event cannot');
  });
});
