/**
 * Proves the Harbor Street Offices seed with the real scheduling engine: it loads without a
 * scheduling issue, the engine agrees with every derived date, the whole plan is one finish-to-start
 * line from the first task to the handover, every pour is a group of forms, rebar, pour and cure, the
 * crane is on rent around the steel with idle days at both ends, and each floor leaves the place the
 * light fixtures belong: after its ceiling grid, before its ceiling tiles.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DateHelper, ProjectModel } from '@bryntum/gantt';
import type { TaskModel } from '@bryntum/gantt';
import { HARBOR_CONTRACT_DATE, HARBOR_HANDOVER_TASK, HARBOR_IDS, HARBOR_STEEL_TASK, harborOffices, harborOfficesRecords, SEED_PROJECTS } from '@collab/shared/seed';
import { readProjectInlineData } from '../../src/gantt/project';
import { runProjectTransaction } from '../../src/scenario/publish';
import { InMemoryRelay } from '../../src/sync/in-memory-relay';
import { PROJECT_ID, disposeAll, joinClient, loadResult, settle, type Client } from '../sync/helpers';

type ProjectConfig = NonNullable<ConstructorParameters<typeof ProjectModel>[0]>;

const iso = (value: unknown): string => (value instanceof Date ? DateHelper.format(value, 'YYYY-MM-DD') : String(value));

let project: ProjectModel | undefined;
afterEach(() => {
  project?.destroy();
  project = undefined;
});

async function load(): Promise<{ project: ProjectModel; issues: string[] }> {
  const issues: string[] = [];
  const record = (kind: string) => (event: { schedulingIssue: { getDescription: Function } }) => issues.push(`${kind}: ${String(event.schedulingIssue.getDescription())}`);
  project = new ProjectModel({ listeners: { schedulingConflict: record('conflict'), cycle: record('cycle'), emptyCalendar: record('calendar') } });
  await project.loadInlineData(structuredClone(harborOffices.inlineData) as object as ProjectConfig);
  await project.commitAsync();
  return { project, issues };
}

const task = (model: ProjectModel, id: number) => model.taskStore.getById(id) as TaskModel;

describe('Harbor Street Offices seed', () => {
  it('is a listed demo project with the tower crane and a scissor lift on rent', () => {
    expect(SEED_PROJECTS.map(({ ids }) => ids.project)).toContain(HARBOR_IDS.project);
    expect(harborOffices.name).toBe('Harbor Street Offices');
    expect(harborOffices.unlisted).toBeUndefined();
    expect(harborOffices.template).toBe('harbor');
    // The tenant is who the project bills (changes it asks for, finished fit-out).
    expect(harborOffices.client?.name).toBe('Larkspur Analytics');
    // A week on rent either side of the steel, Wednesday to Wednesday: fourteen idle days.
    expect(harborOffices.booking).toMatchObject({ task_id: HARBOR_STEEL_TASK, billable_start: '2026-11-25', billable_end: '2026-12-24', idle_days: 14, rental_rate_minor: 60_000 });
    const steel = harborOfficesRecords.tasks.find((record) => record.id === HARBOR_STEEL_TASK)!;
    expect([steel.startDate, steel.endDate]).toEqual(['2026-12-02', '2026-12-17']);
    // The lift is booked on level 1's ceiling tiles as they are dated before any light fixtures go in.
    expect(harborOffices.moreBookings).toEqual([expect.objectContaining({ task_id: 116, idle_days: 0 })]);
    const rented = harborOffices.inlineData.assignmentsData.filter((assignment) => 'rentalStart' in assignment);
    expect(rented.map((assignment) => assignment.event).sort((a, b) => Number(a) - Number(b))).toEqual([HARBOR_STEEL_TASK, 116]);
  });

  it('splits every pour into forms, rebar, the pour and the cure, from the footings to level 3', () => {
    const { tasks } = harborOfficesRecords;
    const childrenOf = (id: number) => tasks.filter((record) => record.parentId === id).map((record) => record.name);
    // The footings end in their payment: pay to proceed, the slab waits for it.
    expect(childrenOf(20)).toEqual(['Form footings', 'Rebar, footings', 'Pour footings', 'Strip forms and backfill', 'Footings paid']);
    expect(childrenOf(30)).toEqual(['Gravel base and vapor barrier', 'Rebar, slab on grade', 'City inspection, slab', 'Pour slab on grade', 'Cure slab on grade']);
    for (const level of [1, 2, 3]) {
      const group = tasks.find((record) => record.name === `Concrete deck, level ${level}`)!;
      expect(group.parentId).toBe(40);
      expect(childrenOf(group.id)).toEqual([`Edge forms and shoring, level ${level}`, `Rebar and mesh, level ${level}`, `Pour deck, level ${level}`, `Cure deck, level ${level}`]);
    }
    // The building goes up before anyone builds inside it.
    const names = tasks.filter((record) => record.parentId === null).map((record) => record.name);
    expect(names).toEqual(['Site and foundations', 'Structure', 'Envelope', 'Ground floor build-out', 'Level 1 build-out', 'Level 2 build-out', 'Level 3 build-out', 'Completion']);
  });

  it('loads on the engine with the dates the seed derived, and no scheduling issue', async () => {
    const { project: model, issues } = await load();
    expect(issues).toEqual([]);
    for (const seeded of harborOfficesRecords.tasks) {
      const live = task(model, seeded.id);
      expect([iso(live.startDate), iso(live.endDate)], `task ${seeded.id} ${seeded.name}`).toEqual([seeded.startDate, seeded.endDate]);
    }
  });

  it('runs each floor in trade order and leaves the light fixtures their place', async () => {
    const { project: model } = await load();
    for (const level of [1, 2, 3]) {
      const n = level * 100;
      const at = (id: number) => task(model, n + id);
      expect(at(11).name).toBe(`Lay out partitions, level ${level}`);
      expect(at(14).name).toBe(`Ceiling grid, level ${level}`);
      expect(at(16).name).toBe(`Ceiling tiles, level ${level}`);
      // Cabling, drywall, the grid, the tiles, paint, floors.
      expect(at(13).endDate <= at(15).startDate).toBe(true);
      expect(at(15).endDate <= at(14).startDate).toBe(true);
      expect(at(14).endDate <= at(16).startDate).toBe(true);
      expect(at(16).endDate <= at(17).startDate).toBe(true);
      expect(at(17).endDate <= at(18).startDate).toBe(true);
      // No light fixtures yet: that is what the library piece adds.
      expect(model.taskStore.query((record) => /light/i.test((record as TaskModel).name ?? '')).length).toBe(0);
    }
  });

  it('is one line: each task waits for the one before it, finish to start, and nothing else', () => {
    const { dependencies, tasks } = harborOfficesRecords;
    const leaves = tasks.filter((record) => !tasks.some((other) => other.parentId === record.id));
    expect(dependencies).toHaveLength(leaves.length - 1);
    expect(new Set(dependencies.map((link) => link.fromEvent)).size).toBe(dependencies.length);
    expect(new Set(dependencies.map((link) => link.toEvent)).size).toBe(dependencies.length);
    expect(dependencies.every((link) => link.type === 2 && link.lag === 0)).toBe(true);
    // Row order is the line's order: a link only ever points at the next task down.
    leaves.slice(0, -1).forEach((record, index) => {
      expect(dependencies.find((link) => link.fromEvent === record.id)?.toEvent, record.name).toBe(leaves[index + 1]!.id);
    });
  });

  it('has its ceiling grid and tiles side by side, for the light fixtures to go between', () => {
    const { tasks } = harborOfficesRecords;
    for (const level of [1, 2, 3]) {
      const floor = tasks.filter((record) => record.parentId === level * 100).map((record) => record.name);
      expect(floor.indexOf(`Ceiling tiles, level ${level}`)).toBe(floor.indexOf(`Ceiling grid, level ${level}`) + 1);
    }
  });

  it('starts a floor when the one below is finished and hands over once every floor is', async () => {
    const { project: model } = await load();
    expect(task(model, 118).endDate <= task(model, 211).startDate).toBe(true);
    expect(task(model, 218).endDate <= task(model, 311).startDate).toBe(true);
    const handover = task(model, harborOffices.handover_task_id);
    expect(handover.isMilestone).toBe(true);
    for (const level of [1, 2, 3]) expect(task(model, level * 100 + 18).endDate <= handover.startDate).toBe(true);
  });

  it('aims at May 27 with the lease’s date, June 11, ten working days later, as the handover’s deadline', async () => {
    const record = harborOfficesRecords.tasks.find((row) => row.id === HARBOR_HANDOVER_TASK)!;
    expect(record.deadlineDate).toBe(HARBOR_CONTRACT_DATE);
    expect(HARBOR_CONTRACT_DATE).toBe('2027-06-11');
    const { project: model, issues } = await load();
    expect(issues).toEqual([]);
    const handover = task(model, HARBOR_HANDOVER_TASK) as TaskModel & { deadlineDate?: Date };
    expect(iso(handover.startDate)).toBe('2027-05-27');
    expect(iso(handover.deadlineDate)).toBe('2027-06-11');
    // Ten working days between them: Memorial Day is a day off.
    const calendar = (model as unknown as { calendar: { calculateDurationMs(start: Date, end: Date): number } }).calendar;
    expect(calendar.calculateDurationMs(handover.startDate as Date, handover.deadlineDate as Date) / 86_400_000).toBe(10);
  });
});

describe('Harbor’s contract date, kept everywhere the plan goes', () => {
  let clients: Client[] = [];
  afterEach(() => {
    disposeAll(clients);
    clients = [];
  });
  const deadlineOf = (model: ProjectModel) => iso((task(model, HARBOR_HANDOVER_TASK) as TaskModel & { deadlineDate?: Date }).deadlineDate);

  it('travels in the snapshot, reaches every browser, moves for everyone as a revision, and survives a reload', async () => {
    const snapshot = structuredClone(harborOffices.inlineData) as never;
    const relay = new InMemoryRelay({ projectId: PROJECT_ID, snapshot });
    const a = await joinClient(relay, 'client-a', loadResult(structuredClone(snapshot)));
    const b = await joinClient(relay, 'client-b', loadResult(structuredClone(snapshot)));
    clients = [a, b];
    await settle(clients, relay);
    expect([deadlineOf(a.project), deadlineOf(b.project)]).toEqual(['2027-06-11', '2027-06-11']);
    // As the inline data a reload starts from: a date without a time zone.
    expect(JSON.stringify(readProjectInlineData(a.project))).toContain('"deadlineDate":"2027-06-11T00:00:00"');

    await runProjectTransaction(a.project, 'Move the contract date', () => (task(a.project, HARBOR_HANDOVER_TASK) as TaskModel & { deadlineDate?: Date }).set('deadlineDate', new Date(2027, 5, 14)));
    await settle(clients, relay);
    expect(deadlineOf(b.project)).toBe('2027-06-14');

    // Browsers opened afterwards: from the seed snapshot and the revisions since, and from a snapshot saved now.
    const c = await joinClient(relay, 'client-c', loadResult(structuredClone(snapshot), 0, relay.rowsAfter(0)));
    clients.push(c);
    const saved = relay.loadResultFor(PROJECT_ID, a.project, relay.currentRevisionNo);
    const d = await joinClient(relay, 'client-d', saved);
    clients.push(d);
    await settle(clients, relay);
    expect([deadlineOf(c.project), deadlineOf(d.project)]).toEqual(['2027-06-14', '2027-06-14']);
  });
});
