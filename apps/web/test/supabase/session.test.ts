import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_HEARTBEAT_MS, randomUuid, registerSession, type SessionsClient } from '../../src/supabase/session';

const PROJECT = '00000000-0000-4000-8000-0000000000aa';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function fakeClient(options: { userId?: string | null; insertError?: string; updateError?: string } = {}) {
  const inserts: Array<{ table: string; values: unknown }> = [];
  const updates: Array<{ table: string; values: unknown; eq: [string, unknown] }> = [];
  const client: SessionsClient = {
    auth: {
      getSession: async () => ({
        data: { session: options.userId === null ? null : { user: { id: options.userId ?? 'user-1' } } },
        error: null,
      }),
    },
    // The fake chain stands in for the PostgREST builder; the cast is the only way to satisfy its generic type.
    from: ((table: string) => ({
      insert(values: object) {
        inserts.push({ table, values });
        return Promise.resolve({ error: options.insertError ? { message: options.insertError } : null });
      },
      update(values: object) {
        return {
          eq(column: string, value: unknown) {
            updates.push({ table, values, eq: [column, value] });
            return Promise.resolve({ error: options.updateError ? { message: options.updateError } : null });
          },
        };
      },
    })) as unknown as SupabaseClient['from'],
  };
  return { client, inserts, updates };
}

describe('supabase/session registerSession()', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-21T10:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('inserts a sessions row with a client-generated uuid and heartbeats last_seen every 30 s until stop()', async () => {
    const { client, inserts, updates } = fakeClient();
    const registration = await registerSession(client, PROJECT);

    expect(registration.userId).toBe('user-1');
    expect(registration.sessionId).toMatch(UUID_RE);
    expect(inserts).toEqual([
      {
        table: 'sessions',
        values: { id: registration.sessionId, user_id: 'user-1', project_id: PROJECT, last_seen: '2026-10-21T10:00:00.000Z' },
      },
    ]);
    expect(SESSION_HEARTBEAT_MS).toBe(30_000);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(updates).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(updates).toEqual([{ table: 'sessions', values: { last_seen: '2026-10-21T10:00:30.000Z' }, eq: ['id', registration.sessionId] }]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(updates).toHaveLength(2);

    registration.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(updates).toHaveLength(2);
  });

  it('honors an explicit session id and heartbeat period, and reports heartbeat failures', async () => {
    const { client, updates } = fakeClient({ updateError: 'row is gone' });
    const errors: unknown[] = [];
    const registration = await registerSession(client, PROJECT, { sessionId: 'fixed-id', heartbeatMs: 1_000, onError: (e) => errors.push(e) });
    expect(registration.sessionId).toBe('fixed-id');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(updates[0]!.eq).toEqual(['id', 'fixed-id']);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('row is gone');
    registration.stop();
  });

  it('fails clearly without a signed-in user or when the insert is refused', async () => {
    await expect(registerSession(fakeClient({ userId: null }).client, PROJECT)).rejects.toThrow(/nobody is signed in/);
    await expect(registerSession(fakeClient({ insertError: 'RLS denied' }).client, PROJECT)).rejects.toThrow(
      'Cannot register the session: RLS denied',
    );
  });

  it('randomUuid() produces RFC 4122 v4 ids', () => {
    const ids = new Set(Array.from({ length: 50 }, () => randomUuid()));
    expect(ids.size).toBe(50);
    for (const id of ids) {
      expect(id).toMatch(UUID_RE);
    }
  });
});
