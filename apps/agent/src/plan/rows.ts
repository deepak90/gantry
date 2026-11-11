/**
 * Builds the PlanSnapshot from database rows: the project's snapshot (Bryntum inline data at
 * `snapshot_revision`) with every later revision laid over it (tasks, links, crew assignments and
 * crews, matched by record id), plus bookings and members. Revisions carry the engine's own date
 * changes, so the overlay is a close approximation of what the browsers show; it is used for spotting
 * issues, never for the numbers that get approved (those come from the browser's engine check). A
 * removed task takes the tasks under it, its links and its crew assignments with it.
 */
import type { SeedCalendarId } from '@collab/shared/seed';
import { buildTasks, deriveStatusDate, ROLE_LABELS, type PlanMember, type PlanSnapshot, type RawTask } from './snapshot';

export interface SnapshotTask extends Omit<RawTask, 'parentId'> {
  children?: SnapshotTask[];
  [field: string]: unknown;
}

export interface ProjectRowInput {
  id: string;
  name: string;
  currency: 'USD';
  current_revision: number;
  handover_task_id: number | null;
  /** Who the project bills (its client; Harbor's is the tenant); absent on plans built by hand. */
  client_name?: string | null;
  /** Progress payouts over this need a second person who sees costs to approve them; absent where it can't be read. */
  second_approval_over_minor?: number | null;
  snapshot: {
    /** Project-level fields; the unit sizes convert lags entered in hours, weeks or months. */
    project?: { hoursPerDay?: number; daysPerWeek?: number; daysPerMonth?: number; [field: string]: unknown };
    tasksData?: SnapshotTask[];
    resourcesData?: { id: number; name: string; kind?: string; company?: string; trade?: string; calendar?: SeedCalendarId | null }[];
    assignmentsData?: { id?: number; event: number; resource: number; units?: number; rentalStart?: string; rentalEnd?: string }[];
    dependenciesData?: { id?: number; fromEvent: number; toEvent: number; type?: number; lag?: number; lagUnit?: string; active?: boolean }[];
    /** The calendars, with their days off: dated ones (a holiday, the inspector away) are read for the plan's state. */
    calendarsData?: { id?: unknown; name?: string; intervals?: { name?: string; startDate?: string; endDate?: string; isWorking?: boolean }[] }[];
  } | null;
}

/** Days off on a calendar that fall on dates (not every weekend): a shutdown, a holiday, someone away. */
export function calendarBreaksOf(snapshot: PlanRows['project']['snapshot']): { calendar: string; name: string; first_day: string; last_day: string }[] {
  const out: { calendar: string; name: string; first_day: string; last_day: string }[] = [];
  for (const calendar of snapshot?.calendarsData ?? []) {
    for (const interval of calendar.intervals ?? []) {
      if (interval.isWorking !== false || typeof interval.startDate !== 'string' || typeof interval.endDate !== 'string') continue;
      const first = interval.startDate.slice(0, 10);
      const end = interval.endDate.slice(0, 10);
      if (end <= first) continue;
      const lastDay = new Date(Date.UTC(Number(end.slice(0, 4)), Number(end.slice(5, 7)) - 1, Number(end.slice(8, 10)) - 1)).toISOString().slice(0, 10);
      out.push({ calendar: typeof calendar.id === 'string' ? calendar.id : String(calendar.id ?? ''), name: interval.name?.trim() || 'Day off', first_day: first, last_day: lastDay });
    }
  }
  return out;
}

export interface RevisionRowInput {
  revision_no: number;
  /** When and by whom (read for the change history; the plan itself needs only the changes). */
  created_at?: string;
  actor_user_id?: string | null;
  origin?: 'human' | 'agent' | 'engine';
  changes: Record<string, { added?: Record<string, unknown>[]; updated?: Record<string, unknown>[]; removed?: { id: unknown }[] } | unknown>;
}

export interface BookingRowInput {
  id: string;
  task_id: number;
  resource_id: number;
  supplier_name: string;
  rental_rate_minor: number;
  currency: 'USD';
  billable_start: string;
  billable_end: string;
}

export interface MemberRowInput {
  user_id: string;
  role: 'pm' | 'cm';
  approval_limit_minor: number;
  can_view_costs: boolean;
}

export interface ProfileRowInput {
  user_id: string;
  display_name: string;
}

export interface PlanRows {
  project: ProjectRowInput;
  revisions: RevisionRowInput[];
  bookings: BookingRowInput[];
  members: MemberRowInput[];
  profiles: ProfileRowInput[];
}

export type FlatTask = Record<string, unknown> & { id: number; parentId: number | null };
export type FlatRecord = Record<string, unknown> & { id: number };

export function flatten(rows: SnapshotTask[], parentId: number | null, out: Map<number, FlatTask>): void {
  rows.forEach((row, rowIndex) => {
    const { children, ...rest } = row;
    if (typeof rest.id === 'number') out.set(rest.id, { ...(rest as Record<string, unknown>), id: rest.id, parentId, rowIndex });
    if (children) flatten(children, typeof rest.id === 'number' ? rest.id : parentId, out);
  });
}

export interface StoreBags {
  added?: Record<string, unknown>[];
  updated?: Record<string, unknown>[];
  removed?: { id: unknown }[];
}

/**
 * One store's changes in a revision. The top-level bags are what the server persisted (the person's
 * input and the changes the engine made as a result); `$input` (the person's part alone) is read only when the
 * top level has no bag of that kind.
 */
export function asStoreChanges(value: unknown): StoreBags | null {
  if (!value || typeof value !== 'object') return null;
  const top = value as StoreBags & { $input?: StoreBags };
  const input = top.$input && typeof top.$input === 'object' ? top.$input : {};
  const bag = <T>(own: T[] | undefined, fallback: T[] | undefined): T[] => (Array.isArray(own) ? own : Array.isArray(fallback) ? fallback : []);
  return { added: bag(top.added, input.added), updated: bag(top.updated, input.updated), removed: bag(top.removed, input.removed) };
}

export const isId = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** Lays one store's added, updated and removed records over `byId` (records without a numeric id are skipped). */
function overlay<T extends FlatRecord>(byId: Map<number, T>, changes: StoreBags, merge: (current: T | undefined, patch: Record<string, unknown>) => T): void {
  for (const added of changes.added ?? []) if (isId(added.id)) byId.set(added.id, merge(undefined, added));
  for (const patch of changes.updated ?? []) {
    const current = isId(patch.id) ? byId.get(patch.id) : undefined;
    if (current) byId.set(current.id, merge(current, patch));
  }
  for (const removed of changes.removed ?? []) if (isId(removed.id)) byId.delete(removed.id);
}

const mergeRecord = (current: FlatRecord | undefined, patch: Record<string, unknown>): FlatRecord =>
  current ? Object.assign(current, patch, { id: current.id }) : { ...patch, id: patch.id as number };

const mergeTask = (current: FlatTask | undefined, patch: Record<string, unknown>): FlatTask => {
  const parentId = typeof patch.parentId === 'number' ? patch.parentId : current ? current.parentId : null;
  return current ? Object.assign(current, patch, { id: current.id, parentId }) : { ...patch, id: patch.id as number, parentId };
};

/** Drops every task whose parent is gone (the tasks under a removed group). */
function dropOrphans(byId: Map<number, FlatTask>): void {
  let dropped = true;
  while (dropped) {
    dropped = false;
    for (const [id, task] of byId) {
      if (task.parentId !== null && !byId.has(task.parentId)) {
        byId.delete(id);
        dropped = true;
      }
    }
  }
}

interface UnitSizes {
  hoursPerDay: number;
  daysPerWeek: number;
  daysPerMonth: number;
}

/** A link's lag in working days: Bryntum lags may be entered in minutes, hours, days, weeks, months or years. */
export function lagInDays(lag: unknown, unit: unknown, sizes: UnitSizes = { hoursPerDay: 24, daysPerWeek: 5, daysPerMonth: 20 }): number {
  const value = typeof lag === 'number' && Number.isFinite(lag) ? lag : 0;
  const name = typeof unit === 'string' ? unit.trim() : '';
  if (!name || value === 0) return value;
  const lower = name.toLowerCase();
  const days =
    lower.startsWith('ms') || lower.startsWith('milli') ? value / (sizes.hoursPerDay * 3_600_000)
    : lower === 'm' || lower.startsWith('mi') ? value / (sizes.hoursPerDay * 60)
    : lower.startsWith('s') ? value / (sizes.hoursPerDay * 3600)
    : lower.startsWith('h') ? value / sizes.hoursPerDay
    : lower.startsWith('w') ? value * sizes.daysPerWeek
    : name === 'M' || lower.startsWith('mo') ? value * sizes.daysPerMonth
    : lower.startsWith('q') ? value * sizes.daysPerMonth * 3
    : lower.startsWith('y') ? value * sizes.daysPerMonth * 12
    : value;
  return Math.round(days * 100) / 100;
}

export function membersFrom(members: MemberRowInput[], profiles: ProfileRowInput[]): PlanMember[] {
  return members.map((member) => ({
    userId: member.user_id,
    name: profiles.find((profile) => profile.user_id === member.user_id)?.display_name ?? ROLE_LABELS[member.role],
    role: member.role,
    roleLabel: ROLE_LABELS[member.role],
    canViewCosts: member.can_view_costs,
    approvalLimitMinor: member.approval_limit_minor,
  }));
}

export function planFromRows(rows: PlanRows): PlanSnapshot {
  const snapshot = rows.project.snapshot ?? {};
  const byId = new Map<number, FlatTask>();
  flatten(snapshot.tasksData ?? [], null, byId);
  // Snapshot links and assignments without an id cannot be matched by a revision; they get keys below any real id.
  let unmatched = -1;
  const keyed = <T extends { id?: number }>(record: T): FlatRecord => ({ ...(record as Record<string, unknown>), id: isId(record.id) ? record.id : unmatched-- });
  const links = new Map<number, FlatRecord>((snapshot.dependenciesData ?? []).map((link) => keyed(link)).map((link) => [link.id, link]));
  const crewAssignments = new Map<number, FlatRecord>((snapshot.assignmentsData ?? []).map((assignment) => keyed(assignment)).map((assignment) => [assignment.id, assignment]));
  const crews = new Map<number, FlatRecord>((snapshot.resourcesData ?? []).filter((resource) => isId(resource.id)).map((resource) => [resource.id, { ...resource }]));
  for (const revision of [...rows.revisions].sort((a, b) => a.revision_no - b.revision_no)) {
    const tasks = asStoreChanges(revision.changes.tasks);
    if (tasks) overlay(byId, tasks, mergeTask);
    const dependencies = asStoreChanges(revision.changes.dependencies);
    if (dependencies) overlay(links, dependencies, mergeRecord);
    const assignments = asStoreChanges(revision.changes.assignments);
    if (assignments) overlay(crewAssignments, assignments, mergeRecord);
    const resources = asStoreChanges(revision.changes.resources);
    if (resources) overlay(crews, resources, mergeRecord);
  }
  dropOrphans(byId);
  const raw = [...byId.values()].filter(
    (task): task is FlatTask & RawTask => typeof task.startDate === 'string' && typeof task.endDate === 'string' && typeof task.name === 'string',
  );
  const tasks = buildTasks(raw);
  const taskIds = new Set(tasks.map((task) => task.id));
  const sizes: UnitSizes = {
    hoursPerDay: snapshot.project?.hoursPerDay ?? 24,
    daysPerWeek: snapshot.project?.daysPerWeek ?? 5,
    daysPerMonth: snapshot.project?.daysPerMonth ?? 20,
  };
  const bookings = rows.bookings.map((booking) => ({
    id: booking.id,
    taskId: booking.task_id,
    resourceId: booking.resource_id,
    supplierName: booking.supplier_name,
    rentalRateMinor: booking.rental_rate_minor,
    currency: booking.currency,
    billableStart: booking.billable_start,
    billableEnd: booking.billable_end,
  }));
  return {
    projectId: rows.project.id,
    projectName: rows.project.name,
    currency: rows.project.currency,
    revision: rows.project.current_revision,
    statusDate: deriveStatusDate(tasks),
    handoverTaskId: rows.project.handover_task_id ?? tasks.filter((task) => task.isMilestone).map((task) => task.id).at(-1) ?? 0,
    tasks,
    resources: [...crews.values()]
      .filter((resource) => typeof resource.name === 'string')
      .map((resource) => ({
        id: resource.id,
        name: resource.name as string,
        kind: resource.kind === 'equipment' ? 'equipment' : 'labor',
        company: typeof resource.company === 'string' ? resource.company : '',
        trade: typeof resource.trade === 'string' ? resource.trade : '',
        calendar: resource.calendar === 'site' ? 'site' : 'standard',
      })),
    assignments: [...crewAssignments.values()]
      .filter((assignment) => isId(assignment.event) && isId(assignment.resource) && taskIds.has(assignment.event) && crews.has(assignment.resource))
      .map((assignment) => ({
        ...(assignment.id > 0 ? { id: assignment.id } : {}),
        taskId: assignment.event as number,
        resourceId: assignment.resource as number,
        units: typeof assignment.units === 'number' ? assignment.units : 100,
        ...(typeof assignment.rentalStart === 'string' ? { rentalStart: assignment.rentalStart } : {}),
        ...(typeof assignment.rentalEnd === 'string' ? { rentalEnd: assignment.rentalEnd } : {}),
      })),
    dependencies: [...links.values()]
      .filter((link) => isId(link.fromEvent) && isId(link.toEvent) && taskIds.has(link.fromEvent) && taskIds.has(link.toEvent))
      .map((link) => ({
        ...(link.id > 0 ? { id: link.id } : {}),
        from: link.fromEvent as number,
        to: link.toEvent as number,
        type: typeof link.type === 'number' ? link.type : 2,
        lag: lagInDays(link.lag, link.lagUnit, sizes),
        ...(typeof link.active === 'boolean' ? { active: link.active } : {}),
      })),
    bookings,
    members: membersFrom(rows.members, rows.profiles),
    clientName: rows.project.client_name ?? null,
    ...(typeof rows.project.second_approval_over_minor === 'number' ? { secondApprovalOverMinor: rows.project.second_approval_over_minor } : {}),
    calendarBreaks: calendarBreaksOf(snapshot),
  };
}
