import { describe, expect, it } from 'vitest';
import { createProjectModel } from '../../src/gantt/project';

const inTime = <T>(work: Promise<T>) =>
  Promise.race([work, new Promise<'never answered'>((resolve) => setTimeout(() => resolve('never answered'), 2_000))]);

describe('a real loop on a project with no screen', () => {
  it('is refused, not left waiting for an answer nobody can give', async () => {
    // Previews and scenario evaluation run on copies like this one: nothing there can answer a pop-up.
    const project = createProjectModel();
    await project.loadInlineData({
      project: { startDate: '2027-01-04T00:00:00' },
      tasks: [
        { id: 1, name: 'First', startDate: '2027-01-04T00:00:00', duration: 2 },
        { id: 2, name: 'Second', startDate: '2027-01-06T00:00:00', duration: 2 },
      ],
      dependencies: [{ id: 1, fromEvent: 1, toEvent: 2 }],
    });
    await project.commitAsync();
    project.dependencyStore.add({ id: 2, fromEvent: 2, toEvent: 1 } as never);
    const result = await inTime(project.commitAsync());
    expect(result).not.toBe('never answered');
    expect((result as { rejectedWith?: unknown }).rejectedWith).toBeTruthy();
    expect(project.dependencyStore.count).toBe(1);
  });
});
