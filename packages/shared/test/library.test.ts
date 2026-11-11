/**
 * The library's shared model: the starter snippets are well-formed nested plans (one first task, one
 * last task, links between tasks, no loops, mostly the project's own crews), the layout follows all
 * four link types and leads, the checks say what stops a save, the tweaks before a drop do what the
 * panel promises, and work saved from a plan keeps its own links only.
 */
import { describe, expect, it } from 'vitest';
import {
  SCALE_CHOICES,
  SnippetDraft,
  checkSnippet,
  isFlatSnippet,
  defaultTweaks,
  entryKeys,
  exitKeys,
  freshKey,
  leavesOf,
  allTasksOf,
  outlineNumbers,
  planSnippet,
  scaleDuration,
  scaleLag,
  scheduleSnippet,
  snippetFromOutline,
  snippetFromRow,
  snippetSpan,
  snippetWithout,
  rowFieldsOf,
  type Snippet,
  type SnippetTask,
} from '../src/library';
import { STARTER_FOLDERS, STARTER_SNIPPETS, starterSnippet, type StarterFolder } from '../src/library-starter';
import { riversideClinic } from '../src/seed';

const depth = (tasks: readonly SnippetTask[]): number => Math.max(0, ...tasks.map((task) => 1 + depth(task.children ?? [])));
// Snippets name crews by trade; a drop matches a crew by its name or its trade.
const projectCrews = riversideClinic.inlineData.resourcesData.flatMap((resource) => [resource.name, resource.trade]);
const asSnippet = (key: string): Snippet => {
  const { starterKey, ...draft } = starterSnippet(key)!;
  return { id: starterKey, ...draft };
};

describe('the starter library', () => {
  it('files every starter snippet exactly once, in nested folders', () => {
    const filed = (folders: readonly StarterFolder[]): string[] => folders.flatMap((folder) => [...folder.snippets, ...filed(folder.folders ?? [])]);
    expect(filed(STARTER_FOLDERS).sort()).toEqual(STARTER_SNIPPETS.map((snippet) => snippet.starterKey).sort());
    expect(STARTER_FOLDERS.some((folder) => (folder.folders?.length ?? 0) > 0)).toBe(true);
    expect(new Set(STARTER_SNIPPETS.map((snippet) => snippet.starterKey)).size).toBe(STARTER_SNIPPETS.length);
  });

  it.each(STARTER_SNIPPETS.map((snippet) => [snippet.name, snippet] as const))('%s is a well-formed nested plan', (_name, snippet) => {
    expect(SnippetDraft.safeParse(snippet).success).toBe(true);
    expect(checkSnippet(snippet, projectCrews).filter((problem) => problem.level === 'error')).toEqual([]);
    const tasks = allTasksOf(snippet.children);
    // Top task > groups > tasks: two or three levels under the top task's own row.
    expect(depth(snippet.children) + 1).toBeGreaterThanOrEqual(2);
    expect(depth(snippet.children) + 1).toBeLessThanOrEqual(3);
    for (const group of tasks.filter((task) => task.children?.length)) {
      expect(group.duration, `${group.key} takes its dates from its tasks`).toBeUndefined();
      expect(group.crews, `${group.key} has no crew of its own`).toBeUndefined();
    }
    expect(entryKeys(snippet), 'one first task').toHaveLength(1);
    expect(exitKeys(snippet), 'one last task').toHaveLength(1);
    // Every task is reachable from the first one, so the whole piece follows the work it is dropped after.
    const reached = new Set(entryKeys(snippet));
    for (let grew = true; grew; ) {
      grew = false;
      for (const link of snippet.links) {
        if (reached.has(link.from) && !reached.has(link.to)) {
          reached.add(link.to);
          grew = true;
        }
      }
    }
    expect(leavesOf(snippet.children).filter((leaf) => !reached.has(leaf.key))).toEqual([]);
    expect(snippetSpan(snippet)).toBeGreaterThan(0);
  });

  it('shows every kind of link, a lead, part-time crews and time ranges, with mostly the project’s crews', () => {
    const links = STARTER_SNIPPETS.flatMap((snippet) => snippet.links);
    expect(new Set(links.map((link) => link.type ?? 'FS'))).toEqual(new Set(['FS', 'SS', 'FF']));
    expect(links.some((link) => (link.lag ?? 0) < 0)).toBe(true);
    const crews = STARTER_SNIPPETS.flatMap((snippet) => leavesOf(snippet.children).flatMap((task) => task.crews ?? []));
    expect(crews.some((crew) => crew.units !== undefined && crew.units < 100)).toBe(true);
    expect(crews.filter((crew) => projectCrews.includes(crew.name)).length / crews.length).toBeGreaterThan(0.9);
    expect(STARTER_SNIPPETS.filter((snippet) => snippet.timeRanges?.length).length).toBeGreaterThanOrEqual(2);
  });
});

describe('laying a snippet out in working days', () => {
  it('follows finish-to-start and start-to-start links with their lags', () => {
    const room = asSnippet('consulting-room');
    // layout 1, studs 2, (rough-in from day 2 to 5), board 2, ceiling 1, trim-out 1, decorate 2, floor 1, snag 1
    expect(snippetSpan(room)).toBe(1 + 3 + 2 + 1 + 1 + 2 + 1 + 1);
    const schedule = scheduleSnippet(room);
    expect(schedule.tasks.get('elec1')).toMatchObject({ start: 2, finish: 4 });
    expect(schedule.tasks.get('walls')).toMatchObject({ start: 0, finish: 4 });
  });

  it('pulls a task earlier for a lead, finishes tasks together for FF, and reports float', () => {
    const pad = scheduleSnippet(asSnippet('pad-foundation'));
    // excavate 0-2, inspect 2-3, blinding 3-4, rebar 5-7 (one day lag), pour 7-8, cure 8-15, backfill 13-14 (two days' lead)
    expect(pad.tasks.get('rebar')).toMatchObject({ start: 5, finish: 7 });
    expect(pad.tasks.get('backfill')).toMatchObject({ start: 13, finish: 14 });
    expect(pad.span).toBe(15);
    expect(pad.tasks.get('cure')).toMatchObject({ critical: true, float: 0 });
    expect(pad.tasks.get('backfill')).toMatchObject({ critical: false, float: 1 });

    const floor = scheduleSnippet(asSnippet('floor-topping-and-floor'));
    // lay 0-1, dry 1-11, moisture 11-12, vinyl 12-15; decorate starts 2 days after the lay, must finish with the vinyl
    expect(floor.tasks.get('vinyl')).toMatchObject({ start: 12, finish: 15 });
    expect(floor.tasks.get('decorate')).toMatchObject({ start: 11, finish: 15 });
  });

  it('handles a start-to-finish link and never starts before day 0', () => {
    const body = {
      children: [
        { key: 'a', name: 'A', duration: 3 },
        { key: 'b', name: 'B', duration: 2 },
        { key: 'c', name: 'C', duration: 1 },
      ],
      links: [
        { from: 'a', to: 'b', type: 'SF' as const, lag: 4 },
        { from: 'a', to: 'c', type: 'SS' as const, lag: -5 },
      ],
    };
    const schedule = scheduleSnippet(body);
    expect(schedule.tasks.get('b')).toMatchObject({ start: 2, finish: 4 });
    expect(schedule.tasks.get('c')).toMatchObject({ start: 0 });
  });

  it('reports a loop instead of hanging', () => {
    const body = {
      children: [
        { key: 'a', name: 'A', duration: 1 },
        { key: 'b', name: 'B', duration: 1 },
      ],
      links: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'a' },
      ],
    };
    expect(scheduleSnippet(body).loop.sort()).toEqual(['a', 'b']);
    expect(checkSnippet({ name: 'Loop', ...body }).map((problem) => problem.message)).toContain('These tasks wait for each other in a loop: A, B.');
  });
});

describe('checking a snippet before it is saved', () => {
  it('names what is wrong in plain words', () => {
    const problems = checkSnippet(
      {
        name: ' ',
        children: [
          { key: 'g', name: 'Group', children: [{ key: 'a', name: 'A', duration: 1 }] },
          { key: 'a', name: 'Again', duration: 1 },
          { key: 'b', name: 'B' },
        ],
        links: [{ from: 'g', to: 'b' }],
        timeRanges: [{ key: 'r', name: 'Band', from: { task: 'zz', edge: 'start' }, to: { task: 'a', edge: 'end' } }],
      },
      ['Carpenters'],
    );
    expect(problems.filter((problem) => problem.level === 'error').map((problem) => problem.message)).toEqual([
      'Give the snippet a name.',
      'Two rows share the key “a”.',
      '“B” needs a whole number of working days.',
      'A link points at “Group”, which is not a task of this snippet (links join tasks, not groups).',
      'The time range “Band” is tied to a row that is no longer in the snippet.',
    ]);
  });

  it('warns about crews the project does not have and leads longer than the task before', () => {
    const problems = checkSnippet(
      { name: 'X', children: [{ key: 'a', name: 'A', duration: 1, crews: [{ name: 'Tilers' }] }, { key: 'b', name: 'B', duration: 2 }], links: [{ from: 'a', to: 'b', lag: -3 }] },
      projectCrews,
    );
    expect(problems.map((problem) => `${problem.level}: ${problem.message}`)).toEqual([
      'warning: The lead on “B” is longer than “A” itself.',
      'warning: Not on this project yet: Tilers. Those tasks are added without that crew.',
    ]);
  });
});

describe('tweaking a snippet before the drop', () => {
  const room = asSnippet('consulting-room');

  it('keeps the snippet as listed by default', () => {
    const plan = planSnippet(room, defaultTweaks(room));
    expect(plan.copies.map((copy) => copy.name)).toEqual(['Exam room build-out']);
    expect(plan.taskCount).toBe(1 + allTasksOf(room.children).length);
    expect(plan.links).toHaveLength(room.links.length);
    expect(plan.entryKeys).toEqual(['0/setout']);
    expect(plan.exitLeafKeys).toEqual(['0/snag']);
    expect(plan.exitKey).toBe('0/');
    expect(plan.crews).toEqual(['General contractor', 'Carpentry', 'Electrical', 'Plumbing', 'Painting']);
  });

  it('renames the top task, numbers repeats and chains them one after another, time ranges included', () => {
    const plan = planSnippet(room, { name: '  Treatment room build-out ', scale: 1, repeats: 3 });
    expect(plan.copies.map((copy) => copy.name)).toEqual(['Treatment room build-out – room 1', 'Treatment room build-out – room 2', 'Treatment room build-out – room 3']);
    expect(plan.links.filter((link) => link.from === '0/' || link.from === '1/')).toEqual([
      { from: '0/', to: '1/setout', type: 'FS', lag: 0 },
      { from: '1/', to: '2/setout', type: 'FS', lag: 0 },
    ]);
    expect(plan.exitKey).toBe('2/');
    expect(plan.span).toBe(3 * snippetSpan(room));

    const xray = planSnippet(asSnippet('xray-room'), { name: 'X-ray', scale: 1, repeats: 2 });
    expect(xray.timeRanges.map((range) => `${range.name}: ${range.from.task} ${range.from.edge} -> ${range.to.task} ${range.to.edge}`)).toEqual([
      'X-ray room closed to other trades – room 1: 0/boards start -> 0/exam end',
      'X-ray room closed to other trades – room 2: 1/boards start -> 1/exam end',
    ]);
  });

  it('scales durations and lags to whole working days, milestones staying milestones', () => {
    expect(scaleDuration(3, 0.5)).toBe(2);
    expect(scaleDuration(1, 0.5)).toBe(1);
    expect(scaleDuration(0, 2)).toBe(0);
    expect(scaleDuration(5, 1.5)).toBe(8);
    expect(scaleLag(-2, 2)).toBe(-4);
    expect(scaleLag(1, 0.5)).toBe(1);
    expect(scaleLag(0, 2)).toBe(0);
    expect(SCALE_CHOICES.map((choice) => choice.value)).toContain(1);
    const plan = planSnippet(room, { name: room.name, scale: 2, repeats: 1 });
    expect(plan.copies[0]!.children[0]!.children[1]).toMatchObject({ name: 'Metal stud walls & door frames', duration: 4 });
    expect(plan.links.find((link) => link.to === '0/elec1')).toMatchObject({ type: 'SS', lag: 2 });
    expect(planSnippet(room, { name: '', scale: 1, repeats: 99 }).copies).toHaveLength(8);
  });
});

describe('outline numbers, keys and rows', () => {
  it('numbers the outline and makes fresh keys from names', () => {
    const room = asSnippet('consulting-room');
    const numbers = outlineNumbers(room.children);
    expect(numbers.get('walls')).toBe('1');
    expect(numbers.get('plumb1')).toBe('1.4');
    expect(numbers.get('snag')).toBe('4');
    expect(freshKey(room.children, 'Hang, tape & finish!')).toBe('hang-tape-finish');
    expect(freshKey(room.children, 'Studs')).toBe('studs-2');
    expect(freshKey([], '***')).toBe('task');
  });

  it('round-trips a snippet through a library row', () => {
    const room = asSnippet('consulting-room');
    const fields = rowFieldsOf(room);
    const row = {
      id: '00000000-0000-4000-8000-000000000001',
      project_id: '00000000-0000-4000-8000-000000000002',
      folder_id: null,
      position: 1,
      origin: 'starter' as const,
      created_by: null,
      updated_by: null,
      created_at: '2026-10-24T00:00:00Z',
      updated_at: '2026-10-24T00:00:00Z',
      ...fields,
    };
    expect(snippetFromRow(row)).toEqual({ ...room, id: row.id });
    expect(snippetFromRow({ ...row, body: { children: [] } })).toBeNull();
  });
});

describe('saving work from the plan as a snippet', () => {
  it('keeps the group’s own tasks, crews and inside links, and drops links to outside work', () => {
    const draft = snippetFromOutline(
      {
        id: 10,
        name: 'Room 1 build-out',
        days: 0,
        crews: [],
        children: [
          { id: 11, name: 'Stud walls', days: 2, crews: [{ name: 'Carpenters' }], children: [] },
          { id: 12, name: 'Board walls', days: 3, crews: [{ name: 'Carpenters', units: 50 }], note: 'Two layers', children: [] },
          { id: 13, name: 'Room ready', days: 0, crews: [], children: [] },
        ],
      },
      [
        { from: 11, to: 12, type: 'FS', lag: 0 },
        { from: 11, to: 13, type: 'SS', lag: -1 },
        { from: 99, to: 11, type: 'FS', lag: 0 },
      ],
      [{ name: 'Dust', from: { id: 11, edge: 'start' }, to: { id: 12, edge: 'end' }, tone: 'slate' }],
    );
    expect(draft).toEqual({
      name: 'Room 1 build-out',
      summary: '3 tasks saved from the plan.',
      icon: 'cubes',
      unit: { one: 'copy', many: 'copies' },
      children: [
        { key: 'stud-walls', name: 'Stud walls', duration: 2, crews: [{ name: 'Carpenters' }] },
        { key: 'board-walls', name: 'Board walls', duration: 3, crews: [{ name: 'Carpenters', units: 50 }], note: 'Two layers' },
        { key: 'room-ready', name: 'Room ready', duration: 0 },
      ],
      links: [
        { from: 'stud-walls', to: 'board-walls' },
        { from: 'stud-walls', to: 'room-ready', type: 'SS', lag: -1 },
      ],
      timeRanges: [{ key: 'dust', name: 'Dust', from: { task: 'stud-walls', edge: 'start' }, to: { task: 'board-walls', edge: 'end' }, tone: 'slate' }],
    });
    expect(checkSnippet(draft).filter((problem) => problem.level === 'error')).toEqual([]);
  });
});

describe('a plain run of tasks', () => {
  const body = {
    name: 'Light fixtures',
    summary: 'Order, deliver, install and test.',
    icon: 'lightbulb',
    unit: { one: 'floor', many: 'floors' },
    children: [
      { key: 'order', name: 'Order', duration: 1 },
      { key: 'install', name: 'Install', duration: 3 },
      { key: 'test', name: 'Test', duration: 1 },
    ],
    links: [
      { from: 'order', to: 'install' },
      { from: 'install', to: 'test' },
    ],
  };
  const snippet = { ...body, id: 'light', origin: 'assistant' } as unknown as Snippet;

  it('goes in as rows of its own, each waiting for the one before', () => {
    expect(isFlatSnippet(body)).toBe(true);
    const plan = planSnippet(snippet, defaultTweaks(snippet));
    expect(plan.flat).toBe(true);
    expect(plan.copies.map((task) => task.name)).toEqual(['Order', 'Install', 'Test']);
    expect(plan.entryKeys).toEqual(['0/order']);
    expect(plan.exitKey).toBe('0/test');
    expect(plan.links.map((link) => `${link.from}>${link.to}`)).toEqual(['0/order>0/install', '0/install>0/test']);
    expect(plan.taskCount).toBe(3);
  });

  it('keeps its group row when it is not one line: an overlap, a gap, a group, or several copies', () => {
    expect(isFlatSnippet({ ...body, links: [{ from: 'order', to: 'install' }] })).toBe(false);
    expect(isFlatSnippet({ ...body, links: [{ from: 'order', to: 'install', type: 'SS' }, { from: 'install', to: 'test' }] })).toBe(false);
    expect(isFlatSnippet({ ...body, links: [{ from: 'order', to: 'install', lag: 2 }, { from: 'install', to: 'test' }] })).toBe(false);
    expect(isFlatSnippet({ ...body, children: [{ key: 'group', name: 'Group', children: body.children }], links: [] })).toBe(false);
    expect(planSnippet(snippet, { ...defaultTweaks(snippet), repeats: 2 }).flat).toBeUndefined();
  });
});

describe('a piece without some of its tasks', () => {
  const piece = {
    children: [
      { key: 'order', name: 'Order light fixtures', duration: 1 },
      { key: 'deliver', name: 'Deliver light fixtures', duration: 1 },
      { key: 'fit', name: 'Fit-out', children: [
        { key: 'install', name: 'Install light fixtures', duration: 4 },
        { key: 'test', name: 'Test light fixtures', duration: 1 },
      ] },
    ],
    links: [
      { from: 'order', to: 'deliver' },
      { from: 'deliver', to: 'install' },
      { from: 'install', to: 'test' },
    ],
    timeRanges: [
      { key: 'shipping', name: 'On the truck', from: { task: 'order', edge: 'end' as const }, to: { task: 'deliver', edge: 'end' as const } },
      { key: 'live', name: 'Circuits live', from: { task: 'install', edge: 'end' as const }, to: { task: 'test', edge: 'end' as const } },
    ],
  };

  it('drops the tasks named, however they are written, with their links and time ranges', () => {
    const rest = snippetWithout(piece, ['order light fixtures', 'Deliver  light fixtures']);
    expect(rest.children.map((task) => task.key)).toEqual(['fit']);
    expect(rest.links).toEqual([{ from: 'install', to: 'test' }]);
    expect(rest.timeRanges?.map((range) => range.key)).toEqual(['live']);
  });

  it('drops a group left empty', () => {
    const rest = snippetWithout(piece, ['Install light fixtures', 'Test light fixtures']);
    expect(rest.children.map((task) => task.key)).toEqual(['order', 'deliver']);
    expect(rest.links).toEqual([{ from: 'order', to: 'deliver' }]);
  });
});
