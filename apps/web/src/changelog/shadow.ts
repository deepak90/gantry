/**
 * A plain copy of the project's records, folded forward from the snapshot `load_project` returned
 * through every revision in order. A stored revision only says what records became; the copy knows
 * what they were before, what removed records were called and which tasks are phases, so the
 * changelog can say "2 days later" and name what was deleted. Nothing here touches the live
 * ProjectModel: the copy is built from the server's data alone, identical in every browser.
 */
import type { ChangesInfo, ProjectInlineData, StoreChanges } from '@collab/shared';

export type ShadowRecord = Record<string, unknown>;
export type RecordId = string | number;

/** Stores that hold records, in the order a revision is folded (records before the links to them). */
export const RECORD_STORES = ['calendars', 'resources', 'tasks', 'dependencies', 'assignments'] as const;
export type RecordStoreName = (typeof RECORD_STORES)[number];
export type StoreName = RecordStoreName | 'project';

/** What happened to one record in one revision. */
export interface RecordChange {
  store: StoreName;
  id: RecordId;
  type: 'add' | 'remove' | 'update';
  /** The record before the revision (null when added). */
  before: ShadowRecord | null;
  /** The record after the revision (null when removed). */
  after: ShadowRecord | null;
  /** Fields whose value changed (updates). */
  fields: string[];
  /** The subset of `fields` (or the add/remove itself) that came from the person: the revision's `$input`. */
  inputFields: string[];
  /** Added or removed by the person, or updated with person-made field changes. */
  isInput: boolean;
}

/** Keys that are bookkeeping, never a change worth showing. */
const IGNORED_KEYS = new Set(['id', '$PhantomId', 'children', 'expanded']);

function isRecord(value: unknown): value is ShadowRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a == null && b == null;
  if (typeof a === 'object' || typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b);
  // Snapshot dates are `YYYY-MM-DD`, revision dates `YYYY-MM-DDT00:00:00`: the same calendar value.
  if (typeof a === 'string' && typeof b === 'string') return a.replace(/T00:00(:00)?$/, '') === b.replace(/T00:00(:00)?$/, '');
  return false;
}

function idOf(record: unknown): RecordId | null {
  if (!isRecord(record)) return null;
  const { id } = record;
  return typeof id === 'number' || typeof id === 'string' ? id : null;
}

const key = (id: RecordId) => String(id);

export class ProjectShadow {
  private readonly stores = new Map<RecordStoreName, Map<string, ShadowRecord>>(RECORD_STORES.map((store) => [store, new Map()]));
  /** Last known state of removed records, so later entries can still name them. */
  private readonly removed = new Map<RecordStoreName, Map<string, ShadowRecord>>(RECORD_STORES.map((store) => [store, new Map()]));
  private projectFields: ShadowRecord = {};

  static fromSnapshot(snapshot: ProjectInlineData): ProjectShadow {
    const shadow = new ProjectShadow();
    shadow.projectFields = { ...(snapshot.project ?? {}) };
    const raw = snapshot as unknown as Record<string, unknown>;
    const rows = (dataKey: string, modernKey: string): unknown[] => {
      const value = raw[dataKey] ?? raw[modernKey];
      return Array.isArray(value) ? value : [];
    };
    shadow.loadTasks(rows('tasksData', 'tasks'), null);
    for (const [store, dataKey] of [
      ['calendars', 'calendarsData'],
      ['resources', 'resourcesData'],
      ['dependencies', 'dependenciesData'],
      ['assignments', 'assignmentsData'],
    ] as const) {
      for (const row of rows(dataKey, store)) {
        const id = idOf(row);
        if (id !== null) shadow.store(store).set(key(id), { ...(row as ShadowRecord) });
      }
    }
    return shadow;
  }

  private loadTasks(rows: unknown[], parentId: RecordId | null): void {
    for (const row of rows) {
      const id = idOf(row);
      if (id === null) continue;
      const { children, ...fields } = row as ShadowRecord;
      this.store('tasks').set(key(id), { ...fields, parentId: fields.parentId ?? parentId });
      if (Array.isArray(children)) this.loadTasks(children, id);
    }
  }

  private store(name: RecordStoreName): Map<string, ShadowRecord> {
    return this.stores.get(name)!;
  }

  get project(): Readonly<ShadowRecord> {
    return this.projectFields;
  }

  /** The record as it is now, or as it was when it was removed. */
  get(store: RecordStoreName, id: RecordId | null | undefined): ShadowRecord | null {
    if (id === null || id === undefined) return null;
    return this.store(store).get(key(id)) ?? this.removed.get(store)!.get(key(id)) ?? null;
  }

  exists(store: RecordStoreName, id: RecordId): boolean {
    return this.store(store).has(key(id));
  }

  name(store: RecordStoreName, id: RecordId | null | undefined): string | null {
    const name = this.get(store, id)?.name;
    return typeof name === 'string' && name.trim() ? name : null;
  }

  /** A task with sub-tasks (a phase) rather than a piece of work. */
  isParentTask(id: RecordId): boolean {
    const target = key(id);
    for (const task of this.store('tasks').values()) {
      if (task.parentId !== null && task.parentId !== undefined && key(task.parentId as RecordId) === target) return true;
    }
    return false;
  }

  /** Folds one revision's changes in and reports what happened to each record. */
  apply(changes: ChangesInfo): RecordChange[] {
    const result: RecordChange[] = [];
    for (const store of RECORD_STORES) {
      const storeChanges = changes[store];
      if (isRecord(storeChanges)) result.push(...this.applyStore(store, storeChanges as StoreChanges));
    }
    const projectChanges = changes.project;
    if (isRecord(projectChanges)) {
      const before = { ...this.projectFields };
      const fields = Object.keys(projectChanges).filter((field) => !field.startsWith('$') && !sameValue(before[field], projectChanges[field]));
      this.projectFields = { ...before, ...projectChanges };
      if (fields.length > 0) {
        result.push({ store: 'project', id: 'project', type: 'update', before, after: { ...this.projectFields }, fields, inputFields: [], isInput: false });
      }
    }
    return result;
  }

  private applyStore(store: RecordStoreName, changes: StoreChanges): RecordChange[] {
    const records = this.store(store);
    const graveyard = this.removed.get(store)!;
    const input = changes.$input ?? {};
    const inputAdded = new Set((input.added ?? []).map(idOf).filter((id) => id !== null).map(key));
    const inputRemoved = new Set((input.removed ?? []).map(idOf).filter((id) => id !== null).map(key));
    const inputUpdated = new Map<string, Set<string>>();
    for (const row of input.updated ?? []) {
      const id = idOf(row);
      if (id !== null) inputUpdated.set(key(id), new Set(Object.keys(row).filter((field) => !IGNORED_KEYS.has(field))));
    }
    const result: RecordChange[] = [];

    for (const row of changes.added ?? []) {
      const id = idOf(row);
      if (id === null) continue;
      const after = { ...row };
      delete after.$PhantomId;
      records.set(key(id), after);
      graveyard.delete(key(id));
      const isInput = inputAdded.has(key(id));
      result.push({ store, id, type: 'add', before: null, after: { ...after }, fields: [], inputFields: [], isInput });
    }

    for (const row of changes.updated ?? []) {
      const id = idOf(row);
      if (id === null) continue;
      const before = records.get(key(id)) ?? null;
      const fields = Object.keys(row).filter((field) => !IGNORED_KEYS.has(field) && !sameValue(before?.[field], row[field]));
      const after = { ...(before ?? {}), ...row };
      delete after.$PhantomId;
      records.set(key(id), after);
      if (fields.length === 0) continue;
      const touched = inputUpdated.get(key(id));
      const inputFields = touched ? fields.filter((field) => touched.has(field)) : [];
      result.push({ store, id, type: 'update', before: before ? { ...before } : null, after: { ...after }, fields, inputFields, isInput: inputFields.length > 0 });
    }

    for (const row of changes.removed ?? []) {
      const id = idOf(row);
      if (id === null) continue;
      const before = records.get(key(id)) ?? null;
      records.delete(key(id));
      if (before) graveyard.set(key(id), before);
      result.push({ store, id, type: 'remove', before, after: null, fields: [], inputFields: [], isInput: inputRemoved.has(key(id)) });
    }
    return result;
  }
}
