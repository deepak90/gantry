/**
 * The library panel on a headless copy of the seed with the starter library: folders numbered like an
 * outline, search, the cards and their tweaks, crews that are not on the project, the keyboard way to
 * drop ("Add after the selected task": the same choice card as a drag, with what each way would move,
 * then Undo), saving work picked in the plan, the card menu, and the builder (open, rename, save).
 * The library store is a stand-in that records the calls.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ProjectModel, TaskModel } from '@bryntum/gantt';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { leavesOf, type ProjectInlineData, type Snippet, type SnippetDraft } from '@collab/shared';
import { STARTER_FOLDERS, STARTER_SNIPPETS, type StarterFolder } from '@collab/shared/library-starter';
import { harborOffices } from '@collab/shared/seed';
import { createProjectModel, loadCollaborativeProject } from '../../src/gantt/project';
import { LibraryPanel } from '../../src/inspector/LibraryPanel';
import { describeEffect, describePlace, formatDay, handoverDate, zoneFor } from '../../src/library/describe';
import { placementFor } from '../../src/library/insert';
import type { AskPlacement, PlacementAnswer } from '../../src/library/placement';
import type { LibraryEntry, LibraryFolder, LibrarySnapshot, LibraryStore } from '../../src/library/store';
import { seedSnapshot } from './harness';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The starter library as the store would read it: folder ids `f:<name>`, snippet ids = starter keys. */
function starterSnapshot(): LibrarySnapshot {
  const folders: LibraryFolder[] = [];
  const entries: LibraryEntry[] = [];
  const walk = (list: readonly StarterFolder[], parentId: string | null) =>
    list.forEach((folder, index) => {
      const id = `f:${folder.name}`;
      folders.push({ id, parentId, name: folder.name, position: index + 1 });
      folder.snippets.forEach((key, order) => {
        const { starterKey, ...draft } = STARTER_SNIPPETS.find((snippet) => snippet.starterKey === key)!;
        entries.push({ id: starterKey, folderId: id, position: order + 1, origin: 'starter', snippet: { id: starterKey, ...draft }, createdBy: null, updatedBy: null, updatedAt: '2026-10-24T00:00:00Z' });
      });
      walk(folder.folders ?? [], id);
    });
  walk(STARTER_FOLDERS, null);
  return { status: 'ready', folders, entries, unreadable: 0, error: null };
}

function fakeStore() {
  const snapshot = starterSnapshot();
  return {
    projectId: 'project-1',
    subscribe: () => () => undefined,
    getSnapshot: () => snapshot,
    entry: (id: string) => snapshot.entries.find((entry) => entry.id === id),
    saveSnippet: vi.fn(async (_draft: SnippetDraft, options: { id?: string }) => options.id ?? 'new-id'),
    renameSnippet: vi.fn(async () => undefined),
    duplicateSnippet: vi.fn(async () => 'copy-id'),
    moveSnippet: vi.fn(async () => undefined),
    deleteSnippet: vi.fn(async () => undefined),
    createFolder: vi.fn(async () => 'folder-id'),
    renameFolder: vi.fn(async () => undefined),
    deleteFolder: vi.fn(async () => undefined),
  };
}

let project: ProjectModel;
let host: HTMLDivElement;
let root: Root;
let store: ReturnType<typeof fakeStore>;

beforeEach(async () => {
  project = createProjectModel();
  await loadCollaborativeProject(project, seedSnapshot(), 'panel-test');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  store = fakeStore();
  window.localStorage.clear();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.querySelectorAll('.builder-backdrop, .library-choice').forEach((element) => element.remove());
  project.destroy();
});

const render = (selectedTaskId: number | null = null) =>
  act(() => root.render(<LibraryPanel project={project} gantt={() => undefined} selectedTaskId={selectedTaskId} library={store as unknown as LibraryStore} />));

const card = (id: string) => host.querySelector<HTMLElement>(`[data-snippet-id="${id}"]`)!;
const click = (element: Element | null) =>
  act(() => {
    (element as HTMLElement).click();
  });
/** Lets timers and the engine run until `done` (the choice card works its numbers out on a copy of the plan). Up to 10 s: with every file running at once, a copy of a 50-task plan can take a while. */
async function settle(done: () => boolean) {
  for (let wait = 0; wait < 200 && !done(); wait++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
  }
}
const previewsReady = () => document.querySelector('[data-testid=library-choice]') !== null && document.querySelector('.library-choice .library-choice-wait') === null;
const type = (input: HTMLInputElement, value: string) =>
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

describe('the library panel', { timeout: 20_000 }, () => {
  it('files every snippet in its folder, numbered like an outline, with a small timeline and unknown crews marked', () => {
    render();
    expect(host.querySelectorAll('[data-testid=library-card]')).toHaveLength(STARTER_SNIPPETS.length);
    expect(host.querySelectorAll('[data-testid=library-folder]')).toHaveLength(8);
    const folderNames = [...host.querySelectorAll('.library-folder-row')].map((row) => `${row.querySelector('.library-number')!.textContent} ${row.querySelector('.library-folder-name')!.textContent}`);
    expect(folderNames.slice(0, 4)).toEqual(['1 Build-out', '1.1 Clinical rooms', '1.2 Restrooms', '1.3 Floors & finishes']);
    expect(card('consulting-room').querySelector('strong')!.textContent).toBe('1.1.1 Exam room build-out');
    expect(card('consulting-room').textContent).toContain('11 tasks · 12 days');
    expect(card('consulting-room').querySelector('svg.snippet-mini')).not.toBeNull();
    expect(card('fire-stopping').querySelectorAll('.library-crew-dot.is-unknown')).toHaveLength(1);
    expect(card('consulting-room').querySelectorAll('.library-crew-dot.is-unknown')).toHaveLength(0);
    // The old two-way switch is gone: how the work ties in is chosen when it lands.
    expect(host.querySelector('[data-testid=library-make-way]')).toBeNull();
  });

  it('finds snippets by task or crew name and closes folders', () => {
    render();
    type(host.querySelector<HTMLInputElement>('input[type=search]')!, 'lead lined');
    expect([...host.querySelectorAll('[data-testid=library-card]')].map((element) => element.getAttribute('data-snippet-id'))).toEqual(['xray-room']);
    type(host.querySelector<HTMLInputElement>('input[type=search]')!, 'commissioning');
    expect(host.querySelectorAll('[data-testid=library-card]').length).toBe(3);
    type(host.querySelector<HTMLInputElement>('input[type=search]')!, '');
    click(host.querySelector('.library-folder-toggle[aria-label="Close Build-out"]'));
    expect(card('consulting-room')).toBeNull();
    expect(card('pad-foundation')).not.toBeNull();
  });

  it('opens a card, takes a repeat count, shows what each way would move, adds it after the selected task and undoes it', async () => {
    render(411);
    click(card('consulting-room').querySelector('.library-toggle'));
    expect(card('consulting-room').querySelectorAll('.library-tree-task')).toHaveLength(11);
    click(card('consulting-room').querySelector('button[aria-label="One more"]'));
    expect(card('consulting-room').querySelector('strong')!.textContent).toBe('1.1.1 Exam room build-out × 2');
    const before = handoverDate(project);
    const add = card('consulting-room').querySelector<HTMLButtonElement>('[data-testid=library-add-after]')!;
    expect(add.textContent).toContain('Add after “Hang, tape & finish drywall partitions”');
    // Nothing lands yet: a card asks how, with the numbers worked out on a copy of the plan.
    click(add);
    await settle(previewsReady);
    const choice = document.querySelector<HTMLElement>('[data-testid=library-choice]')!;
    expect(choice.textContent).toContain('After “Hang, tape & finish drywall partitions”');
    const push = choice.querySelector<HTMLElement>('[data-testid=library-choose-push]')!;
    expect(push.textContent).toMatch(/\d+ tasks move later, up to \d+ days/);
    expect(push.textContent).not.toContain('Handover');
    expect(choice.querySelector('[data-testid=library-choose-fit]')!.textContent).toContain('Nothing already in the plan moves');
    expect(choice.querySelector('[data-testid=library-choose-alongside]')).toBeNull();
    expect((project.taskStore.allRecords as TaskModel[]).some((task) => task.name.startsWith('Exam room build-out'))).toBe(false);

    await act(async () => {
      push.click();
      await new Promise((resolve) => setTimeout(resolve, 50));
      await project.commitAsync();
    });
    expect(document.querySelector('[data-testid=library-choice]')).toBeNull();
    // The note comes once the drop is in, which takes longer on a busy machine.
    await settle(() => host.querySelector('[data-testid=library-note]') !== null);
    const rooms = (project.taskStore.allRecords as TaskModel[]).filter((task) => task.name.startsWith('Exam room build-out – room'));
    expect(rooms.map((room) => room.name)).toEqual(['Exam room build-out – room 1', 'Exam room build-out – room 2']);
    const note = () => host.querySelector('[data-testid=library-note]')!.textContent!;
    expect(note()).toContain('Added Exam room build-out × 2 rooms');
    expect(note()).toMatch(/moved later \(up to \d+ days\)/);
    const after = handoverDate(project)!;
    expect(after.getTime()).toBeGreaterThan(before!.getTime());
    expect(host.querySelector<HTMLButtonElement>('[data-testid=library-undo]')!.disabled).toBe(true);

    // The server numbers the new tasks (here, by hand); then the drop is done and can be undone.
    rooms.forEach((room, index) => {
      room.id = 90_001 + index;
    });
    await settle(() => !host.querySelector<HTMLButtonElement>('[data-testid=library-undo]')!.disabled);

    // Undo takes the rooms out and puts the moved links back: the handover returns.
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid=library-undo]')!.click();
      await new Promise((resolve) => setTimeout(resolve, 50));
      await project.commitAsync();
    });
    await settle(() => host.querySelector('[data-testid=library-note]')?.textContent?.includes('Took out') === true);
    expect((project.taskStore.allRecords as TaskModel[]).some((task) => task.name.startsWith('Exam room build-out'))).toBe(false);
    expect(handoverDate(project)!.getTime()).toBe(before!.getTime());
    expect(note()).toContain('Took out Exam room build-out × 2 rooms');
    expect(note()).toContain('went back');
  });

  it('asks who does work the project has no crew for, and fits it in without moving anything', async () => {
    render(411);
    click(card('fire-stopping').querySelector('.library-toggle'));
    // Work already in the plan keeps its dates (only the group it lands in grows around it).
    const before = new Map((project.taskStore.allRecords as TaskModel[]).filter((task) => task.isLeaf).map((task) => [task.id, (task.endDate as Date).getTime()]));
    click(card('fire-stopping').querySelector('[data-testid=library-add-after]'));
    await settle(previewsReady);
    const choice = document.querySelector<HTMLElement>('[data-testid=library-choice]')!;
    expect(choice.querySelector('.library-choice-crews')!.textContent).toContain('Who does it');
    const who = choice.querySelector<HTMLSelectElement>('.library-choice-crew select')!;
    expect(who.value).toBe('');
    click([...choice.querySelectorAll('.library-choice-foot button')].find((button) => button.textContent === 'More ways to tie it in')!);
    expect(choice.querySelector('[data-testid=library-choose-alongside]')).not.toBeNull();
    await act(async () => {
      choice.querySelector<HTMLButtonElement>('[data-testid=library-choose-fit]')!.click();
      await new Promise((resolve) => setTimeout(resolve, 50));
      await project.commitAsync();
    });
    await settle(() => host.querySelector('[data-testid=library-note]') !== null);
    for (const [id, end] of before) expect(((project.taskStore.getById(id as number) as TaskModel).endDate as Date).getTime()).toBe(end);
    expect(host.querySelector('[data-testid=library-note]')!.textContent).toContain('Nothing already in the plan moved.');
  });

  describe('a plain run of tasks dropped on a floor', () => {
    const REASON = 'The diffusers hang from the grid, so they go in before the tiles close the ceiling.';
    // What hangs from the grid but isn't lights: where it goes is the assistant's answer (lights in a lay-in ceiling
    // go in with the tiles, below).
    const fixtures: Snippet = {
      id: 'air-diffusers',
      name: 'Air diffusers',
      summary: 'Order, deliver, install and test',
      icon: 'fan',
      unit: { one: 'floor', many: 'floors' },
      children: [
        { key: 'order', name: 'Order air diffusers', duration: 1 },
        { key: 'install', name: 'Install air diffusers', duration: 4 },
        { key: 'test', name: 'Test air diffusers', duration: 1 },
      ],
      links: [
        { from: 'order', to: 'install' },
        { from: 'install', to: 'test' },
      ],
    };
    const answerFor = (level: number) => ({ after_id: String(level * 100 + 14), before_id: String(level * 100 + 16), reason: REASON });
    const ask = vi.fn<AskPlacement>();
    const tasksNamed = (name: string) => (project.taskStore.allRecords as TaskModel[]).filter((task) => task.name === name);
    const choice = () => document.querySelector<HTMLElement>('[data-testid=library-choice]');
    const suggested = () => document.querySelector<HTMLElement>('[data-testid=library-choose-suggested]');
    const note = () => host.querySelector<HTMLElement>('[data-testid=library-note]');

    beforeEach(async () => {
      project.destroy();
      project = createProjectModel();
      await loadCollaborativeProject(project, structuredClone(harborOffices.inlineData) as ProjectInlineData, 'panel-test');
      (store.getSnapshot().entries as LibraryEntry[]).push({ id: fixtures.id, folderId: null, position: 99, origin: 'assistant', snippet: fixtures, createdBy: null, updatedBy: null, updatedAt: '2026-11-02T00:00:00Z' });
      ask.mockReset();
    });

    /** Lets the piece go on a task of the plan (the keyboard way: the same card as a drag). */
    const dropOn = (taskId: number) => {
      act(() => root.render(<LibraryPanel project={project} gantt={() => undefined} selectedTaskId={taskId} library={store as unknown as LibraryStore} askPlacement={ask} />));
      if (!card(fixtures.id).querySelector('[data-testid=library-add-after]')) click(card(fixtures.id).querySelector('.library-toggle'));
      click(card(fixtures.id).querySelector('[data-testid=library-add-after]'));
    };
    const press = async (button: HTMLElement) => {
      const was = note()?.textContent ?? null;
      await act(async () => {
        button.click();
        await new Promise((resolve) => setTimeout(resolve, 50));
        await project.commitAsync();
      });
      // The drop is in once its note says so, which takes longer on a busy machine.
      await settle(() => (note()?.textContent ?? was) !== was);
    };
    /** The server numbers the new tasks (here, by hand), which frees the panel for the next drop. */
    const number = async (from: number) => {
      tasksNamed('Order air diffusers').concat(tasksNamed('Install air diffusers'), tasksNamed('Test air diffusers')).forEach((task, index) => {
        if (typeof task.id !== 'number') task.id = from + index;
      });
      // The note's Undo: there, and free (a note not shown yet has none to wait for).
      await settle(() => host.querySelector<HTMLButtonElement>('[data-testid=library-undo]')?.disabled === false);
    };

    it('says where the assistant would put it, and nothing lands until the person takes that place', async () => {
      let answer: (value: PlacementAnswer) => void = () => undefined;
      ask.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
      dropOn(117);

      // Asking: the card is up, and the person can already choose where they let go.
      expect(document.querySelector('[data-testid=library-suggest-asking]')!.textContent).toContain('Finding where it fits');
      expect(choice()!.querySelector('[data-testid=library-choose-push]')).not.toBeNull();

      await act(async () => answer(answerFor(1)));
      await settle(() => suggested() !== null && previewsReady());
      expect(suggested()!.textContent).toContain('After Ceiling grid, level 1');
      expect(suggested()!.textContent).toContain('before Ceiling tiles, level 1');
      expect(suggested()!.textContent).toContain(REASON);
      expect(suggested()!.textContent).toContain('Suggested by Remy');
      // The other ways have their real numbers too.
      expect(choice()!.querySelector('[data-testid=library-choose-push]')!.textContent).toMatch(/moves? later/);
      expect(tasksNamed('Order air diffusers')).toEqual([]);
      expect(note()).toBeNull();

      await press(suggested()!);
      expect(choice()).toBeNull();
      const order = tasksNamed('Order air diffusers')[0]!;
      expect((order as unknown as { previousSibling: TaskModel }).previousSibling.id).toBe(114);
      expect(note()!.querySelector('[data-testid=library-note-placed]')!.textContent).toContain(REASON);
      expect(note()!.textContent).not.toContain('Placed for you');
    });

    it('let go on the floor’s concrete deck, it says the build-out, and lands there', async () => {
      const why = 'Air diffusers are build-out work, not concrete: after the ceiling grid on Level 1 build-out.';
      ask.mockResolvedValue({ after_id: '114', before_id: '116', reason: why, fits: true });
      dropOn(54);
      await settle(() => suggested() !== null && previewsReady());
      expect(ask.mock.lastCall![0].group.name).toBe('Concrete deck, level 1');
      expect(ask.mock.lastCall![0].other_groups.map((group) => group.name)).toEqual(['Level 1 build-out']);
      expect(suggested()!.dataset.group).toBe('Level 1 build-out');
      expect(suggested()!.textContent).toContain('In Level 1 build-out');
      expect(suggested()!.textContent).toContain('After Ceiling grid, level 1');
      expect(suggested()!.textContent).toContain(why);
      await press(suggested()!);
      const order = tasksNamed('Order air diffusers')[0]!;
      expect((order as unknown as { parent: TaskModel }).parent.id).toBe(100);
      expect((order as unknown as { previousSibling: TaskModel }).previousSibling.id).toBe(114);
    });

    it('says plainly when the piece belongs in none of the groups there', async () => {
      ask.mockResolvedValue({ after_id: '54', before_id: null, reason: 'Air diffusers belong in a floor build-out, not a concrete deck.', fits: false });
      dropOn(54);
      await settle(() => suggested() !== null);
      expect(suggested()!.dataset.fits).toBe('false');
      expect(suggested()!.classList.contains('is-misfit')).toBe(true);
      expect(suggested()!.textContent).toContain('Doesn’t belong here');
      expect(suggested()!.textContent).toContain('not a concrete deck');
      expect(tasksNamed('Order air diffusers')).toEqual([]);
    });

    it('lets the person keep the place they let go instead', async () => {
      ask.mockResolvedValue(answerFor(1));
      dropOn(117);
      await settle(() => suggested() !== null && previewsReady());
      await press(document.querySelector<HTMLElement>('[data-testid=library-choose-push]')!);
      const order = tasksNamed('Order air diffusers')[0]!;
      expect((order as unknown as { previousSibling: TaskModel }).previousSibling.id).toBe(117);
      expect(note()!.querySelector('[data-testid=library-note-placed]')).toBeNull();
    });

    it('cancels without touching the plan', async () => {
      ask.mockResolvedValue(answerFor(1));
      dropOn(117);
      await settle(() => suggested() !== null);
      click(choice()!.querySelector('[aria-label=Cancel]'));
      expect(choice()).toBeNull();
      expect(tasksNamed('Order air diffusers')).toEqual([]);
    });

    it('offers light fixtures in a lay-in ceiling with the tiles at once, without asking, and nothing moves', async () => {
      const lights: Snippet = { ...fixtures, id: 'light-fixtures', name: 'Light fixtures', icon: 'lightbulb', children: fixtures.children.map((child) => ({ ...child, name: child.name.replace('air diffusers', 'light fixtures') })) };
      (store.getSnapshot().entries as LibraryEntry[]).push({ id: lights.id, folderId: null, position: 100, origin: 'assistant', snippet: lights, createdBy: null, updatedBy: null, updatedAt: '2026-11-08T00:00:00Z' });
      act(() => root.render(<LibraryPanel project={project} gantt={() => undefined} selectedTaskId={117} library={store as unknown as LibraryStore} askPlacement={ask} />));
      if (!card(lights.id).querySelector('[data-testid=library-add-after]')) click(card(lights.id).querySelector('.library-toggle'));
      click(card(lights.id).querySelector('[data-testid=library-add-after]'));
      await settle(() => suggested() !== null);
      expect(ask).not.toHaveBeenCalled();
      expect(document.querySelector('[data-testid=library-suggest-asking]')).toBeNull();
      expect(suggested()!.textContent).toContain('With Ceiling tiles, level 1');
      expect(suggested()!.textContent).not.toContain('before');
      expect(suggested()!.textContent).toContain('In a lay-in ceiling the fixtures go in with the tiles');
      const handover = handoverDate(project)?.getTime();
      await press(suggested()!);
      const order = tasksNamed('Order light fixtures')[0]!;
      expect((order as unknown as { previousSibling: TaskModel }).previousSibling.id).toBe(116);
      expect(note()!.textContent).toContain('nothing else moved');
      expect(handoverDate(project)?.getTime()).toBe(handover);
    });

    it('follows the first floor on the next one while the piece is still there, and asks again once it is gone', async () => {
      ask.mockImplementation(async (body) => answerFor(Number(body.group.id) / 100));
      dropOn(117);
      await settle(() => suggested() !== null);
      await press(suggested()!);
      await number(90_001);

      // Taken back out: the first floor no longer sets the example, so the next drop asks.
      await act(async () => {
        host.querySelector<HTMLButtonElement>('[data-testid=library-undo]')!.click();
        await new Promise((resolve) => setTimeout(resolve, 50));
        await project.commitAsync();
      });
      await settle(() => note()?.textContent?.includes('Took out') === true);
      expect(tasksNamed('Order air diffusers')).toEqual([]);
      dropOn(217);
      await settle(() => suggested() !== null);
      expect(ask.mock.lastCall![0].precedent).toBeNull();
      expect(choice()).not.toBeNull();
      await press(suggested()!);
      await number(90_011);

      // Still on level 2: a blind drop on level 3 goes the same way, and the note says so.
      dropOn(317);
      await settle(() => note()?.textContent?.includes('Placed for you') === true);
      expect(ask.mock.lastCall![0].precedent).toMatchObject({ group: 'Level 2 build-out', after: 'Ceiling grid, level 2' });
      expect(choice()).toBeNull();
      const onLevel3 = tasksNamed('Order air diffusers').find((task) => (task as unknown as { parent: TaskModel }).parent.id === 300)!;
      expect((onLevel3 as unknown as { previousSibling: TaskModel }).previousSibling.id).toBe(314);
    });
  });

  it('saves work picked in the plan with a short form: one group, or several tasks', async () => {
    act(() => root.render(<LibraryPanel project={project} gantt={() => undefined} library={store as unknown as LibraryStore} saveRequest={{ taskIds: [210], nonce: 1 }} />));
    const form = () => host.querySelector<HTMLElement>('[data-testid=library-save-form]')!;
    expect(form().querySelector<HTMLInputElement>('[data-testid=library-save-name]')!.value).toBe('Spread footings');
    expect(form().textContent).toContain('6 tasks');
    type(form().querySelector<HTMLInputElement>('[data-testid=library-save-name]')!, 'Column pads');
    await act(async () => {
      form().querySelector<HTMLButtonElement>('[data-testid=library-save-submit]')!.click();
    });
    expect(store.saveSnippet).toHaveBeenCalledTimes(1);
    const [draft, options] = store.saveSnippet.mock.calls[0]!;
    expect(draft.name).toBe('Column pads');
    expect(options).toMatchObject({ folderId: null, origin: 'plan' });
    expect(leavesOf(draft.children).map((task) => task.name)).toEqual([
      'Saw-cut yard slab for spread footings',
      'Excavate spread footings',
      'Inspect footing excavations (hold point)',
      'Place rebar & cast-in anchor bolts',
      'Pour spread footings',
      'Cure spread footings',
    ]);
    expect(host.querySelector('[data-testid=library-save-form]')).toBeNull();

    // Two tasks of a group, picked together, become the snippet's two rows with the link between them.
    act(() => root.render(<LibraryPanel project={project} gantt={() => undefined} library={store as unknown as LibraryStore} saveRequest={{ taskIds: [216, 215], nonce: 2 }} />));
    expect(form().querySelector<HTMLInputElement>('[data-testid=library-save-name]')!.value).toBe('Pour spread footings and Cure spread footings');
    await act(async () => {
      form().querySelector<HTMLButtonElement>('[data-testid=library-save-submit]')!.click();
    });
    const [pair] = store.saveSnippet.mock.calls[1]!;
    expect(pair.children.map((task) => task.name)).toEqual(['Pour spread footings', 'Cure spread footings']);
    expect(pair.links).toHaveLength(1);
  });

  it('duplicates, renames and files a snippet from its menu', async () => {
    render();
    const menuButton = () => card('pad-foundation').querySelector('.library-menu-anchor > button')!;
    click(menuButton());
    await act(async () => {
      [...card('pad-foundation').querySelectorAll<HTMLButtonElement>('.menu-item')].find((item) => item.textContent === 'Duplicate')!.click();
    });
    expect(store.duplicateSnippet).toHaveBeenCalledWith('pad-foundation');
    click(menuButton());
    click([...card('pad-foundation').querySelectorAll('.menu-item')].find((item) => item.textContent === 'Rename')!);
    const rename = card('pad-foundation').querySelector<HTMLInputElement>('.library-rename')!;
    type(rename, 'Column pad');
    await act(async () => {
      rename.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(store.renameSnippet).toHaveBeenCalledWith('pad-foundation', 'Column pad');
    click(menuButton());
    click([...card('pad-foundation').querySelectorAll('.menu-item')].find((item) => item.textContent === 'Move to…')!);
    await act(async () => {
      [...card('pad-foundation').querySelectorAll<HTMLButtonElement>('.menu-item')].find((item) => item.textContent === 'Restrooms')!.click();
    });
    expect(store.moveSnippet).toHaveBeenCalledWith('pad-foundation', 'f:Restrooms');
  });

  it('opens a snippet in the builder (one Gantt editor), renames it and saves it back', async () => {
    render();
    click(card('pad-foundation').querySelector('.library-menu-anchor > button'));
    click(card('pad-foundation').querySelector('[data-testid=library-edit]'));
    const builder = document.querySelector<HTMLElement>('[data-testid=snippet-builder]')!;
    expect(builder.querySelector('[data-testid=snippet-gantt]')).not.toBeNull();
    expect([...builder.querySelectorAll('button')].some((button) => button.textContent?.includes('Outline'))).toBe(false);
    expect(builder.querySelector('.builder-stats')!.textContent).toContain('15 working days');
    type(builder.querySelector<HTMLInputElement>('[data-testid=builder-name]')!, 'Column spread footings');
    await act(async () => {
      builder.querySelector<HTMLButtonElement>('[data-testid=builder-save]')!.click();
    });
    expect(store.saveSnippet).toHaveBeenCalledTimes(1);
    const [draft, options] = store.saveSnippet.mock.calls[0]!;
    expect(options).toMatchObject({ id: 'pad-foundation', folderId: 'f:Structure' });
    expect(draft.name).toBe('Column spread footings');
    expect(document.querySelector('[data-testid=snippet-builder]')).toBeNull();
  });
});

describe('the hint shown while dragging', () => {
  it('names where the work lands and what each drop area does', () => {
    const task = (id: number) => project.taskStore.getById(id) as TaskModel;
    expect(describePlace(placementFor(task(411), 'after'))).toBe('After “Hang, tape & finish drywall partitions”');
    expect(describePlace(placementFor(task(410), 'after'))).toBe('After all of “Partitions & ceilings”');
    expect(describePlace(placementFor(task(410), 'inside'))).toBe('At the end of “Partitions & ceilings”');
    expect(describePlace(placementFor(task(411), 'before'))).toBe('At the start of “Partitions & ceilings”, before “Hang, tape & finish drywall partitions”');
    expect(describePlace(placementFor(task(413), 'before'))).toBe('After “X-ray room lead lining & shielded door”');
    expect(describeEffect(placementFor(task(411), 'after'), 'push')).toBe('3 later tasks wait for it and move later');
    expect(describeEffect(placementFor(task(411), 'before'), 'push')).toBe('“Hang, tape & finish drywall partitions” and the work after it move later');
    expect(describeEffect(placementFor(task(411), 'after'), 'fit')).toBe('Starts after “Hang, tape & finish drywall partitions”; nothing else moves');
    expect(describeEffect(placementFor(task(411), 'after'), 'alongside')).toBe('Starts when “Hang, tape & finish drywall partitions” starts');
    expect(describeEffect(placementFor(task(411), 'after'), 'unlinked')).toBe('Pinned to when “Hang, tape & finish drywall partitions” finishes, with no links');
  });

  it('splits a row into zones: halves of a task row, top / middle / bottom of a group row', () => {
    expect([zoneFor(0.2, true, false), zoneFor(0.7, true, false)]).toEqual(['before', 'after']);
    expect([zoneFor(0.1, false, true), zoneFor(0.5, false, true), zoneFor(0.9, false, true), zoneFor(0.9, false, false)]).toEqual([
      'before',
      'inside',
      'first-child',
      'after',
    ]);
  });
});
