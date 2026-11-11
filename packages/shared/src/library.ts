/**
 * The task library's shared vocabulary: a snippet is a small nested plan (a top task, groups, the
 * tasks themselves) with the links between its tasks, durations in working days, the crews that do
 * the work (by name, matched to the project's crews when it is dropped), notes, and time ranges
 * (shaded bands on the timeline, anchored to the start or end of its tasks), and what each task
 * costs: who is paid, how much and when it falls due. Snippets live in a
 * project's library (folders and snippets, `library_folders` / `library_snippets`), are built in the
 * app's builder or drafted by the assistant, and are dropped into the plan by the web app.
 *
 * Pure data and pure functions, used by the web app (builder, panel, drop), the agent service
 * (drafting and checking snippets) and the seed. Nothing here touches Bryntum.
 *
 * Times are working days relative to the snippet's start: a task "starts on day 3" means three
 * working days after the first task starts. Links follow the usual four types; a negative lag is a
 * lead (the next task starts that many days before the link would otherwise allow).
 */
import { z } from 'zod';
import { timestamp, uuid } from './schemas';

// -----------------------------------------------------------------------------------------
// Snippet data
// -----------------------------------------------------------------------------------------

export const SNIPPET_LINK_TYPES = ['FS', 'SS', 'FF', 'SF'] as const;
export const SnippetLinkType = z.enum(SNIPPET_LINK_TYPES);
export type SnippetLinkType = z.infer<typeof SnippetLinkType>;

/** Bryntum's DependencyModel.Type values. */
export const DEPENDENCY_TYPE_CODES: Readonly<Record<SnippetLinkType, number>> = { SS: 0, SF: 1, FS: 2, FF: 3 };

export function linkTypeOfCode(code: number | null | undefined): SnippetLinkType {
  return (Object.entries(DEPENDENCY_TYPE_CODES).find(([, value]) => value === code)?.[0] as SnippetLinkType | undefined) ?? 'FS';
}

/** How each link type reads in the app: a short label for chips, a sentence for hints. */
export const LINK_TYPE_WORDS: Readonly<Record<SnippetLinkType, { label: string; sentence: string }>> = {
  FS: { label: 'After it finishes', sentence: 'starts when the other task finishes' },
  SS: { label: 'Starts with it', sentence: 'starts when the other task starts' },
  FF: { label: 'Finishes with it', sentence: 'finishes when the other task finishes' },
  SF: { label: 'Finishes as it starts', sentence: 'finishes when the other task starts' },
};

export const SNIPPET_RANGE_TONES = ['amber', 'sky', 'rose', 'violet', 'green', 'slate'] as const;
export const SnippetRangeTone = z.enum(SNIPPET_RANGE_TONES);
export type SnippetRangeTone = z.infer<typeof SnippetRangeTone>;

const snippetKey = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[A-Za-z0-9_.-]+$/, 'letters, digits, dot, dash or underscore')
  .describe('Unique inside the snippet, e.g. "studs"; links and time ranges refer to tasks by key');

/** When a cost falls due: when the work is ordered (it starts), when it is delivered, or when it is done. */
export const COST_DUE = ['on_order', 'on_delivery', 'on_completion'] as const;
export const CostDue = z.enum(COST_DUE);
export type CostDue = z.infer<typeof CostDue>;

export const COST_DUE_WORDS: Readonly<Record<CostDue, string>> = {
  on_order: 'on order',
  on_delivery: 'on delivery',
  on_completion: 'on completion',
};

/** What a task costs and who is paid for it: a supplier's goods or a firm's labor. */
export const SnippetCost = z.object({
  label: z.string().trim().min(1).max(80).describe('What it pays for, e.g. "LED panels, 48"'),
  payee: z.string().trim().min(1).max(80).describe('Who is paid: the supplier or the crew\'s firm, e.g. "Lumen & Co Lighting"'),
  amount: z.int().min(0).max(10_000_000).describe('Whole dollars, e.g. 18400'),
  due: CostDue.describe('When it is owed: on_order (when the task starts), on_delivery (when a delivery task is done) or on_completion (when the task is done)'),
});
export type SnippetCost = z.infer<typeof SnippetCost>;

export const SnippetCrew = z.object({
  name: z.string().trim().min(1).max(80).describe('Crew name as the project calls it, e.g. "Carpenters"'),
  units: z.int().min(10).max(1000).optional().describe('Percent of the crew on the task; leave out for 100'),
});
export type SnippetCrew = z.infer<typeof SnippetCrew>;

export interface SnippetTask {
  key: string;
  name: string;
  /** Working days. Leaves only; 0 makes a milestone. Groups take their dates from their tasks. */
  duration?: number;
  crews?: SnippetCrew[];
  /** Leaves only: what the task costs, and who is paid. */
  costs?: SnippetCost[];
  note?: string;
  children?: SnippetTask[];
}

export const SnippetTask: z.ZodType<SnippetTask> = z.object({
  key: snippetKey,
  name: z.string().trim().min(1).max(160),
  duration: z.int().min(0).max(500).optional().describe('Working days for a task (0 = milestone); leave out for a group'),
  crews: z.array(SnippetCrew).max(8).optional(),
  costs: z.array(SnippetCost).max(6).optional().describe('Tasks only: what the task costs and who is paid'),
  note: z.string().trim().max(600).optional(),
  get children() {
    return z.array(SnippetTask).max(60).optional().describe('Tasks of a group; leave out for a task');
  },
});

export const SnippetLink = z.object({
  from: snippetKey.describe('Key of the task that comes first'),
  to: snippetKey.describe('Key of the task that depends on it'),
  type: SnippetLinkType.optional().describe('FS (default): to starts after from finishes; SS: starts together; FF: finish together; SF: to finishes when from starts'),
  lag: z.int().min(-120).max(250).optional().describe('Working days; negative is a lead (overlap)'),
});
export type SnippetLink = z.infer<typeof SnippetLink>;

export const SnippetEdge = z.object({
  task: snippetKey,
  edge: z.enum(['start', 'end']),
});
export type SnippetEdge = z.infer<typeof SnippetEdge>;

/** A shaded band on the timeline, from one task's start or end to another's (e.g. "Floor topping drying: keep off"). */
export const SnippetTimeRange = z.object({
  key: snippetKey,
  name: z.string().trim().min(1).max(80),
  from: SnippetEdge,
  to: SnippetEdge,
  tone: SnippetRangeTone.optional(),
  note: z.string().trim().max(300).optional(),
});
export type SnippetTimeRange = z.infer<typeof SnippetTimeRange>;

/**
 * A time range as it lives in the plan, on the top task of a dropped snippet (the task field
 * `bands`): tied to the start or end of a task inside that top task, found by its position
 * (child indexes from the top task down), so it keeps working when the server renumbers new tasks.
 * The bands drawn on the timeline follow those tasks' dates.
 */
export const TaskBand = z.object({
  name: z.string().min(1).max(80),
  tone: SnippetRangeTone,
  from: z.object({ path: z.array(z.int().min(0)).min(1).max(8), edge: z.enum(['start', 'end']) }),
  to: z.object({ path: z.array(z.int().min(0)).min(1).max(8), edge: z.enum(['start', 'end']) }),
  note: z.string().max(300).optional(),
});
export type TaskBand = z.infer<typeof TaskBand>;

/** The plan inside a snippet: what `library_snippets.body` stores. */
export const SnippetBody = z.object({
  children: z.array(SnippetTask).min(1).max(60),
  links: z.array(SnippetLink).max(300),
  timeRanges: z.array(SnippetTimeRange).max(12).optional(),
});
export type SnippetBody = z.infer<typeof SnippetBody>;

const iconName = z
  .string()
  .trim()
  .regex(/^[a-z0-9-]{1,40}$/)
  .describe('FontAwesome icon name, e.g. "door-open"');

export const SnippetUnit = z.object({
  one: z.string().trim().min(1).max(30).describe('What one copy covers, e.g. "room"'),
  many: z.string().trim().min(1).max(30).describe('Plural, e.g. "rooms"'),
});
export type SnippetUnit = z.infer<typeof SnippetUnit>;

/** Everything about a snippet except where it is filed: what the builder edits and the assistant drafts. */
export const SnippetDraft = SnippetBody.extend({
  name: z.string().trim().min(1).max(120).describe('Name of the top task, e.g. "Exam room build-out"'),
  summary: z.string().trim().max(400),
  icon: iconName,
  unit: SnippetUnit,
});
export type SnippetDraft = z.infer<typeof SnippetDraft>;

export interface Snippet extends SnippetDraft {
  id: string;
}

// -----------------------------------------------------------------------------------------
// The library in the database
// -----------------------------------------------------------------------------------------

export function libraryTopic(projectId: string): string {
  return `project:${projectId}:library`;
}

export const LIBRARY_ORIGINS = ['starter', 'person', 'assistant', 'plan'] as const;
export const LibraryOrigin = z.enum(LIBRARY_ORIGINS);
export type LibraryOrigin = z.infer<typeof LibraryOrigin>;

export const LibraryFolderRow = z.object({
  id: uuid,
  project_id: uuid,
  parent_id: uuid.nullable(),
  name: z.string().min(1).max(80),
  position: z.number(),
  created_by: uuid.nullable(),
  created_at: timestamp,
  updated_at: timestamp,
});
export type LibraryFolderRow = z.infer<typeof LibraryFolderRow>;

export const LibrarySnippetRow = z.object({
  id: uuid,
  project_id: uuid,
  folder_id: uuid.nullable(),
  name: z.string().min(1).max(120),
  summary: z.string().max(400),
  icon: z.string(),
  unit_one: z.string(),
  unit_many: z.string(),
  body: z.unknown(),
  position: z.number(),
  origin: LibraryOrigin,
  created_by: uuid.nullable(),
  updated_by: uuid.nullable(),
  created_at: timestamp,
  updated_at: timestamp,
});
export type LibrarySnippetRow = z.infer<typeof LibrarySnippetRow>;

/** The snippet a row holds; null when its body does not parse (it is then left out of the library). */
export function snippetFromRow(row: LibrarySnippetRow): Snippet | null {
  const draft = SnippetDraft.safeParse({
    ...(row.body as object),
    name: row.name,
    summary: row.summary,
    icon: row.icon,
    unit: { one: row.unit_one, many: row.unit_many },
  });
  return draft.success ? { id: row.id, ...draft.data } : null;
}

/** The row fields for a draft (what an insert or update writes). */
export function rowFieldsOf(draft: SnippetDraft): Pick<LibrarySnippetRow, 'name' | 'summary' | 'icon' | 'unit_one' | 'unit_many' | 'body'> {
  const body: SnippetBody = { children: draft.children, links: draft.links, ...(draft.timeRanges?.length ? { timeRanges: draft.timeRanges } : {}) };
  return { name: draft.name, summary: draft.summary, icon: draft.icon, unit_one: draft.unit.one, unit_many: draft.unit.many, body };
}

// -----------------------------------------------------------------------------------------
// Walking a snippet
// -----------------------------------------------------------------------------------------

export const isGroupTask = (task: SnippetTask): boolean => Boolean(task.children && task.children.length > 0);

/**
 * The piece without the tasks named (by name, as people write them): their links and time ranges go
 * too, and so does a group left empty. For work done once for the whole building, such as ordering and
 * delivery, when the piece goes on the other floors.
 */
export function snippetWithout<T extends Pick<SnippetBody, 'children' | 'links' | 'timeRanges'>>(snippet: T, names: readonly string[]): T {
  const gone = new Set(names.map(normalName));
  const keep = (tasks: readonly SnippetTask[]): SnippetTask[] =>
    tasks.flatMap((task) => {
      if (!isGroupTask(task)) return gone.has(normalName(task.name)) ? [] : [task];
      const children = keep(task.children!);
      return children.length > 0 ? [{ ...task, children }] : [];
    });
  const children = keep(snippet.children);
  const kept = new Set(allTasksOf(children).map((task) => task.key));
  const links = snippet.links.filter((link) => kept.has(link.from) && kept.has(link.to));
  const timeRanges = snippet.timeRanges?.filter((range) => kept.has(range.from.task) && kept.has(range.to.task));
  return { ...snippet, children, links, ...(timeRanges ? { timeRanges } : {}) };
}

export function allTasksOf(tasks: readonly SnippetTask[]): SnippetTask[] {
  return tasks.flatMap((task) => [task, ...allTasksOf(task.children ?? [])]);
}

export function leavesOf(tasks: readonly SnippetTask[]): SnippetTask[] {
  return tasks.flatMap((task) => (isGroupTask(task) ? leavesOf(task.children!) : [task]));
}

/** Leaves of the snippet nothing inside it comes before: they follow the work it is dropped after. */
export function entryKeys(body: Pick<SnippetBody, 'children' | 'links'>): string[] {
  const targets = new Set(body.links.map((link) => link.to));
  return leavesOf(body.children)
    .map((task) => task.key)
    .filter((key) => !targets.has(key));
}

/** Leaves of the snippet nothing inside it comes after: later work waits for them. */
export function exitKeys(body: Pick<SnippetBody, 'children' | 'links'>): string[] {
  const sources = new Set(body.links.map((link) => link.from));
  return leavesOf(body.children)
    .map((task) => task.key)
    .filter((key) => !sources.has(key));
}

/** Outline numbers under the top task: "1", "1.2", "1.2.1". */
export function outlineNumbers(tasks: readonly SnippetTask[], prefix = ''): Map<string, string> {
  const numbers = new Map<string, string>();
  tasks.forEach((task, index) => {
    const number = `${prefix}${index + 1}`;
    numbers.set(task.key, number);
    for (const [key, value] of outlineNumbers(task.children ?? [], `${number}.`)) numbers.set(key, value);
  });
  return numbers;
}

/** A key not used yet in the snippet, from a name: "Hang, tape & finish" -> "hang-tape-finish" (or "-2"). */
export function freshKey(tasks: readonly SnippetTask[], name: string, extra: Iterable<string> = []): string {
  const taken = new Set([...allTasksOf(tasks).map((task) => task.key), ...extra]);
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 28) || 'task';
  if (!taken.has(base)) return base;
  for (let index = 2; ; index++) {
    const candidate = `${base}-${index}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Distinct crew names, in order of first use. */
export function crewNamesOf(tasks: readonly SnippetTask[]): string[] {
  const names: string[] = [];
  for (const task of leavesOf(tasks)) {
    for (const crew of task.crews ?? []) if (!names.includes(crew.name)) names.push(crew.name);
  }
  return names;
}

// -----------------------------------------------------------------------------------------
// Laying a snippet out in working days
// -----------------------------------------------------------------------------------------

export interface ScheduledSnippetTask {
  /** Working days after the snippet's start. */
  start: number;
  finish: number;
  /** Working days the task can slip without making the snippet longer (leaves only; 0 for groups). */
  float: number;
  critical: boolean;
}

export interface SnippetSchedule {
  tasks: Map<string, ScheduledSnippetTask>;
  /** Working days from the first task's start to the last task's finish. */
  span: number;
  /** Keys of tasks on a loop of links (the layout ignores those links). */
  loop: string[];
}

export function scaleDuration(duration: number, scale: number): number {
  if (duration <= 0) return 0;
  return Math.max(1, Math.round(duration * scale));
}

export function scaleLag(lag: number, scale: number): number {
  if (lag === 0) return 0;
  const scaled = Math.round(Math.abs(lag) * scale);
  return Math.sign(lag) * Math.max(1, scaled);
}

/**
 * The earliest start and finish of every task (critical path method over the leaves, all four link
 * types, leads included; nothing starts before day 0), then a backward pass for float. Groups span
 * their tasks. Links on a loop are left out and their tasks reported in `loop`.
 */
export function scheduleSnippet(body: Pick<SnippetBody, 'children' | 'links'>, scale = 1): SnippetSchedule {
  const leaves = leavesOf(body.children);
  const duration = new Map(leaves.map((task) => [task.key, scaleDuration(task.duration ?? 0, scale)]));
  const links = body.links
    .filter((link) => duration.has(link.from) && duration.has(link.to) && link.from !== link.to)
    .map((link) => ({ from: link.from, to: link.to, type: link.type ?? 'FS', lag: scaleLag(link.lag ?? 0, scale) }));

  // Kahn's order over the leaves; whatever never frees up sits on (or behind) a loop.
  const incoming = new Map(leaves.map((task) => [task.key, 0]));
  for (const link of links) incoming.set(link.to, (incoming.get(link.to) ?? 0) + 1);
  const order: string[] = [];
  const ready = leaves.map((task) => task.key).filter((key) => incoming.get(key) === 0);
  while (ready.length > 0) {
    const key = ready.shift()!;
    order.push(key);
    for (const link of links) {
      if (link.from !== key) continue;
      const left = (incoming.get(link.to) ?? 0) - 1;
      incoming.set(link.to, left);
      if (left === 0) ready.push(link.to);
    }
  }
  const ordered = new Set(order);
  const loop = leaves.map((task) => task.key).filter((key) => !ordered.has(key));
  order.push(...loop);
  const usable = links.filter((link) => ordered.has(link.from) && ordered.has(link.to));

  const start = new Map<string, number>();
  for (const key of order) {
    const own = duration.get(key) ?? 0;
    let earliest = 0;
    for (const link of usable) {
      if (link.to !== key || !start.has(link.from)) continue;
      const fromStart = start.get(link.from)!;
      const fromFinish = fromStart + (duration.get(link.from) ?? 0);
      const bound =
        link.type === 'FS'
          ? fromFinish + link.lag
          : link.type === 'SS'
            ? fromStart + link.lag
            : link.type === 'FF'
              ? fromFinish + link.lag - own
              : fromStart + link.lag - own;
      earliest = Math.max(earliest, bound);
    }
    start.set(key, earliest);
  }
  const finishOf = (key: string) => (start.get(key) ?? 0) + (duration.get(key) ?? 0);
  const span = Math.max(0, ...leaves.map((task) => finishOf(task.key)));

  // Backward pass: the latest finish that keeps the span.
  const lateFinish = new Map<string, number>();
  for (const key of [...order].reverse()) {
    const own = duration.get(key) ?? 0;
    let latest = span;
    for (const link of usable) {
      if (link.from !== key || !lateFinish.has(link.to)) continue;
      const toLateFinish = lateFinish.get(link.to)!;
      const toLateStart = toLateFinish - (duration.get(link.to) ?? 0);
      const bound =
        link.type === 'FS'
          ? toLateStart - link.lag
          : link.type === 'SS'
            ? toLateStart - link.lag + own
            : link.type === 'FF'
              ? toLateFinish - link.lag
              : toLateFinish - link.lag + own;
      latest = Math.min(latest, bound);
    }
    lateFinish.set(key, latest);
  }

  const tasks = new Map<string, ScheduledSnippetTask>();
  for (const task of leaves) {
    const float = Math.max(0, (lateFinish.get(task.key) ?? span) - finishOf(task.key));
    tasks.set(task.key, { start: start.get(task.key) ?? 0, finish: finishOf(task.key), float, critical: float === 0 });
  }
  const group = (task: SnippetTask): ScheduledSnippetTask => {
    if (!isGroupTask(task)) return tasks.get(task.key)!;
    const parts = task.children!.map(group);
    const scheduled = {
      start: Math.min(...parts.map((part) => part.start)),
      finish: Math.max(...parts.map((part) => part.finish)),
      float: 0,
      critical: parts.some((part) => part.critical),
    };
    tasks.set(task.key, scheduled);
    return scheduled;
  };
  body.children.forEach(group);
  return { tasks, span, loop };
}

export function snippetSpan(body: Pick<SnippetBody, 'children' | 'links'>, scale = 1): number {
  return scheduleSnippet(body, scale).span;
}

// -----------------------------------------------------------------------------------------
// Checking a snippet
// -----------------------------------------------------------------------------------------

export interface SnippetProblem {
  level: 'error' | 'warning';
  message: string;
  /** The task, link target or time range the problem is about, when there is one. */
  key?: string;
}

/**
 * What stops a snippet from being saved (errors) and what is worth a look (warnings), in plain words.
 * `knownCrews`: the project's crew names; crews not among them are a warning (they are left off when
 * the snippet is dropped).
 */
export function checkSnippet(draft: Pick<SnippetDraft, 'name' | 'children' | 'links'> & { timeRanges?: readonly SnippetTimeRange[] }, knownCrews?: readonly string[]): SnippetProblem[] {
  const problems: SnippetProblem[] = [];
  const tasks = allTasksOf(draft.children);
  if (!draft.name.trim()) problems.push({ level: 'error', message: 'Give the snippet a name.' });
  if (tasks.length === 0) problems.push({ level: 'error', message: 'Add at least one task.' });
  const seen = new Set<string>();
  for (const task of tasks) {
    if (seen.has(task.key)) problems.push({ level: 'error', message: `Two rows share the key “${task.key}”.`, key: task.key });
    seen.add(task.key);
    if (!task.name.trim()) problems.push({ level: 'error', message: 'Every row needs a name.', key: task.key });
    if (!isGroupTask(task) && (task.duration === undefined || !Number.isInteger(task.duration) || task.duration < 0)) {
      problems.push({ level: 'error', message: `“${task.name || task.key}” needs a whole number of working days.`, key: task.key });
    }
  }
  const leafKeys = new Set(leavesOf(draft.children).map((task) => task.key));
  const nameOf = (key: string) => tasks.find((task) => task.key === key)?.name ?? key;
  const pairs = new Set<string>();
  for (const link of draft.links) {
    if (!leafKeys.has(link.from) || !leafKeys.has(link.to)) {
      problems.push({ level: 'error', message: `A link points at “${nameOf(leafKeys.has(link.from) ? link.to : link.from)}”, which is not a task of this snippet (links join tasks, not groups).`, key: link.to });
      continue;
    }
    if (link.from === link.to) problems.push({ level: 'error', message: `“${nameOf(link.from)}” cannot depend on itself.`, key: link.to });
    const pair = `${link.from}>${link.to}`;
    if (pairs.has(pair)) problems.push({ level: 'warning', message: `“${nameOf(link.to)}” depends on “${nameOf(link.from)}” twice; the later link wins.`, key: link.to });
    pairs.add(pair);
    if ((link.lag ?? 0) < 0) {
      const from = leavesOf(draft.children).find((task) => task.key === link.from);
      if (from && (link.type ?? 'FS') === 'FS' && -(link.lag ?? 0) > (from.duration ?? 0)) {
        problems.push({ level: 'warning', message: `The lead on “${nameOf(link.to)}” is longer than “${nameOf(link.from)}” itself.`, key: link.to });
      }
    }
  }
  if (problems.every((problem) => problem.level !== 'error')) {
    const { loop } = scheduleSnippet(draft);
    if (loop.length > 0) {
      problems.push({ level: 'error', message: `These tasks wait for each other in a loop: ${loop.map(nameOf).join(', ')}.`, key: loop[0] });
    }
  }
  const allKeys = new Set(tasks.map((task) => task.key));
  for (const range of draft.timeRanges ?? []) {
    if (!range.name.trim()) problems.push({ level: 'error', message: 'Every time range needs a name.', key: range.key });
    if (!allKeys.has(range.from.task) || !allKeys.has(range.to.task)) {
      problems.push({ level: 'error', message: `The time range “${range.name}” is tied to a row that is no longer in the snippet.`, key: range.key });
    }
  }
  if (knownCrews) {
    const known = new Set(knownCrews.map(normalName));
    const unknown = crewNamesOf(draft.children).filter((name) => !known.has(normalName(name)));
    if (unknown.length > 0) {
      problems.push({ level: 'warning', message: `Not on this project yet: ${unknown.join(', ')}. Those tasks are added without that crew.` });
    }
  }
  return problems;
}

/** Names compared without case or extra spaces. */
export function normalName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

// -----------------------------------------------------------------------------------------
// The snippet as dropped: renamed, scaled, repeated
// -----------------------------------------------------------------------------------------

export interface SnippetTweaks {
  /** Name of the top task (of each copy, numbered when there are several). */
  name: string;
  /** Duration factor; each duration is rounded to whole working days, at least 1 (milestones stay 0). Lags scale too. */
  scale: number;
  /** Numbered copies, chained one after another. */
  repeats: number;
}

export const SCALE_CHOICES = [
  { value: 0.5, label: 'Half the time' },
  { value: 0.75, label: 'A bit quicker' },
  { value: 1, label: 'As listed' },
  { value: 1.5, label: 'A bit longer' },
  { value: 2, label: 'Twice as long' },
] as const;

export const MAX_REPEATS = 8;

export function defaultTweaks(snippet: Pick<Snippet, 'name'>): SnippetTweaks {
  return { name: snippet.name, scale: 1, repeats: 1 };
}

/** A task ready to create: keys are unique across all copies. */
export interface PlannedTask {
  key: string;
  name: string;
  /** Leaves only. */
  duration?: number;
  crews: SnippetCrew[];
  /** Leaves only. */
  costs: SnippetCost[];
  note?: string;
  children: PlannedTask[];
}

export interface PlannedLink {
  from: string;
  to: string;
  type: SnippetLinkType;
  lag: number;
}

export interface PlannedTimeRange {
  key: string;
  name: string;
  from: SnippetEdge;
  to: SnippetEdge;
  tone: SnippetRangeTone;
  note?: string;
}

export interface SnippetPlan {
  snippet: Snippet;
  tweaks: SnippetTweaks;
  /** One top task per copy, in order. */
  copies: PlannedTask[];
  /** Links inside each copy, plus each copy's top task to the next copy's first tasks. */
  links: PlannedLink[];
  /** Bands of every copy, tied to planned task keys. */
  timeRanges: PlannedTimeRange[];
  /** Keys of the first copy's tasks that wait for nothing inside the snippet: they follow the work it is dropped after. */
  entryKeys: string[];
  /** Keys of the last copy's tasks nothing inside it waits for (the copy's top task is `exitKey`). */
  exitLeafKeys: string[];
  /** Key of the last copy's top task: later work waits for it. */
  exitKey: string;
  /** Working days from the first task's start to the last task's finish (copies one after another). */
  span: number;
  /** Every task created, top tasks and groups included. */
  taskCount: number;
  /** Distinct crew names, in order of first use. */
  crews: string[];
  /** The piece goes in as rows of its own, with no group row over them: `copies` are its tasks. */
  flat?: boolean;
}

const copyKey = (copy: number, key: string) => `${copy}/${key}`;

/** "Exam room build-out – room 2" when there are several copies, the plain name otherwise. */
export function copyName(snippet: Pick<Snippet, 'unit'>, name: string, index: number, count: number): string {
  return count > 1 ? `${name} – ${snippet.unit.one} ${index + 1}` : name;
}

function planTask(task: SnippetTask, copy: number, scale: number): PlannedTask {
  const children = (task.children ?? []).map((child) => planTask(child, copy, scale));
  return {
    key: copyKey(copy, task.key),
    name: task.name,
    ...(children.length === 0 && { duration: scaleDuration(task.duration ?? 0, scale) }),
    crews: task.crews ?? [],
    costs: children.length === 0 ? (task.costs ?? []) : [],
    ...(task.note && { note: task.note }),
    children,
  };
}

export function countTasks(tasks: readonly PlannedTask[]): number {
  return tasks.reduce((count, task) => count + 1 + countTasks(task.children), 0);
}

/** Tasks one after another, finish to start: no groups, no time ranges, each task waiting for the one before it. */
export function isFlatSnippet(snippet: Pick<Snippet, 'children' | 'links' | 'timeRanges'>): boolean {
  const { children, links, timeRanges } = snippet;
  if (children.length === 0 || (timeRanges?.length ?? 0) > 0 || children.some((task) => (task.children?.length ?? 0) > 0)) return false;
  if (links.length !== children.length - 1) return false;
  const next = new Map(links.map((link) => [link.from, link]));
  return children.slice(0, -1).every((task, index) => {
    const link = next.get(task.key);
    return link !== undefined && link.to === children[index + 1]!.key && (link.type ?? 'FS') === 'FS' && (link.lag ?? 0) === 0;
  });
}

export function planSnippet(snippet: Snippet, tweaks: SnippetTweaks): SnippetPlan {
  const repeats = Math.min(MAX_REPEATS, Math.max(1, Math.round(tweaks.repeats)));
  const name = tweaks.name.trim() || snippet.name;
  const entries = entryKeys(snippet);
  const exits = exitKeys(snippet);
  // A plain run of tasks goes in as rows of their own, with no group row over them: spliced between two
  // tasks of a waterfall, the plan stays one line.
  if (repeats === 1 && isFlatSnippet(snippet)) {
    const tops = snippet.children.map((task) => planTask(task, 0, tweaks.scale));
    const exit = exits[exits.length - 1] ?? snippet.children[snippet.children.length - 1]!.key;
    return {
      snippet,
      tweaks: { name, scale: tweaks.scale, repeats },
      copies: tops,
      links: snippet.links.map((link) => ({ from: copyKey(0, link.from), to: copyKey(0, link.to), type: link.type ?? 'FS', lag: scaleLag(link.lag ?? 0, tweaks.scale) })),
      timeRanges: [],
      entryKeys: entries.map((key) => copyKey(0, key)),
      exitLeafKeys: exits.map((key) => copyKey(0, key)),
      exitKey: copyKey(0, exit),
      span: snippetSpan(snippet, tweaks.scale),
      taskCount: tops.length,
      crews: crewNamesOf(snippet.children),
      flat: true,
    };
  }
  const copies: PlannedTask[] = [];
  const links: PlannedLink[] = [];
  const timeRanges: PlannedTimeRange[] = [];
  for (let copy = 0; copy < repeats; copy++) {
    const copyTitle = copyName(snippet, name, copy, repeats);
    copies.push({
      key: copyKey(copy, ''),
      name: copyTitle,
      crews: [],
      costs: [],
      children: snippet.children.map((task) => planTask(task, copy, tweaks.scale)),
    });
    for (const link of snippet.links) {
      links.push({ from: copyKey(copy, link.from), to: copyKey(copy, link.to), type: link.type ?? 'FS', lag: scaleLag(link.lag ?? 0, tweaks.scale) });
    }
    if (copy > 0) {
      for (const entry of entries) {
        links.push({ from: copyKey(copy - 1, ''), to: copyKey(copy, entry), type: 'FS', lag: 0 });
      }
    }
    for (const range of snippet.timeRanges ?? []) {
      timeRanges.push({
        key: copyKey(copy, range.key),
        name: repeats > 1 ? `${range.name} – ${snippet.unit.one} ${copy + 1}` : range.name,
        from: { task: copyKey(copy, range.from.task), edge: range.from.edge },
        to: { task: copyKey(copy, range.to.task), edge: range.to.edge },
        tone: range.tone ?? 'amber',
        ...(range.note && { note: range.note }),
      });
    }
  }
  return {
    snippet,
    tweaks: { name, scale: tweaks.scale, repeats },
    copies,
    links,
    timeRanges,
    entryKeys: entries.map((key) => copyKey(0, key)),
    exitLeafKeys: exits.map((key) => copyKey(repeats - 1, key)),
    exitKey: copyKey(repeats - 1, ''),
    span: snippetSpan(snippet, tweaks.scale) * repeats,
    taskCount: countTasks(copies),
    crews: crewNamesOf(snippet.children),
  };
}

// -----------------------------------------------------------------------------------------
// A snippet from work already in a plan
// -----------------------------------------------------------------------------------------

/** A task of a plan, as `snippetFromOutline` needs it (the web app reads it from Bryntum, the agent from its snapshot). */
export interface OutlineTask {
  id: number | string;
  name: string;
  /** Working days (leaves). */
  days: number;
  crews: SnippetCrew[];
  note?: string | null;
  children: OutlineTask[];
}

export interface OutlineLink {
  from: number | string;
  to: number | string;
  type: SnippetLinkType;
  /** Working days; negative is a lead. */
  lag: number;
}

export interface OutlineRange {
  name: string;
  from: { id: number | string; edge: 'start' | 'end' };
  to: { id: number | string; edge: 'start' | 'end' };
  tone?: SnippetRangeTone;
}

/**
 * The snippet a group of the plan makes: its children become the snippet's tasks (the group itself is
 * the top task, so its name becomes the snippet's name), the links between its own tasks are kept and
 * links to outside work dropped. Keys come from the task names.
 */
export function snippetFromOutline(top: OutlineTask, links: readonly OutlineLink[], ranges: readonly OutlineRange[] = []): SnippetDraft {
  const keyOf = new Map<string, string>();
  const taken: string[] = [];
  const convert = (task: OutlineTask): SnippetTask => {
    const key = freshKey([], task.name, taken);
    taken.push(key);
    keyOf.set(String(task.id), key);
    if (task.children.length > 0) return { key, name: task.name, children: task.children.map(convert), ...(task.note ? { note: task.note } : {}) };
    return {
      key,
      name: task.name,
      duration: Math.max(0, Math.round(task.days)),
      ...(task.crews.length > 0 ? { crews: task.crews.map((crew) => ({ name: crew.name, ...(crew.units && crew.units !== 100 ? { units: crew.units } : {}) })) } : {}),
      ...(task.note ? { note: task.note.slice(0, 600) } : {}),
    };
  };
  // A single task saves as itself, under a top task of the same name.
  const children = top.children.length > 0 ? top.children.map(convert) : [convert({ ...top, children: [] })];
  const leafKeys = new Set(leavesOf(children).map((task) => task.key));
  const snippetLinks: SnippetLink[] = [];
  for (const link of links) {
    const from = keyOf.get(String(link.from));
    const to = keyOf.get(String(link.to));
    if (!from || !to || !leafKeys.has(from) || !leafKeys.has(to)) continue;
    snippetLinks.push({ from, to, ...(link.type !== 'FS' ? { type: link.type } : {}), ...(link.lag !== 0 ? { lag: Math.round(link.lag) } : {}) });
  }
  const timeRanges: SnippetTimeRange[] = [];
  for (const range of ranges) {
    const from = keyOf.get(String(range.from.id));
    const to = keyOf.get(String(range.to.id));
    if (!from || !to) continue;
    timeRanges.push({ key: freshKey([], range.name, [...taken, ...timeRanges.map((r) => r.key)]), name: range.name, from: { task: from, edge: range.from.edge }, to: { task: to, edge: range.to.edge }, ...(range.tone ? { tone: range.tone } : {}) });
  }
  const leafCount = leavesOf(children).length;
  return {
    name: top.name,
    summary: `${leafCount} task${leafCount === 1 ? '' : 's'} saved from the plan.`,
    icon: 'cubes',
    unit: { one: 'copy', many: 'copies' },
    children,
    links: snippetLinks,
    ...(timeRanges.length > 0 ? { timeRanges } : {}),
  };
}
