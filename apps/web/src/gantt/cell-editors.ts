/**
 * Editors for the collapsed columns. One Schedule cell stands for start, finish, working days and
 * progress, and one cost cell for budget and expected cost, so a single-input cell editor cannot
 * edit them. The Gantt's own edit triggers (double-click, Enter, F2, typing) still start here: the
 * workspace vetoes Bryntum's cell editor for these columns and opens a small popup instead.
 *
 * The schedule popup also lists the links the task waits for, each with its wait (or overlap) in
 * working days, and, for cost viewers, one line of money and payment state with a way into the
 * task panel for everything else.
 *
 * Saving applies every changed field in ONE STM transaction, so collaborators receive one
 * revision for one save, never a half-applied edit. Fields are read again on save: an edit someone
 * else made to the task while the popup was open is kept unless this popup changed the same field.
 *
 * The Equipment cell's popup edits when the machine is on site for this task, the same way: one
 * transaction, one revision, undone and redone with the plan. Other tasks using the machine keep theirs.
 */
import { DateHelper, Popup, StringHelper } from '@bryntum/gantt';
import type { AssignmentModel, ProjectModel, ResourceModel, TaskModel } from '@bryntum/gantt';
import { addDays, parseDateOnly, rentalDays, toDateOnly, type CurrencyCode, type DateOnly } from '@collab/shared';
import { runProjectTransaction } from '../scenario/publish';
import type { RentalDates, RentalEdit } from '../workflow/rental';
import { lastWorkingDay, original, rolledUpMoney, wholeMoney, type Decorations, type TaskBadge } from './look';
import { dayRange, EDIT_DATE_FORMAT } from './columns';
import { planClock } from '../plan-clock';
import '../styles/task-inspector.css';

/** The engine calendar methods the schedule editor uses to keep start, finish and days in step. */
interface WorkingCalendar {
  calculateEndDate(startDate: Date, durationMs: number): Date | null;
  calculateDurationMs(startDate: Date, endDate: Date): number;
  skipNonWorkingTime(date: Date, isForward?: boolean): Date | null | string;
}

const HOUR_MS = 3_600_000;

function calendarOf(task: TaskModel): WorkingCalendar | null {
  const calendar = (task as TaskModel & { effectiveCalendar?: Partial<WorkingCalendar> }).effectiveCalendar;
  return calendar && typeof calendar.calculateEndDate === 'function' && typeof calendar.calculateDurationMs === 'function' && typeof calendar.skipNonWorkingTime === 'function'
    ? (calendar as WorkingCalendar)
    : null;
}

function dayMs(project: ProjectModel): number {
  const hours = (project as ProjectModel & { hoursPerDay?: number }).hoursPerDay;
  return (typeof hours === 'number' && hours > 0 ? hours : 24) * HOUR_MS;
}

const isDate = (value: unknown): value is Date => value instanceof Date && !Number.isNaN(value.getTime());

/** Exclusive end for an inclusive last day: the 00:00 after it. */
const dayAfter = (date: Date): Date => DateHelper.add(DateHelper.clearTime(date), 1, 'day');

/**
 * The popup's working copy of a task's schedule. Changing one value recomputes the others the way
 * the engine will: a new start keeps the length, new days move the finish, a new finish changes
 * the days. Pure date math over the task's own calendar; nothing touches the record.
 */
export class ScheduleDraft {
  start: Date;
  lastDay: Date;
  days: number;
  progress: number;
  /** The person set the finish, rather than it following from the start or the length. */
  finishSet = false;

  constructor(
    private readonly calendar: WorkingCalendar | null,
    private readonly msPerDay: number,
    task: TaskModel,
  ) {
    this.start = isDate(task.startDate) ? task.startDate : planClock.now();
    this.lastDay = lastWorkingDay(task);
    this.days = typeof task.duration === 'number' ? task.duration : 0;
    this.progress = Math.round(task.percentDone ?? 0);
  }

  setStart(start: Date): void {
    this.start = this.firstWorkingTime(start);
    this.lastDay = this.lastDayFor(this.start, this.days);
  }

  setDays(days: number): void {
    this.days = Math.max(0, days);
    this.lastDay = this.lastDayFor(this.start, this.days);
  }

  setLastDay(lastDay: Date): void {
    this.finishSet = true;
    const end = dayAfter(lastDay < this.start ? this.start : lastDay);
    this.lastDay = DateHelper.clearTime(lastDay < this.start ? this.start : lastDay);
    if (this.calendar) {
      this.days = Math.round((this.calendar.calculateDurationMs(this.start, end) / this.msPerDay) * 10) / 10;
    }
  }

  private firstWorkingTime(date: Date): Date {
    const skipped = this.calendar?.skipNonWorkingTime(date, true);
    return isDate(skipped) ? skipped : date;
  }

  private lastDayFor(start: Date, days: number): Date {
    if (days === 0) return DateHelper.clearTime(start);
    const end = this.calendar?.calculateEndDate(start, days * this.msPerDay);
    if (!isDate(end)) return DateHelper.add(start, Math.max(0, Math.ceil(days) - 1), 'day');
    const workEnd = this.calendar?.skipNonWorkingTime(end, false);
    return DateHelper.clearTime(new Date((isDate(workEnd) ? workEnd : end).getTime() - 1));
  }
}

/** The working copy of a task's schedule over its own calendar. */
export function scheduleDraftFor(project: ProjectModel, task: TaskModel): ScheduleDraft {
  const record = original(task);
  return new ScheduleDraft(calendarOf(record), dayMs(project), record);
}

/** A new wait (positive) or overlap (negative) for one link, in working days. */
/** The changes a schedule save makes, against the values the popup opened with. */
export interface ScheduleChange {
  start?: Date;
  /** Exclusive end; only when the finish (not the length) was what changed. */
  end?: Date;
  days?: number;
  progress?: number;
}

export function isEmptyScheduleChange(change: ScheduleChange): boolean {
  return (
    change.start === undefined &&
    change.end === undefined &&
    change.days === undefined &&
    change.progress === undefined
  );
}

/**
 * Writes a schedule change into the records. Call it inside a transaction (`runProjectTransaction`):
 * the engine then recalculates successors once and the change travels as one revision.
 */
export function writeScheduleChange(_project: ProjectModel, task: TaskModel, change: ScheduleChange): void {
  const record = original(task);
  if (change.start) void record.setStartDate(change.start, true);
  if (change.days !== undefined) void record.setDuration(change.days, record.durationUnit ?? 'day');
  else if (change.end) void record.setEndDate(change.end, false);
  if (change.progress !== undefined) record.percentDone = change.progress;
}

export function scheduleChanges(opened: ScheduleDraft | { start: Date; lastDay: Date; days: number; progress: number }, draft: ScheduleDraft): ScheduleChange {
  const change: ScheduleChange = {};
  if (draft.start.getTime() !== opened.start.getTime()) change.start = draft.start;
  if (draft.days !== opened.days) change.days = draft.days;
  // Only a finish the person set: one that merely followed a new start would go out as a date of its own,
  // which closes the gap in a split task and, redone over someone else's move, changes the task's length.
  else if (draft.finishSet && draft.lastDay.getTime() !== opened.lastDay.getTime()) change.end = dayAfter(draft.lastDay);
  if (draft.progress !== opened.progress) change.progress = draft.progress;
  return change;
}

/** Applies a schedule change (dates and progress together) as one transaction (one revision). */
export function applyScheduleChange(project: ProjectModel, task: TaskModel, change: ScheduleChange): Promise<void> {
  if (isEmptyScheduleChange(change)) return Promise.resolve();
  return runProjectTransaction(project, 'Edit schedule', () => writeScheduleChange(project, task, change));
}

// -----------------------------------------------------------------------------------------
// Link waits (the task panel's words) and the money line
// -----------------------------------------------------------------------------------------

/** `+2 days wait`, `1 day overlap`, `no wait`. */
export function waitText(days: number): string {
  const value = Math.round(days * 10) / 10;
  if (value === 0) return 'no wait';
  const amount = Math.abs(value);
  return value > 0 ? `+${amount} ${amount === 1 ? 'day' : 'days'} wait` : `${amount} ${amount === 1 ? 'day' : 'days'} overlap`;
}

/** A link's wait in working days (links made here are in days; other units are converted). */
export function lagInDays(project: ProjectModel, dependency: { lag?: number; lagUnit?: string }): number {
  const lag = typeof dependency.lag === 'number' && Number.isFinite(dependency.lag) ? dependency.lag : 0;
  const unit = (dependency.lagUnit ?? 'day').toLowerCase();
  const settings = project as ProjectModel & { hoursPerDay?: number; daysPerWeek?: number; daysPerMonth?: number };
  const hours = settings.hoursPerDay || 24;
  const days = unit.startsWith('w')
    ? lag * (settings.daysPerWeek || 5)
    : unit.startsWith('mo')
      ? lag * (settings.daysPerMonth || 20)
      : unit === 'mi' || unit.startsWith('min')
        ? lag / (hours * 60)
        : unit.startsWith('h')
          ? lag / hours
          : lag;
  return Math.round(days * 10) / 10;
}

/** What the schedule popup needs to show money: who may see it, in which currency, and the workflow's badges. */
export interface ScheduleEditorLook {
  canViewCosts: boolean;
  currency: CurrencyCode;
  decorations?: Decorations;
}

const esc = (value: unknown): string => StringHelper.encodeHtml(String(value ?? ''));

/** PayPal's "P" monogram (public/paypal). */
const PAYPAL_MARK = '/paypal/paypal-mark.svg';

/** The ui.css pill tone of each workflow tone. */
const PILL_TONES: Readonly<Record<TaskBadge['tone'], string>> = { ok: ' is-success', busy: ' is-info', warn: ' is-warning', alert: ' is-danger', neutral: '' };

/** A workflow badge as a pill; one about a PayPal payment carries PayPal's mark, and once paid, PayPal's colors. */
function badgeHtml(badge: TaskBadge): string {
  const paypal = badge.icon.includes('fa-paypal');
  const icon = paypal ? `<img class="paypal-mark" src="${PAYPAL_MARK}" alt="">` : `<i class="${esc(badge.icon)}"></i>`;
  return `<span class="pill${paypal && badge.tone === 'ok' ? ' is-paypal' : PILL_TONES[badge.tone]}">${icon}${esc(badge.text)}</span>`;
}

/**
 * One line of money for cost viewers: expected against budget, spent and paid (rolled up for a
 * phase), then what a fix and its PayPal payment say about the task, if there is one. No verdict
 * (over budget, idle rental): those come from the assistant or a watch rule someone added.
 */
export function moneyLineHtml(task: TaskModel, look: ScheduleEditorLook): string {
  const record = original(task);
  const money = rolledUpMoney(record);
  const { currency } = look;
  const decoration = look.decorations?.get(record.id as number);
  const badges = (decoration?.badges ?? []).map((badge) => badgeHtml(badge)).join('');
  return `<div class="look-editor-money-line"><i class="fa fa-sack-dollar"></i><span class="look-editor-money-main"><strong>${esc(wholeMoney(money.expected, currency))}</strong> expected of ${esc(
    wholeMoney(money.budget, currency),
  )}</span></div><div class="look-editor-money-sub"><span><i class="fa fa-receipt"></i>${esc(wholeMoney(money.spent, currency))} spent</span><span><img class="paypal-mark" src="${PAYPAL_MARK}" alt="">${esc(
    wholeMoney(money.paid, currency),
  )} paid</span></div>${badges ? `<div class="look-editor-money-badges">${badges}</div>` : ''}`;
}

export interface MoneyChange {
  budgetMinor?: number;
  forecastMinor?: number;
}

/** Applies a budget / expected change as one transaction (one revision). */
export function applyMoneyChange(project: ProjectModel, task: TaskModel, change: MoneyChange): Promise<void> {
  if (Object.keys(change).length === 0) return Promise.resolve();
  return runProjectTransaction(project, 'Edit costs', () => {
    task.set(change);
  });
}

// -----------------------------------------------------------------------------------------
// Popups
// -----------------------------------------------------------------------------------------

interface FieldLike {
  value: unknown;
  disabled?: boolean;
  /** Date fields: the earliest day that can be picked. */
  min?: Date;
  /** Text widgets. */
  html?: string;
}

interface PopupLike {
  widgetMap: Record<string, FieldLike>;
  close(): void;
  destroy(): void;
  isDestroyed?: boolean;
  focus?(): void;
}

let open: PopupLike | null = null;

function closeOpen(): void {
  if (open && !open.isDestroyed) open.destroy();
  open = null;
}

export interface CellEditorTarget {
  project: ProjectModel;
  task: TaskModel;
  /** The cell the popup points at. */
  element: HTMLElement;
  /** Called after the popup closes (saved or not), e.g. to give the cell its focus back. */
  onClose?: () => void;
  /** Reports a failed save. */
  onError?: (message: string) => void;
  /** Opens the task in the side panel's task tab (offered as "Open in task panel"). */
  onOpenInPanel?: () => void;
}

function header(task: TaskModel, subtitle: string): string {
  return `<span class="look-editor-title">${StringHelper.encodeHtml(String(task.name ?? ''))}</span><span class="look-editor-subtitle">${subtitle}</span>`;
}

/** The most links the popup lists; the task panel shows them all. */

/**
 * Opens the schedule editor for a task's Schedule cell: dates, working days and progress, and (cost
 * viewers) a line of money and payment state. Links are edited on the chart and in the task panel.
 */
export function openScheduleEditor({ project, task: shown, element, onClose, onError, onOpenInPanel }: CellEditorTarget, look?: ScheduleEditorLook): void {
  closeOpen();
  const task = original(shown);
  const draft = scheduleDraftFor(project, task);
  const opened = { start: draft.start, lastDay: draft.lastDay, days: draft.days, progress: draft.progress };
  // Phase dates and progress follow the tasks inside them; the engine recalculates them.
  const derived = !task.isLeaf;
  const milestone = task.isMilestone;

  let syncing = false;
  let popupRef: PopupLike | null = null;
  const map = () => popupRef?.widgetMap ?? {};
  const sync = () => {
    syncing = true;
    const fields = map();
    if (fields.start) fields.start.value = draft.start;
    if (fields.lastDay) fields.lastDay.value = draft.lastDay;
    if (fields.days) fields.days.value = draft.days;
    syncing = false;
  };
  // Live: one field changes, the other two follow (typed or picked; Bryntum fires input while typing).
  const follow = (field: 'start' | 'lastDay' | 'days', value: unknown) => {
    if (syncing) return;
    if (field === 'days' && typeof value === 'number' && Number.isFinite(value)) draft.setDays(value);
    else if (field === 'start' && isDate(value)) draft.setStart(value);
    else if (field === 'lastDay' && isDate(value)) draft.setLastDay(value);
    else return;
    sync();
  };

  // Save reads the fields themselves, so a value typed but not yet committed (no blur) still counts.
  const save = async () => {
    const fields = map();
    const start = fields.start?.value;
    const lastDay = fields.lastDay?.value;
    const days = fields.days?.value;
    const progress = fields.progress?.value;
    if (!derived) {
      if (isDate(start) && start.getTime() !== draft.start.getTime()) draft.setStart(start);
      if (typeof days === 'number' && Number.isFinite(days) && days !== draft.days) draft.setDays(days);
      else if (isDate(lastDay) && DateHelper.clearTime(lastDay).getTime() !== draft.lastDay.getTime()) draft.setLastDay(lastDay);
      if (typeof progress === 'number' && Number.isFinite(progress)) draft.progress = Math.round(progress);
    }
    const change: ScheduleChange = derived ? {} : scheduleChanges(opened, draft);
    closeOpen();
    try {
      await applyScheduleChange(project, task, change);
    } catch (error) {
      onError?.(error instanceof Error ? error.message : String(error));
    }
  };

  const popup = new Popup({
    forElement: element,
    align: { align: 't-b', offset: 6 },
    cls: 'look-editor look-schedule-editor',
    title: header(task, derived ? 'Phase dates follow the tasks inside it' : milestone ? 'Milestone date' : 'Schedule'),
    width: 380,
    modal: false,
    autoShow: true,
    autoClose: true,
    closable: true,
    trapFocus: true,
    focusOnToFront: true,
    defaults: { labelPosition: 'above' },
    items: {
      start: {
        type: 'datefield',
        label: milestone ? 'Date' : 'Starts',
        format: EDIT_DATE_FORMAT,
        value: draft.start,
        disabled: derived,
        cls: 'look-editor-start',
        onChange: ({ value }: { value: unknown }) => follow('start', value),
      },
      lastDay: {
        type: 'datefield',
        label: 'Last working day',
        format: EDIT_DATE_FORMAT,
        value: draft.lastDay,
        disabled: derived || milestone,
        hidden: milestone,
        onChange: ({ value }: { value: unknown }) => follow('lastDay', value),
      },
      days: {
        type: 'numberfield',
        label: 'Working days',
        min: 0,
        step: 1,
        format: '0.#',
        value: draft.days,
        disabled: derived || milestone,
        hidden: milestone,
        onInput: ({ value }: { value: unknown }) => follow('days', value),
        onChange: ({ value }: { value: unknown }) => follow('days', value),
      },
      progress: {
        type: 'slider',
        label: 'Progress',
        min: 0,
        max: 100,
        step: 5,
        unit: '%',
        showValue: true,
        showTooltip: false,
        value: draft.progress,
        disabled: derived,
        hidden: milestone,
        cls: 'look-editor-progress',
        onInput: ({ value }: { value: number }) => {
          draft.progress = Math.round(value);
        },
      },
      money: {
        type: 'widget',
        cls: 'look-editor-money',
        hidden: !look?.canViewCosts,
        html: look?.canViewCosts ? moneyLineHtml(task, look) : '',
      },
      note: {
        type: 'widget',
        cls: 'look-editor-footnote',
        html: derived ? 'Edit the tasks inside to move it.' : 'Saved for everyone at once.',
      },
    },
    bbar: {
      items: {
        openPanel: {
          type: 'button',
          text: 'Open in task panel',
          icon: 'fa fa-table-columns',
          rendition: 'text',
          cls: 'look-editor-open-panel',
          hidden: !onOpenInPanel,
          onClick: () => {
            closeOpen();
            onOpenInPanel?.();
          },
        },
        hint: { type: 'widget', cls: 'look-editor-hint', html: '' },
        cancel: { type: 'button', text: 'Cancel', rendition: 'text', onClick: () => closeOpen() },
        save: { type: 'button', text: 'Save', rendition: 'filled', disabled: derived, onClick: () => void save() },
      },
    },
    keyMap: {
      Enter: () => {
        if (!derived) void save();
      },
      Escape: () => closeOpen(),
    },
    listeners: {
      destroy: () => {
        if (open === (popup as unknown as PopupLike)) open = null;
        onClose?.();
      },
      hide: () => closeOpen(),
    },
  } as unknown as ConstructorParameters<typeof Popup>[0]);
  open = popupRef = popup as unknown as PopupLike;
}

/** Opens the money editor for a task's Budget · Forecast cell (cost viewers, leaf tasks). */
export function openMoneyEditor({ project, task: shown, element, onClose, onError }: CellEditorTarget, currency: CurrencyCode): void {
  closeOpen();
  const task = original(shown) as TaskModel & { budgetMinor?: number; forecastMinor?: number; incurredMinor?: number; paidMinor?: number };
  const opened = { budgetMinor: task.budgetMinor ?? 0, forecastMinor: task.forecastMinor ?? 0 };
  const toMinor = (value: unknown, fallback: number) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value * 100) : fallback);
  const draft = { ...opened };

  let popupRef: PopupLike | null = null;
  const save = async () => {
    const fields = popupRef?.widgetMap ?? {};
    draft.budgetMinor = toMinor(fields.budget?.value, draft.budgetMinor);
    draft.forecastMinor = toMinor(fields.expected?.value, draft.forecastMinor);
    const change: MoneyChange = {};
    if (draft.budgetMinor !== opened.budgetMinor) change.budgetMinor = draft.budgetMinor;
    if (draft.forecastMinor !== opened.forecastMinor) change.forecastMinor = draft.forecastMinor;
    closeOpen();
    try {
      await applyMoneyChange(project, task, change);
    } catch (error) {
      onError?.(error instanceof Error ? error.message : String(error));
    }
  };

  const popup = new Popup({
    forElement: element,
    align: { align: 't-b', offset: 6 },
    cls: 'look-editor',
    title: header(task, 'Costs'),
    width: 340,
    autoShow: true,
    autoClose: true,
    closable: true,
    trapFocus: true,
    defaults: { labelPosition: 'above' },
    items: {
      budget: {
        type: 'numberfield',
        label: `Budget (${currency})`,
        min: 0,
        step: 100,
        format: { minimumFractionDigits: 0, maximumFractionDigits: 2 },
        value: opened.budgetMinor / 100,
        onChange: ({ value }: { value: number | null }) => {
          draft.budgetMinor = toMinor(value, draft.budgetMinor);
        },
      },
      expected: {
        type: 'numberfield',
        label: `Forecast (${currency})`,
        min: 0,
        step: 100,
        format: { minimumFractionDigits: 0, maximumFractionDigits: 2 },
        value: opened.forecastMinor / 100,
        onChange: ({ value }: { value: number | null }) => {
          draft.forecastMinor = toMinor(value, draft.forecastMinor);
        },
      },
      actuals: {
        type: 'widget',
        cls: 'look-editor-actuals',
        html: `<span><i class="fa fa-receipt"></i>${wholeMoney(task.incurredMinor ?? 0, currency)} spent</span><span><i class="fa-brands fa-paypal"></i>${wholeMoney(task.paidMinor ?? 0, currency)} paid</span>`,
      },
    },
    bbar: {
      items: {
        hint: { type: 'widget', cls: 'look-editor-hint', html: 'Spent and paid come from the work and from PayPal.' },
        cancel: { type: 'button', text: 'Cancel', rendition: 'text', onClick: () => closeOpen() },
        save: { type: 'button', text: 'Save', rendition: 'filled', onClick: () => void save() },
      },
    },
    keyMap: {
      Enter: () => void save(),
      Escape: () => closeOpen(),
    },
    listeners: {
      destroy: () => {
        if (open === (popup as unknown as PopupLike)) open = null;
        onClose?.();
      },
      hide: () => closeOpen(),
    },
  } as unknown as ConstructorParameters<typeof Popup>[0]);
  open = popupRef = popup as unknown as PopupLike;
}

/**
 * What a rental popup's fields ask for against the rental as it opened: only the dates that changed, so
 * a date someone else changes meanwhile is kept, or the problem to show. The end date is the last day
 * on rent, as the cell shows it; the booking's end is the day after.
 */
export function rentalDatesChange(rental: Pick<RentalEdit, 'start' | 'end'>, start: unknown, lastDay: unknown): RentalDates | string {
  if (!isDate(start) || !isDate(lastDay)) return 'Choose a start date and an end date.';
  const first = toDateOnly(start);
  const last = toDateOnly(lastDay);
  if (last < first) return 'The end date cannot be before the start date.';
  const change: RentalDates = {};
  if (first !== rental.start) change.rentalStart = first;
  if (addDays(last, 1) !== rental.end) change.rentalEnd = addDays(last, 1);
  return change;
}

/** New dates on a machine, inside a change already under way. What the days come to goes on its task's forecast, or comes off it. */
export function setRentalDates(assignment: AssignmentModel, dates: { start: DateOnly; end: DateOnly }, was: { start: DateOnly; end: DateOnly }, rateMinor: number | null): void {
  assignment.set({ rentalStart: dates.start, rentalEnd: dates.end });
  const task = assignment.event as (TaskModel & { forecastMinor?: number | null }) | null;
  const forecast = task?.forecastMinor;
  if (!task || rateMinor === null || typeof forecast !== 'number') return;
  const moreDays = rentalDays(dates.start, dates.end) - rentalDays(was.start, was.end);
  if (moreDays !== 0) task.set('forecastMinor', Math.max(0, forecast + moreDays * rateMinor));
}

/**
 * Puts new dates on the machine on this task as one change (one revision, one step of undo). Both dates
 * go on, so a machine that was going by the task's days keeps these when the task moves.
 */
export function applyRentalDates(project: ProjectModel, rental: Pick<RentalEdit, 'assignmentId' | 'equipment' | 'start' | 'end'> & { rateMinor?: number | null }, dates: RentalDates): Promise<void> {
  const assignment = project.assignmentStore.getById(rental.assignmentId) as AssignmentModel | undefined;
  if (!assignment || Object.keys(dates).length === 0) return Promise.resolve();
  return runProjectTransaction(project, `Change ${rental.equipment} dates`, () => {
    const current = assignment as AssignmentModel & { rentalStart?: DateOnly | null; rentalEnd?: DateOnly | null };
    const was = { start: current.rentalStart ?? rental.start, end: current.rentalEnd ?? rental.end };
    setRentalDates(assignment, { start: dates.rentalStart ?? was.start, end: dates.rentalEnd ?? was.end }, was, rental.rateMinor ?? null);
  });
}

/** What the dates in a rental popup come to: every day on rent, the cost for cost viewers, and when the work is. */
export function rentalFactsHtml(rental: RentalEdit, start: DateOnly, end: DateOnly): string {
  const days = rental.rentalDays(start, end);
  const cost = rental.rateMinor === null ? '' : `<span><i class="fa fa-sack-dollar"></i>${esc(wholeMoney(rental.rateMinor * days, rental.currency))}</span>`;
  const work = dayRange(parseDateOnly(rental.taskStart), parseDateOnly(addDays(rental.taskEnd, -1)));
  return `<div class="look-editor-money-line"><i class="fa fa-calendar-days"></i><span class="look-editor-money-main"><strong>${days} ${rental.bookingId === null ? '' : 'rental '}${days === 1 ? 'day' : 'days'}</strong> end date included</span></div><div class="look-editor-money-sub">${cost}<span><i class="fa fa-list-check"></i>${esc(rental.taskName)}: ${esc(work)}</span></div>`;
}

/** What changing a machine's dates means here: why it can't happen, or what happens to the rental. */
export function rentalNote(rental: Pick<RentalEdit, 'locked' | 'bookingId'>): string {
  if (rental.locked) return rental.locked;
  if (rental.bookingId === null) return 'Nothing is paid for these dates until a rental is booked. Other tasks keep their own dates.';
  return 'Tasks keep their dates, and other tasks using this machine keep theirs. Saved for everyone at once.';
}

/** Takes a machine off a task as one change; its rental and its other tasks stay as they are. */
export function removeEquipment(project: ProjectModel, task: TaskModel, resourceId: number): Promise<void> {
  const isMachine = (assignment: AssignmentModel) => (assignment.resource as ResourceModel | null)?.id === resourceId;
  const assignments = ((original(task).assignments ?? []) as AssignmentModel[]).filter(isMachine);
  if (assignments.length === 0) return Promise.resolve();
  return runProjectTransaction(project, 'Remove equipment', () => {
    project.assignmentStore.remove(assignments as never);
  });
}

/**
 * Opens the editor for a task's Equipment cell: when the machine is on site for this task, and a way
 * to take it off the task.
 */
export function openRentalEditor({ project, task, element, onClose, onError }: CellEditorTarget, rental: RentalEdit): void {
  closeOpen();
  const booked = rental.bookingId !== null;
  const locked = rental.locked !== null;
  let popupRef: PopupLike | null = null;
  const map = () => popupRef?.widgetMap ?? {};
  const problem = (text: string) => `<div class="look-editor-problem" role="alert"><i class="fa fa-circle-exclamation"></i> ${esc(text)}</div>`;

  // Live: the facts follow the fields, and an end before the start moves up with it.
  const refresh = () => {
    const fields = map();
    if (!fields.facts || !fields.save) return;
    const asked = rentalDatesChange(rental, fields.start?.value, fields.lastDay?.value);
    fields.save.disabled = locked || typeof asked === 'string';
    fields.facts.html =
      typeof asked === 'string'
        ? problem(asked)
        : rentalFactsHtml(rental, asked.rentalStart ?? rental.start, asked.rentalEnd ?? rental.end);
  };
  const startChanged = (value: unknown) => {
    const end = map().lastDay;
    if (isDate(value) && end) {
      end.min = value;
      if (isDate(end.value) && end.value < value) end.value = value;
    }
    refresh();
  };

  const save = () => {
    const fields = map();
    if (locked) return;
    const asked = rentalDatesChange(rental, fields.start?.value, fields.lastDay?.value);
    if (typeof asked === 'string') {
      refresh();
      return;
    }
    closeOpen();
    applyRentalDates(project, rental, asked).catch((error: unknown) => onError?.(error instanceof Error ? error.message : String(error)));
  };

  const popup = new Popup({
    forElement: element,
    align: { align: 't-b', offset: 6 },
    cls: 'look-editor look-rental-editor',
    title: `<span class="look-editor-title">${esc(rental.equipment)}</span><span class="look-editor-subtitle">${booked ? `Rental from ${esc(rental.supplier)}` : 'No rental booked for this task'}</span>`,
    width: 380,
    modal: false,
    autoShow: true,
    autoClose: true,
    closable: true,
    trapFocus: true,
    focusOnToFront: true,
    defaults: { labelPosition: 'above' },
    items: {
      start: {
        type: 'datefield',
        label: 'Start date',
        format: EDIT_DATE_FORMAT,
        value: parseDateOnly(rental.start),
        disabled: locked,
        onChange: ({ value }: { value: unknown }) => startChanged(value),
      },
      lastDay: {
        type: 'datefield',
        label: 'End date',
        format: EDIT_DATE_FORMAT,
        value: parseDateOnly(addDays(rental.end, -1)),
        min: parseDateOnly(rental.start),
        disabled: locked,
        onChange: () => refresh(),
      },
      facts: {
        type: 'widget',
        cls: 'look-editor-money',
        html: rentalFactsHtml(rental, rental.start, rental.end),
      },
      note: {
        type: 'widget',
        cls: 'look-editor-footnote',
        html: esc(rentalNote(rental)),
      },
    },
    bbar: {
      items: {
        remove: {
          type: 'button',
          text: 'Remove from task',
          icon: 'fa fa-xmark',
          rendition: 'text',
          cls: 'look-editor-open-panel',
          disabled: rental.locked !== null,
          onClick: () => {
            closeOpen();
            removeEquipment(project, task, rental.resourceId).catch((error: unknown) => onError?.(error instanceof Error ? error.message : String(error)));
          },
        },
        hint: { type: 'widget', cls: 'look-editor-hint', html: '' },
        cancel: { type: 'button', text: 'Cancel', rendition: 'text', onClick: () => closeOpen() },
        save: { type: 'button', text: 'Save', rendition: 'filled', disabled: locked, onClick: () => save() },
      },
    },
    keyMap: {
      Enter: () => save(),
      Escape: () => closeOpen(),
    },
    listeners: {
      destroy: () => {
        if (open === (popup as unknown as PopupLike)) open = null;
        onClose?.();
      },
      hide: () => closeOpen(),
    },
  } as unknown as ConstructorParameters<typeof Popup>[0]);
  open = popupRef = popup as unknown as PopupLike;
}

/** Closes whichever cell editor is open (e.g. when the Gantt unmounts). */
export function closeCellEditor(): void {
  closeOpen();
}
