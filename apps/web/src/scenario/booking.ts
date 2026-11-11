/**
 * What the scheduling engine says about an equipment booking: the booked activity's dates, the rental's
 * days (every calendar day, see rental-days.ts) and its idle days on either side of the activity, and the
 * activities the equipment is assigned to. The dates are read from a ProjectModel, never recomputed by hand.
 */
import type { CalendarModel, ProjectModel, ResourceModel, TaskModel } from '@bryntum/gantt';
import { addDays, idleRentalDays, parseDateOnly, rentalDays, toDateOnly, withinBuffer, type DateOnly } from '@collab/shared';

/** The booking fields the engine reads (an `equipment_bookings` row, camel-cased). */
export interface ScenarioBooking {
  taskId: number;
  resourceId: number;
  billableStart: DateOnly;
  /** Exclusive. */
  billableEnd: DateOnly;
}

const MS_PER_HOUR = 3_600_000;

export class ScenarioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScenarioError';
  }
}

export function bookedTask(project: ProjectModel, booking: ScenarioBooking): TaskModel {
  const task = project.taskStore.getById(booking.taskId) as TaskModel | undefined;
  if (!task) {
    throw new ScenarioError(`The booked activity (task ${booking.taskId}) is not in the project`);
  }
  return task;
}

export function bookedResource(project: ProjectModel, booking: ScenarioBooking): ResourceModel {
  const resource = project.resourceStore.getById(booking.resourceId) as ResourceModel | undefined;
  if (!resource) {
    throw new ScenarioError(`The booked equipment (resource ${booking.resourceId}) is not in the project`);
  }
  return resource;
}

/** The calendar the equipment works to, which says when it can work and not what it costs: its own, else the project's. */
export function equipmentCalendar(project: ProjectModel, booking: ScenarioBooking): CalendarModel {
  const resource = bookedResource(project, booking) as ResourceModel & { effectiveCalendar?: CalendarModel };
  return (resource.effectiveCalendar ?? project.calendar) as CalendarModel;
}

/** Working days of `calendar` in [start, end); 0 for an empty or inverted interval. */
export function workingDays(project: ProjectModel, calendar: CalendarModel, start: DateOnly, end: DateOnly): number {
  if (end <= start) {
    return 0;
  }
  const ms = calendar.calculateDurationMs(parseDateOnly(start), parseDateOnly(end));
  return Math.round(ms / (project.hoursPerDay * MS_PER_HOUR));
}

/** Whether `calendar` has any working time on `day`. */
export function isWorkingDay(calendar: CalendarModel, day: DateOnly): boolean {
  return calendar.calculateDurationMs(parseDateOnly(day), parseDateOnly(addDays(day, 1))) > 0;
}

/** The first working day of `calendar` on or after `day`. */
export function firstWorkingDay(calendar: CalendarModel, day: DateOnly): DateOnly {
  let current = day;
  for (let guard = 0; guard < 60 && !isWorkingDay(calendar, current); guard++) current = addDays(current, 1);
  return current;
}

/** The exclusive end of `days` working days of `calendar` starting on `start`. */
export function endAfterWorkingDays(calendar: CalendarModel, start: DateOnly, days: number): DateOnly {
  let current = start;
  for (let left = days, guard = 0; left > 0 && guard < 400; guard++) {
    if (isWorkingDay(calendar, current)) left -= 1;
    current = addDays(current, 1);
  }
  return current;
}

export interface LinkedActivity {
  taskId: number;
  name: string;
  start: DateOnly;
  end: DateOnly;
}

export interface BookingFacts {
  taskName: string;
  taskStart: DateOnly;
  /** Exclusive. */
  taskEnd: DateOnly;
  resourceName: string;
  calendarName: string;
  /** Every calendar day on rent. */
  billableDays: number;
  /** Days on rent with no work planned, before the booked activity and after it, at the current schedule. */
  idleDays: number;
  idleBefore: number;
  idleAfter: number;
  /** Those days are no more than a working day of cover either side: nothing to flag. */
  buffered: boolean;
  /** Every activity the equipment is assigned to. */
  activities: LinkedActivity[];
}

function taskDates(task: TaskModel): { start: DateOnly; end: DateOnly } {
  if (!(task.startDate instanceof Date) || !(task.endDate instanceof Date)) {
    throw new ScenarioError(`Task ${String(task.id)} has no scheduled dates`);
  }
  return { start: toDateOnly(task.startDate), end: toDateOnly(task.endDate) };
}

export function readBookingFacts(project: ProjectModel, booking: ScenarioBooking): BookingFacts {
  const task = bookedTask(project, booking);
  const resource = bookedResource(project, booking);
  const calendar = equipmentCalendar(project, booking);
  const { start, end } = taskDates(task);
  const idle = idleRentalDays({ start: booking.billableStart, end: booking.billableEnd }, { start, end });
  const activities = (resource.assignments as unknown as { event?: TaskModel | null }[])
    .map((assignment) => assignment.event)
    .filter((event): event is TaskModel => event != null && typeof event.id === 'number')
    .map((event) => ({ taskId: event.id as number, name: event.name, ...taskDates(event) }))
    .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.taskId - b.taskId));
  return {
    taskName: task.name,
    taskStart: start,
    taskEnd: end,
    resourceName: resource.name,
    calendarName: calendar.name ?? String(calendar.id),
    billableDays: rentalDays(booking.billableStart, booking.billableEnd),
    idleDays: idle.before + idle.after,
    idleBefore: idle.before,
    idleAfter: idle.after,
    buffered: withinBuffer({ start: booking.billableStart, end: booking.billableEnd }, { start, end }, (day) => isWorkingDay(calendar, day)),
    activities,
  };
}

/** Proposal defaults: on rent for the days of the activity, from the day it starts to the day it ends. A machine kept on after that is idle, the same as one that comes early. */
export function defaultRevisedInterval(project: ProjectModel, booking: ScenarioBooking): { newStart: DateOnly; newEnd: DateOnly } {
  const { start, end } = taskDates(bookedTask(project, booking));
  return { newStart: start, newEnd: end > start ? end : addDays(start, 1) };
}
