import { addWorkingDays } from '@collab/shared/seed';
import { describe, expect, it } from 'vitest';
import { FakeDb } from '../src/dev/fake';
import {
  criticalPath,
  crewWorkload,
  findTasks,
  normalizeName,
  repeatingWork,
  scheduleFloat,
  scheduleHealth,
  similarPlaces,
  taskDetail,
} from '../src/plan/analysis';
import { lagInDays, planFromRows, type RevisionRowInput } from '../src/plan/rows';
import { buildTasks, type PlanSnapshot, type RawTask } from '../src/plan/snapshot';

function seedPlan(revisions: RevisionRowInput[] = []) {
  const db = new FakeDb();
  db.plan.revisions = revisions;
  return planFromRows(db.plan);
}

const ids = (rows: { id: number }[]) => rows.map((row) => row.id);

interface Node {
  id: number;
  name: string;
  children?: Node[];
}

/** A plan from a tree of names: every leaf one working day, one after the other in plan order. */
function handPlan(nodes: Node[], links: [number, number][] = []): PlanSnapshot {
  const raw: RawTask[] = [];
  let day = '2027-01-04';
  const place = (list: Node[], parentId: number | null): { start: string; end: string } => {
    let start = '';
    let end = '';
    list.forEach((node, orderedParentIndex) => {
      const row: RawTask = { id: node.id, name: node.name, parentId, startDate: '', endDate: '', orderedParentIndex };
      raw.push(row);
      let span: { start: string; end: string };
      if (node.children) {
        span = place(node.children, node.id);
      } else {
        span = { start: day, end: addWorkingDays(day, 1, 'standard') };
        day = span.end;
      }
      row.startDate = span.start;
      row.endDate = span.end;
      if (!start || span.start < start) start = span.start;
      if (!end || span.end > end) end = span.end;
    });
    return { start, end };
  };
  place(nodes, null);
  return {
    projectId: 'hand',
    projectName: 'Hand-built',
    currency: 'USD',
    revision: 0,
    statusDate: '2027-01-04',
    handoverTaskId: 0,
    tasks: buildTasks(raw),
    resources: [],
    assignments: [],
    dependencies: links.map(([from, to]) => ({ from, to, type: 2, lag: 0 })),
    bookings: [],
    members: [],
  };
}

describe('plan from database rows: links, crews and task fields', () => {
  it('keeps record ids on links and assignments, and the snapshot row order on tasks', () => {
    const plan = seedPlan();
    expect(plan.dependencies[0]).toEqual({ id: 1, from: 113, to: 114, type: 2, lag: 0 });
    expect(plan.assignments[0]).toEqual({ id: 1, taskId: 111, resourceId: 1, units: 100 });
    expect(plan.tasks.find((task) => task.id === 15)).toMatchObject({ order: 2, note: expect.stringContaining('Northgate Equipment Rental') });
  });

  it('lays added, updated and removed links and assignments over the snapshot', () => {
    const before = seedPlan();
    const fabricationLink = before.dependencies.find((link) => link.from === 232 && link.to === 233)!;
    const plan = seedPlan([
      {
        revision_no: 1,
        changes: {
          dependencies: {
            $input: { added: [{ $PhantomId: '_generated1', id: 500, fromEvent: 216, toEvent: 311, type: 2, lag: 1, lagUnit: 'week' }], removed: [{ id: 1 }] },
            added: [{ $PhantomId: '_generated1', id: 500, fromEvent: 216, toEvent: 311, type: 2, lag: 1, lagUnit: 'week' }],
            updated: [{ id: fabricationLink.id, lag: 3 }],
            removed: [{ id: 1 }],
          },
          assignments: {
            added: [{ id: 900, event: 213, resource: 1, units: 50 }],
            updated: [{ id: 1, units: 50 }],
            removed: [{ id: 2 }],
          },
        },
      },
      { revision_no: 2, changes: { dependencies: { updated: [{ id: 3, active: false }] } } },
    ]);
    expect(plan.dependencies.find((link) => link.id === 500)).toEqual({ id: 500, from: 216, to: 311, type: 2, lag: 5 });
    expect(plan.dependencies.some((link) => link.id === 1)).toBe(false);
    expect(plan.dependencies.find((link) => link.id === fabricationLink.id)).toMatchObject({ from: 232, to: 233, type: 3, lag: 3 });
    expect(plan.dependencies.find((link) => link.id === 3)).toMatchObject({ from: 111, to: 122, active: false });
    expect(plan.dependencies).toHaveLength(before.dependencies.length);
    expect(plan.assignments.find((assignment) => assignment.id === 900)).toEqual({ id: 900, taskId: 213, resourceId: 1, units: 50 });
    expect(plan.assignments.find((assignment) => assignment.id === 1)?.units).toBe(50);
    expect(plan.assignments.some((assignment) => assignment.id === 2)).toBe(false);
  });

  it('drops the tasks under a removed group, with their links and crews', () => {
    const plan = seedPlan([{ revision_no: 1, changes: { tasks: { removed: [{ id: 250 }] } } }]);
    expect(plan.tasks.some((task) => [250, 251, 252].includes(task.id))).toBe(false);
    expect(plan.dependencies.some((link) => [251, 252].includes(link.from) || [251, 252].includes(link.to))).toBe(false);
    expect(plan.assignments.some((assignment) => [251, 252].includes(assignment.taskId))).toBe(false);
  });

  it('carries constraints, notes and the sibling order revisions send', () => {
    const plan = seedPlan([
      {
        revision_no: 1,
        changes: {
          tasks: {
            updated: [
              { id: 15, constraintType: 'startnoearlierthan', constraintDate: '2026-12-11T00:00:00' },
              { id: 243, orderedParentIndex: 0, parentIndex: 0 },
              { id: 233, orderedParentIndex: 1, parentIndex: 1 },
              { id: 234, orderedParentIndex: 2, parentIndex: 2 },
              { id: 15, orderedParentIndex: 3, parentIndex: 3 },
              { id: 242, orderedParentIndex: 4, parentIndex: 4 },
            ],
          },
        },
      },
    ]);
    expect(plan.tasks.find((task) => task.id === 15)).toMatchObject({ constraintType: 'startnoearlierthan', constraintDate: '2026-12-11', order: 3 });
    expect(taskDetail(plan, 240)?.children.map((child) => child.id)).toEqual([243, 233, 234, 15, 242]);
    expect(taskDetail(plan, 15)?.constraint).toEqual({ type: 'startnoearlierthan', date: '2026-12-11' });
  });

  it('converts lags entered in other units to working days', () => {
    expect(lagInDays(1, 'week')).toBe(5);
    expect(lagInDays(12, 'h')).toBe(0.5);
    expect(lagInDays(1, 'month')).toBe(20);
    expect(lagInDays(-2, 'day')).toBe(-2);
    expect(lagInDays(3, undefined)).toBe(3);
  });
});

describe('float and the critical path', () => {
  const plan = seedPlan();

  it('puts the handover and the steel chain on the critical path; the footings have 8 days to spare', () => {
    const float = scheduleFloat(plan);
    expect(float[42]).toEqual({ float_days: 0, critical: true });
    for (const id of [232, 233, 234, 15, 242, 243]) expect(float[id]?.critical).toBe(true);
    // Cure spread footings finishes Mon, Nov 30; the erection cannot start before Fri, Dec 11 (the steel).
    expect(float[216]).toEqual({ float_days: 8, critical: false });
    expect(float[312]?.float_days).toBe(2);
    expect(Object.values(float).every((entry) => entry.float_days >= 0)).toBe(true);
  });

  it('walks the chain back from the handover through the steel delivery and the crane erection', () => {
    const path = criticalPath(plan);
    expect(path.finish).toEqual({ task_id: 42, name: 'Handover', date: '2027-04-28' });
    expect(path.chains.length).toBeGreaterThan(0);
    for (const chain of path.chains) {
      expect(chain.slice(0, 6)).toEqual([232, 233, 234, 15, 242, 243]);
      expect(chain.at(-1)).toBe(42);
    }
    // Finished work cannot move the handover, so it is not listed.
    expect(ids(path.tasks)).not.toContain(231);
    expect(path.tasks[0]).toMatchObject({ id: 232, name: 'Fabricate steel off-site', float_days: 0 });
    expect(path.tasks.find((task) => task.id === 15)).toMatchObject({ start: '2026-12-11', last_day: '2026-12-17', days: 6 });
    expect(path.critical_count).toBe(path.tasks.length);
    expect(path.near_critical.every((task) => task.float_days >= 1 && task.float_days <= 3)).toBe(true);
    expect(ids(path.near_critical)).toContain(312);
  });

  it('uses up the float when a revision moves work later: footings curing until Dec 10 become critical', () => {
    const delayed = seedPlan([{ revision_no: 1, changes: { tasks: { updated: [{ id: 216, startDate: '2026-11-20', endDate: '2026-12-11' }] } } }]);
    expect(scheduleFloat(delayed)[216]).toEqual({ float_days: 0, critical: true });
  });
});

describe('one task in full', () => {
  const plan = seedPlan();

  it('describes the crane erection: path, crews, links, float, note and money', () => {
    const detail = taskDetail(plan, 15)!;
    expect(detail).toMatchObject({
      name: 'Erect structural steel frame',
      kind: 'task',
      path: ['Foundations & steel frame', 'Steel delivery & frame erection'],
      start: '2026-12-11',
      last_day: '2026-12-17',
      days: 6,
      calendar: 'Mon-Sat',
      baseline: { start: '2026-12-11', last_day: '2026-12-17', start_slip_days: 0, finish_slip_days: 0 },
      float_days: 0,
      critical: true,
      constraint: null,
      money: { budget_minor: 9_600_000, forecast_minor: 9_840_000, incurred_minor: 0, paid_minor: 0 },
    });
    expect(detail.crews).toEqual([
      { name: 'Crane', units: 100, kind: 'equipment', company: 'Northgate Equipment Rental', trade: 'Equipment rental', on_site: { from: '2026-12-07', last_day: '2026-12-17' } },
      { name: 'Castlegate Steel', units: 100, kind: 'labor', company: 'Castlegate Steel', trade: 'Structural steel' },
    ]);
    expect(detail.predecessors.map((link) => `${link.task_id}:${link.type}:${link.lag_days}`)).toEqual(['234:finish-to-start:0', '216:finish-to-start:0']);
    expect(detail.predecessors[0]).toMatchObject({ name: 'Deliver & lay down steel', last_day: '2026-12-10' });
    expect(detail.successors.map((link) => link.task_id)).toEqual([242]);
    expect(detail.note).toContain('Erection starts once all the steel is on site');
  });

  it('names link types in plain words, and shows a split task’s pieces', () => {
    expect(taskDetail(plan, 233)!.predecessors[0]).toMatchObject({ task_id: 232, type: 'finish-to-finish', lag_days: 2 });
    expect(taskDetail(plan, 341)!.predecessors[0]).toMatchObject({ task_id: 321, type: 'start-to-start', lag_days: 3 });
    const fireProtection = taskDetail(plan, 321)!;
    expect(fireProtection.days).toBe(5);
    expect(fireProtection.segments?.map((segment) => segment.days)).toEqual([3, 2]);
  });

  it('describes a group: children in plan order, links across its edge, summed money', () => {
    const group = taskDetail(plan, 240)!;
    expect(group.kind).toBe('group');
    expect(group.children.map((child) => child.id)).toEqual([233, 234, 15, 242, 243]);
    expect(group.predecessors.map((link) => `${link.task_id}>${link.via?.task_id}`)).toEqual(['232>233', '216>15']);
    expect(group.successors.map((link) => link.task_id)).toEqual([251]);
    expect(group.money.budget_minor).toBe((16_000 + 9_500 + 96_000 + 12_000 + 3_800) * 100);
    expect(group.critical).toBe(true);
    expect(taskDetail(plan, 200)!.kind).toBe('phase');
    expect(taskDetail(plan, 999_999)).toBeNull();
  });
});

describe('finding tasks', () => {
  const plan = seedPlan();

  it('finds by crew, by words in the name or note, and by phase and status', () => {
    expect(findTasks(plan, { crew: 'crane' })).toEqual({
      total: 1,
      tasks: [
        {
          id: 15,
          name: 'Erect structural steel frame',
          kind: 'task',
          phase: 'Foundations & steel frame',
          parent: 'Steel delivery & frame erection',
          start: '2026-12-11',
          last_day: '2026-12-17',
          days: 6,
          percent_done: 0,
          crews: ['Crane', 'Castlegate Steel'],
          critical: true,
        },
      ],
    });
    // "crane" is in the erection note and in the ventilation note (a truck-mounted crane lifts the unit onto the roof).
    expect(ids(findTasks(plan, { text: 'crane', leaves_only: true }).tasks)).toEqual([15, 342]);
    expect(ids(findTasks(plan, { text: 'Crane ROOF' }).tasks)).toEqual([342]);
    expect(ids(findTasks(plan, { text: 'hold point', leaves_only: true }).tasks)).toEqual([213, 331]);
    expect(ids(findTasks(plan, { phase: 'Testing', status: 'milestone' }).tasks)).toEqual([42]);
    expect(ids(findTasks(plan, { status: 'milestone' }).tasks)).toEqual([315, 42]);
  });

  it('filters by dates and progress, and caps the rows but not the total', () => {
    expect(ids(findTasks(plan, { crew: 'Electrical', from: '2027-04-01', to: '2027-04-30' }).tasks)).toEqual([513, 611]);
    expect(ids(findTasks(plan, { from: '2026-12-14', to: '2026-12-18', leaves_only: true }).tasks)).toEqual([15, 242]);
    expect(ids(findTasks(plan, { status: 'done', leaves_only: true }).tasks)).toEqual([111, 112, 113, 114, 121, 122, 123, 124, 231]);
    expect(ids(findTasks(plan, { status: 'in_progress', leaves_only: true }).tasks)).toEqual([232, 211]);
    // Half done, and its last day (Tue, Nov 10) is before the status date.
    expect(ids(findTasks(plan, { status: 'late' }).tasks)).toEqual([211]);
    const critical = findTasks(plan, { status: 'critical', limit: 3 });
    expect(critical.total).toBe(criticalPath(plan).critical_count);
    expect(ids(critical.tasks)).toEqual([232, 233, 234]);
    const all = findTasks(plan, { leaves_only: true });
    expect(all.total).toBe(70);
    expect(all.tasks).toHaveLength(25);
  });
});

describe('crew workload', () => {
  it('counts the crane’s six site days in the two weeks it works', () => {
    const { crews } = crewWorkload(seedPlan(), { crew: 'Crane' });
    expect(crews).toEqual([
      {
        crew: 'Crane',
        kind: 'equipment',
        company: 'Northgate Equipment Rental',
        trade: 'Equipment rental',
        booked_days: 6,
        busy_days: 6,
        tasks: 1,
        weeks: [
          { week_of: '2026-12-07', days: 2 },
          { week_of: '2026-12-14', days: 4 },
        ],
        peak_week: { week_of: '2026-12-14', days: 4 },
        overloaded_days: [],
        overloaded_day_count: 0,
      },
    ]);
  });

  it('keeps to the window and lists every crew that works', () => {
    const december = crewWorkload(seedPlan(), { crew: 'Calloway', from: '2026-12-01', to: '2026-12-31' }).crews[0]!;
    expect(december.weeks).toEqual([
      { week_of: '2026-11-30', days: 1 },
      { week_of: '2026-12-07', days: 4 },
      { week_of: '2026-12-21', days: 2 },
    ]);
    const all = crewWorkload(seedPlan());
    expect(all.crews).toHaveLength(12);
    expect(all.idle_crews).toEqual([]);
    expect(all.crews.every((crew) => crew.overloaded_day_count === 0)).toBe(true);
  });

  it('finds the days a crew is needed twice', () => {
    // The electricians put on the ductwork as well: it overlaps the cable pulling for four days.
    const plan = seedPlan([{ revision_no: 1, changes: { assignments: { added: [{ id: 900, event: 342, resource: 2, units: 100 }] } } }]);
    const electricians = crewWorkload(plan, { crew: 'electrical' }).crews[0]!;
    expect(electricians.overloaded_day_count).toBe(4);
    expect(electricians.overloaded_days[0]).toEqual({
      date: '2027-02-02',
      units: 200,
      tasks: ['Electrical rough-in: conduit & cabling', 'Ventilation ductwork & air handling unit'],
    });
    expect(electricians.peak_week).toEqual({ week_of: '2027-02-01', days: 9 });
  });
});

describe('schedule health', () => {
  it('passes the seed on everything but crews: eight open working tasks have none', () => {
    const health = scheduleHealth(seedPlan());
    expect(health).toMatchObject({ passed: 9, total: 10 });
    const byId = Object.fromEntries(health.checks.map((entry) => [entry.id, entry]));
    expect(byId.no_crew).toMatchObject({ passed: false, count: 8, severity: 'low', task_ids: [232, 213, 216, 233, 312, 314, 422, 624] });
    expect(byId.link_types).toMatchObject({ passed: true, count: 10 });
    expect(byId.link_types!.detail).toBe('10 of 106 links (9%) are not finish-to-start: 9 start-to-start, 1 finish-to-finish.');
    for (const id of ['missing_logic', 'leads', 'long_lags', 'hard_constraints', 'long_durations', 'crew_overloads', 'finish_slips', 'negative_float']) {
      expect(byId[id], id).toMatchObject({ passed: true, count: 0 });
    }
  });

  it('catches a broken link to the handover, a lead, a fixed date and a slip', () => {
    const toHandover = seedPlan().dependencies.find((link) => link.from === 624 && link.to === 42)!;
    const health = scheduleHealth(
      seedPlan([
        {
          revision_no: 1,
          changes: {
            dependencies: { removed: [{ id: toHandover.id }], added: [{ id: 700, fromEvent: 411, toEvent: 413, type: 2, lag: -2, lagUnit: 'day' }] },
            tasks: {
              updated: [
                { id: 463, constraintType: 'mustfinishon', constraintDate: '2027-03-31T00:00:00' },
                { id: 42, startDate: '2027-04-30', endDate: '2027-04-30' },
              ],
            },
          },
        },
      ]),
    );
    const byId = Object.fromEntries(health.checks.map((entry) => [entry.id, entry]));
    expect(byId.missing_logic).toMatchObject({ passed: false, severity: 'high', task_ids: [42, 624] });
    expect(byId.leads).toMatchObject({ passed: false, count: 1, task_ids: [413] });
    expect(byId.hard_constraints).toMatchObject({ count: 1, task_ids: [463] });
    expect(byId.finish_slips).toMatchObject({ passed: false, severity: 'high', task_ids: [42] });
    expect(byId.finish_slips!.detail).toContain('The handover is 2 working days late.');
  });
});

describe('work worth saving to the library', () => {
  const room = (n: number, id: number): Node => ({
    id,
    name: `Room ${n} build-out`,
    children: [
      { id: id + 1, name: `Room ${n} walls` },
      { id: id + 2, name: `Room ${n} rough-in` },
      { id: id + 3, name: `Room ${n} drywall` },
      { id: id + 4, name: `Room ${n} painting` },
    ],
  });

  it('finds three rooms built out the same way, then the self-contained groups', () => {
    const chain = (first: number) => [[first, first + 1], [first + 1, first + 2], [first + 2, first + 3]] as [number, number][];
    const plan = handPlan(
      [
        { id: 1, name: 'Build-out', children: [room(1, 10), room(2, 20), room(3, 30)] },
        { id: 2, name: 'Commissioning', children: [{ id: 41, name: 'Electrical testing' }, { id: 42, name: 'Water testing' }, { id: 43, name: 'Handover' }] },
      ],
      [...chain(11), ...chain(21), ...chain(31), [14, 21], [24, 31], [41, 42], [42, 43], [34, 41]],
    );
    const candidates = repeatingWork(plan);
    expect(candidates[0]).toMatchObject({ group_ids: [10, 20, 30], sample_id: 10, name: 'Room 1 build-out', leaf_count: 4, span_days: 4, reason: 'repeats' });
    expect(candidates.slice(1).map((candidate) => `${candidate.sample_id}:${candidate.reason}`)).toEqual(['1:self_contained', '2:self_contained']);
    expect(candidates[0]!.score).toBeGreaterThan(candidates[1]!.score);
  });

  it('prefers whole levels over the rooms repeated inside them', () => {
    const level = (n: number, id: number, rooms: number[]): Node => ({ id, name: `Level ${n}`, children: rooms.map((r, at) => room(r, id + 10 * (at + 1))) });
    const candidates = repeatingWork(handPlan([level(1, 100, [1, 2]), level(2, 200, [3, 4])]));
    expect(candidates.map((candidate) => candidate.group_ids)).toEqual([
      [100, 200],
      [110, 120, 210, 220],
    ]);
  });

  it('reports the seed’s linked work packages, best formed first', () => {
    const candidates = repeatingWork(seedPlan());
    expect(candidates).toHaveLength(8);
    expect(candidates.every((candidate) => candidate.reason === 'self_contained' && candidate.leaf_count >= 3 && candidate.leaf_count <= 15)).toBe(true);
    expect(candidates.map((candidate) => candidate.sample_id)).toContain(210);
    expect(candidates.find((candidate) => candidate.sample_id === 210)).toMatchObject({ name: 'Spread footings', leaf_count: 6, crews: ['Calloway Construction', 'Concrete pump'] });
  });

  it('takes the numbering out of names', () => {
    expect(normalizeName('Room 2 – rough-in (east)')).toBe('room rough in east');
    expect(normalizeName('Level 2 rooms')).toBe('level rooms');
    expect(normalizeName('First floor rooms')).toBe('floor rooms');
    expect(normalizeName('Room A walls')).toBe('room walls');
    expect(normalizeName('3rd fix')).toBe('fix');
    expect(normalizeName('Rooms not ready')).toBe('rooms not ready');
  });
});

describe('other places for a dropped piece', () => {
  it('suggests the matching rooms on other levels and later in the same level, not where it already is', () => {
    const plan = handPlan([
      {
        id: 100,
        name: 'Level 1 rooms',
        children: [
          { id: 101, name: 'Room 1 rough-in' },
          { id: 150, name: 'Pressure test', children: [{ id: 151, name: 'Fill & pressurize' }, { id: 152, name: 'Hold & inspect' }] },
          { id: 102, name: 'Room 1 trim-out' },
          { id: 103, name: 'Room 2 rough-in' },
          { id: 104, name: 'Room 2 trim-out' },
        ],
      },
      {
        id: 200,
        name: 'Level 2 rooms',
        children: [
          { id: 201, name: 'Room 3 rough-in' },
          { id: 202, name: 'Room 3 trim-out' },
          { id: 203, name: 'Room 4 rough-in' },
          { id: 205, name: 'Pressure test' },
          { id: 204, name: 'Room 4 trim-out' },
        ],
      },
      { id: 300, name: 'Level 3 rooms', children: [{ id: 301, name: 'Room 5 rough-in' }, { id: 302, name: 'Room 5 trim-out' }] },
      { id: 400, name: 'Roof', children: [{ id: 401, name: 'Roof deck' }, { id: 402, name: 'Roof rough-in' }] },
    ]);
    const places = similarPlaces(plan, { added_top_ids: [150], anchor_id: 101, parent_id: 100 });
    expect(places.map((place) => `${place.parent_id}:${place.anchor_id}`)).toEqual(['200:201', '300:301', '100:103']);
    expect(places[0]).toMatchObject({ position: 'after', label: 'After “Room 3 rough-in” in “Level 2 rooms”', score: 1 });
    expect(places[0]!.why).toContain('no “Pressure test” there yet');
  });

  it('works for rooms that are groups of their own, after the same task or at the end', () => {
    const rooms = (dropAt: 'after' | 'end') =>
      handPlan([
        {
          id: 10,
          name: 'Room 1',
          children:
            dropAt === 'after'
              ? [{ id: 11, name: 'Rough-in' }, { id: 15, name: 'Pressure test' }, { id: 12, name: 'Trim-out' }]
              : [{ id: 11, name: 'Rough-in' }, { id: 12, name: 'Trim-out' }, { id: 15, name: 'Pressure test' }],
        },
        { id: 20, name: 'Room 2', children: [{ id: 21, name: 'Rough-in' }, { id: 22, name: 'Trim-out' }] },
        { id: 30, name: 'Room 3', children: [{ id: 31, name: 'Rough-in' }, { id: 35, name: 'Pressure test' }, { id: 32, name: 'Trim-out' }] },
        { id: 40, name: 'Store', children: [{ id: 41, name: 'Rough-in' }] },
      ]);
    expect(similarPlaces(rooms('after'), { added_top_ids: [15], anchor_id: 11, parent_id: 10 })).toEqual([
      {
        parent_id: 20,
        anchor_id: 21,
        position: 'after',
        label: 'After “Rough-in” in “Room 2”',
        why: '“Room 2” is laid out like “Room 1” and has its own “Rough-in”; there is no “Pressure test” there yet.',
        score: 1,
      },
    ]);
    expect(similarPlaces(rooms('end'), { added_top_ids: [15], anchor_id: null, parent_id: 10 })).toEqual([
      expect.objectContaining({ parent_id: 20, anchor_id: null, position: 'end', label: 'At the end of “Room 2”' }),
    ]);
    expect(similarPlaces(rooms('end'), { added_top_ids: [999], anchor_id: null, parent_id: 10 })).toEqual([]);
  });
});
