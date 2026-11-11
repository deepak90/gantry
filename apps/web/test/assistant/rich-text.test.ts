/**
 * Links in the assistant's text: the task links it writes, the plan's own names it mentions (a task
 * whose name is unique, a crew), and amounts it left out.
 */
import { describe, expect, it } from 'vitest';
import { planEntities, taskPieces } from '../../src/assistant/rich-text';
import { newProject } from '../sync/helpers';

async function load() {
  const project = newProject();
  await project.loadInlineData({
    tasksData: [
      { id: 1, name: 'Steel frame', children: [{ id: 2, name: 'Erect structural steel frame', duration: 2 }, { id: 3, name: 'Grout base plates', duration: 1 }] },
      { id: 4, name: 'Grout base plates', duration: 1 },
      { id: 5, name: 'Roof', duration: 1 },
    ],
    resourcesData: [
      { id: 1, name: 'Crane' },
      { id: 2, name: 'Castlegate Steel' },
    ],
  });
  await project.commitAsync();
  return project;
}

describe('the plan’s names in a reply', () => {
  it('links unique task names and crews, longest first, and keeps written links', async () => {
    const entities = planEntities(await load());
    expect(taskPieces('Castlegate Steel can start Erect structural steel frame once the crane is there; see [the roof](task:5).', entities)).toEqual([
      { label: 'Castlegate Steel', crew: 'Castlegate Steel' },
      ' can start ',
      { label: 'Erect structural steel frame', taskId: 2 },
      ' once the ',
      { label: 'crane', crew: 'Crane' },
      ' is there; see ',
      { label: 'the roof', taskId: 5 },
      '.',
    ]);
  });

  it('leaves a name two tasks share, short names and parts of words alone', async () => {
    const entities = planEntities(await load());
    expect(taskPieces('Grout base plates twice; the Roof; cranes', entities)).toEqual(['Grout base plates twice; the Roof; cranes']);
  });

  it('shows a left-out amount as its own piece', () => {
    expect(taskPieces('The idle days cost [amount withheld] in all.')).toEqual(['The idle days cost ', { withheld: true }, ' in all.']);
  });
});
