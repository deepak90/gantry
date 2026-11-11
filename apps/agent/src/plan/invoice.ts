/**
 * The invoice for a change to the plan (a change order), worked out from the plan itself. The change is
 * the tasks it added: the ones named, or else the library piece added to the plan most recently, on every
 * floor it went. Each is billed at its own cost in the plan, grouped the way the tenant reads a change
 * order: what is bought once for every floor first, then each floor's own work as one line with its tasks
 * listed under it ("Deliver, install and test light fixtures, level 2"). Nothing is added that the plan
 * does not have: no fee, markup or tax.
 *
 * Pure: the plan in, the invoice out. Nothing here bills anyone: a person who sees costs sends it from the
 * card (prepare_invoice, then supabase/functions/paypal-invoice).
 */
import { INVOICE_DUE_DAYS, PAYPAL_PAYMENT_LIMIT_MINOR, placeOf, type ChangeInvoiceCard, type ChangeInvoiceLine } from '@collab/shared';
import { usd } from './format';
import type { PlanSnapshot, PlanTask } from './snapshot';

/** A task that buys materials, by its name ("Order light fixtures"): a building does it once. */
export const BUYS = /\b(order|buy|purchas|procur)/i;

/** A name that already says where its work is ("Order light fixtures, levels 1 to 3"). */
const NAMES_A_PLACE = /\b(levels?|floors?|stor(?:e)?ys?|stories|wings?|zones?|blocks?|units?|areas?|buildings?)\b/i;

/** "Install light fixtures, level 2" → "Install light fixtures": the floor goes at the end of its line instead. */
const PLACE_SUFFIX = /\s*[,–—-]\s*(?:levels?|floors?|stor(?:e)?ys?|lvl|wings?|zones?|blocks?|units?|areas?|rooms?)\s+[\w.]+(?:\s+(?:to|and|-)\s+[\w.]+)?\s*$/i;

/** PayPal takes an item of at most $1,000,000 (the sandbox refuses more: "Amount should be between 0 and 1000000"). */
export const LINE_MAX_MINOR = 100_000_000;
/**
 * A line's name, as the tenant reads it on the invoice: short enough to take in at a glance, and well under the 200
 * characters PayPal takes (it refuses exactly 200: "Item Name should be less than 200 characters").
 */
export const LINE_LABEL_MAX = 120;
/** The tasks listed under a line, with their amounts (PayPal's item description takes under 1,000 characters). */
export const LINE_DETAIL_MAX = 900;
/** An invoice has 1 to 40 lines (prepare_invoice). */
export const MAX_LINES = 40;
/** The invoice's title is its reference in PayPal, which takes 120 characters. */
const TITLE_MAX = 120;

/** Why a change cannot be invoiced as asked; the tool hands the message back to the model. */
export class ChangeInvoiceError extends Error {}

export interface ChangeTasks {
  /** The change's tasks (leaves only, inactive ones left out), in plan order. */
  tasks: PlanTask[];
  /** The library piece they came from, when they all came from one. */
  libraryRef: string | null;
}

/** The invoice as drafted: the card's content without the id it is kept under. */
export type ChangeInvoiceDraft = Omit<ChangeInvoiceCard, 'invoice_id'>;

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`);

/** `text` in at most `max` characters, cut at a word where that keeps most of it, with "…" when cut. */
function clipWords(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, Math.max(0, max - 1));
  const atWord = cut.replace(/[\s,;:–—-]+\S*$/, '');
  return `${(atWord.length >= cut.length * 0.6 ? atWord : cut).trimEnd()}…`;
}

/** A name and where its work is ("…, level 2"), in at most LINE_LABEL_MAX characters: the name gives way, never the place. */
function withWhere(name: string, where: string): string {
  if (`${name}${where}`.length <= LINE_LABEL_MAX) return `${name}${where}`;
  if (where.length >= LINE_LABEL_MAX - 12) return clipWords(`${name}${where}`, LINE_LABEL_MAX);
  return `${clipWords(name, LINE_LABEL_MAX - where.length)}${where}`;
}

/**
 * A floor's line, at most LINE_LABEL_MAX characters, always saying where its work is: the work in one phrase when that
 * fits ("Deliver, install and test light fixtures, level 2"); otherwise what the change is and how many tasks
 * ("Light fixtures, level 2 (14 tasks)"). Its tasks are listed under it either way.
 */
export function floorLabel({ work, place, groupName, subject, count }: { work: string; place: string | null; groupName: string | null; subject: string; count: number }): string {
  const where = place ? `, ${place}` : groupName ? ` (${groupName})` : '';
  if (`${work}${where}`.length <= LINE_LABEL_MAX) return `${work}${where}`;
  const tasks = count > 1 ? ` (${count} tasks)` : '';
  // A place that already says what the work is ("light fixtures, level 2") needs nothing before it.
  if (place && place.toLowerCase().includes(subject.toLowerCase())) return withWhere(upperFirst(place), tasks);
  return withWhere(subject, `${where}${tasks}`);
}

/** The tasks under a line with their amounts, "a $600 · b $900", as many as fit in `max` characters, then how many more. */
export function taskList(items: readonly string[], max: number = LINE_DETAIL_MAX): string {
  const all = items.join(' · ');
  if (all.length <= max) return all;
  const kept: string[] = [];
  for (const item of items) {
    const more = ` · and ${items.length - kept.length - 1} more`;
    if ([...kept, item].join(' · ').length + more.length > max) break;
    kept.push(item);
  }
  if (kept.length === 0) return clipWords(items[0] ?? '', max);
  return `${kept.join(' · ')} · and ${items.length - kept.length} more`;
}
const lowerFirst = (text: string) => (/^[A-Z][a-z]/.test(text) ? text[0]!.toLowerCase() + text.slice(1) : text);
const upperFirst = (text: string) => (text ? text[0]!.toUpperCase() + text.slice(1) : text);
/** "$6,200" (no cents unless they matter). */
const dollars = (minor: number) => usd(minor).replace(/\.00$/, '');

/** "a", "a and b", "a, b and c". */
function series(items: readonly string[]): string {
  return items.length <= 2 ? items.join(' and ') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/** Plan order, by outline number ("6.10" after "6.9"). */
export function byPlanOrder(a: PlanTask, b: PlanTask): number {
  const left = (a.wbs ?? '').split('.').map(Number);
  const right = (b.wbs ?? '').split('.').map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const diff = (left[index] ?? -1) - (right[index] ?? -1);
    if (diff !== 0) return diff;
  }
  return a.id - b.id;
}

/** A task's work without the floor it is on: "Install light fixtures, level 2" → "Install light fixtures". */
export function withoutPlace(name: string): string {
  return name.replace(PLACE_SUFFIX, '').trim() || name;
}

/** Each distinct name as its words, and how many last words they all share (each keeping one of its own). */
function sharedEnding(names: readonly string[]): { distinct: string[]; words: string[][]; shared: number } {
  const distinct = [...new Set(names.map((name) => name.trim()).filter(Boolean))];
  const words = distinct.map((name) => name.split(/\s+/));
  if (words.length < 2) return { distinct, words, shared: 0 };
  const shortest = Math.min(...words.map((list) => list.length));
  const wordAt = (list: string[], fromEnd: number) => list[list.length - 1 - fromEnd]!.toLowerCase();
  let shared = 0;
  while (shared < shortest - 1 && words.every((list) => wordAt(list, shared) === wordAt(words[0]!, shared))) shared += 1;
  return { distinct, words, shared };
}

/**
 * The work of several tasks in one phrase, the words they share said once: "Deliver light fixtures",
 * "Install light fixtures", "Test light fixtures" → "Deliver, install and test light fixtures".
 */
export function workPhrase(names: readonly string[]): string {
  const { distinct, words, shared } = sharedEnding(names);
  if (distinct.length <= 1) return distinct[0] ?? '';
  if (shared === 0) return series(distinct.map((name, index) => (index === 0 ? name : lowerFirst(name))));
  const heads = words.map((list, index) => {
    const head = list.slice(0, list.length - shared).join(' ');
    return index === 0 ? head : lowerFirst(head);
  });
  return `${series([...new Set(heads)])} ${words[0]!.slice(words[0]!.length - shared).join(' ')}`;
}

/** Where a group's work is, as a line ends: "Level 1 build-out" → "level 1"; null for a group that names no place. */
function placeOfGroup(group: PlanTask | null): string | null {
  if (!group || !(placeOf(group.name) || NAMES_A_PLACE.test(group.name))) return null;
  return lowerFirst(group.name.replace(/\s+(?:build-?out|fit-?out)$/i, '').trim() || group.name);
}

/** "levels 1 to 3", "levels 1 and 3", "level 2"; null when the groups name no numbered floor. */
function floorsWords(groups: readonly (PlanTask | null)[]): string | null {
  const numbers = [
    ...new Set(
      groups
        .map((group) => (group ? placeOf(group.name) : null))
        .filter((place): place is string => place !== null && /^level \d+$/.test(place))
        .map((place) => Number(place.slice('level '.length)))
        .filter((number) => number > 0),
    ),
  ].sort((a, b) => a - b);
  if (numbers.length === 0) return null;
  if (numbers.length === 1) return `level ${numbers[0]}`;
  const consecutive = numbers.every((number, index) => index === 0 || number === numbers[index - 1]! + 1);
  return consecutive && numbers.length > 2 ? `levels ${numbers[0]} to ${numbers.at(-1)}` : `levels ${series(numbers.map(String))}`;
}

/** The tasks under a task (itself, when it is one). */
function leavesUnder(plan: PlanSnapshot, id: number, seen = new Set<number>()): PlanTask[] {
  if (seen.has(id)) return [];
  seen.add(id);
  const task = plan.tasks.find((candidate) => candidate.id === id);
  if (!task) return [];
  if (task.isLeaf) return [task];
  return plan.tasks.filter((candidate) => candidate.parentId === id).flatMap((child) => leavesUnder(plan, child.id, seen));
}

/** The library piece a task came from: its own, or the group's it was dropped as. */
function pieceOf(plan: PlanSnapshot, task: PlanTask): string | null {
  for (let current: PlanTask | undefined = task, steps = 0; current && steps < 50; steps++) {
    if (current.libraryRef) return current.libraryRef;
    current = current.parentId === null ? undefined : plan.tasks.find((candidate) => candidate.id === current!.parentId);
  }
  return null;
}

/**
 * The tasks a change added: the ones named (a group brings its tasks), or else the library piece added
 * to the plan most recently (the server numbers new tasks in order), on every floor it went.
 */
export function changeTasks(plan: PlanSnapshot, named: readonly number[] | null): ChangeTasks {
  let tasks: PlanTask[];
  if (named && named.length > 0) {
    const missing = named.filter((id) => !plan.tasks.some((task) => task.id === id));
    if (missing.length > 0) throw new ChangeInvoiceError(`There is no task ${missing.join(', ')} in the plan.`);
    tasks = named.flatMap((id) => leavesUnder(plan, id));
  } else {
    const pieces = plan.tasks.filter((task) => task.libraryRef);
    if (pieces.length === 0) throw new ChangeInvoiceError('Nothing in the plan came from the library yet: name the tasks the change added (task_ids).');
    const newest = pieces.reduce((latest, task) => (task.id > latest.id ? task : latest));
    tasks = pieces.filter((task) => task.libraryRef === newest.libraryRef).flatMap((task) => leavesUnder(plan, task.id));
  }
  const unique = [...new Map(tasks.filter((task) => !task.inactive).map((task) => [task.id, task])).values()].sort(byPlanOrder);
  if (unique.length === 0) throw new ChangeInvoiceError('Those tasks are not worked (inactive), so there is nothing to bill.');
  const refs = new Set(unique.map((task) => pieceOf(plan, task)));
  return { tasks: unique, libraryRef: refs.size === 1 ? ([...refs][0] ?? null) : null };
}

/**
 * The change's invoice: a line for each task that buys for every floor, then one line per floor (or
 * group) with that floor's own tasks, each at its cost in the plan; the total; the terms; and whether the
 * payer may pay in parts (over $60,000, the most one PayPal payment carries). `name` is the change in a
 * few words; without it, the library piece and its floors ("Light fixtures, levels 1 to 3").
 */
export function changeInvoice(plan: PlanSnapshot, change: ChangeTasks, options: { name: string | null; pieceName: string | null; recipient: string }): ChangeInvoiceDraft {
  const byId = new Map(plan.tasks.map((task) => [task.id, task]));
  const groupOf = (task: PlanTask) => (task.parentId === null ? null : (byId.get(task.parentId) ?? null));
  /** The floor a task's work is for: the nearest group above it that names a place (a piece dropped as a group sits under it), else its own group. */
  const floorOf = (task: PlanTask): PlanTask | null => {
    for (let current = groupOf(task), steps = 0; current && steps < 50; current = groupOf(current), steps++) if (placeOfGroup(current)) return current;
    return groupOf(task);
  };
  const priced = change.tasks.filter((task) => task.budgetMinor > 0);
  if (priced.length === 0) throw new ChangeInvoiceError('None of the change’s tasks has a cost in the plan yet, so there is nothing to bill: set what they cost first.');

  // What the change is, for a floor's line whose tasks don't fit in one phrase: "Light fixtures" from "Light fixtures,
  // levels 1 to 3", the library piece's name, or the words its tasks share.
  const subject =
    upperFirst(withoutPlace(options.name?.trim() || options.pieceName?.trim() || sharedWork(priced.map((task) => withoutPlace(task.name))) || '')) || 'Work';

  const lines: ChangeInvoiceLine[] = [];
  // Bought once for every floor: a line each, saying where when its name does not.
  for (const task of priced.filter((candidate) => BUYS.test(candidate.name))) {
    const place = placeOfGroup(floorOf(task));
    const label = NAMES_A_PLACE.test(task.name) || !place ? clipWords(task.name, LINE_LABEL_MAX) : withWhere(task.name, `, ${place}`);
    lines.push({ label, amount_minor: task.budgetMinor, detail: null, task_ids: [task.id] });
  }
  // Then each floor's own work, in plan order: one line, its tasks under it.
  const floors = new Map<number | null, PlanTask[]>();
  for (const task of priced.filter((candidate) => !BUYS.test(candidate.name))) {
    const floor = floorOf(task)?.id ?? null;
    floors.set(floor, [...(floors.get(floor) ?? []), task]);
  }
  for (const [floorId, tasks] of floors) {
    const group = floorId === null ? null : (byId.get(floorId) ?? null);
    const place = placeOfGroup(group);
    const names = tasks.map((task) => withoutPlace(task.name));
    const work = upperFirst(workPhrase(names));
    lines.push({
      label: floorLabel({ work, place, groupName: group?.name ?? null, subject, count: tasks.length }),
      amount_minor: tasks.reduce((sum, task) => sum + task.budgetMinor, 0),
      detail: tasks.length > 1 ? taskList(tasks.map((task, index) => `${names[index]} ${dollars(task.budgetMinor)}`)) : null,
      // The card keeps at most 60 a line (a floor's own work is a handful).
      task_ids: tasks.map((task) => task.id).slice(0, 60),
    });
  }
  if (lines.length > MAX_LINES) throw new ChangeInvoiceError(`That comes to ${lines.length} lines and an invoice has at most ${MAX_LINES}: name fewer tasks.`);
  const tooBig = lines.find((line) => line.amount_minor > LINE_MAX_MINOR);
  if (tooBig) throw new ChangeInvoiceError(`PayPal takes at most ${dollars(LINE_MAX_MINOR)} a line, and “${tooBig.label}” is ${dollars(tooBig.amount_minor)}.`);

  const total = lines.reduce((sum, line) => sum + line.amount_minor, 0);
  const floorsNamed = floorsWords(priced.map(floorOf));
  const what = options.pieceName?.trim() || upperFirst(sharedWork(priced.map((task) => withoutPlace(task.name)))) || 'Change to the plan';
  const name = clip(options.name?.trim() || (floorsNamed ? `${what}, ${floorsNamed}` : what), 90);
  const prefix = plan.projectName ? `${plan.projectName} · Change order: ` : 'Change order: ';
  return {
    change: name,
    title: clip(`${prefix}${name}`, TITLE_MAX),
    recipient: clip(options.recipient, 120),
    lines,
    total_minor: total,
    currency: plan.currency,
    due_days: INVOICE_DUE_DAYS,
    partial_payments: total > PAYPAL_PAYMENT_LIMIT_MINOR,
    task_ids: change.tasks.map((task) => task.id).slice(0, 200),
    record_task_id: Math.min(...change.tasks.map((task) => task.id)),
  };
}

/** What a change's tasks are about: the words every name ends with ("light fixtures"), the one name, or ''. */
function sharedWork(names: readonly string[]): string {
  const { distinct, words, shared } = sharedEnding(names);
  if (distinct.length === 1) return distinct[0]!;
  return shared > 0 ? words[0]!.slice(words[0]!.length - shared).join(' ') : '';
}
