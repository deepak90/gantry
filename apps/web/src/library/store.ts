/**
 * The project's task library in this tab: folders and snippets read from `library_folders` and
 * `library_snippets` (RLS: the project's members), kept fresh by the `changed` announcements on the
 * private `project:{id}:library` topic (each one schedules a short, merged re-read; on every join the
 * whole library is read again, so nothing missed while the channel was down is lost), and the
 * changes people make: add, rename, file, copy and delete. Every change goes straight to the
 * database; the re-read that follows is what the panel draws, so all members see the same library.
 *
 * A plain store (`subscribe` / `getSnapshot`) for `useSyncExternalStore`.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  LibraryFolderRow,
  LibrarySnippetRow,
  libraryTopic,
  rowFieldsOf,
  snippetFromRow,
  type LibraryOrigin,
  type Snippet,
  type SnippetDraft,
} from '@collab/shared';
import { z } from 'zod';
import { joinPrivateTopic, type PrivateTopicClient } from '../supabase/private-topic';

export interface LibraryFolder {
  id: string;
  parentId: string | null;
  name: string;
  position: number;
}

export interface LibraryEntry {
  id: string;
  folderId: string | null;
  position: number;
  origin: LibraryOrigin;
  snippet: Snippet;
  createdBy: string | null;
  updatedBy: string | null;
  updatedAt: string;
}

export interface LibrarySnapshot {
  status: 'loading' | 'ready' | 'error';
  folders: readonly LibraryFolder[];
  entries: readonly LibraryEntry[];
  /** Rows whose body no longer reads as a snippet (left out of `entries`). */
  unreadable: number;
  error: string | null;
}

export type LibraryRealtimeClient = PrivateTopicClient;

export interface LibraryClient {
  from: SupabaseClient['from'];
}

const Announcement = z.object({ table: z.enum(['library_folders', 'library_snippets']), id: z.string(), op: z.string() });

const byPosition = <T extends { position: number; name?: string }>(a: T, b: T) => a.position - b.position || (a.name ?? '').localeCompare(b.name ?? '');

export class LibraryStore {
  private snapshot: LibrarySnapshot = { status: 'loading', folders: [], entries: [], unreadable: 0, error: null };
  private readonly listeners = new Set<() => void>();
  private reloadTimer: ReturnType<typeof setTimeout> | null = null;
  private loading: Promise<void> | null = null;
  private again = false;
  private leave: (() => void) | null = null;
  private disposed = false;

  constructor(
    private readonly client: LibraryClient & LibraryRealtimeClient,
    readonly projectId: string,
    private readonly options: { reloadDelayMs?: number; onWarning?: (message: string, error?: unknown) => void } = {},
  ) {}

  start(): void {
    this.leave = this.subscribeTopic();
    void this.reload();
  }

  dispose(): void {
    this.disposed = true;
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.leave?.();
    this.listeners.clear();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): LibrarySnapshot => this.snapshot;

  entry(id: string): LibraryEntry | undefined {
    return this.snapshot.entries.find((entry) => entry.id === id);
  }

  /** Re-reads the whole library (merged with a re-read already under way). */
  reload(): Promise<void> {
    if (this.loading) {
      this.again = true;
      return this.loading;
    }
    this.loading = (async () => {
      do {
        this.again = false;
        try {
          await this.read();
        } catch (error) {
          this.set({ ...this.snapshot, status: this.snapshot.status === 'ready' ? 'ready' : 'error', error: error instanceof Error ? error.message : String(error) });
        }
      } while (this.again && !this.disposed);
    })().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  // ---- changes ------------------------------------------------------------------------------

  async createFolder(name: string, parentId: string | null): Promise<string> {
    const position = this.nextPosition(this.snapshot.folders.filter((folder) => folder.parentId === parentId));
    const { data, error } = await this.client.from('library_folders').insert({ project_id: this.projectId, parent_id: parentId, name: name.trim(), position }).select('id').single();
    if (error) throw new Error(error.message);
    await this.reload();
    return (data as { id: string }).id;
  }

  async renameFolder(id: string, name: string): Promise<void> {
    await this.update('library_folders', id, { name: name.trim() });
  }

  async moveFolder(id: string, parentId: string | null): Promise<void> {
    const position = this.nextPosition(this.snapshot.folders.filter((folder) => folder.parentId === parentId && folder.id !== id));
    await this.update('library_folders', id, { parent_id: parentId, position });
  }

  /** Deletes a folder and the folders in it; their snippets move up to the folder's own parent first. */
  async deleteFolder(id: string): Promise<void> {
    const folder = this.snapshot.folders.find((candidate) => candidate.id === id);
    if (!folder) return;
    const inside = this.foldersUnder(id);
    const snippets = this.snapshot.entries.filter((entry) => entry.folderId !== null && inside.has(entry.folderId));
    if (snippets.length > 0) {
      const { error } = await this.client.from('library_snippets').update({ folder_id: folder.parentId }).in('id', snippets.map((entry) => entry.id));
      if (error) throw new Error(error.message);
    }
    const { error } = await this.client.from('library_folders').delete().eq('id', id);
    if (error) throw new Error(error.message);
    await this.reload();
  }

  /** Saves a snippet: a new one when `id` is not given. Returns its id. */
  async saveSnippet(draft: SnippetDraft, options: { id?: string; folderId?: string | null; origin?: LibraryOrigin } = {}): Promise<string> {
    const fields = rowFieldsOf(draft);
    if (options.id) {
      const { data, error } = await this.client
        .from('library_snippets')
        .update({ ...fields, ...(options.folderId !== undefined ? { folder_id: options.folderId } : {}) })
        .eq('id', options.id)
        .select('id');
      if (error) throw new Error(error.message);
      if ((data as unknown[]).length > 0) {
        await this.reload();
        return options.id;
      }
      // Someone deleted it while this was open: the work is saved as a new piece rather than lost.
    }
    const folderId = options.folderId ?? null;
    const position = this.nextPosition(this.snapshot.entries.filter((entry) => entry.folderId === folderId));
    const { data, error } = await this.client
      .from('library_snippets')
      .insert({ project_id: this.projectId, folder_id: folderId, position, origin: options.origin ?? 'person', ...fields })
      .select('id')
      .single();
    if (error) throw new Error(error.message);
    await this.reload();
    return (data as { id: string }).id;
  }

  async renameSnippet(id: string, name: string): Promise<void> {
    await this.update('library_snippets', id, { name: name.trim() });
  }

  async moveSnippet(id: string, folderId: string | null): Promise<void> {
    const position = this.nextPosition(this.snapshot.entries.filter((entry) => entry.folderId === folderId && entry.id !== id));
    await this.update('library_snippets', id, { folder_id: folderId, position });
  }

  /** A copy next to the original, named "… (copy)". Returns the copy's id. */
  async duplicateSnippet(id: string): Promise<string> {
    const entry = this.entry(id);
    if (!entry) throw new Error('That snippet is no longer in the library.');
    const { id: _old, ...draft } = entry.snippet;
    return this.saveSnippet({ ...draft, name: `${draft.name} (copy)`.slice(0, 120) }, { folderId: entry.folderId });
  }

  async deleteSnippet(id: string): Promise<void> {
    const { error } = await this.client.from('library_snippets').delete().eq('id', id);
    if (error) throw new Error(error.message);
    await this.reload();
  }

  // ---- internals ----------------------------------------------------------------------------

  private async read(): Promise<void> {
    const [folders, snippets] = await Promise.all([
      this.client.from('library_folders').select('*').eq('project_id', this.projectId),
      this.client.from('library_snippets').select('*').eq('project_id', this.projectId),
    ]);
    if (folders.error) throw new Error(folders.error.message);
    if (snippets.error) throw new Error(snippets.error.message);
    const folderRows = z.array(LibraryFolderRow).parse(folders.data);
    const snippetRows = z.array(LibrarySnippetRow).parse(snippets.data);
    const entries: LibraryEntry[] = [];
    let unreadable = 0;
    for (const row of snippetRows) {
      const snippet = snippetFromRow(row);
      if (!snippet) {
        unreadable++;
        continue;
      }
      entries.push({ id: row.id, folderId: row.folder_id, position: row.position, origin: row.origin, snippet, createdBy: row.created_by, updatedBy: row.updated_by, updatedAt: row.updated_at });
    }
    if (this.disposed) return;
    this.set({
      status: 'ready',
      folders: folderRows.map((row) => ({ id: row.id, parentId: row.parent_id, name: row.name, position: row.position })).sort(byPosition),
      entries: entries.sort((a, b) => a.position - b.position || a.snippet.name.localeCompare(b.snippet.name)),
      unreadable,
      error: null,
    });
  }

  private async update(table: 'library_folders' | 'library_snippets', id: string, values: Record<string, unknown>): Promise<void> {
    const { error } = await this.client.from(table).update(values).eq('id', id);
    if (error) throw new Error(error.message);
    await this.reload();
  }

  private nextPosition(siblings: readonly { position: number }[]): number {
    return siblings.reduce((max, sibling) => Math.max(max, sibling.position), 0) + 1;
  }

  private foldersUnder(id: string): Set<string> {
    const found = new Set([id]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const folder of this.snapshot.folders) {
        if (folder.parentId && found.has(folder.parentId) && !found.has(folder.id)) {
          found.add(folder.id);
          grew = true;
        }
      }
    }
    return found;
  }

  private set(next: LibrarySnapshot): void {
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }

  private scheduleReload(): void {
    if (this.reloadTimer || this.disposed) return;
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = null;
      void this.reload();
    }, this.options.reloadDelayMs ?? 150);
  }

  private warn(message: string, error?: unknown): void {
    if (this.options.onWarning) this.options.onWarning(message, error);
    else console.warn(`[library ${this.projectId}] ${message}`, error);
  }

  /** Joins the library topic (and again, with a growing delay, whenever the server closes it). */
  private subscribeTopic(): () => void {
    return joinPrivateTopic(this.client, libraryTopic(this.projectId), {
      name: 'library channel',
      warn: (message, error) => this.warn(message, error),
      listen: (joined, live) => {
        joined.on('broadcast', { event: 'changed' }, ({ payload }) => {
          if (!live()) return;
          if (Announcement.safeParse(payload).success) this.scheduleReload();
          else this.warn('dropped a malformed library announcement', payload);
        });
      },
      // Back after a rejoin: whatever changed while the channel was down is read again.
      onStatus: (_status, rejoined) => {
        if (rejoined) this.scheduleReload();
      },
    });
  }
}

// -----------------------------------------------------------------------------------------
// The library as a tree, with outline numbers
// -----------------------------------------------------------------------------------------

export interface LibraryFolderNode {
  folder: LibraryFolder;
  /** "2.1": the folder's place in the library outline. */
  number: string;
  folders: LibraryFolderNode[];
  entries: { entry: LibraryEntry; number: string }[];
  /** Snippets in this folder and every folder under it. */
  count: number;
}

export interface LibraryTree {
  folders: LibraryFolderNode[];
  /** Snippets not filed in any folder. */
  entries: { entry: LibraryEntry; number: string }[];
}

/** Folders and snippets nested and numbered (folders first, then snippets, each in their saved order). */
export function libraryTree(folders: readonly LibraryFolder[], entries: readonly LibraryEntry[]): LibraryTree {
  const known = new Set(folders.map((folder) => folder.id));
  const build = (parentId: string | null, prefix: string): { folders: LibraryFolderNode[]; entries: { entry: LibraryEntry; number: string }[] } => {
    const childFolders = folders.filter((folder) => folder.parentId === parentId).sort(byPosition);
    const nodes = childFolders.map((folder, index) => {
      const number = `${prefix}${index + 1}`;
      const inner = build(folder.id, `${number}.`);
      const count = inner.entries.length + inner.folders.reduce((sum, child) => sum + child.count, 0);
      return { folder, number, folders: inner.folders, entries: inner.entries, count };
    });
    // A snippet whose folder is gone shows at the top level.
    const own = entries.filter((entry) => (parentId === null ? entry.folderId === null || !known.has(entry.folderId) : entry.folderId === parentId));
    return { folders: nodes, entries: own.map((entry, index) => ({ entry, number: `${prefix}${childFolders.length + index + 1}` })) };
  };
  return build(null, '');
}

/** Whether a snippet matches a search: its name, summary, task names, crews or notes contain every word. */
export function matchesLibrarySearch(snippet: Snippet, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const parts: string[] = [snippet.name, snippet.summary];
  const walk = (tasks: Snippet['children']) => {
    for (const task of tasks) {
      parts.push(task.name, task.note ?? '', ...(task.crews ?? []).map((crew) => crew.name));
      walk(task.children ?? []);
    }
  };
  walk(snippet.children);
  const text = parts.join(' ').toLowerCase();
  return words.every((word) => text.includes(word));
}

/** The folder path of a folder, outermost first ("Build-out › Clinical rooms"). */
export function folderPath(folders: readonly LibraryFolder[], id: string | null): LibraryFolder[] {
  const path: LibraryFolder[] = [];
  const seen = new Set<string>();
  for (let current = folders.find((folder) => folder.id === id); current && !seen.has(current.id); current = folders.find((folder) => folder.id === current!.parentId)) {
    seen.add(current.id);
    path.unshift(current);
  }
  return path;
}
