/**
 * Revisions are made on older states than the ones they land on. What each client does about that,
 * alike on every client because all of them apply the same revisions in the same order.
 */
import type { ProjectModel } from '@bryntum/gantt';
import type { ChangesInfo } from '@collab/shared';
import { PHANTOM_ID_FIELD, type OrderedNode } from './ordered-tree';

interface LinkRecord {
  fromEvent?: unknown;
  toEvent?: unknown;
  event?: unknown;
  resource?: unknown;
}

type ChangeEntry = Record<string, unknown>;

interface StoreBags {
  added?: ChangeEntry[];
  updated?: ChangeEntry[];
  removed?: { id: unknown }[];
}

const LINK_STORES = ['tasks', 'dependencies', 'assignments'] as const;
type LinkStore = (typeof LINK_STORES)[number];

interface Orphan {
  store: LinkStore;
  entry: ChangeEntry;
}

interface Removals {
  tasks: Set<unknown>;
  resources: Set<unknown>;
}

/** The tasks and, for parents, every task under them. */
function withDescendants(project: ProjectModel, ids: unknown[]): Set<unknown> {
  const all = new Set<unknown>();
  for (const id of ids) {
    all.add(id);
    (project.taskStore.getById(id as number) as unknown as OrderedNode | undefined)?.traverse((node) =>
      all.add((node as unknown as { id: unknown }).id),
    );
  }
  return all;
}

/** Tasks and crews removed by this client's revisions the server has not confirmed yet. */
export function pendingRemovals(project: ProjectModel): Removals {
  // Bryntum keeps a confirmed revision in `pendingLocalRevisions` until the batch it came back in ends.
  const unconfirmed = new Set(
    ((project.stm as unknown as { localRevisions?: { title: string }[] }).localRevisions ?? []).map((transaction) => transaction.title),
  );
  const pending = (
    (project as unknown as { pendingLocalRevisions?: { localRevisionId: string; changes?: ChangesInfo }[] }).pendingLocalRevisions ?? []
  ).filter((revision) => unconfirmed.has(revision.localRevisionId));
  const removed = (store: string) =>
    pending.flatMap(({ changes }) => [...(changes?.[store]?.removed ?? []), ...(changes?.[store]?.$input?.removed ?? [])].map((entry) => entry.id));
  return { tasks: withDescendants(project, removed('tasks')), resources: new Set(removed('resources')) };
}

/** What Bryntum applies of a store's changes: the input when there is one, the changes otherwise. */
function appliedBags(changes: ChangesInfo, store: string): StoreBags | undefined {
  const storeChanges = changes[store];
  return storeChanges ? ((storeChanges.$input ?? storeChanges) as StoreBags) : undefined;
}

const firstKey = (entry: ChangeEntry, keys: string[]): unknown => {
  const key = keys.find((name) => entry[name] != null);
  return key === undefined ? undefined : entry[key];
};

const entryIds = (entries: ChangeEntry[]): Set<unknown> =>
  new Set<unknown>(entries.flatMap((entry) => [entry.id, entry[PHANTOM_ID_FIELD]]).filter((id) => id != null));

/**
 * Two people can add the same link, or put the same crew on a task, at the same moment, and Bryntum keeps
 * both copies. The first to reach the server stands. Every client applies the same revisions in the same
 * order and so leaves out the same later ones, and the client that made one removes its own copy
 * (`removeOrphans`). Two links that close a loop only between them are Bryntum's to settle: applying the
 * revision, it switches the later one off on every client.
 */
function duplicatesOf(project: ProjectModel, tasks: StoreBags | undefined, links: StoreBags | undefined, assignments: StoreBags | undefined, gone: ReadonlySet<unknown>): Set<ChangeEntry> {
  const refused = new Set<ChangeEntry>();
  const idOf = (record: unknown) => (record != null && typeof record === 'object' ? (record as { id: unknown }).id : record);
  /** The records these entries added, as this client already holds them under a temporary id or the real one. */
  const ownCopies = (entries: readonly ChangeEntry[]) => new Set<unknown>(entries.flatMap((entry) => [entry.id, entry[PHANTOM_ID_FIELD]]).filter((id) => id != null));
  // A client holds its own new tasks under temporary ids: links name them by their real ones.
  const aliases = new Map<unknown, unknown>();
  for (const entry of tasks?.added ?? []) if (entry[PHANTOM_ID_FIELD] != null) aliases.set(entry[PHANTOM_ID_FIELD], entry.id);
  const canon = (id: unknown) => aliases.get(id) ?? id;
  const firstOfEach = (entries: ChangeEntry[], held: Set<string>, keyOf: (entry: ChangeEntry) => string) => {
    for (const entry of entries) {
      const key = keyOf(entry);
      if (held.has(key)) refused.add(entry);
      else held.add(key);
    }
  };

  if (assignments?.added?.length) {
    const own = ownCopies(assignments.added);
    const held = new Set(
      (project.assignmentStore.allRecords as unknown as (LinkRecord & { id: unknown })[])
        .filter((assignment) => !own.has(assignment.id))
        .map((assignment) => `${String(canon(idOf(assignment.event)))}:${String(idOf(assignment.resource))}`),
    );
    firstOfEach(assignments.added, held, (entry) => `${String(firstKey(entry, ['event', 'eventId']))}:${String(firstKey(entry, ['resource', 'resourceId']))}`);
  }

  if (links?.added?.length) {
    const own = ownCopies(links.added);
    const removedLinks = new Set((links.removed ?? []).map((entry) => entry.id));
    const held = new Set<string>();
    for (const link of project.dependencyStore.allRecords as unknown as (LinkRecord & { id: unknown })[]) {
      if (own.has(link.id) || removedLinks.has(link.id)) continue;
      const [from, to] = [canon(idOf(link.fromEvent)), canon(idOf(link.toEvent))];
      if (!gone.has(from) && !gone.has(to)) held.add(`${String(from)}>${String(to)}`);
    }
    firstOfEach(links.added, held, (entry) => `${String(firstKey(entry, ['fromEvent', 'from', 'fromTask']))}>${String(firstKey(entry, ['toEvent', 'to', 'toTask']))}`);
  }
  return refused;
}

/**
 * A revision made on an older state can disagree with what revisions applied before it removed or
 * added. It can point at removed records: a child added under a deleted parent, a task moved into
 * one, a dependency to a deleted task, an assignment of a deleted task or crew. Bryntum threw on the
 * first ("Parent node with id ... not found") and kept the others as broken links. Those entries are
 * left out of what is applied. And a removal made without knowing a link added meanwhile (a
 * dependency to the task, an assignment of the crew) does not list that link; applying it made the
 * engine throw ("Unknown identifier"). Such links are removed with the record. Either way the client
 * was out of sync for good, and every reload replaying the log failed the same way. Every client
 * applies the same revisions in the same order, so all of them reconcile alike: a deleted parent takes
 * the children added under it at the same time, a move into it is ignored and links to deleted records
 * go. The client that made left-out records removes its own copies (`removeOrphans`).
 *
 * A client whose own deletion the server has not confirmed yet treats the deleted records as gone
 * when another client's revision arrives (`pending`). Bryntum undoes the deletion, applies the
 * revision and redoes the deletion, and the redo removes only the links the deletion removed at the
 * time: a link or child the revision attached to a deleted task (another client linked it a moment
 * earlier) was left behind, and the engine threw on it once the deletion came back from the server
 * ("Unknown identifier"). Left out here, it never exists on this client; the deletion removes it on
 * every other client.
 */
export function reconcileInput(
  project: ProjectModel,
  changes: ChangesInfo,
  pending?: Removals,
): { input: ChangesInfo; orphans: Orphan[] } {
  const orphans: Orphan[] = [];
  const tasks = appliedBags(changes, 'tasks');
  const resources = appliedBags(changes, 'resources');
  const removedTasks = withDescendants(project, (tasks?.removed ?? []).map((entry) => entry.id));
  // A task moved into a group this client is deleting goes with the group, as it does on every client
  // that applies the move before the deletion.
  const swept = withDescendants(
    project,
    (tasks?.updated ?? [])
      .filter(
        (entry) =>
          entry.parentId != null &&
          pending?.tasks.has(entry.parentId) &&
          !removedTasks.has(entry.parentId) &&
          project.taskStore.getById(entry.parentId as number) != null,
      )
      .map((entry) => entry.id)
      .filter((id) => project.taskStore.getById(id as number) != null),
  );
  swept.forEach((id) => removedTasks.add(id));
  const removedResources = new Set((resources?.removed ?? []).map((entry) => entry.id));
  // Records gone for this client: removed by the revision, or by one of this client's pending revisions.
  const goneTasks = new Set([...removedTasks, ...(pending?.tasks ?? [])]);
  const goneResources = new Set([...removedResources, ...(pending?.resources ?? [])]);
  const addedResources = entryIds(resources?.added ?? []);
  const taskKnown = (id: unknown) => project.taskStore.getById(id as number) != null && !goneTasks.has(id);
  const resourceExists = (id: unknown) =>
    (project.resourceStore.getById(id as number) != null && !goneResources.has(id)) || addedResources.has(id);

  // Added tasks whose parent exists or is added, and kept, by the same revision.
  let addedTasks = tasks?.added ?? [];
  for (;;) {
    const ids = entryIds(addedTasks);
    const kept = addedTasks.filter((entry) => entry.parentId == null || taskKnown(entry.parentId) || ids.has(entry.parentId));
    if (kept.length === addedTasks.length) {
      break;
    }
    orphans.push(...addedTasks.filter((entry) => !kept.includes(entry)).map((entry) => ({ store: 'tasks' as const, entry })));
    addedTasks = kept;
  }
  const addedTaskIds = entryIds(addedTasks);
  const taskExists = (id: unknown) => taskKnown(id) || addedTaskIds.has(id);
  /** Two people moving two groups into each other: the first to reach the server stands. */
  const movesIntoItself = (entry: ChangeEntry) => {
    const moved = project.taskStore.getById(entry.id as number) as unknown as { contains?(child: unknown, skipSelf?: boolean): boolean } | undefined;
    const into = entry.parentId == null ? undefined : project.taskStore.getById(entry.parentId as number);
    return Boolean(moved && into && moved.contains?.(into));
  };
  const movesIntoMissing = (entry: ChangeEntry) => (entry.parentId != null && !taskExists(entry.parentId)) || movesIntoItself(entry);
  const linksMissing = (entry: ChangeEntry) =>
    [firstKey(entry, ['fromEvent', 'from', 'fromTask']), firstKey(entry, ['toEvent', 'to', 'toTask'])].some(
      (id) => id !== undefined && !taskExists(id),
    );
  const assignsMissing = (entry: ChangeEntry) => {
    const event = firstKey(entry, ['event', 'eventId']);
    const resource = firstKey(entry, ['resource', 'resourceId']);
    return (event !== undefined && !taskExists(event)) || (resource !== undefined && !resourceExists(resource));
  };
  const refused = duplicatesOf(project, tasks, appliedBags(changes, 'dependencies'), appliedBags(changes, 'assignments'), goneTasks);
  const orphanTest: Record<LinkStore, (entry: ChangeEntry) => boolean> = {
    tasks: () => false,
    dependencies: (entry) => linksMissing(entry) || refused.has(entry),
    assignments: (entry) => assignsMissing(entry) || refused.has(entry),
  };
  // Existing links of removed tasks and crews.
  const idOf = (record: unknown) => (record != null && typeof record === 'object' ? (record as { id: unknown }).id : record);
  const unlisted: Record<LinkStore, { id: unknown }[]> = {
    tasks: [...swept].map((id) => ({ id })),
    dependencies: (project.dependencyStore.allRecords as unknown as LinkRecord[] & { id: unknown }[])
      .filter((dependency) => removedTasks.has(idOf(dependency.fromEvent)) || removedTasks.has(idOf(dependency.toEvent)))
      .map((dependency) => ({ id: (dependency as unknown as { id: unknown }).id })),
    assignments: (project.assignmentStore.allRecords as unknown as LinkRecord[])
      .filter((assignment) => removedTasks.has(idOf(assignment.event)) || removedResources.has(idOf(assignment.resource)))
      .map((assignment) => ({ id: (assignment as unknown as { id: unknown }).id })),
  };

  let input = changes;
  for (const store of LINK_STORES) {
    const bags = appliedBags(changes, store) ?? (unlisted[store].length > 0 ? {} : undefined);
    if (!bags) {
      continue;
    }
    const added = store === 'tasks' ? addedTasks : bags.added?.filter((entry) => !orphanTest[store](entry));
    for (const entry of store === 'tasks' ? [] : (bags.added ?? []).filter(orphanTest[store])) {
      orphans.push({ store, entry });
    }
    const updated =
      store === 'tasks'
        ? bags.updated?.filter((entry) => !swept.has(entry.id)).map((entry) => {
            if (!movesIntoMissing(entry)) {
              return entry;
            }
            const { parentId: _parent, parentIndex: _index, orderedParentIndex: _ordered, ...rest } = entry;
            return rest;
          })
        : bags.updated?.filter((entry) => !orphanTest[store](entry));
    const listed = new Set((bags.removed ?? []).map((entry) => entry.id));
    const removals = unlisted[store].filter((entry) => !listed.has(entry.id));
    const same =
      removals.length === 0 &&
      (added?.length ?? 0) === (bags.added?.length ?? 0) &&
      (updated?.length ?? 0) === (bags.updated?.length ?? 0) &&
      (updated ?? []).every((entry, index) => entry === bags.updated?.[index]);
    if (same) {
      continue;
    }
    const kept: StoreBags = {
      ...bags,
      ...(bags.added && { added }),
      ...(bags.updated && { updated }),
      ...(removals.length > 0 && { removed: [...(bags.removed ?? []), ...removals] }),
    };
    const storeChanges = changes[store];
    input = {
      ...input,
      [store]: !storeChanges ? { $input: kept } : storeChanges.$input ? { ...storeChanges, $input: kept } : { ...storeChanges, ...kept },
    } as ChangesInfo;
  }
  return { input, orphans };
}

/** Removes this client's own copies of records a revision added but `reconcileInput` left out. */
export function removeOrphans(project: ProjectModel, orphans: Orphan[]): void {
  const stores = { tasks: project.taskStore, dependencies: project.dependencyStore, assignments: project.assignmentStore };
  for (const { store, entry } of orphans) {
    const records = stores[store] as unknown as { getById(id: unknown): { remove(): void } | undefined };
    const record = records.getById(entry[PHANTOM_ID_FIELD]) ?? records.getById(entry.id);
    record?.remove();
  }
}
