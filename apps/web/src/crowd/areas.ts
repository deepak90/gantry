/**
 * Who looks after which tasks. Each person's persona names the words of their trade; a task goes to
 * whoever's words its name (and its phase's) match best, keeping the shares roughly even. Tasks no
 * persona recognizes go, phase by phase, to whoever has least. Nothing here knows any project's ids.
 *
 * Or each person is given one part of the plan (`branchAreas`): a summary task, by name or WBS code,
 * and every task under it is theirs and nobody else's.
 */
import type { ProjectModel, TaskModel } from '@bryntum/gantt';
import type { Persona } from './personas';

/** The summary task `wanted` names: by its WBS code ("2", "1.3") or by its name, in any case. */
export function branchNamed(project: ProjectModel, wanted: string): TaskModel | null {
  const key = wanted.trim().toLowerCase();
  const groups = (project.taskStore.allRecords as TaskModel[]).filter((task) => !task.isLeaf && !task.isRoot);
  return (
    groups.find((task) => String((task as TaskModel & { wbsCode?: unknown }).wbsCode ?? '') === key) ??
    groups.find((task) => String(task.name ?? '').trim().toLowerCase() === key) ??
    null
  );
}

/** Whether `task` is somewhere under `branch`. */
function isUnder(task: TaskModel, branch: TaskModel): boolean {
  for (let node = task.parent as TaskModel | null | undefined; node; node = node.parent as TaskModel | null | undefined) {
    if (node === branch) return true;
  }
  return false;
}

export type BranchAreas = { areas: Map<string, number[]>; names: Map<string, string> } | { missing: string };

/**
 * Each person, in order, gets the part of the plan `branches` names for them: their tasks are the ones
 * of `tasks` under it. A branch the plan doesn't have comes back as `missing`, so nothing is half pinned.
 */
export function branchAreas(project: ProjectModel, tasks: readonly TaskModel[], people: readonly string[], branches: readonly string[]): BranchAreas {
  const areas = new Map<string, number[]>();
  const names = new Map<string, string>();
  for (const [index, personId] of people.entries()) {
    const wanted = branches[index];
    if (wanted === undefined) {
      areas.set(personId, []);
      continue;
    }
    const branch = branchNamed(project, wanted);
    if (!branch) return { missing: wanted };
    areas.set(
      personId,
      tasks.filter((task) => typeof task.id === 'number' && isUnder(task, branch)).map((task) => task.id as number),
    );
    names.set(personId, String(branch.name ?? wanted));
  }
  return { areas, names };
}

/** The task's name and its phases' names, lower case, the task first. */
export function taskWords(task: TaskModel): { own: string; parents: string } {
  const parents: string[] = [];
  let parent = task.parent as TaskModel | null | undefined;
  while (parent && !parent.isRoot) {
    parents.push(String(parent.name ?? ''));
    parent = parent.parent as TaskModel | null | undefined;
  }
  return { own: String(task.name ?? '').toLowerCase(), parents: parents.join(' / ').toLowerCase() };
}

export function matchScore(task: TaskModel, keywords: readonly string[]): number {
  const { own, parents } = taskWords(task);
  let score = 0;
  for (const keyword of keywords) {
    if (own.includes(keyword)) score += 2;
    else if (parents.includes(keyword)) score += 1;
  }
  return score;
}

const topPhase = (task: TaskModel): string => {
  let node: TaskModel = task;
  while (node.parent && !(node.parent as TaskModel).isRoot) node = node.parent as TaskModel;
  return String(node.id);
};

/** Splits `tasks` among `personas`: person id → task ids. */
export function partitionAreas(tasks: readonly TaskModel[], personas: readonly Persona[]): Map<string, number[]> {
  const areas = new Map<string, number[]>(personas.map((persona) => [persona.person.id, []]));
  if (personas.length === 0) return areas;
  const cap = Math.max(2, Math.ceil((tasks.length / personas.length) * 1.4));
  const load = (persona: Persona) => areas.get(persona.person.id)!.length;
  const leastLoaded = () => [...personas].sort((a, b) => load(a) - load(b))[0]!;
  const unmatched = new Map<string, TaskModel[]>();
  const scored = tasks
    .filter((task): task is TaskModel & { id: number } => typeof task.id === 'number')
    .map((task) => ({ task, scores: personas.map((persona) => ({ persona, score: matchScore(task, persona.keywords) })) }))
    // Clear matches first, so they get their people before the shares fill up.
    .sort((a, b) => Math.max(...b.scores.map((entry) => entry.score)) - Math.max(...a.scores.map((entry) => entry.score)));
  for (const { task, scores } of scored) {
    const ranked = scores.filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score || load(a.persona) - load(b.persona));
    const chosen = ranked.find((entry) => load(entry.persona) < cap)?.persona;
    if (chosen) {
      areas.get(chosen.person.id)!.push(task.id as number);
      continue;
    }
    const phase = topPhase(task);
    unmatched.set(phase, [...(unmatched.get(phase) ?? []), task]);
  }
  for (const group of unmatched.values()) {
    // A phase nobody recognizes stays together, with whoever has least.
    for (let start = 0; start < group.length; start += cap) {
      const owner = leastLoaded();
      for (const task of group.slice(start, start + cap)) areas.get(owner.person.id)!.push(task.id as number);
    }
  }
  return areas;
}
