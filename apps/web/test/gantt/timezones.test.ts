/**
 * Two clients in different time zones exchange a revision (rule: dates travel without an offset;
 * Gantt guide "Revisions / Timezones Support"). Node re-reads `process.env.TZ` at runtime, so one
 * process plays both sides: the producer records a revision in Los Angeles, the consumer applies it
 * in Berlin. With every date serialized without an offset the consumer's engine finds nothing to
 * correct and stays silent. The control with plain Bryntum models shows the corrective
 * `project.endDate` revision the shared factory prevents.
 */
import { ProjectModel } from '@bryntum/gantt';
import type { ChangesInfo, IncomingRevision, ProjectInlineData } from '@collab/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { createProjectModel, loadCollaborativeProject } from '../../src/gantt/project';
import type { RevisionNotificationEvent } from '../../src/sync/revision-sync';

const PRODUCER_TZ = 'America/Los_Angeles';
const CONSUMER_TZ = 'Europe/Berlin';
const TZ_LESS_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
const WITH_OFFSET = /[+-]\d{2}:\d{2}$/;
const ORIGINAL_TZ = process.env.TZ;

afterAll(() => {
  if (ORIGINAL_TZ === undefined) {
    delete process.env.TZ;
  } else {
    process.env.TZ = ORIGINAL_TZ;
  }
});

function snapshot(): ProjectInlineData {
  return {
    tasksData: [
      { id: 1, name: 'Site setup', startDate: '2026-11-02', duration: 2 },
      { id: 2, name: 'Foundations', duration: 3 },
    ],
    dependenciesData: [{ id: 1, fromEvent: 1, toEvent: 2 }],
  };
}

type Factory = () => ProjectModel;

const collaborative: Factory = () => createProjectModel({ config: { startDate: '2026-11-02' } });
/** Bryntum's defaults: dates serialized with the browser's UTC offset. */
const plain: Factory = () => new ProjectModel({ startDate: '2026-11-02', stm: { revisionsEnabled: true } });

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const pad = (value: number) => String(value).padStart(2, '0');
/** Local wall-clock time, which is what every client must agree on. */
const wallClock = (date: Date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;

interface TaskDates {
  startDate: Date;
  endDate: Date;
  duration: number;
}

function recordRevisions(project: ProjectModel): ChangesInfo[] {
  const emitted: ChangesInfo[] = [];
  project.on({
    revisionNotification: (event: RevisionNotificationEvent) => {
      emitted.push(JSON.parse(JSON.stringify(event.changes)) as ChangesInfo);
    },
  });
  return emitted;
}

/** Waits until the engine and the STM have stopped producing revisions (follow-ups are recorded ~100 ms after a change). */
async function quiesce(project: ProjectModel, emitted: ChangesInfo[]): Promise<void> {
  let seen = -1;
  for (let round = 0; round < 12 && emitted.length !== seen; round++) {
    seen = emitted.length;
    await project.commitAsync();
    await sleep(200);
  }
}

async function inTimeZone<T>(tz: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.TZ;
  process.env.TZ = tz;
  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = previous;
    }
  }
}

/** Client A's edit: task 1 one day longer, unless the test edits something else. */
type Edit = (project: ProjectModel) => void;

const lengthenSiteSetup: Edit = (project) => {
  (project.taskStore.getById(1) as unknown as TaskDates).duration = 3;
};

/** Client A edits the project and records the revision it would submit. */
function produce(factory: Factory, edit: Edit = lengthenSiteSetup): Promise<ChangesInfo> {
  return inTimeZone(PRODUCER_TZ, async () => {
    expect(new Date(2026, 10, 2).getTimezoneOffset()).toBe(480);
    const project = factory();
    try {
      await loadCollaborativeProject(project, snapshot(), 'A', '0');
      const emitted = recordRevisions(project);
      edit(project);
      await quiesce(project, emitted);
      expect(emitted).toHaveLength(1);
      return emitted[0]!;
    } finally {
      project.destroy();
    }
  });
}

/** Client B applies A's revision and reports what it emitted in response. */
function consume(factory: Factory, changes: ChangesInfo): Promise<{ emitted: ChangesInfo[]; task2: string; projectEnd: string; deadline2: string | null }> {
  return inTimeZone(CONSUMER_TZ, async () => {
    expect(new Date(2026, 10, 2).getTimezoneOffset()).toBe(-60);
    const project = factory();
    try {
      await loadCollaborativeProject(project, snapshot(), 'B', '0');
      const emitted = recordRevisions(project);
      const revision: IncomingRevision = { revisionId: '1', localRevisionId: 'local-1', clientId: 'A', changes };
      await project.applyRevisions([revision]);
      await quiesce(project, emitted);
      const task2 = project.taskStore.getById(2) as unknown as TaskDates;
      const deadline = (task2 as TaskDates & { deadlineDate?: Date | null }).deadlineDate;
      return {
        emitted,
        task2: `${wallClock(task2.startDate)}..${wallClock(task2.endDate)}`,
        projectEnd: wallClock(project.endDate as Date),
        deadline2: deadline instanceof Date ? wallClock(deadline) : null,
      };
    } finally {
      project.destroy();
    }
  });
}

describe('a revision crossing time zones', () => {
  it('is applied in another zone without a corrective follow-up when every date is serialized without an offset', async () => {
    const changes = await produce(collaborative);
    const projectChanges = changes.project as { endDate?: string } | undefined;
    expect(projectChanges?.endDate).toMatch(TZ_LESS_DATE);
    for (const updated of changes.tasks?.updated ?? []) {
      for (const field of ['startDate', 'endDate'] as const) {
        if (typeof updated[field] === 'string') expect(updated[field]).toMatch(TZ_LESS_DATE);
      }
    }

    const consumed = await consume(collaborative, changes);
    expect(consumed.task2).toBe('2026-11-05T00:00..2026-11-08T00:00');
    expect(consumed.projectEnd).toBe('2026-11-08T00:00');
    expect(consumed.emitted).toEqual([]);
  }, 30_000);

  it('carries a task deadline (set in the task panel) without an offset: the other zone reads the same day', async () => {
    const setDeadline: Edit = (project) => {
      (project.taskStore.getById(2) as unknown as { deadlineDate: Date }).deadlineDate = new Date(2026, 10, 20);
    };
    const changes = await produce(collaborative, setDeadline);
    const input = changes.tasks?.$input?.updated ?? [];
    expect(input).toEqual([{ id: 2, deadlineDate: '2026-11-20T00:00:00' }]);
    const consumed = await consume(collaborative, changes);
    expect(consumed.deadline2).toBe('2026-11-20T00:00');
    expect(consumed.emitted).toEqual([]);

    // Plain Bryntum models would send the producer's offset with it.
    const plainChanges = await produce(plain, setDeadline);
    expect(plainChanges.tasks?.$input?.updated?.[0]?.deadlineDate).toMatch(WITH_OFFSET);
  }, 30_000);

  it('control: plain Bryntum models serialize the project endDate with an offset and the other zone answers with a corrective revision', async () => {
    const changes = await produce(plain);
    const projectChanges = changes.project as { endDate?: string } | undefined;
    expect(projectChanges?.endDate).toMatch(WITH_OFFSET);

    const consumed = await consume(plain, changes);
    expect(consumed.emitted).toHaveLength(1);
    const correction = consumed.emitted[0]!.project as { endDate?: string } | undefined;
    expect(correction?.endDate).toMatch(/\+01:00$/);
  }, 30_000);
});
