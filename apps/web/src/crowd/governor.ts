/**
 * The governor: every change a simulated person makes goes through it, and it lets through only
 * innocent ones (none at all in a look-only crowd). It never deletes, never adds or removes links, never touches phases, milestones,
 * locked or booked tasks. Text (names, notes) is checked before it is written. Dates move only on
 * tasks with float to spare, and every change is made as one transaction that is checked after the
 * engine has rescheduled: if the handover, the project end or the critical path moved, a task would
 * now miss its deadline (or, for a
 * change that should not move dates, the task itself moved), the transaction is rolled back before
 * anything leaves the browser.
 *
 * It also keeps the drift ledger: what the crowd moved away from where it was, and when it is due to
 * be brought back. Whoever takes a due entry makes it look like a natural edit, preferably not the
 * person who made the original change, and never straight away.
 */
import type { ProjectModel, TaskModel } from '@bryntum/gantt';
import type { Clock } from '../presence/clock';
import { isPaymentLocked } from '../gantt/payment-lock';
import { runProjectTransaction } from '../scenario/publish';
import type { Random } from './random';

export type DriftField = 'name' | 'note' | 'progress' | 'start' | 'duration' | 'crew';

/** A start as the crowd moves it: through its constraint (a drag sets "start no earlier than"). */
export interface StartValue {
  constraintType: string | null;
  constraintDate: number | null;
  /** For the status page: the start it led to. */
  start: number | null;
}

export interface CrewValue {
  assignmentId: number;
  resourceId: number;
  resourceName: string;
}

export type DriftValue = string | number | StartValue | CrewValue | null;

export interface DriftEntry {
  key: string;
  taskId: number;
  taskName: string;
  field: DriftField;
  /** The value before the crowd first changed it. */
  seed: DriftValue;
  current: DriftValue;
  /** Crowd person id of who moved it. */
  by: string;
  byName: string;
  since: number;
  /** When it should be brought back (by someone else if possible). */
  dueAt: number;
  /** Failed attempts to bring it back. */
  attempts: number;
}

export function sameValue(field: DriftField, a: DriftValue, b: DriftValue): boolean {
  if (field === 'start') {
    const x = a as StartValue | null;
    const y = b as StartValue | null;
    return (x?.constraintType ?? null) === (y?.constraintType ?? null) && (x?.constraintDate ?? null) === (y?.constraintDate ?? null);
  }
  if (field === 'crew') return (a as CrewValue | null)?.resourceId === (b as CrewValue | null)?.resourceId;
  if (field === 'note' || field === 'name') return String(a ?? '').trim() === String(b ?? '').trim();
  return a === b;
}

export interface LedgerOptions {
  clock: Clock;
  random: Random;
  /** How long after a change it is due to be brought back (ms). */
  delayMs?: { min: number; max: number };
  /** How long past due before the person who made the change may bring it back themselves. */
  selfGraceMs?: number;
  /** Called with every entry after each change: the launcher keeps them, so a reload or a crash leaves no drift behind. */
  onChange?: (entries: DriftEntry[]) => void;
}

export class DriftLedger {
  private readonly entries = new Map<string, DriftEntry>();
  private readonly delay: { min: number; max: number };
  private readonly selfGraceMs: number;

  constructor(private readonly options: LedgerOptions) {
    this.delay = options.delayMs ?? { min: 90_000, max: 240_000 };
    this.selfGraceMs = options.selfGraceMs ?? 90_000;
  }

  /** Notes a change: a new displacement, a further change of one, or one brought back (then it is cleared). */
  /** Takes back entries kept from an earlier run (or before a reload); they are due soon. */
  load(entries: readonly DriftEntry[]): void {
    const now = this.options.clock.now();
    for (const entry of entries) {
      if (!entry || typeof entry.key !== 'string' || this.entries.has(entry.key)) continue;
      this.entries.set(entry.key, { ...entry, dueAt: Math.min(entry.dueAt, now + this.options.random.range(20_000, 60_000)), attempts: 0 });
    }
    this.changed();
  }

  record(change: { taskId: number; taskName: string; field: DriftField; before: DriftValue; after: DriftValue; by: string; byName: string }): void {
    this.update(change);
    this.changed();
  }

  private changed(): void {
    try {
      this.options.onChange?.(this.list());
    } catch (error) {
      console.warn('[crowd] could not hand over the ledger', error);
    }
  }

  private update(change: { taskId: number; taskName: string; field: DriftField; before: DriftValue; after: DriftValue; by: string; byName: string }): void {
    const key = `${change.taskId}:${change.field}`;
    const existing = this.entries.get(key);
    const now = this.options.clock.now();
    if (existing) {
      if (sameValue(change.field, change.after, existing.seed)) this.entries.delete(key);
      else this.entries.set(key, { ...existing, current: change.after, taskName: change.taskName });
      return;
    }
    if (sameValue(change.field, change.after, change.before)) return;
    this.entries.set(key, {
      key,
      taskId: change.taskId,
      taskName: change.taskName,
      field: change.field,
      seed: change.before,
      current: change.after,
      by: change.by,
      byName: change.byName,
      since: now,
      dueAt: now + this.options.random.range(this.delay.min, this.delay.max),
      attempts: 0,
    });
  }

  get(taskId: number, field: DriftField): DriftEntry | undefined {
    return this.entries.get(`${taskId}:${field}`);
  }

  /** Every entry, soonest due first. */
  list(): DriftEntry[] {
    return [...this.entries.values()].sort((a, b) => a.dueAt - b.dueAt);
  }

  get size(): number {
    return this.entries.size;
  }

  /** Entries this person may bring back now: due, and made by someone else (or long overdue). */
  due(personId: string, now = this.options.clock.now()): DriftEntry[] {
    return this.list().filter((entry) => entry.dueAt <= now && (entry.by !== personId || now >= entry.dueAt + this.selfGraceMs));
  }

  /**
   * Entries someone else made at least `minAgeMs` ago, oldest first: what a person with nothing else
   * left to change may bring back before it is due (still a while after it was made, never at once).
   */
  early(personId: string, minAgeMs: number, now = this.options.clock.now()): DriftEntry[] {
    return [...this.entries.values()].filter((entry) => entry.by !== personId && now - entry.since >= minAgeMs).sort((a, b) => a.since - b.since);
  }

  /** Displacements a person made that are still out. */
  countBy(personId: string): number {
    let count = 0;
    for (const entry of this.entries.values()) if (entry.by === personId) count++;
    return count;
  }

  countField(fields: readonly DriftField[]): number {
    let count = 0;
    for (const entry of this.entries.values()) if (fields.includes(entry.field)) count++;
    return count;
  }

  /** Makes entries due now (the handover moved, or the crowd is winding down). */
  expedite(filter: (entry: DriftEntry) => boolean = () => true): void {
    const now = this.options.clock.now();
    for (const entry of this.entries.values()) if (filter(entry)) entry.dueAt = Math.min(entry.dueAt, now);
    this.changed();
  }

  /** A try to bring it back failed: try again a little later, and give up after a few. */
  failed(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.attempts++;
    if (entry.attempts >= 4) this.entries.delete(key);
    else entry.dueAt = this.options.clock.now() + 20_000 * entry.attempts;
    this.changed();
  }

  drop(key: string): void {
    if (this.entries.delete(key)) this.changed();
  }
}

/** Kept between the crowd's date changes and the critical path: a task needs this much float beyond the change. */
export const FLOAT_MARGIN_DAYS = 2;

export interface GovernedChange {
  /** STM transaction title. */
  title: string;
  taskId: number;
  field: DriftField;
  /** The field's value as the ledger keeps it. */
  read(task: TaskModel, project: ProjectModel): DriftValue;
  write(task: TaskModel, project: ProjectModel): void;
  /** Dates may move (within float); otherwise the task's own dates must not. */
  movesDates: boolean;
  /** Bringing a value back: only the handover and the project end are checked (it moves nothing later). */
  restoring?: boolean;
}

export type ChangeOutcome = { ok: true; before: DriftValue; after: DriftValue } | { ok: false; reason: string };

export class Veto extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'Veto';
  }
}

export interface GovernorOptions {
  clock: Clock;
  random: Random;
  /** The handover milestone (load_project's handover_task_id), if the project names one. */
  handoverTaskId?: number | null;
  /** Tasks the crowd stays out of: booked equipment and anything being paid for. */
  offLimits?: () => ReadonlySet<number>;
  ledger?: Omit<LedgerOptions, 'clock' | 'random'>;
  /** Displacements one person may have out at once. */
  perPerson?: number;
  /** Date displacements (moves, resizes) the whole crowd may have out at once. */
  dateDisplacements?: number;
  /** A look-only crowd: every change is refused before anything is written, so nothing is ever sent. */
  lookOnly?: boolean;
}

interface Guard {
  handoverEnd: number | null;
  projectEnd: number | null;
  critical: string;
  /** Tasks finishing after their deadline. */
  late: Set<string>;
  taskStart: number | null;
  taskEnd: number | null;
  value: DriftValue;
}

const time = (value: unknown): number | null => (value instanceof Date && !Number.isNaN(value.getTime()) ? value.getTime() : null);
const fields = (task: TaskModel) => task as TaskModel & Record<string, unknown>;

export function isMilestone(task: TaskModel): boolean {
  const record = fields(task);
  return Boolean(record.isMilestone || record.milestone) || (task.isLeaf && Number(task.duration) === 0);
}

const words = (text: string) =>
  text
    .toLowerCase()
    .replace(/&/g, ' and ')
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3 && word !== 'and' && word !== 'the');

export class Governor {
  readonly ledger: DriftLedger;
  readonly stats = { applied: 0, vetoed: 0, restored: 0 };
  readonly perPerson: number;
  readonly dateDisplacements: number;
  private dateQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: GovernorOptions) {
    this.ledger = new DriftLedger({ clock: options.clock, random: options.random, ...options.ledger });
    this.perPerson = options.perPerson ?? 4;
    this.dateDisplacements = options.dateDisplacements ?? 2;
  }

  get handoverTaskId(): number | null {
    return this.options.handoverTaskId ?? null;
  }

  /** Nobody changes anything (`apply` refuses every change). */
  get lookOnly(): boolean {
    return this.options.lookOnly === true;
  }

  /** Why the crowd must leave a task alone, or null when it may work on it. */
  refusal(task: TaskModel | null | undefined): string | null {
    if (!task) return 'gone';
    const id = task.id;
    if (typeof id !== 'number') return 'not saved yet';
    if (!task.isLeaf) return 'a phase';
    if (isMilestone(task)) return 'a milestone';
    if (id === this.options.handoverTaskId) return 'the handover';
    if (isPaymentLocked(task)) return 'locked while paid';
    if (this.options.offLimits?.().has(id)) return 'booked or being paid';
    if (fields(task).inactive) return 'inactive';
    if (!(task.startDate instanceof Date) || !(task.endDate instanceof Date)) return 'not scheduled';
    return null;
  }

  /** Working days a task can move later (or grow) by without touching the critical path, the handover or the end. */
  room(task: TaskModel): number {
    const slack = Number(fields(task).totalSlack);
    const unit = String(fields(task).slackUnit ?? 'day');
    if (!Number.isFinite(slack) || !unit.startsWith('d')) return 0;
    return Math.max(0, Math.floor(slack) - FLOAT_MARGIN_DAYS);
  }

  /** A rename that keeps the meaning: most words stay, about the same length, plain text. Null when fine. */
  vetRename(original: string, next: string): string | null {
    const value = next.trim();
    if (!value || value === original.trim()) return 'no change';
    if (/[\n<>{}]|https?:|@/.test(value)) return 'not plain text';
    if (value.length > Math.min(120, original.length + 32) || value.length < original.length * 0.6) return 'length';
    const before = words(original);
    const after = new Set(words(value));
    const kept = before.filter((word) => after.has(word) || after.has(word.replace(/s$/, '')) || after.has(`${word}s`)).length;
    return before.length === 0 || kept / before.length >= 0.7 ? null : 'changes the meaning';
  }

  /** A note: a sentence or two of plain text. */
  vetNote(text: string): string | null {
    const value = text.trim();
    if (value.length < 4 || value.length > 240) return 'length';
    if (/[<>{}]|https?:|@/.test(value)) return 'not plain text';
    if (value.split('\n').length > 3) return 'too many lines';
    return null;
  }

  /** Whether `personId` may displace this field (a new ledger entry) now, or change it further. */
  mayDisplace(personId: string, taskId: number, field: DriftField): boolean {
    const entry = this.ledger.get(taskId, field);
    if (entry) return entry.by === personId;
    if (this.ledger.countBy(personId) >= this.perPerson) return false;
    if ((field === 'start' || field === 'duration') && this.ledger.countField(['start', 'duration']) >= this.dateDisplacements) return false;
    // A task carries one date displacement at a time.
    if (field === 'start' && this.ledger.get(taskId, 'duration')) return false;
    if (field === 'duration' && this.ledger.get(taskId, 'start')) return false;
    return true;
  }

  /** Date changes run one at a time across the whole crowd, so their float checks never add up behind each other's back. */
  serialDates<T>(run: () => Promise<T>): Promise<T> {
    const result = this.dateQueue.then(run, run);
    this.dateQueue = result.catch(() => undefined);
    return result;
  }

  /**
   * Makes the change as one transaction and checks the result before it is kept: rolled back (nothing
   * sent) when the engine refused it or it moved more than it may. On success the ledger notes it.
   */
  async apply(project: ProjectModel, change: GovernedChange, who: { id: string; name: string }): Promise<ChangeOutcome> {
    // Before any transaction is opened: a look-only crowd never writes, not even to bring something back.
    if (this.lookOnly) return this.veto('look-only: nobody changes anything');
    const task = project.taskStore.getById(change.taskId) as TaskModel | undefined;
    const refused = this.refusal(task);
    if (refused) return this.veto(`${task?.name ?? `task ${change.taskId}`}: ${refused}`);
    let before: Guard | null = null;
    let after: Guard | null = null;
    let rejected = false;
    const detach = project.on('commitRejected', () => {
      rejected = true;
    }) as unknown as (() => void) | undefined;
    try {
      await runProjectTransaction(project, change.title, [
        () => {
          const live = project.taskStore.getById(change.taskId) as TaskModel | undefined;
          const late = this.refusal(live);
          if (late || !live) throw new Veto(late ?? 'gone');
          before = this.guard(project, live, change);
        },
        () => change.write(project.taskStore.getById(change.taskId) as TaskModel, project),
        () => {
          const live = project.taskStore.getById(change.taskId) as TaskModel;
          after = this.guard(project, live, change);
          const problem = rejected ? 'the scheduler refused it' : this.compare(before!, after, change);
          if (problem) throw new Veto(problem);
        },
      ]);
    } catch (error) {
      return this.veto(error instanceof Veto ? error.message : error instanceof Error ? error.message : String(error));
    } finally {
      detach?.();
    }
    const done = { before: before as Guard | null, after: after as Guard | null };
    if (!done.before || !done.after) return this.veto('not checked');
    const live = project.taskStore.getById(change.taskId) as TaskModel | undefined;
    this.ledger.record({ taskId: change.taskId, taskName: live?.name ?? '', field: change.field, before: done.before.value, after: done.after.value, by: who.id, byName: who.name });
    if (change.restoring) this.stats.restored++;
    else this.stats.applied++;
    return { ok: true, before: done.before.value, after: done.after.value };
  }

  private veto(reason: string): ChangeOutcome {
    this.stats.vetoed++;
    return { ok: false, reason };
  }

  private guard(project: ProjectModel, task: TaskModel, change: GovernedChange): Guard {
    const handover = this.options.handoverTaskId != null ? (project.taskStore.getById(this.options.handoverTaskId) as TaskModel | undefined) : undefined;
    const critical: string[] = [];
    const late = new Set<string>();
    if (change.movesDates && !change.restoring) {
      for (const leaf of project.taskStore.leaves as TaskModel[]) {
        if (fields(leaf).critical) critical.push(String(leaf.id));
        const deadline = time(fields(leaf).deadlineDate);
        const end = time(leaf.endDate);
        if (deadline !== null && end !== null && end > deadline) late.add(String(leaf.id));
      }
    }
    return {
      handoverEnd: time(handover?.endDate),
      projectEnd: time((project as unknown as { endDate?: Date }).endDate),
      critical: critical.sort().join(','),
      late,
      taskStart: time(task.startDate),
      taskEnd: time(task.endDate),
      value: change.read(task, project),
    };
  }

  private compare(before: Guard, after: Guard, change: GovernedChange): string | null {
    if (change.restoring) {
      if (before.handoverEnd !== null && after.handoverEnd !== null && after.handoverEnd > before.handoverEnd) return 'the handover would move';
      if (before.projectEnd !== null && after.projectEnd !== null && after.projectEnd > before.projectEnd) return 'the project end would move';
      return null;
    }
    if (before.handoverEnd !== after.handoverEnd) return 'the handover would move';
    if (before.projectEnd !== after.projectEnd) return 'the project end would move';
    if (change.movesDates) {
      if (before.critical !== after.critical) return 'the critical path would change';
      if ([...after.late].some((id) => !before.late.has(id))) return 'a task would miss its deadline';
    } else if (before.taskStart !== after.taskStart || before.taskEnd !== after.taskEnd) {
      return 'the task’s dates would move';
    }
    return null;
  }
}
