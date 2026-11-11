/**
 * A plain, JSON-safe view of the plan the agent reasons over. The agent never runs the scheduling
 * engine in Node: it reads task dates as the engine last scheduled them (the project snapshot with
 * later revisions laid over it) and counts working days with the seed calendars. Anything that needs
 * real rescheduling is checked on the engine in a person's browser.
 */
import { readPayGate, TaskBand, type CurrencyCode, type PayGate } from '@collab/shared';
import type { SeedCalendarId } from '@collab/shared/seed';

export interface PlanTask {
  id: number;
  name: string;
  parentId: number | null;
  /** The phase (top-level summary) the task belongs to. */
  phase: string;
  start: string;
  /** Exclusive. */
  end: string;
  calendar: SeedCalendarId;
  percentDone: number;
  isLeaf: boolean;
  isMilestone: boolean;
  baselineStart: string | null;
  baselineEnd: string | null;
  budgetMinor: number;
  forecastMinor: number;
  incurredMinor: number;
  paidMinor: number;
  /** Working pieces of a split task; the gaps between them are not work. */
  segments: { start: string; end: string }[] | null;
  note?: string;
  /** Bryntum constraint, e.g. 'startnoearlierthan', 'muststarton' (absent when the task has none). */
  constraintType?: string;
  constraintDate?: string;
  /** The date it must be done by (Bryntum `deadlineDate`): a contract date that schedules nothing. */
  deadline?: string;
  manuallyScheduled?: boolean;
  /** An inactive task stays in the plan but is not worked and moves nothing. */
  inactive?: boolean;
  /** Position among its siblings (`orderedParentIndex`, else `parentIndex`, else the snapshot's row order). */
  order?: number;
  /** Outline number from the task's place in the plan, e.g. "3.4.1" (what Bryntum shows as the WBS). */
  wbs?: string;
  /** Time ranges a library piece brought along, tied to tasks under this one by position. */
  bands?: TaskBand[];
  /** The library snippet a dropped piece came from (on each top task of the piece): the change a piece made. */
  libraryRef?: string;
  /** A payment gate on this milestone: the work after it waits until the progress payment it names is paid. */
  payGate?: PayGate;
}

export interface PlanResource {
  id: number;
  /** A crew goes by its firm's name; equipment by what it is. */
  name: string;
  kind: 'labor' | 'equipment';
  company: string;
  /** What the crew does (Electrical, HVAC …), or the kind of equipment; may be empty. */
  trade?: string;
  calendar: SeedCalendarId;
}

export interface PlanAssignment {
  /** Bryntum record id (absent on hand-built plans). */
  id?: number;
  taskId: number;
  resourceId: number;
  units: number;
  /** A machine's own dates on this task, `YYYY-MM-DD`, the end exclusive; without them it goes by the task's days. */
  rentalStart?: string | null;
  rentalEnd?: string | null;
}

/** Whether a crew or machine is needed on a working day of its task: a machine only within its own dates there. */
export function neededOn(assignment: PlanAssignment, date: string): boolean {
  return (!assignment.rentalStart || date >= assignment.rentalStart) && (!assignment.rentalEnd || date < assignment.rentalEnd);
}

export interface PlanDependency {
  /** Bryntum record id (absent on hand-built plans). */
  id?: number;
  from: number;
  to: number;
  /** Bryntum DependencyModel.Type: 0 start-to-start, 1 start-to-finish, 2 finish-to-start, 3 finish-to-finish. */
  type: number;
  /** Working days (negative is a lead); a lag entered in hours, weeks or months is converted to days. */
  lag: number;
  /** False for a link switched off: it stays in the plan but moves nothing. */
  active?: boolean;
}

export interface PlanBooking {
  id: string;
  taskId: number;
  resourceId: number;
  supplierName: string;
  rentalRateMinor: number;
  currency: CurrencyCode;
  billableStart: string;
  /** Exclusive. */
  billableEnd: string;
}

export interface PlanMember {
  userId: string;
  name: string;
  /** Still in the data, but no longer decides anything: one role for everyone (see ROLE_LABELS). */
  role: 'pm' | 'cm';
  roleLabel: string;
  canViewCosts: boolean;
  approvalLimitMinor: number;
}

export interface PlanSnapshot {
  projectId: string;
  projectName: string;
  currency: CurrencyCode;
  revision: number;
  /** The day the plan is read "as of": the first day with work not yet started. */
  statusDate: string;
  handoverTaskId: number;
  tasks: PlanTask[];
  resources: PlanResource[];
  assignments: PlanAssignment[];
  dependencies: PlanDependency[];
  bookings: PlanBooking[];
  members: PlanMember[];
  /** Who the project bills (its client; Harbor's is the tenant), by name; null or absent when nobody is. */
  clientName?: string | null;
  /** Progress payouts over this need a second person who sees costs to approve them; absent: the default ($25,000). */
  secondApprovalOverMinor?: number | null;
  /** Days off on a calendar that fall on dates: the holiday shutdown, the holidays, the city inspector away. */
  calendarBreaks?: { calendar: string; name: string; first_day: string; last_day: string }[];
}

/**
 * One role for everyone: the app calls every member "Member". The role column stays in
 * the data, but what a member may do follows from seeing costs and their approval limit, not from it.
 */
export const ROLE_LABELS = { pm: 'Member', cm: 'Member' } as const;

export interface RawTask {
  id: number;
  name: string;
  parentId: number | null;
  startDate: string;
  endDate: string;
  percentDone?: number;
  calendar?: SeedCalendarId | null;
  baselines?: { startDate: string; endDate: string }[];
  budgetMinor?: number | null;
  forecastMinor?: number | null;
  incurredMinor?: number | null;
  paidMinor?: number | null;
  segments?: { startDate: string; endDate: string }[] | null;
  note?: string | null;
  constraintType?: string | null;
  constraintDate?: string | null;
  deadlineDate?: string | null;
  manuallyScheduled?: boolean | null;
  inactive?: boolean | null;
  orderedParentIndex?: number | null;
  parentIndex?: number | null;
  /** The row's position among its siblings in the snapshot, used when the data has no index of its own. */
  rowIndex?: number;
  bands?: unknown;
  libraryRef?: string | null;
  payGate?: unknown;
}

/** The optional fields of a raw task, set only when the data has them. */
function optionalFields(task: RawTask): Partial<PlanTask> {
  const extra: Partial<PlanTask> = {};
  if (typeof task.note === 'string' && task.note.trim()) extra.note = task.note;
  if (typeof task.constraintType === 'string' && task.constraintType) {
    extra.constraintType = task.constraintType;
    if (typeof task.constraintDate === 'string' && task.constraintDate) extra.constraintDate = task.constraintDate.slice(0, 10);
  }
  if (typeof task.deadlineDate === 'string' && task.deadlineDate) extra.deadline = task.deadlineDate.slice(0, 10);
  if (typeof task.manuallyScheduled === 'boolean') extra.manuallyScheduled = task.manuallyScheduled;
  if (typeof task.inactive === 'boolean') extra.inactive = task.inactive;
  const order = [task.orderedParentIndex, task.parentIndex, task.rowIndex].find((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (order !== undefined) extra.order = order;
  if (Array.isArray(task.bands)) {
    const bands = task.bands.map((band) => TaskBand.safeParse(band)).flatMap((parsed) => (parsed.success ? [parsed.data] : []));
    if (bands.length > 0) extra.bands = bands;
  }
  if (typeof task.libraryRef === 'string' && task.libraryRef) extra.libraryRef = task.libraryRef;
  const payGate = readPayGate(task.payGate);
  if (payGate) extra.payGate = payGate;
  return extra;
}

/** Outline numbers ("1", "1.2", "1.2.3") from each task's place among its siblings. */
function numberOutline(tasks: PlanTask[]): void {
  const ids = new Set(tasks.map((task) => task.id));
  const children = new Map<number | null, PlanTask[]>();
  for (const task of tasks) {
    const key = task.parentId !== null && ids.has(task.parentId) ? task.parentId : null;
    children.set(key, [...(children.get(key) ?? []), task]);
  }
  const seen = new Set<number>();
  const visit = (parent: number | null, prefix: string) => {
    const kids = [...(children.get(parent) ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    kids.forEach((task, index) => {
      if (seen.has(task.id)) return;
      seen.add(task.id);
      task.wbs = prefix ? `${prefix}.${index + 1}` : String(index + 1);
      visit(task.id, task.wbs);
    });
  };
  visit(null, '');
}

export function buildTasks(raw: RawTask[]): PlanTask[] {
  const byId = new Map(raw.map((task) => [task.id, task]));
  const hasChildren = new Set(raw.map((task) => task.parentId).filter((id): id is number => id !== null));
  const phaseOf = (task: RawTask): string => {
    let node: RawTask | undefined = task;
    const seen = new Set<number>();
    while (node && node.parentId !== null && !seen.has(node.id)) {
      seen.add(node.id);
      const parent: RawTask | undefined = byId.get(node.parentId);
      if (!parent) break;
      node = parent;
    }
    return node?.name ?? task.name;
  };
  const tasks = raw.map((task): PlanTask => {
    const start = task.startDate.slice(0, 10);
    const end = task.endDate.slice(0, 10);
    const leaf = !hasChildren.has(task.id);
    return {
      id: task.id,
      name: task.name,
      parentId: task.parentId,
      phase: phaseOf(task),
      start,
      end,
      calendar: task.calendar ?? 'standard',
      percentDone: task.percentDone ?? 0,
      isLeaf: leaf,
      isMilestone: leaf && start === end,
      baselineStart: task.baselines?.[0]?.startDate.slice(0, 10) ?? null,
      baselineEnd: task.baselines?.[0]?.endDate.slice(0, 10) ?? null,
      budgetMinor: task.budgetMinor ?? 0,
      forecastMinor: task.forecastMinor ?? task.budgetMinor ?? 0,
      incurredMinor: task.incurredMinor ?? 0,
      paidMinor: task.paidMinor ?? 0,
      segments:
        task.segments && task.segments.length > 1
          ? task.segments.map((segment) => ({ start: segment.startDate.slice(0, 10), end: segment.endDate.slice(0, 10) }))
          : null,
      ...optionalFields(task),
    };
  });
  numberOutline(tasks);
  return tasks;
}

/** First day on which a leaf task has not started yet: the plan's "as of" date. */
export function deriveStatusDate(tasks: PlanTask[]): string {
  const notStarted = tasks.filter((task) => task.isLeaf && !task.isMilestone && task.percentDone === 0).map((task) => task.start);
  return notStarted.sort()[0] ?? tasks.map((task) => task.start).sort()[0] ?? '1970-01-01';
}

export function taskById(plan: PlanSnapshot, id: number): PlanTask {
  const task = plan.tasks.find((candidate) => candidate.id === id);
  if (!task) throw new Error(`Task ${id} is not in the plan`);
  return task;
}

export function findTask(plan: PlanSnapshot, id: number | null | undefined): PlanTask | null {
  return id == null ? null : (plan.tasks.find((candidate) => candidate.id === id) ?? null);
}

export function resourceById(plan: PlanSnapshot, id: number): PlanResource {
  const resource = plan.resources.find((candidate) => candidate.id === id);
  if (!resource) throw new Error(`Resource ${id} is not in the plan`);
  return resource;
}

export function bookingById(plan: PlanSnapshot, id?: string | null): PlanBooking {
  const booking = id ? plan.bookings.find((candidate) => candidate.id === id) : plan.bookings[0];
  if (!booking) throw new Error(id ? `Booking ${id} is not in the plan` : 'The plan has no equipment booking');
  return booking;
}

/** The members who see costs: anyone of them approves a fix and pays the supplier, within their limit. */
export function costViewers(members: readonly PlanMember[]): PlanMember[] {
  return members.filter((member) => member.canViewCosts);
}

/** Who can approve a fix paying this much (the dates and the payment in one click): cost viewers whose limit covers it. */
export function approversFor(members: readonly PlanMember[], amountMinor: number | null): PlanMember[] {
  return costViewers(members).filter((member) => amountMinor === null || amountMinor <= member.approvalLimitMinor);
}

/** People in words, by first name: "Deepak", "Chris or Deepak", "anyone who sees costs" (none, or more than two). */
export function eitherOf(members: readonly PlanMember[]): string {
  if (members.length === 0 || members.length > 2) return 'anyone who sees costs';
  return members.map((member) => firstName(member.name)).join(' or ');
}

/**
 * Enough people for a meeting: at least two present, one of whom sees costs (so someone there can
 * approve a fix). With one role for everyone, this replaces waiting for both roles.
 */
export function meetingReady(present: readonly PlanMember[]): boolean {
  return new Set(present.map((member) => member.userId)).size >= 2 && present.some((member) => member.canViewCosts);
}

export function memberById(plan: PlanSnapshot, userId: string | null | undefined): PlanMember | null {
  return userId ? (plan.members.find((candidate) => candidate.userId === userId) ?? null) : null;
}

export function firstName(name: string): string {
  return name.split(/\s+/)[0] ?? name;
}
