/**
 * The session's database functions as this page calls them: the object or a one-row table read the same, the name
 * asked for passed only when there is one, a code that matches no session turned into a refusal in the server's
 * words, "every session in use", a wait and a sign-in that has had its session told apart, and the site's switches
 * read with everything else off.
 */
import { describe, expect, it } from 'vitest';
import {
  claimCopy,
  CopyError,
  DEFAULT_WAIT_S,
  isAllInUse,
  isSessionUsed,
  joinCopy,
  joinCopyByCode,
  loadAppFlags,
  namesTaken,
  NO_MATCH,
  releaseCopy,
  touchCopy,
  waitOf,
  type CopyClient,
} from '../../src/copy/rpc';

type Answer = { data: unknown; error: { message: string; code?: string; details?: string } | null };

function fakeClient(answers: Record<string, Answer>) {
  const calls: [string, unknown][] = [];
  const client: CopyClient = {
    rpc: async (fn, args) => {
      calls.push([fn, args]);
      return answers[fn] ?? { data: null, error: null };
    },
    from: (table) => ({
      select: async () => answers[`from:${table}`] ?? { data: [], error: null },
    }),
  };
  return { client, calls };
}

const ROW = { project_id: 'p-1', join_token: 'tok_1', join_code: '482917', lease_until: '2026-11-11T18:30:00Z', display_name: 'Riley Brooks' };
const SESSION = { projectId: 'p-1', joinToken: 'tok_1', code: '482917', leaseUntil: '2026-11-11T18:30:00Z', name: 'Riley Brooks' };

describe('the session’s functions', () => {
  it('claims a session, from an object or a one-row table, asking for a name only when there is one', async () => {
    for (const data of [ROW, [ROW]]) {
      const { client, calls } = fakeClient({ claim_copy: { data, error: null } });
      await expect(claimCopy(client)).resolves.toEqual(SESSION);
      await expect(claimCopy(client, 'Riley Brooks')).resolves.toEqual(SESSION);
      expect(calls).toEqual([
        ['claim_copy', undefined],
        ['claim_copy', { p_name: 'Riley Brooks' }],
      ]);
    }
  });

  it('reads a claim from before codes and names', async () => {
    const { client } = fakeClient({ claim_copy: { data: { project_id: 'p-1', join_token: 'tok_1', lease_until: null }, error: null } });
    await expect(claimCopy(client)).resolves.toEqual({ projectId: 'p-1', joinToken: 'tok_1', code: null, leaseUntil: null, name: null });
  });

  it('joins with the token, keeping it when the answer leaves it out, and touches and releases by project', async () => {
    const { client, calls } = fakeClient({
      join_copy: { data: { project_id: 'p-2', join_code: '615203', lease_until: '2026-11-11T19:00:00Z', display_name: 'Avery Patel' }, error: null },
      touch_copy: { data: { lease_until: '2026-11-11T19:00:00Z', join_code: '615203' }, error: null },
    });
    await expect(joinCopy(client, 'tok_2', 'Avery Patel')).resolves.toEqual({
      projectId: 'p-2',
      joinToken: 'tok_2',
      code: '615203',
      leaseUntil: '2026-11-11T19:00:00Z',
      name: 'Avery Patel',
    });
    await expect(touchCopy(client, 'p-2')).resolves.toEqual({ leaseUntil: '2026-11-11T19:00:00Z', code: '615203' });
    await releaseCopy(client, 'p-2');
    expect(calls).toEqual([
      ['join_copy', { p_token: 'tok_2', p_name: 'Avery Patel' }],
      ['touch_copy', { p_project: 'p-2' }],
      ['release_copy', { p_project: 'p-2' }],
    ]);
  });

  it('joins with a code, and turns a code that matches nothing into a refusal in the server’s words', async () => {
    const joined = fakeClient({ join_copy_by_code: { data: ROW, error: null } });
    await expect(joinCopyByCode(joined.client, '482917')).resolves.toEqual(SESSION);
    expect(joined.calls).toEqual([['join_copy_by_code', { p_code: '482917' }]]);

    const missed = fakeClient({
      join_copy_by_code: { data: { error: 'no_match', message: 'That code doesn’t match a session that’s open now.', tries_left: 7 }, error: null },
    });
    const error = await joinCopyByCode(missed.client, '111111', 'Devon Park').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CopyError);
    expect((error as CopyError).message).toBe('That code doesn’t match a session that’s open now.');
    expect((error as CopyError).code).toBe(NO_MATCH);
    expect((error as CopyError).refused).toBe(true);
    expect(missed.calls).toEqual([['join_copy_by_code', { p_code: '111111', p_name: 'Devon Park' }]]);
  });

  it('keeps the words of too many wrong codes', async () => {
    const { client } = fakeClient({
      join_copy_by_code: { data: null, error: { message: 'Too many wrong codes. Try again in 10 minutes, or ask for the invite link.', code: 'PT429' } },
    });
    const error = (await joinCopyByCode(client, '111111').catch((caught: unknown) => caught)) as CopyError;
    expect(error.message).toBe('Too many wrong codes. Try again in 10 minutes, or ask for the invite link.');
    expect(error.refused).toBe(true);
  });

  it('reads the names in use in an invite’s session, and none when that can’t be told', async () => {
    const { client, calls } = fakeClient({ copy_names_taken: { data: ['Riley Brooks', 'Avery Patel'], error: null } });
    await expect(namesTaken(client, 'tok_1')).resolves.toEqual(['Riley Brooks', 'Avery Patel']);
    expect(calls).toEqual([['copy_names_taken', { p_token: 'tok_1' }]]);
    await expect(namesTaken(fakeClient({ copy_names_taken: { data: null, error: { message: 'boom', code: '500' } } }).client, 'tok_1')).resolves.toEqual([]);
    await expect(namesTaken(fakeClient({ copy_names_taken: { data: 'nonsense', error: null } }).client, 'tok_1')).resolves.toEqual([]);
  });

  it('reads a touch that answers with the time alone, or with nothing', async () => {
    await expect(touchCopy(fakeClient({ touch_copy: { data: '2026-11-11T19:00:00Z', error: null } }).client, 'p')).resolves.toEqual({ leaseUntil: '2026-11-11T19:00:00Z', code: null });
    await expect(touchCopy(fakeClient({ touch_copy: { data: null, error: null } }).client, 'p')).resolves.toEqual({ leaseUntil: null, code: null });
  });

  it('keeps the server’s words for a refusal, and tells a refusal from a lost request', async () => {
    const refused = fakeClient({ join_copy: { data: null, error: { message: 'join_copy: This session already has 5 people in it.', code: '53300' } } });
    const error = await joinCopy(refused.client, 'tok').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CopyError);
    expect((error as CopyError).message).toBe('This session already has 5 people in it.');
    expect((error as CopyError).refused).toBe(true);

    const lost = fakeClient({ touch_copy: { data: null, error: { message: 'TypeError: Failed to fetch', code: '' } } });
    const failure = await touchCopy(lost.client, 'p').catch((caught: unknown) => caught);
    expect((failure as CopyError).refused).toBe(false);
  });

  it('reads how long a network must wait, and why, from a refusal’s details', async () => {
    const details = JSON.stringify({ count: 1, reason: 'gap', retry_after: 105 });
    const { client } = fakeClient({
      claim_copy: { data: null, error: { message: 'A session was just started on your network. You can start a new session in 2 minutes.', code: 'PT429', details } },
    });
    const error = (await claimCopy(client).catch((caught: unknown) => caught)) as CopyError;
    expect(error.message).toBe('A session was just started on your network. You can start a new session in 2 minutes.');
    expect(error.details).toBe(details);
    expect(waitOf(error)).toEqual({ seconds: 105, reason: 'gap' });
    expect(isAllInUse(error)).toBe(false);
    expect(isSessionUsed(error)).toBe(false);

    expect(waitOf(new CopyError('Too many messages for now.', 'PT429', JSON.stringify({ kind: 'message', limit: 'user', retry_after: 59.2 })))).toEqual({ seconds: 60, reason: null });
    expect(waitOf(new CopyError('Too many tries for now.', 'PT429'))).toEqual({ seconds: DEFAULT_WAIT_S, reason: null });
    expect(waitOf(new CopyError('Too many tries for now.', 'PT429', 'not json'))).toEqual({ seconds: DEFAULT_WAIT_S, reason: null });
    expect(waitOf(new CopyError('Every session is in use right now.', '53000'))).toBeNull();
    expect(waitOf(new Error('PT429'))).toBeNull();
  });

  it('tells a sign-in that has had its session apart', () => {
    expect(isSessionUsed(new CopyError('You’ve already started a session from this page. Reload the page to start a new one.', 'PT403'))).toBe(true);
    expect(isSessionUsed(new CopyError('claim_copy: sign in first', '42501'))).toBe(false);
    expect(isSessionUsed(new Error('PT403'))).toBe(false);
  });

  it('tells "every session is in use" apart from other refusals', () => {
    expect(isAllInUse(new CopyError('Every session is in use right now. Please try again in a few minutes.', '53000'))).toBe(true);
    expect(isAllInUse(new CopyError('All copies are in use right now. Try again in a few minutes.', 'P0001'))).toBe(true);
    expect(isAllInUse(new CopyError('No free sessions.', 'P0001'))).toBe(true);
    expect(isAllInUse(new CopyError('Not signed in.', '42501'))).toBe(false);
    expect(isAllInUse(new CopyError('Every session is in use', ''))).toBe(false);
    expect(isAllInUse(new Error('Every session is in use'))).toBe(false);
  });

  it('reads the site’s switches, with anything not said off', async () => {
    const { client } = fakeClient({ 'from:app_flags': { data: [{ key: 'live_ai', enabled: true }, { key: 'live_calls', enabled: false }, { key: 'something_else', enabled: true }], error: null } });
    await expect(loadAppFlags(client)).resolves.toEqual({ live_ai: true, live_calls: false, live_payments: false });
  });
});
