/**
 * A snippet in a real Bryntum project (the builder's Gantt): every starter snippet loads, the
 * scheduling engine lays it out on working days exactly as the snippet's own layout says (links,
 * lags, leads, finish-to-finish), and it reads back unchanged; tasks added in the Gantt get keys from
 * their names and keep them.
 */
import { ProjectModel, type TaskModel } from '@bryntum/gantt';
import { describe, expect, it } from 'vitest';
import { scheduleSnippet, type Snippet } from '@collab/shared';
import { STARTER_SNIPPETS } from '@collab/shared/library-starter';
import { ANCHOR, SnippetTaskModel, dateOfWorkingDay, projectDataOf, snippetBodyOf, workingDayIndex } from '../../src/library/snippet-project';

const crews = [
  { name: 'Site crew', color: '#a16207' },
  { name: 'Carpenters', color: '#7c2d12' },
];

async function load(snippet: Pick<Snippet, 'children' | 'links'>): Promise<ProjectModel> {
  const data = projectDataOf(snippet, crews);
  const project = new ProjectModel({ ...data.project, calendars: data.calendars, taskModelClass: SnippetTaskModel } as never);
  await project.loadInlineData({ tasksData: data.tasks, dependenciesData: data.dependencies, resourcesData: data.resources, assignmentsData: data.assignments } as never);
  await project.commitAsync();
  return project;
}

describe('working days from the anchor', () => {
  it('counts Monday to Friday only', () => {
    expect(ANCHOR.getDay()).toBe(1);
    expect(workingDayIndex(ANCHOR)).toBe(0);
    expect(workingDayIndex(dateOfWorkingDay(4))).toBe(4);
    expect(dateOfWorkingDay(5).getDay()).toBe(1);
    expect(workingDayIndex(dateOfWorkingDay(12))).toBe(12);
  });
});

describe('a snippet in the builder’s Gantt', () => {
  it.each(STARTER_SNIPPETS.map((snippet) => [snippet.name, snippet] as const))('%s: the engine lays it out like the snippet and it reads back unchanged', async (_name, snippet) => {
    const project = await load(snippet);
    const layout = scheduleSnippet(snippet);
    for (const task of project.taskStore.allRecords as TaskModel[]) {
      if (!task.isLeaf) continue;
      expect({ key: task.id, start: workingDayIndex(task.startDate as Date) }).toEqual({ key: task.id, start: layout.tasks.get(String(task.id))!.start });
    }
    const back = snippetBodyOf(project, new Map());
    expect(back.children).toEqual(snippet.children);
    expect(back.links).toEqual(snippet.links.map((link) => ({ from: link.from, to: link.to, ...(link.type && link.type !== 'FS' ? { type: link.type } : {}), ...(link.lag ? { lag: link.lag } : {}) })));
    project.destroy();
  });

  it('keeps each task\'s costs through the Gantt, and reads a changed line back', async () => {
    const costed: Pick<Snippet, 'children' | 'links'> = {
      children: [
        { key: 'order', name: 'Order light fixtures', duration: 1, costs: [{ label: 'LED panels, 48', payee: 'Lumen & Co Lighting', amount: 18_400, due: 'on_order' }] },
        { key: 'install', name: 'Install light fixtures', duration: 4, crews: [{ name: 'Carpenters' }] },
      ],
      links: [{ from: 'order', to: 'install' }],
    };
    const project = await load(costed);
    expect(snippetBodyOf(project, new Map()).children).toEqual(costed.children);
    const install = project.taskStore.getById('install') as SnippetTaskModel;
    install.set('costs', [{ label: 'Labor', payee: 'Halden Electrical', amount: 6_200, due: 'on_completion' }, { label: 'not a cost' }]);
    // A malformed line is left out; a group carries no costs.
    expect(snippetBodyOf(project, new Map()).children[1]).toEqual({ key: 'install', name: 'Install light fixtures', duration: 4, crews: [{ name: 'Carpenters' }], costs: [{ label: 'Labor', payee: 'Halden Electrical', amount: 6_200, due: 'on_completion' }] });
    project.destroy();
  });

  it('gives tasks added in the Gantt keys from their names, and keeps them', async () => {
    const snippet = STARTER_SNIPPETS.find((candidate) => candidate.starterKey === 'pad-foundation')!;
    const project = await load(snippet);
    const group = project.taskStore.getById('concrete') as TaskModel;
    const added = (group as unknown as { appendChild(data: object): TaskModel }).appendChild({ name: 'Strip formwork', duration: 1, durationUnit: 'day' });
    await project.commitAsync();
    const keys = new Map<unknown, string>();
    const first = snippetBodyOf(project, keys);
    const strip = first.children[1]!.children!.at(-1)!;
    expect(strip).toEqual({ key: 'strip-formwork', name: 'Strip formwork', duration: 1 });
    added.set('name', 'Strip the formwork');
    expect(snippetBodyOf(project, keys).children[1]!.children!.at(-1)!.key).toBe('strip-formwork');
    project.destroy();
  });
});
