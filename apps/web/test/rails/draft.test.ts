/**
 * Which line of an open package your words are about, read from the editor's rows as Bryntum draws
 * them: the row number in its own cell, right before the task's name.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { namedTaskFor, taskFor } from '../../src/rails/draft';

const row = (number: number, name: string, crew: string, cost: string) =>
  `<div class="b-grid-row"><div class="b-grid-cell" data-column="wbs">${number}</div><div class="b-grid-cell" data-column="name">${name}</div><div class="b-grid-cell" data-column="duration">2 days</div><div class="b-grid-cell" data-column="resourceassignment">${crew}</div><div class="b-grid-cell" data-column="costs">${cost}</div></div>`;

function draft(): void {
  document.body.innerHTML = `<div data-testid="snippet-gantt">${[
    row(1, 'Order light fixtures', 'Halden Electrical 100%', '$7,500'),
    row(2, 'Deliver light fixtures', 'Halden Electrical 100%', ''),
    row(3, 'Install light fixtures', 'Halden Electrical 100%', '$6,200'),
    row(4, 'Test light fixtures', 'Halden Electrical 100%', '$900'),
  ].join('')}</div>`;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('the line your words are about', () => {
  it('finds the task by the first word of its name, not just the most expensive one', () => {
    draft();
    expect(taskFor('the install')?.name).toBe('Install light fixtures');
    expect(taskFor('installation')?.name).toBe('Install light fixtures');
    expect(taskFor('testing')?.name).toBe('Test light fixtures');
  });

  it('takes the fixtures to be the ones bought, and falls back to what costs most', () => {
    draft();
    expect(taskFor('the fixtures')?.name).toBe('Order light fixtures');
    expect(taskFor('light fixtures')?.name).toBe('Order light fixtures');
    expect(taskFor('it')?.name).toBe('Order light fixtures');
  });

  it('names no line for a word the draft has no line for, so the person is asked', () => {
    draft();
    expect(namedTaskFor('the wiring')).toBeNull();
    expect(namedTaskFor('the install')?.name).toBe('Install light fixtures');
    expect(namedTaskFor('the fixtures')?.name).toBe('Order light fixtures');
  });

  it('reads a crew too, below a task named outright', () => {
    draft();
    expect(taskFor('the electrician')?.name).toBe('Order light fixtures');
  });
});
