/**
 * The seed builder shared by every demo project: the types, the calendars and working-day arithmetic,
 * the authoring specs and the functions that turn a spec (phases, links, crews, money) into Bryntum
 * inline data. Dates, segments, baselines, cost codes and summary roll-ups are derived so they cannot
 * drift apart.
 *
 * Pure data and arithmetic, loaded by Node's type stripping (scripts/gen-seed-snapshot.ts) as well as
 * by Vite and Vitest: it imports types only.
 */
import type { ProjectInlineData } from '../revisions';


/** Plain calendar date, 'YYYY-MM-DD', no time, no timezone. */
export type IsoDate = string;

export type SeedCalendarId = 'standard' | 'site' | 'inspector';

/**
 * Value of the resource `kind` field (the web app's ResourceModel subclass declares it). Bryntum's
 * own ResourceModel already owns a `type` field ('work' | 'material' | 'cost'), so the split lives
 * under a different name.
 */
export type SeedResourceType = 'labor' | 'equipment';

export interface SeedMember {
  email: string;
  password: string;
  display_name: string;
  color: string;
  role: 'pm' | 'cm';
  can_view_costs: boolean;
  approval_limit_minor: number;
}

export interface SeedEquipmentBooking {
  /** Bryntum task id of the activity the equipment serves (the crane erection task). */
  task_id: number;
  /** Bryntum resource id of the equipment resource. */
  resource_id: number;
  supplier_name: string;
  supplier_payout_email: string;
  rental_rate_minor: number;
  currency: 'USD';
  /** First day on rent. A rental is paid for every calendar day (rental-days.ts). */
  billable_start: IsoDate;
  /** Exclusive end of the billable period. */
  billable_end: IsoDate;
  /** Days on rent with no work planned, as booked: before the booked task and after it. */
  idle_days: number;
  evidence_path: string | null;
}

export interface SeedCalendarInterval {
  name: string;
  isWorking: false;
  recurrentStartDate?: string;
  recurrentEndDate?: string;
  startDate?: IsoDate;
  endDate?: IsoDate;
  cls?: string;
}

export interface SeedCalendarRow {
  id: SeedCalendarId;
  name: string;
  unspecifiedTimeIsWorking: true;
  intervals: SeedCalendarInterval[];
}

export interface SeedBaseline {
  startDate: IsoDate;
  endDate: IsoDate;
}

/** One piece of a split task (Bryntum `segments`). The gaps between pieces are not working time of the task. */
export interface SeedSegment {
  name: string;
  startDate: IsoDate;
  /** Exclusive, like task end dates. */
  endDate: IsoDate;
  /** Working days in the task's calendar. */
  duration: number;
}

/** Task fields shared by the nested (`SeedTaskRow`) and flat (`SeedTaskRecord`) views. */
export interface SeedTaskFields {
  id: number;
  name: string;
  startDate: IsoDate;
  /** Exclusive: the 00:00 after the last working day. */
  endDate: IsoDate;
  /** Working days in the task's calendar (a split task: the sum of its segments). Absent on summary tasks, where the engine derives it. */
  duration?: number;
  durationUnit?: 'day';
  percentDone: number;
  /** Absent means the project calendar ('standard'). */
  calendar?: SeedCalendarId;
  /** Summary rows only: false folds the row (the finished site-setup phase), true shows its children. */
  expanded?: boolean;
  note?: string;
  /** Split tasks only: the pieces of work, in order. The task ends when the last piece ends. */
  segments?: SeedSegment[];
  /** One baseline equal to the scheduled dates, so the UI can show baseline vs current. */
  baselines: SeedBaseline[];
  costCode: string;
  budgetMinor?: number;
  forecastMinor?: number;
  incurredMinor?: number;
  paidMinor?: number;
  /** On a payment milestone: the progress payment the work after it waits for (PayGate, progress-payments.ts). */
  payGate?: Record<string, unknown>;
  /** The date the work must be done by (Bryntum `deadlineDate`): shown on the chart, it moves nothing. */
  deadlineDate?: IsoDate;
}

/** Nested task as Bryntum loads it: summary tasks carry their `children`. */
export interface SeedTaskRow extends SeedTaskFields {
  children?: SeedTaskRow[];
}

/** Flat task view with the parent reference, in WBS order (each parent before its children). */
export interface SeedTaskRecord extends SeedTaskFields {
  parentId: number | null;
}

/** Bryntum DependencyModel.Type: 0 = Start-to-Start, 2 = Finish-to-Start, 3 = Finish-to-Finish. */
export type SeedDependencyType = 0 | 2 | 3;

export interface SeedDependencyRow {
  id: number;
  fromEvent: number;
  toEvent: number;
  type: SeedDependencyType;
  /** Lag in working days of the successor's calendar (the project's `dependenciesCalendar`). */
  lag: number;
  lagUnit: 'day';
}

export interface SeedResourceRow {
  id: number;
  /** The crew by its firm's name, or the piece of equipment. */
  name: string;
  /** What the crew does, or what kind of equipment it is: shown as a label (a site has several crews of a trade). */
  trade: string;
  kind: SeedResourceType;
  /** The firm that supplies the crew or rents out the equipment. */
  company: string;
  /** Bryntum ResourceModel field: the crew color on avatars, bars and the histogram ('#rrggbb'). */
  eventColor: string;
  /** Bryntum ResourceModel field: FontAwesome 6 solid icon classes, e.g. 'fa fa-bolt'. */
  iconCls: string;
  /**
   * Bryntum ResourceModel field: the company logo, served by the web app from apps/web/public
   * ('/crews/<slug>.png'). Badges fall back to the icon without it.
   */
  imageUrl?: string;
  /** Absent means the project calendar ('standard'). */
  calendar?: SeedCalendarId;
}

export interface SeedAssignmentRow {
  id: number;
  event: number;
  resource: number;
  units: number;
  /** A rental's dates on the machine on its task: `YYYY-MM-DD`, the end exclusive. */
  rentalStart?: IsoDate;
  rentalEnd?: IsoDate;
  /** How many people a crew has on this task. */
  headcount?: number;
}

/** Project-level fields. */
export type SeedProjectFields = {
  startDate: IsoDate;
  calendar: SeedCalendarId;
  hoursPerDay: number;
  daysPerWeek: number;
  daysPerMonth: number;
};

/**
 * The Bryntum data package. `new ProjectModel({ ...inlineData })` reads the project-level fields
 * from the top level and ignores `project`; `project.loadInlineData(inlineData)` reads them from
 * `project`. Both forms are supported by carrying the fields in both places.
 */
export interface SeedInlineData extends ProjectInlineData, SeedProjectFields {
  project: SeedProjectFields;
  calendarsData: SeedCalendarRow[];
  tasksData: SeedTaskRow[];
  dependenciesData: SeedDependencyRow[];
  resourcesData: SeedResourceRow[];
  assignmentsData: SeedAssignmentRow[];
}

/** Typed flat view of every Bryntum record in the seed. */
export interface SeedRecords {
  calendars: SeedCalendarRow[];
  tasks: SeedTaskRecord[];
  dependencies: SeedDependencyRow[];
  resources: SeedResourceRow[];
  assignments: SeedAssignmentRow[];
}

/** Puts each rental's dates on its machine on its task: the plan keeps them there. */
export function withRentalDates(inlineData: SeedInlineData, bookings: readonly SeedEquipmentBooking[]): SeedInlineData {
  return {
    ...inlineData,
    assignmentsData: inlineData.assignmentsData.map((assignment) => {
      const booking = bookings.find((candidate) => candidate.resource_id === assignment.resource && candidate.task_id === assignment.event);
      return booking ? { ...assignment, rentalStart: booking.billable_start, rentalEnd: booking.billable_end } : assignment;
    }),
  };
}

export interface SeedProject {
  name: string;
  currency: 'USD';
  /** Bryntum task id of the Handover milestone. */
  handover_task_id: number;
  members: SeedMember[];
  inlineData: SeedInlineData;
  /** The project's first equipment rental, if any (its id is in the project's seed ids). */
  booking: SeedEquipmentBooking | null;
  /** Its other rentals, each with its own id. */
  moreBookings?: (SeedEquipmentBooking & { id: string })[];
  /** Who the project bills for finished work (invoices), if anyone. */
  client?: { name: string; email: string };
  /** Not offered in the project menu or opened by default; a link still opens it. */
  unlisted?: boolean;
  /** `none`: the project's library starts empty. Default: the starter library. */
  library?: 'starter' | 'none';
  /**
   * The demo the project plays (`projects.template`): the app opens it on the plan alone, with the steps, whether
   * or not the menu offers it. Absent on a plain project, such as the automated tests' fixture.
   */
  template?: SeedTemplate;
  /**
   * A private copy of another seed project (its project id) for the hosted demo: it starts from that project's seed
   * plan, with rentals and documents of its own, and waits in the pool of copies (`copy_pool`) for a visitor.
   */
  copyOf?: string;
}

/** The demos a seed project can play: Harbor Street Offices (and its copies) and Cedar Park Clinic. */
export type SeedTemplate = 'harbor' | 'cedar';

/** One role for the demo: both see costs and approve fixes (supabase/seed.sql gives the same rights). */
export const SEED_MEMBERS: SeedMember[] = [
  {
    email: 'pm@demo.local',
    password: 'demo-pm-2026',
    display_name: 'Chris Hale',
    color: '#2563eb',
    role: 'cm',
    can_view_costs: true,
    approval_limit_minor: 25000000,
  },
  {
    email: 'cm@demo.local',
    password: 'demo-cm-2026',
    display_name: 'Deepak Jayaram',
    color: '#d97706',
    role: 'cm',
    can_view_costs: true,
    approval_limit_minor: 25000000,
  },
];

/** Site-wide holiday shutdown, non-working in both calendars (exclusive end). */
export const SEED_SHUTDOWN = { startDate: '2026-12-24', endDate: '2027-01-04' } as const;

/** When the city's inspector is away (exclusive end): Thanksgiving week. Her own calendar; the crews work. */
export const SEED_INSPECTOR_AWAY = { startDate: '2026-11-23', endDate: '2026-11-28' } as const;

/**
 * The public holidays building crews take off in 2027 (the holiday shutdown covers New Year's Day),
 * non-working in both calendars. A day lost before one of them can cost a long weekend at the end.
 */
export const SEED_HOLIDAYS: readonly { name: string; date: IsoDate }[] = [
  { name: 'Memorial Day', date: '2027-05-31' },
  { name: 'Independence Day (observed)', date: '2027-07-05' },
  { name: 'Labor Day', date: '2027-09-06' },
  { name: 'Thanksgiving', date: '2027-11-25' },
  { name: 'Day after Thanksgiving', date: '2027-11-26' },
];
const HOLIDAY_DATES: ReadonlySet<string> = new Set(SEED_HOLIDAYS.map((holiday) => holiday.date));

// ---------------------------------------------------------------------------------------------
// Working-day arithmetic. Mirrors the two calendars below (24-hour days, weekends and the
// shutdown non-working); the engine test checks that the engine agrees with every date derived here.
// ---------------------------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;

function dayNumber(iso: IsoDate): number {
  const [year, month, day] = iso.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined || Number.isNaN(year + month + day)) {
    throw new Error(`Not a YYYY-MM-DD date: ${iso}`);
  }
  return Date.UTC(year, month - 1, day) / MS_PER_DAY;
}

function isoFromDayNumber(days: number): IsoDate {
  return new Date(days * MS_PER_DAY).toISOString().slice(0, 10);
}

export function addDays(iso: IsoDate, days: number): IsoDate {
  return isoFromDayNumber(dayNumber(iso) + days);
}

/** Whether `iso` is a working day in the given seed calendar. */
export function isWorkingDay(iso: IsoDate, calendar: SeedCalendarId): boolean {
  if (iso >= SEED_SHUTDOWN.startDate && iso < SEED_SHUTDOWN.endDate) return false;
  if (HOLIDAY_DATES.has(iso)) return false;
  if (calendar === 'inspector' && iso >= SEED_INSPECTOR_AWAY.startDate && iso < SEED_INSPECTOR_AWAY.endDate) return false;
  const weekday = new Date(dayNumber(iso) * MS_PER_DAY).getUTCDay(); // 0 = Sunday, 6 = Saturday
  return calendar === 'site' ? weekday !== 0 : weekday !== 0 && weekday !== 6;
}

/** First working day on or after `iso`. */
export function nextWorkingDay(iso: IsoDate, calendar: SeedCalendarId): IsoDate {
  let day = iso;
  while (!isWorkingDay(day, calendar)) day = addDays(day, 1);
  return day;
}

/** The day after `count` working days have been accumulated from `iso` (an exclusive end). */
export function addWorkingDays(iso: IsoDate, count: number, calendar: SeedCalendarId): IsoDate {
  let day = iso;
  let remaining = count;
  while (remaining > 0) {
    if (isWorkingDay(day, calendar)) remaining -= 1;
    day = addDays(day, 1);
  }
  return day;
}

/** The start of the last `count` working days before the exclusive end `endExclusive`. */
export function subtractWorkingDays(endExclusive: IsoDate, count: number, calendar: SeedCalendarId): IsoDate {
  let day = endExclusive;
  let remaining = count;
  while (remaining > 0) {
    day = addDays(day, -1);
    if (isWorkingDay(day, calendar)) remaining -= 1;
  }
  return day;
}

/** Working days in [start, endExclusive). */
export function countWorkingDays(start: IsoDate, endExclusive: IsoDate, calendar: SeedCalendarId): number {
  let count = 0;
  for (let day = start; day < endExclusive; day = addDays(day, 1)) {
    if (isWorkingDay(day, calendar)) count += 1;
  }
  return count;
}

// ---------------------------------------------------------------------------------------------
// Authoring specs
// ---------------------------------------------------------------------------------------------

/** One piece of a split task: working days of work, and the working days of pause before it. */
export interface SegmentSpec {
  name: string;
  duration: number;
  /** Working days between the previous piece and this one (absent on the first piece). */
  gapBefore?: number;
}

export interface LeafSpec {
  id: number;
  /** Number for the cost code when `id` is one of the fixed legacy ids. */
  wbs?: number;
  name: string;
  /** Working days in the task calendar (0 = milestone; a split task: the sum of its segments). */
  duration: number;
  /** Whole US dollars; converted to minor units when the rows are built. */
  budget: number;
  forecast?: number;
  incurred?: number;
  paid?: number;
  percentDone?: number;
  calendar?: SeedCalendarId;
  note?: string;
  /** A split task: the pieces of work, separated by pauses. */
  segments?: SegmentSpec[];
  /** Resource ids assigned at 100% units. */
  assign?: number[];
  /** A payment milestone: what the work after it waits for. */
  payGate?: Record<string, unknown>;
  /** The date it must be done by: a contract date (Bryntum `deadlineDate`), which schedules nothing. */
  deadline?: IsoDate;
  /** How many people each crew on it has there (machines have no headcount). */
  people?: number;
}

export interface SummarySpec {
  id: number;
  name: string;
  /** Phases only: the three-letter cost-code prefix of everything below. */
  code?: string;
  /** Starts folded: the finished site-setup phase, which keeps the steel near the top of the grid. */
  collapsed?: true;
  /** What the place is (a floor's size and use), for people and the assistant. */
  note?: string;
  children: NodeSpec[];
}

export type NodeSpec = SummarySpec | LeafSpec;

export const isSummary = (spec: NodeSpec): spec is SummarySpec => 'children' in spec;

/** Finish-to-Start unless `kind` says otherwise. */
export interface DependencySpec {
  from: number;
  to: number;
  kind?: 'SS' | 'FF';
  lag?: number;
}

function shutdownInterval(): SeedCalendarInterval {
  return { name: 'Holiday shutdown', startDate: SEED_SHUTDOWN.startDate, endDate: SEED_SHUTDOWN.endDate, isWorking: false };
}

function holidayIntervals(): SeedCalendarInterval[] {
  return SEED_HOLIDAYS.map((holiday) => ({ name: holiday.name, startDate: holiday.date, endDate: addDays(holiday.date, 1), isWorking: false }));
}

/** The calendars every seed project has: the crews' two, and the city inspector's, which only an inspection task uses. */
export const SEED_CALENDARS: SeedCalendarRow[] = [
  {
    id: 'standard',
    name: 'Standard (Mon-Fri)',
    unspecifiedTimeIsWorking: true,
    intervals: [
      { name: 'Weekend', recurrentStartDate: 'on Sat', recurrentEndDate: 'on Mon', isWorking: false },
      shutdownInterval(),
      ...holidayIntervals(),
    ],
  },
  {
    id: 'site',
    name: 'Site (Mon-Sat)',
    unspecifiedTimeIsWorking: true,
    intervals: [
      { name: 'Sunday', recurrentStartDate: 'on Sun', recurrentEndDate: 'on Mon', isWorking: false },
      shutdownInterval(),
      ...holidayIntervals(),
    ],
  },
  {
    id: 'inspector',
    name: 'City inspector',
    unspecifiedTimeIsWorking: true,
    intervals: [
      { name: 'Weekend', recurrentStartDate: 'on Sat', recurrentEndDate: 'on Mon', isWorking: false },
      shutdownInterval(),
      ...holidayIntervals(),
      // `cls`: drawn on the chart as a band (apps/web/src/library/bands.ts).
      { name: 'City inspector away', startDate: SEED_INSPECTOR_AWAY.startDate, endDate: SEED_INSPECTOR_AWAY.endDate, isWorking: false, cls: 'look-calendar-band' },
    ],
  },
];

// ---------------------------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------------------------

const usd = (dollars: number): number => Math.round(dollars * 100);

export function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`Seed is inconsistent: ${what}`);
  return value;
}

const DEPENDENCY_TYPE: Record<'FS' | 'SS' | 'FF', SeedDependencyType> = { SS: 0, FS: 2, FF: 3 };

interface Scheduled {
  startDate: IsoDate;
  endDate: IsoDate;
  segments?: SeedSegment[];
}

interface LeafInPhase {
  leaf: LeafSpec;
  phaseCode: string;
}

/** Every leaf in WBS order, with the cost-code prefix of its phase. */
function leavesOf(spec: NodeSpec, phaseCode: string): LeafInPhase[] {
  return isSummary(spec) ? spec.children.flatMap((child) => leavesOf(child, phaseCode)) : [{ leaf: spec, phaseCode }];
}

/** Places a task's pieces of work from its start: each piece waits out its pause in working days. */
function placeSegments(leaf: LeafSpec, startDate: IsoDate, calendar: SeedCalendarId): SeedSegment[] {
  const specs = must(leaf.segments, `segments of task ${leaf.id}`);
  if (specs.reduce((total, segment) => total + segment.duration, 0) !== leaf.duration) {
    throw new Error(`Seed is inconsistent: segments of task ${leaf.id} do not add up to its duration`);
  }
  const placed: SeedSegment[] = [];
  for (const segment of specs) {
    const previous = placed.at(-1);
    const segmentStart = previous ? nextWorkingDay(addWorkingDays(previous.endDate, segment.gapBefore ?? 0, calendar), calendar) : startDate;
    placed.push({ name: segment.name, startDate: segmentStart, endDate: addWorkingDays(segmentStart, segment.duration, calendar), duration: segment.duration });
  }
  return placed;
}

/**
 * Forward pass: each leaf starts at the first working day all of its predecessors allow (a
 * milestone sits exactly where they allow). Finish-to-Start waits for the predecessor's end,
 * Start-to-Start for its start plus the lag, Finish-to-Finish lets the leaf end no earlier than the
 * predecessor's end plus the lag.
 */
function scheduleLeaves(leaves: LeafSpec[], deps: readonly DependencySpec[], projectStart: IsoDate): Map<number, Scheduled> {
  const byId = new Map(leaves.map((leaf) => [leaf.id, leaf]));
  for (const dep of deps) {
    must(byId.get(dep.from), `dependency from unknown task ${dep.from}`);
    const successor = must(byId.get(dep.to), `dependency to unknown task ${dep.to}`);
    if (dep.kind === 'FF' && successor.segments) throw new Error(`Seed is inconsistent: Finish-to-Finish into split task ${dep.to}`);
  }
  const scheduled = new Map<number, Scheduled>();
  const pending = new Set(byId.keys());
  while (pending.size > 0) {
    let progressed = false;
    for (const id of pending) {
      const incoming = deps.filter((dep) => dep.to === id);
      if (incoming.some((dep) => !scheduled.has(dep.from))) continue;
      const leaf = must(byId.get(id), `task ${id}`);
      const calendar = leaf.calendar ?? 'standard';
      let earliest = projectStart;
      for (const dep of incoming) {
        const predecessor = must(scheduled.get(dep.from), `schedule of task ${dep.from}`);
        const lag = dep.lag ?? 0;
        const candidate =
          dep.kind === 'SS' ? addWorkingDays(predecessor.startDate, lag, calendar)
          : dep.kind === 'FF' ? subtractWorkingDays(addWorkingDays(predecessor.endDate, lag, calendar), leaf.duration, calendar)
          : addWorkingDays(predecessor.endDate, lag, calendar);
        if (candidate > earliest) earliest = candidate;
      }
      const startDate = leaf.duration === 0 ? earliest : nextWorkingDay(earliest, calendar);
      if (leaf.segments) {
        const segments = placeSegments(leaf, startDate, calendar);
        scheduled.set(id, { startDate, endDate: must(segments.at(-1), `last segment of task ${id}`).endDate, segments });
      } else {
        scheduled.set(id, { startDate, endDate: addWorkingDays(startDate, leaf.duration, calendar) });
      }
      pending.delete(id);
      progressed = true;
    }
    if (!progressed) throw new Error(`Seed is inconsistent: dependency cycle among tasks ${[...pending].join(', ')}`);
  }
  return scheduled;
}

function leafRow(leaf: LeafSpec, phaseCode: string, dates: Scheduled): SeedTaskRow {
  const row: SeedTaskRow = {
    id: leaf.id,
    name: leaf.name,
    startDate: dates.startDate,
    endDate: dates.endDate,
    duration: leaf.duration,
    durationUnit: 'day',
    percentDone: leaf.percentDone ?? 0,
    baselines: [{ startDate: dates.startDate, endDate: dates.endDate }],
    costCode: `${phaseCode}-${leaf.wbs ?? leaf.id}`,
    budgetMinor: usd(leaf.budget),
    forecastMinor: usd(leaf.forecast ?? leaf.budget),
    incurredMinor: usd(leaf.incurred ?? 0),
    paidMinor: usd(leaf.paid ?? 0),
  };
  if (leaf.calendar) row.calendar = leaf.calendar;
  if (leaf.note) row.note = leaf.note;
  if (leaf.payGate) row.payGate = leaf.payGate;
  if (leaf.deadline) row.deadlineDate = leaf.deadline;
  if (dates.segments) row.segments = dates.segments;
  return row;
}

interface Progress {
  /** Sum of leaf durations below a row. */
  weight: number;
  /** Sum of leaf duration x percentDone below a row. */
  done: number;
}

/**
 * Builds a row and everything below it. Summary dates span the children; percentDone is the
 * engine's roll-up, the duration-weighted average over every leaf below (not over the children).
 */
function buildRow(spec: NodeSpec, phaseCode: string, schedule: Map<number, Scheduled>): { row: SeedTaskRow; progress: Progress } {
  if (!isSummary(spec)) {
    const row = leafRow(spec, phaseCode, must(schedule.get(spec.id), `schedule of task ${spec.id}`));
    return { row, progress: { weight: spec.duration, done: spec.duration * row.percentDone } };
  }
  const built = spec.children.map((child) => buildRow(child, phaseCode, schedule));
  const first = must(built[0], `summary ${spec.id} has no tasks`).row;
  let startDate = first.startDate;
  let endDate = first.endDate;
  const progress: Progress = { weight: 0, done: 0 };
  for (const { row, progress: child } of built) {
    if (row.startDate < startDate) startDate = row.startDate;
    if (row.endDate > endDate) endDate = row.endDate;
    progress.weight += child.weight;
    progress.done += child.done;
  }
  const row: SeedTaskRow = {
    id: spec.id,
    name: spec.name,
    startDate,
    endDate,
    percentDone: progress.weight === 0 ? 0 : progress.done / progress.weight,
    expanded: !spec.collapsed,
    baselines: [{ startDate, endDate }],
    costCode: spec.code ?? `${phaseCode}-${spec.id}`,
    children: built.map(({ row: child }) => child),
  };
  if (spec.note) row.note = spec.note;
  return { row, progress };
}

function cloneFields(row: SeedTaskRow): SeedTaskFields {
  const { children: _children, ...fields } = row;
  const clone: SeedTaskFields = { ...fields, baselines: fields.baselines.map((baseline) => ({ ...baseline })) };
  if (fields.segments) clone.segments = fields.segments.map((segment) => ({ ...segment }));
  return clone;
}

function flatten(row: SeedTaskRow, parentId: number | null): SeedTaskRecord[] {
  return [{ ...cloneFields(row), parentId }, ...(row.children ?? []).flatMap((child) => flatten(child, row.id))];
}

function summaryIds(spec: NodeSpec): number[] {
  return isSummary(spec) ? [spec.id, ...spec.children.flatMap(summaryIds)] : [];
}

function buildTasks(phases: readonly SummarySpec[], dependencySpecs: readonly DependencySpec[], start: IsoDate): { rows: SeedTaskRow[]; records: SeedTaskRecord[] } {
  const leaves = phases.flatMap((phase) => leavesOf(phase, must(phase.code, `cost code of phase ${phase.id}`)));
  const ids = new Set<number>();
  for (const id of [...phases.flatMap(summaryIds), ...leaves.map(({ leaf }) => leaf.id)]) {
    if (ids.has(id)) throw new Error(`Seed is inconsistent: duplicate task id ${id}`);
    ids.add(id);
  }
  const schedule = scheduleLeaves(leaves.map(({ leaf }) => leaf), dependencySpecs, start);
  const rows = phases.map((phase) => buildRow(phase, must(phase.code, `cost code of phase ${phase.id}`), schedule).row);
  return { rows, records: rows.flatMap((row) => flatten(row, null)) };
}

function buildDependencies(dependencySpecs: readonly DependencySpec[]): SeedDependencyRow[] {
  return dependencySpecs.map((dep, index) => ({
    id: index + 1,
    fromEvent: dep.from,
    toEvent: dep.to,
    type: DEPENDENCY_TYPE[dep.kind ?? 'FS'],
    lag: dep.lag ?? 0,
    lagUnit: 'day',
  }));
}

function buildAssignments(phases: readonly SummarySpec[], resources: readonly SeedResourceRow[]): SeedAssignmentRow[] {
  const resourceIds = new Set(resources.map((resource) => resource.id));
  const crewIds = new Set(resources.filter((resource) => resource.kind !== 'equipment').map((resource) => resource.id));
  const rows: SeedAssignmentRow[] = [];
  for (const { leaf } of phases.flatMap((phase) => leavesOf(phase, ''))) {
    for (const resource of leaf.assign ?? []) {
      if (!resourceIds.has(resource)) throw new Error(`Seed is inconsistent: task ${leaf.id} assigns unknown resource ${resource}`);
      rows.push({ id: rows.length + 1, event: leaf.id, resource, units: 100, ...(leaf.people !== undefined && crewIds.has(resource) ? { headcount: leaf.people } : {}) });
    }
  }
  return rows;
}

/** What a project's spec builds: the Bryntum package and the flat records the tests read. */
export interface BuiltSeed {
  records: SeedRecords;
  inlineData: SeedInlineData;
}

export interface SeedProjectSpec {
  start: IsoDate;
  phases: readonly SummarySpec[];
  dependencies: readonly DependencySpec[];
  resources: SeedResourceRow[];
}

export function buildSeed({ start, phases, dependencies, resources }: SeedProjectSpec): BuiltSeed {
  const tasks = buildTasks(phases, dependencies, start);
  const projectFields: SeedProjectFields = { startDate: start, calendar: 'standard', hoursPerDay: 24, daysPerWeek: 5, daysPerMonth: 20 };
  const records: SeedRecords = {
    calendars: SEED_CALENDARS,
    tasks: tasks.records,
    dependencies: buildDependencies(dependencies),
    resources,
    assignments: buildAssignments(phases, resources),
  };
  return {
    records,
    inlineData: {
      ...projectFields,
      project: { ...projectFields },
      calendarsData: SEED_CALENDARS,
      tasksData: tasks.rows,
      dependenciesData: records.dependencies,
      resourcesData: resources,
      assignmentsData: records.assignments,
    },
  };
}
