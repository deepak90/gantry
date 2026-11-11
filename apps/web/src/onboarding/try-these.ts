/**
 * "Try these": the hosted site's short list of things to do in a session, on the counter in the header
 * (onboarding/StoryRail.tsx). Each item points at its control (the coach's marks, StoryCoach.tsx) and ticks itself off
 * when it happens: from what this tab does (a call joined, the 3D view opened, Remy's answer worked out here, the odds
 * run here), from presence (a teammate in the session) or from the session's data, whoever did it (a library piece on
 * level 1, the tenant invoice sent, a payment hold paid with PayPal). Items for something switched off on the site, or
 * that this person can't do, are not listed.
 *
 * The items can be done in any order. The counter counts them as they are done: what is done comes first, in the
 * order it was done, then the item at hand (the one picked with "Show me", or the next one left after it), then the
 * rest. What is done is kept in this browser for the session, in that order, so a reload doesn't untick anything;
 * each item is counted once.
 */
import type { ProjectModel, TaskModel } from '@bryntum/gantt';
import { readPayGate, type AgentCommandType } from '@collab/shared';
import { ASSISTANT_NAME } from '../assistant/identity';
import type { AppFlags } from '../copy/rpc';
import type { InspectorTabId } from '../inspector/Inspector';
import type { WorkflowSnapshot } from '../workflow/api';
import { rentalStanding } from '../workflow/rental';

export type TryKey = 'call' | 'invite' | 'drop' | 'site' | 'ask' | 'odds' | 'invoice' | 'pay' | 'rental';

export interface TryItem {
  key: TryKey;
  /** Short: it stands on the counter in the header. */
  label: string;
  hint: string;
  /** Where the coach points: selectors, the first one on screen wins. */
  targets: readonly string[];
  /** The side panel the item happens in; null for a control in the header or above the chart. */
  panel: InspectorTabId | null;
  /** What one press above Remy's message box asks her, for an item that is a question to her. */
  ask?: string;
}

const id = (testId: string) => `[data-testid="${testId}"]`;
const tab = (name: InspectorTabId) => id(`inspector-tab-${name}`);

export const TRY_ITEMS: readonly TryItem[] = [
  {
    key: 'call',
    label: `Call ${ASSISTANT_NAME}`,
    hint: `Press Call ${ASSISTANT_NAME} and talk. With others on the call, start with “${ASSISTANT_NAME}, …” so she knows it’s for her.`,
    targets: [id('call-start'), id('call-remy')],
    panel: null,
  },
  {
    key: 'invite',
    label: 'Invite a teammate',
    hint: 'Press Invite, then share the session code, or open a teammate in a new tab.',
    targets: [id('invite-open')],
    panel: null,
  },
  {
    key: 'drop',
    label: 'Drag a package onto level 1',
    hint: 'Open the library and drag a package onto a row of Level 1 build-out.',
    targets: [id('library-card'), tab('library')],
    panel: 'library',
  },
  {
    key: 'site',
    label: 'Open the 3D site view',
    hint: 'Press Site view above the chart to see the building as the plan has it on any date.',
    targets: [id('view-site')],
    panel: null,
  },
  {
    key: 'ask',
    label: `Ask ${ASSISTANT_NAME} about paying on Friday`,
    hint: `Ask in the chat what waiting until Friday to pay would do. ${ASSISTANT_NAME} works it out on the plan’s own schedule.`,
    targets: [id('assistant-next-chip'), id('assistant-input'), tab('assistant')],
    panel: 'assistant',
    ask: 'What happens if we wait until Friday to pay?',
  },
  {
    key: 'odds',
    label: 'Check the on-time odds',
    hint: 'Press On-time odds above the chart. The plan runs a thousand times, and the board shows how often the handover makes its date.',
    targets: [id('gantt-odds')],
    panel: null,
  },
  {
    key: 'invoice',
    label: 'Send the tenant invoice',
    hint: `After adding a package, ask ${ASSISTANT_NAME} to bill the tenant for it. Review the invoice, then send it with PayPal.`,
    targets: [id('change-invoice-review'), id('invoice-modal-send'), id('invoice-send'), id('assistant-next-chip'), tab('assistant')],
    panel: 'assistant',
    ask: 'Bill the tenant for the work we just added.',
  },
  {
    key: 'pay',
    label: 'Pay the footings with PayPal',
    hint: 'Open the payment hold after the footings and press Review payment. Over $25,000 needs a second person: open a teammate in a new tab to approve, then Send payout.',
    // Review payment in the hold's card; before that, the hold itself on the chart (its tag, then its milestone).
    targets: [id('pay-gate-pay'), '.look-gate-label.is-waiting', '.look-gate-label.is-failed', '.b-milestone-wrap.look-pay-gate-waiting'],
    panel: 'task',
  },
  {
    key: 'rental',
    label: 'Pay the crane’s rental',
    hint: 'Open Rentals, press Review payment on the tower crane, then send the payout with PayPal.',
    targets: [id('rental-pay'), id('task-equipment-pay'), tab('rentals')],
    panel: 'rentals',
  },
];

/** What the guide says around the items: one line on top of the opened counter, and the last row once all are done. */
export const TRY_PITCH = 'Things to try in your session. Each one ticks itself off when it happens.';
export const TRY_GOAL = 'All done';

/** What decides which items are listed. */
export interface TryContext {
  flags: AppFlags;
  /** The call is on this page. */
  calls: boolean;
  /** Remy is in the side panel. */
  assistant: boolean;
  /** The 3D view can open here (not switched off with `?fx=off`). */
  site: boolean;
  /** This person sees costs, so may send an invoice. */
  seesCosts: boolean;
  /** This person pays: progress payments and rentals. */
  pays: boolean;
}

/**
 * The crane's rental stays off the list for now: the rental suppliers need sandbox accounts of their own first. Until
 * then the hosted site refuses their payout rather than pay an account set up for someone else.
 */
const RENTAL_LISTED = false;

function listed(key: TryKey, context: TryContext): boolean {
  switch (key) {
    case 'call':
      return context.calls;
    case 'site':
      return context.site;
    case 'ask':
      return context.assistant && context.flags.live_ai;
    case 'invoice':
      return context.assistant && context.flags.live_ai && context.flags.live_payments && context.seesCosts;
    case 'pay':
      return context.flags.live_payments && context.pays;
    case 'rental':
      return RENTAL_LISTED && context.flags.live_payments && context.pays;
    case 'invite':
    case 'drop':
    case 'odds':
      return true;
  }
}

/** The items for this person, in order. */
export function tryItemsFor(context: TryContext): TryItem[] {
  return TRY_ITEMS.filter((item) => listed(item.key, context));
}

/** The item a command Remy had this browser carry out stands for: her answer about paying on Friday, and the odds. */
export function triedBy(type: AgentCommandType): TryKey | null {
  return type === 'late_payment_effect' ? 'ask' : type === 'schedule_odds' ? 'odds' : null;
}

// ---- the item at hand, and the counter's order ---------------------------------------------------

/** An item as the page shows it. */
export interface TryItemView extends TryItem {
  done: boolean;
}

/** The item at hand: the one picked with "Show me", else the first one left after it, going round; with none picked, the first one left. */
export function currentItem(items: readonly TryItemView[], picked: TryKey | null): TryItemView | null {
  const from = picked ? items.findIndex((item) => item.key === picked) : -1;
  for (let step = 0; step < items.length; step += 1) {
    const item = items[(Math.max(0, from) + step) % items.length]!;
    if (!item.done) return item;
  }
  return null;
}

/**
 * The items as the counter in the header turns through them: what is done, in the order it was done; then the item
 * at hand; then the rest, going on from it. Each item done turns the counter one notch, whichever it was.
 */
export function railOrder(items: readonly TryItemView[], doneOrder: Iterable<TryKey>, current: TryKey | null): TryItemView[] {
  const byKey = new Map(items.map((item) => [item.key, item]));
  const order = [...doneOrder];
  const done = [
    ...order.flatMap((key) => {
      const item = byKey.get(key);
      return item?.done ? [item] : [];
    }),
    ...items.filter((item) => item.done && !order.includes(item.key)),
  ];
  const from = Math.max(0, current ? items.findIndex((item) => item.key === current) : 0);
  const left = [...items.slice(from), ...items.slice(0, from)].filter((item) => !item.done);
  return [...done, ...left];
}

// ---- what the session says is done -----------------------------------------------------------

/** What the session itself shows done, whoever did it. */
export interface TryFacts {
  drop: boolean;
  invoice: boolean;
  pay: boolean;
  rental: boolean;
}

const childrenOf = (task: TaskModel): TaskModel[] => (Array.isArray(task.children) ? (task.children as TaskModel[]) : []);
const fromLibrary = (task: TaskModel): boolean => Boolean((task as TaskModel & { libraryRef?: string | null }).libraryRef);

/** A piece of work from the library somewhere in the plan's level 1 group. */
export function pieceOnLevelOne(project: ProjectModel): boolean {
  const root = (project.taskStore as unknown as { rootNode: { children?: TaskModel[] | boolean } }).rootNode;
  const tops = Array.isArray(root.children) ? root.children : [];
  const level = tops.find((task) => /^(level|floor)\s*1\b/i.test(task.name ?? ''));
  if (!level) return false;
  // A copy: the walk takes tasks off the front of its queue, and `children` is the plan's own list.
  const queue = [...childrenOf(level)];
  for (let task = queue.shift(); task; task = queue.shift()) {
    if (fromLibrary(task)) return true;
    queue.push(...childrenOf(task));
  }
  return false;
}

/** Every task in the plan, groups included, in the plan's order; the plan's own lists are copied, never walked as queues. */
function tasksOf(project: ProjectModel): TaskModel[] {
  const root = (project.taskStore as unknown as { rootNode: { children?: TaskModel[] | boolean } }).rootNode;
  const tasks: TaskModel[] = [];
  const stack = Array.isArray(root.children) ? [...root.children].reverse() : [];
  for (let task = stack.pop(); task; task = stack.pop()) {
    tasks.push(task);
    stack.push(...[...childrenOf(task)].reverse());
  }
  return tasks;
}

const payGateOf = (task: TaskModel) => readPayGate((task as unknown as { payGate?: unknown }).payGate);

/** A payment hold in the plan shows Paid: PayPal paid the progress payment its work waits for (gantt/pay-gates.ts `recordPaid`). */
export const holdPaid = (project: ProjectModel): boolean => tasksOf(project).some((task) => payGateOf(task)?.state === 'paid');

/** The payment hold to pay: the first in the plan that isn't paid yet ("Show me" opens it, where Review payment is). */
export function holdToPay(project: ProjectModel): TaskModel['id'] | null {
  return tasksOf(project).find((task) => (payGateOf(task)?.state ?? 'paid') !== 'paid')?.id ?? null;
}

/** The tower crane's rental is paid (its machine is the one named for a crane). */
export function cranePaid(project: ProjectModel, snapshot: WorkflowSnapshot | null): boolean {
  if (!snapshot) return false;
  const nameOf = (resourceId: number) => (project.resourceStore.getById(resourceId) as { name?: string } | undefined)?.name ?? '';
  return snapshot.bookings.some((booking) => /crane/i.test(nameOf(booking.resource_id)) && rentalStanding(snapshot, booking).pay === 'paid');
}

/** The tenant was billed: an invoice went out through PayPal (paid ones included). */
export const invoiceSent = (snapshot: WorkflowSnapshot | null): boolean => (snapshot?.invoices ?? []).some((invoice) => invoice.status === 'sent' || invoice.status === 'paid');

export function tryFactsOf(project: ProjectModel, snapshot: WorkflowSnapshot | null): TryFacts {
  return { drop: pieceOnLevelOne(project), invoice: invoiceSent(snapshot), pay: holdPaid(project), rental: cranePaid(project, snapshot) };
}

// ---- ticking ----------------------------------------------------------------------------------

export interface TryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const KEYS: readonly TryKey[] = TRY_ITEMS.map((item) => item.key);
const isKey = (value: unknown): value is TryKey => KEYS.includes(value as TryKey);

function browserStorage(): TryStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export interface TrackerOptions {
  /** Where this session's ticks are kept in this browser; null keeps them for this page only. */
  storageKey: string | null;
  storage?: TryStorage | null;
  /** Each item once, as it is done (not the ones a reload brings back). */
  onDone?(key: TryKey): void;
}

/** Which items are done, in the order they were done: each ticked once and kept. Framework-free, read by React with useSyncExternalStore. */
export class TryTheseTracker {
  private done: ReadonlySet<TryKey>;
  private readonly listeners = new Set<() => void>();
  private readonly options: TrackerOptions;
  private readonly storage: TryStorage | null;

  constructor(options: TrackerOptions) {
    this.options = options;
    this.storage = options.storage === undefined ? browserStorage() : options.storage;
    this.done = new Set(this.load());
  }

  /** The items done, in the order they were done. */
  getSnapshot = (): ReadonlySet<TryKey> => this.done;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  has(key: TryKey): boolean {
    return this.done.has(key);
  }

  /** The item happened. */
  mark = (key: TryKey): void => {
    if (this.done.has(key)) return;
    this.done = new Set([...this.done, key]);
    this.save();
    this.options.onDone?.(key);
    for (const listener of [...this.listeners]) listener();
  };

  /** What the session shows done. */
  sync(facts: TryFacts): void {
    if (facts.drop) this.mark('drop');
    if (facts.invoice) this.mark('invoice');
    if (facts.pay) this.mark('pay');
    if (facts.rental) this.mark('rental');
  }

  private load(): TryKey[] {
    const { storageKey } = this.options;
    if (!storageKey) return [];
    try {
      const saved = JSON.parse(this.storage?.getItem(storageKey) ?? '[]') as unknown;
      return Array.isArray(saved) ? [...new Set(saved.filter(isKey))] : [];
    } catch {
      return [];
    }
  }

  private save(): void {
    const { storageKey } = this.options;
    if (!storageKey) return;
    try {
      this.storage?.setItem(storageKey, JSON.stringify([...this.done]));
    } catch {
      // Kept for this page only.
    }
  }
}
