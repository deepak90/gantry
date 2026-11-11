/**
 * The crews tab in jsdom over the seed project: a row per crew (its firm, its trade as a label, its
 * tasks), search by firm or trade, the crews/equipment and trade filters, the + that puts a crew on
 * the selected task, editing, and removing a crew after the "remove from N tasks?" question. Every
 * change is one STM transaction.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectModel, ResourceModel, TaskModel } from '@bryntum/gantt';
import { riversideClinic, riversideClinicRecords } from '@collab/shared/seed';
import { CREW_PALETTE, CrewsPanel, weeklyLoad, type CrewsPanelProps } from '../../src/inspector/CrewsPanel';
import { createProjectModel, loadCollaborativeProject } from '../../src/gantt/project';
import { crewOf } from '../../src/gantt/look';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { tasks, assignments, resources } = riversideClinicRecords;
const ELECTRICIANS = resources.find((resource) => resource.trade === 'Electrical')!.id;
const isLeaf = (id: number) => !tasks.some((task) => task.parentId === id);
const FREE_TASK = tasks.find(
  (task) => isLeaf(task.id) && (task.duration ?? 0) > 0 && !assignments.some((assignment) => assignment.event === task.id && assignment.resource === ELECTRICIANS),
)!.id;
const electricianTasks = assignments.filter((assignment) => assignment.resource === ELECTRICIANS).length;

/**
 * Lets a click's transaction finish: one macrotask for React's handler to queue it, then a step
 * queued behind it on the project (transactions run in the project queue, in order).
 */
const settleProject = async (project: ProjectModel) => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await (project as unknown as { queue(step: () => unknown): Promise<unknown> }).queue(() => undefined);
  await project.commitAsync();
};

describe('CrewsPanel', () => {
  let host: HTMLDivElement;
  let root: Root;
  let project: ProjectModel;
  let transactions: string[];

  const render = async (props: Partial<CrewsPanelProps> = {}) => {
    await act(async () => {
      root.render(<CrewsPanel project={project} gantt={() => undefined} onShowTasks={() => undefined} {...props} />);
    });
  };
  const cards = () => [...host.querySelectorAll<HTMLElement>('[data-testid=crew-row]')];
  const card = (name: string) => cards().find((element) => element.querySelector('.crew-row-name')?.textContent === name)!;
  const names = () => cards().map((element) => element.querySelector('.crew-row-name')?.textContent);
  const search = async (text: string) => {
    const input = host.querySelector<HTMLInputElement>('.crews-search input')!;
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setValue.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  const click = async (element: Element | null | undefined) => {
    expect(element).toBeTruthy();
    await act(async () => {
      (element as HTMLElement).click();
      await settleProject(project);
    });
  };

  beforeEach(async () => {
    project = createProjectModel();
    // As in the app: loaded with recording (STM) on, so each change is its own transaction.
    await loadCollaborativeProject(project, structuredClone(riversideClinic.inlineData), 'crews-test');
    transactions = [];
    project.stm.on('recordingStop', ({ transaction }: { transaction: { title?: string } }) => transactions.push(transaction.title ?? ''));
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    project.destroy();
  });

  it('shows every crew as a row: its firm, its trade as a label, its tasks; equipment apart, with its supplier', async () => {
    await render();
    expect(cards()).toHaveLength(resources.length);
    expect([...host.querySelectorAll('.crews-group-label')].map((label) => label.textContent)).toEqual([`Crews ${resources.length - 2}`, 'Equipment 2']);
    const halden = card('Halden Electrical');
    expect(halden.dataset.crewId).toBe(String(ELECTRICIANS));
    expect(halden.querySelector('.crew-logo img')?.getAttribute('src')).toBe('/crews/electricians.png');
    expect(halden.querySelector('.crew-trade')?.textContent).toBe('Electrical');
    expect(halden.querySelector('.crew-row-tasks')?.textContent).toBe(`${electricianTasks} tasks`);
    expect(halden.querySelector('.crew-row-dates')?.textContent).toMatch(/^[A-Z][a-z]{2} \d+ – [A-Z][a-z]{2} \d+$/);
    const crane = card('Crane');
    expect(crane.querySelector('.crew-trade')?.textContent).toBe('Equipment rental');
    expect(crane.querySelector('.crew-row-company')?.textContent).toBe('Northgate Equipment Rental');
  });

  it('finds crews by firm or trade, and filters crews from equipment and by trade', async () => {
    await render();
    await search('halden');
    expect(names()).toEqual(['Halden Electrical']);
    await search('hvac');
    expect(names()).toEqual(['Northwind Air Systems']);
    await search('');
    await click([...host.querySelectorAll('.crews-filter button')].find((button) => button.textContent?.startsWith('Equipment')));
    expect(names()).toEqual(['Crane', 'Concrete pump']);
    await click([...host.querySelectorAll('.crews-filter button')].find((button) => button.textContent?.startsWith('All')));
    await click([...host.querySelectorAll('.crews-trades button')].find((button) => button.textContent?.startsWith('Equipment rental')));
    expect(names()).toEqual(['Crane', 'Concrete pump']);
    expect(host.querySelector('.crews-trades button[aria-pressed=true]')?.textContent).toBe('Equipment rental2');
  });

  it('puts a crew on the selected task with the + on its row, in one transaction', async () => {
    await render({ selectedTaskId: FREE_TASK });
    const put = card('Halden Electrical').querySelector<HTMLButtonElement>('.crew-put');
    expect(put?.getAttribute('aria-label')).toBe(`Put Halden Electrical on ${(project.taskStore.getById(FREE_TASK) as TaskModel).name}`);
    await click(put);
    expect(crewOf(project.taskStore.getById(FREE_TASK) as TaskModel).map((resource) => resource.id)).toContain(ELECTRICIANS);
    expect(transactions).toEqual(['Assign crew']);
    // Now on the task, the + is gone.
    expect(card('Halden Electrical').querySelector('.crew-put')).toBeNull();
  });

  it('edits a crew: renames the firm (and its company), sets the trade, recolors, switches to equipment', async () => {
    await render();
    await click(card('Halden Electrical').querySelector('[aria-label="Edit Halden Electrical"]'));
    const [name, trade] = card('Halden Electrical').querySelectorAll<HTMLInputElement>('.crew-editor input');
    await act(async () => {
      name!.value = 'Halden Electrical Services';
      name!.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      await settleProject(project);
    });
    const crew = project.resourceStore.getById(ELECTRICIANS) as ResourceModel & { kind: string; company: string; trade: string };
    expect([crew.name, crew.company]).toEqual(['Halden Electrical Services', 'Halden Electrical Services']);
    await act(async () => {
      trade!.value = 'Electrical & lighting';
      trade!.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      await settleProject(project);
    });
    expect(crew.trade).toBe('Electrical & lighting');
    // A color no crew of the seed uses.
    await click(card('Halden Electrical Services').querySelector(`.crew-swatches [aria-label="${CREW_PALETTE[12]}"]`));
    expect(crew.eventColor).toBe(CREW_PALETTE[12]);
    await click([...card('Halden Electrical Services').querySelectorAll('.crew-kind button')].find((button) => button.textContent === 'Equipment'));
    expect(crew.kind).toBe('equipment');
    expect(transactions).toEqual(['Edit crew', 'Edit crew', 'Edit crew', 'Edit crew']);
    // It stays where it is while its editor is open, and joins the equipment once it closes.
    const groupOf = (name: string) => card(name).closest('.crews-group')!.getAttribute('aria-label');
    expect(groupOf('Halden Electrical Services')).toBe('Crews');
    expect(card('Halden Electrical Services').querySelector('.crew-editor')).not.toBeNull();
    await click(card('Halden Electrical Services').querySelector('[aria-label="Edit Halden Electrical Services"]'));
    expect(groupOf('Halden Electrical Services')).toBe('Equipment');
  });

  it('asks before removing a crew from its tasks, then removes it and its assignments together', async () => {
    await render();
    await click(card('Halden Electrical').querySelector('[aria-label="Edit Halden Electrical"]'));
    await click(card('Halden Electrical').querySelector('.crew-remove'));
    expect(card('Halden Electrical').querySelector('.crew-confirm span')?.textContent).toBe(`Remove Halden Electrical from ${electricianTasks} tasks?`);
    await click(card('Halden Electrical').querySelector('.crew-confirm .button.is-danger'));
    expect(project.resourceStore.getById(ELECTRICIANS)).toBeFalsy();
    expect(project.assignmentStore.allRecords.some((assignment) => (assignment as { resourceId?: unknown }).resourceId === ELECTRICIANS)).toBe(false);
    expect(cards()).toHaveLength(resources.length - 1);
    expect(transactions).toEqual(['Remove crew']);
  });

  it('adds a crew in an unused color and opens it for editing', async () => {
    await render();
    await click(host.querySelector('[data-testid=add-crew]'));
    expect(cards()).toHaveLength(resources.length + 1);
    const added = card('New crew');
    expect(added.classList.contains('is-editing')).toBe(true);
    const used = new Set(resources.map((resource) => resource.eventColor));
    expect(used.has(added.style.getPropertyValue('--crew'))).toBe(false);
    expect(transactions).toEqual(['Add crew']);
  });
});

describe('weeklyLoad', () => {
  const day = (iso: string) => new Date(`${iso}T00:00:00`);
  const task = (start: string, end: string) => ({ startDate: day(start), endDate: day(end) }) as unknown as TaskModel;

  it('counts weekdays with work per week and flags days with two tasks', () => {
    // Mon, Nov 2 to Fri, Nov 20, 2026: three weeks.
    const load = weeklyLoad([task('2026-11-02', '2026-11-05'), task('2026-11-04', '2026-11-07'), task('2026-11-16', '2026-11-17')], day('2026-11-02'), day('2026-11-20'));
    expect(load.map((week) => [week.days, week.clash])).toEqual([
      [5, true],
      [0, false],
      [1, false],
    ]);
  });

  it('counts only the working pieces of a split task', () => {
    const split = {
      startDate: day('2026-11-02'),
      endDate: day('2026-11-13'),
      segments: [
        { startDate: day('2026-11-02'), endDate: day('2026-11-03') },
        { startDate: day('2026-11-12'), endDate: day('2026-11-13') },
      ],
    } as unknown as TaskModel;
    expect(weeklyLoad([split], day('2026-11-02'), day('2026-11-13')).map((week) => week.days)).toEqual([1, 1]);
  });
});
