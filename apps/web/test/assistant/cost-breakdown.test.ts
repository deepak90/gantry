/**
 * Remy's cost charts read the money from the live plan: each task's cost lines, else its budget shared
 * by its crews, by who is paid, by floor, by month, and as a running total in the order it falls due
 * (the way Pay reads it: on order at the start, otherwise on the task's last day).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectModel } from '@bryntum/gantt';
import type { ProjectInlineData } from '@collab/shared';
import { createProjectModel, loadCollaborativeProject } from '../../src/gantt/project';
import { costBreakdown, levelMark, levelNumber, NO_FIRM, NO_GROUP } from '../../src/assistant/cost-breakdown';

if (!('fonts' in document)) {
  Object.defineProperty(document, 'fonts', { configurable: true, value: { ready: Promise.resolve(), addEventListener() {}, removeEventListener() {} } });
}

const line = (label: string, payee: string, amount_minor: number, due: string) => ({ label, payee, amount_minor, due, paid_ref: null });

const DATA: ProjectInlineData = {
  project: { calendar: 'standard', startDate: '2027-01-11', hoursPerDay: 24, daysPerWeek: 5, daysPerMonth: 20 },
  calendarsData: [{ id: 'standard', name: 'Standard (Mon-Fri)', unspecifiedTimeIsWorking: true, intervals: [{ recurrentStartDate: 'on Sat', recurrentEndDate: 'on Mon', isWorking: false }] }],
  tasksData: [
    {
      id: 100,
      name: 'Level 1 build-out',
      expanded: true,
      children: [
        { id: 1, name: 'Order light fixtures', startDate: '2027-01-28', duration: 1, durationUnit: 'day', manuallyScheduled: true, costLines: [line('Light fixtures, levels 1 to 3', 'Lumen & Co Lighting', 3_430_000, 'on_order')], budgetMinor: 3_430_000 },
        { id: 2, name: 'Deliver and stock fixtures', startDate: '2027-01-29', duration: 1, durationUnit: 'day', manuallyScheduled: true, costLines: [line('Freight and stocking', 'Carrow Freight', 114_000, 'on_delivery')], budgetMinor: 114_000 },
        { id: 3, name: 'Install light fixtures', startDate: '2027-02-01', duration: 4, durationUnit: 'day', manuallyScheduled: true, budgetMinor: 1_500_000 },
        { id: 4, name: 'Paint, level 1', startDate: '2027-02-05', duration: 1, durationUnit: 'day', manuallyScheduled: true, budgetMinor: 790_000 },
      ],
    },
    {
      id: 200,
      name: 'Level 2 build-out',
      expanded: true,
      children: [{ id: 5, name: 'Install light fixtures', startDate: '2027-03-08', duration: 4, durationUnit: 'day', manuallyScheduled: true, costLines: [line('Install labor', 'Halden Electrical', 1_500_000, 'on_completion')], budgetMinor: 1_500_000 }],
    },
    { id: 6, name: 'Final clean', startDate: '2027-04-28', duration: 2, durationUnit: 'day', manuallyScheduled: true, budgetMinor: 360_000 },
  ],
  resourcesData: [
    { id: 1, name: 'Halden Electrical', kind: 'labor' },
    { id: 2, name: 'Linwood Painting', kind: 'labor' },
  ],
  assignmentsData: [
    { id: 1, event: 3, resource: 1, units: 100 },
    { id: 2, event: 4, resource: 2, units: 100 },
    { id: 3, event: 4, resource: 1, units: 50 },
  ],
} as ProjectInlineData;

let project: ProjectModel;

beforeEach(async () => {
  project = createProjectModel();
  await loadCollaborativeProject(project, structuredClone(DATA), 'cost-test');
});

afterEach(() => project.destroy());

describe("the plan's money, for Remy's charts", () => {
  it('reads cost lines where a task has them, else its budget shared by its crews, else no firm', () => {
    const { parts, totalMinor } = costBreakdown(project, null);
    expect(parts.map((part) => [part.task, part.payee, part.amountMinor])).toEqual([
      ['Order light fixtures', 'Lumen & Co Lighting', 3_430_000],
      ['Deliver and stock fixtures', 'Carrow Freight', 114_000],
      ['Install light fixtures', 'Halden Electrical', 1_500_000],
      ['Paint, level 1', 'Halden Electrical', 395_000],
      ['Paint, level 1', 'Linwood Painting', 395_000],
      ['Install light fixtures', 'Halden Electrical', 1_500_000],
      ['Final clean', NO_FIRM, 360_000],
    ]);
    expect(totalMinor).toBe(7_694_000);
  });

  it('dates each cost the way Pay does: on order at the start, otherwise on the last day', () => {
    const due = Object.fromEntries(costBreakdown(project, null).parts.map((part) => [part.taskId, part.due]));
    expect(due[1]).toBe('2027-01-28'); // on order: the day it is placed
    expect(due[2]).toBe('2027-01-29'); // on delivery: the delivery's day
    expect(due[3]).toBe('2027-02-04'); // a budget: the work's last day
    expect(due[5]).toBe('2027-03-11'); // on completion
    expect(due[6]).toBe('2027-04-29');
  });

  it('groups by who is paid (largest first), by floor (in plan order) and by month', () => {
    const { payees, floors, months } = costBreakdown(project, null);
    expect(payees.map((payee) => [payee.name, payee.totalMinor])).toEqual([
      ['Lumen & Co Lighting', 3_430_000],
      ['Halden Electrical', 3_395_000],
      ['Linwood Painting', 395_000],
      [NO_FIRM, 360_000],
      ['Carrow Freight', 114_000],
    ]);
    expect(payees[1]!.taskIds).toEqual([3, 4, 5]);
    expect(floors.map((floor) => [floor.name, floor.totalMinor])).toEqual([
      ['Level 1 build-out', 5_834_000],
      ['Level 2 build-out', 1_500_000],
      [NO_GROUP, 360_000],
    ]);
    expect(months.map((month) => [month.name, month.totalMinor])).toEqual([
      ['January', 3_544_000],
      ['February', 2_290_000],
      ['March', 1_500_000],
      ['April', 360_000],
    ]);
  });

  it('runs the total up in the order the money falls due', () => {
    const { flow } = costBreakdown(project, null);
    expect(flow.map((step) => step.runningMinor)).toEqual([3_430_000, 3_544_000, 5_044_000, 5_439_000, 5_834_000, 7_334_000, 7_694_000]);
  });

  it('keeps to the tasks asked about; a group brings all of its tasks', () => {
    expect(costBreakdown(project, [200]).parts.map((part) => part.taskId)).toEqual([5]);
    expect(costBreakdown(project, [5, 1]).parts.map((part) => part.taskId)).toEqual([1, 5]);
    expect(costBreakdown(project, [999]).totalMinor).toBe(0);
  });

  it('marks floors the way a drawing does', () => {
    expect(levelMark('Level 2 build-out')).toBe('L2');
    expect(levelMark('Floor 3')).toBe('F3');
    expect(levelMark('Completion')).toBe('Comp.');
    expect(levelNumber('Level 3 build-out')).toBe(3);
    expect(levelNumber('Completion')).toBeNull();
  });
});
