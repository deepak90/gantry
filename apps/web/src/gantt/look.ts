/**
 * How tasks look on the Gantt: phase colors, crew icons, plain-language status buckets and the
 * renderers that draw them on bars, labels, grid cells and group rows. Pure presentation: nothing
 * here writes to a record, so styling never produces a revision.
 *
 * Renderers read a mutable `LookState` instead of closing over React props, because Bryntum keeps
 * the functions it was configured with; the workspace updates the state and refreshes the rows.
 */
import { DateHelper, StringHelper } from '@bryntum/gantt';
import type { AssignmentModel, DependencyModel, DomConfig, ResourceModel, TaskModel } from '@bryntum/gantt';
import type { CurrencyCode } from '@collab/shared';
import { holdClasses, isBeingReleased } from './hold-look';
import { safeColor } from './model/safe-fields';
import { gateFor, gateIndex, heldBy, paymentOf, scheduledPayDay, type Gate } from './pay-gates';
import { isPaymentLocked } from './payment-lock';

// -----------------------------------------------------------------------------------------
// Decorations: what the workflow knows about a task, drawn on its bar
// -----------------------------------------------------------------------------------------

export type Tone = 'ok' | 'busy' | 'warn' | 'alert' | 'neutral';

/** A one-line pill: where the fix stands, for places too small for the tracker (the cost editor). */
export interface TaskBadge {
  text: string;
  tone: Tone;
  /** FontAwesome class names, e.g. `fa fa-check`. */
  icon: string;
}

/** Equipment booked (and paid for) with no work planned for it, before its task or after it. */
export interface IdleSpan {
  /** The rental's first day, `YYYY-MM-DD`. */
  start: string;
  /** The day after the rental's last. */
  end: string;
  days: number;
  /** What the idle days cost; null when the viewer may not see money. */
  costMinor: number | null;
  equipment: string;
}

/** The steps a fix goes through, in order (the approval chain, workflow/chain.ts). */
export type TrackerStepKey = 'proposed' | 'approved' | 'plan' | 'paid' | 'receipt';

/**
 * Where one step stands. `attention` asks a person to act again (the fix changed after it was
 * checked or approved); `skipped` is a step the dropped fix never reached.
 */
export type TrackerStepState = 'done' | 'current' | 'todo' | 'attention' | 'failed' | 'skipped';

export type TrackerTone = Tone;

export interface TrackerStep {
  key: TrackerStepKey;
  /** The step's name: "Checked". */
  label: string;
  /** What is happening at this step, in a few words: "1 of 2 approved", "PayPal is processing". */
  status: string;
  state: TrackerStepState;
  /** FontAwesome class names, e.g. `fa fa-lightbulb`. */
  icon: string;
  /** Payment steps are drawn in PayPal blue. */
  paypal: boolean;
  who: string | null;
  /** ISO timestamp of the step's last event. */
  at: string | null;
  /** One more line for the fix panel (money only for viewers who may see it). */
  detail: string | null;
}

/** A fix and its payment, step by step. The bar shows only the payment (`stepOnBar`). */
export interface Tracker {
  steps: TrackerStep[];
  /** The step to look at: a failure, else the first step under way or waiting for someone. */
  focus: TrackerStepKey;
  /** One sentence for the step in focus. */
  headline: string;
  tone: TrackerTone;
  complete: boolean;
  dropped: boolean;
  /** Money is moving at PayPal (authorized, sent, processing or being checked). */
  paying: boolean;
  /** The supplier payment; null when the viewer may not see money or nothing is priced yet. */
  amountMinor: number | null;
  feeMinor: number | null;
  currency: CurrencyCode;
}

/** When a machine is on site for a task: facts only, drawn around the bar. */
export interface RentalSpan {
  /** Inclusive calendar date, `YYYY-MM-DD`. */
  start: string;
  /** Exclusive calendar date. */
  end: string;
  equipment: string;
  supplier: string;
  /** False while no rental is booked for the machine on this task: the dates then pay nobody. */
  booked: boolean;
}

export interface TaskDecoration {
  rental?: RentalSpan | null;
  idle: IdleSpan | null;
  /** What a day of its booked machine costs; absent when nothing is booked or the viewer may not see money. */
  rentalRateMinor?: number;
  /** The fix and payment of the task's rented equipment; null when nothing is proposed. */
  tracker: Tracker | null;
  /** The tracker's step in focus as one pill (empty without a tracker). */
  badges: TaskBadge[];
}

export type Decorations = ReadonlyMap<number, TaskDecoration>;

export const NO_DECORATIONS: Decorations = new Map();

// -----------------------------------------------------------------------------------------
// View state shared with the renderers
// -----------------------------------------------------------------------------------------

export type GroupBy = 'phase' | 'crew' | 'status' | 'budget';
export type QuickFilter = 'all' | 'active' | 'attention';
/** What the bar color says: which phase a task belongs to, or which crew does it. */
export type ColorBy = 'phase' | 'crew';

export interface LookState {
  decorations: Decorations;
  canViewCosts: boolean;
  /** A money column is shown: the bars also carry the expected cost beside them. */
  moneyColumns: boolean;
  currency: CurrencyCode;
  groupBy: GroupBy;
  colorBy: ColorBy;
}

// -----------------------------------------------------------------------------------------
// Task facts
// -----------------------------------------------------------------------------------------

/** Grouping shows linked copies of the tasks; every fact is read from the original record. */
export function original(task: TaskModel): TaskModel {
  return ((task as TaskModel & { $original?: TaskModel }).$original ?? task) as TaskModel;
}

/**
 * Whether the scheduling engine is in the middle of a commit. It works in steps and yields to the
 * browser between them, so a render can land in the gap. Slack and "critical" are worked out only
 * when read: read in that gap, the engine finds them half calculated, takes that for a cycle, and its
 * search for the cycle does not end, which freezes the tab. Check this before reading them from a render.
 */
export function engineCommitting(project: object | null | undefined): boolean {
  return (project as { replica?: { isCommitting?: boolean } } | null | undefined)?.replica?.isCommitting === true;
}

/** Whether a task sets the end date; false while the engine is committing (the bar is redrawn when it is done). */
export function isCritical(task: TaskModel): boolean {
  const record = original(task);
  return !engineCommitting(record.project) && (record as TaskModel & { critical?: boolean }).critical === true;
}

function numberField(task: TaskModel, field: string): number {
  const value = (original(task) as unknown as Record<string, unknown>)[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export interface TaskMoney {
  budget: number;
  expected: number;
  spent: number;
  paid: number;
}

export function taskMoney(task: TaskModel): TaskMoney {
  return {
    budget: numberField(task, 'budgetMinor'),
    expected: numberField(task, 'forecastMinor'),
    spent: numberField(task, 'incurredMinor'),
    paid: numberField(task, 'paidMinor'),
  };
}

interface TreeNodeLike {
  parent?: TreeNodeLike | null;
  isRoot?: boolean;
  isLeaf?: boolean;
  children?: TreeNodeLike[] | boolean | null;
}

/** Index of the task's top-level phase among the project's phases, -1 for a top-level leaf. */
export function phaseIndex(task: TaskModel): number {
  let node = original(task) as unknown as TreeNodeLike;
  while (node.parent && !node.parent.isRoot) {
    node = node.parent;
  }
  const siblings = node.parent?.children;
  return node.isLeaf || !Array.isArray(siblings) ? -1 : siblings.indexOf(node);
}

export const PHASE_COUNT = 6;

export function phaseClass(task: TaskModel): string {
  const index = phaseIndex(task);
  return index < 0 ? 'look-phase-none' : `look-phase-${index % PHASE_COUNT}`;
}

export function crewOf(task: TaskModel): ResourceModel[] {
  return (original(task).resources ?? []) as ResourceModel[];
}

const isEquipment = (resource: ResourceModel) => (resource as ResourceModel & { kind?: string }).kind === 'equipment';

/** The people on a task (crews), without its rented equipment. */
export function laborOf(task: TaskModel): ResourceModel[] {
  return crewOf(task).filter((resource) => !isEquipment(resource));
}

/** How many people a crew of this trade usually has on a job: what a task counts until it says otherwise. */
const USUAL_CREW: readonly [RegExp, number][] = [
  [/general/i, 4],
  [/ground/i, 5],
  [/concrete/i, 6],
  [/steel/i, 6],
  [/roof/i, 5],
  [/wall|envelope/i, 4],
  [/mechanical|electric|plumb|hvac/i, 4],
  [/interior|drywall|paint|carpent/i, 5],
  [/commission|inspect/i, 2],
];

export const usualCrewSize = (trade: string | undefined): number => USUAL_CREW.find(([pattern]) => pattern.test(trade ?? ''))?.[1] ?? 4;

/** How many people this crew has on this task, and whether the plan said so or that is the usual size. */
export function crewSizeOn(task: TaskModel, crew: ResourceModel): { people: number; usual: boolean } {
  const assignment = ((original(task).assignments ?? []) as (AssignmentModel & { headcount?: number | null })[]).find((item) => item.resource === crew);
  const said = assignment?.headcount;
  if (typeof said === 'number' && said > 0) return { people: said, usual: false };
  return { people: usualCrewSize((crew as ResourceModel & { trade?: string }).trade), usual: true };
}

/** The rented equipment on a task (a crane, a concrete pump). */
export function equipmentOf(task: TaskModel): ResourceModel[] {
  return crewOf(task).filter(isEquipment);
}

const CREW_ICONS: [RegExp, string][] = [
  [/crane/i, 'weight-hanging'],
  [/electric/i, 'bolt'],
  [/plumb/i, 'faucet-drip'],
  [/steel/i, 'industry'],
  [/carpent|paint|decor/i, 'paint-roller'],
  [/test|commission|inspect/i, 'clipboard-check'],
  [/vent|air|mechan|hvac/i, 'fan'],
];

/** The crew's own icon (`iconCls`, e.g. `fa fa-bolt` → `bolt`), else one guessed from its name. */
export function crewIcon(resource: ResourceModel): string {
  const own = /\bfa-([a-z0-9-]+)/.exec(resource.iconCls ?? '')?.[1];
  if (own) return own;
  const name = resource.name ?? '';
  return CREW_ICONS.find(([pattern]) => pattern.test(name))?.[1] ?? 'helmet-safety';
}

/** Fallback colors for crews without their own, picked by id so every client agrees (muted, no reds). */
const CREW_FALLBACK_COLORS = ['#446b9c', '#1d777b', '#51744a', '#775386', '#585399', '#327892', '#607c42', '#515f6e'];

/** The crew's color (`eventColor`, which Bryntum's avatars and histogram also use), when it is a color at all. */
export function crewColor(resource: ResourceModel): string {
  // It goes into style attributes and canvas paint: only `#rgb`, `#rrggbb` or a Bryntum color name (safe-fields.ts).
  const own = safeColor(resource.eventColor);
  if (own) return own;
  const id = typeof resource.id === 'number' ? resource.id : String(resource.id ?? '').length;
  return CREW_FALLBACK_COLORS[Math.abs(id) % CREW_FALLBACK_COLORS.length] ?? '#515f6e';
}

/** The crew that leads a task: equipment first (it sets the cost story), then the first crew. */
export function leadCrew(task: TaskModel): ResourceModel | undefined {
  const crew = crewOf(task);
  return crew.find((resource) => (resource as ResourceModel & { kind?: string }).kind === 'equipment') ?? crew[0];
}

/** The icon for a task: its lead crew's (equipment first), else something from its name. */
export function taskIcon(task: TaskModel): string {
  const lead = leadCrew(task);
  if (lead) return crewIcon(lead);
  if (task.isMilestone) return gateFor(task.project, task) ? 'money-check-dollar' : 'flag-checkered';
  if (/concrete|set|cur/i.test(task.name ?? '')) return 'hourglass-half';
  if (/inspect|check/i.test(task.name ?? '')) return 'clipboard-check';
  return 'list-check';
}

export type StatusKey = 'done' | 'active' | 'todo';

export const STATUS_LABELS: Readonly<Record<StatusKey, string>> = {
  done: 'Done',
  active: 'In progress',
  todo: 'Not started',
};

export function statusOf(task: TaskModel): StatusKey {
  const done = original(task).percentDone ?? 0;
  return done >= 100 ? 'done' : done > 0 ? 'active' : 'todo';
}

export type BudgetKey = 'over' | 'on' | 'under';

export const BUDGET_LABELS: Readonly<Record<BudgetKey, string>> = {
  over: 'Over budget',
  on: 'On budget',
  under: 'Under budget',
};

export function budgetOf(task: TaskModel): BudgetKey {
  const { budget, expected } = taskMoney(task);
  return expected > budget ? 'over' : expected < budget ? 'under' : 'on';
}

const DAY_MS = 86_400_000;

/** Whole days the task now finishes after its planned (baseline) finish; 0 when on plan or early. */
export function slipDays(task: TaskModel): number {
  const record = original(task) as TaskModel & { baselines?: { first?: { endDate?: Date } } };
  const planned = record.baselines?.first?.endDate;
  const end = record.endDate;
  if (!(planned instanceof Date) || !(end instanceof Date)) return 0;
  return Math.max(0, Math.round((end.getTime() - planned.getTime()) / DAY_MS));
}

/**
 * The last working day a task occupies. Bryntum end dates are exclusive (a Mon–Wed task ends on
 * Thursday 00:00), and the day before can be a weekend, so the task's own calendar is asked.
 */
export function lastWorkingDay(task: TaskModel): Date {
  const record = original(task);
  const end = record.endDate;
  const start = record.startDate;
  if (!(end instanceof Date)) return start instanceof Date ? start : new Date(NaN);
  if (record.isMilestone || !(start instanceof Date) || end.getTime() <= start.getTime()) return end;
  const calendar = (record as TaskModel & { effectiveCalendar?: { skipNonWorkingTime?(date: Date, forward: boolean): unknown } }).effectiveCalendar;
  const skipped = calendar?.skipNonWorkingTime?.(end, false);
  const workEnd = skipped instanceof Date && skipped.getTime() > start.getTime() ? skipped : end;
  return DateHelper.clearTime(new Date(workEnd.getTime() - 1));
}

/**
 * Late against the plan, or a fix waiting on people. The plan does not judge itself beyond that
 * when it opens: idle rental and budget questions come from the assistant or a rule someone made.
 */
export function needsAttention(task: TaskModel, state: LookState): boolean {
  if (statusOf(task) === 'done') return false;
  if (slipDays(task) > 0) return true;
  const decoration = state.decorations.get(original(task).id as number);
  return Boolean(decoration?.tracker && !decoration.tracker.complete && !decoration.tracker.dropped);
}

// -----------------------------------------------------------------------------------------
// Money text
// -----------------------------------------------------------------------------------------

const wholeFormatters = new Map<string, Intl.NumberFormat>();
const compactFormatters = new Map<string, Intl.NumberFormat>();

/** `9840000` → `$98,400`. */
export function wholeMoney(minor: number, currency: CurrencyCode): string {
  let formatter = wholeFormatters.get(currency);
  if (!formatter) {
    formatter = new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 });
    wholeFormatters.set(currency, formatter);
  }
  return formatter.format(minor / 100);
}

/** `9840000` → `$98.4K`. */
export function compactMoney(minor: number, currency: CurrencyCode): string {
  let formatter = compactFormatters.get(currency);
  if (!formatter) {
    formatter = new Intl.NumberFormat('en-US', { style: 'currency', currency, notation: 'compact', maximumFractionDigits: 1 });
    compactFormatters.set(currency, formatter);
  }
  return formatter.format(minor / 100);
}

// -----------------------------------------------------------------------------------------
// DomConfig helpers
// -----------------------------------------------------------------------------------------

/** Drops the optional parts of a DomConfig child list. */
export const compact = (children: (DomConfig | null | false | undefined)[]): DomConfig[] =>
  children.filter((child): child is DomConfig => Boolean(child));

const icon = (name: string, extra = ''): DomConfig => ({ tag: 'i', className: `fa fa-${name}${extra ? ` ${extra}` : ''}` });

const span = (className: string, text: string, children?: DomConfig[]): DomConfig =>
  children ? { tag: 'span', className, children: [...children, { tag: 'span', text }] } : { tag: 'span', className, text };

// -----------------------------------------------------------------------------------------
// Bar language: what a bar's shape, fill, edge and motion say (docs/design/bar-language.md)
// -----------------------------------------------------------------------------------------

/** Inspections, hold points, tests and sign-offs: work that has to pass before the next can start. */
const CHECKPOINT = /hold point|inspect|acceptance|certif|\btest(s|ing)?\b|sign[- ]?off/i;

export function isCheckpoint(task: TaskModel): boolean {
  return CHECKPOINT.test(original(task).name ?? '');
}

/** The task books rented equipment (a crane, a concrete pump). */
export function usesEquipment(task: TaskModel): boolean {
  return equipmentOf(task).length > 0;
}

/** Share of the bar (0–1) that lies after its planned finish: the slipped tail. */
export function slipShare(task: TaskModel): number {
  const record = original(task) as TaskModel & { baselines?: { first?: { endDate?: Date } } };
  const planned = record.baselines?.first?.endDate;
  const { startDate: start, endDate: end } = record;
  if (!(planned instanceof Date) || !(start instanceof Date) || !(end instanceof Date) || slipDays(record) <= 0) return 0;
  const length = end.getTime() - start.getTime();
  return length <= 0 ? 0 : Math.min(1, Math.max(0, (end.getTime() - planned.getTime()) / length));
}

interface BaselineLike {
  startDate?: unknown;
  endDate?: unknown;
}

const sameTime = (a: unknown, b: unknown) =>
  a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : !(a instanceof Date) && !(b instanceof Date);

/** The baseline still matches the task: there is nothing to compare, so nothing is drawn for it. */
export function baselineOnPlan(baseline: BaselineLike, task: TaskModel): boolean {
  const record = original(task);
  return sameTime(baseline.startDate, record.startDate) && sameTime(baseline.endDate, record.endDate);
}

/** Every planned date of the task is where it is now (also true when it has none). */
export function onPlan(task: TaskModel): boolean {
  const baselines = (original(task) as TaskModel & { baselines?: { allRecords?: BaselineLike[] } }).baselines?.allRecords ?? [];
  return baselines.every((baseline) => baselineOnPlan(baseline, task));
}

/** 1 for a phase, 2 for a work package inside it, and so on. */
function treeDepth(task: TaskModel): number {
  let depth = 0;
  let node = original(task) as unknown as TreeNodeLike;
  while (node.parent && !node.isRoot) {
    depth += 1;
    node = node.parent;
  }
  return depth;
}

function luminance(hex: string): number | null {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  const digits = match[1]!.length === 3 ? [...match[1]!].map((digit) => digit + digit).join('') : match[1]!;
  const channel = (offset: number) => {
    const value = parseInt(digits.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

/** White text on this color reaches WCAG AA (4.5:1); unknown colors are assumed dark enough. */
export function carriesWhiteText(color: string): boolean {
  const value = luminance(color);
  return value === null || 1.05 / (value + 0.05) >= 4.5;
}

export interface BarLook {
  /** Classes for the bar's wrapper element. */
  classes: string[];
  /** Share of the bar after its planned finish, drawn as a hatched red tail (0 when on plan). */
  slip: number;
  /** FontAwesome icon name inside the bar; empty for phases, groups and milestones. */
  icon: string;
}

/**
 * The visual decisions for one bar. Status sets the fill (ghost outline → raised solid → flat and
 * receded), the kind of work sets the shape (hexagon ends for checks, a capsule for rented
 * equipment, a bracket for phases), the plan sets the edges (heavier keel when critical, hatched
 * tail when late) and money in motion sets the only animation (a PayPal-blue pulse).
 */
export function barLook(rendered: TaskModel, state: LookState): BarLook {
  const task = original(rendered);
  const classes = [phaseClass(rendered)];
  if (isGeneratedParent(rendered)) {
    return { classes: [...classes, 'look-group-bar'], slip: 0, icon: '' };
  }
  // A payment hold lit by the walkthrough, or lifting as PayPal pays (gantt/hold-look.ts).
  classes.push(...holdClasses(task));
  const status = statusOf(task);
  if (status === 'done') classes.push('look-done');
  if (!task.isLeaf) {
    classes.push('look-summary', treeDepth(task) <= 1 ? 'look-summary-phase' : 'look-summary-package');
    if (heldBy(task.project, task)) classes.push('look-held');
    return { classes, slip: 0, icon: '' };
  }
  if (task.isMilestone) {
    const gate = gateFor(task.project, task);
    if (gate) classes.push('look-pay-gate', `look-pay-gate-${gate.payGate.state}`);
    return { classes, slip: 0, icon: '' };
  }
  classes.push(`look-status-${status}`);
  // Work a payment gate holds until the money is in.
  if (heldBy(task.project, task)) classes.push('look-held');
  if (isCritical(task) && status !== 'done') classes.push('look-critical');
  if (isCheckpoint(task)) classes.push('look-checkpoint');
  if (usesEquipment(task)) classes.push('look-equipment');
  const slip = status === 'done' ? 0 : slipShare(task);
  if (status !== 'done' && slipDays(task) > 0) classes.push('look-late');
  const decoration = state.decorations.get(task.id as number);
  if (decoration?.tracker?.paying) classes.push('look-paying');
  return { classes, slip, icon: status === 'done' ? 'check' : taskIcon(task) };
}

// -----------------------------------------------------------------------------------------
// The fix and its payment, beside the bar and in the hover card
// -----------------------------------------------------------------------------------------

/** A step's icon: a check mark once done, a cross or warning when stuck, else the step's own. */
export function stepIcon(step: TrackerStep, focused: boolean): string {
  if (step.state === 'failed') return 'fa fa-xmark';
  if (step.state === 'attention') return 'fa fa-rotate-left';
  if (step.state === 'done' && !focused) return 'fa fa-check';
  return step.icon;
}

/** What the pill says beside the bar: the step's status, with the amount on payment steps. */
export function compactStepText(tracker: Tracker, step: TrackerStep): string {
  const amount = step.paypal && tracker.amountMinor !== null ? wholeMoney(tracker.amountMinor, tracker.currency) : null;
  if (tracker.complete) return amount ? `Paid ${amount}` : 'Paid';
  return amount && (step.state === 'current' || step.state === 'done') ? `${step.status} · ${amount}` : step.status;
}

/** The tracker's step in focus as one badge, e.g. "PayPal is processing · $1,200". */
export function trackerBadge(tracker: Tracker): TaskBadge {
  const step = tracker.steps.find((candidate) => candidate.key === tracker.focus) ?? tracker.steps[0]!;
  return { text: compactStepText(tracker, step), tone: tracker.tone, icon: stepIcon(step, true) };
}

/**
 * What the bar says about a fix: its payment (pending, processing, paid), or a step that failed. The
 * steps before the payment stay in the fix panel: there is one person deciding, so they need no marks here.
 */
export function stepOnBar(tracker: Tracker): TrackerStep | null {
  const step = tracker.steps.find((candidate) => candidate.key === tracker.focus);
  return step && !tracker.dropped && (step.key === 'paid' || step.state === 'failed') ? step : null;
}

/** The pill beside the bar, or null when the bar has nothing to say about the fix. */
export function renderTracker(tracker: Tracker): DomConfig | null {
  const step = stepOnBar(tracker);
  if (!step) return null;
  const paypal = step.paypal && step.state !== 'failed';
  return {
    tag: 'span',
    className: `look-pill look-tone-${tracker.tone} look-status${paypal ? ' is-paypal' : ''}${tracker.paying ? ' is-paying' : ''}`,
    dataset: { focus: tracker.focus },
    children: [
      paypal
        ? { tag: 'img', className: 'look-status-mark', src: '/paypal/paypal-mark-white.svg', alt: '' }
        : { tag: 'i', className: stepIcon(step, true), 'aria-hidden': 'true' },
      { tag: 'span', text: compactStepText(tracker, step) },
    ],
  } as DomConfig;
}

// -----------------------------------------------------------------------------------------
// Renderers
// -----------------------------------------------------------------------------------------

interface ClassTarget {
  add?: (...names: string[]) => void;
}

function addClass(target: unknown, name: string): void {
  if (target && typeof (target as ClassTarget).add === 'function') {
    (target as ClassTarget).add!(name);
  }
}

export interface TaskRenderData {
  taskRecord: TaskModel;
  renderData: { cls: unknown; wrapperCls: unknown; style: unknown; iconCls: unknown };
}

/**
 * The colors a task can be given (Bryntum's named event colors, with the shade drawn for each).
 * Muted like the phase colors and never red, orange, pink or yellow: those mean danger and caution.
 */
export const TASK_COLORS: readonly { name: string; swatch: string }[] = [
  { name: 'lime', swatch: '#607c42' },
  { name: 'green', swatch: '#307a4f' },
  { name: 'teal', swatch: '#1d777b' },
  { name: 'cyan', swatch: '#327892' },
  { name: 'blue', swatch: '#446b9c' },
  { name: 'indigo', swatch: '#585399' },
  { name: 'violet', swatch: '#775386' },
  { name: 'gray', swatch: '#515f6e' },
];

/** The color somebody gave this task (`eventColor`, a name or a hex value), or null. */
export function ownTaskColor(task: TaskModel): string | null {
  const value = (original(task) as TaskModel & { eventColor?: string | null }).eventColor;
  if (typeof value !== 'string' || !value) return null;
  if (/^#[0-9a-f]{6}$/i.test(value)) return value;
  return TASK_COLORS.find((entry) => entry.name === value)?.swatch ?? null;
}

/** Bar content: the task's icon and name on leaf bars; the bar language classes on every bar. */
export function renderTaskBar(state: LookState, { taskRecord: rendered, renderData }: TaskRenderData): DomConfig[] | string {
  // Each part of a split task is rendered with its segment record; the facts belong to the task.
  const segment = rendered as TaskModel & { isEventSegment?: boolean; event?: TaskModel };
  const taskRecord = segment.isEventSegment && segment.event ? segment.event : rendered;
  const task = original(taskRecord);
  const look = barLook(taskRecord, state);
  for (const name of look.classes) addClass(renderData.wrapperCls, name);
  // A bar whose planned dates match keeps its full height: its baseline is not drawn (gantt.css).
  if (!segment.isEventSegment && onPlan(taskRecord)) addClass(renderData.wrapperCls, 'look-on-plan');
  if (isGeneratedParent(taskRecord) || !taskRecord.isLeaf || taskRecord.isMilestone) {
    return '';
  }
  const styles: string[] = [];
  const lead = state.colorBy === 'crew' ? leadCrew(task) : undefined;
  // The bar reads its color from --look-phase: a color given to the task wins, then (when coloring
  // by crew) its crew's, else its phase's. A light color switches the bar's text to ink.
  const color = ownTaskColor(task) ?? (lead ? crewColor(lead) : null);
  if (color) {
    styles.push(`--look-phase:${color}`);
    if (!carriesWhiteText(color)) addClass(renderData.cls, 'look-ink-dark');
  }
  if (look.slip > 0 && !segment.isEventSegment) styles.push(`--look-slip:${(look.slip * 100).toFixed(1)}%`);
  if (styles.length > 0) {
    renderData.style = [typeof renderData.style === 'string' ? renderData.style : '', ...styles].filter(Boolean).join(';');
  }
  return [icon(look.icon, 'look-bar-icon'), span('look-bar-name', task.name ?? '')];
}

/**
 * Labels merge the returned object into their own `<label>` DomConfig, so the label renderers
 * return only `children` and keep Bryntum's tag, classes and grid placement.
 */
type LabelContent = { children: DomConfig[] } | '';

const labelContent = (content: DomConfig): LabelContent => ({ children: [content] });

/**
 * Right of the bar: the fix and payment tracker, how late the task is against its planned dates,
 * and (with a money column shown, for viewers who see money) the forecast cost. Budget verdicts are
 * left to the assistant and the watch list. Crews are not repeated here: the Crew column, the crew
 * coloring and the hover card already say who.
 */
export function renderAfterLabel(state: LookState, { taskRecord }: { taskRecord: TaskModel }): LabelContent {
  const task = original(taskRecord);
  if (isGeneratedParent(taskRecord)) return '';
  if (task.isMilestone) {
    const gate = gateFor(task.project, task);
    if (gate) return labelContent(gateLabel(state, gate));
    const date = task.startDate instanceof Date ? task.startDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : '';
    return labelContent({ tag: 'span', className: 'look-milestone-label', children: [{ tag: 'strong', text: task.name ?? '' }, { tag: 'span', text: date }] });
  }
  if (!task.isLeaf) {
    // The group a payment gate holds, by the name it goes by on a call ("Ground-floor slab"), held until it is paid.
    const holder = heldBy(task.project, task);
    if (holder && holder.holds.includes(task)) {
      return labelContent({ tag: 'span', className: 'look-held-label', children: [icon('lock'), { tag: 'strong', text: spokenName(task.name ?? '') }, { tag: 'span', text: ' held until paid' }] });
    }
    // Just released: for as long as the block takes to lift.
    if (isBeingReleased(task)) {
      const released = [...gateIndex(task.project as never).gates.values()].find((gate) => gate.holds.includes(task));
      if (released) return labelContent({ tag: 'span', className: 'look-held-label is-released', children: [{ tag: 'i', className: 'fa fa-lock-open' }, { tag: 'strong', text: spokenName(task.name ?? '') }, { tag: 'span', text: ' cleared to start' }] });
    }
    return '';
  }
  const children: DomConfig[] = [];
  const tracker = state.decorations.get(task.id as number)?.tracker;
  const pill = tracker ? renderTracker(tracker) : null;
  if (pill) children.push(pill);
  const done = statusOf(task) === 'done';
  const slip = slipDays(task);
  if (slip > 0 && !done) {
    children.push(span('look-pill look-tone-alert look-late-pill', `${slip}d late`, [icon('clock')]));
  }
  if (state.canViewCosts && state.moneyColumns) {
    const money = taskMoney(task);
    if (money.budget > 0) children.push(span('look-money', compactMoney(money.expected, state.currency)));
  }
  return children.length > 0 ? labelContent({ tag: 'span', className: 'look-after', children }) : '';
}

const SHORT_DAY: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric' };

/** What a payment pays for, the way it is said in a sentence: "the footings". */
export function paidForWords(gate: Gate): string {
  const names = gate.pays.map((row) => {
    const name = row.name ?? '';
    return row.isLeaf ? name : `the ${name.charAt(0).toLowerCase()}${name.slice(1)}`;
  });
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : (names[0] ?? 'the work');
}

/** Work the plan names in the trade's terms, as it is said on a call: a slab on grade is the ground-floor slab. */
const SPOKEN_NAMES: readonly (readonly [RegExp, string])[] = [[/^slab[- ]on[- ]grade$/i, 'Ground-floor slab']];

/** A held group's name on its tag, as it is said where that differs from the plan's: "Slab on grade" is "Ground-floor slab". */
export function spokenName(name: string): string {
  const trimmed = name.trim();
  return SPOKEN_NAMES.find(([pattern]) => pattern.test(trimmed))?.[1] ?? trimmed;
}

/** Held work, in a sentence (the held task's note, the link's tooltip): "Can't start until the footings are paid". */
export function heldWords(gate: Gate): string {
  const what = paidForWords(gate);
  const plural = gate.pays.length > 1 || /s$/i.test(what.split(' ').at(-1) ?? '');
  return `Can't start until ${what} ${plural ? 'are' : 'is'} paid`;
}

/**
 * Beside a payment gate: what it pays for, and where the payment stands. Amounts only for those who may see
 * money; everyone sees whether the work after it is waiting.
 */
function gateLabel(state: LookState, gate: Gate): DomConfig {
  const paid = gate.pays.map((row) => row.name).join(', ');
  const { payGate } = gate;
  const amount = (minor: number | null | undefined) => (state.canViewCosts && typeof minor === 'number' ? wholeMoney(minor, state.currency) : null);
  let status: string;
  if (payGate.state === 'paid') {
    const sent = amount(payGate.amountMinor);
    status = sent ? `Paid with PayPal · ${sent}` : 'Paid with PayPal';
  } else if (payGate.state === 'paying') {
    status = 'Processing with PayPal…';
  } else if (payGate.state === 'failed') {
    status = 'Payment failed';
  } else {
    const due = amount(paymentOf(gate).dueMinor);
    const later = scheduledPayDay(gate);
    status = [due && due !== amount(0) ? `${due} due` : 'Nothing due yet', later ? `scheduled ${later.toLocaleDateString('en-US', SHORT_DAY)}` : null].filter(Boolean).join(' · ');
  }
  // PayPal's mark only once PayPal has it (paying, paid); before that, the payment that holds the work.
  const mark = payGate.state === 'paid' || payGate.state === 'paying' ? 'fa-brands fa-paypal' : payGate.state === 'failed' ? 'fa fa-triangle-exclamation' : 'fa fa-lock';
  return {
    tag: 'span',
    className: `look-gate-label is-${payGate.state}`,
    children: [{ tag: 'i', className: mark }, { tag: 'strong', text: `${paid} payment` }, { tag: 'span', text: status }],
  };
}

const RENTAL_DATE = 'MMM D';

/**
 * Rented equipment's time on site: a dashed box from the day it is delivered to the day it goes,
 * around the work that uses it, with a small tab naming it. Facts only; whether days are wasted is
 * for the assistant to work out when asked.
 */
export function rentalIndicator(state: LookState, taskRecord: TaskModel): { startDate: Date; endDate: Date; name: string; cls: string; iconCls: string; style: string } | null {
  const rental = state.decorations.get(original(taskRecord).id as number)?.rental;
  if (!rental) return null;
  const startDate = dateOnly(rental.start);
  const endDate = dateOnly(rental.end);
  const lastDay = new Date(endDate.getTime() - DAY_MS);
  return {
    startDate,
    endDate,
    name: `${rental.equipment} ${rental.booked ? `on rent from ${rental.supplier}` : 'on site, no rental booked for this task'}: ${DateHelper.format(startDate, RENTAL_DATE)} → ${DateHelper.format(lastDay, RENTAL_DATE)}`,
    cls: 'look-rental-band',
    iconCls: '',
    style: `--rental-label:${JSON.stringify(`${rental.equipment} ${rental.booked ? 'on rent' : 'on site'}`)}`,
  };
}

function dateOnly(value: string): Date {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1);
}

// -----------------------------------------------------------------------------------------
// Grouping
// -----------------------------------------------------------------------------------------

/** Values that generated parents are built from; the key carries its own sort order. */
export function groupKey(groupBy: GroupBy, task: TaskModel): string {
  switch (groupBy) {
    case 'crew':
      return crewOf(task)[0]?.name ?? 'No crew';
    case 'status':
      return STATUS_LABELS[statusOf(task)];
    case 'budget':
      return BUDGET_LABELS[budgetOf(task)];
    default:
      return '';
  }
}

const GROUP_ORDER: Readonly<Record<string, number>> = {
  [STATUS_LABELS.active]: 0,
  [STATUS_LABELS.todo]: 1,
  [STATUS_LABELS.done]: 2,
  [BUDGET_LABELS.over]: 0,
  [BUDGET_LABELS.on]: 1,
  [BUDGET_LABELS.under]: 2,
  'No crew': 99,
};

export function compareGroups(a: string, b: string): number {
  return (GROUP_ORDER[a] ?? 50) - (GROUP_ORDER[b] ?? 50) || a.localeCompare(b);
}

export interface GroupStats {
  count: number;
  done: number;
  budget: number;
  expected: number;
  icon: string;
}

/** Per-group totals over the leaves of the original task tree. */
export function groupStats(groupBy: GroupBy, leaves: readonly TaskModel[]): Map<string, GroupStats> {
  const stats = new Map<string, GroupStats>();
  for (const leaf of leaves) {
    const key = groupKey(groupBy, leaf);
    const entry = stats.get(key) ?? { count: 0, done: 0, budget: 0, expected: 0, icon: '' };
    const money = taskMoney(leaf);
    entry.count += 1;
    entry.done += statusOf(leaf) === 'done' ? 1 : 0;
    entry.budget += money.budget;
    entry.expected += money.expected;
    if (!entry.icon) {
      const crew = crewOf(leaf)[0];
      entry.icon = groupBy === 'crew' ? (crew ? crewIcon(crew) : 'circle-question') : '';
    }
    stats.set(key, entry);
  }
  return stats;
}

const GROUP_ICONS: Readonly<Record<string, string>> = {
  [STATUS_LABELS.done]: 'circle-check',
  [STATUS_LABELS.active]: 'person-digging',
  [STATUS_LABELS.todo]: 'clock',
  [BUDGET_LABELS.over]: 'triangle-exclamation',
  [BUDGET_LABELS.on]: 'scale-balanced',
  [BUDGET_LABELS.under]: 'piggy-bank',
};

const GROUP_TONES: Readonly<Record<string, Tone>> = {
  [STATUS_LABELS.done]: 'ok',
  [STATUS_LABELS.active]: 'busy',
  [STATUS_LABELS.todo]: 'neutral',
  [BUDGET_LABELS.over]: 'alert',
  [BUDGET_LABELS.on]: 'neutral',
  [BUDGET_LABELS.under]: 'ok',
};

/** A generated group row: icon, name and how many tasks it holds (money shows in the cost columns). */
export function renderGroupRow(key: string, stats: GroupStats | undefined): DomConfig {
  const tone = GROUP_TONES[key] ?? 'neutral';
  return {
    tag: 'span',
    className: `look-group look-tone-${tone}`,
    children: compact([
      { tag: 'span', className: 'look-group-icon', children: [icon(stats?.icon || GROUP_ICONS[key] || 'layer-group')] },
      span('look-group-name', key),
      stats ? span('look-group-count', String(stats.count)) : null,
    ]),
  };
}

export function isGeneratedParent(record: unknown): boolean {
  return Boolean((record as { generatedParent?: boolean } | null)?.generatedParent);
}

/** Money of a task, or the sum over the leaves under a phase or generated group. */
export function rolledUpMoney(record: TaskModel): TaskMoney {
  const task = original(record);
  if (task.isLeaf) return taskMoney(task);
  const total: TaskMoney = { budget: 0, expected: 0, spent: 0, paid: 0 };
  const visit = (node: TaskModel) => {
    const children = (node.children ?? []) as TaskModel[] | boolean;
    if (!Array.isArray(children) || children.length === 0) {
      const money = taskMoney(node);
      total.budget += money.budget;
      total.expected += money.expected;
      total.spent += money.spent;
      total.paid += money.paid;
      return;
    }
    children.forEach(visit);
  };
  visit(record);
  return total;
}

// -----------------------------------------------------------------------------------------
// Tooltips
// -----------------------------------------------------------------------------------------

const esc = (value: unknown): string => StringHelper.encodeHtml(String(value ?? ''));
const TOOLTIP_DATE = 'ddd MMM D';

/** Phase › work package: where the task sits in the plan. */
export function taskPath(task: TaskModel): string[] {
  const path: string[] = [];
  let node = original(task).parent as TaskModel | null | undefined;
  while (node && !node.isRoot) {
    path.unshift(node.name ?? '');
    node = node.parent as TaskModel | null | undefined;
  }
  return path;
}

const STATUS_TONES: Readonly<Record<StatusKey, Tone>> = { done: 'ok', active: 'busy', todo: 'neutral' };

function linkedNames(tasks: TaskModel[]): string {
  const names = tasks.map((task) => esc(task.name)).filter(Boolean);
  if (names.length <= 2) return names.join(', ');
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
}

interface DependencyLike {
  fromEvent?: TaskModel | null;
  toEvent?: TaskModel | null;
  type?: number;
  lag?: number;
  lagUnit?: string;
}

/** Planned against current dates as two thin bars on one scale; null when the task kept its dates. */
export function planStrip(task: TaskModel): { plan: [number, number]; now: [number, number]; slip: number; startShift: number } | null {
  const record = original(task) as TaskModel & { baselines?: { first?: { startDate?: Date; endDate?: Date } } };
  const baseline = record.baselines?.first;
  const { startDate: start, endDate: end } = record;
  if (record.isMilestone || !(baseline?.startDate instanceof Date) || !(baseline.endDate instanceof Date) || !(start instanceof Date) || !(end instanceof Date)) return null;
  const days = (from: Date, to: Date) => Math.round((to.getTime() - from.getTime()) / DAY_MS);
  const startShift = days(baseline.startDate, start);
  const slip = days(baseline.endDate, end);
  if (startShift === 0 && slip === 0) return null;
  const min = Math.min(start.getTime(), baseline.startDate.getTime());
  const range = Math.max(end.getTime(), baseline.endDate.getTime()) - min || 1;
  const at = (date: Date) => Math.round(((date.getTime() - min) / range) * 1000) / 10;
  return { plan: [at(baseline.startDate), at(baseline.endDate)], now: [at(start), at(end)], slip, startShift };
}

function planStripHtml(task: TaskModel): string {
  const strip = planStrip(task);
  if (!strip) return '';
  const { plan, now, slip, startShift } = strip;
  const late = slip > 0 && statusOf(task) !== 'done';
  const words =
    slip > 0
      ? `Finishes ${slip} day${slip === 1 ? '' : 's'} later than planned`
      : slip < 0
        ? `Finishes ${-slip} day${slip === -1 ? '' : 's'} earlier than planned`
        : `Starts ${Math.abs(startShift)} day${Math.abs(startShift) === 1 ? '' : 's'} ${startShift > 0 ? 'later' : 'earlier'}, finishes on plan`;
  const tail = late ? Math.max(0, Math.min(now[1] - now[0], now[1] - plan[1])) : 0;
  return `<div class="look-tip-plan${late ? ' is-late' : ''}">
      <div class="look-tip-plan-lane"><span class="look-tip-plan-tag">Plan</span><span class="look-tip-plan-track"><span class="look-tip-plan-bar is-plan" style="left:${plan[0]}%;width:${Math.max(1, plan[1] - plan[0])}%"></span></span></div>
      <div class="look-tip-plan-lane"><span class="look-tip-plan-tag">Now</span><span class="look-tip-plan-track"><span class="look-tip-plan-bar is-now" style="left:${now[0]}%;width:${Math.max(1, now[1] - now[0])}%">${tail > 0 ? `<span class="look-tip-plan-slip" style="width:${Math.round((tail / Math.max(0.1, now[1] - now[0])) * 1000) / 10}%"></span>` : ''}</span></span></div>
      <div class="look-tip-plan-words"><i class="fa fa-${late ? 'clock' : slip < 0 ? 'circle-check' : 'arrows-left-right'}"></i>${esc(words)}</div>
    </div>`;
}

function moneyHtml(state: LookState, task: TaskModel): string {
  const money = rolledUpMoney(task);
  if (money.budget <= 0 && money.expected <= 0) return '';
  const over = money.expected - money.budget;
  const scale = Math.max(money.budget, money.expected, money.spent, 1);
  const pct = (value: number) => Math.round((Math.max(0, value) / scale) * 1000) / 10;
  // Figures, not verdicts: forecast against budget, and how much of it is spent and paid.
  return `<div class="look-tip-row look-tip-money"><i class="fa fa-sack-dollar"></i><span>
      <span><strong>${esc(wholeMoney(money.expected, state.currency))}</strong> forecast · ${esc(wholeMoney(money.budget, state.currency))} budget</span>
      <span class="look-tip-meter${over > 0 ? ' is-over' : ''}" aria-hidden="true">
        <span class="look-tip-meter-expected" style="width:${pct(money.expected)}%"></span>
        <span class="look-tip-meter-spent" style="width:${pct(money.spent)}%"></span>
        <span class="look-tip-meter-paid" style="width:${pct(money.paid)}%"></span>
        <span class="look-tip-meter-budget" style="left:${pct(money.budget)}%"></span>
      </span>
      <em>${esc(wholeMoney(money.spent, state.currency))} spent · ${esc(wholeMoney(money.paid, state.currency))} paid</em>
    </span></div>`;
}

/**
 * The task's hover card: where it sits, when (and against the plan), who, how far along, what it
 * waits for, money for viewers who see it, and the payment of rented equipment. It
 * stays open while the pointer is on it, so its contents can be read and selected.
 */
export function renderTaskTooltip(state: LookState, taskRecord: TaskModel): string {
  const task = original(taskRecord);
  if (isGeneratedParent(taskRecord)) {
    return `<div class="look-tip"><div class="look-tip-title">${esc(taskRecord.name)}</div></div>`;
  }
  const status = statusOf(task);
  const done = Math.round(task.percentDone ?? 0);
  const path = taskPath(task);
  const rows: string[] = [];
  const start = task.startDate;
  const segments = ((task as TaskModel & { segments?: unknown[] }).segments ?? []) as unknown[];

  if (start instanceof Date) {
    const when = task.isMilestone
      ? DateHelper.format(start, TOOLTIP_DATE)
      : `${DateHelper.format(start, TOOLTIP_DATE)} <i class="fa fa-arrow-right-long"></i> ${DateHelper.format(lastWorkingDay(task), TOOLTIP_DATE)}`;
    const length = task.isMilestone
      ? 'milestone'
      : `${Math.round((task.duration ?? 0) * 10) / 10} working day${task.duration === 1 ? '' : 's'}${segments.length > 1 ? `, in ${segments.length} parts` : ''}`;
    rows.push(`<div class="look-tip-row"><i class="fa fa-calendar-days"></i><span><strong>${when}</strong> <em>${length}</em></span></div>`);
  }
  if (isPaymentLocked(task)) {
    rows.push(`<div class="look-tip-row is-locked"><i class="fa fa-lock"></i><span>Locked while PayPal pays the supplier: it unlocks when PayPal confirms</span></div>`);
  }
  if (isCritical(task) && status !== 'done') {
    rows.push(`<div class="look-tip-row is-critical"><i class="fa fa-bolt"></i><span>On the critical path: a day lost here moves the handover</span></div>`);
  }
  if (task.isLeaf && isCheckpoint(task)) {
    rows.push(`<div class="look-tip-row"><i class="fa fa-shield-halved"></i><span>A check: the work after it waits until it passes</span></div>`);
  }
  const crew = crewOf(task);
  if (crew.length > 0) {
    const chips = crew
      .map((resource) => {
        const company = (resource as ResourceModel & { company?: string }).company;
        return `<span class="look-tip-crew" style="--crew:${esc(crewColor(resource))}"><i class="fa fa-${esc(crewIcon(resource))}"></i>${esc(resource.name)}${company ? `<em>${esc(company)}</em>` : ''}</span>`;
      })
      .join('');
    rows.push(`<div class="look-tip-row"><i class="fa fa-user-group"></i><span class="look-tip-chips">${chips}</span></div>`);
  }
  const before = ((task.predecessors ?? []) as unknown as DependencyLike[]).map((dep) => dep.fromEvent).filter((item): item is TaskModel => Boolean(item));
  const after = ((task.successors ?? []) as unknown as DependencyLike[]).map((dep) => dep.toEvent).filter((item): item is TaskModel => Boolean(item));
  if (before.length > 0) rows.push(`<div class="look-tip-row"><i class="fa fa-arrow-right-to-bracket"></i><span>Waits for ${linkedNames(before)}</span></div>`);
  if (after.length > 0) rows.push(`<div class="look-tip-row"><i class="fa fa-arrow-right-from-bracket"></i><span>Then ${linkedNames(after)}</span></div>`);
  if (!task.isLeaf) {
    const leaves = (task.allChildren as TaskModel[]).filter((child) => child.isLeaf);
    const finished = leaves.filter((child) => statusOf(child) === 'done').length;
    rows.push(`<div class="look-tip-row"><i class="fa fa-list-check"></i><span>${finished} of ${leaves.length} tasks done</span></div>`);
  }
  if (state.canViewCosts) rows.push(moneyHtml(state, task));
  const decoration = state.decorations.get(task.id as number);
  if (decoration?.rental) {
    const rental = decoration.rental;
    const last = new Date(dateOnly(rental.end).getTime() - DAY_MS);
    rows.push(
      `<div class="look-tip-row"><i class="fa fa-truck-ramp-box"></i><span>${esc(rental.equipment)} ${rental.booked ? 'on rent' : 'on site'} ${esc(DateHelper.format(dateOnly(rental.start), TOOLTIP_DATE))} <i class="fa fa-arrow-right-long"></i> ${esc(DateHelper.format(last, TOOLTIP_DATE))} <em>${rental.booked ? esc(rental.supplier) : 'No rental booked for this task'}</em></span></div>`,
    );
  }
  const tracker = decoration?.tracker;
  const payment = tracker ? stepOnBar(tracker) : null;
  const trackerBlock =
    tracker && payment
      ? `<div class="look-tip-tracker look-tone-${tracker.tone}"><div class="look-tip-tracker-head"><span>${payment.key === 'paid' ? 'Payment' : esc(payment.label)}</span><strong>${esc(compactStepText(tracker, payment))}</strong></div></div>`
      : '';
  const note = typeof task.note === 'string' ? task.note.trim() : '';
  const noteText = note.length > 220 ? `${note.slice(0, 217)}…` : note;

  return `<div class="look-tip ${phaseClass(task)}">
    <div class="look-tip-head">
      <span class="look-tip-icon"><i class="fa fa-${task.isLeaf ? (task.isMilestone ? 'flag-checkered' : taskIcon(task)) : 'layer-group'}"></i></span>
      <span class="look-tip-heading">
        ${path.length > 0 ? `<span class="look-tip-path">${path.map(esc).join(' <i class="fa fa-chevron-right"></i> ')}</span>` : ''}
        <span class="look-tip-title">${esc(task.name)}</span>
      </span>
      <span class="look-pill look-tone-${STATUS_TONES[status]}">${esc(STATUS_LABELS[status])}</span>
    </div>
    ${task.isMilestone ? '' : `<div class="look-tip-progress"><span class="look-progress-track"><span class="look-progress-fill" style="width:${done}%"></span></span><span>${done}%</span></div>`}
    ${task.isLeaf ? planStripHtml(task) : ''}
    <div class="look-tip-rows">${rows.filter(Boolean).join('')}</div>
    ${trackerBlock}
    ${noteText ? `<div class="look-tip-note"><i class="fa fa-note-sticky"></i>${esc(noteText)}</div>` : ''}
    <div class="look-tip-hint">${task.isLeaf ? 'Double-click to edit · drag to move' : 'Double-click to edit'}</div>
  </div>`;
}

const DEPENDENCY_SENTENCES: Readonly<Record<number, (from: string, to: string) => string>> = {
  0: (from, to) => `${to} can start once ${from} has started`,
  1: (from, to) => `${to} can finish once ${from} has started`,
  2: (from, to) => `${to} can start once ${from} is finished`,
  3: (from, to) => `${to} can finish once ${from} is finished`,
};

const DEPENDENCY_KINDS: Readonly<Record<number, string>> = {
  0: 'Start together',
  1: 'Start to finish',
  2: 'Finish, then start',
  3: 'Finish together',
};

/** The hover card of a dependency line, in words. */
export function renderDependencyTooltip(dependency: DependencyModel | null | undefined): DomConfig[] | null {
  if (!dependency) return null;
  const { fromEvent, toEvent, type, lag, lagUnit } = dependency as unknown as DependencyLike;
  if (!fromEvent || !toEvent) return null;
  const kind = typeof type === 'number' ? type : 2;
  const sentence = (DEPENDENCY_SENTENCES[kind] ?? DEPENDENCY_SENTENCES[2]!)(fromEvent.name ?? 'the first task', toEvent.name ?? 'the next task');
  const lagValue = typeof lag === 'number' ? lag : 0;
  const unit = lagUnit === 'day' || lagUnit === 'd' || !lagUnit ? 'day' : lagUnit;
  const lagText = lagValue === 0 ? null : lagValue > 0 ? `then wait ${lagValue} ${unit}${lagValue === 1 ? '' : 's'}` : `may overlap by ${-lagValue} ${unit}${lagValue === -1 ? '' : 's'}`;
  const end = (task: TaskModel): DomConfig => ({
    tag: 'span',
    className: `look-dep-task ${phaseClass(task)}`,
    children: [{ tag: 'i', className: `fa fa-${task.isLeaf ? taskIcon(task) : 'layer-group'}` }, { tag: 'span', text: task.name ?? '' }],
  });
  // A link out of a payment: held until it is paid.
  const gate = fromEvent.isMilestone ? gateFor(fromEvent.project, fromEvent) : null;
  if (gate) {
    return [
      {
        className: 'look-tip look-dep-tip',
        children: [
          { className: 'look-dep-kind', text: gate.holding ? 'Held for a payment' : 'Paid: no longer held' },
          { className: 'look-dep-ends', children: [end(fromEvent), { tag: 'i', className: `fa fa-${gate.holding ? 'ban' : 'arrow-right-long'} look-dep-arrow` }, end(toEvent)] },
          { className: 'look-dep-sentence', text: gate.holding ? `${toEvent.name}: ${heldWords(gate).replace(/^C/, 'c')}.` : `PayPal paid for ${paidForWords(gate)}, so ${toEvent.name} can start.` },
        ],
      },
    ];
  }
  return [
    {
      className: 'look-tip look-dep-tip',
      children: compact([
        { className: 'look-dep-kind', text: DEPENDENCY_KINDS[kind] ?? DEPENDENCY_KINDS[2] },
        { className: 'look-dep-ends', children: [end(fromEvent), { tag: 'i', className: 'fa fa-arrow-right-long look-dep-arrow' }, end(toEvent)] },
        { className: 'look-dep-sentence', text: lagText ? `${sentence}, ${lagText}.` : `${sentence}.` },
      ]),
    },
  ];
}
