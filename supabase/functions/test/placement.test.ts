/**
 * place-snippet: a member asks where a library piece belongs in a floor; Claude's answer is checked
 * against the floor's own tasks and the other groups for the same place (an id from elsewhere is
 * refused, never guessed), the model may move the piece to the group its work belongs in or say it
 * fits none, the precedent from another floor reaches the model, and without a key the browser is told
 * to use its own rules.
 */
import { describe, expect, it, vi } from 'vitest';
import { createPlacementHandler, PLACEMENT_SYSTEM, placementPrompt, readAnswer, readPlacementRequest, type AskModel, type PlacementDeps } from '../_shared/placement.ts';

const PROJECT = '00000000-0000-4000-8000-000000000002';
const USER = '00000000-0000-4000-8000-000000000012';

const body = {
  project_id: PROJECT,
  snippet: {
    name: 'Light fixtures',
    summary: 'Order, deliver, install and test the light fixtures of one floor',
    tasks: [
      { name: 'Order light fixtures', trade: null, days: 1 },
      { name: 'Install light fixtures', trade: 'Electrical', days: 4 },
    ],
  },
  group: {
    id: 200,
    name: 'Level 2 build-out',
    tasks: [
      { id: 213, name: 'Electrical rough-in, level 2', trade: 'Electrical', start: '2026-11-23', end: '2026-11-26', waits_for: [212] },
      { id: 214, name: 'Ceiling grid, level 2', trade: 'Ceilings', start: '2026-11-26', end: '2026-11-28', waits_for: [213] },
      { id: 216, name: 'Ceiling tiles, level 2', trade: 'Ceilings', start: '2026-11-30', end: '2026-12-02', waits_for: [214] },
    ],
  },
  dropped_after: 216,
  precedent: { group: 'Level 1 build-out', after: 'Ceiling grid, level 1', before: 'Ceiling tiles, level 1' },
};

function deps(overrides: Partial<PlacementDeps> = {}): PlacementDeps {
  return {
    env: { get: () => undefined },
    resolveUser: async (token) => (token === 'good' ? USER : null),
    isMember: async (projectId, userId) => projectId === PROJECT && userId === USER,
    ask: async () => JSON.stringify({ after_id: '214', before_id: '216', reason: 'Fixtures hang from the grid, so they go after it and before the tiles.' }),
    log: () => undefined,
    ...overrides,
  };
}

const post = (payload: unknown, token: string | null = 'good') =>
  new Request('http://local/place-snippet', { method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {}, body: JSON.stringify(payload) });

describe('readPlacementRequest', () => {
  it('reads ids as text and keeps the precedent', () => {
    const request = readPlacementRequest(body);
    expect(request.group.tasks.map((task) => task.id)).toEqual(['213', '214', '216']);
    expect(request.group.tasks[1]!.waits_for).toEqual(['213']);
    expect(request.dropped_after).toBe('216');
    expect(request.precedent).toEqual({ group: 'Level 1 build-out', after: 'Ceiling grid, level 1', before: 'Ceiling tiles, level 1' });
  });

  it('refuses a request without a project, a piece or a group', () => {
    expect(() => readPlacementRequest({ ...body, project_id: '' })).toThrow(/project_id/);
    expect(() => readPlacementRequest({ ...body, snippet: { name: 'X', tasks: [] } })).toThrow(/snippet/);
    expect(() => readPlacementRequest({ ...body, group: { id: 1, tasks: [] } })).toThrow(/group/);
  });
});

describe('placementPrompt', () => {
  it('lists the floor in order and tells the model how the piece went before', () => {
    const prompt = placementPrompt(readPlacementRequest(body));
    expect(prompt).toContain('- id 214: Ceiling grid, level 2 [Ceilings], 2026-11-26 to 2026-11-28, waits for 213');
    expect(prompt).toContain('On "Level 1 build-out" the same piece went after "Ceiling grid, level 1" and before "Ceiling tiles, level 1".');
    expect(prompt).toContain('The person let go just after task 216; that is only where the pointer was.');
  });
});

describe('readAnswer', () => {
  const request = readPlacementRequest(body);
  it('accepts tasks of the group, with a reason', () => {
    expect(readAnswer('{"after_id":"214","before_id":"216","fits":true,"reason":"After the grid."}', request)).toEqual({ after_id: '214', before_id: '216', reason: 'After the grid.', fits: true, source: 'model' });
    expect(readAnswer('{"after_id":214,"before_id":null,"reason":"Last."}', request).before_id).toBeNull();
  });

  it('refuses a task from outside the group, the same task twice, no reason, or no JSON', () => {
    expect(() => readAnswer('{"after_id":"999","before_id":null,"reason":"x"}', request)).toThrow(/not in the group/);
    expect(() => readAnswer('{"after_id":"214","before_id":"214","reason":"x"}', request)).toThrow(/wait/);
    expect(() => readAnswer('{"after_id":"214","before_id":null,"reason":""}', request)).toThrow(/reason/);
    expect(() => readAnswer('After the grid', request)).toThrow(/JSON/);
  });
});

/** Light fixtures let go on the concrete deck of level 1, with the floor's build-out offered beside it. */
const onTheDeck = {
  ...body,
  group: {
    id: 50,
    name: 'Concrete deck, level 1',
    tasks: [
      { id: 53, name: 'Pour deck, level 1', trade: 'Concrete', start: '2027-02-04', end: '2027-02-05', waits_for: [52] },
      { id: 54, name: 'Cure deck, level 1', trade: 'Concrete', start: '2027-02-05', end: '2027-02-09', waits_for: [53] },
    ],
  },
  other_groups: [
    {
      id: 100,
      name: 'Level 1 build-out',
      tasks: [
        { id: 114, name: 'Ceiling grid, level 1', trade: 'Ceilings', start: '2027-03-01', end: '2027-03-03', waits_for: [115] },
        { id: 116, name: 'Ceiling tiles, level 1', trade: 'Ceilings', start: '2027-03-03', end: '2027-03-05', waits_for: [114] },
      ],
    },
    { id: 50, name: 'The same group again', tasks: [{ id: 54, name: 'Cure deck, level 1' }] },
    { id: 300, name: 'No tasks', tasks: [] },
  ],
  dropped_after: 54,
  precedent: null,
};

describe('a piece let go in a group that is not for its kind of work', () => {
  const request = readPlacementRequest(onTheDeck);

  it('offers the model the other groups for the same place, and leaves out repeats and empty ones', () => {
    expect(request.other_groups.map((group) => group.name)).toEqual(['Level 1 build-out']);
    const prompt = placementPrompt(request);
    expect(prompt).toContain('It was let go in the group "Concrete deck, level 1".');
    expect(prompt).toContain('Another group for the same place: "Level 1 build-out". Its tasks, in plan order:');
    expect(prompt).toContain('- id 114: Ceiling grid, level 1 [Ceilings], 2027-03-01 to 2027-03-03, waits for 115');
  });

  it('accepts a place in the group its work belongs in, with what waits for it from that group only', () => {
    expect(readAnswer('{"after_id":"114","before_id":"116","fits":true,"reason":"Fixtures are build-out work, not concrete: after the grid on Level 1 build-out."}', request)).toMatchObject({ after_id: '114', before_id: '116', fits: true });
    expect(() => readAnswer('{"after_id":"114","before_id":"54","fits":true,"reason":"x"}', request)).toThrow(/wait/);
  });

  it('passes on that it fits nowhere it was offered, with the reason', () => {
    expect(readAnswer('{"after_id":"54","before_id":null,"fits":false,"reason":"Fixtures belong in a floor build-out, not a concrete deck."}', request)).toEqual({
      after_id: '54',
      before_id: null,
      reason: 'Fixtures belong in a floor build-out, not a concrete deck.',
      fits: false,
      source: 'model',
    });
  });

  it('tells the model to put work where its trade goes, and never to make up a reason', () => {
    expect(PLACEMENT_SYSTEM).toContain('Never put work in a group for another trade, and never make up a reason why it could go there');
  });
});

describe('the place-snippet handler', () => {
  it('answers a member with the model\'s placement', async () => {
    const ask = vi.fn<AskModel>(async () => JSON.stringify({ after_id: '214', before_id: '216', reason: 'Placed like Level 1: after the grid, before the tiles.' }));
    const response = await createPlacementHandler(deps({ ask }))(post(body));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ after_id: '214', before_id: '216', reason: 'Placed like Level 1: after the grid, before the tiles.', fits: true, source: 'model' });
    expect(ask.mock.calls[0]![0].schema).toMatchObject({ required: ['after_id', 'before_id', 'fits', 'reason'] });
  });

  it('refuses without a session (401) and for someone outside the project (403)', async () => {
    expect((await createPlacementHandler(deps())(post(body, null))).status).toBe(401);
    expect((await createPlacementHandler(deps())(post({ ...body, project_id: '00000000-0000-4000-8000-000000000009' }))).status).toBe(403);
  });

  it('says there is no model (503) so the browser places it by its rules, and reports a bad answer (502)', async () => {
    const none = await createPlacementHandler(deps({ ask: null }))(post(body));
    expect(none.status).toBe(503);
    expect(await none.json()).toMatchObject({ code: 'MODEL_NOT_CONFIGURED' });
    const wrong = await createPlacementHandler(deps({ ask: async () => '{"after_id":"999","before_id":null,"reason":"x"}' }))(post(body));
    expect(wrong.status).toBe(502);
    expect(await wrong.json()).toMatchObject({ code: 'MODEL_UNAVAILABLE' });
  });

  it('answers the CORS preflight and refuses other methods', async () => {
    expect((await createPlacementHandler(deps())(new Request('http://local/place-snippet', { method: 'OPTIONS' }))).status).toBe(200);
    expect((await createPlacementHandler(deps())(new Request('http://local/place-snippet', { method: 'GET' }))).status).toBe(405);
  });
});
