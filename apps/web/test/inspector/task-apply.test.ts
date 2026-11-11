/**
 * The task panel's edits on a headless project: each committed field is one transaction, so one
 * revisionNotification (what collaborators receive), with the engine's follow-on changes inside it.
 * An edit that changes nothing sends nothing; an edit to a removed record, an invalid value or a
 * change the engine cannot schedule is refused (`EditError`) and changes nothing.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { DependencyModel, ProjectModel, TaskModel } from '@bryntum/gantt';
import type { ProjectInlineData } from '@collab/shared';
import { createProjectModel, loadCollaborativeProject } from '../../src/gantt/project';
import {
  EditError,
  addLink,
  assignCrew,
  removeLink,
  renameTask,
  setCalendar,
  setConstraint,
  setDeadline,
  setEffortDriven,
  setIgnoreResourceCalendar,
  setInactive,
  setLinkActive,
  setLinkKind,
  setLinkLag,
  setManuallyScheduled,
  setMilestone,
  setProgress,
  setProjectBorder,
  setRollup,
  setScheduleField,
  setSchedulingMode,
  setTaskColor,
  setTaskMoney,
  setTaskNote,
  unassignCrew,
} from '../../src/inspector/task/apply';
import {
  calendarChoices,
  constraintChoicesFor,
  constraintDateFor,
  constraintDay,
  crewCandidates,
  findTask,
  lagText,
  linkCandidates,
  linkKindText,
  linkSentence,
  taskView,
} from '../../src/inspector/task/model';

/** Mon–Fri, 24-hour days like the seed; Monday, November 2, 2026 is day one. */
const DATA: ProjectInlineData = {
  project: { calendar: 'standard', startDate: '2026-11-02', hoursPerDay: 24, daysPerWeek: 5, daysPerMonth: 20 },
  calendarsData: [
    {
      id: 'standard',
      name: 'Standard (Mon-Fri)',
      unspecifiedTimeIsWorking: true,
      intervals: [{ recurrentStartDate: 'on Sat', recurrentEndDate: 'on Mon', isWorking: false }],
    },
    {
      id: 'site',
      name: 'Site (Mon-Sat)',
      unspecifiedTimeIsWorking: true,
      intervals: [{ recurrentStartDate: 'on Sun', recurrentEndDate: 'on Mon', isWorking: false }],
    },
  ],
  tasksData: [
    {
      id: 10,
      name: 'Frame',
      expanded: true,
      children: [
        { id: 1, name: 'Deliver steel', startDate: '2026-11-02', duration: 3, durationUnit: 'day', budgetMinor: 100_000, forecastMinor: 100_000 },
        { id: 2, name: 'Erect steel frame', startDate: '2026-11-05', duration: 2, durationUnit: 'day', note: 'Crane on site' },
        { id: 3, name: 'Bolt-up', startDate: '2026-11-09', duration: 2, durationUnit: 'day' },
      ],
    },
    { id: 4, name: 'Frame signed off', startDate: '2026-11-11', duration: 0, durationUnit: 'day' },
  ],
  dependenciesData: [
    { id: 1, fromEvent: 1, toEvent: 2, type: 2, lag: 0, lagUnit: 'day' },
    { id: 2, fromEvent: 2, toEvent: 3, type: 2, lag: 0, lagUnit: 'day' },
  ],
  resourcesData: [
    { id: 1, name: 'Steel erectors', kind: 'labor' },
    { id: 2, name: 'Crane', kind: 'equipment' },
    { id: 3, name: 'Site crew', kind: 'labor' },
  ],
  assignmentsData: [{ id: 1, event: 2, resource: 1, units: 100 }],
};

const projects: ProjectModel[] = [];

async function load(): Promise<ProjectModel> {
  const project = createProjectModel();
  projects.push(project);
  await loadCollaborativeProject(project, structuredClone(DATA), 'client-1');
  return project;
}

afterEach(() => {
  projects.splice(0).forEach((project) => project.destroy());
});

interface Notification {
  changes: Record<string, { $input?: { added?: Record<string, unknown>[]; updated?: Record<string, unknown>[]; removed?: { id: unknown }[] } } | undefined>;
}

/** Collects the revisions the project announces (what RevisionSync would send). */
function revisions(project: ProjectModel): Notification[] {
  const seen: Notification[] = [];
  project.on('revisionNotification', (event: Notification) => seen.push(event));
  return seen;
}

/** The STM records a revision shortly after the transaction stops. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

const day = (iso: string) => {
  const [year, month, date] = iso.split('-').map(Number);
  return new Date(year!, month! - 1, date!);
};
const iso = (value: Date | string | null | undefined) => {
  const date = typeof value === 'string' ? new Date(value) : value;
  return date ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}` : null;
};
const task = (project: ProjectModel, id: number) => project.taskStore.getById(id) as TaskModel;
const dependency = (project: ProjectModel, id: number) =>
  project.dependencyStore.getById(id) as DependencyModel & { lag: number; lagUnit: string; type: number; active: boolean };
/** The scheduling fields of a task, as the engine holds them. */
const fields = (project: ProjectModel, id: number) => task(project, id) as unknown as Record<string, unknown> & { calendar?: { id: string } | null };
const inputOf = (notification: Notification | undefined, store = 'tasks') => notification?.changes[store]?.$input?.updated ?? [];

describe('task panel: one field = one revision', () => {
  it('renames, with the new name in the revision input', async () => {
    const project = await load();
    const seen = revisions(project);
    await renameTask(project, 2, '  Erect structural steel frame ');
    await settle();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.changes.tasks?.$input?.updated).toEqual([expect.objectContaining({ id: 2, name: 'Erect structural steel frame' })]);
  });

  it('saves notes and sends nothing when nothing changed', async () => {
    const project = await load();
    const seen = revisions(project);
    await setTaskNote(project, 2, 'Crane on site');
    await renameTask(project, 2, 'Erect steel frame');
    await settle();
    expect(seen).toHaveLength(0);
    await setTaskNote(project, 2, 'Crane on site from Monday');
    await settle();
    expect(seen).toHaveLength(1);
    expect((task(project, 2) as TaskModel & { note: string }).note).toBe('Crane on site from Monday');
  });

  it('moves the start keeping the length, and the successor follows in the same revision', async () => {
    const project = await load();
    const seen = revisions(project);
    await setScheduleField(project, 1, 'start', day('2026-11-03'));
    await settle();
    expect(seen).toHaveLength(1);
    expect(iso(task(project, 1).startDate)).toBe('2026-11-03');
    expect(task(project, 1).duration).toBe(3);
    expect(iso(task(project, 2).startDate)).toBe('2026-11-06');
  });

  it('changes the length from the last working day, over the weekend', async () => {
    const project = await load();
    const seen = revisions(project);
    await setScheduleField(project, 1, 'lastDay', day('2026-11-09'));
    await settle();
    expect(seen).toHaveLength(1);
    expect(task(project, 1).duration).toBe(6); // Mon 2 - Mon 9, weekend excluded
  });

  it('changes the working days', async () => {
    const project = await load();
    const seen = revisions(project);
    await setScheduleField(project, 1, 'days', 4);
    await settle();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.changes.tasks?.$input?.updated).toEqual([expect.objectContaining({ id: 1, duration: 4 })]);
  });

  it('sets progress', async () => {
    const project = await load();
    const seen = revisions(project);
    await setProgress(project, 1, 42.4);
    await settle();
    expect(seen).toHaveLength(1);
    expect(task(project, 1).percentDone).toBe(42);
  });

  it('sets and removes a start-no-earlier-than constraint', async () => {
    const project = await load();
    const seen = revisions(project);
    await setConstraint(project, 3, 'startnoearlierthan', day('2026-11-16'));
    await settle();
    expect(seen).toHaveLength(1);
    expect(taskView(project, task(project, 3)).constraint).toEqual(expect.objectContaining({ type: 'startnoearlierthan', day: day('2026-11-16') }));
    expect(iso(task(project, 3).startDate)).toBe('2026-11-16');
    await setConstraint(project, 3, null);
    await settle();
    expect(seen).toHaveLength(2);
    expect(taskView(project, task(project, 3)).constraint.type).toBeNull();
    expect(iso(task(project, 3).startDate)).toBe('2026-11-09');
  });

  it('turns a task into a milestone and back', async () => {
    const project = await load();
    const seen = revisions(project);
    await setMilestone(project, 3, true);
    await settle();
    expect(task(project, 3).isMilestone).toBe(true);
    await setMilestone(project, 3, false);
    await settle();
    expect(task(project, 3).isMilestone).toBe(false);
    expect(task(project, 3).duration).toBe(1);
    expect(seen).toHaveLength(2);
  });

  it('edits budget and expected of a task', async () => {
    const project = await load();
    const seen = revisions(project);
    await setTaskMoney(project, 1, { forecastMinor: 112_500 });
    await settle();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.changes.tasks?.$input?.updated).toEqual([expect.objectContaining({ id: 1, forecastMinor: 112_500 })]);
  });
});

describe('task panel: links', () => {
  it('reads links in words with the wait in working days', async () => {
    const project = await load();
    const view = taskView(project, task(project, 2));
    expect(view.waitsFor).toEqual([expect.objectContaining({ otherName: 'Deliver steel', kind: 'after it finishes', lagText: 'no wait' })]);
    expect(view.leadsTo).toEqual([expect.objectContaining({ otherName: 'Bolt-up', kind: 'after this finishes' })]);
    expect(lagText(2)).toBe('+2 days wait');
    expect(lagText(-1)).toBe('1 day overlap');
    expect(linkKindText(0, 'waits')).toBe('when it starts');
    expect(linkKindText(3, 'leads')).toBe('finish together');
  });

  it('a wait is one revision and moves the successor', async () => {
    const project = await load();
    const seen = revisions(project);
    await setLinkLag(project, 1, 2);
    await settle();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.changes.dependencies?.$input?.updated).toEqual([expect.objectContaining({ id: 1, lag: 2 })]);
    expect(dependency(project, 1).lagUnit).toBe('day');
    expect(iso(task(project, 2).startDate)).toBe('2026-11-09'); // Thu 5 + 2 working days
    expect(taskView(project, task(project, 2)).waitsFor[0]!.lagText).toBe('+2 days wait');
  });

  it('an overlap is a negative wait', async () => {
    const project = await load();
    await setLinkLag(project, 1, -1);
    await settle();
    expect(iso(task(project, 2).startDate)).toBe('2026-11-04');
    expect(taskView(project, task(project, 2)).waitsFor[0]!.lagText).toBe('1 day overlap');
  });

  it('changes the kind of a link', async () => {
    const project = await load();
    const seen = revisions(project);
    await setLinkKind(project, 1, 0);
    await settle();
    expect(seen).toHaveLength(1);
    expect(dependency(project, 1).type).toBe(0);
    expect(iso(task(project, 2).startDate)).toBe('2026-11-02');
  });

  it('adds a link as one revision and refuses a loop without changing anything', async () => {
    const project = await load();
    const seen = revisions(project);
    await addLink(project, { fromId: 3, toId: 4, type: 2, lag: 1 });
    await settle();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.changes.dependencies?.$input?.added).toEqual([expect.objectContaining({ fromEvent: 3, toEvent: 4, type: 2, lag: 1 })]);
    expect(taskView(project, task(project, 4)).waitsFor.map((link) => link.otherName)).toEqual(['Bolt-up']);

    await expect(addLink(project, { fromId: 3, toId: 1, type: 2 })).rejects.toBeInstanceOf(EditError);
    await expect(addLink(project, { fromId: 1, toId: 2, type: 2 })).rejects.toThrow('already waits for');
    await settle();
    expect(seen).toHaveLength(1);
  });

  it('removes a link as one revision', async () => {
    const project = await load();
    const seen = revisions(project);
    await removeLink(project, 2);
    await settle();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.changes.dependencies?.$input?.removed).toEqual([expect.objectContaining({ id: 2 })]);
    expect(taskView(project, task(project, 3)).waitsFor).toEqual([]);
  });

  it('offers only tasks that can be linked', async () => {
    const project = await load();
    const waits = linkCandidates(project, task(project, 2), 'waits').map((option) => option.id);
    // Not itself, not its phase, not the task it already waits for.
    expect(waits).toEqual([3, 4]);
    const phase = linkCandidates(project, task(project, 10), 'leads').map((option) => option.id);
    expect(phase).toEqual([4]);
  });
});

describe('task panel: crew', () => {
  it('adds and removes a crew, one revision each', async () => {
    const project = await load();
    const seen = revisions(project);
    expect(crewCandidates(project, task(project, 2)).map((crew) => crew.name)).toEqual(['Site crew', 'Crane']);
    await assignCrew(project, 2, 2);
    await settle();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.changes.assignments?.$input?.added).toEqual([expect.objectContaining({ event: 2, resource: 2, units: 100 })]);
    const crane = taskView(project, task(project, 2)).crew.find((crew) => crew.name === 'Crane')!;
    expect(crane.equipment).toBe(true);
    // The length stays: a crew joining does not shorten the task.
    expect(task(project, 2).duration).toBe(2);

    // (Removing the crane here would undo an add the server never confirmed; remove a saved crew instead.)
    await unassignCrew(project, 1);
    await settle();
    expect(seen).toHaveLength(2);
    expect(seen[1]!.changes.assignments?.$input?.removed).toEqual([expect.objectContaining({ id: 1 })]);
    expect(taskView(project, task(project, 2)).crew.map((crew) => crew.name)).toEqual(['Crane']);
  });

  it('adding a crew already on the task sends nothing', async () => {
    const project = await load();
    const seen = revisions(project);
    await assignCrew(project, 2, 1);
    await settle();
    expect(seen).toHaveLength(0);
  });
});

describe('task panel: phases, milestones and removed tasks', () => {
  it("a phase's dates, progress and money are read-only", async () => {
    const project = await load();
    const seen = revisions(project);
    const view = taskView(project, task(project, 10));
    expect(view.isPhase).toBe(true);
    expect(view.inside).toEqual({ tasks: 3, done: 0 });
    expect(view.crewInside.map((crew) => crew.name)).toEqual(['Steel erectors']);
    await expect(setScheduleField(project, 10, 'start', day('2026-11-03'))).rejects.toBeInstanceOf(EditError);
    await expect(setProgress(project, 10, 50)).rejects.toBeInstanceOf(EditError);
    await expect(setTaskMoney(project, 10, { budgetMinor: 1 })).rejects.toBeInstanceOf(EditError);
    await expect(assignCrew(project, 10, 3)).rejects.toBeInstanceOf(EditError);
    // Its name is the user's to change.
    await renameTask(project, 10, 'Steel frame');
    await settle();
    expect(seen).toHaveLength(1);
  });

  it('reads a milestone', async () => {
    const project = await load();
    const view = taskView(project, task(project, 4));
    expect(view.isMilestone).toBe(true);
    expect(view.days).toBe(0);
    expect(view.path).toEqual([]);
    expect(taskView(project, task(project, 2)).path).toEqual(['Frame']);
  });

  it('an edit to a task someone else removed is refused and changes nothing', async () => {
    const project = await load();
    const seen = revisions(project);
    await removeLink(project, 2);
    await settle();
    // The other person's removal, recorded by the STM on its own (it waits ~100 ms before it records).
    project.taskStore.getById(3)!.remove();
    await project.commitAsync();
    await new Promise((resolve) => setTimeout(resolve, 200));
    seen.length = 0;
    expect(findTask(project, 3)).toBeNull();
    await expect(renameTask(project, 3, 'Gone')).rejects.toThrow('no longer in the plan');
    await expect(setLinkLag(project, 2, 1)).rejects.toThrow('no longer in the plan');
    await settle();
    expect(seen).toHaveLength(0);
  });
});

describe('task panel: details (Bryntum General tab and deadline)', () => {
  it('sets an exact % complete, and refuses one on a phase', async () => {
    const project = await load();
    const seen = revisions(project);
    await setProgress(project, 1, 37);
    await setProgress(project, 1, 37.2);
    await settle();
    expect(seen).toHaveLength(1);
    expect(task(project, 1).percentDone).toBe(37);
    await expect(setProgress(project, 10, 10)).rejects.toThrow('adds up the tasks inside it');
    await expect(setProgress(project, 1, Number.NaN)).rejects.toBeInstanceOf(EditError);
  });

  it('sets a deadline (sent without a time zone) and shows a finish past it', async () => {
    const project = await load();
    const seen = revisions(project);
    await setDeadline(project, 2, day('2026-11-05'));
    await settle();
    expect(seen).toHaveLength(1);
    expect(inputOf(seen[0])).toEqual([{ id: 2, deadlineDate: '2026-11-05T00:00:00' }]);
    // Erect steel frame finishes Fri 6: a day after its deadline. The deadline does not move it.
    const view = taskView(project, task(project, 2));
    expect(view.deadline).toEqual(day('2026-11-05'));
    expect(view.pastDeadline).toBe(1);
    expect(iso(task(project, 2).startDate)).toBe('2026-11-05');
    await setDeadline(project, 2, day('2026-11-06'));
    await settle();
    expect(taskView(project, task(project, 2)).pastDeadline).toBe(0);
    await setDeadline(project, 2, new Date(2026, 10, 6, 15, 30));
    await settle();
    expect(seen).toHaveLength(2); // same day: nothing sent
    await setDeadline(project, 2, null);
    await settle();
    expect(seen).toHaveLength(3);
    expect(taskView(project, task(project, 2)).deadline).toBeNull();
  });

  it('sets the task color from Bryntum colors, and refuses anything else', async () => {
    const project = await load();
    const seen = revisions(project);
    await setTaskColor(project, 2, 'teal');
    await settle();
    expect(seen).toHaveLength(1);
    expect(inputOf(seen[0])).toEqual([{ id: 2, eventColor: 'teal' }]);
    expect(taskView(project, task(project, 2)).color).toBe('teal');
    await setTaskColor(project, 2, 'teal');
    await expect(setTaskColor(project, 2, 'url(evil)')).rejects.toBeInstanceOf(EditError);
    await setTaskColor(project, 2, null);
    await settle();
    expect(seen).toHaveLength(2);
    expect(taskView(project, task(project, 2)).color).toBeNull();
  });
});

describe('task panel: scheduling (Bryntum Advanced tab)', () => {
  it('a manually scheduled task keeps its dates when its predecessor moves', async () => {
    const project = await load();
    const seen = revisions(project);
    await setManuallyScheduled(project, 3, true);
    await settle();
    expect(seen).toHaveLength(1);
    expect(inputOf(seen[0])).toEqual([{ id: 3, manuallyScheduled: true }]);
    expect(taskView(project, task(project, 3)).isManual).toBe(true);
    // Erect steel frame now waits three more days; Bolt-up stays where it was put.
    await setLinkLag(project, 1, 3);
    await settle();
    expect(iso(task(project, 2).startDate)).toBe('2026-11-10');
    expect(iso(task(project, 3).startDate)).toBe('2026-11-09');
    // Same value: nothing sent.
    await setManuallyScheduled(project, 3, true);
    await settle();
    expect(seen).toHaveLength(2);
    // Scheduled automatically again, it follows its predecessor.
    await setManuallyScheduled(project, 3, false);
    await settle();
    expect(iso(task(project, 3).startDate)).toBe('2026-11-12');
  });

  it('sets each constraint type with its date, converting finish dates to the last working day', async () => {
    const project = await load();
    const seen = revisions(project);
    await setConstraint(project, 3, 'muststarton', day('2026-11-16'));
    await settle();
    expect(iso(task(project, 3).startDate)).toBe('2026-11-16');
    expect(inputOf(seen[0])).toEqual([expect.objectContaining({ id: 3, constraintType: 'muststarton', constraintDate: '2026-11-16T00:00:00' })]);

    // Must finish on Fri 20: the stored date is the end (Sat 21 00:00), shown as Fri 20.
    const finish = constraintDateFor('mustfinishon', day('2026-11-20'));
    expect(iso(finish)).toBe('2026-11-21');
    await setConstraint(project, 3, 'mustfinishon', finish);
    await settle();
    const view = taskView(project, task(project, 3));
    expect(view.constraint).toEqual(expect.objectContaining({ type: 'mustfinishon', day: day('2026-11-20'), note: null }));
    expect(iso(view.lastDay)).toBe('2026-11-20');
    expect(constraintDay('mustfinishon', finish)).toEqual(day('2026-11-20'));

    await setConstraint(project, 3, 'finishnolaterthan', constraintDateFor('finishnolaterthan', day('2026-11-20')));
    await setConstraint(project, 3, 'startnolaterthan', day('2026-11-20'));
    await setConstraint(project, 3, 'finishnoearlierthan', constraintDateFor('finishnoearlierthan', day('2026-11-13')));
    await settle();
    expect(seen).toHaveLength(5);
    expect(iso(taskView(project, task(project, 3)).lastDay)).toBe('2026-11-13');

    // The same constraint again sends nothing.
    await setConstraint(project, 3, 'finishnoearlierthan', constraintDateFor('finishnoearlierthan', day('2026-11-13')));
    await settle();
    expect(seen).toHaveLength(5);
  });

  it('as late as possible schedules backward (the direction), with no date; none returns to the inherited direction', async () => {
    const project = await load();
    expect(taskView(project, task(project, 4)).direction).toEqual({ value: 'Forward', kind: 'inherited', source: 'the project' });
    await setConstraint(project, 4, 'aslateaspossible', day('2026-11-20'));
    await settle();
    const view = taskView(project, task(project, 4));
    expect(view.constraint).toEqual(expect.objectContaining({ type: 'aslateaspossible', date: null, day: null }));
    expect(view.direction).toEqual({ value: 'Backward', kind: 'own', source: null });
    expect(fields(project, 4).direction).toBe('Backward');
    await setConstraint(project, 4, 'assoonaspossible');
    await settle();
    expect(taskView(project, task(project, 4)).direction).toEqual({ value: 'Forward', kind: 'own', source: null });
    await setConstraint(project, 4, null);
    await settle();
    expect(taskView(project, task(project, 4)).direction.kind).toBe('inherited');
    expect(taskView(project, task(project, 4)).constraint.type).toBeNull();

    // A phase as late as possible: the tasks inside inherit its direction.
    await setConstraint(project, 10, 'aslateaspossible');
    await settle();
    expect(taskView(project, task(project, 1)).direction).toEqual({ value: 'Backward', kind: 'inherited', source: '“Frame”' });
  });

  it('validates constraints: a date for the dated types, only summary types on a phase, known types only', async () => {
    const project = await load();
    const seen = revisions(project);
    await expect(setConstraint(project, 3, 'muststarton')).rejects.toThrow('Must start on needs a constraint date');
    await expect(setConstraint(project, 3, 'finishnolaterthan', null)).rejects.toBeInstanceOf(EditError);
    await expect(setConstraint(project, 3, 'sometime' as never, day('2026-11-16'))).rejects.toThrow('constraint type');
    await expect(setConstraint(project, 10, 'muststarton', day('2026-11-16'))).rejects.toThrow('A phase can only be');
    await expect(setConstraint(project, 10, 'startnolaterthan', day('2026-11-16'))).rejects.toBeInstanceOf(EditError);
    expect(constraintChoicesFor(true).map((choice) => choice.type)).toEqual([null, 'assoonaspossible', 'aslateaspossible', 'startnoearlierthan', 'finishnolaterthan']);
    await settle();
    expect(seen).toHaveLength(0);
    // The summary types are fine on a phase.
    await setConstraint(project, 10, 'startnoearlierthan', day('2026-11-04'));
    await settle();
    expect(seen).toHaveLength(1);
    expect(iso(task(project, 1).startDate)).toBe('2026-11-04');
  });

  it('a constraint that conflicts with a link is refused, nothing changes and the next edit works', async () => {
    const project = await load();
    const seen = revisions(project);
    // Erect steel frame cannot start on Tue 3: it waits for Deliver steel, which finishes Wed 4.
    await expect(setConstraint(project, 2, 'muststarton', day('2026-11-03'))).rejects.toThrow('could not fit that into the plan');
    await settle();
    expect(seen).toHaveLength(0);
    expect(fields(project, 2).constraintType).toBeNull();
    expect(iso(task(project, 2).startDate)).toBe('2026-11-05');
    await renameTask(project, 2, 'Erect the steel frame');
    await settle();
    expect(seen).toHaveLength(1);
  });

  it('says when the engine ignores a constraint, and nothing while it is met', async () => {
    const project = await load();
    // Must start on a Saturday: the engine starts it right then, so the constraint is met.
    await setConstraint(project, 3, 'muststarton', day('2026-11-14'));
    await settle();
    expect(iso(task(project, 3).startDate)).toBe('2026-11-14');
    expect(taskView(project, task(project, 3)).constraint.note).toBeNull();
    await setConstraint(project, 3, 'startnoearlierthan', day('2026-11-16'));
    await setManuallyScheduled(project, 3, true);
    await settle();
    expect(taskView(project, task(project, 3)).constraint.note).toEqual({ tone: 'neutral', text: expect.stringContaining('Manually scheduled') });
    await setManuallyScheduled(project, 3, false);
    await setInactive(project, 3, true);
    await settle();
    expect(taskView(project, task(project, 3)).constraint.note).toEqual({ tone: 'neutral', text: expect.stringContaining('Inactive') });
  });

  it('an inactive task stops moving the tasks that wait for it', async () => {
    const project = await load();
    const seen = revisions(project);
    await setInactive(project, 1, true);
    await settle();
    expect(seen).toHaveLength(1);
    expect(inputOf(seen[0])).toEqual([expect.objectContaining({ id: 1, inactive: true })]);
    expect(taskView(project, task(project, 1)).isInactive).toBe(true);
    expect(iso(task(project, 2).startDate)).toBe('2026-11-02');
    await setInactive(project, 1, true);
    await settle();
    expect(seen).toHaveLength(1);
    await setInactive(project, 1, false);
    await settle();
    expect(iso(task(project, 2).startDate)).toBe('2026-11-05');
  });

  it('changes the calendar: the task is scheduled on its working days and its crews\' (unless ignored)', async () => {
    const project = await load();
    const seen = revisions(project);
    expect(calendarChoices(project).map((choice) => choice.id)).toEqual(['site', 'standard']);
    await setScheduleField(project, 2, 'days', 3);
    await settle();
    // Thu 5, Fri 6, (weekend), Mon 9.
    expect(iso(taskView(project, task(project, 2)).lastDay)).toBe('2026-11-09');
    expect(taskView(project, task(project, 2)).calendar).toEqual(expect.objectContaining({ ownId: null, effectiveName: 'Standard (Mon-Fri)' }));
    await setCalendar(project, 2, 'site');
    await settle();
    expect(seen).toHaveLength(2);
    expect(inputOf(seen[1])).toEqual([{ id: 2, calendar: 'site' }]);
    expect(taskView(project, task(project, 2)).calendar).toEqual(expect.objectContaining({ ownId: 'site', effectiveName: 'Site (Mon-Sat)', projectName: 'Standard (Mon-Fri)' }));
    // Its crew (no calendar of its own: the project's) still works Mon-Fri, so it still ends Mon 9...
    expect(iso(taskView(project, task(project, 2)).lastDay)).toBe('2026-11-09');
    // ...until the resource calendars are ignored: Thu 5, Fri 6, Sat 7 on the site calendar.
    await setIgnoreResourceCalendar(project, 2, true);
    await settle();
    expect(iso(taskView(project, task(project, 2)).lastDay)).toBe('2026-11-07');
    await setCalendar(project, 2, 'site');
    await expect(setCalendar(project, 2, 'night-shift')).rejects.toThrow('no longer in the project');
    await setCalendar(project, 2, null);
    await settle();
    expect(seen).toHaveLength(4);
    expect(fields(project, 2).calendar).toBeNull();
    expect(iso(taskView(project, task(project, 2)).lastDay)).toBe('2026-11-09');
  });

  it('scheduling mode and effort driven', async () => {
    const project = await load();
    const seen = revisions(project);
    await setSchedulingMode(project, 2, 'FixedEffort');
    await settle();
    expect(seen).toHaveLength(1);
    expect(inputOf(seen[0])).toEqual([expect.objectContaining({ id: 2, schedulingMode: 'FixedEffort' })]);
    expect(taskView(project, task(project, 2)).schedulingMode).toBe('FixedEffort');
    await setEffortDriven(project, 2, true);
    await settle();
    expect(seen).toHaveLength(2);
    expect(taskView(project, task(project, 2)).effortDriven).toBe(true);
    // The same values again send nothing.
    await setSchedulingMode(project, 2, 'FixedEffort');
    await setEffortDriven(project, 2, true);
    await settle();
    expect(seen).toHaveLength(2);
    await expect(setSchedulingMode(project, 2, 'Whenever' as never)).rejects.toBeInstanceOf(EditError);
    await expect(setSchedulingMode(project, 10, 'FixedDuration')).rejects.toThrow('apply to tasks');
    await expect(setEffortDriven(project, 10, true)).rejects.toBeInstanceOf(EditError);
  });

  it('resource calendars, rollup and project border are one revision each; WBS code is read', async () => {
    const project = await load();
    const seen = revisions(project);
    expect(taskView(project, task(project, 2)).wbsCode).toBe('1.2');
    expect(taskView(project, task(project, 2)).projectBorder).toBe('honor');
    await setIgnoreResourceCalendar(project, 2, true);
    await setRollup(project, 2, true);
    await setProjectBorder(project, 2, 'ignore');
    await settle();
    expect(seen).toHaveLength(3);
    expect(seen.map((notification) => inputOf(notification)[0])).toEqual([
      { id: 2, ignoreResourceCalendar: true },
      { id: 2, rollup: true },
      { id: 2, projectConstraintResolution: 'ignore' },
    ]);
    const view = taskView(project, task(project, 2));
    expect([view.ignoreResourceCalendar, view.rollup, view.projectBorder]).toEqual([true, true, 'ignore']);
    await setRollup(project, 2, true);
    await setProjectBorder(project, 2, 'ignore');
    await settle();
    expect(seen).toHaveLength(3);
    await expect(setProjectBorder(project, 2, 'maybe' as never)).rejects.toBeInstanceOf(EditError);
    await expect(setIgnoreResourceCalendar(project, 10, true)).rejects.toBeInstanceOf(EditError);
  });

  it('a manually scheduled phase has dates of its own; an automatic one follows its tasks', async () => {
    const project = await load();
    const seen = revisions(project);
    await expect(setScheduleField(project, 10, 'start', day('2026-11-03'))).rejects.toThrow('make it manually scheduled');
    await setManuallyScheduled(project, 10, true);
    await settle();
    expect(taskView(project, task(project, 10)).canEditDates).toBe(true);
    await setScheduleField(project, 10, 'start', day('2026-11-03'));
    await settle();
    expect(seen).toHaveLength(2);
    expect(iso(task(project, 10).startDate)).toBe('2026-11-03');
    // The tasks inside can't start before it.
    expect(iso(task(project, 1).startDate)).toBe('2026-11-03');
    await setScheduleField(project, 10, 'days', 12);
    await settle();
    expect(task(project, 10).duration).toBe(12);
    // Its progress and effort still add up its tasks; it can be inactive and take a calendar.
    await expect(setProgress(project, 10, 50)).rejects.toBeInstanceOf(EditError);
    await setCalendar(project, 10, 'site');
    await setInactive(project, 10, true);
    await settle();
    expect(seen).toHaveLength(5);
  });
});

describe('task panel: links, all four types', () => {
  it('a start-to-finish link: the successor finishes once the predecessor starts', async () => {
    const project = await load();
    const seen = revisions(project);
    await setLinkKind(project, 1, 1);
    await settle();
    expect(seen).toHaveLength(1);
    expect(dependency(project, 1).type).toBe(1);
    const link = taskView(project, task(project, 2)).waitsFor[0]!;
    expect(link).toEqual(expect.objectContaining({ type: 1, typeCode: 'SF', sentence: 'Finishes when Deliver steel starts' }));
    // Nothing else holds it, so it runs from the project start.
    expect(iso(task(project, 2).startDate)).toBe('2026-11-02');
    await expect(setLinkKind(project, 1, 7 as never)).rejects.toBeInstanceOf(EditError);
  });

  it('a lag in weeks travels with its unit', async () => {
    const project = await load();
    const seen = revisions(project);
    await setLinkLag(project, 1, 1, 'w');
    await settle();
    expect(seen).toHaveLength(1);
    expect(inputOf(seen[0], 'dependencies')).toEqual([expect.objectContaining({ id: 1, lag: 1, lagUnit: 'week' })]);
    // Deliver steel finishes Wed 4; a working week later is Thu 12.
    expect(iso(task(project, 2).startDate)).toBe('2026-11-12');
    const link = taskView(project, task(project, 2)).waitsFor[0]!;
    expect(link).toEqual(expect.objectContaining({ lagValue: 1, lagUnit: 'week', lag: 5, lagText: '+1 week wait', sentence: 'Starts 1 week after Deliver steel finishes' }));
    await setLinkLag(project, 1, 1, 'week');
    await settle();
    expect(seen).toHaveLength(1);
    await expect(setLinkLag(project, 1, 1, 'two weeks')).rejects.toBeInstanceOf(EditError);
    await expect(setLinkLag(project, 1, Number.POSITIVE_INFINITY)).rejects.toBeInstanceOf(EditError);
  });

  it('an inactive link stays but no longer moves its successor', async () => {
    const project = await load();
    const seen = revisions(project);
    await setLinkActive(project, 1, false);
    await settle();
    expect(seen).toHaveLength(1);
    expect(inputOf(seen[0], 'dependencies')).toEqual([{ id: 1, active: false }]);
    expect(dependency(project, 1).active).toBe(false);
    expect(taskView(project, task(project, 2)).waitsFor[0]!.active).toBe(false);
    expect(iso(task(project, 2).startDate)).toBe('2026-11-02');
    await setLinkActive(project, 1, false);
    await settle();
    expect(seen).toHaveLength(1);
    await setLinkActive(project, 1, true);
    await settle();
    expect(iso(task(project, 2).startDate)).toBe('2026-11-05');
  });

  it('says what each link does in one sentence, from either side', () => {
    expect(linkSentence(2, 'waits', 'Pour', 0, 'day')).toBe('Starts once Pour finishes');
    expect(linkSentence(2, 'waits', 'Pour', 2, 'day')).toBe('Starts 2 days after Pour finishes');
    expect(linkSentence(0, 'waits', 'Pour', -1, 'day')).toBe('Starts 1 day before Pour starts');
    expect(linkSentence(3, 'leads', 'Cure', 0, 'day')).toBe('Cure finishes when this finishes');
    expect(linkSentence(1, 'leads', 'Cure', 4, 'hour')).toBe('Cure finishes 4 hours after this starts');
  });
});

describe('task panel: new edits on removed records', () => {
  it('every scheduling edit to a removed task or link is refused and sends nothing', async () => {
    const project = await load();
    const seen = revisions(project);
    project.taskStore.getById(3)!.remove();
    await project.commitAsync();
    await new Promise((resolve) => setTimeout(resolve, 200));
    seen.length = 0;
    const gone = 'no longer in the plan';
    await expect(setManuallyScheduled(project, 3, true)).rejects.toThrow(gone);
    await expect(setConstraint(project, 3, 'startnoearlierthan', day('2026-11-16'))).rejects.toThrow(gone);
    await expect(setInactive(project, 3, true)).rejects.toThrow(gone);
    await expect(setCalendar(project, 3, 'site')).rejects.toThrow(gone);
    await expect(setSchedulingMode(project, 3, 'FixedEffort')).rejects.toThrow(gone);
    await expect(setDeadline(project, 3, day('2026-11-20'))).rejects.toThrow(gone);
    await expect(setTaskColor(project, 3, 'teal')).rejects.toThrow(gone);
    await expect(setRollup(project, 3, true)).rejects.toThrow(gone);
    await expect(setProjectBorder(project, 3, 'ignore')).rejects.toThrow(gone);
    // Its link (Erect steel frame → Bolt-up) went with it.
    await expect(setLinkActive(project, 2, false)).rejects.toThrow(gone);
    await settle();
    expect(seen).toHaveLength(0);
  });
});
