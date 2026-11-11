/**
 * The assistant's hand on a drafted package: reading the package editor and changing a cost line in it,
 * the line your words are about. Both the walkthrough and the voice conversation use it.
 */
import type { Hand } from './hand';
import { mentions } from './said';
import { find, waitFor } from './wait';

const id = (testId: string) => `[data-testid="${testId}"]`;
export const DRAFT_EDITOR = id('snippet-builder');
const COST_ROW = id('builder-cost-row');
const FIXTURE_WORDS = /fixture|light|lamp|luminaire|\bled\b|panel/i;
const BUYING = /order|buy|purchase|supply|procure/i;

export interface DraftTask {
  cell: HTMLElement;
  name: string;
  cost: number;
}

/** The tasks in the open package editor, top to bottom, with what each costs. */
export function draftTasks(): DraftTask[] {
  const cells = [...document.querySelectorAll<HTMLElement>(`${id('snippet-gantt')} .b-grid-cell[data-column="name"]`)];
  return cells
    .map((cell) => {
      const costs = cell.closest('.b-grid-row')?.querySelector('[data-column="costs"]')?.textContent ?? '';
      return { cell, name: cell.textContent?.trim() ?? '', cost: Number(costs.replace(/[^0-9.]/g, '')) || 0 };
    })
    .filter((task) => task.name !== '')
    .sort((a, b) => a.cell.getBoundingClientRect().top - b.cell.getBoundingClientRect().top);
}

/** The open package in words: its name, each task's cost and the total. */
export function describeDraft(): string {
  const name = find<HTMLInputElement>(id('builder-name'))?.value ?? 'The package';
  const total = find(id('builder-cost-total'))?.textContent?.trim() ?? '';
  const tasks = draftTasks().map((task) => `${task.name}${task.cost ? ` $${task.cost.toLocaleString('en-US')}` : ''}`);
  return `${name}: ${tasks.join('; ')}${total ? `. Total ${total}` : ''}.`;
}

/** A row's text cell by cell, so its number doesn't run into the task's name ("3Install"). */
function rowText(cell: HTMLElement): string {
  const row = cell.closest('.b-grid-row');
  if (!row) return cell.textContent ?? '';
  return [...row.querySelectorAll('.b-grid-cell')].map((each) => each.textContent ?? '').join(' ');
}

/**
 * The task with costs that `words` are about: the words are matched against the task's name first, then
 * its whole row (its crews too). Said of fixtures, the task that buys them comes first. Otherwise the
 * task that costs most.
 */
export function taskFor(words: string): DraftTask | undefined {
  const aboutFixtures = FIXTURE_WORDS.test(words);
  const score = (task: DraftTask) =>
    mentions(words, task.name) * 4 +
    mentions(words, rowText(task.cell)) +
    (aboutFixtures && FIXTURE_WORDS.test(task.name) ? 1 : 0) +
    (aboutFixtures && BUYING.test(task.name) ? 2 : 0) +
    task.cost / 1_000_000;
  return draftTasks()
    .filter((candidate) => candidate.cost > 0)
    .sort((a, b) => score(b) - score(a))[0];
}

/**
 * The task with costs that `words` name, or null when they name none of them: "the wiring" in a draft
 * with no wiring line is a question for the person, not the dearest line.
 */
export function namedTaskFor(words: string): DraftTask | null {
  const aboutFixtures = FIXTURE_WORDS.test(words);
  const score = (task: DraftTask) =>
    mentions(words, task.name) * 4 + mentions(words, rowText(task.cell)) + (aboutFixtures && FIXTURE_WORDS.test(task.name) ? 1 : 0) + (aboutFixtures && BUYING.test(task.name) ? 2 : 0);
  const best = draftTasks()
    .filter((candidate) => candidate.cost > 0)
    .map((task) => ({ task, score: score(task) }))
    .sort((a, b) => b.score - a.score)[0];
  return best && best.score > 0 ? best.task : null;
}

/**
 * Changes what the task `words` are about costs, where people can see it: a double-click on its Cost
 * cell, the amount typed over, Enter. A task with several cost lines takes no one amount in its cell,
 * so then the line the words are about is changed in the costs below instead. Returns the task's name.
 */
export async function editCost(hand: Hand, words: string, amount: number, signal?: AbortSignal): Promise<{ name: string }> {
  const task = taskFor(words);
  if (!task) throw new Error('The draft has no costs to change');
  const cell = task.cell.closest('.b-grid-row')?.querySelector<HTMLElement>('.b-grid-cell[data-column="costs"]');
  if (cell) {
    await hand.doubleClick(cell, signal);
    const box = await waitFor(() => find<HTMLInputElement>(id('snippet-cost-input')), { what: 'the cost in its cell', timeout: 2500, signal }).catch(() => null);
    if (box) {
      await hand.type(box, String(Math.round(amount)), signal, { replace: true, perSecond: 6 });
      await hand.beat(260, signal);
      hand.key('Enter', box);
      await waitFor(() => (find(id('snippet-cost-input')) ? null : true), { what: 'the cost to go in', timeout: 3000, signal }).catch(() => undefined);
      return { name: task.name };
    }
  }
  const line = await costLineFor(hand, words, signal);
  await hand.type(line.amount, String(Math.round(amount)), signal, { replace: true, perSecond: 6 });
  line.amount.blur();
  return { name: line.name };
}

/**
 * Selects the task `words` are about and returns the amount box of its line they're about, with that
 * line's name: the costs below the Gantt. A line's name and payee are matched against the words;
 * otherwise the line that costs most.
 */
export async function costLineFor(hand: Hand, words: string, signal?: AbortSignal): Promise<{ amount: HTMLInputElement; name: string }> {
  const task = taskFor(words);
  if (!task) throw new Error('The draft has no costs to change');
  await hand.click(task.cell, signal);
  const lines = await waitFor(
    () => {
      const rows = [...document.querySelectorAll<HTMLElement>(COST_ROW)];
      return rows.length > 0 ? rows : null;
    },
    { what: `what “${task.name}” costs`, timeout: 5000, signal },
  );
  const read = (line: HTMLElement) => ({
    amount: line.querySelector<HTMLInputElement>('input[aria-label="Amount in whole dollars"]'),
    name: line.querySelector<HTMLInputElement>('input[aria-label="What the cost is for"]')?.value ?? '',
    payee: line.querySelector<HTMLInputElement>('input[aria-label="Who is paid"]')?.value ?? '',
  });
  const best = lines
    .map(read)
    .filter((line): line is { amount: HTMLInputElement; name: string; payee: string } => line.amount !== null)
    .sort((a, b) => mentions(words, `${b.name} ${b.payee}`) - mentions(words, `${a.name} ${a.payee}`) || (Number(b.amount.value) || 0) - (Number(a.amount.value) || 0))[0];
  if (!best) throw new Error(`“${task.name}” has no amount to change`);
  return { amount: best.amount, name: best.name || task.name };
}

/** The task in the open package `words` name, costs or not: its name first, then its whole row. Null when none. */
export function lineFor(words: string): DraftTask | null {
  const aboutFixtures = FIXTURE_WORDS.test(words);
  const score = (task: DraftTask) =>
    mentions(words, task.name) * 4 + mentions(words, rowText(task.cell)) + (aboutFixtures && FIXTURE_WORDS.test(task.name) ? 1 : 0) + (aboutFixtures && BUYING.test(task.name) ? 2 : 0);
  const best = draftTasks()
    .map((task) => ({ task, score: score(task) }))
    .sort((a, b) => b.score - a.score)[0];
  return best && best.score > 0 ? best.task : null;
}

/**
 * Who is paid on the line `words` are about: the task is selected so its costs show below, and the payee
 * of its cost line is typed over, the way a person fixes it. A task with no cost line gets one for its
 * whole cost. Returns the task's name.
 */
export async function setPayee(hand: Hand, words: string, payee: string, signal?: AbortSignal): Promise<{ name: string }> {
  const task = lineFor(words);
  if (!task) throw new Error('No line in the package goes by that name');
  await hand.click(task.cell, signal);
  let rows = await waitFor(
    () => {
      const found = [...document.querySelectorAll<HTMLElement>(COST_ROW)];
      return found.length > 0 ? found : null;
    },
    { what: `the costs of “${task.name}”`, timeout: 2500, signal },
  ).catch(() => null);
  if (!rows) {
    const add = find<HTMLButtonElement>(`${id('builder-add-cost')}:not(:disabled)`);
    if (!add) throw new Error(`“${task.name}” has no cost line to name a payee on`);
    await hand.click(add, signal);
    rows = await waitFor(() => [...document.querySelectorAll<HTMLElement>(COST_ROW)].filter(Boolean), { what: 'a new cost line', timeout: 2500, signal });
  }
  // The line the words are about, else the one that costs most.
  const amountOf = (row: HTMLElement) => Number(row.querySelector<HTMLInputElement>('input[aria-label="Amount in whole dollars"]')?.value) || 0;
  const labelOf = (row: HTMLElement) => row.querySelector<HTMLInputElement>('input[aria-label="What the cost is for"]')?.value ?? '';
  const row = [...rows].sort((a, b) => mentions(words, labelOf(b)) - mentions(words, labelOf(a)) || amountOf(b) - amountOf(a))[0]!;
  const box = row.querySelector<HTMLInputElement>('input[aria-label="Who is paid"]');
  if (!box) throw new Error(`“${task.name}” has no payee to set`);
  await hand.type(box, payee, signal, { replace: true, perSecond: 14 });
  hand.leaveField(box);
  return { name: task.name };
}

/** Renames the line `words` are about in its Name cell: a double-click, the new name typed over, and on. */
export async function renameLine(hand: Hand, words: string, name: string, signal?: AbortSignal): Promise<{ was: string }> {
  const task = lineFor(words);
  if (!task) throw new Error('No line in the package goes by that name');
  await hand.doubleClick(task.cell, signal);
  const box = await waitFor(() => find<HTMLInputElement>(`${id('snippet-gantt')} .b-editor input, ${id('snippet-gantt')} .b-cell-editor input`), { what: 'the name in its cell', timeout: 2500, signal });
  await hand.type(box, name, signal, { replace: true, perSecond: 14 });
  await hand.beat(200, signal);
  // Left rather than Enter: Enter on the last line starts a new line after it.
  hand.leaveField(box);
  await waitFor(() => (find(`${id('snippet-gantt')} .b-editor input, ${id('snippet-gantt')} .b-cell-editor input`) ? null : true), { what: 'the name to go in', timeout: 3000, signal }).catch(() => undefined);
  return { was: task.name };
}
