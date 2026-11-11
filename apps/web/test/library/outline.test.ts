/**
 * The builder's rows and bands (outline numbers, new bands over one task or a run of them) and the
 * library tree (folders nested and numbered, search, folder paths): pure functions, no Bryntum.
 */
import { describe, expect, it } from 'vitest';
import type { SnippetDraft } from '@collab/shared';
import { emptyDraft, newTimeRange, outlineRows, setTimeRanges } from '../../src/library/outline';
import { folderPath, libraryTree, matchesLibrarySearch, type LibraryEntry, type LibraryFolder } from '../../src/library/store';

const draft = (): SnippetDraft => ({
  ...emptyDraft(),
  name: 'Room',
  children: [
    { key: 'walls', name: 'Walls', children: [{ key: 'studs', name: 'Studs', duration: 2 }, { key: 'board', name: 'Drywall', duration: 1 }] },
    { key: 'paint', name: 'Paint', duration: 2, crews: [{ name: 'Painters' }] },
    { key: 'punch', name: 'Punch list', duration: 1 },
  ],
  links: [
    { from: 'studs', to: 'board' },
    { from: 'board', to: 'paint' },
    { from: 'paint', to: 'punch' },
  ],
});

const shape = (value: SnippetDraft) => outlineRows(value.children).map((row) => `${row.number} ${row.task.name}${row.isGroup ? '/' : ''}`);

describe('the builder rows and bands', () => {
  it('lists rows in plan order with outline numbers', () => {
    expect(shape(draft())).toEqual(['1 Walls/', '1.1 Studs', '1.2 Drywall', '2 Paint', '3 Punch list']);
  });

  it('lays a band over one task, or from the start of one to the end of another', () => {
    expect(newTimeRange(draft(), 'paint')).toEqual({ key: 'band', name: 'New time range', from: { task: 'paint', edge: 'start' }, to: { task: 'paint', edge: 'end' }, tone: 'amber' });
    const over = newTimeRange(draft(), 'studs', 'paint');
    expect([over.from, over.to]).toEqual([
      { task: 'studs', edge: 'start' },
      { task: 'paint', edge: 'end' },
    ]);
    const banded = setTimeRanges(draft(), [over]);
    expect(newTimeRange(banded, 'punch').key).toBe('band-2');
    expect(setTimeRanges(banded, [])).not.toHaveProperty('timeRanges');
  });
});

describe('the library tree', () => {
  const folders: LibraryFolder[] = [
    { id: 'a', parentId: null, name: 'Build-out', position: 1 },
    { id: 'b', parentId: 'a', name: 'Rooms', position: 1 },
    { id: 'c', parentId: null, name: 'Services', position: 2 },
  ];
  const entry = (id: string, folderId: string | null, position: number, name = id): LibraryEntry => ({
    id,
    folderId,
    position,
    origin: 'person',
    snippet: { id, ...draft(), name },
    createdBy: null,
    updatedBy: null,
    updatedAt: '2026-10-24T00:00:00Z',
  });

  it('nests and numbers folders before snippets, counting everything below', () => {
    const tree = libraryTree(folders, [entry('x', 'b', 1), entry('y', 'a', 1), entry('z', null, 1), entry('lost', 'gone', 1)]);
    expect(tree.folders.map((node) => `${node.number} ${node.folder.name} (${node.count})`)).toEqual(['1 Build-out (2)', '2 Services (0)']);
    expect(tree.folders[0]!.folders[0]!.number).toBe('1.1');
    expect(tree.folders[0]!.folders[0]!.entries.map((item) => item.number)).toEqual(['1.1.1']);
    expect(tree.folders[0]!.entries.map((item) => item.number)).toEqual(['1.2']);
    expect(tree.entries.map((item) => `${item.number} ${item.entry.id}`)).toEqual(['3 z', '4 lost']);
    expect(folderPath(folders, 'b').map((folder) => folder.name)).toEqual(['Build-out', 'Rooms']);
  });

  it('searches names, task names and crews', () => {
    const snippet = entry('x', null, 1, 'Room build-out').snippet;
    expect(matchesLibrarySearch(snippet, 'room studs')).toBe(true);
    expect(matchesLibrarySearch(snippet, 'painters')).toBe(true);
    expect(matchesLibrarySearch(snippet, 'crane')).toBe(false);
    expect(matchesLibrarySearch(snippet, '  ')).toBe(true);
  });
});
