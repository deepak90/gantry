/** Which tasks a card from the assistant is about, so that a 3D view can go to them. */
import { describe, expect, it } from 'vitest';
import { tasksOfCard } from '../../src/assistant/card-tasks';

describe('the tasks a card is about', () => {
  it('reads them from the cards that name tasks', () => {
    expect(tasksOfCard('show_issue_card', { task_ids: [15] })).toEqual([15]);
    expect(tasksOfCard('show_tasks', { task_ids: [1, 2] })).toEqual([1, 2]);
    expect(tasksOfCard('show_task', { task_id: 7 })).toEqual([7]);
  });

  it('takes the first problem of a list of findings, the one on top', () => {
    expect(tasksOfCard('show_findings', { findings: [{ task_ids: [] }, { task_ids: [4, 5] }, { task_ids: [6] }] })).toEqual([4, 5]);
  });

  it('takes the existing tasks a drafted change touches, once each', () => {
    const operations = [{ op: 'update_task', task: 3 }, { op: 'link', from: 3, to: 4 }, { op: 'add_task', name: 'New' }];
    expect(tasksOfCard('show_plan_edit', { operations })).toEqual([3, 4]);
  });

  it('has none for a card about no task, or one stored before cards named them', () => {
    expect(tasksOfCard('show_choices', { options: [] })).toEqual([]);
    expect(tasksOfCard('show_issue_card', { issue_id: 'x' })).toEqual([]);
    expect(tasksOfCard('show_tasks', { task_ids: 'nonsense' })).toEqual([]);
  });
});
