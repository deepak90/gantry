/**
 * Proves the Riverside Clinic seed with the real scheduling engine (headless ProjectModel under
 * jsdom): the dates (split tasks' segments included), calendars, roll-ups and the crane booking
 * arithmetic the scenario relies on.
 */
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { DateHelper, ProjectModel } from '@bryntum/gantt';
import type { AssignmentModel, CalendarModel, DependencyModel, ResourceModel, TaskModel } from '@bryntum/gantt';
import { riversideClinic, riversideClinicRecords, type SeedInlineData } from '@collab/shared/seed';

type ProjectConfig = NonNullable<ConstructorParameters<typeof ProjectModel>[0]>;

const MS_PER_DAY = 86_400_000;
const { booking } = riversideClinic;

/** Formats with local date parts: the seed's plain dates are parsed as local midnight. */
const iso = (value: unknown): string => (value instanceof Date ? DateHelper.format(value, 'YYYY-MM-DD') : String(value));
const localDate = (value: string): Date => DateHelper.parse(value, 'YYYY-MM-DD');

interface LoadedProject {
  project: ProjectModel;
  issues: string[];
}

const loaders: Record<'constructor' | 'loadInlineData', (data: SeedInlineData) => Promise<LoadedProject>> = {
  async constructor(data) {
    const issues: string[] = [];
    // The package carries app-level fields (task money, resource `kind`) that ProjectModelConfig
    // does not know, so it crosses the Bryntum boundary as an untyped data package.
    const project = new ProjectModel({ ...data, listeners: issueListeners(issues) } as object as ProjectConfig);
    await project.commitAsync();
    return { project, issues };
  },
  async loadInlineData(data) {
    const issues: string[] = [];
    const project = new ProjectModel({ listeners: issueListeners(issues) });
    await project.loadInlineData(data);
    await project.commitAsync();
    return { project, issues };
  },
};

/** Bryntum types the issue's `getDescription` as the broad `Function`. */
interface SchedulingIssueEvent {
  schedulingIssue: { getDescription: Function };
}

function issueListeners(issues: string[]) {
  const record = (kind: string) => (event: SchedulingIssueEvent): void => {
    issues.push(`${kind}: ${String(event.schedulingIssue.getDescription())}`);
  };
  return {
    schedulingConflict: record('schedulingConflict'),
    cycle: record('cycle'),
    emptyCalendar: record('emptyCalendar'),
    calendarMisconfigured: record('calendarMisconfigured'),
  };
}

const tasksOf = (project: ProjectModel) => project.taskStore.allRecords as TaskModel[];
const taskById = (project: ProjectModel, id: number) => project.taskStore.getById(id) as TaskModel;
const calendarById = (project: ProjectModel, id: string) => project.calendarManagerStore.getById(id) as CalendarModel;
const workingDays = (calendar: CalendarModel, start: string, end: string) =>
  calendar.calculateDurationMs(localDate(start), localDate(end)) / MS_PER_DAY;

describe.each(Object.entries(loaders))('Riverside Clinic seed loaded via %s', (_name, load) => {
  let loaded: LoadedProject;

  afterEach(() => {
    loaded?.project.destroy();
  });

  it('loads cleanly: project fields applied, no scheduling issues, no pending changes', async () => {
    loaded = await load(structuredClone(riversideClinic.inlineData));
    const { project, issues } = loaded;
    expect(issues).toEqual([]);
    expect(iso(project.startDate)).toBe('2026-11-02');
    expect((project.calendar as CalendarModel).id).toBe('standard');
    expect(project.hoursPerDay).toBe(24);
    expect(project.daysPerWeek).toBe(5);
    expect(project.changes).toBeNull();
    expect(calendarById(project, 'standard').name).toBe('Standard (Mon-Fri)');
    expect(calendarById(project, 'site').name).toBe('Site (Mon-Sat)');
  });

  it('has every task, and its parents, dependencies and assignments all resolve', async () => {
    loaded = await load(structuredClone(riversideClinic.inlineData));
    const { project } = loaded;
    const tasks = tasksOf(project);
    expect(tasks.length).toBeGreaterThanOrEqual(80);
    expect(tasks.length).toBe(riversideClinicRecords.tasks.length);
    for (const task of tasks) {
      const parent = task.parent as TaskModel | null;
      if (parent && !parent.isRoot) expect(taskById(project, parent.id as number)).toBe(parent);
      expect(task.startDate).toBeInstanceOf(Date);
      expect(task.endDate).toBeInstanceOf(Date);
    }
    const dependencies = project.dependencyStore.allRecords as DependencyModel[];
    expect(dependencies).toHaveLength(riversideClinicRecords.dependencies.length);
    for (const dependency of dependencies) {
      expect(taskById(project, (dependency.fromTask as TaskModel).id as number)).toBe(dependency.fromTask);
      expect(taskById(project, (dependency.toTask as TaskModel).id as number)).toBe(dependency.toTask);
    }
    const linkTypes = (records: { type: number; lag: number }[]) => records.map((record) => `${record.type}/${record.lag}`).sort();
    expect(linkTypes(dependencies)).toEqual(linkTypes(riversideClinicRecords.dependencies));
    expect(dependencies.filter((dependency) => dependency.type === 0).length).toBeGreaterThanOrEqual(2);
    expect(dependencies.filter((dependency) => dependency.type === 3).length).toBeGreaterThanOrEqual(1);
    const assignments = project.assignmentStore.allRecords as AssignmentModel[];
    expect(assignments).toHaveLength(riversideClinicRecords.assignments.length);
    for (const assignment of assignments) {
      expect(taskById(project, (assignment.event as TaskModel).id as number)).toBe(assignment.event);
      expect(project.resourceStore.getById((assignment.resource as ResourceModel).id)).toBe(assignment.resource);
    }
    const crane = project.resourceStore.getById(booking.resource_id) as ResourceModel;
    expect(crane.get('kind')).toBe('equipment');
    expect(crane.get('company')).toBe(booking.supplier_name);
    // Color, icon and logo land on Bryntum's own ResourceModel fields, which avatars and the histogram read.
    for (const seed of riversideClinicRecords.resources) {
      const resource = project.resourceStore.getById(seed.id) as ResourceModel;
      expect([seed.id, resource.name, resource.eventColor, resource.iconCls, resource.imageUrl]).toEqual([seed.id, seed.name, seed.eventColor, seed.iconCls, seed.imageUrl]);
      expect(resource.get('kind')).toBe(seed.kind);
    }
  });

  it('schedules every task exactly as the seed says (dates, baselines, progress)', async () => {
    loaded = await load(structuredClone(riversideClinic.inlineData));
    const { project } = loaded;
    for (const seed of riversideClinicRecords.tasks) {
      const task = taskById(project, seed.id);
      expect(task, `task ${seed.id}`).toBeDefined();
      expect([seed.id, iso(task.startDate), iso(task.endDate)]).toEqual([seed.id, seed.startDate, seed.endDate]);
      if (seed.duration !== undefined) expect([seed.id, task.duration]).toEqual([seed.id, seed.duration]);
      expect(task.percentDone, `percentDone of task ${seed.id}`).toBeCloseTo(seed.percentDone, 6);
      const baselines = (task.baselines as unknown as { allRecords: { startDate: Date; endDate: Date }[] }).allRecords;
      expect(baselines.map((baseline) => [iso(baseline.startDate), iso(baseline.endDate)])).toEqual([[seed.startDate, seed.endDate]]);
      expect(task.get('costCode')).toBe(seed.costCode);
      if (seed.budgetMinor !== undefined) expect(task.get('budgetMinor')).toBe(seed.budgetMinor);
    }
    const phases = tasksOf(project).filter((task) => (task.parent as TaskModel).isRoot);
    expect(phases).toHaveLength(6);
    expect(phases[0]?.percentDone).toBe(100);
    expect(phases[1]?.percentDone).toBeGreaterThan(0);
    expect(phases[1]?.percentDone).toBeLessThan(100);
  });

  it('honors the site calendar for crane erection and both calendars around the shutdown', async () => {
    loaded = await load(structuredClone(riversideClinic.inlineData));
    const { project } = loaded;
    const erection = taskById(project, booking.task_id);
    expect(erection.name).toBe('Erect structural steel frame');
    expect((erection.effectiveCalendar as CalendarModel).id).toBe('site');
    expect(iso(erection.startDate)).toBe('2026-12-11'); // Friday
    expect(iso(erection.endDate)).toBe('2026-12-18'); // Fri 00:00 after working Sat, Dec 12
    expect(erection.duration).toBe(6);
    expect(erection.durationUnit).toBe('day');
    const boltUp = taskById(project, 242);
    expect(iso(boltUp.startDate)).toBe('2026-12-18'); // Friday: the standard calendar takes over after erection
    expect(iso(boltUp.endDate)).toBe('2026-12-22'); // Fri 18, then Mon, Dec 21
    const subBase = taskById(project, 251);
    expect(iso(subBase.startDate)).toBe('2026-12-23'); // Wednesday, the last working day before the shutdown
    expect(iso(subBase.endDate)).toBe('2026-12-24');
    const slab = taskById(project, 252);
    expect(iso(slab.startDate)).toBe('2027-01-04'); // Monday after the shutdown
    expect(iso(slab.endDate)).toBe('2027-01-06');
    expect(slab.duration).toBe(2);
    const slabPackage = slab.parent as TaskModel;
    expect([iso(slabPackage.startDate), iso(slabPackage.endDate)]).toEqual(['2026-12-23', '2027-01-06']);
    const site = calendarById(project, 'site');
    expect(site.isWorkingTime(localDate('2026-12-12'), localDate('2026-12-13'))).toBe(true); // Saturday
    expect(calendarById(project, 'standard').isWorkingTime(localDate('2026-12-12'), localDate('2026-12-13'))).toBe(false);
  });

  it('is engine-true for the crane booking: 4 idle working days before erection, 10 booked', async () => {
    loaded = await load(structuredClone(riversideClinic.inlineData));
    const { project } = loaded;
    const erection = taskById(project, booking.task_id);
    const standard = calendarById(project, 'standard');
    const site = calendarById(project, 'site');
    // Rental is billed on the crane's own ('site') calendar, the calendar idle_days is counted on.
    const idle = workingDays(site, booking.billable_start, iso(erection.startDate));
    expect(idle).toBe(booking.idle_days);
    expect(idle).toBe(4);
    expect(workingDays(standard, booking.billable_start, iso(erection.startDate))).toBe(4); // Mon-Thu: no Saturday in the window
    expect(workingDays(site, booking.billable_start, booking.billable_end)).toBe(10);
    expect(workingDays(site, iso(erection.startDate), iso(erection.endDate))).toBe(6);
    expect(iso(erection.endDate) <= booking.billable_end).toBe(true);
    expect(booking.idle_days * booking.rental_rate_minor).toBe(240_000);
    // The steel lay-down is the last predecessor to finish, and it finishes as erection starts.
    const predecessors = (erection.predecessors as DependencyModel[]).map((dependency) => dependency.fromTask as TaskModel);
    const driving = predecessors.filter((task) => iso(task.endDate) === iso(erection.startDate));
    expect(driving.map((task) => task.name)).toEqual(['Deliver & lay down steel']);
    expect(predecessors.every((task) => iso(task.endDate) <= iso(erection.startDate))).toBe(true);
    // The crane works the erection only.
    const crane = project.resourceStore.getById(booking.resource_id) as ResourceModel;
    expect((crane.assignments as AssignmentModel[]).map((assignment) => (assignment.event as TaskModel).id)).toEqual([booking.task_id]);
  });

  it('reads as a waterfall: rows in time order, links pointing down the grid, no holes', async () => {
    loaded = await load(structuredClone(riversideClinic.inlineData));
    const { project } = loaded;
    // The grid with every row expanded: depth-first through the engine's task tree, siblings in order.
    const rows: TaskModel[] = [];
    const walk = (parent: TaskModel): void => {
      for (const child of Array.isArray(parent.children) ? (parent.children as TaskModel[]) : []) {
        rows.push(child);
        walk(child);
      }
    };
    walk(project.taskStore.rootNode as unknown as TaskModel);
    expect(rows.map((task) => task.id)).toEqual(riversideClinicRecords.tasks.map((task) => task.id));
    const time = (task: TaskModel, field: 'startDate' | 'endDate') => (task[field] as Date).getTime();

    rows.forEach((task, index) => {
      const above = rows[index - 1];
      if (above) expect(time(task, 'startDate') >= time(above, 'startDate'), `${task.id} starts before ${above.id}`).toBe(true);
    });

    const rowIndex = new Map(rows.map((task, index) => [task, index]));
    for (const dependency of project.dependencyStore.allRecords as DependencyModel[]) {
      const [from, to] = [rowIndex.get(dependency.fromTask as TaskModel), rowIndex.get(dependency.toTask as TaskModel)];
      expect((from as number) < (to as number), `link ${(dependency.fromTask as TaskModel).id} -> ${(dependency.toTask as TaskModel).id} points up`).toBe(true);
    }

    // No row starts more than three working days (weekends and the shutdown excluded) after the latest
    // finish among the rows above it; a row's own parents span it, so they do not count.
    const standard = calendarById(project, 'standard');
    rows.forEach((task, index) => {
      const ancestors = new Set<TaskModel>();
      for (let parent = task.parent as TaskModel; !parent.isRoot; parent = parent.parent as TaskModel) ancestors.add(parent);
      const finishes = rows.slice(0, index).filter((above) => !ancestors.has(above)).map((above) => time(above, 'endDate'));
      if (finishes.length === 0) return; // the first rows of the first phase
      const latestFinish = Math.max(...finishes);
      const gap = time(task, 'startDate') > latestFinish ? standard.calculateDurationMs(new Date(latestFinish), task.startDate as Date) / MS_PER_DAY : 0;
      expect(gap, `${task.id} ${task.name} starts ${gap} working days after the work above it`).toBeLessThanOrEqual(3);
    });

    const phases = rows.filter((task) => (task.parent as TaskModel).isRoot);
    expect(phases).toHaveLength(6);
    phases.forEach((phase, index) => {
      const before = phases[index - 1];
      if (before) expect(time(phase, 'startDate') > time(before, 'startDate'), `${phase.name} starts with ${before.name}`).toBe(true);
    });
  });

  it('places the pieces of split tasks where the seed says, counting only their work as duration', async () => {
    loaded = await load(structuredClone(riversideClinic.inlineData));
    const { project } = loaded;
    const split = riversideClinicRecords.tasks.filter((seed) => seed.segments);
    expect(split.length).toBeGreaterThanOrEqual(2);
    for (const seed of split) {
      const task = taskById(project, seed.id);
      const segments = (task.segments ?? []) as unknown as { name: string; startDate: Date; endDate: Date; duration: number }[];
      expect(segments.map((segment) => [segment.name, iso(segment.startDate), iso(segment.endDate), segment.duration])).toEqual(
        (seed.segments ?? []).map((segment) => [segment.name, segment.startDate, segment.endDate, segment.duration]),
      );
      expect(task.duration).toBe(segments.reduce((total, segment) => total + segment.duration, 0));
      expect(iso(task.endDate)).toBe(iso(segments.at(-1)?.endDate));
      // The pauses are not work: the task spans more working days than its duration.
      expect(workingDays(task.effectiveCalendar as CalendarModel, seed.startDate, seed.endDate)).toBeGreaterThan(task.duration);
    }
  });

  it('ends with the Handover milestone on Wednesday, April 28, 2027', async () => {
    loaded = await load(structuredClone(riversideClinic.inlineData));
    const { project } = loaded;
    const handover = taskById(project, riversideClinic.handover_task_id);
    expect(handover.name).toBe('Handover');
    expect(handover.isMilestone).toBe(true);
    expect(handover.duration).toBe(0);
    expect(iso(handover.startDate)).toBe('2027-04-28');
    expect(iso(handover.endDate)).toBe('2027-04-28');
    expect(iso(project.endDate)).toBe('2027-04-28');
    expect(tasksOf(project).every((task) => (task.endDate as Date) <= (handover.endDate as Date))).toBe(true);
  });
});

describe('crew logos', () => {
  it('ships a small PNG in apps/web/public for every seed crew', () => {
    for (const { name, imageUrl } of riversideClinicRecords.resources) {
      expect(imageUrl, name).toBeDefined();
      const file = join(dirname(fileURLToPath(import.meta.url)), '../../public', imageUrl ?? '');
      expect(readFileSync(file).subarray(1, 4).toString('latin1'), `${imageUrl} is a PNG`).toBe('PNG');
      expect(statSync(file).size, `${imageUrl} stays small`).toBeLessThan(40 * 1024);
    }
  });
});
