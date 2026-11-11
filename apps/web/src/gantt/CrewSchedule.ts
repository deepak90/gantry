/**
 * The crew schedule: a Bryntum Scheduler Pro over the SAME project instance as the Gantt (not a
 * copy), with one row per crew and that crew's tasks as bars on the Gantt's own time axis. Drag a
 * bar sideways to move the task, or onto another crew's row to hand the task over to that crew.
 *
 * Both drags run as transactional features: Bryntum wraps each drop in one STM transaction inside
 * the project queue, so a drop reaches everyone as one revision, and a revision that arrives while
 * a bar is held waits until it is dropped. Everything else Scheduler Pro would let a user do here
 * (its pop-up task editor, which holds the project queue while open; menus; creating, copying,
 * pasting or deleting tasks; drawing links; renaming crews in the grid) is turned off: tasks are
 * created and edited in the Gantt and the side panel.
 */
import { DateHelper, SchedulerPro, StringHelper } from '@bryntum/gantt';
import type { AssignmentModel, DomConfig, Gantt, Model, ProjectModel, ResourceModel, SchedulerProConfig, Store, TaskModel } from '@bryntum/gantt';
import { crewBadge } from './columns';
import { crewColor, original } from './look';

export interface CrewScheduleOptions {
  /** Element the schedule renders into; it fills it. */
  appendTo: HTMLElement;
  /** The live project the Gantt shows. */
  project: ProjectModel;
  /** The Gantt whose time axis, zoom and horizontal scroll the schedule follows. */
  partner?: Gantt;
  /** Width of the crew column, to line the timeline up with the Gantt's. */
  lockedWidth?: number;
  readOnly?: boolean;
  /** Hover card for a task (the Gantt's own, so both views say the same). */
  tooltip?: (task: TaskModel) => string;
  /** A click on a bar, and a drop once it is saved: show the task in the Gantt. */
  onSelectTask?: (task: TaskModel) => void;
  /** A double-click on a bar: open the task in the side panel. */
  onOpenTask?: (task: TaskModel) => void;
}

/** One plain line about a drop: whether it is allowed, and what it does or why not. */
export interface CrewMoveVerdict {
  valid: boolean;
  message: string;
}

const DAY = 'ddd MMM D';

function crewName(crew: ResourceModel | null | undefined): string {
  return crew?.name || 'this crew';
}

function taskName(task: TaskModel): string {
  return original(task).name || 'This task';
}

/**
 * Whether the task of `assignment` may go to `target` (the crew row under the pointer). Bryntum
 * refuses a crew that is already on the task by itself, in its own words ("Event cannot be
 * assigned to the same resource multiple times"); the drag tooltip shows this plain reason instead.
 */
export function crewMoveVerdict(assignment: AssignmentModel | undefined, target: ResourceModel | null | undefined): CrewMoveVerdict {
  const task = assignment?.event as TaskModel | undefined;
  if (!task || !target) return { valid: false, message: 'Drop on a crew’s row' };
  const from = assignment?.resource as ResourceModel | undefined;
  if (from === target) return { valid: true, message: '' };
  const crews = (original(task).resources ?? []) as ResourceModel[];
  if (crews.includes(target)) return { valid: false, message: `${crewName(target)} is already on “${taskName(task)}”` };
  return { valid: true, message: `Hand over from ${crewName(from)} to ${crewName(target)}` };
}

/** Last working day of a task (its end date is exclusive), as people say it. */
function lastDay(task: TaskModel, end: Date): Date {
  return task.isMilestone ? end : new Date(end.getTime() - 1);
}

/** What the drag tooltip says: the new dates, and the hand-over when the crew changes. */
export function dragTipHtml(data: { eventRecord: TaskModel; newResource?: ResourceModel; valid: boolean; startDate: Date; endDate: Date; message?: string; dragData?: { assignmentRecords?: AssignmentModel[] } }): string {
  const task = data.eventRecord;
  const assignment = data.dragData?.assignmentRecords?.[0];
  const verdict = crewMoveVerdict(assignment, data.newResource);
  const message = data.valid || !verdict.valid ? verdict.message : data.message;
  const start = DateHelper.format(data.startDate, DAY);
  const end = DateHelper.format(lastDay(task, data.endDate), DAY);
  const when = task.isMilestone || start === end ? start : `${start} → ${end}`;
  return [
    `<div class="crew-tip ${data.valid ? 'is-valid' : 'is-invalid'}">`,
    `<strong>${StringHelper.encodeHtml(taskName(task))}</strong>`,
    `<span class="crew-tip-when"><i class="fa fa-calendar-days"></i>${StringHelper.encodeHtml(when)}</span>`,
    message ? `<span class="crew-tip-message">${StringHelper.encodeHtml(message)}</span>` : '',
    '</div>',
  ].join('');
}

function renderCrew({ record }: { record: Model }): DomConfig {
  const crew = record as ResourceModel;
  const count = (crew.events ?? []).length;
  return {
    tag: 'span',
    className: 'crew-schedule-crew',
    children: [
      crewBadge(crew),
      { tag: 'span', className: 'crew-schedule-crew-name', text: crew.name ?? '' },
      { tag: 'span', className: 'crew-schedule-crew-count', text: count === 1 ? '1 task' : `${count} tasks` },
    ],
  };
}

interface EventRenderContext {
  eventRecord: TaskModel;
  resourceRecord: ResourceModel;
  renderData: { eventColor: string };
}

/**
 * A bar: the crew's color, the task name and how far along it is (the fill is Bryntum's percent
 * bar; the figure hides on narrow bars, see crew-schedule.css).
 */
function renderEvent({ eventRecord, resourceRecord, renderData }: EventRenderContext): DomConfig[] {
  const task = eventRecord;
  renderData.eventColor = crewColor(resourceRecord);
  const done = Math.round(task.percentDone ?? 0);
  const name: DomConfig = { tag: 'span', className: 'crew-event-name', text: task.name ?? '' };
  if (done === 0) return [name];
  return [
    name,
    done >= 100
      ? { tag: 'i', className: 'crew-event-done fa fa-circle-check', title: 'Done' }
      : { tag: 'span', className: 'crew-event-progress', text: `${done}%` },
  ];
}

export function crewScheduleConfig(options: CrewScheduleOptions): Partial<SchedulerProConfig> {
  const { project, partner, lockedWidth = 618, readOnly = false, tooltip, onSelectTask, onOpenTask } = options;
  return {
    appendTo: options.appendTo,
    project: project as unknown as SchedulerProConfig['project'],
    partner,
    readOnly,
    cls: 'crew-schedule',
    hideHeaders: true,
    rowHeight: 42,
    barMargin: 7,
    eventStyle: 'filled',
    useInitialAnimation: false,
    // One edit per drop, as one revision; a revision arriving mid-drag waits for the drop.
    enableTransactionalFeatures: true,
    // The Delete key would remove the task (or the crew from it) with no way to see what happened.
    enableDeleteKey: false,
    subGridConfigs: { locked: { width: lockedWidth } },
    columns: [{ field: 'name', text: 'Crew', flex: 1, editor: false, renderer: renderCrew }],
    eventRenderer: renderEvent as unknown as SchedulerProConfig['eventRenderer'],
    features: {
      // Sideways moves the task (the engine pins it there, like a drag in the Gantt); onto another
      // row hands it to that crew. Holding Ctrl does not copy.
      eventDrag: {
        copyKey: '',
        showExactDropPosition: true,
        tooltipTemplate: dragTipHtml as unknown as (data: object) => string,
        validatorFn: ({ assignmentRecords, newResource }: { assignmentRecords: unknown[]; newResource: unknown }) =>
          crewMoveVerdict(assignmentRecords[0] as AssignmentModel, newResource as ResourceModel),
      },
      // Progress is shown, not dragged: it is set in the Gantt and the side panel.
      percentBar: { allowResize: false, showPercentage: false },
      eventTooltip: tooltip
        ? { cls: 'look-tooltip', maxWidth: 380, template: ({ eventRecord }: { eventRecord: TaskModel }) => tooltip(eventRecord) }
        : true,
      // Off: Scheduler Pro's pop-up task editor holds the project queue while it is open, and these
      // others create, copy, delete or re-link tasks outside the plan's own editors.
      taskEdit: false,
      eventEdit: false,
      cellEdit: false,
      cellMenu: false,
      eventMenu: false,
      scheduleMenu: false,
      headerMenu: false,
      timeAxisHeaderMenu: false,
      eventDragCreate: false,
      eventCopyPaste: false,
      eventResize: false,
      eventSegmentDrag: false,
      eventSegmentResize: false,
      dependencies: false,
      dependencyEdit: false,
      dependencyMenu: false,
      scheduleTooltip: false,
      sort: false,
      // The crew column follows the Gantt's splitter, so the two timelines line up.
      regionResize: false,
      columnReorder: false,
      columnPicker: false,
    },
    listeners: {
      eventClick: ({ eventRecord }: { eventRecord: unknown }) => onSelectTask?.(eventRecord as TaskModel),
      // Once the drop's transaction is done (the change is in the plan and on its way to everyone).
      afterEventDrop: ({ source, eventRecords }: { source: unknown; eventRecords: unknown[] }) => {
        const task = eventRecords[0] as TaskModel | undefined;
        if (!task || !onSelectTask) return;
        (source as { afterFeatureTransaction(callback: () => void): void }).afterFeatureTransaction(() => {
          if (!task.isDestroyed) onSelectTask(task);
        });
      },
      eventDblClick: ({ eventRecord }: { eventRecord: unknown }) => onOpenTask?.(eventRecord as TaskModel),
    },
  } as Partial<SchedulerProConfig>;
}

/**
 * Selects the task's row in the Gantt, scrolls it into view and flashes its bar. While the Gantt is
 * grouped it shows linked copies; the copy of this task is selected.
 */
export function revealTaskInGantt(gantt: Gantt, task: TaskModel): boolean {
  const record = original(task);
  const store = gantt.store as Store;
  const shown =
    (store.getById(record.id) as TaskModel | undefined) ??
    (store.find((candidate: Model) => original(candidate as TaskModel) === record, true) as TaskModel | undefined);
  if (!shown || gantt.isDestroyed) return false;
  gantt.selectRow({ record: shown, scrollIntoView: true });
  void gantt.scrollTaskIntoView(shown, { highlight: true, block: 'center' });
  return true;
}

/** Creates the crew schedule; destroy it when the pane closes (the project lives on). */
export function createCrewSchedule(options: CrewScheduleOptions): SchedulerPro {
  return new SchedulerPro(crewScheduleConfig(options) as SchedulerProConfig);
}
