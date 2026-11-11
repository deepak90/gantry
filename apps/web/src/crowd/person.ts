/**
 * One simulated person at work: their own project copy, revision stream and presence (the same code
 * path as a browser tab), a virtual screen with a hand on the mouse, and the moves that lead up to each
 * change, so the others see it coming: the pointer travels to the cell or the bar, hesitates, selects,
 * the flag shows them typing (or the row shows them in the task panel, or the bar is outlined while
 * they drag it), and then the change lands. Between changes they look around. Nothing they do fails
 * loudly: a refused change is logged and they move on.
 *
 * In a look-only crowd they never change anything: where a change would come they open the task panel
 * on a row and read it, rest on a bar, select a cell or go over to what a colleague has selected, and
 * they keep to the part of the plan a viewer opening it has on screen (the upper rows, the first weeks).
 */
import type { ProjectModel, TaskModel } from '@bryntum/gantt';
import type { Clock } from '../presence/clock';
import type { PresenceSession } from '../presence/session';
import type { RevisionSync } from '../sync/revision-sync';
import { chooseLook, choosePlan, restorePlan, type LookKind, type Plan } from './brain';
import { crewNames, type ContentBook, type Intent } from './content';
import type { DriftEntry, Governor } from './governor';
import { Hand } from './hand';
import type { Vec } from './motion';
import type { Persona } from './personas';
import type { Random } from './random';
import type { TaskClaims } from './scheduler';
import { singleCell, VirtualScreen } from './screen';
import { syntheticViewport } from './viewport';

/** A signed-in simulated person's session: the parts a browser tab has. */
export interface PersonParts {
  persona: Persona;
  /** As presence and History show them ("Marcus Webb (sim)"). */
  displayName: string;
  project: ProjectModel;
  sync: RevisionSync;
  presence: PresenceSession;
  sessionId: string;
}

/** What the people of one crowd share. */
export interface CrowdShared {
  clock: Clock;
  /** They only look: no plan is made, nothing lands, nothing is brought back. */
  lookOnly?: boolean;
  /** The grid columns their screens show (VirtualScreen's default when absent). */
  screenColumns?: readonly string[];
  governor: Governor;
  claims: TaskClaims;
  content: ContentBook;
  /** Person id → their tasks. */
  areas(): ReadonlyMap<string, readonly number[]>;
  /** Every task the crowd may work on. */
  pool(): readonly number[];
  /** Each person is pinned to one part of the plan: they bring back only what was changed there. */
  pinned?(): boolean;
  log(person: SimPerson, line: string): void;
}

export type PersonState = 'starting' | 'browsing' | 'working' | 'error' | 'stopped';

export interface PersonStatus {
  id: string;
  name: string;
  color: string;
  state: PersonState;
  intent: string | null;
  intentSource: 'llm' | 'canned' | null;
  last: string | null;
  lastAt: number | null;
  changes: number;
  restores: number;
  vetoes: number;
  backedOff: number;
  errors: number;
  lastError: string | null;
  pointerUpdates: number;
  followers: number;
  connection: string;
  sync: string;
}

const firstName = (name: string) => name.split(' ')[0] ?? name;

/**
 * Look-only: the rows below the top of their view and the days from the start of their timeline they
 * keep to. A viewer who opens the plan has these on screen too (about 16 rows and 23 days or more in a
 * 1280 px wide window), so the pointer is where it can be seen, not parked at the edge with an arrow.
 */
const LOOK_ROWS = 11;
const LOOK_DAYS = 16;

export class SimPerson {
  readonly id: string;
  readonly screen: VirtualScreen;
  readonly hand: Hand;
  /** Where their screen started (the opening view): a look-only person scrolls only a little from it. */
  private readonly home: Vec;
  private intent: Intent | null = null;
  /** Their last changes, newest first. */
  private readonly recent: { taskId: number; kind: Plan['kind'] }[] = [];
  private stopped = false;
  private readonly state: Omit<PersonStatus, 'pointerUpdates' | 'followers' | 'connection' | 'sync'>;

  constructor(
    readonly parts: PersonParts,
    private readonly shared: CrowdShared,
    private readonly random: Random,
  ) {
    this.id = parts.persona.person.id;
    this.screen = new VirtualScreen(parts.project, shared.screenColumns ? { columns: shared.screenColumns } : {});
    this.home = this.screen.scroll;
    // Look-only: the pointer shows up where a viewer of the opening view can see it.
    const start = shared.lookOnly ? this.somewhereInView() : undefined;
    this.hand = new Hand({ screen: this.screen, clock: shared.clock, random, send: (point) => parts.presence.moveCursor(point), ...(start ? { start } : {}) });
    this.state = {
      id: this.id,
      name: parts.displayName,
      color: parts.persona.person.color,
      state: 'starting',
      intent: null,
      intentSource: null,
      last: null,
      lastAt: null,
      changes: 0,
      restores: 0,
      vetoes: 0,
      backedOff: 0,
      errors: 0,
      lastError: null,
    };
    parts.presence.attachViewport(syntheticViewport(this.screen));
  }

  get persona(): Persona {
    return this.parts.persona;
  }

  get who(): { id: string; name: string } {
    return { id: this.id, name: this.parts.displayName };
  }

  get status(): PersonStatus {
    const snapshot = this.parts.presence.getSnapshot();
    // (Readable after the session is gone: presence and sync keep their last state.)
    const sync = this.parts.sync.state;
    return {
      ...this.state,
      pointerUpdates: this.hand.sent,
      followers: snapshot.followers.length,
      connection: snapshot.status,
      sync: sync.status === 'error' ? `error: ${sync.error ?? ''}` : `${sync.status} @${sync.lastRevision}`,
    };
  }

  /** The intent line as the status page shows it: "Tom is chasing the riser inspections". */
  get intentLine(): string | null {
    return this.intent ? `${firstName(this.parts.persona.person.name)} is ${this.intent.text}` : null;
  }

  stop(): void {
    this.stopped = true;
    this.state.state = 'stopped';
  }

  dispose(): void {
    this.stop();
    this.hand.dispose();
    this.shared.claims.releaseAll(this.id);
    this.parts.presence.attachViewport(null);
    this.screen.dispose();
  }

  fail(error: unknown): void {
    this.state.errors++;
    this.state.lastError = error instanceof Error ? error.message : String(error);
    this.shared.log(this, `error: ${this.state.lastError}`);
  }

  // ---- the scheduler's side -------------------------------------------------------------------

  /** One change (or a look around when nothing fits right now; always, in a look-only crowd). */
  async turn(): Promise<void> {
    if (this.stopped) return;
    if (this.parts.sync.state.status === 'error') {
      this.state.state = 'error';
      return;
    }
    if (this.shared.lookOnly) {
      // Where a change would come, something the others notice instead; nothing is ever planned.
      this.state.state = 'browsing';
      this.state.intent ??= `${firstName(this.parts.persona.person.name)} is looking around (look-only)`;
      const left = this.random.range(3_500, 6_500);
      await this.look(chooseLook(this.random, { left, lookOnly: true, turn: true, colleague: this.colleagueTask() !== null }) ?? 'read', left);
      return;
    }
    const now = this.shared.clock.now();
    if (!this.intent || now >= this.intent.until) this.newIntent(now);
    const plan = choosePlan({
      persona: this.persona,
      who: this.who,
      project: this.parts.project,
      governor: this.shared.governor,
      content: this.shared.content,
      area: this.shared.areas().get(this.id) ?? [],
      pool: this.shared.pool(),
      pinned: this.shared.pinned?.() === true,
      busy: (taskId) => this.busy(taskId),
      intent: this.intent,
      recent: this.recent,
      random: this.random,
      now,
    });
    if (!plan) {
      this.state.state = 'browsing';
      await this.lookAround(now + this.random.range(2_000, 4_000));
      return;
    }
    this.state.state = 'working';
    await this.perform(plan);
    this.state.state = 'browsing';
  }

  /** Looks around without changing anything until about `until`. */
  async idleUntil(until: number): Promise<void> {
    if (this.stopped) {
      // Stopped (being rebuilt or winding down): wait it out, never spin.
      await new Promise<void>((resolve) => this.shared.clock.setTimeout(resolve, Math.max(250, until - this.shared.clock.now())));
      return;
    }
    if (this.state.state === 'starting') this.state.state = 'browsing';
    await this.lookAround(until);
  }

  /** Brings a ledger entry back at once (winding down): the short version of the moves. */
  async restoreNow(entry: DriftEntry): Promise<boolean> {
    // A look-only person moved nothing and brings nothing back.
    if (this.shared.lookOnly) return false;
    const plan = restorePlan({ project: this.parts.project, random: this.random }, entry);
    if (!plan) {
      this.shared.governor.ledger.drop(entry.key);
      return false;
    }
    if (!this.shared.claims.claim(plan.taskId, this.id)) return false;
    try {
      this.select(plan.taskId, plan.via === 'cell' ? plan.column : null);
      this.parts.presence.setActivity({ kind: plan.via === 'panel' ? 'panel' : plan.via === 'bar' ? (plan.grip === 'end' ? 'resizing' : 'moving') : 'editing', taskId: plan.taskId, column: plan.via === 'cell' ? plan.column : null });
      return await this.land(plan, { force: true });
    } finally {
      this.parts.presence.setActivity(null);
      this.shared.claims.release(plan.taskId, this.id);
    }
  }

  private newIntent(now: number): void {
    const area = (this.shared.areas().get(this.id) ?? [])
      .map((id) => this.parts.project.taskStore.getById(id) as TaskModel | undefined)
      .filter((task): task is TaskModel => Boolean(task));
    this.intent = this.shared.content.intent(this.persona, area, now);
    this.state.intent = this.intentLine;
    this.state.intentSource = this.intent.source;
    this.shared.log(this, `now ${this.intent.text}`);
  }

  /** Someone else is on this task: another simulated person's claim, or anyone's selection or activity. */
  busy(taskId: number): boolean {
    const holder = this.shared.claims.holder(taskId);
    if (holder !== undefined && holder !== this.id) return true;
    for (const peer of this.parts.presence.getSnapshot().peers) {
      if (peer.taskId === taskId || peer.active?.taskId === taskId || peer.activity?.taskId === taskId) return true;
      if (peer.cells.some((row) => row.taskId === taskId)) return true;
    }
    return false;
  }

  // ---- doing it -------------------------------------------------------------------------------

  private async perform(plan: Plan): Promise<void> {
    const { claims } = this.shared;
    if (!claims.claim(plan.taskId, this.id)) return;
    try {
      const task = this.parts.project.taskStore.getById(plan.taskId) as TaskModel | undefined;
      if (!task) return;
      await this.bringIntoView(task, plan);
      if (plan.via === 'bar') await this.barEdit(task, plan);
      else if (plan.via === 'panel') await this.panelEdit(plan);
      else await this.cellEdit(plan);
    } catch (error) {
      this.fail(error);
      this.parts.presence.setActivity(null);
    } finally {
      claims.release(plan.taskId, this.id);
    }
  }

  /** Makes the change through the governor; false when it was refused or someone else got there first. */
  private async land(plan: Plan, options: { force?: boolean } = {}): Promise<boolean> {
    if (this.shared.lookOnly) {
      // Never reached (a look-only person makes no plan); refused here as well as by the governor.
      this.state.vetoes++;
      return false;
    }
    if (!options.force && this.busy(plan.taskId)) {
      this.state.backedOff++;
      this.shared.log(this, `backed off ${plan.summary}: someone else is on it`);
      return false;
    }
    const { governor } = this.shared;
    const run = () => governor.apply(this.parts.project, plan.change, this.who);
    const outcome = plan.change.movesDates
      ? await governor.serialDates(async () => {
          // Float is checked on the latest plan.
          await this.parts.sync.catchUpNow().catch(() => undefined);
          return run();
        })
      : await run();
    if (!outcome.ok) {
      this.state.vetoes++;
      this.shared.log(this, `governor said no to “${plan.summary}”: ${outcome.reason}`);
      if (plan.restores) governor.ledger.failed(plan.restores.key);
      return false;
    }
    if (plan.restores) this.state.restores++;
    else this.state.changes++;
    this.recent.unshift({ taskId: plan.taskId, kind: plan.kind });
    this.recent.length = Math.min(this.recent.length, 4);
    this.state.last = plan.summary;
    this.state.lastAt = this.shared.clock.now();
    this.shared.log(this, plan.summary);
    return true;
  }

  private select(taskId: number | null, column: string | null): void {
    const { presence } = this.parts;
    presence.setSelectedTask(taskId);
    if (taskId !== null && column) presence.setCellSelection(singleCell(taskId, column), { taskId, column });
    else presence.setCellSelection([], null);
    this.screen.setSelected(taskId);
  }

  private async bringIntoView(task: TaskModel, plan: Plan): Promise<void> {
    this.screen.reveal(task.id as number);
    let dates: { from: Date; to: Date } | undefined;
    if (plan.via === 'bar' && task.startDate instanceof Date && task.endDate instanceof Date) {
      const shift = (plan.dragDays ?? 0) * 86_400_000;
      dates = { from: new Date(Math.min(task.startDate.getTime(), task.startDate.getTime() + shift)), to: new Date(Math.max(task.endDate.getTime(), task.endDate.getTime() + shift)) };
    }
    const target = this.screen.scrollToShow(task.id as number, dates);
    const { x, y } = this.screen.scroll;
    if (Math.abs(target.x - x) > 2 || Math.abs(target.y - y) > 2) {
      await this.hand.scroll(target);
      await this.hand.hold(this.random.range(150, 400));
    }
  }

  private async cellEdit(plan: Plan): Promise<void> {
    const column = plan.column ?? 'task';
    const rect = this.screen.cellRect(plan.taskId, column);
    if (!rect) return;
    const { hand, random } = this;
    await hand.move({ x: rect.x + rect.width * random.range(0.15, 0.6), y: rect.y + rect.height * random.range(0.35, 0.65) }, { targetWidth: Math.min(rect.width, rect.height) });
    await hand.hold(random.range(150, 450));
    this.select(plan.taskId, column);
    await hand.drift(random.range(250, 700), { radius: 5 });
    const { presence } = this.parts;
    presence.setActivity({ kind: 'editing', taskId: plan.taskId, column });
    const typing = plan.kind === 'rename' ? random.range(1_600, 3_000) : random.range(1_000, 2_400);
    await hand.drift(typing, { radius: 7 });
    await this.land(plan);
    presence.setActivity(null);
    await hand.drift(random.range(300, 900), { radius: 14 });
  }

  private async panelEdit(plan: Plan): Promise<void> {
    const rect = this.screen.cellRect(plan.taskId, 'task');
    if (!rect) return;
    const { hand, random, screen } = this;
    await hand.move({ x: rect.x + rect.width * random.range(0.2, 0.7), y: rect.y + rect.height * random.range(0.35, 0.65) }, { targetWidth: rect.height });
    await hand.hold(random.range(150, 400));
    this.select(plan.taskId, null);
    // Over to the task panel, at the right of the plan.
    await hand.move({ x: screen.bounds.right - random.range(0, 10), y: hand.position.y + random.range(-80, 80) }, { pace: 0.9 });
    hand.leave();
    const { presence } = this.parts;
    presence.setActivity({ kind: 'panel', taskId: plan.taskId, column: null });
    await hand.hold(random.range(2_400, 4_800));
    await this.land(plan);
    await hand.hold(random.range(300, 900));
    presence.setActivity(null);
    hand.enter({ x: screen.bounds.right - 2, y: random.range(screen.height * 0.2, screen.height * 0.8) });
    await hand.move(this.somewhereInView(), { pace: 1.1 });
  }

  private async barEdit(task: TaskModel, plan: Plan): Promise<void> {
    const bar = this.screen.barRect(task);
    if (!bar) return;
    const { hand, random, screen } = this;
    const end = plan.grip === 'end';
    const grab: Vec = { x: end ? bar.x + bar.width - random.range(2, 5) : bar.x + bar.width * random.range(0.3, 0.7), y: bar.y + bar.height * random.range(0.3, 0.7) };
    await hand.move(grab, { targetWidth: end ? 8 : Math.min(bar.width, 40) });
    await hand.hold(random.range(200, 500));
    this.select(plan.taskId, null);
    const { presence } = this.parts;
    presence.setActivity({ kind: end ? 'resizing' : 'moving', taskId: plan.taskId, column: null });
    await hand.hold(random.range(80, 200));
    const dx = (plan.dragDays ?? 1) * screen.pxPerDay;
    // A drag is slower and flatter than a reach, and snaps to the day it lands on.
    await hand.move({ x: grab.x + dx, y: grab.y + random.range(-3, 3) }, { pace: random.range(1.5, 2.2), bow: random.range(0.01, 0.05), targetWidth: screen.pxPerDay * 0.6 });
    await hand.hold(random.range(150, 350));
    await this.land(plan);
    presence.setActivity(null);
    await hand.drift(random.range(300, 800), { radius: 12 });
  }

  // ---- looking around -------------------------------------------------------------------------

  /** Look-only: the bottom and right edges (screen pixels) of the part of their screen they keep to. */
  private lookRegion(): { bottom: number; right: number } {
    const { screen } = this;
    return {
      bottom: Math.min(screen.bounds.bottom, LOOK_ROWS * screen.rowHeight),
      right: Math.min(screen.bounds.right, screen.timelineLeft + LOOK_DAYS * screen.pxPerDay),
    };
  }

  /** Look-only: where the timeline part of that region starts, a little after the left edge of the view. */
  private get lookLeft(): number {
    return this.screen.timelineLeft + 2 * this.screen.pxPerDay;
  }

  private somewhereInView(): Vec {
    const { screen, random } = this;
    const onTimeline = random.chance(0.6);
    if (this.shared.lookOnly) {
      const { bottom, right } = this.lookRegion();
      return {
        x: onTimeline ? random.range(this.lookLeft, right - 20) : random.range(30, screen.gridWidth - 60),
        y: random.range(screen.rowHeight * 0.5, bottom - screen.rowHeight * 0.5),
      };
    }
    return {
      x: onTimeline ? random.range(screen.timelineLeft + 20, screen.bounds.right - 20) : random.range(30, screen.gridWidth - 60),
      y: random.range(screen.rowHeight * 0.5, screen.height - screen.rowHeight),
    };
  }

  /** A row on their screen to look at (look-only: one of the upper rows). */
  private rowToLookAt(): number | undefined {
    const { screen, random } = this;
    const rows = screen.rowIds;
    const first = Math.floor(screen.scroll.y / screen.rowHeight);
    const shown = Math.max(1, Math.floor(screen.height / screen.rowHeight) - 2);
    return rows[Math.min(rows.length - 1, first + random.int(1, this.shared.lookOnly ? Math.min(shown, LOOK_ROWS - 1) : shown))];
  }

  /** Look-only: an x on the timeline along `taskId`'s row: on its bar where that is in view, else in the first days shown. */
  private alongRow(taskId: number): number {
    const { random, screen } = this;
    const right = this.lookRegion().right - 20;
    const task = this.parts.project.taskStore.getById(taskId) as TaskModel | undefined;
    const bar = task ? screen.barRect(task) : null;
    const from = bar ? Math.max(bar.x, this.lookLeft) : 0;
    const to = bar ? Math.min(bar.x + bar.width, right) : 0;
    return to - from >= 12 ? random.range(from, to) : random.range(this.lookLeft, Math.min(right, this.lookLeft + 8 * screen.pxPerDay));
  }

  /** Look-only: the rows in the part of their screen they keep to. */
  private rowsInRegion(): number[] {
    const { screen } = this;
    const first = Math.floor(screen.scroll.y / screen.rowHeight);
    return screen.rowIds.slice(first, first + LOOK_ROWS);
  }

  /** Look-only: a task another simulated person has selected, among the rows this person keeps to. */
  private colleagueTask(): number | null {
    const rows = new Set(this.rowsInRegion());
    for (const peer of this.parts.presence.getSnapshot().peers) {
      if (peer.simulated && peer.taskId !== null && rows.has(peer.taskId)) return peer.taskId;
    }
    return null;
  }

  /** Reading rows, wandering, selecting things, scrolling elsewhere: no changes. */
  private async lookAround(until: number): Promise<void> {
    const { clock, lookOnly } = this.shared;
    const { hand, random } = this;
    while (!this.stopped && clock.now() < until - 250) {
      const left = until - clock.now();
      if (left < 900) {
        await hand.drift(left, { radius: 10 });
        break;
      }
      const kind = chooseLook(random, lookOnly ? { left, lookOnly, colleague: this.colleagueTask() !== null } : { left });
      await this.look(kind ?? 'rest', left);
    }
  }

  /** One way of looking, for about `left` ms at most (or less: it returns at once when it finds nothing to look at). */
  private async look(kind: LookKind, left: number): Promise<void> {
    const { hand, random, screen } = this;
    switch (kind) {
      case 'read': {
        const taskId = this.rowToLookAt();
        const rect = taskId === undefined ? null : screen.cellRect(taskId, 'task');
        if (!rect) return;
        await hand.move({ x: rect.x + random.range(20, 120), y: rect.y + rect.height * random.range(0.35, 0.65) }, { pace: random.range(1, 1.4) });
        if (this.shared.lookOnly && random.chance(0.45)) {
          // On along the row into the chart, to its bar when that is in view (the viewer's grid is narrow).
          await hand.drift(Math.min(left / 3, random.range(600, 1_300)), { radius: random.range(30, 70), heading: { x: 1.4, y: 0 } });
          await hand.move({ x: this.alongRow(taskId!), y: hand.position.y + random.range(-5, 5) }, { pace: random.range(1.2, 1.6) });
          await hand.drift(Math.min(left / 3, random.range(800, 1_800)), { radius: 18, heading: { x: 1, y: 0 } });
          return;
        }
        // Reading across the row, toward the dates and the bar.
        await hand.drift(Math.min(left - 200, random.range(1_200, 3_000)), { radius: random.range(60, 160), heading: { x: 1.4, y: 0 } });
        return;
      }
      case 'wander':
        await hand.move(this.somewhereInView(), { pace: random.range(1.1, 1.8) });
        await hand.hold(Math.min(left / 3, random.range(250, 1_000)));
        return;
      case 'select': {
        const taskId = this.rowToLookAt();
        if (taskId === undefined || this.busy(taskId)) return;
        // (Look-only: the columns their screen has, which are the ones a viewer has; a phase's other cells are empty.)
        const columns = this.shared.lookOnly ? ['task', 'task', ...screen.columns.slice(1).map((column) => column.id)] : ['task', 'task', 'schedule-when', 'schedule-crew'];
        const picked = random.pick(columns)!;
        const column = this.shared.lookOnly && !(this.parts.project.taskStore.getById(taskId) as TaskModel | undefined)?.isLeaf ? 'task' : picked;
        const rect = screen.cellRect(taskId, column);
        if (!rect) return;
        await hand.move({ x: rect.x + rect.width * random.range(0.2, 0.7), y: rect.y + rect.height * random.range(0.35, 0.65) }, { targetWidth: rect.height });
        await hand.hold(random.range(120, 380));
        this.select(taskId, column);
        await hand.drift(Math.min(left / 2, random.range(600, 1_600)), { radius: 20 });
        return;
      }
      case 'scroll':
        if (this.shared.lookOnly) {
          // A little way from the opening view and back again, never far: the pointer stays where viewers look.
          await hand.scroll({ x: this.home.x + random.range(0, 4) * screen.pxPerDay, y: this.home.y + random.int(0, 3) * screen.rowHeight });
          await hand.drift(Math.min(left / 3, random.range(400, 1_000)), { radius: 25 });
          return;
        }
        return this.scrollToFocus(left);
      case 'rest':
        await hand.drift(Math.min(left - 100, random.range(800, 2_200)), { radius: 18 });
        return;
      case 'peek':
        return this.peek(left);
      case 'inspect':
        return this.inspect(left);
      case 'glance':
        return this.glance(left);
    }
  }

  /** Over to a part of the plan they care about, its bar in view too. */
  private async scrollToFocus(left: number): Promise<void> {
    const { hand, random, screen } = this;
    const focus = this.intent?.focus ?? [];
    const target = random.pick(focus.length ? focus : screen.rowIds);
    if (target === undefined) return;
    const task = this.parts.project.taskStore.getById(target) as TaskModel | undefined;
    screen.reveal(target);
    const dates = task?.startDate instanceof Date && task.endDate instanceof Date ? { from: task.startDate, to: task.endDate } : undefined;
    await hand.scroll(screen.scrollToShow(target, dates));
    await hand.drift(Math.min(left / 3, random.range(400, 1_000)), { radius: 25 });
  }

  /**
   * Look-only: opens the task panel on a row and reads it, the way a person does: the name clicked (the
   * row shows as theirs), the pointer over to the panel at the right (it leaves the plan), a while there,
   * and back. Nothing is typed, so no activity shows: the app shows one only while somebody types there.
   */
  private async peek(left: number): Promise<void> {
    const taskId = this.rowToLookAt();
    const rect = taskId === undefined || this.busy(taskId) ? null : this.screen.cellRect(taskId, 'task');
    if (!rect || taskId === undefined) return;
    const { hand, random, screen } = this;
    await hand.move({ x: rect.x + rect.width * random.range(0.2, 0.6), y: rect.y + rect.height * random.range(0.35, 0.65) }, { targetWidth: rect.height });
    await hand.hold(random.range(150, 400));
    this.select(taskId, 'task');
    await hand.hold(random.range(300, 700));
    // Off to the right, leaving the plan a few weeks in: the far edge of their screen can lie past the edge
    // of a viewer's, where the pointer would wait at the edge with an arrow before it goes.
    const exit = Math.min(screen.bounds.right, screen.timelineLeft + (LOOK_DAYS + 4) * screen.pxPerDay);
    await hand.move({ x: exit - random.range(0, 10), y: hand.position.y + random.range(-60, 60) }, { pace: 0.9 });
    hand.leave();
    await hand.hold(Math.max(1_200, Math.min(left - 1_800, random.range(2_400, 4_500))));
    hand.enter({ x: exit - 2, y: random.range(screen.rowHeight, this.lookRegion().bottom - screen.rowHeight) });
    await hand.move(this.somewhereInView(), { pace: 1.1 });
  }

  /** Look-only: rests on something to read it: a bar in view (its hover card) or who is on a task (the crew); else a name. */
  private async inspect(left: number): Promise<void> {
    const { hand, random, screen } = this;
    const { right } = this.lookRegion();
    const tasks = this.rowsInRegion()
      .map((id) => this.parts.project.taskStore.getById(id) as TaskModel | undefined)
      .filter((task): task is TaskModel => Boolean(task));
    const bars = tasks.flatMap((task) => {
      const bar = screen.barRect(task);
      const from = bar ? Math.max(bar.x, this.lookLeft) : 0;
      const to = bar ? Math.min(bar.x + bar.width, right - 10) : 0;
      return bar && to - from >= 12 ? [{ taskId: task.id as number, from, to, y: bar.y, height: bar.height }] : [];
    });
    const crewed = screen.column('schedule-crew') ? tasks.filter((task) => task.isLeaf && crewNames(task).length > 0) : [];
    // One choice over both, so a plan with a single bar in view is not looked at over and over.
    if (bars.length + crewed.length === 0) return this.look('read', left);
    const index = random.int(0, bars.length + crewed.length - 1);
    const bar = bars[index];
    if (bar) {
      await hand.move({ x: random.range(bar.from, bar.to), y: bar.y + bar.height * random.range(0.3, 0.7) }, { targetWidth: Math.min(40, bar.to - bar.from) });
      // The card comes up after a moment; reading it.
      await hand.drift(Math.max(600, Math.min(left - 600, random.range(1_400, 2_800))), { radius: 6 });
      // Now and then a click on the bar, which selects its row.
      if (random.chance(0.4) && !this.busy(bar.taskId)) {
        this.select(bar.taskId, null);
        await hand.drift(Math.max(300, Math.min(left / 3, random.range(500, 1_200))), { radius: 14 });
      }
      return;
    }
    const rect = screen.cellRect(crewed[index - bars.length]!.id as number, 'schedule-crew');
    if (!rect) return;
    await hand.move({ x: rect.x + rect.width * random.range(0.25, 0.45), y: rect.y + rect.height * random.range(0.4, 0.6) }, { targetWidth: 26 });
    await hand.drift(Math.max(600, Math.min(left - 600, random.range(1_200, 2_400))), { radius: 5 });
  }

  /** Look-only: over to the row a colleague has selected, as if talking it over (the selection stays theirs). */
  private async glance(left: number): Promise<void> {
    const taskId = this.colleagueTask();
    const rect = taskId === null ? null : this.screen.cellRect(taskId, 'task');
    if (!rect) return this.look('read', left);
    const { hand, random } = this;
    await hand.move({ x: rect.x + rect.width * random.range(0.45, 0.85), y: rect.y + rect.height * random.range(0.3, 0.7) }, { pace: random.range(1, 1.3) });
    await hand.drift(Math.max(600, Math.min(left - 400, random.range(1_500, 3_200))), { radius: 16, heading: { x: 1, y: 0 } });
  }
}
