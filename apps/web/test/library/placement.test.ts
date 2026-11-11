/**
 * Where a dropped piece belongs in its floor: the assistant's answer when it gives one from the
 * floor's own tasks (or from another group for the same place, when the piece's work belongs there),
 * the browser's rules when it cannot be asked (or answers with a task from elsewhere), what the
 * assistant is told, and the placement remembered for the next floor. Light fixtures let go on a
 * floor's concrete deck go to its build-out, never after the cure.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectModel, TaskModel } from '@bryntum/gantt';
import { defaultTweaks, planSnippet, type Snippet } from '@collab/shared';
import { harborOffices } from '@collab/shared/seed';
import { createProjectModel, loadProjectInlineData } from '../../src/gantt/project';
import { placementFor } from '../../src/library/insert';
import { fitOf, forgetPlacements, groupOfPlacement, pieceWorkOf, placeInGroup, placementRequest, precedentFor, rememberPlacement, samePlaceGroups, type AskPlacement } from '../../src/library/placement';

const PROJECT = '00000000-0000-4000-8000-000000000002';

const fixtures: Snippet = {
  id: 'light-fixtures',
  name: 'Light fixtures',
  summary: 'Install and test the light fixtures of one floor',
  icon: 'lightbulb',
  unit: { one: 'floor', many: 'floors' },
  children: [
    { key: 'install', name: 'Install light fixtures', duration: 3, crews: [{ name: 'Electrical' }] },
    { key: 'test', name: 'Test the lighting', duration: 1 },
  ],
  links: [{ from: 'install', to: 'test' }],
};
const plan = planSnippet(fixtures, defaultTweaks(fixtures));

/** What hangs from the grid but isn't lights: the assistant is asked where it goes. */
const diffusers: Snippet = {
  id: 'air-diffusers',
  name: 'Air diffusers',
  summary: 'Set and connect the ceiling diffusers of one floor',
  icon: 'fan',
  unit: { one: 'floor', many: 'floors' },
  children: [
    { key: 'install', name: 'Install air diffusers', duration: 2, crews: [{ name: 'Electrical' }] },
    { key: 'balance', name: 'Balance the air diffusers', duration: 1 },
  ],
  links: [{ from: 'install', to: 'balance' }],
};
const diffuserPlan = planSnippet(diffusers, defaultTweaks(diffusers));

let project: ProjectModel;
beforeEach(async () => {
  project = createProjectModel();
  await loadProjectInlineData(project, structuredClone(harborOffices.inlineData));
  forgetPlacements(PROJECT);
});
afterEach(() => {
  project.destroy();
  forgetPlacements(PROJECT);
});

const task = (id: number) => project.taskStore.getById(id) as TaskModel;

describe('placing a piece in its floor', () => {
  it('tells the assistant the piece, the floor in order with trades and links, and where it was let go', () => {
    const placement = placementFor(task(117), 'after');
    expect(groupOfPlacement(placement)?.id).toBe(100);
    const body = placementRequest(PROJECT, plan, placement, task(100), null);
    expect(body.snippet.tasks).toEqual([
      { name: 'Install light fixtures', trade: 'Electrical', days: 3 },
      { name: 'Test the lighting', trade: null, days: 1 },
    ]);
    expect(body.group.tasks.map((entry) => entry.name)).toEqual(harborOffices.inlineData.tasksData.find((phase) => phase.id === 100)!.children!.map((child) => child.name));
    expect(body.group.tasks.find((entry) => entry.id === '114')).toMatchObject({ trade: 'Ceilings', waits_for: ['115'] });
    expect(body.dropped_after).toBe('117');
  });

  it('takes the assistant\'s answer when it names tasks of the floor', async () => {
    const ask = vi.fn<AskPlacement>(async () => ({ after_id: '114', before_id: '116', reason: 'Diffusers hang from the grid.' }));
    const found = await placeInGroup(ask, PROJECT, diffuserPlan, placementFor(task(117), 'after'), null);
    expect(found?.suggestion).toEqual({ afterId: 114, beforeId: 116, reason: 'Diffusers hang from the grid.', source: 'model' });
  });

  it('falls back to the trade order when the assistant cannot answer, or names a task from elsewhere', async () => {
    const down = await placeInGroup(async () => Promise.reject(new Error('no model')), PROJECT, diffuserPlan, placementFor(task(117), 'after'), null);
    expect(down?.suggestion).toMatchObject({ afterId: 114, beforeId: 116, source: 'rules' });
    const wrong = await placeInGroup(async () => ({ after_id: '214', before_id: null, reason: 'Level 2?' }), PROJECT, diffuserPlan, placementFor(task(117), 'after'), null);
    expect(wrong?.suggestion).toMatchObject({ afterId: 114, source: 'rules' });
    expect(await placeInGroup(null, PROJECT, diffuserPlan, placementFor(task(100), 'after'), null)).toBeNull();
  });

  it('puts light fixtures in a lay-in ceiling in with the tiles at once, without asking', async () => {
    const ask = vi.fn<AskPlacement>();
    const found = await placeInGroup(ask, PROJECT, plan, placementFor(task(117), 'after'), null);
    expect(ask).not.toHaveBeenCalled();
    expect(found?.group.name).toBe('Level 1 build-out');
    expect(found?.suggestion).toMatchObject({ afterId: 116, beforeId: null, source: 'rules', mode: 'alongside' });
  });

  it('remembers where a piece went, and the next floor follows it by its rules too', async () => {
    rememberPlacement(PROJECT, diffusers.id, { group: 'Level 1 build-out', after: 'Ceiling grid, level 1', before: 'Ceiling tiles, level 1' });
    const precedent = precedentFor(PROJECT, diffusers.id);
    expect(precedent?.after).toBe('Ceiling grid, level 1');
    const found = await placeInGroup(null, PROJECT, diffuserPlan, placementFor(task(318), 'after'), precedent);
    expect(found?.suggestion).toMatchObject({ afterId: 314, beforeId: 316, source: 'rules' });
    expect(found?.suggestion.reason).toBe('Placed like Level 1 build-out: after Ceiling grid, level 3, before Ceiling tiles, level 3.');
  });
});

/** Harbor's own light fixtures package, as saved: the electricians install and test, the freight firm delivers. */
const harborFixtures: Snippet = {
  id: 'harbor-fixtures',
  name: 'Light fixtures, levels 1 to 3',
  summary: 'Order once for all floors, then deliver, install and test',
  icon: 'lightbulb',
  unit: { one: 'floor', many: 'floors' },
  children: [
    { key: 'order', name: 'Order light fixtures, levels 1 to 3', duration: 1, crews: [{ name: 'Halden Electrical' }] },
    { key: 'deliver', name: 'Deliver light fixtures', duration: 1, crews: [{ name: 'Carrow Freight' }] },
    { key: 'install', name: 'Install light fixtures', duration: 3, crews: [{ name: 'Halden Electrical' }] },
    { key: 'test', name: 'Test and commission lighting', duration: 1, crews: [{ name: 'Halden Electrical' }] },
  ],
  links: [
    { from: 'order', to: 'deliver' },
    { from: 'deliver', to: 'install' },
    { from: 'install', to: 'test' },
  ],
};
const harborPlan = planSnippet(harborFixtures, defaultTweaks(harborFixtures));

describe('a piece let go in a group that is not for its kind of work', () => {
  it('knows a floor’s concrete deck and its build-out are the same place', () => {
    expect(samePlaceGroups(project, task(50)).map((group) => group.name)).toEqual(['Level 1 build-out']);
    expect(samePlaceGroups(project, task(100)).map((group) => group.name)).toEqual(['Concrete deck, level 1']);
    // "Structure" names no place: nothing else is offered.
    expect(samePlaceGroups(project, task(40))).toEqual([]);
  });

  it('scores the fixtures’ fit by the trades that do the work there, and the stage of work', () => {
    const piece = pieceWorkOf(harborFixtures);
    expect(fitOf(project, piece, task(50))).toBe(0);
    // The electricians do the rough-in there (2), and it is build-out work (1).
    expect(fitOf(project, piece, task(100))).toBe(3);
  });

  it('tells the assistant about the floor’s build-out too, so it can say the piece belongs there', () => {
    const placement = placementFor(task(54), 'after');
    const body = placementRequest(PROJECT, harborPlan, placement, task(50), null, samePlaceGroups(project, task(50)));
    expect(body.group.name).toBe('Concrete deck, level 1');
    expect(body.other_groups.map((group) => group.name)).toEqual(['Level 1 build-out']);
    expect(body.other_groups[0]!.tasks.find((entry) => entry.id === '114')).toMatchObject({ name: 'Ceiling grid, level 1', trade: 'Ceilings' });
  });

  it('takes the assistant’s place in the build-out, and keeps what waits to the same group', async () => {
    const ask = vi.fn<AskPlacement>(async () => ({ after_id: '114', before_id: '54', reason: 'Fixtures are build-out work, not concrete.', fits: true }));
    const found = await placeInGroup(ask, PROJECT, harborPlan, placementFor(task(54), 'after'), null);
    expect(found?.group.name).toBe('Level 1 build-out');
    expect(found?.suggestion).toEqual({ afterId: 114, beforeId: null, reason: 'Fixtures are build-out work, not concrete.', source: 'model' });
    expect(ask.mock.calls[0]![0].other_groups.map((group) => group.id)).toEqual(['100']);
  });

  it('passes on that it fits none of the groups, so the card says so', async () => {
    const ask = vi.fn<AskPlacement>(async () => ({ after_id: '54', before_id: null, reason: 'Fixtures belong in a build-out, not a concrete deck.', fits: false }));
    const found = await placeInGroup(ask, PROJECT, harborPlan, placementFor(task(54), 'after'), null);
    expect(found?.group.name).toBe('Concrete deck, level 1');
    expect(found?.suggestion).toMatchObject({ afterId: 54, fits: false });
  });

  it('by its rules too: in with the tiles of the build-out, never after the cure', async () => {
    const found = await placeInGroup(null, PROJECT, harborPlan, placementFor(task(54), 'after'), null);
    expect(found?.group.name).toBe('Level 1 build-out');
    expect(found?.suggestion).toMatchObject({ afterId: 116, beforeId: null, source: 'rules', mode: 'alongside' });
    expect(found?.suggestion.reason).toMatch(/^Light fixtures, levels 1 to 3 isn’t work for Concrete deck, level 1: it goes in Level 1 build-out\. /);
  });

  it('leaves a piece where it was let go when that group does its kind of work', async () => {
    const found = await placeInGroup(null, PROJECT, harborPlan, placementFor(task(117), 'after'), null);
    expect(found?.group.name).toBe('Level 1 build-out');
    expect(found?.suggestion).toMatchObject({ afterId: 116, beforeId: null, mode: 'alongside' });
    expect(found?.suggestion.reason).not.toMatch(/isn’t work for/);
  });
});

