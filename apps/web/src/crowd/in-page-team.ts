/**
 * Simulated teammates on this page, for the walkthrough and the film: two or three of the crowd's people
 * (CROWD_PEOPLE, with their names and colors) show in the app's own presence: avatars in the header,
 * named pointers over the rows and the bars, their selected cells and rows. They are marked as
 * simulated the way the crowd is: a robot by the name on the pointer and on the avatar, "(sim)" after
 * the full name, "Simulated" on their card. Their pointers move the way the crowd's hands do (motion.ts,
 * hand.ts): they read along a row, go over to a bar and rest on it, select a cell or a row, open the
 * task panel (the pointer leaves for a while), come over to what a colleague has selected, and move on.
 *
 * They never write anything: they have no copy of the plan, no revision stream, nothing to submit. All
 * a teammate has is a presence session on this page's own channel (presence/local-peers.ts), so nobody
 * else sees them, and the real presence goes on beside them.
 *
 *   const team = startTeam({ people: 2, around: [100] });  // level 1 and its tasks, while they show
 *   team.around([200]);                                    // over to level 2
 *   team.stop();                                           // they leave
 *
 * `?team=2` starts a team when the plan opens (PresenceLayer).
 */
import type { Gantt } from '@bryntum/gantt';
import { CROWD_PEOPLE, type CrowdPerson } from '@collab/shared';
import { systemClock, type Clock } from '../presence/clock';
import { dataColumns, placeBar, placeCell, planRegions, pointAt, shownRows, type ShownRow } from '../presence/gantt-adapter';
import type { InMemoryPresenceHub } from '../presence/in-memory-presence';
import { localPeers, shownPlan } from '../presence/local-peers';
import type { CursorPoint } from '../presence/protocol';
import { PresenceSession, type PresenceViewport } from '../presence/session';
import { Hand, type HandScreen } from './hand';
import type { Bounds, Vec } from './motion';
import { Random } from './random';

/** A box on the page, in client pixels. */
export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** What the team needs of the plan on screen, in client pixels: the Gantt of this page (or a stand-in, in tests). */
export interface PlanView {
  /** The rows (grid and timeline together), or null while the plan is not on screen. */
  body(): Box | null;
  /** Where the timeline starts. */
  timelineLeft(): number;
  /** The rows wholly on screen, top to bottom. */
  rows(): readonly ShownRow[];
  /** The grid's data columns, left to right (the task name first). */
  columns(): readonly string[];
  cell(taskId: number, column: string): Box | null;
  /** The task's bar, where it is drawn. */
  bar(taskId: number): Box | null;
  /** What a pointer there is over, as presence says it. */
  pointAt(x: number, y: number): CursorPoint | null;
}

/** Where a team is: the plan on screen, and the view its people's frames carry when somebody follows one of them. */
export interface TeamStage {
  view: PlanView;
  viewport?: PresenceViewport | null;
}

export interface TeamOptions {
  /** How many, 1 to 3 (default 2): the first of CROWD_PEOPLE (Marcus, Lena, Tom). */
  people?: number;
  /** Or who, by first name ("Lena", "Tom", "Kenji"); any of CROWD_PEOPLE. */
  names?: readonly string[];
  /**
   * Tasks they keep to, while those rows show: a group counts with the tasks in it. Default (or when
   * none of them shows): the rows near the top of what is on screen.
   */
  around?: readonly number[];
  /** The same moves every time (default: different each time). */
  seed?: number;
  /** Where they are (default: the plan PresenceLayer registers). */
  stage?: () => TeamStage | null;
  /** The channel they are on (default: this page's, `localPeers`). */
  hub?: InMemoryPresenceHub;
  clock?: Clock;
}

export interface TeamHandle {
  /** Who came, as their pointers name them. */
  readonly people: readonly { name: string; color: string }[];
  /** Where they keep to from now on (as `around`); empty: near the top of what is on screen. */
  around(taskIds: readonly number[]): void;
  /** They leave: avatars, pointers and selections go. */
  stop(): void;
}

/** Without `around`: the rows they look at, from the top of what is on screen. */
const TOP_ROWS = 10;
/** Pointer updates go out about 2.5 times as often as the crowd's: in-page, nothing is counted, and they glide. */
const INTERVAL_SCALE = 0.4;

const firstName = (person: CrowdPerson) => person.name.split(' ')[0] ?? person.name;
const right = (box: Box) => box.left + box.width;
const bottom = (box: Box) => box.top + box.height;

/** The Gantt on this page as a team sees it (client pixels). */
export function ganttPlanView(gantt: Gantt): PlanView {
  const origin = { left: 0, top: 0 } as DOMRect;
  return {
    body: () => planRegions(gantt)?.rows ?? null,
    timelineLeft: () => planRegions(gantt)?.timeline.left ?? 0,
    rows: () => shownRows(gantt),
    columns: () => dataColumns(gantt),
    cell: (taskId, column) => placeCell(gantt, { taskId, column }, document.body, origin),
    bar: (taskId) => placeBar(gantt, taskId, document.body, origin),
    pointAt: (x, y) => pointAt(gantt, x, y),
  };
}

/** The plan PresenceLayer registers, as a stage (one view per Gantt). */
function pageStage(): () => TeamStage | null {
  let cached: { gantt: Gantt; stage: TeamStage } | null = null;
  return () => {
    const plan = shownPlan();
    if (!plan) return null;
    if (cached?.gantt !== plan.gantt) cached = { gantt: plan.gantt, stage: { view: ganttPlanView(plan.gantt), viewport: plan.viewport } };
    return cached.stage;
  };
}

/** The hand's screen: the plan on this page, in client pixels; nobody scrolls it but its viewer. */
class StageScreen implements HandScreen {
  readonly scroll: Vec = { x: 0, y: 0 };
  private cached: { at: number; box: Box | null } | null = null;

  constructor(
    private readonly stage: () => TeamStage | null,
    private readonly clock: Clock,
  ) {}

  /** The rows' box, read at most every 200 ms (it is asked for on every tick). */
  private box(): Box | null {
    const now = this.clock.now();
    if (!this.cached || now - this.cached.at > 200) this.cached = { at: now, box: this.stage()?.view.body() ?? null };
    return this.cached.box;
  }

  get bounds(): Bounds {
    const box = this.box();
    return box ? { left: box.left + 4, top: box.top + 2, right: right(box) - 14, bottom: bottom(box) - 4 } : { left: 0, top: 0, right: 0, bottom: 0 };
  }

  get width(): number {
    return this.box()?.width ?? 0;
  }

  get height(): number {
    return this.box()?.height ?? 0;
  }

  get timelineLeft(): number {
    return this.stage()?.view.timelineLeft() ?? 0;
  }

  setScroll(): void {
    // The viewer's plan is theirs to scroll.
  }

  pointAt(point: Vec): CursorPoint | null {
    return this.stage()?.view.pointAt(point.x, point.y) ?? null;
  }
}

type Look = 'read' | 'bar' | 'select' | 'peek' | 'glance' | 'wander' | 'rest';

interface Team {
  hub: InMemoryPresenceHub;
  clock: Clock;
  stage: () => TeamStage | null;
  around: ReadonlySet<number>;
  mates: readonly Mate[];
}

/** One simulated teammate: a presence session (once they arrive) and a hand, nothing else. */
class Mate {
  private presence: PresenceSession | null = null;
  readonly hand: Hand;
  /** The row they have selected (shown as theirs), or null. */
  selected: number | null = null;
  private stopped = false;
  private readonly waits = new Set<() => void>();

  constructor(
    readonly person: CrowdPerson,
    private readonly team: Team,
    private readonly random: Random,
  ) {
    this.hand = new Hand({
      screen: new StageScreen(team.stage, team.clock),
      clock: team.clock,
      random,
      send: (point) => this.presence?.moveCursor(point),
      start: { x: 0, y: 0 },
      // Sampled 25 times a second: the presence layer draws between updates.
      tickMs: 40,
      intervalScale: INTERVAL_SCALE,
    });
    // Not here until they arrive.
    this.hand.leave();
  }

  /** Arrives after `delay` and looks around until stopped. */
  async run(delay: number): Promise<void> {
    await this.wait(delay);
    if (this.stopped) return;
    // Their session begins as they arrive, so the avatars line up in the order people came in.
    const session = `team-${firstName(this.person).toLowerCase()}-${this.random.int(0, 2 ** 30).toString(36)}`;
    const presence = new PresenceSession({
      self: { session, user: this.person.id, name: this.person.displayName, color: this.person.color, role: 'pm', simulated: true },
      transport: this.team.hub.connect(session),
      clock: this.team.clock,
    });
    this.presence = presence;
    presence.start();
    // Following one of them shows what this page shows: they look at the same plan.
    presence.attachViewport({
      read: () => this.team.stage()?.viewport?.read() ?? null,
      apply: () => 'applied',
      onChange: (listener) => this.team.stage()?.viewport?.onChange(listener) ?? (() => undefined),
      onUserNavigate: () => () => undefined,
    });
    let here = false;
    while (!this.stopped) {
      const stage = this.team.stage();
      const rows = stage ? this.rowsToLookAt(stage) : [];
      const body = stage?.view.body() ?? null;
      if (!stage || !body || rows.length === 0) {
        // The plan is not on screen (another view, between projects): the pointer goes until it is back.
        if (here) this.hand.leave();
        here = false;
        await this.wait(700);
        continue;
      }
      if (!here) {
        // In from the right of the plan, at the height of the rows they keep to.
        const row = this.random.pick(rows)!;
        this.hand.enter({ x: right(body) - this.random.range(30, 120), y: row.top + row.height * this.random.range(0.3, 0.7) });
        here = true;
      }
      const colleague = this.colleagueRow(rows) !== null;
      const look = this.random.weighted<Look>([
        ['read', 4],
        ['bar', 2.5],
        ['select', 2.2],
        ['glance', colleague ? 1.2 : 0],
        ['peek', 0.8],
        ['wander', 2],
        ['rest', 1.5],
      ])!;
      const looked = await this.look(look, stage, body, rows);
      // Nothing to do it on right now: a moment's rest instead, so the loop always takes time.
      if (!looked && !this.stopped) await this.hand.drift(this.random.range(600, 1_400), { radius: 12 });
    }
  }

  leave(): void {
    this.stopped = true;
    for (const resolve of [...this.waits]) resolve();
    this.waits.clear();
    this.hand.dispose();
    this.presence?.attachViewport(null);
    this.presence?.dispose();
  }

  private wait(ms: number): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = () => {
        this.waits.delete(done);
        this.team.clock.clearTimeout(timer);
        resolve();
      };
      const timer = this.team.clock.setTimeout(done, ms);
      this.waits.add(done);
    });
  }

  /** The rows they keep to: those of `around` on screen, else the top of what is on screen. */
  private rowsToLookAt(stage: TeamStage): ShownRow[] {
    const rows = stage.view.rows();
    const { around } = this.team;
    const near = around.size ? rows.filter((row) => around.has(row.taskId) || row.parents.some((id) => around.has(id))) : [];
    return near.length ? near : rows.slice(0, TOP_ROWS);
  }

  /** Someone else has this row selected or is on it (a teammate, the viewer, anyone on the channel). */
  private busy(taskId: number): boolean {
    if (this.team.mates.some((mate) => mate !== this && mate.selected === taskId)) return true;
    return (this.presence?.getSnapshot().peers ?? []).some((peer) => peer.taskId === taskId || peer.active?.taskId === taskId || peer.activity?.taskId === taskId || peer.cells.some((row) => row.taskId === taskId));
  }

  /** A row a teammate has selected, among those this one keeps to. */
  private colleagueRow(rows: readonly ShownRow[]): ShownRow | null {
    for (const mate of this.team.mates) {
      if (mate === this || mate.selected === null) continue;
      const row = rows.find((candidate) => candidate.taskId === mate.selected);
      if (row) return row;
    }
    return null;
  }

  private select(taskId: number, column: string | null): void {
    // (A move cut short by `leave()` returns early: they are gone by then.)
    if (this.stopped || !this.presence) return;
    this.selected = taskId;
    this.presence.setSelectedTask(taskId);
    this.presence.setCellSelection(column ? [{ taskId, columns: [column] }] : [], column ? { taskId, column } : null);
  }

  /** A point inside a box, `fx` and `fy` of the way across and down (give or take). */
  private inside(box: Box, fx: [number, number], fy: [number, number] = [0.35, 0.65]): Vec {
    return { x: box.left + box.width * this.random.range(fx[0], fx[1]), y: box.top + box.height * this.random.range(fy[0], fy[1]) };
  }

  /** The part of a task's bar on screen (clear of the timeline's edges), or null. */
  private shownBar(stage: TeamStage, body: Box, taskId: number): Box | null {
    const bar = stage.view.bar(taskId);
    if (!bar) return null;
    const left = Math.max(bar.left, stage.view.timelineLeft() + 8);
    const end = Math.min(right(bar), right(body) - 24);
    return end - left >= 10 ? { left, top: bar.top, width: end - left, height: bar.height } : null;
  }

  /** One look; false when it found nothing to look at. Nothing here changes the plan. */
  private async look(look: Look, stage: TeamStage, body: Box, rows: readonly ShownRow[]): Promise<boolean> {
    const { hand, random } = this;
    const { view } = stage;
    const name = view.columns()[0];
    switch (look) {
      case 'read': {
        // Along a row from its name, and now and then on into the chart, to its bar where it shows.
        const row = random.pick(rows)!;
        const cell = name ? view.cell(row.taskId, name) : null;
        if (!cell) return false;
        await hand.move({ x: cell.left + random.range(18, Math.max(24, Math.min(140, cell.width - 30))), y: cell.top + cell.height * random.range(0.35, 0.65) }, { pace: random.range(1, 1.4) });
        await hand.drift(random.range(900, 2_200), { radius: random.range(30, 90), heading: { x: 1.4, y: 0 } });
        if (random.chance(0.5)) {
          const bar = this.shownBar(stage, body, row.taskId);
          const timeline = view.timelineLeft();
          const x = bar ? random.range(bar.left, right(bar)) : random.range(timeline + 16, timeline + Math.max(32, (right(body) - timeline) * 0.3));
          await hand.move({ x, y: hand.position.y + random.range(-4, 4) }, { pace: random.range(1.2, 1.6) });
          await hand.drift(random.range(800, 1_800), { radius: 16, heading: { x: 1, y: 0 } });
        }
        return true;
      }
      case 'bar': {
        // Onto a bar, resting there as if reading its card; now and then a click, which selects the row.
        const bars = rows.map((row) => ({ row, bar: this.shownBar(stage, body, row.taskId) })).filter((entry): entry is { row: ShownRow; bar: Box } => entry.bar !== null);
        const entry = random.pick(bars);
        if (!entry) return this.look('read', stage, body, rows);
        await hand.move(this.inside(entry.bar, [0.1, 0.9], [0.3, 0.7]), { targetWidth: Math.min(40, entry.bar.width) });
        await hand.drift(random.range(1_400, 2_800), { radius: 6 });
        if (random.chance(0.45) && !this.busy(entry.row.taskId)) {
          this.select(entry.row.taskId, null);
          await hand.drift(random.range(600, 1_400), { radius: 12 });
        }
        return true;
      }
      case 'select':
      case 'peek': {
        // A click on a cell (the name, now and then another of a task's cells). Peeking, it opens the task
        // panel: the pointer goes off to the right of the plan, a while there, and back.
        const free = rows.filter((row) => !this.busy(row.taskId));
        const row = random.pick(free);
        if (!row || !name) return false;
        const others = view.columns().slice(1);
        const column = look === 'select' && row.leaf && others.length && random.chance(0.35) ? random.pick(others)! : name;
        const cell = view.cell(row.taskId, column);
        if (!cell) return false;
        await hand.move(this.inside(cell, column === name ? [0.15, 0.6] : [0.25, 0.6]), { targetWidth: Math.min(cell.width, cell.height) });
        await hand.hold(random.range(120, 380));
        this.select(row.taskId, column);
        if (look === 'select') {
          await hand.drift(random.range(700, 1_800), { radius: 18 });
          return true;
        }
        await hand.hold(random.range(300, 700));
        await hand.move({ x: right(body) - random.range(4, 10), y: hand.position.y + random.range(-60, 60) }, { pace: 0.9 });
        if (this.stopped) return true;
        hand.leave();
        await this.wait(random.range(2_200, 4_200));
        if (this.stopped) return true;
        const back = random.pick(rows)!;
        hand.enter({ x: right(body) - 8, y: back.top + back.height * random.range(0.3, 0.7) });
        await hand.move(this.somewhere(stage, body, rows), { pace: 1.1 });
        return true;
      }
      case 'glance': {
        // Over to the row a teammate has selected, as if talking it over (the selection stays theirs).
        const row = this.colleagueRow(rows);
        const cell = row && name ? view.cell(row.taskId, name) : null;
        if (!cell) return this.look('read', stage, body, rows);
        await hand.move(this.inside(cell, [0.45, 0.85], [0.3, 0.7]), { pace: random.range(1, 1.3) });
        await hand.drift(random.range(1_500, 3_200), { radius: 16, heading: { x: 1, y: 0 } });
        return true;
      }
      case 'wander':
        await hand.move(this.somewhere(stage, body, rows), { pace: random.range(1.1, 1.7) });
        await hand.hold(random.range(300, 1_000));
        return true;
      case 'rest':
        await hand.drift(random.range(800, 2_000), { radius: 16 });
        return true;
    }
  }

  /** Somewhere over the rows they keep to: the first weeks the timeline shows, or the grid. */
  private somewhere(stage: TeamStage, body: Box, rows: readonly ShownRow[]): Vec {
    const { random } = this;
    const top = Math.min(...rows.map((row) => row.top));
    const end = Math.max(...rows.map((row) => row.top + row.height));
    const timeline = stage.view.timelineLeft();
    const x = random.chance(0.55) ? random.range(timeline + 16, timeline + Math.max(40, (right(body) - timeline) * 0.6)) : random.range(body.left + 30, Math.max(body.left + 40, timeline - 50));
    return { x, y: random.range(top + 8, Math.max(top + 12, end - 8)) };
  }
}

let current: TeamHandle | null = null;

/** Starts a team (one at a time: a running one leaves first). See the top of this file. */
export function startTeam(options: TeamOptions = {}): TeamHandle {
  current?.stop();
  const random = new Random(options.seed ?? Date.now());
  const named = (options.names ?? []).map((wanted) => CROWD_PEOPLE.find((person) => firstName(person).toLowerCase() === wanted.trim().toLowerCase())).filter((person): person is CrowdPerson => Boolean(person));
  const count = Math.min(3, Math.max(1, Math.floor(options.people ?? 2) || 2));
  const people = named.length ? [...new Set(named)] : CROWD_PEOPLE.slice(0, count);
  const mates: Mate[] = [];
  const team: Team = {
    hub: options.hub ?? localPeers,
    clock: options.clock ?? systemClock,
    stage: options.stage ?? pageStage(),
    around: new Set(options.around ?? []),
    mates,
  };
  let delay = random.range(300, 900);
  for (const person of people) {
    const mate = new Mate(person, team, random.fork());
    mates.push(mate);
    void mate.run(delay).catch((error: unknown) => console.warn(`[team] ${person.name} stopped`, error));
    // One after another, as people do.
    delay += random.range(700, 1_600);
  }
  const handle: TeamHandle = {
    people: people.map((person) => ({ name: person.displayName, color: person.color })),
    around(taskIds) {
      team.around = new Set(taskIds);
    },
    stop() {
      for (const mate of mates) mate.leave();
      if (current === handle) current = null;
    },
  };
  current = handle;
  return handle;
}
