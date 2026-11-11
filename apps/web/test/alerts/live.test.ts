/**
 * Slack is worked out only when read, and reading it while the engine is between the steps of a commit
 * freezes the tab (see engineCommitting): the plan the rules read leaves it out until the commit ends.
 */
import type { AssignmentModel, ProjectModel, ResourceModel, TaskModel } from '@bryntum/gantt';
import type { ProjectInlineData } from '@collab/shared';
import { cedarParkClinic } from '@collab/shared/seed';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { overbookedDays, watchPlan } from '../../src/alerts/live';
import { engineCommitting, isCritical, NO_DECORATIONS } from '../../src/gantt/look';
import { applyRentalDates, removeEquipment } from '../../src/gantt/cell-editors';
import { createProjectModel, loadCollaborativeProject } from '../../src/gantt/project';
import { runProjectTransaction } from '../../src/scenario/publish';

const DATA = {
  project: { startDate: '2026-11-02', hoursPerDay: 24, daysPerWeek: 5, daysPerMonth: 20 },
  tasksData: [
    { id: 1, name: 'Pour slab', startDate: '2026-11-02', duration: 3, durationUnit: 'day' },
    { id: 2, name: 'Frame walls', startDate: '2026-11-02', duration: 5, durationUnit: 'day' },
  ],
} as unknown as ProjectInlineData;

const projects: ProjectModel[] = [];

async function load(): Promise<ProjectModel> {
  const project = createProjectModel();
  projects.push(project);
  await loadCollaborativeProject(project, structuredClone(DATA), 'client-1');
  return project;
}

/** The engine as a render finds it between the steps of a commit. */
function midCommit(project: ProjectModel): void {
  vi.spyOn((project as unknown as { replica: { isCommitting: boolean } }).replica, 'isCommitting', 'get').mockReturnValue(true);
}

afterEach(() => {
  vi.restoreAllMocks();
  projects.splice(0).forEach((project) => project.destroy());
});

describe('reading slack from a render', () => {
  it('reads it between commits', async () => {
    const project = await load();
    expect(engineCommitting(project)).toBe(false);
    expect(watchPlan(project, NO_DECORATIONS).tasks.map((task) => task.slackDays)).toEqual([2, 0]);
    expect(isCritical(project.taskStore.getById(2) as TaskModel)).toBe(true);
  });

  it('does not touch it during a commit', async () => {
    const project = await load();
    Object.defineProperty((project as unknown as { replica: object }).replica, 'isCommitting', { configurable: true, get: () => false });
    midCommit(project);
    const task = project.taskStore.getById(2) as TaskModel;
    const read = vi.fn();
    for (const field of ['totalSlack', 'critical']) {
      Object.defineProperty(task, field, { configurable: true, get: read });
    }
    expect(engineCommitting(project)).toBe(true);
    expect(watchPlan(project, NO_DECORATIONS).tasks.map((row) => row.slackDays)).toEqual([null, null]);
    expect(isCritical(task)).toBe(false);
    expect(read).not.toHaveBeenCalled();
  });
});

describe('a machine booked twice, on Cedar Park’s two pours', () => {
  const PUMP = 2;
  const EAST_POUR = 113;
  const WEST_POUR = 114;

  async function cedar() {
    const project = createProjectModel();
    projects.push(project);
    await loadCollaborativeProject(project, structuredClone(cedarParkClinic.inlineData) as unknown as ProjectInlineData, 'client-1');
    return project;
  }
  const pumpClashes = (project: ProjectModel) => overbookedDays(project.taskStore.allRecords as TaskModel[]).filter((clash) => clash.crewId === PUMP);
  const pumpOn = (project: ProjectModel, taskId: number) =>
    (project.assignmentStore.allRecords as AssignmentModel[]).find((row) => (row.event as TaskModel).id === taskId && (row.resource as ResourceModel).id === PUMP)!;
  const dates = (project: ProjectModel, taskId: number, start: string, end: string) => ({ assignmentId: pumpOn(project, taskId).id as number, equipment: 'Concrete pump', start, end });

  it('is flagged while both pours need the pump on the same days, whatever the rental says', async () => {
    const project = await cedar();
    expect(pumpClashes(project)).toEqual([{ crewId: PUMP, firstDay: '2027-01-21', days: 2, taskIds: [EAST_POUR, WEST_POUR] }]);
  });

  it('clears when one pour’s dates no longer overlap, and comes back when they do', async () => {
    const project = await cedar();
    await applyRentalDates(project, dates(project, EAST_POUR, '2027-01-20', '2027-01-23'), { rentalEnd: '2027-01-21' });
    expect(pumpClashes(project)).toEqual([]);
    await applyRentalDates(project, dates(project, EAST_POUR, '2027-01-20', '2027-01-21'), { rentalEnd: '2027-01-22' });
    expect(pumpClashes(project)).toEqual([{ crewId: PUMP, firstDay: '2027-01-21', days: 1, taskIds: [EAST_POUR, WEST_POUR] }]);
  });

  it('clears when one pour gets a second pump', async () => {
    const project = await cedar();
    await removeEquipment(project, project.taskStore.getById(EAST_POUR) as TaskModel, PUMP);
    await runProjectTransaction(project, 'Second pump', () => {
      const [second] = project.resourceStore.add({ name: 'Concrete pump 2', kind: 'equipment', company: 'Ridgeway Concrete Pumping' } as object) as ResourceModel[];
      project.assignmentStore.add({ event: EAST_POUR, resource: second!.id, units: 100 } as never);
    });
    expect(overbookedDays(project.taskStore.allRecords as TaskModel[]).filter((clash) => clash.taskIds.includes(EAST_POUR) && clash.taskIds.includes(WEST_POUR) && clash.crewId === PUMP)).toEqual([]);
    expect(pumpClashes(project)).toEqual([]);
  });

  it('a long rental does not clash with later work the machine does on another task', async () => {
    const project = await cedar();
    // The west pour's rental runs on past the east pour, moved to start after the west pour ends.
    await applyRentalDates(project, dates(project, WEST_POUR, '2027-01-21', '2027-01-26'), { rentalEnd: '2027-02-12' });
    await runProjectTransaction(project, 'Move', () => {
      void (project.taskStore.getById(EAST_POUR) as TaskModel).setStartDate(new Date(2027, 1, 1), true);
    });
    expect(pumpClashes(project)).toEqual([]);
  });
});
