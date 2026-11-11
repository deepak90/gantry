/**
 * The task panel in jsdom over a small headless project: the Scheduling tab shows Bryntum's
 * advanced fields under their scheduling terms, the constraint date is off for the types without
 * a date and on (with the task's start) for the dated ones, switches save, a phase is offered only
 * what applies to a summary task, and the Links tab offers all four dependency types with a lag and
 * an Active switch. Every change is one STM transaction.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectModel } from '@bryntum/gantt';
import type { ProjectInlineData } from '@collab/shared';
import { createProjectModel, loadCollaborativeProject } from '../../src/gantt/project';
import { TaskInspector } from '../../src/inspector/TaskInspector';
import { runProjectTransaction } from '../../src/scenario/publish';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
if (!('fonts' in document)) {
  Object.defineProperty(document, 'fonts', { configurable: true, value: { ready: Promise.resolve(), addEventListener() {}, removeEventListener() {} } });
}

const DATA: ProjectInlineData = {
  project: { calendar: 'standard', startDate: '2026-11-02', hoursPerDay: 24, daysPerWeek: 5, daysPerMonth: 20 },
  calendarsData: [
    { id: 'standard', name: 'Standard (Mon-Fri)', unspecifiedTimeIsWorking: true, intervals: [{ recurrentStartDate: 'on Sat', recurrentEndDate: 'on Mon', isWorking: false }] },
    { id: 'site', name: 'Site (Mon-Sat)', unspecifiedTimeIsWorking: true, intervals: [{ recurrentStartDate: 'on Sun', recurrentEndDate: 'on Mon', isWorking: false }] },
  ],
  tasksData: [
    {
      id: 10,
      name: 'Frame',
      expanded: true,
      children: [
        { id: 1, name: 'Deliver steel', startDate: '2026-11-02', duration: 3, durationUnit: 'day' },
        { id: 2, name: 'Erect steel frame', startDate: '2026-11-05', duration: 2, durationUnit: 'day' },
      ],
    },
  ],
  dependenciesData: [{ id: 1, fromEvent: 1, toEvent: 2, type: 2, lag: 0, lagUnit: 'day' }],
  resourcesData: [{ id: 1, name: 'Steel erectors', kind: 'labor' }],
  assignmentsData: [{ id: 1, event: 2, resource: 1, units: 100 }],
} as ProjectInlineData;

/** Lets a change's transaction finish: React's handler queues it, then a step behind it on the project queue. */
async function settleProject(project: ProjectModel): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await (project as unknown as { queue(step: () => unknown): Promise<unknown> }).queue(() => undefined);
  await project.commitAsync();
}

describe('TaskInspector', () => {
  let host: HTMLDivElement;
  let root: Root;
  let project: ProjectModel;
  let transactions: string[];
  let version = 0;

  const render = async (taskId: number) => {
    version += 1;
    await act(async () => {
      root.render(<TaskInspector project={project} taskId={taskId} dataVersion={version} canViewCosts={false} />);
    });
  };
  const byTestId = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const field = (id: string) => byTestId(id)!.querySelector('input') as HTMLInputElement;
  const task = (id: number) => project.taskStore.getById(id) as unknown as Record<string, unknown>;

  /** Picks an option of a plain select the way a person does, then lets the edit land and the panel re-read. */
  const choose = async (select: HTMLSelectElement, value: string, taskId: number) => {
    await act(async () => {
      select.value = value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await settleProject(project);
    });
    await render(taskId);
  };
  const click = async (element: HTMLElement, taskId: number) => {
    await act(async () => {
      element.click();
      await settleProject(project);
    });
    await render(taskId);
  };

  beforeEach(async () => {
    project = createProjectModel();
    await loadCollaborativeProject(project, structuredClone(DATA), 'panel-test');
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

  it('shows who is paid for a task from a library piece: each line, its payee and when, and whether it is due', async () => {
    const install = project.taskStore.getById(2) as unknown as { set(field: string, value: unknown): void };
    await runProjectTransaction(project, 'Cost lines', () => {
      install.set('costLines', [
        { label: 'Installation labor', payee: 'Halden Electrical', amount_minor: 620_000, due: 'on_completion', paid_ref: null },
        { label: 'Fasteners', payee: 'Lumen & Co Lighting', amount_minor: 45_000, due: 'on_delivery', paid_ref: 'PAYOUT-1' },
        { label: 'not a cost line' },
      ]);
      install.set('percentDone', 100);
    });
    version += 1;
    await act(async () => {
      root.render(<TaskInspector project={project} taskId={2} dataVersion={version} canViewCosts />);
    });
    await click(byTestId('task-tab-money')!, 2);
    version += 1;
    await act(async () => {
      root.render(<TaskInspector project={project} taskId={2} dataVersion={version} canViewCosts />);
    });
    const section = byTestId('task-cost-lines')!;
    const lines = [...section.querySelectorAll('.cs-line')].map((line) => line.textContent);
    expect(lines).toEqual(['Installation laborHalden Electrical · on completion$6,200.00Due now', 'FastenersLumen & Co Lighting · on delivery$450.00Paid']);
    expect(section.textContent).toContain('$6,650.00');
  });

  describe('what the chart and the cells can do, from the panel', () => {
    /** With a machine on task 2, which the Crew tab no longer lists. */
    const withMachine = async () => {
      await runProjectTransaction(project, 'Add a machine', () => {
        project.resourceStore.add({ id: 2, name: 'Crane', kind: 'equipment', company: 'Northgate' } as never);
        project.assignmentStore.add({ id: 2, event: 2, resource: 2, units: 100, rentalStart: '2026-11-04', rentalEnd: '2026-11-10' } as never);
      });
    };

    it('keeps crews and machines apart, each with its own picker', async () => {
      await withMachine();
      await render(2);
      await click(byTestId('task-tab-crew')!, 2);
      expect(host.querySelectorAll('[data-testid="task-crew-row"]')).toHaveLength(1);
      expect(byTestId('task-crew-row')!.textContent).toContain('Steel erectors');
      await click(byTestId('task-tab-equipment')!, 2);
      expect(host.querySelectorAll('[data-testid="task-equipment-row"]')).toHaveLength(1);
      expect(byTestId('task-equipment-row')!.textContent).toContain('Crane');
      expect(byTestId('task-equipment-picker')).not.toBeNull();
    });

    it('shows a machine its own dates, what they come to and the days with no work planned', async () => {
      await withMachine();
      await render(2);
      await click(byTestId('task-tab-equipment')!, 2);
      expect(field('task-equipment-start').value).toContain('2026');
      // Nov 4 to Nov 9 is six days on rent, the weekend too, around work on Nov 5 and 6.
      expect(byTestId('task-equipment-facts')!.textContent).toContain('6 days');
      expect(byTestId('task-equipment-idle')!.textContent).toBe('4 days: 1 before, 3 after');
    });

    it('takes a machine off the task', async () => {
      await withMachine();
      await render(2);
      await click(byTestId('task-tab-equipment')!, 2);
      await click(byTestId('task-equipment-remove')!, 2);
      expect(byTestId('task-equipment-row')).toBeNull();
      expect(project.assignmentStore.getById(2)).toBeFalsy();
    });

    it('has effort in the Scheduling tab, and adds it up on a phase', async () => {
      await render(2);
      await click(byTestId('task-tab-scheduling')!, 2);
      expect(byTestId('task-effort-input')).not.toBeNull();
      await render(10);
      expect(byTestId('task-effort-input')).toBeNull();
      expect(byTestId('task-effort')!.textContent).toContain('Adds up');
    });

    it('offers to split a task with days to split, and lists the parts of one that is split', async () => {
      await render(1);
      await click(byTestId('task-tab-details')!, 1);
      await click(byTestId('task-split-open')!, 1);
      expect(byTestId('task-split-from')).not.toBeNull();
      await runProjectTransaction(project, 'Split', () => (project.taskStore.getById(1) as unknown as { splitToSegments(from: Date, lag: number): Promise<void> }).splitToSegments(new Date(2026, 10, 3), 1));
      await render(1);
      expect(host.querySelectorAll('[data-testid="task-part"]')).toHaveLength(2);
      expect(host.querySelectorAll('[data-testid="task-part-join"]')).toHaveLength(1);
    });

    it('moves and deletes a task from its menu, asking twice before deleting', async () => {
      await render(2);
      await click(byTestId('task-actions')!, 2);
      expect((byTestId('task-outdent') as HTMLButtonElement).disabled).toBe(false);
      await click(byTestId('task-delete')!, 2);
      expect(project.taskStore.getById(2)).toBeTruthy();
      expect(byTestId('task-delete')!.textContent).toContain('Click again');
      await click(byTestId('task-delete')!, 2);
      expect(project.taskStore.getById(2)).toBeFalsy();
      expect(byTestId('task-gone')).not.toBeNull();
    });

    it('does not offer to move a first task into a task above it', async () => {
      await render(10);
      await click(byTestId('task-actions')!, 10);
      expect((byTestId('task-indent') as HTMLButtonElement).disabled).toBe(true);
      expect((byTestId('task-outdent') as HTMLButtonElement).disabled).toBe(true);
    });
  });

  it('keeps the existing tabs and adds Scheduling', async () => {
    await render(2);
    expect(byTestId('task-name')).not.toBeNull();
    expect(byTestId('task-edit-status')).not.toBeNull();
    const tabs = [...host.querySelectorAll('[role=tab]')].map((tab) => tab.getAttribute('data-testid'));
    expect(tabs).toEqual(['task-tab-details', 'task-tab-scheduling', 'task-tab-links', 'task-tab-crew', 'task-tab-equipment', 'task-tab-notes']);
    expect(byTestId('task-details')).not.toBeNull();
    // Progress is one value, typed or dragged; effort is in the Scheduling tab.
    expect(byTestId('task-percent-done')).not.toBeNull();
    expect(byTestId('task-progress')).not.toBeNull();
    expect(byTestId('task-effort')).toBeNull();
    expect(byTestId('task-deadline')).not.toBeNull();
    expect(byTestId('task-color')).not.toBeNull();
  });

  it("shows Bryntum's advanced fields under their terms, the constraint date off for None", async () => {
    await render(2);
    await click(byTestId('task-tab-scheduling')!, 2);
    const scheduling = byTestId('task-scheduling')!;
    for (const id of [
      'task-manual',
      'task-scheduling-mode',
      'task-effort-driven',
      'task-inactive',
      'task-constraint-type',
      'task-constraint-date',
      'task-direction',
      'task-calendar',
      'task-ignore-resource-calendar',
      'task-project-border',
      'task-wbs',
      'task-rollup',
    ]) {
      expect(byTestId(id), id).not.toBeNull();
    }
    for (const term of ['Manually scheduled', 'Scheduling mode', 'Effort driven', 'Inactive', 'Constraint type', 'Constraint date', 'Scheduling direction', 'Calendar', 'Ignore resource calendar', 'Project border', 'Rollup', 'WBS code']) {
      expect(scheduling.textContent, term).toContain(term);
    }
    const types = [...(byTestId('task-constraint-type') as HTMLSelectElement).options].map((option) => option.text);
    expect(types).toEqual([
      'None',
      'As soon as possible',
      'As late as possible',
      'Must start on',
      'Must finish on',
      'Start no earlier than',
      'Start no later than',
      'Finish no earlier than',
      'Finish no later than',
    ]);
    expect([...(byTestId('task-scheduling-mode') as HTMLSelectElement).options].map((option) => option.text)).toEqual(['Normal', 'Fixed Duration', 'Fixed Effort', 'Fixed Units']);
    expect([...(byTestId('task-calendar') as HTMLSelectElement).options].map((option) => option.text)).toEqual(['Project calendar (Standard (Mon-Fri))', 'Site (Mon-Sat)', 'Standard (Mon-Fri)']);
    expect(byTestId('task-wbs')!.textContent).toContain('1.2');
    expect(byTestId('task-direction')!.textContent).toContain('Forward (as soon as possible), inherited from the project');
    expect(byTestId('task-constraint-date')!.classList).toContain('b-disabled');
  });

  it('keeps the constraint date off for As soon as possible, and turns it on with the start for Must start on', async () => {
    await render(2);
    await click(byTestId('task-tab-scheduling')!, 2);
    await choose(byTestId('task-constraint-type') as HTMLSelectElement, 'assoonaspossible', 2);
    expect(task(2).constraintType).toBe('assoonaspossible');
    expect(byTestId('task-constraint-date')!.classList).toContain('b-disabled');
    expect(field('task-constraint-date').disabled).toBe(true);
    expect(byTestId('task-constraint-hint')!.textContent).toContain('as early as its links allow');

    await choose(byTestId('task-constraint-type') as HTMLSelectElement, 'muststarton', 2);
    expect(task(2).constraintType).toBe('muststarton');
    expect(byTestId('task-constraint-date')!.classList).not.toContain('b-disabled');
    expect(field('task-constraint-date').value).toBe('Nov 5, 2026');
    expect(transactions).toEqual(['Set constraint: as soon as possible', 'Set constraint: must start on']);
  });

  it('a refused constraint date (it conflicts with a link) is reported and the field shows the stored date again', async () => {
    await render(2);
    await click(byTestId('task-tab-scheduling')!, 2);
    await choose(byTestId('task-constraint-type') as HTMLSelectElement, 'muststarton', 2);
    expect(field('task-constraint-date').value).toBe('Nov 5, 2026');
    // Tue 3: before Deliver steel (which it waits for) finishes.
    await act(async () => {
      const input = field('task-constraint-date');
      input.value = 'Nov 3, 2026';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await settleProject(project);
    });
    await render(2);
    expect(byTestId('task-edit-error')!.textContent).toContain('could not fit that into the plan');
    expect((task(2).constraintDate as Date).getDate()).toBe(5);
    expect(field('task-constraint-date').value).toBe('Nov 5, 2026');
  });

  it('saves a switch (manually scheduled) and a select (calendar) as one transaction each', async () => {
    await render(2);
    await click(byTestId('task-tab-scheduling')!, 2);
    await click(field('task-manual'), 2);
    expect(task(2).manuallyScheduled).toBe(true);
    expect(byTestId('task-calendar-section')!.textContent).toContain('counts every day');
    await choose(byTestId('task-calendar') as HTMLSelectElement, 'site', 2);
    expect((task(2).calendar as { id?: string } | null)?.id).toBe('site');
    expect(transactions).toEqual(['Schedule manually', 'Edit calendar']);
    // Shown in the header too.
    expect(host.querySelector('.ti-pills')!.textContent).toContain('Manually scheduled');
  });

  it('offers a phase only what applies to a summary task, and its dates once it is manually scheduled', async () => {
    await render(10);
    expect(byTestId('task-start')).toBeNull();
    await click(byTestId('task-tab-scheduling')!, 10);
    expect(byTestId('task-scheduling-mode')).toBeNull();
    expect(byTestId('task-effort-driven')).toBeNull();
    const types = [...(byTestId('task-constraint-type') as HTMLSelectElement).options].map((option) => option.value);
    expect(types).toEqual(['', 'assoonaspossible', 'aslateaspossible', 'startnoearlierthan', 'finishnolaterthan']);
    await click(field('task-manual'), 10);
    await click(byTestId('task-tab-details')!, 10);
    expect(byTestId('task-start')).not.toBeNull();
    expect(byTestId('task-duration')).not.toBeNull();
  });

  it('offers all four dependency types, a lag with its unit and an Active switch on each link', async () => {
    await render(2);
    await click(byTestId('task-tab-links')!, 2);
    const link = byTestId('task-link')!;
    const type = link.querySelector<HTMLSelectElement>('[data-testid=task-link-type]')!;
    expect([...type.options].map((option) => option.text)).toEqual(['Finish-to-Start (FS)', 'Start-to-Start (SS)', 'Finish-to-Finish (FF)', 'Start-to-Finish (SF)']);
    expect(link.querySelector<HTMLInputElement>('[data-testid=task-link-lag] input')!.value).toBe('0 days');
    expect(link.querySelector('[data-testid=task-link-sentence]')!.textContent).toBe('Starts once Deliver steel finishes');
    await choose(type, '1', 2);
    expect(project.dependencyStore.getById(1)!.get('type')).toBe(1);
    await click(byTestId('task-link')!.querySelector<HTMLInputElement>('[data-testid=task-link-active] input')!, 2);
    expect(project.dependencyStore.getById(1)!.get('active')).toBe(false);
    expect(byTestId('task-link')!.classList).toContain('is-off');
    expect(transactions).toEqual(['Edit link type', 'Deactivate link']);
  });
});
