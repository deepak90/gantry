/**
 * What the site board shows, read from the plan when it opens and again whenever the plan changes: money and PayPal payments for those
 * who may see them, the crews on each task, and what is wrong. Nothing here is judged anew: idle rentals
 * come from the workflow, double bookings from the watch rules' own check, slip from the baseline.
 */
import type { ResourceModel, TaskModel } from '@bryntum/gantt';
import { overbookedDays } from '../../alerts/live';
import { engineCommitting, isCritical, original, slipDays, statusOf, taskMoney, wholeMoney, type LookState, type TaskMoney, type Tracker } from '../look';
import { type CostLine, costLines } from './cost-breakdown';
import { type DayTile, dayTiles, spentWords } from './day-track';
import { factsOf, type TaskFacts } from './facts';

export type IssueKind = 'late' | 'over' | 'booked' | 'idle' | 'ahead';

export interface Issue {
  kind: IssueKind;
  /** Red means act now; amber is caution (docs/DESIGN.md). */
  tone: 'danger' | 'caution';
  text: string;
  /** When it is happening: scrubbing to these dates is how it is found and shown. */
  from: number;
  to: number;
}

export interface Payout {
  state: 'none' | 'ready' | 'moving' | 'paid' | 'failed';
  amountMinor: number | null;
  status: string | null;
  /** When PayPal confirmed it. */
  at: number | null;
}

export interface SiteTask {
  record: TaskModel;
  facts: TaskFacts;
  /** Null for viewers who may not see money. */
  money: TaskMoney | null;
  idleCostMinor: number;
  /** Every day of this work and of its machine's rental, for the room's track. */
  days: DayTile[];
  payout: Payout;
  /** Everyone on it, across its crews. */
  people: number;
  /** What has been paid against what has been reported done; null for viewers who may not see money. */
  payCheck: PayCheck | null;
  /** What it costs, line by line; empty for viewers who may not see money. */
  costs: CostLine[];
  issues: Issue[];
  /** Late because of the work before it; shown on request, not flagged. */
  knockOnDays: number;
  critical: boolean;
  /** Working days it can slip without moving the handover; 0 on the critical path. */
  slackDays: number;
}

/**
 * The question before a payment: is the work there to justify it? Both sides are what people entered, the money paid and
 * the work reported done, so nothing here assumes how work is spread over its days.
 */
export interface PayCheck {
  percent: number;
  /** The forecast's share for the work reported done. */
  earnedMinor: number;
  paidMinor: number;
  /** Reported work not paid for yet. */
  owedMinor: number;
  /** Paid beyond the work reported. */
  aheadMinor: number;
}

/** Under a dollar either way is only rounding. */
const PAY_TOLERANCE_MINOR = 100;

export function payCheckOf(money: Pick<TaskMoney, 'expected' | 'paid'>, percent: number): PayCheck {
  const earnedMinor = (money.expected * Math.min(100, Math.max(0, percent))) / 100;
  const gap = money.paid - earnedMinor;
  return { percent, earnedMinor, paidMinor: money.paid, owedMinor: gap < -PAY_TOLERANCE_MINOR ? -gap : 0, aheadMinor: gap > PAY_TOLERANCE_MINOR ? gap : 0 };
}

export function payCheckWords(check: PayCheck, money: (minor: number) => string): string {
  if (check.aheadMinor > 0) return `Paid ${money(check.aheadMinor)} ahead of the work reported`;
  if (check.owedMinor > 0) return `${money(check.owedMinor)} of reported work not paid yet`;
  return check.percent <= 0 && check.paidMinor <= 0 ? 'Nothing reported, nothing paid' : 'Paid in line with the work reported';
}

const DAY_MS = 86_400_000;
const days = (count: number): string => `${count} ${count === 1 ? 'day' : 'days'}`;

/** The engine's total slack, in days. Read once when the board opens, like critical, and never during a commit. */
export function slackDaysOf(task: TaskModel): number {
  const record = original(task) as TaskModel & { totalSlack?: number | null; slackUnit?: string };
  if (engineCommitting(record.project)) return 0;
  const slack = record.totalSlack;
  if (typeof slack !== 'number' || !Number.isFinite(slack) || slack <= 0) return 0;
  const perDay: Readonly<Record<string, number>> = { hour: 1 / 8, day: 1, week: 5, month: 21 };
  return Math.round(slack * (perDay[record.slackUnit ?? 'day'] ?? 1));
}

const NO_PAYOUT: Payout = { state: 'none', amountMinor: null, status: null, at: null };

/** Where the supplier payment of a task's fix stands at PayPal. */
export function payoutOf(tracker: Tracker | null | undefined): Payout {
  const step = tracker && !tracker.dropped ? tracker.steps.find((item) => item.key === 'paid') : undefined;
  if (!tracker || !step) return NO_PAYOUT;
  const state = step.state === 'done' ? 'paid' : step.state === 'failed' ? 'failed' : tracker.paying ? 'moving' : step.state === 'current' ? 'ready' : 'none';
  return { state, amountMinor: tracker.amountMinor, status: step.status, at: step.at ? new Date(step.at).getTime() : null };
}

/**
 * A task that is late only because the one before it is late isn't a problem to act on: flagging all of
 * them turns one slip into a wall of red. This is the task where the lateness starts.
 */
export function startsTheDelay(task: TaskModel): boolean {
  if (slipDays(task) <= 0) return false;
  const before = ((original(task).predecessors ?? []) as unknown as { fromEvent?: TaskModel | null }[]).map((dep) => dep.fromEvent).filter((item): item is TaskModel => Boolean(item));
  // Any lateness before it counts: slip is in calendar days, so a weekend can make the same delay look longer.
  return !before.some((item) => slipDays(item) > 0);
}

/** The stretches of a machine's booking with no work planned: one before the work, one after it, or both. */
export function idleStretches(days: readonly DayTile[], start: number): { side: 'before' | 'after'; days: number; costMinor: number; from: number; to: number }[] {
  const stretches = [];
  for (const side of ['before', 'after'] as const) {
    const idle = days.filter((day) => day.kind === 'idle' && (side === 'before' ? day.at < start : day.at >= start));
    const [first, last] = [idle[0], idle[idle.length - 1]];
    if (!first || !last) continue;
    stretches.push({ side, days: idle.length, costMinor: idle.reduce((sum, day) => sum + day.costMinor, 0), from: first.at, to: last.at + DAY_MS });
  }
  return stretches;
}

export function issuesOf(task: TaskModel, facts: TaskFacts, look: LookState, doubleBooked: readonly { crew: string; days: number; from: number; to: number }[], tiles: readonly DayTile[] = []): Issue[] {
  const issues: Issue[] = [];
  const done = statusOf(task) === 'done';
  const [start, end] = [facts.start.getTime(), facts.end.getTime()];
  if (!done && startsTheDelay(task)) issues.push({ kind: 'late', tone: 'danger', text: `${days(slipDays(task))} late, and it starts here`, from: end - slipDays(task) * DAY_MS, to: end });
  if (look.canViewCosts && !done) {
    const { expected, budget } = taskMoney(task);
    if (budget > 0 && expected > budget) issues.push({ kind: 'over', tone: 'danger', text: `${wholeMoney(expected - budget, look.currency)} over budget`, from: start, to: end });
  }
  if (look.canViewCosts) {
    const check = payCheckOf(taskMoney(task), original(task).percentDone ?? 0);
    if (check.aheadMinor > 0) issues.push({ kind: 'ahead', tone: 'caution', text: payCheckWords(check, (minor) => wholeMoney(minor, look.currency)), from: start, to: end });
  }
  for (const clash of doubleBooked) issues.push({ kind: 'booked', tone: 'danger', text: `${clash.crew} booked twice, ${days(clash.days)}`, from: clash.from, to: clash.to });
  if (!done) {
    for (const stretch of idleStretches(tiles, start)) {
      const cost = stretch.costMinor > 0 ? `, ${spentWords(wholeMoney(stretch.costMinor, look.currency))}` : '';
      issues.push({ kind: 'idle', tone: 'caution', text: `${facts.machine ?? 'Machine'}: ${stretch.days} idle ${stretch.days === 1 ? 'day' : 'days'} ${stretch.side} the work${cost}`, from: stretch.from, to: stretch.to });
    }
  }
  return issues;
}

/** Midnight after `count` weekdays from a date: how long a run of days on a crew's calendar lasts. */
export function afterWeekdays(from: string, count: number): number {
  const [year, month, day] = from.split('-').map(Number);
  const date = new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1);
  for (let left = count; left > 0; ) {
    if (date.getDay() !== 0 && date.getDay() !== 6) left -= 1;
    date.setDate(date.getDate() + 1);
  }
  return date.getTime();
}

export function siteTasks(leaves: readonly TaskModel[], everyRecord: readonly TaskModel[], crewName: (id: number) => string, look: LookState): SiteTask[] {
  const clashes = new Map<unknown, { crew: string; days: number; from: number; to: number }[]>();
  for (const clash of overbookedDays(everyRecord)) {
    const [year, month, day] = clash.firstDay.split('-').map(Number);
    const from = new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1).getTime();
    for (const id of clash.taskIds) {
      const list = clashes.get(id) ?? [];
      list.push({ crew: crewName(clash.crewId), days: clash.days, from, to: afterWeekdays(clash.firstDay, clash.days) });
      clashes.set(id, list);
    }
  }
  return leaves.map((record) => {
    const task = original(record);
    const facts = factsOf(task, look);
    const decoration = look.decorations.get(task.id as number);
    const days = dayTiles(facts, look.canViewCosts ? (facts.rig?.rateMinor ?? 0) : 0);
    const idleCostMinor = days.reduce((sum, day) => (day.kind === 'idle' ? sum + day.costMinor : sum), 0);
    return {
      record: task,
      facts,
      money: look.canViewCosts ? taskMoney(task) : null,
      idleCostMinor,
      days,
      costs: look.canViewCosts ? costLines({ forecastMinor: taskMoney(task).expected, crews: facts.crews, machine: facts.rig, days, idleColor: 'var(--warning-fill)', unassigned: 'No crew yet', unassignedColor: 'var(--gray-500)' }) : [],
      payout: look.canViewCosts ? payoutOf(decoration?.tracker) : NO_PAYOUT,
      payCheck: look.canViewCosts ? payCheckOf(taskMoney(task), facts.percent) : null,
      people: facts.crews.reduce((sum, crew) => sum + crew.people, 0),
      issues: issuesOf(task, facts, look, clashes.get(task.id) ?? [], days),
      knockOnDays: statusOf(task) !== 'done' && !startsTheDelay(task) ? slipDays(task) : 0,
      critical: isCritical(task),
      slackDays: slackDaysOf(task),
    };
  });
}

export const crewNames = (resources: readonly ResourceModel[]): ((id: number) => string) => {
  const names = new Map(resources.map((resource) => [resource.id, resource.name ?? 'Crew']));
  return (id) => names.get(id) ?? 'Crew';
};

// -----------------------------------------------------------------------------------------
// The road: the plan laid out in the order it is built
// -----------------------------------------------------------------------------------------

export interface Point {
  x: number;
  y: number;
}

export interface RoadItem<K> {
  key: K;
  /** The phase it belongs to: a phase is one block along the road. */
  group: unknown;
  start: number;
  /** Working days: a plot is as long as its work. */
  days: number;
  /** Days a machine is paid for before the work begins, drawn along the plot's front edge. */
  idleDays: number;
  before: readonly K[];
}

export interface RoadPlot {
  row: number;
  /** The way the road runs on this row: 1 is to the right. */
  dir: 1 | -1;
  x: number;
  y: number;
  w: number;
  d: number;
  idleW: number;
  /** How many steps of work come before this one: plots with the same rank run side by side. */
  rank: number;
}

export interface RoadRow<K> {
  y: number;
  height: number;
  dir: 1 | -1;
  group: unknown;
  keys: K[];
}

export interface Road<K> {
  plots: Map<K, RoadPlot>;
  rows: RoadRow<K>[];
  width: number;
  depth: number;
}

export const ROAD = { plotDepth: 158, rowGap: 150, stackGap: 26, stationGap: 74, dayWidth: 17, plotBase: 176, maxStations: 6 };

/**
 * Lays the work out along one continuous road: steps of work follow each other, work that can run at the
 * same time stands side by side, and each phase is its own block, the road turning back at the end of each
 * row. Following the dependencies rather than the calendar is what keeps the flow free of crossings.
 */
export function layoutRoad<K>(items: readonly RoadItem<K>[]): Road<K> {
  const byKey = new Map(items.map((item) => [item.key, item]));
  const ranks = new Map<K, number>();
  const rankOf = (key: K, seen: readonly K[] = []): number => {
    const known = ranks.get(key);
    if (known !== undefined) return known;
    const item = byKey.get(key);
    if (!item || seen.includes(key)) return 0;
    const inPlan = item.before.filter((other) => byKey.has(other));
    const rank = inPlan.length === 0 ? 0 : Math.max(...inPlan.map((other) => rankOf(other, [...seen, key]) + 1));
    ranks.set(key, rank);
    return rank;
  };

  const groups = new Map<unknown, RoadItem<K>[]>();
  for (const item of items) {
    const list = groups.get(item.group) ?? [];
    list.push(item);
    groups.set(item.group, list);
  }
  const ordered = [...groups.values()].sort((a, b) => Math.min(...a.map((item) => item.start)) - Math.min(...b.map((item) => item.start)));

  // Each row: a run of stations, each holding the work that runs side by side.
  const stationRows: { group: unknown; stations: RoadItem<K>[][] }[] = [];
  for (const group of ordered) {
    const byRank = new Map<number, RoadItem<K>[]>();
    for (const item of group) {
      const rank = rankOf(item.key);
      byRank.set(rank, [...(byRank.get(rank) ?? []), item]);
    }
    const stations = [...byRank.entries()].sort((a, b) => a[0] - b[0]).map(([, list]) => [...list].sort((a, b) => a.start - b.start));
    for (let index = 0; index < stations.length; index += ROAD.maxStations) {
      stationRows.push({ group: group[0]?.group, stations: stations.slice(index, index + ROAD.maxStations) });
    }
  }

  // A milestone takes no time: its plot is only somewhere to stand.
  const plotWidth = (item: RoadItem<K>) => (item.days === 0 ? ROAD.plotBase * 0.6 : ROAD.plotBase + item.days * ROAD.dayWidth);
  const stationWidth = (station: readonly RoadItem<K>[]) => Math.max(...station.map((item) => plotWidth(item) + item.idleDays * ROAD.dayWidth));
  const rowWidth = (stations: readonly RoadItem<K>[][]) => stations.reduce((sum, station) => sum + stationWidth(station), 0) + (stations.length - 1) * ROAD.stationGap;
  const width = Math.max(1, ...stationRows.map((row) => rowWidth(row.stations)));
  const rowHeight = (stations: readonly RoadItem<K>[][]) => Math.max(...stations.map((station) => station.length * ROAD.plotDepth + (station.length - 1) * ROAD.stackGap));
  const depth = stationRows.reduce((sum, row) => sum + rowHeight(row.stations), 0) + Math.max(0, stationRows.length - 1) * ROAD.rowGap;

  const plots = new Map<K, RoadPlot>();
  const rows: RoadRow<K>[] = [];
  let top = depth / 2;
  stationRows.forEach(({ group, stations }, row) => {
    const dir: 1 | -1 = row % 2 === 0 ? 1 : -1;
    const height = rowHeight(stations);
    const y = top - height / 2;
    // The stations spread out to the full width, so every turn of the road lines up.
    const gap = stations.length > 1 ? (width - stations.reduce((sum, station) => sum + stationWidth(station), 0)) / (stations.length - 1) : 0;
    let cursor = -dir * (width / 2);
    for (const station of stations) {
      const span = stationWidth(station);
      station.forEach((item, index) => {
        const w = plotWidth(item);
        const stackHeight = station.length * ROAD.plotDepth + (station.length - 1) * ROAD.stackGap;
        plots.set(item.key, {
          row,
          dir,
          // Each plot's far end is at the station's far end; a machine's idle days lie behind it.
          x: cursor + dir * (span - w / 2),
          y: y + stackHeight / 2 - ROAD.plotDepth / 2 - index * (ROAD.plotDepth + ROAD.stackGap),
          w,
          d: ROAD.plotDepth,
          idleW: item.idleDays * ROAD.dayWidth,
          rank: rankOf(item.key),
        });
      });
      cursor += dir * (span + gap);
    }
    rows.push({ y, height, dir, group, keys: stations.flat().map((item) => item.key) });
    top -= height + ROAD.rowGap;
  });
  return { plots, rows, width, depth };
}

/**
 * The lane from one plot to the next, in right angles: straight on along a row, around the end of the
 * block to the next row, or along the gap between rows when the next step is further away.
 */
export function roadRoute(from: RoadPlot, to: RoadPlot, edge: number): Point[] {
  const out: Point = { x: from.x + (from.dir * from.w) / 2, y: from.y };
  const into: Point = { x: to.x - (to.dir * to.w) / 2, y: to.y };
  if (from.row === to.row && to.dir * (into.x - out.x) > 0) {
    const turn = into.x - to.dir * Math.min(30, Math.abs(into.x - out.x) / 2);
    return dedupe([out, { x: turn, y: out.y }, { x: turn, y: into.y }, into]);
  }
  if (to.row === from.row + 1 && to.dir === -from.dir) {
    const turn = from.dir * edge;
    return dedupe([out, { x: turn, y: out.y }, { x: turn, y: into.y }, into]);
  }
  const lane = from.y - from.d / 2 - ROAD.rowGap / 2;
  const leave = out.x + from.dir * 24;
  const arrive = into.x - to.dir * 24;
  return dedupe([out, { x: leave, y: out.y }, { x: leave, y: lane }, { x: arrive, y: lane }, { x: arrive, y: into.y }, into]);
}

function dedupe(points: Point[]): Point[] {
  return points.filter((point, index) => {
    const before = points[index - 1];
    return !before || Math.hypot(point.x - before.x, point.y - before.y) > 0.01;
  });
}

/** The same route with each corner rounded, as dense points ready to be given a width. */
export function roundedRoute(points: readonly Point[], radius: number, steps = 6): Point[] {
  const out: Point[] = [];
  points.forEach((point, index) => {
    const before = points[index - 1];
    const after = points[index + 1];
    if (!before || !after) {
      out.push(point);
      return;
    }
    const toBefore = Math.hypot(before.x - point.x, before.y - point.y);
    const toAfter = Math.hypot(after.x - point.x, after.y - point.y);
    const r = Math.min(radius, toBefore / 2, toAfter / 2);
    const start = { x: point.x + ((before.x - point.x) / toBefore) * r, y: point.y + ((before.y - point.y) / toBefore) * r };
    const end = { x: point.x + ((after.x - point.x) / toAfter) * r, y: point.y + ((after.y - point.y) / toAfter) * r };
    for (let step = 0; step <= steps; step++) {
      const t = step / steps;
      out.push({
        x: (1 - t) ** 2 * start.x + 2 * (1 - t) * t * point.x + t ** 2 * end.x,
        y: (1 - t) ** 2 * start.y + 2 * (1 - t) * t * point.y + t ** 2 * end.y,
      });
    }
  });
  return out;
}
