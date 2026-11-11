/**
 * Putting a library package on the plan the way a person does: the library open, the package's card
 * carried onto a row of the floor, then the spot the assistant suggests. Both the walkthrough and the
 * voice conversation use it.
 */
import type { Gantt, Model, ProjectModel, TaskModel } from '@bryntum/gantt';
import { placeNumber, placeOf } from '@collab/shared';
import { fitOf, fromLibrary, type PieceWork } from '../library/placement';
import type { DragOptions, Hand, Point } from './hand';
import { mentions } from './said';
import { find, waitFor } from './wait';

export { placeNumber };

/** What placing needs of the plan on screen. */
export interface PlanReach {
  gantt(): Gantt | undefined;
  project: ProjectModel;
}

const id = (testId: string) => `[data-testid="${testId}"]`;

const tasksOf = (project: ProjectModel) => (project.taskStore as unknown as { allRecords: TaskModel[] }).allRecords;

/**
 * The groups `where` could name, the likeliest first: a number said ("floor one") counts most, then the
 * words. A place said ("level one") is only the groups for that place, when the plan names its groups
 * that way, and never a piece dropped from the library ("Light fixtures, levels 1 to 3" is no floor).
 */
function groupsNamed(project: ProjectModel, where: string): { group: TaskModel; score: number }[] {
  const number = placeNumber(where);
  const score = (group: TaskModel) => (number !== null && new RegExp(`\\b${number}\\b`).test(group.name ?? '') ? 2 : 0) + mentions(where, group.name ?? '');
  const groups = tasksOf(project).filter((task) => !task.isLeaf && !task.isRoot && !fromLibrary(task));
  const place = placeOf(where);
  const forPlace = place ? groups.filter((group) => placeOf(group.name ?? '') === place) : [];
  return (forPlace.length > 0 ? forPlace : groups)
    .map((group) => ({ group, score: score(group) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);
}

/**
 * The group `where` names: a floor, a wing, a phase. Said with a number ("floor one", "level 1"), a group
 * with that number in its name comes first; words in the name count too ("Level 1 build-out"). When two
 * name it as well, the first in the plan; to know which one a piece of work belongs in, `placeForPiece`.
 */
export function placeFor(project: ProjectModel, where: string): TaskModel | null {
  return groupsNamed(project, where)[0]?.group ?? null;
}

/** Where a piece goes when `where` was said: the group, why that one when others had the same name, or the groups to ask about. */
export type PlaceAnswer = { group: TaskModel; over: TaskModel[] } | { choices: TaskModel[] } | null;

/**
 * The group `where` names for this piece of work. A place can have several groups ("level one" has
 * "Concrete deck, level 1" and "Level 1 build-out"): the one whose work the piece is (its trades work
 * there; it is that stage of work) is the one meant. When the work doesn't tell them apart, it is not
 * guessed: the answer is the groups to ask about. Null when nothing is called that.
 */
export function placeForPiece(project: ProjectModel, where: string, piece: PieceWork | null): PlaceAnswer {
  const named = groupsNamed(project, where);
  if (named.length === 0) return null;
  const top = named.filter((entry) => entry.score === named[0]!.score).map((entry) => entry.group);
  if (top.length === 1) return { group: top[0]!, over: [] };
  if (!piece) return { choices: top };
  const fits = top.map((group) => ({ group, fit: fitOf(project, piece, group) })).sort((a, b) => b.fit - a.fit);
  if (fits[0]!.fit > 0 && fits[0]!.fit > fits[1]!.fit) return { group: fits[0]!.group, over: fits.slice(1).map((entry) => entry.group) };
  return { choices: fits.map((entry) => entry.group) };
}

/** The last task in a group, where new work for it most often goes. */
export function lastTaskOf(group: TaskModel): TaskModel | null {
  const leaves: TaskModel[] = [];
  (group as unknown as { traverse(visit: (node: TaskModel) => void, skipSelf?: boolean): void }).traverse((node) => {
    if (node.isLeaf) leaves.push(node);
  }, true);
  return leaves.at(-1) ?? null;
}

/** Brings a task's row on screen; returns the selector of its name cell. */
export async function showRow(plan: PlanReach, task: TaskModel, signal?: AbortSignal): Promise<string> {
  const gantt = plan.gantt();
  if (!gantt) throw new Error('The plan is not on screen');
  const view = gantt as unknown as { expandTo(record: Model, highlight?: boolean): Promise<unknown>; scrollRowIntoView(record: Model, options?: object): Promise<unknown> };
  await view.expandTo(task as unknown as Model, false).catch(() => undefined);
  await view.scrollRowIntoView(task as unknown as Model, { block: 'center' });
  const selector = `.b-gantt .b-grid-row[data-id="${task.id}"] .b-grid-cell[data-column="name"]`;
  await waitFor(() => find(selector), { what: `the row of “${task.name}”`, timeout: 5000, signal });
  return selector;
}

/** A point inside the element `selector` finds now, `fx` and `fy` of the way across and down. */
export const pointIn =
  (selector: string, fx: number, fy: number) =>
  (): Point | null => {
    const element = find(selector);
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return { x: rect.left + Math.min(rect.width - 8, rect.width * fx), y: rect.top + rect.height * fy };
  };

/** How a package is tied in when it isn't the spot the assistant suggests. */
export interface PlaceOptions {
  /**
   * `alongside`: it starts when `target` starts, and nothing in the plan moves (light fixtures in a lay-in ceiling go
   * in with the ceiling tiles). Picked from the library's "More ways to tie it in".
   */
  mode?: 'alongside';
  /** How the carry goes (its pace, the hold over the spot); a careful carry by default. */
  drag?: DragOptions;
}

/**
 * Carries the library package `name` (or the first one, without a name) onto `target`'s row, into the
 * lower part of it so the work goes after the task, and takes the spot the assistant suggests. If no
 * suggestion comes, it is put where it was dropped, pushing later work back. With a `mode`, it is tied in
 * that way instead. Returns what the library says it did ("Added …, after …").
 */
export async function placePackage(hand: Hand, plan: PlanReach, openLibrary: () => void, name: string | null, target: TaskModel, signal?: AbortSignal, { mode, drag }: PlaceOptions = {}): Promise<string> {
  openLibrary();
  // The package by its name; any package only if that one can't be found.
  const named = name ? await waitFor(() => find<HTMLElement>(id('library-card'), { text: name }), { what: `“${name}” in the library`, timeout: 3000, signal }).catch(() => null) : null;
  const card = named ?? (await waitFor(() => find<HTMLElement>(id('library-card')), { what: 'a package in the library', timeout: 5000, signal }));
  const grip = card.querySelector<HTMLElement>('.library-grip') ?? card.querySelector<HTMLElement>('.library-grab');
  if (!grip) throw new Error('The library card has nothing to pick it up by');
  const cell = await showRow(plan, target, signal);
  const noteBefore = find(id('library-note'))?.textContent ?? '';
  const placed = () => find<HTMLElement>(id('library-note'), { text: 'Added' }) ?? null;
  const fresh = () => {
    const note = placed();
    return note && note.textContent !== noteBefore ? note : null;
  };
  await hand.drag(grip, pointIn(cell, 0.5, 0.85), signal, drag);
  if (mode) {
    // Tied in this way: the other ways are behind "More ways to tie it in". No choice comes when the piece goes the
    // way it went last time.
    const asked = await waitFor(() => find<HTMLElement>(id('library-choice')) ?? fresh(), { what: 'the ways to tie it in', timeout: 15_000, signal });
    if (asked.dataset.testid === 'library-choice' && !asked.classList.contains('is-auto')) {
      const option = `${id(`library-choose-${mode}`)}:not(:disabled)`;
      if (!find(id(`library-choose-${mode}`))) {
        const more = [...asked.querySelectorAll<HTMLButtonElement>('.library-choice-foot button[aria-expanded="false"]')][0];
        if (more) await hand.click(more, signal);
      }
      await waitFor(() => find<HTMLButtonElement>(option), { what: `the way to tie it in (${mode})`, timeout: 10_000, signal });
      await hand.click(() => find<HTMLButtonElement>(option), signal);
    }
    const note = await waitFor(fresh, { what: 'the package on the plan', timeout: 30_000, signal });
    return noteWords(note);
  }
  // Where it goes: the spot the assistant suggests once it has (it answers or gives up within 15 s), or
  // no choice at all when the piece goes the way it went last time.
  const choice = await waitFor(
    () =>
      find<HTMLButtonElement>(`${id('library-choose-suggested')}:not(:disabled)`) ??
      (find(id('library-suggest-asking')) ? null : find<HTMLButtonElement>(`${id('library-choose-push')}:not(:disabled)`)) ??
      fresh(),
    { what: 'where it goes', timeout: 45_000, signal },
  );
  if (choice instanceof HTMLButtonElement && choice.dataset.fits === 'false') {
    // The assistant says it belongs nowhere here: it isn't put in anyway. The card goes, and why comes back.
    const why = [...choice.querySelectorAll('.library-choice-text > span')].find((part) => !part.className)?.textContent?.trim();
    const cancel = find<HTMLButtonElement>(`${id('library-choice')} [aria-label="Cancel"]`);
    if (cancel) await hand.click(cancel, signal);
    throw new NotPlaced(why || 'It doesn’t belong in that group.');
  }
  if (choice instanceof HTMLButtonElement) await hand.click(choice, signal);
  const note = await waitFor(fresh, { what: 'the package on the plan', timeout: 30_000, signal });
  return noteWords(note);
}

/** The assistant found the package belongs nowhere it was carried to, so it was not put on the plan. */
export class NotPlaced extends Error {
  constructor(readonly why: string) {
    super(`Not placed: ${why}`);
  }
}

/**
 * What the library's note says, one sentence per part ("Added Light fixtures. After “Ceiling grid,
 * level 1”. …"), without its buttons: the parts sit side by side, so their text alone would run together.
 */
export function noteWords(note: Element): string {
  const text = note.querySelector('.library-note-text');
  const parts = text ? [...text.children].filter((part) => !part.classList.contains('library-note-actions')).map((part) => part.textContent ?? '') : [note.textContent ?? ''];
  return parts
    .map((part) => part.replace(/Show in the plan[\s\S]*$/, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map((part) => (/[.!?]["”]?$/.test(part) ? part : `${part}.`))
    .join(' ');
}
