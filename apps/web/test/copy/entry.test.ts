/**
 * The way into a session on the hosted site: the human check and an anonymous sign-in, then claim_copy (or join_copy
 * for an invite link, join_copy_by_code for a code) under the name picked; a remembered session is touched and
 * opened; every session in use, a session that was reset and an invite that didn't work each have their own screen;
 * a code that doesn't work is said beside the code field. A sign-in has one session, ever: Start over, a new session
 * after a reset and trying again when every session was in use sign this tab out and start from the check again; a
 * network that must wait is shown a countdown, and the sign-in that waited starts the session once it is over.
 */
import type { Session } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { CopyEntry, type EntryDeps } from '../../src/copy/entry';
import { CopyError, FLAGS_OFF, NO_MATCH, type AppFlags, type Copy, type Touch } from '../../src/copy/rpc';

const session = (id = 'user-1'): Session => ({ access_token: `jwt-${id}`, user: { id } }) as unknown as Session;

const COPY: Copy = { projectId: 'project-7', joinToken: 'token-7', code: '482917', leaseUntil: '2026-11-11T18:30:00Z', name: 'Jordan Ellis' };
const NEXT: Copy = { projectId: 'project-8', joinToken: 'token-8', code: '193746', leaseUntil: '2026-11-11T19:30:00Z', name: 'Jordan Ellis' };
const JOINED: Copy = { projectId: 'project-9', joinToken: 'invite-abc', code: '615203', leaseUntil: '2026-11-11T18:40:00Z', name: 'Avery Patel' };
const FLAGS: AppFlags = { live_ai: true, live_calls: true, live_payments: false };
const NOW = Date.parse('2026-11-11T18:00:00Z');

/** What PostgREST answers when a network must wait: PT429, with how long and why in the details. */
const tooSoon = (seconds: number, reason = 'gap') =>
  new CopyError('A session was just started on your network. You can start a new session in 2 minutes.', 'PT429', JSON.stringify({ count: 1, reason, retry_after: seconds }));
const used = () => new CopyError('You’ve already started a session from this page. Reload the page to start a new one.', 'PT403');

function fakeDeps(overrides: Partial<EntryDeps> = {}) {
  let stored: { userId: string; copy: Copy } | null = null;
  let signIns = 0;
  let clock = NOW;
  const events: [string, unknown][] = [];
  const deps: EntryDeps = {
    getSession: vi.fn(async () => null),
    signInAnonymously: vi.fn(async () => session(signIns++ === 0 ? 'user-1' : `user-${signIns}`)),
    signOut: vi.fn(async () => undefined),
    claimCopy: vi.fn(async () => COPY),
    joinCopy: vi.fn(async () => JOINED),
    joinCopyByCode: vi.fn(async () => JOINED),
    namesTaken: vi.fn(async () => ['Riley Brooks']),
    touchCopy: vi.fn(async (): Promise<Touch> => ({ leaseUntil: '2026-11-11T19:00:00Z', code: '482917' })),
    releaseCopy: vi.fn(async () => undefined),
    loadFlags: vi.fn(async () => FLAGS),
    readCopy: vi.fn((userId: string) => (stored && stored.userId === userId ? stored.copy : null)),
    writeCopy: vi.fn((userId: string, copy: Copy) => {
      stored = { userId, copy };
    }),
    forgetCopy: vi.fn(() => {
      stored = null;
    }),
    joinToken: null,
    joinCode: null,
    clearInvite: vi.fn(),
    report: (event, props) => void events.push([event, props]),
    now: () => clock,
    ...overrides,
  };
  return {
    deps,
    events,
    remember: (userId: string, copy: Copy) => {
      stored = { userId, copy };
    },
    get stored() {
      return stored;
    },
    /** Time passes. */
    later: (ms: number) => {
      clock += ms;
    },
  };
}

const WELCOME = { kind: 'welcome', signedIn: false, again: false, error: null, taken: [], code: null, name: null } as const;

describe('CopyEntry', () => {
  it('asks a newcomer for the human check, then signs in anonymously with its token and starts a session under the name picked', async () => {
    const fake = fakeDeps();
    const entry = new CopyEntry(fake.deps);
    await entry.start();
    expect(entry.state).toEqual({ ...WELCOME, mode: 'claim' });

    await entry.go('turnstile-token', 'Jordan Ellis');
    expect(fake.deps.signInAnonymously).toHaveBeenCalledWith('turnstile-token');
    expect(fake.deps.signOut).not.toHaveBeenCalled();
    expect(fake.deps.claimCopy).toHaveBeenCalledWith('Jordan Ellis');
    expect(entry.state).toMatchObject({ kind: 'ready', copy: COPY, flags: FLAGS, generation: 1 });
    expect(fake.stored).toEqual({ userId: 'user-1', copy: COPY });
    expect(fake.events).toContainEqual(['copy_claimed', { via: 'welcome' }]);
  });

  it('joins the session an invite link is for, suggesting a name nobody there has, and takes the invite out of the address', async () => {
    const fake = fakeDeps({ joinToken: 'invite-abc' });
    const entry = new CopyEntry(fake.deps);
    await entry.start();
    expect(fake.deps.namesTaken).toHaveBeenCalledWith('invite-abc');
    expect(entry.state).toEqual({ ...WELCOME, mode: 'join', taken: ['Riley Brooks'] });
    expect(fake.events).toContainEqual(['join_opened', { signed_in: false, via: 'link' }]);

    await entry.go('turnstile-token', 'Avery Patel');
    expect(fake.deps.joinCopy).toHaveBeenCalledWith('invite-abc', 'Avery Patel');
    expect(fake.deps.claimCopy).not.toHaveBeenCalled();
    expect(fake.deps.clearInvite).toHaveBeenCalled();
    expect(entry.state).toMatchObject({ kind: 'ready', copy: JOINED });
    expect(fake.stored?.copy.code).toBe('615203');
  });

  it('joins straight away when the invite is opened by someone already signed in, keeping their name', async () => {
    const fake = fakeDeps({ joinToken: 'invite-abc', getSession: async () => session('user-2') });
    const entry = new CopyEntry(fake.deps);
    await entry.start();
    expect(fake.deps.signInAnonymously).not.toHaveBeenCalled();
    expect(fake.deps.joinCopy).toHaveBeenCalledWith('invite-abc', null);
    expect(entry.state).toMatchObject({ kind: 'ready', copy: { projectId: 'project-9' } });
    expect(fake.events).toContainEqual(['join_opened', { signed_in: true, via: 'link' }]);
  });

  it('opens the session this browser is in after touching it, without claiming another, and learns its code', async () => {
    const fake = fakeDeps({ getSession: async () => session() });
    fake.remember('user-1', { ...COPY, code: null });
    const entry = new CopyEntry(fake.deps);
    await entry.start();
    expect(fake.deps.touchCopy).toHaveBeenCalledWith('project-7');
    expect(fake.deps.claimCopy).not.toHaveBeenCalled();
    expect(entry.state).toMatchObject({ kind: 'ready', copy: { ...COPY, leaseUntil: '2026-11-11T19:00:00Z', code: '482917' } });
    expect(fake.stored?.copy.code).toBe('482917');
  });

  it('opens the remembered session for its own invite or code, but joins another for someone else’s', async () => {
    const own = fakeDeps({ getSession: async () => session(), joinToken: 'token-7' });
    own.remember('user-1', COPY);
    const first = new CopyEntry(own.deps);
    await first.start();
    expect(own.deps.joinCopy).not.toHaveBeenCalled();
    expect(first.state).toMatchObject({ kind: 'ready', copy: { projectId: 'project-7' } });

    const ownCode = fakeDeps({ getSession: async () => session(), joinCode: '482917' });
    ownCode.remember('user-1', COPY);
    const second = new CopyEntry(ownCode.deps);
    await second.start();
    expect(ownCode.deps.joinCopyByCode).not.toHaveBeenCalled();
    expect(second.state).toMatchObject({ kind: 'ready', copy: { projectId: 'project-7' } });
    expect(ownCode.deps.clearInvite).toHaveBeenCalled();

    const other = fakeDeps({ getSession: async () => session(), joinToken: 'someone-else' });
    other.remember('user-1', COPY);
    const third = new CopyEntry(other.deps);
    await third.start();
    expect(other.deps.joinCopy).toHaveBeenCalledWith('someone-else', null);
    expect(third.state).toMatchObject({ kind: 'ready', copy: { projectId: 'project-9' } });
  });

  it('asks someone signed in before, with no session remembered, for the check, and starts from a new sign-in', async () => {
    const fake = fakeDeps({ getSession: async () => session('user-old') });
    const entry = new CopyEntry(fake.deps);
    await entry.start();
    expect(entry.state).toEqual({ ...WELCOME, mode: 'claim' });

    await entry.go('turnstile-token', 'Kai Larsen');
    expect(fake.deps.signOut).toHaveBeenCalledTimes(1);
    expect(fake.deps.signInAnonymously).toHaveBeenCalledWith('turnstile-token');
    expect(fake.deps.claimCopy).toHaveBeenCalledWith('Kai Larsen');
    expect(fake.stored).toEqual({ userId: 'user-1', copy: COPY });
  });

  it('says the session was reset when the database refuses the touch, and starts a new one from a new sign-in', async () => {
    const fake = fakeDeps({ getSession: async () => session('user-old'), touchCopy: async () => Promise.reject(new CopyError('That copy was reset.', 'P0001')) });
    fake.remember('user-old', COPY);
    const entry = new CopyEntry(fake.deps);
    await entry.start();
    expect(entry.state).toEqual({ kind: 'reset' });
    expect(fake.stored).toBeNull();
    expect(fake.events).toContainEqual(['copy_reset', { reason: 'lease' }]);

    await entry.newCopy();
    expect(fake.deps.signOut).toHaveBeenCalledTimes(1);
    expect(fake.deps.claimCopy).not.toHaveBeenCalled();
    expect(entry.state).toEqual({ ...WELCOME, mode: 'claim', again: true });

    await entry.go('turnstile-token');
    expect(fake.deps.signInAnonymously).toHaveBeenCalledWith('turnstile-token');
    expect(fake.deps.claimCopy).toHaveBeenCalledTimes(1);
    expect(entry.state).toMatchObject({ kind: 'ready', copy: COPY });
    expect(fake.events).toContainEqual(['copy_claimed', { via: 'new' }]);
  });

  it('keeps the session when the touch only failed to get through, and says so', async () => {
    const fake = fakeDeps({ getSession: async () => session(), touchCopy: async () => Promise.reject(new CopyError('TypeError: Failed to fetch')) });
    fake.remember('user-1', COPY);
    const entry = new CopyEntry(fake.deps);
    await entry.start();
    expect(entry.state).toMatchObject({ kind: 'error', message: 'Your session could not be reached: TypeError: Failed to fetch' });
    expect(fake.stored).not.toBeNull();
  });

  it('shows the calm screen when every session is in use, and tries again from a new sign-in with the same name', async () => {
    const claimCopy = vi.fn<(name: string | null) => Promise<Copy>>().mockRejectedValueOnce(new CopyError('Every session is in use right now.', '53000')).mockResolvedValueOnce(COPY);
    const fake = fakeDeps({ claimCopy });
    const entry = new CopyEntry(fake.deps);
    await entry.start();
    await entry.go('t', 'Kai Larsen');
    expect(entry.state).toEqual({ kind: 'busy' });
    expect(fake.events.some(([event]) => event === 'error')).toBe(false);

    await entry.newCopy();
    expect(fake.deps.signOut).toHaveBeenCalledTimes(1);
    expect(entry.state).toEqual({ ...WELCOME, mode: 'claim', name: 'Kai Larsen' });
    await entry.go('t2', 'Kai Larsen');
    expect(fake.deps.signInAnonymously).toHaveBeenLastCalledWith('t2');
    expect(claimCopy).toHaveBeenLastCalledWith('Kai Larsen');
    expect(entry.state).toMatchObject({ kind: 'ready', copy: COPY });
  });

  it('shows the server’s words for an invite link that did not work, and starts a session of their own with the sign-in made to join', async () => {
    const fake = fakeDeps({ joinToken: 'full-copy', joinCopy: async () => Promise.reject(new CopyError('This session already has 5 people in it.', '53300')) });
    const entry = new CopyEntry(fake.deps);
    await entry.start();
    await entry.go('t', 'Avery Patel');
    expect(entry.state).toEqual({ kind: 'refused', message: 'This session already has 5 people in it.' });
    expect(fake.events).toContainEqual(['error', { where: 'join', message: 'This session already has 5 people in it.' }]);

    await entry.newCopy();
    expect(fake.deps.clearInvite).toHaveBeenCalled();
    expect(fake.deps.signOut).not.toHaveBeenCalled();
    expect(fake.deps.signInAnonymously).toHaveBeenCalledTimes(1);
    expect(fake.deps.claimCopy).toHaveBeenCalledWith('Avery Patel');
    expect(entry.state).toMatchObject({ kind: 'ready', copy: COPY });
  });

  it('stays on the welcome screen with the reason when the anonymous sign-in fails', async () => {
    const fake = fakeDeps({ signInAnonymously: async () => Promise.reject(new Error('captcha verification process failed')) });
    const entry = new CopyEntry(fake.deps);
    await entry.start();
    await entry.go('stale-token', 'Jordan Ellis');
    expect(entry.state).toEqual({ ...WELCOME, mode: 'claim', error: 'captcha verification process failed', name: 'Jordan Ellis' });
    expect(fake.deps.claimCopy).not.toHaveBeenCalled();
  });

  it('turns an invite into a session of their own on request', async () => {
    const fake = fakeDeps({ joinToken: 'invite-abc' });
    const entry = new CopyEntry(fake.deps);
    await entry.start();
    entry.chooseOwn();
    expect(entry.state).toEqual({ ...WELCOME, mode: 'claim' });
    expect(fake.deps.clearInvite).toHaveBeenCalled();
    await entry.go('t', 'Riley Brooks');
    expect(fake.deps.joinCopy).not.toHaveBeenCalled();
    expect(fake.deps.claimCopy).toHaveBeenCalledWith('Riley Brooks');
  });

  it('starts over: releases the session, signs this tab out, asks for the check again under the same name, then starts a fresh one', async () => {
    const claimCopy = vi.fn<(name: string | null) => Promise<Copy>>().mockResolvedValueOnce(COPY).mockResolvedValueOnce(NEXT);
    const fake = fakeDeps({ claimCopy });
    const entry = new CopyEntry(fake.deps);
    await entry.start();
    await entry.go('t', 'Riley Brooks');
    expect(entry.state).toMatchObject({ kind: 'ready', copy: COPY });

    await entry.startOver();
    expect(fake.deps.releaseCopy).toHaveBeenCalledWith('project-7');
    expect(fake.deps.signOut).toHaveBeenCalledTimes(1);
    expect(fake.stored).toBeNull();
    // The name the person had in the session (the server gave Jordan Ellis), asked for again.
    expect(entry.state).toEqual({ ...WELCOME, mode: 'claim', again: true, name: 'Jordan Ellis' });
    expect(claimCopy).toHaveBeenCalledTimes(1);
    expect(fake.events).toContainEqual(['copy_reset', { reason: 'start_over' }]);

    await entry.go('t2', 'Jordan Ellis');
    expect(fake.deps.signInAnonymously).toHaveBeenLastCalledWith('t2');
    expect(claimCopy).toHaveBeenLastCalledWith('Jordan Ellis');
    expect(entry.state).toMatchObject({ kind: 'ready', copy: NEXT, generation: 2 });
    expect(fake.stored).toEqual({ userId: 'user-2', copy: NEXT });
    expect(fake.events).toContainEqual(['copy_claimed', { via: 'start_over' }]);
  });

  it('goes on with Start over when the tab’s sign-out answers the way Supabase does, and when it fails', async () => {
    const fake = fakeDeps();
    const entry = new CopyEntry(fake.deps);
    // Supabase tells this page "signed out" while the sign-out runs: that is this page's own step.
    fake.deps.signOut = vi.fn(async () => entry.signedOut());
    await entry.start();
    await entry.go('t', 'Riley Brooks');
    await entry.startOver();
    expect(entry.state).toEqual({ ...WELCOME, mode: 'claim', again: true, name: 'Jordan Ellis' });

    await entry.go('t2', 'Jordan Ellis');
    fake.deps.signOut = vi.fn(async () => Promise.reject(new Error('TypeError: Failed to fetch')));
    await entry.startOver();
    expect(entry.state).toEqual({ ...WELCOME, mode: 'claim', again: true, name: 'Jordan Ellis' });
    expect(fake.events).toContainEqual(['error', { where: 'sign_out', message: 'TypeError: Failed to fetch' }]);
    await entry.go('t3', 'Jordan Ellis');
    expect(entry.state).toMatchObject({ kind: 'ready', generation: 3 });
  });

  it('counts down when the network must wait, with nothing to do before it is over, then starts with the sign-in that waited', async () => {
    const claimCopy = vi.fn<(name: string | null) => Promise<Copy>>().mockRejectedValueOnce(tooSoon(105)).mockResolvedValueOnce(COPY);
    const fake = fakeDeps({ claimCopy });
    const entry = new CopyEntry(fake.deps);
    await entry.start();
    await entry.go('t', 'Kai Larsen');
    expect(entry.state).toEqual({ kind: 'wait', until: NOW + 105_000, reason: 'gap' });
    expect(fake.events).toContainEqual(['copy_wait', { reason: 'gap' }]);
    expect(fake.events.some(([event]) => event === 'error')).toBe(false);

    fake.later(60_000);
    await entry.afterWait();
    expect(claimCopy).toHaveBeenCalledTimes(1);
    expect(entry.state.kind).toBe('wait');

    fake.later(45_000);
    await entry.afterWait();
    expect(fake.deps.signOut).not.toHaveBeenCalled();
    expect(fake.deps.signInAnonymously).toHaveBeenCalledTimes(1);
    expect(claimCopy).toHaveBeenLastCalledWith('Kai Larsen');
    expect(entry.state).toMatchObject({ kind: 'ready', copy: COPY });
  });

  it('counts down after Start over too, and waits a minute when the server doesn’t say how long', async () => {
    const claimCopy = vi
      .fn<(name: string | null) => Promise<Copy>>()
      .mockResolvedValueOnce(COPY)
      .mockRejectedValueOnce(new CopyError('Too many tries for now.', 'PT429'))
      .mockResolvedValueOnce(NEXT);
    const fake = fakeDeps({ claimCopy });
    const entry = new CopyEntry(fake.deps);
    await entry.start();
    await entry.go('t', 'Riley Brooks');
    await entry.startOver();
    await entry.go('t2', 'Jordan Ellis');
    expect(entry.state).toEqual({ kind: 'wait', until: NOW + 60_000, reason: null });
    fake.later(60_000);
    await entry.afterWait();
    expect(entry.state).toMatchObject({ kind: 'ready', copy: NEXT, generation: 2 });
    expect(fake.events).toContainEqual(['copy_claimed', { via: 'start_over' }]);
  });

  it('starts from a new sign-in when the database says this one has had its session', async () => {
    const claimCopy = vi.fn<(name: string | null) => Promise<Copy>>().mockRejectedValueOnce(used()).mockResolvedValueOnce(COPY);
    const fake = fakeDeps({ claimCopy, joinToken: 'full-copy', joinCopy: async () => Promise.reject(new CopyError('This session already has 5 people in it.', '53300')) });
    const entry = new CopyEntry(fake.deps);
    await entry.start();
    await entry.go('t', 'Avery Patel');
    await entry.newCopy();
    expect(fake.deps.signOut).toHaveBeenCalledTimes(1);
    expect(entry.state).toEqual({ ...WELCOME, mode: 'claim', name: 'Avery Patel' });
    expect(fake.events.some(([event, props]) => event === 'error' && (props as { where: string }).where === 'claim')).toBe(false);

    await entry.go('t2', 'Avery Patel');
    expect(fake.deps.signInAnonymously).toHaveBeenLastCalledWith('t2');
    expect(entry.state).toMatchObject({ kind: 'ready', copy: COPY });
  });

  it('says the session was reset when its lease is lost', async () => {
    const fake = fakeDeps();
    const entry = new CopyEntry(fake.deps);
    await entry.start();
    await entry.go('t');
    entry.leaseLost();
    expect(entry.state).toEqual({ kind: 'reset' });
    expect(fake.stored).toBeNull();
  });

  it('leaves a session that won’t open for one of its own, without releasing it, from a new sign-in', async () => {
    const fake = fakeDeps({ joinToken: 'invite-abc' });
    const entry = new CopyEntry(fake.deps);
    await entry.start();
    await entry.go('t');
    await entry.leave();
    expect(fake.deps.releaseCopy).not.toHaveBeenCalled();
    expect(fake.deps.signOut).toHaveBeenCalledTimes(1);
    expect(entry.state).toEqual({ ...WELCOME, mode: 'claim', again: true, name: 'Avery Patel' });
    await entry.go('t2', 'Avery Patel');
    expect(entry.state).toMatchObject({ kind: 'ready', copy: COPY, generation: 2 });
  });

  it('opens the session with nothing live when the switches can’t be read', async () => {
    const fake = fakeDeps({ loadFlags: async () => Promise.reject(new CopyError('relation "app_flags" does not exist', '42P01')) });
    const entry = new CopyEntry(fake.deps);
    await entry.start();
    await entry.go('t');
    expect(entry.state).toMatchObject({ kind: 'ready', flags: FLAGS_OFF });
  });

  it('looks once, however often it is started (React starts effects twice in development)', async () => {
    const fake = fakeDeps({ joinToken: 'invite-abc', getSession: async () => session('user-2') });
    const entry = new CopyEntry(fake.deps);
    await Promise.all([entry.start(), entry.start()]);
    expect(fake.deps.joinCopy).toHaveBeenCalledTimes(1);
  });

  it('looks again after an error, on request', async () => {
    const touchCopy = vi
      .fn<(projectId: string) => Promise<Touch>>()
      .mockRejectedValueOnce(new CopyError('TypeError: Failed to fetch'))
      .mockResolvedValueOnce({ leaseUntil: null, code: null });
    const fake = fakeDeps({ getSession: async () => session(), touchCopy });
    fake.remember('user-1', COPY);
    const entry = new CopyEntry(fake.deps);
    await entry.start();
    expect(entry.state.kind).toBe('error');
    await entry.retry();
    expect(entry.state).toMatchObject({ kind: 'ready', copy: COPY });
  });

  it('goes back to the start when the sign-in ends', async () => {
    const fake = fakeDeps();
    const entry = new CopyEntry(fake.deps);
    await entry.start();
    await entry.go('t');
    entry.signedOut();
    expect(entry.state).toEqual({ ...WELCOME, mode: 'claim', name: 'Jordan Ellis' });
  });
});

describe('CopyEntry with a session code', () => {
  it('opens on the code, from the landing page’s link, and joins with it after the check', async () => {
    const fake = fakeDeps({ joinCode: '615203' });
    const entry = new CopyEntry(fake.deps);
    await entry.start();
    expect(entry.state).toEqual({ ...WELCOME, mode: 'code', code: '615203' });
    expect(fake.events).toContainEqual(['join_opened', { signed_in: false, via: 'code' }]);

    await entry.go('turnstile-token', 'Devon Park', '615 203');
    expect(fake.deps.joinCopyByCode).toHaveBeenCalledWith('615203', 'Devon Park');
    expect(fake.deps.clearInvite).toHaveBeenCalled();
    expect(entry.state).toMatchObject({ kind: 'ready', copy: JOINED });
    expect(fake.stored).toEqual({ userId: 'user-1', copy: JOINED });
  });

  it('joins with the code in the address straight away for someone signed in', async () => {
    const fake = fakeDeps({ joinCode: '615203', getSession: async () => session('user-2') });
    const entry = new CopyEntry(fake.deps);
    await entry.start();
    expect(fake.deps.joinCopyByCode).toHaveBeenCalledWith('615203', null);
    expect(entry.state).toMatchObject({ kind: 'ready', copy: JOINED });
  });

  it('switches from starting a session to joining with a code, and back', async () => {
    const fake = fakeDeps();
    const entry = new CopyEntry(fake.deps);
    await entry.start();
    entry.chooseCode();
    expect(entry.state).toEqual({ ...WELCOME, mode: 'code' });
    entry.chooseOwn();
    expect(entry.state).toEqual({ ...WELCOME, mode: 'claim' });
  });

  it('asks for six digits before anything is sent', async () => {
    const fake = fakeDeps();
    const entry = new CopyEntry(fake.deps);
    await entry.start();
    entry.chooseCode();
    await entry.go('t', 'Devon Park', '61520');
    expect(entry.state).toEqual({ ...WELCOME, mode: 'code', error: 'Enter the 6-digit code you were given.', code: '61520', name: 'Devon Park' });
    expect(fake.deps.signInAnonymously).not.toHaveBeenCalled();
    expect(fake.deps.joinCopyByCode).not.toHaveBeenCalled();
  });

  it('says beside the field when a code matches no session, signed in by then, so the next try needs no check', async () => {
    const joinCopyByCode = vi
      .fn<(code: string, name: string | null) => Promise<Copy>>()
      .mockRejectedValueOnce(new CopyError('That code doesn’t match a session that’s open now.', NO_MATCH))
      .mockResolvedValueOnce(JOINED);
    const fake = fakeDeps({ joinCode: '111111', joinCopyByCode });
    const entry = new CopyEntry(fake.deps);
    await entry.start();
    await entry.go('turnstile-token', 'Devon Park', '111111');
    expect(entry.state).toEqual({ ...WELCOME, mode: 'code', signedIn: true, error: 'That code doesn’t match a session that’s open now.', code: '111111', name: 'Devon Park' });
    expect(fake.deps.clearInvite).toHaveBeenCalled();

    await entry.go(null, 'Devon Park', '615203');
    expect(fake.deps.signInAnonymously).toHaveBeenCalledTimes(1);
    expect(joinCopyByCode).toHaveBeenLastCalledWith('615203', 'Devon Park');
    expect(entry.state).toMatchObject({ kind: 'ready', copy: JOINED });
  });

  it('starts a session of their own after a wrong code with the sign-in made for it, which hasn’t had one', async () => {
    const fake = fakeDeps({
      joinCode: '111111',
      joinCopyByCode: async () => Promise.reject(new CopyError('That code doesn’t match a session that’s open now.', NO_MATCH)),
    });
    const entry = new CopyEntry(fake.deps);
    await entry.start();
    await entry.go('turnstile-token', 'Devon Park', '111111');
    entry.chooseOwn();
    expect(entry.state).toEqual({ ...WELCOME, mode: 'claim', signedIn: true, name: 'Devon Park' });
    await entry.go(null, 'Devon Park');
    expect(fake.deps.signOut).not.toHaveBeenCalled();
    expect(fake.deps.signInAnonymously).toHaveBeenCalledTimes(1);
    expect(fake.deps.claimCopy).toHaveBeenCalledWith('Devon Park');
    expect(entry.state).toMatchObject({ kind: 'ready', copy: COPY });
  });

  it('says too many tries, or a full session, beside the field too', async () => {
    const fake = fakeDeps({
      getSession: async () => session(),
      joinCopyByCode: async () => Promise.reject(new CopyError('Too many wrong codes. Try again in 10 minutes, or ask for the invite link.', 'PT429')),
    });
    const entry = new CopyEntry(fake.deps);
    await entry.start();
    entry.chooseCode();
    await entry.go(null, 'Devon Park', '222222');
    expect(entry.state).toMatchObject({ kind: 'welcome', mode: 'code', error: 'Too many wrong codes. Try again in 10 minutes, or ask for the invite link.' });
  });

  it('shows the error screen when a code could not be sent at all, and tries it again on request', async () => {
    const joinCopyByCode = vi.fn<(code: string, name: string | null) => Promise<Copy>>().mockRejectedValueOnce(new CopyError('TypeError: Failed to fetch')).mockResolvedValueOnce(JOINED);
    const fake = fakeDeps({ joinCode: '615203', getSession: async () => session(), joinCopyByCode });
    const entry = new CopyEntry(fake.deps);
    await entry.start();
    expect(entry.state).toMatchObject({ kind: 'error' });
    await entry.retry();
    expect(joinCopyByCode).toHaveBeenCalledTimes(2);
    expect(entry.state).toMatchObject({ kind: 'ready', copy: JOINED });
  });

  it('takes the invite link over a code when an address has both', async () => {
    const fake = fakeDeps({ joinToken: 'invite-abc', joinCode: '615203', getSession: async () => session() });
    const entry = new CopyEntry(fake.deps);
    await entry.start();
    expect(fake.deps.joinCopy).toHaveBeenCalledWith('invite-abc', null);
    expect(fake.deps.joinCopyByCode).not.toHaveBeenCalled();
  });
});
