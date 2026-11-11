/**
 * A busy site office: N simulated people working in one project at once. The crowd shares the
 * governor (and its drift ledger), the task claims, what the people say and the scheduler; each person
 * brings their own signed-in session (person.ts). Works the same over Supabase (boot.ts) and in memory
 * (the tests).
 */
import type { ProjectModel, TaskModel } from '@bryntum/gantt';
import { systemClock, type Clock } from '../presence/clock';
import { branchAreas, partitionAreas } from './areas';
import { ContentBook, suggestionRequest, type SuggestionRequest } from './content';
import { Governor, type DriftEntry, type GovernorOptions } from './governor';
import { SimPerson, type CrowdShared, type PersonParts, type PersonStatus } from './person';
import { Random } from './random';
import { CrowdScheduler, TaskClaims } from './scheduler';

export interface CrowdOptions {
  projectName: string;
  handoverTaskId: number | null;
  offLimits?: () => ReadonlySet<number>;
  clock?: Clock;
  seed?: number;
  cadenceMs?: { min: number; max: number };
  ledger?: GovernorOptions['ledger'];
  perPerson?: number;
  /** Asks the launcher's language model for intents, notes and renames (absent: canned only). */
  suggest?: (request: SuggestionRequest) => Promise<unknown>;
  /** How often fresh suggestions are asked for (ms). */
  suggestEveryMs?: number;
  /** Ledger entries kept from before (a reload, a crashed run): brought back first. */
  ledgerEntries?: readonly DriftEntry[];
  /**
   * The people only look (pointers, selections, the task panel, scrolling): no change is made, nothing
   * is brought back and nothing is asked of the language model, so they never send a revision.
   */
  lookOnly?: boolean;
  /** The grid columns the people's screens show (screen.ts `viewerColumns`); default: all of them. */
  screenColumns?: readonly string[];
  /**
   * One part of the plan per person, in the order they were added: a summary task's name or WBS code
   * ("Site and foundations", "2"). Each works only under theirs, and brings back only their own changes,
   * so what each one is doing stays in one place. Absent: the tasks are shared out by trade.
   */
  branches?: readonly string[];
  onLog?: (line: string) => void;
}

export interface LogLine {
  at: number;
  who: string;
  color: string;
  text: string;
}

export interface CrowdStatus {
  running: boolean;
  people: (PersonStatus & { area: number })[];
  ledger: (DriftEntry & { dueIn: number })[];
  governor: Governor['stats'];
  content: ContentBook['counts'];
  handover: { baseline: number | null; now: number | null };
  log: LogLine[];
}

const time = (value: unknown): number | null => (value instanceof Date && !Number.isNaN(value.getTime()) ? value.getTime() : null);

export class Crowd {
  readonly clock: Clock;
  readonly governor: Governor;
  readonly claims = new TaskClaims();
  readonly content: ContentBook;
  readonly people: SimPerson[] = [];
  private readonly random: Random;
  private readonly scheduler: CrowdScheduler;
  private areas = new Map<string, readonly number[]>();
  private pool: readonly number[] = [];
  /** Person id → the part of the plan they are pinned to (empty: shared out by trade). */
  private branchOf = new Map<string, string>();
  private warnedMissing = false;
  private readonly lines: LogLine[] = [];
  private timers: unknown[] = [];
  private handoverBaseline: number | null = null;
  private running = false;

  constructor(private readonly options: CrowdOptions) {
    this.clock = options.clock ?? systemClock;
    this.random = new Random(options.seed ?? Date.now());
    this.governor = new Governor({
      clock: this.clock,
      random: this.random.fork(),
      handoverTaskId: options.handoverTaskId,
      offLimits: options.offLimits,
      ledger: options.ledger,
      perPerson: options.perPerson,
      lookOnly: options.lookOnly,
    });
    // A look-only crowd brings nothing back: an earlier run's drift is left to a crowd that edits.
    if (options.ledgerEntries?.length && !options.lookOnly) this.governor.ledger.load(options.ledgerEntries);
    this.content = new ContentBook(this.governor, this.random.fork());
    this.scheduler = new CrowdScheduler({
      clock: this.clock,
      random: this.random.fork(),
      cadenceMs: options.cadenceMs,
      onError: (actor, error) => this.people.find((person) => person.id === actor.id)?.fail(error),
    });
  }

  /** Nobody changes anything. */
  get lookOnly(): boolean {
    return this.options.lookOnly === true;
  }

  private get shared(): CrowdShared {
    return {
      clock: this.clock,
      lookOnly: this.lookOnly,
      screenColumns: this.options.screenColumns,
      governor: this.governor,
      claims: this.claims,
      content: this.content,
      areas: () => this.areas,
      pool: () => this.pool,
      pinned: () => this.branchOf.size > 0,
      log: (person, text) => this.log(person, text),
    };
  }

  add(parts: PersonParts): SimPerson {
    const person = new SimPerson(parts, this.shared, this.random.fork());
    this.people.push(person);
    if (this.running) {
      this.divide();
    }
    return person;
  }

  /** Rebuilds a person on a new session (theirs fell out of sync): same person, same place in the schedule. */
  replace(personId: string, parts: PersonParts): SimPerson | null {
    const index = this.people.findIndex((person) => person.id === personId);
    if (index < 0) return null;
    this.people[index]!.dispose();
    const person = new SimPerson(parts, this.shared, this.random.fork());
    this.people[index] = person;
    this.scheduler.replace(person);
    this.log(person, 'back after reconnecting');
    return person;
  }

  /** The project as the first person sees it (they all converge on the same one). */
  private get project(): ProjectModel | null {
    return this.people[0]?.parts.project ?? null;
  }

  /** Splits the editable tasks among the people. */
  divide(): void {
    const project = this.project;
    if (!project) return;
    const tasks = (project.taskStore.leaves as TaskModel[]).filter((task) => !this.governor.refusal(task));
    const branches = this.options.branches ?? [];
    if (branches.length) {
      const pinned = branchAreas(
        project,
        tasks,
        this.people.map((person) => person.id),
        branches,
      );
      if ('areas' in pinned) {
        this.areas = pinned.areas;
        this.branchOf = pinned.names;
        // Nobody borrows from another part of the plan.
        this.pool = [];
        return;
      }
      if (!this.warnedMissing) this.options.onLog?.(`[crowd] the plan has no “${pinned.missing}”: the tasks are shared out by trade instead`);
      this.warnedMissing = true;
    }
    this.branchOf = new Map();
    this.pool = tasks.map((task) => task.id as number);
    this.areas = partitionAreas(
      tasks,
      this.people.map((person) => person.persona),
    );
  }

  start(): void {
    if (this.running || !this.people.length) return;
    this.running = true;
    this.divide();
    const project = this.project!;
    this.handoverBaseline = this.handoverEnd(project);
    for (const person of this.people) {
      const area = this.areas.get(person.id)?.length ?? 0;
      const branch = this.branchOf.get(person.id);
      this.log(person, this.lookOnly ? 'on site, looking only (no changes)' : `on site, looking after ${area} task${area === 1 ? '' : 's'}${branch ? ` in ${branch}` : ''}`);
    }
    this.scheduler.start(this.people);
    if (this.options.suggest && !this.lookOnly) {
      void this.askForSuggestions();
      this.every(this.options.suggestEveryMs ?? 600_000, () => void this.askForSuggestions());
    }
    // New or removed tasks: shares are worked out again now and then.
    this.every(120_000, () => this.divide());
    // The handover moved (someone, maybe a real person, pushed it): date displacements are brought back now.
    this.every(5_000, () => this.watchHandover());
  }

  private every(ms: number, run: () => void): void {
    const tick = () => {
      if (!this.running) return;
      try {
        run();
      } catch (error) {
        this.options.onLog?.(`[crowd] ${error instanceof Error ? error.message : String(error)}`);
      }
      this.timers.push(this.clock.setTimeout(tick, ms));
    };
    this.timers.push(this.clock.setTimeout(tick, ms));
  }

  private handoverEnd(project: ProjectModel): number | null {
    // After winding down the sessions (and their projects) are gone.
    if ((project as unknown as { isDestroyed?: boolean }).isDestroyed || !project.taskStore) return null;
    const id = this.options.handoverTaskId;
    const handover = id != null ? (project.taskStore.getById(id) as TaskModel | undefined) : undefined;
    return time(handover?.endDate) ?? time((project as unknown as { endDate?: Date }).endDate);
  }

  private watchHandover(): void {
    const project = this.project;
    if (!project || this.handoverBaseline === null) return;
    const now = this.handoverEnd(project);
    if (now !== null && now > this.handoverBaseline) this.governor.ledger.expedite((entry) => entry.field === 'start' || entry.field === 'duration');
  }

  private async askForSuggestions(): Promise<void> {
    const project = this.project;
    if (!project || !this.options.suggest) return;
    const request = suggestionRequest(
      this.options.projectName,
      this.people.map((person) => ({
        persona: person.persona,
        tasks: (this.areas.get(person.id) ?? []).map((id) => project.taskStore.getById(id) as TaskModel | undefined).filter((task): task is TaskModel => Boolean(task)),
      })),
    );
    try {
      const raw = await this.options.suggest(request);
      if (raw == null) return;
      const { accepted, rejected } = this.content.accept(raw, this.areas, project);
      this.options.onLog?.(`[crowd] suggestions: ${accepted} taken, ${rejected} turned down by the governor`);
    } catch (error) {
      this.options.onLog?.(`[crowd] no suggestions this time (${error instanceof Error ? error.message : String(error)}); canned text it is`);
    }
  }

  /**
   * Stops making changes and brings everything in the ledger back, each entry by someone other than
   * who moved it when possible. Resolves once every revision has left (or `timeoutMs` passed).
   */
  async windDown(timeoutMs = 30_000): Promise<DriftEntry[]> {
    this.running = false;
    for (const timer of this.timers) this.clock.clearTimeout(timer);
    this.timers = [];
    await this.scheduler.stop();
    for (const person of this.people) person.stop();
    const deadline = this.clock.now() + timeoutMs;
    // (A look-only crowd moved nothing: its ledger stays empty.)
    for (let round = 0; round < 4 && !this.lookOnly && this.governor.ledger.size > 0 && this.clock.now() < deadline; round++) {
      for (const entry of this.governor.ledger.list()) {
        const others = this.people.filter((person) => person.id !== entry.by);
        // Pinned to parts of the plan: whoever works there brings it back.
        const owner = this.branchOf.size > 0 ? this.people.find((person) => this.areas.get(person.id)?.includes(entry.taskId)) : undefined;
        const person = owner ?? this.random.pick(others.length ? others : this.people);
        if (!person) break;
        try {
          await person.restoreNow(entry);
        } catch (error) {
          person.fail(error);
        }
      }
    }
    await Promise.all(
      this.people.map(async (person) => {
        while (person.parts.sync.state.pending > 0 && this.clock.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
      }),
    );
    return this.governor.ledger.list();
  }

  dispose(): void {
    this.running = false;
    for (const timer of this.timers) this.clock.clearTimeout(timer);
    this.timers = [];
    void this.scheduler.stop();
    for (const person of this.people) person.dispose();
  }

  status(): CrowdStatus {
    const now = this.clock.now();
    const project = this.project;
    return {
      running: this.running,
      people: this.people.map((person) => ({ ...person.status, area: this.areas.get(person.id)?.length ?? 0 })),
      ledger: this.governor.ledger.list().map((entry) => ({ ...entry, dueIn: entry.dueAt - now })),
      governor: { ...this.governor.stats },
      content: { ...this.content.counts },
      handover: { baseline: this.handoverBaseline, now: project ? this.handoverEnd(project) : null },
      log: [...this.lines],
    };
  }

  private log(person: SimPerson, text: string): void {
    const line = { at: this.clock.now(), who: person.parts.displayName, color: person.persona.person.color, text };
    this.lines.unshift(line);
    if (this.lines.length > 80) this.lines.length = 80;
    this.options.onLog?.(`[crowd] ${person.persona.firstName}: ${text}`);
  }
}
