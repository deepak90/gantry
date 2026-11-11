/**
 * Remy on screen: what she shows a person in their own tab, with her own cursor, when they ask to see something
 * ("take me to the site view", "go to row 12", "filter to the electrician's work", "zoom to June", "undo that").
 * Each tool files a `ui_action` command for the person who asked; their tab carries it out
 * (apps/web/src/assistant/remy-ui.ts): the cursor goes to the real control, presses it, and the app does the rest
 * through its own code and Bryntum's API.
 *
 * Words are matched to the plan here, where the plan is: a task by its name or outline number, a crew by its name or
 * trade, a month to its year, a payment hold to the work it pays for. The browser maps what is meant to what is on
 * its screen (a row, a column, a button). None of these change the plan, approve, pay or bill: undo and redo are the
 * person's own toolbar buttons, and a payment or an invoice only comes up for them to review.
 */
import { UI_ACTION_CLAIM_MS, UI_ACTION_TIMEOUT_MS, UiAction, UiActionOutcome, normalName, type UiTaskTarget } from '@collab/shared';
import { z } from 'zod';
import type { LibraryRows } from '../data/store';
import { day } from '../plan/format';
import { libraryItems } from '../plan/library';
import type { PlanResource, PlanSnapshot, PlanTask } from '../plan/snapshot';
import type { CommandOutcome } from './commands';
import { ToolRefusal } from './refusal';

const date = z.iso.date().describe('Calendar date YYYY-MM-DD');

/** How a tool names a task: an id from a tool result, its name, its outline number, or its row on their screen. */
const taskWords = {
  task_id: z.int().positive().nullish().describe('The task’s id, from a tool result'),
  name: z.string().trim().min(1).max(160).nullish().describe('Its name, or the words of it they used ("the slab"), when you have no id'),
  wbs: z
    .string()
    .trim()
    .regex(/^\d{1,4}(\.\d{1,4}){0,8}$/)
    .nullish()
    .describe('Its outline number (WBS) as the plan shows it, e.g. "2.3.1"'),
  row: z.int().min(1).max(5000).nullish().describe('Its row on their screen, counted from the top ("row 12")'),
};

export const ScreenToolSchemas = {
  site_view: z.object({
    open: z.boolean().describe('True to open the 3D site view; false to close it and go back to the chart'),
    look: z
      .enum(['crane', 'from_crane', 'level', 'whole'])
      .nullish()
      .describe(
        'crane: look at the tower crane and its days on rent ("show me the crane"); from_crane: ride up on the crane and look down ("take me up the crane"); level: look into one level (level); whole: the whole site again',
      ),
    level: z.string().trim().min(1).max(60).nullish().describe('For look level: the level in their words ("level 2", "the ground floor", "the roof")'),
  }),
  play_site: z.object({
    do: z.enum(['play', 'pause', 'go_to_day']).describe('play: the building’s days going by; pause: stop on the day on show; go_to_day: show one day'),
    from: date.nullish().describe('play: the first day; leave out to start from the day on show'),
    to: date.nullish().describe('play: the last day; leave out to play to the end (or for days)'),
    days: z.int().min(1).max(800).nullish().describe('play: how many days to play from the start, when they said a length ("the next two weeks": 14)'),
    seconds: z.int().min(2).max(120).nullish().describe('play: about how long it takes, only when they said ("slowly": 20)'),
    day: date.nullish().describe('go_to_day: the day'),
  }),
  go_to_task: z.object({
    ...taskWords,
    column: z
      .string()
      .trim()
      .min(1)
      .max(40)
      .nullish()
      .describe('A column of its row, in their words ("start", "finish", "days", "progress", "crew", "budget"), to show that cell'),
    open: z
      .enum(['cell_editor', 'task_editor'])
      .nullish()
      .describe('task_editor: the task’s editor, as a double-click opens it ("open the editor for the slab"); cell_editor: edit the cell in column'),
    bar: z.boolean().nullish().describe('True to point at its bar on the timeline ("show me the slab’s bar")'),
  }),
  filter_plan: z.object({
    text: z.string().trim().min(1).max(80).nullish().describe('Words in the task names (or a crew name) to keep'),
    crew: z.string().trim().min(1).max(80).nullish().describe('A crew, firm or trade, in their words ("the electrician", "Volt Electric", "plumbing")'),
    from: date.nullish().describe('Keep work on or after this day'),
    to: date.nullish().describe('Keep work on or before this day'),
    clear: z.boolean().nullish().describe('True to show the whole plan again ("show everything", "clear the filter")'),
  }),
  search_plan: z.object({
    text: z.string().trim().min(1).max(80).nullish().describe('What to find, in their words ("the punch list")'),
    step: z.enum(['next', 'previous']).nullish().describe('Go to the next or previous match of the last search ("next one")'),
    clear: z.boolean().nullish().describe('True to take the highlight off'),
  }),
  expand_plan: z.object({
    open: z.boolean().describe('True to open (expand), false to close (collapse)'),
    task_id: taskWords.task_id.describe('One group, by id; leave every way of naming a group out for all of them'),
    name: taskWords.name,
    wbs: taskWords.wbs,
  }),
  zoom_plan: z.object({
    to: z
      .enum(['fit', 'in', 'out', 'month', 'dates', 'day'])
      .describe('fit: the whole project; in or out: one step; month: one month ("zoom to June"); dates: first_day to last_day; day: scroll the chart to first_day, the zoom kept ("go to December 3 on the chart")'),
    month: z.int().min(1).max(12).nullish().describe('For month: 1 to 12'),
    year: z.int().min(2000).max(2100).nullish().describe('For month, only when they said a year; otherwise the plan’s own year for that month is used'),
    first_day: date.nullish(),
    last_day: date.nullish(),
  }),
  open_panel: z.object({
    panel: z
      .enum(['library', 'rentals', 'documents', 'assistant', 'crews', 'alerts', 'history', 'task'])
      .describe('library: the task library; rentals: rented equipment and paying for it; documents: quotes, receipts and drawings; assistant: your conversation; crews; alerts: the watch list; history: what changed; task: the selected task'),
  }),
  open_review: z.object({
    of: z.enum(['payment', 'invoice']).describe('payment: a payment hold’s progress payment, for review before someone presses Send payout; invoice: the newest invoice for the tenant, for review before someone sends it'),
    about: z.string().trim().min(1).max(160).nullish().describe('For a payment: the work it pays for or holds, in their words ("the footings", "level 1"); leave out for the next one due'),
  }),
  undo_redo: z.object({
    direction: z.enum(['undo', 'redo']),
    steps: z.int().min(1).max(5).nullish().describe('Only when they asked for more than one step'),
  }),
  close_view: z.object({
    what: z
      .enum(['modal', 'panel', 'odds'])
      .describe('modal: what is open over the page (the payment review, an invoice, the library drop card, the package editor), or the side panel when nothing is; panel: the side panel; odds: the odds panel'),
    panel: z
      .enum(['library', 'rentals', 'documents', 'assistant', 'crews', 'alerts', 'history', 'task'])
      .nullish()
      .describe('For panel, when they named one ("close the library"): it is closed only if it is the one open'),
  }),
  open_library_piece: z.object({
    package: z.string().trim().min(1).max(120).describe('The package or piece of work in the library, in their words ("the light fixtures")'),
  }),
  drag_library_piece: z.object({
    package: z.string().trim().min(1).max(120).describe('The library package, in their words'),
    onto: z.string().trim().min(1).max(160).nullish().describe('The task or group it goes onto, in their words ("level 2", "Level 2 build-out")'),
    onto_task_id: z.int().positive().nullish().describe('Or its id, from a tool result'),
    onto_wbs: taskWords.wbs.describe('Or its outline number'),
    inside: z.boolean().nullish().describe('True to go at the end of a group they named; a plain package let go on a group goes inside it anyway'),
  }),
};
export type ScreenToolName = keyof typeof ScreenToolSchemas;

const SHOWS = 'It moves only what that person sees, with your cursor in their tab; it never changes the plan.';

export const SCREEN_TOOL_DESCRIPTIONS: Record<ScreenToolName, string> = {
  site_view: `Open the 3D site view (the plan as the building on its lot) or close it back to the chart; with look, show the tower crane and its days on rent, ride up on it, look into one level, or the whole site again. ${SHOWS}`,
  play_site: `The 3D site view's days, as its play button and date rail work them: play the building going up from one day to another ("play this out", "play these dates", "the next two weeks"), pause, or show one day. It opens the site view first when it is closed. This is the plan as drawn, day by day: never the odds. ${SHOWS}`,
  go_to_task: `Take them to a task in the chart: by id, name, outline number (WBS) or row ("go to row 12"). Opens the groups above it, scrolls to it, selects it and flashes its row; with column, shows that cell; with open, opens the task's editor or the cell's editor for them to type in. A name that fits several tasks comes back as choices: ask which. ${SHOWS}`,
  filter_plan: `Show only part of the plan: tasks with some words, one crew's or firm's work, work in a span of days, or a mix; clear shows everything again. The filter shows above the chart, where they can clear it. ${SHOWS}`,
  search_plan: `Find tasks by their words and highlight every match on the chart, going to the first; step goes to the next or previous match. The answer says how many matched. ${SHOWS}`,
  expand_plan: `Open or close one group of the plan, or every group ("collapse everything"). ${SHOWS}`,
  zoom_plan: `Zoom the timeline: the whole project, one step in or out, one month ("zoom to June"), or a span of days. ${SHOWS}`,
  open_panel: `Bring a side panel forward: the task library, rentals, documents, your conversation, crews, the watch list's alerts, the plan's history, or the selected task. ${SHOWS}`,
  open_review: `Bring a payment hold's progress payment up for review (every firm and what each is due; a person who sees costs presses Send payout), or the newest invoice for the tenant (a person sends it). It never pays or sends. ${SHOWS}`,
  undo_redo: `Press Undo or Redo in their toolbar: it takes back (or puts back) their own last change to the plan, exactly, for everyone. The answer names each step.`,
  close_view: `Close what is open on their screen: the window or sheet over the page (the payment review, an invoice, the card asking how to tie a library piece in, the package editor), the side panel, or the odds panel. "Close that" is what <screen> shows open. Closing never pays, sends or adds anything. ${SHOWS}`,
  open_library_piece: `Open a package's card in the task library, to show what is in it: its tasks, how long it runs, its crews. ${SHOWS}`,
  drag_library_piece: `Carry a library package from its card onto a row of the chart, as a person drags it ("drag the light fixtures onto level 2"): the card that asks how to tie it in opens there, and the person picks a way and applies it. Nothing goes into the plan until they do. ${SHOWS}`,
};

export const isScreenTool = (name: string): name is ScreenToolName => name in ScreenToolSchemas;

/** What runs a command in a person's browser (the project's CommandRunner). */
export interface ScreenCommandPort {
  run(type: 'ui_action', args: unknown, requestedBy: string, requiredRevision: number | null, options?: { timeoutMs?: number; claimTimeoutMs?: number }): Promise<CommandOutcome>;
}

export interface ScreenToolContext {
  plan: PlanSnapshot;
  speaker: { userId: string; name: string } | null;
  commands?: ScreenCommandPort;
  /** The task library, for a package named by its words. */
  library?: LibraryRows;
}

/** A day `days` after `iso`, YYYY-MM-DD. */
function addDaysIso(iso: string, days: number): string {
  const [year, month, dayOfMonth] = iso.split('-').map(Number);
  const at = new Date(Date.UTC(year!, month! - 1, dayOfMonth! + days));
  return at.toISOString().slice(0, 10);
}

/** The library package they named: one name matched by its words, or what to say when it is none or several. */
function pieceNamed(ctx: ScreenToolContext, said: string): { id: string; name: string } | { result: ScreenResult } {
  const items = ctx.library ? libraryItems(ctx.library) : [];
  if (items.length === 0) return { result: notDone('The task library is empty.') };
  const wanted = normalName(said).replace(/^the\s+/, '').replace(/\s+(package|piece|snippet|template)$/, '');
  const exact = items.filter(({ snippet }) => normalName(snippet.name) === wanted);
  const words = keyWords(wanted).filter((word) => !['package', 'piece', 'snippet', 'template', 'library'].includes(word));
  const found = exact.length > 0 ? exact : items.filter(({ snippet }) => words.length > 0 && words.every((word) => containsWord(snippet.name, word)));
  if (found.length === 1) return { id: found[0]!.snippet.id, name: found[0]!.snippet.name };
  if (found.length === 0) return { result: { ...notDone(`No package in the library is called anything like “${said}”.`), packages: items.slice(0, 12).map(({ snippet }) => snippet.name) } };
  return { result: { ...notDone(`“${said}” fits ${found.length} packages; ask which.`), choices: found.slice(0, 8).map(({ snippet }) => snippet.name) } };
}

/**
 * What a screen tool gives the model: what happened, in a line it can say, and `said_enough` when the short reply it
 * gave before the tool already covers it (the turn then ends there: nothing more to say).
 */
export interface ScreenResult {
  done: boolean;
  said_enough: boolean;
  did: string;
  [key: string]: unknown;
}

const STOP_WORDS = new Set(['the', 'a', 'an', 'of', 'for', 'on', 'at', 'to', 'in', 'and', 'our', 'my', 'their', 'that', 'this', 'task', 'tasks', 'work', 's']);

/** The words that carry meaning, plural or possessive endings taken off ("the electrician's" -> "electrician"). */
export function keyWords(text: string): string[] {
  return normalName(text)
    .replace(/[’']s\b/g, '')
    .split(/[^a-z0-9.]+/)
    .map((word) => word.replace(/\.+$/, ''))
    .filter((word) => word.length > 0 && !STOP_WORDS.has(word));
}

/** A word's stem, for matching "electrician" to "Electrical" or "plumber" to "Plumbing". */
function stem(word: string): string {
  const cut = word.replace(/(icians|ician|ical|ings|ing|ers|er|als|al|ies|es|s)$/, '');
  return cut.length >= 4 ? cut : word;
}

const containsWord = (haystack: string, word: string) => {
  const words = normalName(haystack).split(/[^a-z0-9]+/);
  // A number is that number: "level 1" is not "level 10".
  if (/^\d+$/.test(word)) return words.includes(word);
  return words.some((candidate) => candidate === word || candidate.startsWith(stem(word)) || stem(candidate) === stem(word));
};

/** Outline order: "2.10" after "2.9". */
export function byOutline(a: PlanTask, b: PlanTask): number {
  const left = (a.wbs ?? '').split('.').map(Number);
  const right = (b.wbs ?? '').split('.').map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? -1) - (right[index] ?? -1);
    if (difference !== 0) return difference;
  }
  return a.id - b.id;
}

/** Tasks whose name has every word they said: an exact name first, then all the words. */
export function tasksMatching(plan: PlanSnapshot, said: string): PlanTask[] {
  const wanted = normalName(said).replace(/^the\s+/, '');
  const exact = plan.tasks.filter((task) => normalName(task.name) === wanted);
  if (exact.length > 0) return exact;
  const words = keyWords(said);
  if (words.length === 0) return [];
  return plan.tasks.filter((task) => words.every((word) => containsWord(task.name, word))).sort(byOutline);
}

const taskLine = (task: PlanTask) => ({ id: task.id, name: task.name, wbs: task.wbs ?? null, phase: task.phase, kind: task.isMilestone ? 'milestone' : task.isLeaf ? 'task' : 'group' });

type Named = { target: UiTaskTarget; task: PlanTask | null } | { result: ScreenResult };

/** The task they named, as the browser takes it; or what to say when it is none or several. */
function namedTask(plan: PlanSnapshot, args: { task_id?: number | null; name?: string | null; wbs?: string | null; row?: number | null }): Named {
  if (typeof args.task_id === 'number') {
    const task = plan.tasks.find((candidate) => candidate.id === args.task_id);
    if (!task) throw new ToolRefusal(`There is no task ${args.task_id} in the plan.`);
    return { target: { task_id: task.id }, task };
  }
  if (args.wbs) {
    const task = plan.tasks.find((candidate) => candidate.wbs === args.wbs);
    if (!task) return { result: notDone(`No task in the plan has the outline number ${args.wbs}.`) };
    return { target: { task_id: task.id }, task };
  }
  if (typeof args.row === 'number') return { target: { row: args.row }, task: null };
  if (args.name) {
    const found = tasksMatching(plan, args.name);
    if (found.length === 0) return { result: notDone(`No task in the plan goes by “${args.name}”.`) };
    // A group and the tasks inside it that share its name: the group is what they mean.
    const top = found.filter((task) => !found.some((other) => other !== task && isUnder(plan, task, other.id)));
    if (top.length === 1) return { target: { task_id: top[0]!.id }, task: top[0]! };
    // "Level 2" is "Level 2 build-out" rather than "Concrete deck, level 2": the one whose name starts with their words.
    const said = keyWords(args.name).join(' ');
    const leading = top.filter((task) => keyWords(task.name).join(' ').startsWith(said));
    if (leading.length === 1) return { target: { task_id: leading[0]!.id }, task: leading[0]! };
    return { result: { ...notDone(`“${args.name}” fits ${top.length} tasks. Nothing was shown; ask which one.`), choices: top.slice(0, 8).map(taskLine) } };
  }
  throw new ToolRefusal('Name the task: give task_id, name, wbs or row.');
}

function isUnder(plan: PlanSnapshot, task: PlanTask, ancestorId: number): boolean {
  const byId = new Map(plan.tasks.map((other) => [other.id, other]));
  const seen = new Set<number>();
  for (let at = task.parentId; at !== null && !seen.has(at); at = byId.get(at)?.parentId ?? null) {
    if (at === ancestorId) return true;
    seen.add(at);
  }
  return false;
}

const notDone = (did: string): ScreenResult => ({ done: false, said_enough: false, did });

/** The crews they mean: by firm name or by trade ("the electrician" is every crew whose trade is electrical). */
export function crewsMatching(plan: PlanSnapshot, said: string): PlanResource[] {
  const wanted = normalName(said).replace(/^the\s+/, '');
  const exact = plan.resources.filter((resource) => normalName(resource.name) === wanted || normalName(resource.company) === wanted);
  if (exact.length > 0) return exact;
  const words = keyWords(said).filter((word) => !['crew', 'crews', 'firm', 'guys', 'team', 'folks', 'people', 'sub', 'subs'].includes(word));
  if (words.length === 0) return [];
  const fits = (text: string | undefined) => Boolean(text) && words.every((word) => containsWord(text!, word));
  const byName = plan.resources.filter((resource) => fits(resource.name) || fits(resource.company));
  return byName.length > 0 ? byName : plan.resources.filter((resource) => fits(resource.trade));
}

const pad = (value: number) => String(value).padStart(2, '0');
const lastOfMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/** The year of a month the plan has work in: the first such month on or after the plan's "as of" day, else the last one before. */
export function yearOfMonth(plan: PlanSnapshot, month: number): number {
  const leaves = plan.tasks.filter((task) => task.isLeaf);
  const first = leaves.map((task) => task.start).sort()[0] ?? plan.statusDate;
  const last = leaves.map((task) => task.end).sort().at(-1) ?? plan.statusDate;
  const years: number[] = [];
  for (let year = Number(first.slice(0, 4)); year <= Number(last.slice(0, 4)); year += 1) {
    const from = `${year}-${pad(month)}-01`;
    const to = `${year}-${pad(month)}-${pad(lastOfMonth(year, month))}`;
    if (from <= last && to >= first) years.push(year);
  }
  const statusYear = Number(plan.statusDate.slice(0, 4));
  const ahead = years.find((year) => `${year}-${pad(month)}-${pad(lastOfMonth(year, month))}` >= plan.statusDate);
  return ahead ?? years.at(-1) ?? (month >= Number(plan.statusDate.slice(5, 7)) ? statusYear : statusYear + 1);
}

/** The payment hold they mean: by the work it pays for or holds, else the next one still waiting. */
function holdMeant(plan: PlanSnapshot, about: string | null | undefined): { gate: PlanTask } | { result: ScreenResult } {
  const gates = plan.tasks.filter((task) => task.payGate).sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  if (gates.length === 0) return { result: notDone('No work in this plan waits for a payment.') };
  if (!about) return { gate: gates.find((gate) => gate.payGate!.state !== 'paid') ?? gates[0]! };
  const words = keyWords(about);
  const named = (task: PlanTask | undefined) => Boolean(task) && words.length > 0 && words.every((word) => containsWord(task!.name, word));
  const byId = new Map(plan.tasks.map((task) => [task.id, task]));
  const holds = (gate: PlanTask) => plan.dependencies.filter((link) => link.from === gate.id).map((link) => byId.get(link.to));
  const pays = (gate: PlanTask) =>
    gate.payGate!.pays.flatMap((id) => {
      const task = typeof id === 'number' ? byId.get(id) : undefined;
      return task ? [task, ...plan.tasks.filter((other) => isUnder(plan, other, task.id))] : [];
    });
  const found = gates.filter((gate) => named(gate) || pays(gate).some(named) || holds(gate).some(named));
  if (found.length === 0) return { result: notDone(`No payment hold pays for or holds “${about}”. Holds in the plan: ${gates.map((gate) => `“${gate.name}”`).join(', ')}.`) };
  return { gate: found.find((gate) => gate.payGate!.state !== 'paid') ?? found[0]! };
}

function parseArgs<T extends z.ZodType>(schema: T, raw: unknown): z.infer<T> {
  const parsed = schema.safeParse(raw ?? {});
  if (!parsed.success) throw new ToolRefusal(`Invalid arguments: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

/**
 * Sends one action to the person's own tab and reads back what it did. `saidEnough`: whether the short reply before
 * the tool covers what it did (a filter that shows nothing does not).
 */
async function act(ctx: ScreenToolContext, action: UiAction, saidEnough: boolean | ((shown: UiActionOutcome) => boolean) = true): Promise<ScreenResult> {
  if (!ctx.speaker) throw new ToolRefusal('Only someone in the plan can ask for this: it happens on their own screen.');
  if (!ctx.commands) throw new ToolRefusal('Their screen can’t be reached from here right now.');
  const checked = UiAction.safeParse(action);
  if (!checked.success) throw new ToolRefusal(`Invalid arguments: ${z.prettifyError(checked.error)}`);
  const outcome = await ctx.commands.run('ui_action', checked.data, ctx.speaker.userId, null, { timeoutMs: UI_ACTION_TIMEOUT_MS, claimTimeoutMs: UI_ACTION_CLAIM_MS });
  if (outcome.status !== 'succeeded') return notDone(outcome.message);
  const shown = UiActionOutcome.safeParse(outcome.row.result?.ui);
  if (!shown.success) return notDone('Their screen did it but said nothing back.');
  const { did, task, matches, at, nothing } = shown.data;
  return {
    done: true,
    // When nothing needed doing, the few words before it ("Closing it.") may be wrong: say what is so.
    said_enough: nothing ? false : typeof saidEnough === 'function' ? saidEnough(shown.data) : saidEnough,
    did,
    ...(task ? { task } : {}),
    ...(typeof matches === 'number' ? { matches } : {}),
    ...(typeof at === 'number' ? { at } : {}),
  };
}

export async function runScreenTool(name: ScreenToolName, rawArgs: unknown, ctx: ScreenToolContext): Promise<ScreenResult> {
  const { plan } = ctx;
  switch (name) {
    case 'site_view': {
      const args = parseArgs(ScreenToolSchemas.site_view, rawArgs);
      if (args.look === 'level') {
        if (!args.level) throw new ToolRefusal('Say which level (level).');
        return act(ctx, { action: 'site_level', level: args.level });
      }
      if (args.look === 'whole') return act(ctx, { action: 'site_level', level: null });
      // Looking at the crane, or riding it, opens the site view first.
      return args.look ? act(ctx, { action: 'site_view', open: true, look: args.look }) : act(ctx, { action: 'site_view', open: args.open });
    }
    case 'play_site': {
      const args = parseArgs(ScreenToolSchemas.play_site, rawArgs);
      if (args.do === 'pause') return act(ctx, { action: 'site_pause' });
      if (args.do === 'go_to_day') {
        if (!args.day) throw new ToolRefusal('Give the day (day).');
        return act(ctx, { action: 'site_day', date: args.day });
      }
      if (args.from && args.to && args.to < args.from) throw new ToolRefusal('to comes before from.');
      const to = args.to ?? (args.from && args.days ? addDaysIso(args.from, args.days) : null);
      return act(ctx, { action: 'site_play', from: args.from ?? null, to, days: !to && args.days ? args.days : null, seconds: args.seconds ?? null });
    }
    case 'close_view': {
      const args = parseArgs(ScreenToolSchemas.close_view, rawArgs);
      return act(ctx, { action: 'close', what: args.what, panel: args.what === 'panel' ? (args.panel ?? null) : null });
    }
    case 'open_library_piece': {
      const args = parseArgs(ScreenToolSchemas.open_library_piece, rawArgs);
      const piece = pieceNamed(ctx, args.package);
      if ('result' in piece) return piece.result;
      return act(ctx, { action: 'open_snippet', snippet_id: piece.id });
    }
    case 'drag_library_piece': {
      const args = parseArgs(ScreenToolSchemas.drag_library_piece, rawArgs);
      const piece = pieceNamed(ctx, args.package);
      if ('result' in piece) return piece.result;
      if (typeof args.onto_task_id !== 'number' && !args.onto && !args.onto_wbs) throw new ToolRefusal('Say where it goes: onto, onto_wbs or onto_task_id.');
      const named = namedTask(plan, { task_id: args.onto_task_id, name: args.onto, wbs: args.onto_wbs });
      if ('result' in named) return named.result;
      const onto = named.task!;
      // The card it opens is the person's to answer; the few words before it ("pick how to tie it in") say so.
      return act(ctx, { action: 'drag_snippet', snippet_id: piece.id, task_id: onto.id, zone: args.inside ? 'inside' : 'after' });
    }
    case 'go_to_task': {
      const args = parseArgs(ScreenToolSchemas.go_to_task, rawArgs);
      const named = namedTask(plan, args);
      if ('result' in named) return named.result;
      if (args.open === 'cell_editor' && !args.column) throw new ToolRefusal('Say which column to edit (column), or open the task_editor.');
      if (args.bar) return act(ctx, { action: 'show_bar', target: named.target });
      if (args.open === 'task_editor') return act(ctx, { action: 'open_editor', target: named.target });
      if (args.column) return act(ctx, { action: 'focus_cell', target: named.target, column: args.column, edit: args.open === 'cell_editor' });
      return act(ctx, { action: 'go_to_task', target: named.target });
    }
    case 'filter_plan': {
      const args = parseArgs(ScreenToolSchemas.filter_plan, rawArgs);
      if (args.clear) return act(ctx, { action: 'filter', clear: true });
      if (!args.text && !args.crew && !args.from && !args.to) throw new ToolRefusal('Give text, crew, from or to; or clear true.');
      if (args.from && args.to && args.to < args.from) throw new ToolRefusal('to comes before from.');
      let crewIds: number[] | null = null;
      let crewLabel: string | null = null;
      if (args.crew) {
        const crews = crewsMatching(plan, args.crew);
        if (crews.length === 0) {
          return { ...notDone(`No crew on the project fits “${args.crew}”.`), crews: plan.resources.map((resource) => (resource.trade ? `${resource.name} (${resource.trade})` : resource.name)) };
        }
        crewIds = crews.map((resource) => resource.id);
        crewLabel = crews.length <= 2 ? crews.map((resource) => resource.name).join(' and ') : `${crews.length} ${normalName(args.crew)} crews`;
      }
      const result = await act(
        ctx,
        { action: 'filter', clear: false, text: args.text ?? null, crew_ids: crewIds, crew_label: crewLabel, from: args.from ?? null, to: args.to ?? null },
        (shown) => (shown.matches ?? 1) > 0,
      );
      return crewLabel ? { ...result, crews: crewLabel } : result;
    }
    case 'search_plan': {
      const args = parseArgs(ScreenToolSchemas.search_plan, rawArgs);
      if (args.clear) return act(ctx, { action: 'search', clear: true });
      if (args.step && !args.text) return act(ctx, { action: 'search', step: args.step }, false);
      if (!args.text) throw new ToolRefusal('Give text to find, a step, or clear true.');
      const found = tasksMatching(plan, args.text);
      if (found.length === 0) return notDone(`Nothing in the plan is called anything like “${args.text}”.`);
      const result = await act(ctx, { action: 'search', text: args.text, task_ids: found.slice(0, 200).map((task) => task.id), step: 'first' }, false);
      return { ...result, found: found.slice(0, 12).map(taskLine), ...(found.length > 12 ? { more: found.length - 12 } : {}) };
    }
    case 'expand_plan': {
      const args = parseArgs(ScreenToolSchemas.expand_plan, rawArgs);
      if (typeof args.task_id !== 'number' && !args.name && !args.wbs) return act(ctx, { action: 'expand', open: args.open });
      const named = namedTask(plan, args);
      if ('result' in named) return named.result;
      const group = named.task!;
      if (group.isLeaf) return notDone(`“${group.name}” is a task, not a group: there is nothing in it to ${args.open ? 'open' : 'close'}.`);
      return act(ctx, { action: 'expand', open: args.open, task_id: group.id });
    }
    case 'zoom_plan': {
      const args = parseArgs(ScreenToolSchemas.zoom_plan, rawArgs);
      if (args.to === 'month') {
        if (!args.month) throw new ToolRefusal('Give the month (1 to 12).');
        const year = args.year ?? yearOfMonth(plan, args.month);
        const first = `${year}-${pad(args.month)}-01`;
        const last = `${year}-${pad(args.month)}-${pad(lastOfMonth(year, args.month))}`;
        return act(ctx, { action: 'zoom', how: 'dates', first_day: first, last_day: last });
      }
      if (args.to === 'day') {
        if (!args.first_day) throw new ToolRefusal('Give the day as first_day.');
        return act(ctx, { action: 'scroll_to_date', date: args.first_day });
      }
      if (args.to === 'dates') {
        if (!args.first_day || !args.last_day) throw new ToolRefusal('Give first_day and last_day.');
        if (args.last_day < args.first_day) throw new ToolRefusal('last_day comes before first_day.');
        return act(ctx, { action: 'zoom', how: 'dates', first_day: args.first_day, last_day: args.last_day });
      }
      return act(ctx, { action: 'zoom', how: args.to });
    }
    case 'open_panel': {
      const args = parseArgs(ScreenToolSchemas.open_panel, rawArgs);
      return act(ctx, { action: 'open_panel', panel: args.panel });
    }
    case 'open_review': {
      const args = parseArgs(ScreenToolSchemas.open_review, rawArgs);
      if (args.of === 'invoice') return act(ctx, { action: 'open_invoice' });
      const meant = holdMeant(plan, args.about);
      if ('result' in meant) return meant.result;
      const { gate } = meant;
      const result = await act(ctx, { action: 'open_payment', task_id: gate.id });
      return { ...result, hold: { id: gate.id, name: gate.name, due: gate.start, text: day(gate.start), state: gate.payGate!.state } };
    }
    case 'undo_redo': {
      const args = parseArgs(ScreenToolSchemas.undo_redo, rawArgs);
      return act(ctx, { action: 'history', direction: args.direction, steps: args.steps ?? 1 });
    }
  }
}

/** One line for the logs and the tool chip. */
export function summarizeScreenTool(result: Record<string, unknown>): string {
  return typeof result.did === 'string' ? result.did : 'ok';
}
