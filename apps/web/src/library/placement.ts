/**
 * Where a dropped library piece belongs (a floor, a work package): the group it was let go in, unless
 * its work plainly belongs in another group for the same place ("level 1" has its concrete deck and its
 * build-out: light fixtures let go on the deck belong in the build-out), and where in that group. The
 * assistant decides (the place-snippet function asks Claude, which reasons about the trades and the
 * trade order and how the piece went on another floor), and the browser's own rules answer when it
 * cannot be asked. Neither ever forces work into a group that isn't its own: the assistant can say it
 * fits nowhere it was offered, and the card says so. This browser remembers where each piece went, so a
 * drop on the next floor can follow it without asking the person again, while the piece is still on
 * the floor it follows.
 */
import type { AssignmentModel, ProjectModel, ResourceModel, TaskModel } from '@bryntum/gantt';
import { DateHelper } from '@bryntum/gantt';
import { leavesOf, placeOf, stageFits, suggestPlacement, withTheTiles, type PlacementPrecedent, type PlacementSuggestion, type Snippet, type SnippetPlan } from '@collab/shared';
import { crewMatcher, type Placement } from './insert';

type GroupBody = { id: string; name: string; tasks: { id: string; name: string; trade: string | null; start: string | null; end: string | null; waits_for: string[] }[] };

/** The body place-snippet takes (supabase/functions/_shared/placement.ts). */
export interface PlacementRequestBody {
  project_id: string;
  snippet: { name: string; summary: string; tasks: { name: string; trade: string | null; days: number }[] };
  group: GroupBody;
  /** The other groups for the same place (the build-out of a floor whose concrete deck it was let go on). */
  other_groups: GroupBody[];
  dropped_after: string | null;
  precedent: { group: string; after: string; before: string | null } | null;
}

export interface PlacementAnswer {
  after_id: string;
  before_id: string | null;
  reason: string;
  /** False when the piece belongs in none of the groups it was offered (the reason says why). */
  fits?: boolean;
}

/** Calls place-snippet; throws when it cannot answer (no model, an error, a timeout). */
export type AskPlacement = (body: PlacementRequestBody) => Promise<PlacementAnswer>;

interface TreeNode {
  parent?: TaskModel | null;
  children?: TaskModel[] | boolean;
  /** The children a filter is hiding too. */
  unfilteredOrChildren?: TaskModel[] | boolean;
  isRoot?: boolean;
}

/** The group a drop goes into (the summary task the piece will sit in); null at the top of the plan. */
export function groupOfPlacement(placement: Placement): TaskModel | null {
  const parent = placement.kind === 'after' ? ((placement.anchor as unknown as TreeNode).parent ?? null) : placement.parent;
  return parent && !(parent as unknown as TreeNode).isRoot ? parent : null;
}

/** The group's own tasks (the leaves directly inside it), in plan order. */
export function groupTasks(group: TaskModel): TaskModel[] {
  const children = (group as unknown as TreeNode).unfilteredOrChildren;
  return Array.isArray(children) ? children.filter((child) => child.isLeaf) : [];
}

const day = (date: unknown) => (date instanceof Date ? DateHelper.format(date, 'YYYY-MM-DD') : null);

function tradeOf(task: TaskModel): string | null {
  const assignment = ((task.assignments ?? []) as AssignmentModel[])[0];
  const resource = assignment?.resource as (ResourceModel & { trade?: string }) | null | undefined;
  return resource?.trade || resource?.name || null;
}

type Crew = ResourceModel & { trade?: string; kind?: string };

/** A task that came from the library: work dropped in, not what the group is for. */
export const fromLibrary = (task: TaskModel): boolean => Boolean((task as TaskModel & { libraryRef?: string | null }).libraryRef);

/** The group's own work: its tasks, less the pieces dropped into it (light fixtures let go on a concrete deck don't make it electrical work). */
const ownTasks = (group: TaskModel): TaskModel[] => groupTasks(group).filter((task) => !fromLibrary(task));

/** The trades a group's own tasks are done by ("electrical", "carpentry"); machines on rent say nothing about the work. */
function tradesIn(group: TaskModel): Set<string> {
  const trades = new Set<string>();
  for (const task of ownTasks(group)) {
    for (const assignment of (task.assignments ?? []) as AssignmentModel[]) {
      const crew = assignment.resource as Crew | null | undefined;
      if (crew && crew.kind !== 'equipment' && (crew.trade || crew.name)) trades.add((crew.trade || crew.name)!.toLowerCase());
    }
  }
  return trades;
}

/** A piece's work as placing it needs it: its tasks, with the crews they name (a firm or a trade). */
export interface PieceWork {
  name: string;
  tasks: readonly { name: string; days?: number; crews: readonly string[] }[];
}

export const pieceWorkOf = (snippet: Snippet): PieceWork => ({
  name: snippet.name,
  tasks: leavesOf(snippet.children).map((task) => ({ name: task.name, days: task.duration ?? 0, crews: (task.crews ?? []).map((crew) => crew.name) })),
});

/**
 * How well a piece's work belongs in a group: two for every trade the group's own tasks are done by too
 * (the electricians who do the rough-in install the fixtures), and one more when the group holds the
 * stage of work the piece is part of (a floor's build-out, for light fixtures). Nought for light fixtures
 * in a concrete pour.
 */
export function fitOf(project: ProjectModel, piece: PieceWork, group: TaskModel): number {
  const match = crewMatcher(project);
  const theirs = tradesIn(group);
  const ours = new Set(
    piece.tasks.flatMap((task) =>
      task.crews.map((name) => {
        const crew = match(name) as Crew | undefined;
        return (crew?.trade || name).toLowerCase();
      }),
    ),
  );
  const shared = [...ours].filter((trade) => theirs.has(trade)).length;
  return shared * 2 + (stageFits(piece, ownTasks(group).map((task) => task.name ?? '')) ? 1 : 0);
}

/**
 * The other groups for the same place as `group`, each with tasks of its own: "Level 1 build-out" for
 * "Concrete deck, level 1", and the other way round. None when its name names no place.
 */
export function samePlaceGroups(project: ProjectModel, group: TaskModel): TaskModel[] {
  const place = placeOf(group.name ?? '');
  if (!place) return [];
  return (project.taskStore.allRecords as TaskModel[]).filter(
    (other) => other !== group && !other.isLeaf && !(other as unknown as TreeNode).isRoot && placeOf(other.name ?? '') === place && groupTasks(other).length > 0,
  );
}

const groupBody = (group: TaskModel): GroupBody => ({
  id: String(group.id),
  name: group.name ?? '',
  tasks: groupTasks(group).map((task) => ({
    id: String(task.id),
    name: task.name ?? '',
    trade: tradeOf(task),
    start: day(task.startDate),
    end: day(task.endDate),
    waits_for: ((task.predecessors ?? []) as unknown as { fromEvent?: { id?: unknown } | null }[]).map((link) => link.fromEvent?.id).filter((id) => id !== undefined && id !== null).map(String),
  })),
});

/**
 * What the assistant is told: the piece, the group it was let go in, in order, the other groups for the
 * same place (so it can say the piece belongs in one of those), where it was let go, and the precedent.
 */
export function placementRequest(projectId: string, plan: SnippetPlan, placement: Placement, group: TaskModel, precedent: PlacementPrecedent | null, others: readonly TaskModel[] = []): PlacementRequestBody {
  return {
    project_id: projectId,
    snippet: {
      name: plan.snippet.name,
      summary: plan.snippet.summary,
      tasks: leavesOf(plan.snippet.children).map((task) => ({ name: task.name, trade: task.crews?.[0]?.name ?? null, days: task.duration ?? 0 })),
    },
    group: groupBody(group),
    other_groups: others.slice(0, 3).map(groupBody),
    dropped_after: placement.kind === 'after' ? String(placement.anchor.id) : placement.kind === 'inside' && placement.anchor ? String(placement.anchor.id) : null,
    precedent: precedent ? { group: precedent.group, after: precedent.after, before: precedent.before } : null,
  };
}

/** Gives up on the assistant after this long and uses the rules (a drop should not hang). */
const ASK_TIMEOUT_MS = 15_000;

/**
 * Where the piece fits: the group and the spot the assistant answers with, else the rules'. The group is
 * the one it was let go in unless its work plainly belongs in another group for the same place. Null
 * when the drop is not into a group with tasks of its own.
 */
export async function placeInGroup(ask: AskPlacement | null, projectId: string, plan: SnippetPlan, placement: Placement, precedent: PlacementPrecedent | null): Promise<{ group: TaskModel; suggestion: PlacementSuggestion } | null> {
  const dropped = groupOfPlacement(placement);
  if (!dropped) return null;
  const tasks = groupTasks(dropped);
  if (tasks.length === 0) return null;
  const project = dropped.project as unknown as ProjectModel | undefined;
  const others = project ? samePlaceGroups(project, dropped) : [];
  const groupOf = new Map<string, TaskModel>();
  for (const group of [dropped, ...others.slice(0, 3)]) for (const task of groupTasks(group)) groupOf.set(String(task.id), group);
  const byId = new Map([...groupOf.keys()].map((id) => [id, groupTasks(groupOf.get(id)!).find((task) => String(task.id) === id)!]));
  // The group by the rules: the one it was let go in, unless nothing of the piece's work is done there and another
  // group for the same place does that work (light fixtures let go on a concrete deck go to the floor's build-out).
  const piece = pieceWorkOf(plan.snippet);
  const better =
    project && fitOf(project, piece, dropped) === 0
      ? others
          .map((other) => ({ other, fit: fitOf(project, piece, other) }))
          .filter((entry) => entry.fit > 0)
          .sort((a, b) => b.fit - a.fit)[0]?.other
      : undefined;
  const group = better ?? dropped;
  const elsewhere = (suggestion: PlacementSuggestion): PlacementSuggestion => (better ? { ...suggestion, reason: `${piece.name} isn’t work for ${dropped.name}: it goes in ${group.name}. ${suggestion.reason}` } : suggestion);
  // Light fixtures let go in a floor with a lay-in ceiling go in with its tiles, the way the trade does it: answered at
  // once, without waiting on the assistant. Let go in a group that is not for that work, the assistant still says so.
  const withTiles = better ? null : withTheTiles({ name: piece.name, tasks: piece.tasks }, { name: dropped.name ?? '', tasks: groupTasks(dropped).map((task) => ({ id: task.id, name: task.name ?? '' })) });
  if (withTiles) return { group: dropped, suggestion: withTiles };
  if (ask) {
    try {
      const answer = await Promise.race([
        ask(placementRequest(projectId, plan, placement, dropped, precedent, others)),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('The assistant took too long')), ASK_TIMEOUT_MS)),
      ]);
      const after = byId.get(answer.after_id);
      const group = groupOf.get(answer.after_id);
      if (after && group) {
        // What waits for it is in the same group, or nothing does.
        const before = answer.before_id && groupOf.get(answer.before_id) === group ? (byId.get(answer.before_id) ?? null) : null;
        return { group, suggestion: { afterId: after.id, beforeId: before?.id ?? null, reason: answer.reason, source: 'model', ...(answer.fits === false ? { fits: false } : {}) } };
      }
    } catch {
      // Falls through to the rules.
    }
  }
  // By the rules, in that group.
  const suggestion = suggestPlacement({ name: piece.name, tasks: piece.tasks }, { name: group.name ?? '', tasks: groupTasks(group).map((task) => ({ id: task.id, name: task.name ?? '' })) }, precedent);
  if (!suggestion) return null;
  return { group, suggestion: elsewhere(suggestion) };
}

const STORE_KEY = (projectId: string) => `collab.library.placed.${projectId}`;

function readPlaced(projectId: string): Record<string, PlacementPrecedent> {
  try {
    const raw = window.localStorage.getItem(STORE_KEY(projectId));
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, PlacementPrecedent>) : {};
  } catch {
    return {};
  }
}

/** How a piece was placed last in this project (this browser), or null. */
export function precedentFor(projectId: string, snippetId: string): PlacementPrecedent | null {
  const found = readPlaced(projectId)[snippetId];
  return found && typeof found.group === 'string' && typeof found.after === 'string' ? found : null;
}

/** Whether the piece is in the plan now, in the group of that name. */
export function isPlacedIn(project: ProjectModel, snippetId: string, groupName: string): boolean {
  return (project.taskStore.allRecords as TaskModel[]).some((task) => (task as TaskModel & { libraryRef?: string | null }).libraryRef === snippetId && (task as unknown as TreeNode).parent?.name === groupName);
}

/** Remembers where a piece went, so the next group can follow it. */
export function rememberPlacement(projectId: string, snippetId: string, precedent: PlacementPrecedent): void {
  try {
    window.localStorage.setItem(STORE_KEY(projectId), JSON.stringify({ ...readPlaced(projectId), [snippetId]: precedent }));
  } catch {
    // Without storage the next floor asks again; nothing is lost.
  }
}

/** Forgets every placement remembered in this project (the demo starts over). */
export function forgetPlacements(projectId: string): void {
  try {
    window.localStorage.removeItem(STORE_KEY(projectId));
  } catch {
    // Nothing to forget.
  }
}
