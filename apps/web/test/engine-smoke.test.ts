import { describe, it, expect } from 'vitest';
import { ProjectModel } from '@bryntum/gantt';

describe('Bryntum engine under jsdom', () => {
  it('schedules a two-task FS chain headlessly', async () => {
    const project = new ProjectModel({
      startDate: '2026-11-02',
      tasksData: [
        { id: 1, name: 'A', startDate: '2026-11-02', duration: 2 },
        { id: 2, name: 'B', duration: 3 },
      ],
      dependenciesData: [{ id: 1, fromEvent: 1, toEvent: 2 }],
    });
    await project.commitAsync();
    const b = project.taskStore.getById(2) as any;
    expect(b.startDate.toISOString().slice(0, 10)).toBe('2026-11-04');
    expect(b.endDate.toISOString().slice(0, 10)).toBe('2026-11-07');
    project.destroy();
  });
});
