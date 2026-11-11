import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CEDAR_IDS,
  HARBOR_COPIES,
  HARBOR_COPY_COUNT,
  HARBOR_IDS,
  HARBOR_QUOTES,
  SEED_IDS,
  SEED_MEMBERS,
  SEED_PROJECTS,
  SEED_PROJECT_START,
  SEED_SHUTDOWN,
  addDays,
  addWorkingDays,
  countWorkingDays,
  isWorkingDay,
  nextWorkingDay,
  cedarParkClinic,
  cedarParkRecords,
  harborCopyIds,
  harborOffices,
  riversideClinic,
  riversideClinicRecords,
  subtractWorkingDays,
  type SeedTaskRecord,
  type SeedTaskRow,
} from '../src/seed/index';
import { canonicalJson, renderSeedSnapshotsSql, sqlLiteral } from '../src/seed/snapshot-sql';
import { starterLibrarySeed } from '../src/library-starter';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** The demo is recorded on Tuesday, November 10, 2026: progress must agree with that "today". */
const DEMO_TODAY = '2026-11-10';
const { tasks, dependencies, resources, assignments, calendars } = riversideClinicRecords;
const taskById = new Map(tasks.map((task) => [task.id, task]));
const childrenOf = (parent: SeedTaskRecord) => tasks.filter((task) => task.parentId === parent.id);
const isLeaf = (task: SeedTaskRecord) => !tasks.some((other) => other.parentId === task.id);
const leaves = tasks.filter(isLeaf);
const summaries = tasks.filter((task) => !isLeaf(task));
const phases = tasks.filter((task) => task.parentId === null);
const erection = taskById.get(riversideClinic.booking.task_id) as SeedTaskRecord;
const handover = taskById.get(riversideClinic.handover_task_id) as SeedTaskRecord;

function flattenRows(rows: SeedTaskRow[], parentId: number | null = null): SeedTaskRecord[] {
  return rows.flatMap((row) => {
    const { children, ...fields } = row;
    return [{ ...fields, parentId }, ...flattenRows(children ?? [], row.id)];
  });
}

/** 0 for a phase, 1 for a work package, ... */
function depthOf(task: SeedTaskRecord): number {
  return task.parentId === null ? 0 : 1 + depthOf(taskById.get(task.parentId) as SeedTaskRecord);
}

function phaseOf(task: SeedTaskRecord): SeedTaskRecord {
  return task.parentId === null ? task : phaseOf(taskById.get(task.parentId) as SeedTaskRecord);
}

function leavesUnder(task: SeedTaskRecord): SeedTaskRecord[] {
  return isLeaf(task) ? [task] : childrenOf(task).flatMap(leavesUnder);
}

function ancestorsOf(task: SeedTaskRecord): Set<number> {
  const ids = new Set<number>();
  for (let parentId = task.parentId; parentId !== null; parentId = (taskById.get(parentId) as SeedTaskRecord).parentId) ids.add(parentId);
  return ids;
}

/** The grid with every row expanded: depth-first over the nested rows, siblings in authored order. */
const gridRows = flattenRows(riversideClinic.inlineData.tasksData);
/** How far (in working days) a row may start after the latest finish of the rows above it. */
const MAX_GAP_WORKING_DAYS = 3;

/** WCAG contrast ratio of white text on `hex`. */
function contrastWithWhite(hex: string): number {
  const channel = (offset: number) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  return 1.05 / (luminance + 0.05);
}

describe('working-day arithmetic', () => {
  it('treats weekends and the holiday shutdown as non-working', () => {
    expect(isWorkingDay('2026-11-02', 'standard')).toBe(true); // Monday
    expect(isWorkingDay('2026-11-07', 'standard')).toBe(false); // Saturday
    expect(isWorkingDay('2026-11-07', 'site')).toBe(true);
    expect(isWorkingDay('2026-11-08', 'site')).toBe(false); // Sunday
    expect(isWorkingDay(SEED_SHUTDOWN.startDate, 'site')).toBe(false);
    expect(isWorkingDay('2026-12-28', 'standard')).toBe(false);
    expect(isWorkingDay(SEED_SHUTDOWN.endDate, 'standard')).toBe(true);
  });

  it('accumulates working days with an exclusive end', () => {
    expect(addWorkingDays('2026-11-02', 2, 'standard')).toBe('2026-11-04');
    expect(addWorkingDays('2026-11-06', 1, 'standard')).toBe('2026-11-07');
    expect(nextWorkingDay('2026-11-07', 'standard')).toBe('2026-11-09');
    expect(nextWorkingDay('2026-11-07', 'site')).toBe('2026-11-07');
    expect(nextWorkingDay(SEED_SHUTDOWN.startDate, 'standard')).toBe('2027-01-04');
    expect(countWorkingDays('2026-11-02', '2026-11-09', 'standard')).toBe(5);
    expect(countWorkingDays('2026-11-02', '2026-11-09', 'site')).toBe(6);
  });

  it('counts back from an exclusive end', () => {
    expect(subtractWorkingDays('2026-11-11', 3, 'standard')).toBe('2026-11-06'); // Fri, Mon, Tue
    expect(subtractWorkingDays('2026-11-09', 1, 'standard')).toBe('2026-11-06'); // over the weekend
    expect(subtractWorkingDays('2026-11-09', 1, 'site')).toBe('2026-11-07');
    expect(subtractWorkingDays('2027-01-05', 2, 'standard')).toBe('2026-12-23'); // over the shutdown
  });
});

describe('Riverside Clinic seed structure', () => {
  it('keeps the shared identifiers and members', () => {
    expect(SEED_IDS.project).toMatch(/^[0-9a-f-]{36}$/);
    expect(SEED_IDS.booking).not.toBe(SEED_IDS.project);
    expect(riversideClinic.members).toBe(SEED_MEMBERS);
    // One role for the demo: every member sees costs and can approve a fix within the same limit.
    expect(SEED_MEMBERS.map((member) => member.email)).toEqual(['pm@demo.local', 'cm@demo.local']);
    expect(SEED_MEMBERS.every((member) => member.role === 'cm' && member.can_view_costs && member.approval_limit_minor === 25_000_000)).toBe(true);
    expect(riversideClinic.name).toBe('Riverside Clinic');
    expect(riversideClinic.currency).toBe('USD');
  });

  it('has 80-110 tasks in 6 phases: phase, work package and task everywhere, a fourth level in places', () => {
    expect(tasks.length).toBeGreaterThanOrEqual(80);
    expect(tasks.length).toBeLessThanOrEqual(110);
    expect(phases).toHaveLength(6);
    expect(new Set(tasks.map((task) => task.id)).size).toBe(tasks.length);
    for (const task of tasks) {
      expect(Number.isInteger(task.id)).toBe(true);
      expect(task.id).toBeGreaterThan(0);
      expect(task.id).toBeLessThan(1000);
      if (task.parentId !== null) expect(isLeaf(taskById.get(task.parentId) as SeedTaskRecord)).toBe(false);
    }
    expect(flattenRows(riversideClinic.inlineData.tasksData)).toEqual(tasks);
    // Phases hold work packages only; every task sits at least three levels down.
    for (const phase of phases) expect(childrenOf(phase).every((child) => !isLeaf(child))).toBe(true);
    for (const leaf of leaves) expect([2, 3]).toContain(depthOf(leaf));
    const subPackages = summaries.filter((summary) => depthOf(summary) === 2);
    expect(new Set(subPackages.map((summary) => summary.parentId)).size).toBeGreaterThanOrEqual(2);
    expect(summaries.filter((summary) => depthOf(summary) > 2)).toEqual([]);
  });

  it('folds only the finished site-setup phase', () => {
    for (const summary of summaries) {
      expect(summary.expanded, `expanded of task ${summary.id}`).toBe(summary !== phases[0]);
    }
    expect(phases[0]?.percentDone).toBe(100);
    for (const leaf of leaves) expect(leaf.expanded).toBeUndefined();
  });

  it('uses plain YYYY-MM-DD dates everywhere and starts on Monday, November 2, 2026', () => {
    expect(SEED_PROJECT_START).toBe('2026-11-02');
    expect(riversideClinic.inlineData.startDate).toBe(SEED_PROJECT_START);
    expect(riversideClinic.inlineData.project.startDate).toBe(SEED_PROJECT_START);
    expect(riversideClinic.inlineData.project).toEqual({
      startDate: SEED_PROJECT_START,
      calendar: 'standard',
      hoursPerDay: 24,
      daysPerWeek: 5,
      daysPerMonth: 20,
    });
    for (const task of tasks) {
      expect(task.startDate).toMatch(ISO_DATE);
      expect(task.endDate).toMatch(ISO_DATE);
      expect(task.baselines).toEqual([{ startDate: task.startDate, endDate: task.endDate }]);
      expect(task.startDate >= SEED_PROJECT_START).toBe(true);
      for (const segment of task.segments ?? []) {
        expect(segment.startDate).toMatch(ISO_DATE);
        expect(segment.endDate).toMatch(ISO_DATE);
      }
    }
    for (const calendar of calendars) {
      for (const interval of calendar.intervals) {
        if (interval.startDate) expect(interval.startDate).toMatch(ISO_DATE);
        if (interval.endDate) expect(interval.endDate).toMatch(ISO_DATE);
      }
    }
  });

  it('schedules each leaf after its predecessors in its own calendar', () => {
    for (const leaf of leaves) {
      const calendar = leaf.calendar ?? 'standard';
      expect(isWorkingDay(leaf.startDate, calendar) || leaf.duration === 0).toBe(true);
      if (!leaf.segments) expect(countWorkingDays(leaf.startDate, leaf.endDate, calendar)).toBe(leaf.duration);
      const incoming = dependencies.filter((candidate) => candidate.toEvent === leaf.id);
      for (const dep of incoming) {
        const predecessor = taskById.get(dep.fromEvent) as SeedTaskRecord;
        if (dep.type === 2) expect(leaf.startDate >= predecessor.endDate).toBe(true);
        else if (dep.type === 0) expect(leaf.startDate >= addWorkingDays(predecessor.startDate, dep.lag, calendar)).toBe(true);
        else expect(leaf.endDate >= addWorkingDays(predecessor.endDate, dep.lag, calendar)).toBe(true);
      }
      // As early as the links allow: no leaf waits without a reason.
      if (incoming.length === 0) expect(leaf.startDate).toBe(SEED_PROJECT_START);
    }
    for (const summary of summaries) {
      const children = childrenOf(summary);
      expect(summary.startDate).toBe(children.map((child) => child.startDate).sort()[0]);
      expect(summary.endDate).toBe(children.map((child) => child.endDate).sort().at(-1));
      expect(summary.duration).toBeUndefined();
      expect(summary.segments).toBeUndefined();
    }
  });

  it('splits a few tasks into pieces of work separated by pauses', () => {
    const split = leaves.filter((leaf) => leaf.segments);
    expect(split.length).toBeGreaterThanOrEqual(2);
    expect(split.length).toBeLessThanOrEqual(3);
    for (const task of split) {
      const segments = task.segments ?? [];
      const calendar = task.calendar ?? 'standard';
      expect(segments.length).toBeGreaterThanOrEqual(2);
      // A split task's duration is its work only; the pauses between the pieces do not count.
      expect(segments.reduce((total, segment) => total + segment.duration, 0)).toBe(task.duration);
      expect(segments[0]?.startDate).toBe(task.startDate);
      expect(segments.at(-1)?.endDate).toBe(task.endDate);
      expect(countWorkingDays(task.startDate, task.endDate, calendar)).toBeGreaterThan(task.duration as number);
      segments.forEach((segment, index) => {
        expect(segment.name).toBeTruthy();
        expect(isWorkingDay(segment.startDate, calendar)).toBe(true);
        expect(countWorkingDays(segment.startDate, segment.endDate, calendar)).toBe(segment.duration);
        const previous = segments[index - 1];
        if (previous) expect(countWorkingDays(previous.endDate, segment.startDate, calendar)).toBeGreaterThan(0);
      });
    }
  });

  it('links tasks mostly Finish-to-Start, with lagged Start-to-Start overlaps and a Finish-to-Finish', () => {
    expect(new Set(dependencies.map((dep) => dep.id)).size).toBe(dependencies.length);
    expect(new Set(dependencies.map((dep) => `${dep.fromEvent}>${dep.toEvent}`)).size).toBe(dependencies.length);
    for (const dep of dependencies) {
      expect(isLeaf(taskById.get(dep.fromEvent) as SeedTaskRecord)).toBe(true);
      expect(isLeaf(taskById.get(dep.toEvent) as SeedTaskRecord)).toBe(true);
      expect([0, 2, 3]).toContain(dep.type);
      expect(dep.lagUnit).toBe('day');
    }
    const byType = (type: number) => dependencies.filter((dep) => dep.type === type);
    expect(byType(2).every((dep) => dep.lag === 0)).toBe(true);
    expect(byType(0).length).toBeGreaterThanOrEqual(2);
    expect(byType(0).every((dep) => dep.lag > 0)).toBe(true);
    expect(byType(3).length).toBeGreaterThanOrEqual(1);
    expect(byType(2).length).toBeGreaterThan(dependencies.length * 0.8);
    // Logic, not a single chain: some tasks wait for several others, some release several.
    expect(leaves.some((leaf) => dependencies.filter((dep) => dep.toEvent === leaf.id).length >= 4)).toBe(true);
    expect(leaves.some((leaf) => dependencies.filter((dep) => dep.fromEvent === leaf.id).length >= 4)).toBe(true);
    // No loose ends: every task except the Handover releases something.
    const withSuccessor = new Set(dependencies.map((dep) => dep.fromEvent));
    expect(leaves.filter((leaf) => !withSuccessor.has(leaf.id)).map((leaf) => leaf.id)).toEqual([handover.id]);
  });

  it('defines the crews\' two calendars and the inspector\'s, and uses the site calendar only for crane erection', () => {
    expect(calendars.map((calendar) => calendar.id)).toEqual(['standard', 'site', 'inspector']);
    expect(riversideClinic.inlineData.calendar).toBe('standard');
    expect(erection.calendar).toBe('site');
    expect(tasks.filter((task) => task.calendar === 'site')).toEqual([erection]);
    for (const calendar of calendars) {
      expect(calendar.intervals.every((interval) => interval.isWorking === false)).toBe(true);
      expect(calendar.intervals.some((interval) => interval.name === 'Holiday shutdown')).toBe(true);
    }
  });

  it('has a roster of crews (by firm, with a trade) and equipment, each with a color, an icon and a logo', () => {
    expect(resources.length).toBeGreaterThanOrEqual(10);
    expect(resources.length).toBeLessThanOrEqual(12);
    expect(new Set(resources.map((resource) => resource.id)).size).toBe(resources.length);
    expect(new Set(resources.map((resource) => resource.name)).size).toBe(resources.length);
    expect(new Set(resources.map((resource) => resource.eventColor)).size).toBe(resources.length);
    expect(new Set(resources.map((resource) => resource.iconCls)).size).toBe(resources.length);
    expect(new Set(resources.map((resource) => resource.imageUrl)).size).toBe(resources.length);
    for (const resource of resources) {
      // Logos live in apps/web/public/crews (checked in apps/web/test/seed).
      expect(resource.imageUrl).toMatch(/^\/crews\/[a-z0-9-]+\.png$/);
      expect(resource.company).toMatch(/\S/);
      expect(resource.eventColor).toMatch(/^#[0-9a-f]{6}$/);
      expect(contrastWithWhite(resource.eventColor), `${resource.name} color carries white text`).toBeGreaterThanOrEqual(4.5);
      expect(resource.iconCls).toMatch(/^fa fa-[a-z-]+$/);
      expect(['labor', 'equipment']).toContain(resource.kind);
      expect(resource.trade).toMatch(/\S/);
      // A crew goes by its firm's name; its trade is a label.
      if (resource.kind === 'labor') expect(resource.name).toBe(resource.company);
    }
    const crane = resources.find((resource) => resource.id === riversideClinic.booking.resource_id);
    expect(crane).toEqual({
      id: riversideClinic.booking.resource_id,
      name: 'Crane',
      trade: 'Equipment rental',
      kind: 'equipment',
      company: riversideClinic.booking.supplier_name,
      eventColor: expect.any(String),
      iconCls: 'fa fa-weight-hanging',
      imageUrl: '/crews/crane.png',
      calendar: 'site',
    });
    expect(crane?.company).toBe('Northgate Equipment Rental');
    expect(resources.filter((resource) => resource.kind === 'equipment').map((resource) => resource.name)).toEqual(['Crane', 'Concrete pump']);
    expect(resources.filter((resource) => resource.calendar === 'site').map((resource) => resource.name)).toEqual(['Crane', 'Castlegate Steel']);
    expect(resources.filter((resource) => resource.kind === 'labor').map((resource) => resource.name)).toEqual(
      expect.arrayContaining(['Calloway Construction', 'Halden Electrical', 'Brightwater Plumbing', 'Castlegate Steel']),
    );
  });

  it('assigns a crew to most tasks, the crane to the erection only, and never double-books a crew', () => {
    const resourceIds = new Set(resources.map((resource) => resource.id));
    expect(new Set(assignments.map((assignment) => assignment.id)).size).toBe(assignments.length);
    expect(new Set(assignments.map((assignment) => `${assignment.event}/${assignment.resource}`)).size).toBe(assignments.length);
    for (const assignment of assignments) {
      const task = taskById.get(assignment.event) as SeedTaskRecord;
      expect(isLeaf(task)).toBe(true);
      expect(task.duration).toBeGreaterThan(0);
      expect(resourceIds.has(assignment.resource)).toBe(true);
      expect(assignment.units).toBe(100);
    }
    const assignedLeaves = new Set(assignments.map((assignment) => assignment.event));
    expect(assignedLeaves.size / leaves.length).toBeGreaterThan(0.8);
    expect(leaves.filter((leaf) => assignments.filter((assignment) => assignment.event === leaf.id).length === 2).length).toBeGreaterThanOrEqual(4);
    // The booked crane works the erection and nothing else (the booking's activity list).
    const craneTasks = assignments.filter((assignment) => assignment.resource === riversideClinic.booking.resource_id).map((assignment) => assignment.event);
    expect(craneTasks).toEqual([erection.id]);
    // Resources working the Mon-Sat erection task must themselves work Saturdays, otherwise the
    // engine's task/resource calendar intersection would clip the task.
    for (const assignment of assignments.filter((candidate) => candidate.event === erection.id)) {
      expect(resources.find((resource) => resource.id === assignment.resource)?.calendar).toBe('site');
    }
    // No crew is on two tasks on the same working day (pauses of split tasks are free time).
    const booked = new Map<string, number>();
    for (const assignment of assignments) {
      const task = taskById.get(assignment.event) as SeedTaskRecord;
      const calendar = task.calendar ?? 'standard';
      for (const piece of task.segments ?? [task]) {
        for (let day = piece.startDate; day < piece.endDate; day = addDays(day, 1)) {
          if (!isWorkingDay(day, calendar)) continue;
          const key = `${assignment.resource}@${day}`;
          expect(booked.get(key), `resource ${assignment.resource} on ${day}: tasks ${booked.get(key)} and ${task.id}`).toBeUndefined();
          booked.set(key, task.id);
        }
      }
    }
  });

  it('ends with the Handover milestone', () => {
    expect(handover.name).toBe('Handover');
    expect(handover.duration).toBe(0);
    expect(handover.startDate).toBe(handover.endDate);
    expect(handover.startDate).toBe('2027-04-28');
    expect(tasks.every((task) => task.endDate <= handover.endDate)).toBe(true);
    expect(dependencies.some((dep) => dep.fromEvent === handover.id)).toBe(false);
  });

  it('marks site setup complete, the substructure in progress and the rest not started, as of the demo date', () => {
    expect(leavesUnder(phases[0] as SeedTaskRecord).every((task) => task.percentDone === 100)).toBe(true);
    const substructure = phases[1] as SeedTaskRecord;
    expect(substructure.percentDone).toBeGreaterThan(0);
    expect(substructure.percentDone).toBeLessThan(100);
    expect(leavesUnder(substructure).some((task) => task.percentDone === 100)).toBe(true);
    expect(leavesUnder(substructure).some((task) => task.percentDone > 0 && task.percentDone < 100)).toBe(true);
    for (const phase of phases.slice(2)) {
      expect(phase.percentDone).toBe(0);
      expect(leavesUnder(phase).every((task) => task.percentDone === 0)).toBe(true);
    }
    for (const leaf of leaves) {
      if (leaf.percentDone === 100) expect(leaf.endDate <= DEMO_TODAY).toBe(true);
      else if (leaf.percentDone > 0) expect(leaf.startDate <= DEMO_TODAY && DEMO_TODAY < leaf.endDate).toBe(true);
      else expect(leaf.startDate > DEMO_TODAY).toBe(true);
    }
  });
});

describe('Riverside Clinic seed reads as a waterfall', () => {
  it('lists the rows in time order: every row starts on or after the row above it', () => {
    expect(gridRows.map((row) => row.id)).toEqual(tasks.map((task) => task.id));
    gridRows.forEach((row, index) => {
      const above = gridRows[index - 1];
      if (above) expect(row.startDate >= above.startDate, `${row.id} ${row.name} (${row.startDate}) starts before ${above.id} ${above.name} (${above.startDate})`).toBe(true);
    });
  });

  it('points every link down the grid: the predecessor sits above its successor', () => {
    const rowIndex = new Map(gridRows.map((row, index) => [row.id, index]));
    for (const dep of dependencies) {
      expect((rowIndex.get(dep.fromEvent) as number) < (rowIndex.get(dep.toEvent) as number), `link ${dep.fromEvent} -> ${dep.toEvent} points up`).toBe(true);
    }
  });

  it('leaves no holes: every row starts within a few working days of the latest finish above it', () => {
    gridRows.forEach((row, index) => {
      // A row's own parents span it, so only the rows above it that are not its parents count.
      const ancestors = ancestorsOf(row);
      const latestFinish = gridRows
        .slice(0, index)
        .filter((above) => !ancestors.has(above.id))
        .map((above) => above.endDate)
        .sort()
        .at(-1);
      if (latestFinish === undefined) return; // the first rows of the first phase
      // Weekends and the holiday shutdown do not count as a gap.
      const gap = row.startDate > latestFinish ? countWorkingDays(latestFinish, row.startDate, 'standard') : 0;
      expect(gap, `${row.id} ${row.name} starts ${gap} working days after the work above it finishes`).toBeLessThanOrEqual(MAX_GAP_WORKING_DAYS);
    });
  });

  it('starts each phase after the phase before it has started', () => {
    phases.forEach((phase, index) => {
      const before = phases[index - 1];
      if (before) expect(phase.startDate > before.startDate, `${phase.name} starts with ${before.name}`).toBe(true);
    });
    expect(phases.map((phase) => phase.startDate)).toEqual(['2026-11-02', '2026-11-05', '2027-01-06', '2027-02-18', '2027-03-29', '2027-04-09']);
  });
});

describe('Riverside Clinic commercial data', () => {
  it('books the crane for 10 site working days with 4 idle days before a 6-day erection', () => {
    const { booking } = riversideClinic;
    expect(booking).toEqual({
      task_id: erection.id,
      resource_id: 4,
      supplier_name: 'Northgate Equipment Rental',
      supplier_payout_email: 'sb-northgate@personal.example.com',
      rental_rate_minor: 60000,
      currency: 'USD',
      billable_start: '2026-12-07',
      billable_end: '2026-12-18',
      idle_days: 4,
      evidence_path: 'evidence/northgate-quote.pdf',
    });
    expect(erection.id).toBe(15);
    expect(erection.name).toBe('Erect structural steel frame');
    expect(erection.duration).toBe(6);
    expect(erection.startDate).toBe('2026-12-11');
    expect(erection.endDate).toBe('2026-12-18');
    expect(isLeaf(erection)).toBe(true);
    expect(erection.note).toMatch(/Northgate Equipment Rental/);
    expect(isWorkingDay(booking.billable_start, 'standard')).toBe(true); // Monday
    expect(countWorkingDays(booking.billable_start, erection.startDate, 'standard')).toBe(booking.idle_days);
    expect(countWorkingDays(booking.billable_start, erection.startDate, 'site')).toBe(booking.idle_days);
    expect(countWorkingDays(booking.billable_start, booking.billable_end, 'site')).toBe(10);
    expect(countWorkingDays(booking.billable_start, booking.billable_end, 'site')).toBe(booking.idle_days + (erection.duration as number));
    expect(erection.endDate <= booking.billable_end).toBe(true);
    expect(booking.idle_days * booking.rental_rate_minor).toBe(240_000); // $2,400 of idle crane rental
    // The steel lay-down finishing late is what pushes erection into the booking.
    const predecessors = dependencies.filter((dep) => dep.toEvent === erection.id).map((dep) => taskById.get(dep.fromEvent) as SeedTaskRecord);
    expect(predecessors.map((task) => task.endDate).sort().at(-1)).toBe(erection.startDate);
    expect(predecessors.filter((task) => task.endDate === erection.startDate).map((task) => task.name)).toEqual(['Deliver & lay down steel']);
  });

  it('carries meaningful budget, forecast, incurred and paid figures on leaf tasks only', () => {
    const sum = (field: 'budgetMinor' | 'forecastMinor' | 'incurredMinor' | 'paidMinor') =>
      tasks.reduce((total, task) => total + (task[field] ?? 0), 0);
    for (const summary of summaries) {
      expect(summary.budgetMinor).toBeUndefined();
      expect(summary.forecastMinor).toBeUndefined();
      expect(summary.incurredMinor).toBeUndefined();
      expect(summary.paidMinor).toBeUndefined();
      expect(summary.costCode).toMatch(summary.parentId === null ? /^[A-Z]{3}$/ : /^[A-Z]{3}-\d{3}$/);
    }
    for (const leaf of leaves) {
      expect(leaf.costCode).toMatch(/^[A-Z]{3}-\d{3}$/);
      for (const field of ['budgetMinor', 'forecastMinor', 'incurredMinor', 'paidMinor'] as const) {
        expect(Number.isInteger(leaf[field])).toBe(true);
        expect(leaf[field]).toBeGreaterThanOrEqual(0);
      }
      expect(leaf.paidMinor).toBeLessThanOrEqual(leaf.incurredMinor as number);
      expect(leaf.incurredMinor).toBeLessThanOrEqual(leaf.forecastMinor as number);
      if (leaf.percentDone === 0) expect(leaf.incurredMinor).toBe(0);
      if (leaf.percentDone === 100) expect(leaf.incurredMinor).toBe(leaf.forecastMinor);
      if ((leaf.incurredMinor as number) > 0) expect(leaf.percentDone).toBeGreaterThan(0);
      if (leaf.duration === 0) expect(leaf.budgetMinor).toBe(0);
    }
    // Cost codes are unique and carry their phase's prefix.
    expect(new Set(tasks.map((task) => task.costCode)).size).toBe(tasks.length);
    for (const task of tasks) expect(task.costCode.startsWith(phaseOf(task).costCode)).toBe(true);
    expect(sum('budgetMinor')).toBe(254_065_000); // $2,540,650
    expect(sum('forecastMinor')).toBe(257_335_000); // $2,573,350
    expect(sum('incurredMinor')).toBe(19_270_000); // $192,700
    expect(sum('paidMinor')).toBe(17_195_000); // $171,950
    expect(sum('forecastMinor')).toBeGreaterThan(sum('budgetMinor'));
    expect((erection.forecastMinor as number) - (erection.budgetMinor as number)).toBe(240_000); // the idle crane days
    // Work still to finish that is heading over budget: what the "needs attention" view shows.
    const overBudgetOpen = leaves.filter((leaf) => leaf.percentDone < 100 && (leaf.forecastMinor as number) > (leaf.budgetMinor as number));
    expect(overBudgetOpen.length).toBeGreaterThanOrEqual(4);
    expect(overBudgetOpen.some((leaf) => leaf.percentDone > 0)).toBe(true);
  });
});

describe('seed snapshot SQL', () => {
  const sql = renderSeedSnapshotsSql([{ project: riversideClinic, ids: SEED_IDS, library: starterLibrarySeed() }]);

  it('escapes literals and canonicalises JSON key order', () => {
    expect(sqlLiteral("O'Brien")).toBe("'O''Brien'");
    expect(sqlLiteral(42)).toBe('42');
    expect(sqlLiteral(null)).toBe('null');
    expect(JSON.stringify(canonicalJson({ b: [{ z: 1, a: null }], a: 'x' }))).toBe('{"a":"x","b":[{"a":null,"z":1}]}');
  });

  it('renders the upserts with the snapshot as a dollar-quoted jsonb literal', () => {
    expect(sql.startsWith('-- GENERATED by scripts/gen-seed-snapshot.ts from packages/shared/src/seed')).toBe(true);
    expect(sql).toContain(
      `insert into public.projects (id, name, currency, current_revision, snapshot, snapshot_revision, handover_task_id, listed, client_name, client_email, template) values ('${SEED_IDS.project}', 'Riverside Clinic', 'USD', 0, $snapshot$`,
    );
    expect(sql).toContain(`$snapshot$::jsonb, 0, ${riversideClinic.handover_task_id}, false, null, null, null)\n`);
    expect(sql).toContain(
      'on conflict (id) do update set name = excluded.name, currency = excluded.currency, snapshot = excluded.snapshot, snapshot_revision = excluded.snapshot_revision, handover_task_id = excluded.handover_task_id, listed = excluded.listed, client_name = excluded.client_name, client_email = excluded.client_email, template = excluded.template;',
    );
    expect(sql).toContain(
      `insert into public.equipment_bookings (id, project_id, task_id, resource_id, supplier_name, supplier_payout_email, rental_rate_minor, currency, billable_start, billable_end, idle_days, evidence_path) values ('${SEED_IDS.booking}', '${SEED_IDS.project}', ${erection.id}, 4, 'Northgate Equipment Rental', 'sb-northgate@personal.example.com', 60000, 'USD', '2026-12-07', '2026-12-18', 4, 'evidence/northgate-quote.pdf')`,
    );
    expect(sql).toContain(
      'on conflict (id) do update set project_id = excluded.project_id, task_id = excluded.task_id, resource_id = excluded.resource_id, supplier_name = excluded.supplier_name, supplier_payout_email = excluded.supplier_payout_email, rental_rate_minor = excluded.rental_rate_minor, currency = excluded.currency, billable_start = excluded.billable_start, billable_end = excluded.billable_end, idle_days = excluded.idle_days, evidence_path = excluded.evidence_path;',
    );
    expect(sql).toContain(`$library$::jsonb from public.projects p join public.equipment_bookings b on b.id = '${SEED_IDS.booking}' where p.id = '${SEED_IDS.project}'`);
    expect(sql).toContain(`select public.seed_library(d.project_id, d.library) from public.demo_seeds d where d.project_id = '${SEED_IDS.project}';`);
    const [, library] = sql.match(/\$library\$([\s\S]*)\$library\$::jsonb/) as RegExpMatchArray;
    expect(JSON.parse(library as string)).toEqual(JSON.parse(JSON.stringify(starterLibrarySeed())));
    expect(sql.match(/^insert into /gm)).toHaveLength(3);
    const [, json] = sql.match(/\$snapshot\$([\s\S]*)\$snapshot\$::jsonb/) as RegExpMatchArray;
    expect(JSON.parse(json as string)).toEqual(JSON.parse(JSON.stringify(riversideClinic.inlineData)));
  });

  it('matches the generated supabase/seed_snapshot.sql on disk, every demo project in order', () => {
    const generated = readFileSync(fileURLToPath(new URL('../../../supabase/seed_snapshot.sql', import.meta.url)), 'utf8');
    expect(generated).toBe(renderSeedSnapshotsSql(SEED_PROJECTS.map(({ project, ids }) => ({ project, ids, library: project.library === 'none' ? [] : starterLibrarySeed() }))));
    // Riverside comes first, unchanged; every demo project has its rentals, Harbor's crane first and its lift after.
    expect(generated.startsWith(sql.trimEnd())).toBe(true);
    expect(generated).not.toContain(`select p.id, p.snapshot, null, null, $library$`);
    expect(generated).toContain(`join public.equipment_bookings b on b.id = '${HARBOR_IDS.booking}' where p.id = '${HARBOR_IDS.project}'`);
    expect(generated).toContain(`values ('${HARBOR_IDS.liftBooking}', '${HARBOR_IDS.project}', 116,`);
    // Each copy of Harbor takes Harbor's seed plan from its demo_seeds row and joins the pool; the JSON is written once.
    for (const { ids } of HARBOR_COPIES) {
      expect(generated).toContain(
        `values ('${ids.project}', 'Harbor Street Offices', 'USD', 0, (select d.snapshot from public.demo_seeds d where d.project_id = '${HARBOR_IDS.project}'), 0, 412, false, 'Larkspur Analytics', 'sb-larkspur@personal.example.com', 'harbor')`,
      );
      expect(generated).toContain(`join public.equipment_bookings b on b.id = '${ids.booking}' where p.id = '${ids.project}'`);
      expect(generated).toContain(`values ('${ids.liftBooking}', '${ids.project}', 116,`);
      expect(generated).toContain(`insert into public.copy_pool (project_id) values ('${ids.project}') on conflict (project_id) do nothing;`);
    }
    expect(generated.match(/\$snapshot\$::jsonb/g)).toHaveLength(3);
    expect(generated.match(/^insert into public\.copy_pool /gm)).toHaveLength(HARBOR_COPY_COUNT);
    // A copy comes after what it copies, with the same plan.
    expect(() => renderSeedSnapshotsSql([{ project: HARBOR_COPIES[0]!.project, ids: HARBOR_COPIES[0]!.ids, library: [] }])).toThrow(/rendered before it/);
    expect(() =>
      renderSeedSnapshotsSql([
        { project: harborOffices, ids: HARBOR_IDS, library: [] },
        { project: { ...HARBOR_COPIES[0]!.project, inlineData: cedarParkClinic.inlineData }, ids: HARBOR_COPIES[0]!.ids, library: [] },
      ]),
    ).toThrow(/must have the plan of the project it copies/);
  });
});

describe('the private copies of Harbor for the hosted demo', () => {
  const copies = HARBOR_COPIES;

  it('are twelve, copy 1 to copy 12, under the fixed project ids the pool hands out', () => {
    expect(copies).toHaveLength(HARBOR_COPY_COUNT);
    expect(HARBOR_COPY_COUNT).toBe(12);
    expect(copies.map(({ ids }) => ids.project)).toEqual(
      Array.from({ length: 12 }, (_, index) => `00000000-0000-4000-8000-0000000100${String(index + 1).padStart(2, '0')}`),
    );
    expect(harborCopyIds(1)).toEqual({
      project: '00000000-0000-4000-8000-000000010001',
      booking: '00000000-0000-4000-8000-000000015101',
      liftBooking: '00000000-0000-4000-8000-000000015201',
      craneQuote: '00000000-0000-4000-8000-000000016101',
    });
    expect(() => harborCopyIds(0)).toThrow();
    expect(() => harborCopyIds(100)).toThrow();
  });

  it('are Harbor exactly: its name, plan, rentals, client and empty library, playing Harbor, reached by link only', () => {
    for (const { project, ids, quotes } of copies) {
      expect(project).toEqual({ ...harborOffices, moreBookings: [{ ...harborOffices.moreBookings![0]!, id: ids.liftBooking }], unlisted: true, copyOf: HARBOR_IDS.project });
      expect(project.inlineData).toBe(harborOffices.inlineData);
      expect(project.template).toBe('harbor');
      expect(quotes).toEqual([{ ...HARBOR_QUOTES[0], documentId: ids.craneQuote }]);
    }
    expect(harborOffices.unlisted).toBeUndefined();
    expect(harborOffices.copyOf).toBeUndefined();
    expect(harborOffices.template).toBe('harbor');
  });

  it('give every row that has an id of its own a key no other seed project uses', () => {
    const keys = [
      ...SEED_PROJECTS.map(({ ids }) => ids.project),
      ...SEED_PROJECTS.flatMap(({ project, ids }) => [...(project.booking ? [ids.booking!] : []), ...(project.moreBookings ?? []).map((booking) => booking.id)]),
      SEED_IDS.quoteDocument,
      CEDAR_IDS.craneQuote,
      CEDAR_IDS.pumpQuote,
      CEDAR_IDS.liftQuote,
      HARBOR_IDS.craneQuote,
      ...copies.flatMap(({ quotes }) => quotes.map((quote) => quote.documentId)),
    ];
    expect(new Set(keys).size).toBe(keys.length);
    expect(SEED_PROJECTS.map(({ ids }) => ids.project)).toEqual([SEED_IDS.project, HARBOR_IDS.project, CEDAR_IDS.project, ...copies.map(({ ids }) => ids.project)]);
  });

  it('leave Harbor the one project the menu offers', () => {
    expect(SEED_PROJECTS.filter(({ project }) => !project.unlisted).map(({ ids }) => ids.project)).toEqual([HARBOR_IDS.project]);
    expect(cedarParkClinic).toMatchObject({ unlisted: true, template: 'cedar' });
    expect(riversideClinic.template).toBeUndefined();
  });
});

describe('crew sizes in Cedar Park', () => {
  const machines = new Set(cedarParkRecords.resources.filter((resource) => resource.kind === 'equipment').map((resource) => resource.id));
  const crews = cedarParkRecords.assignments.filter((assignment) => !machines.has(assignment.resource));

  it('gives every crew on every task a number of people, and machines none', () => {
    expect(crews.length).toBeGreaterThan(0);
    for (const assignment of crews) expect(assignment.headcount).toBeGreaterThan(0);
    for (const assignment of cedarParkRecords.assignments.filter((row) => machines.has(row.resource))) expect(assignment.headcount).toBeUndefined();
  });
});
