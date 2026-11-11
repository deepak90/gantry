import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { loadProfile, type ProfilesClient } from '../../src/supabase/profile';
import { listProjects, opensAsDemo, type ProjectsTableClient } from '../../src/supabase/project';

function tableClient(result: { data: unknown; error: { message: string } | null }) {
  const chain: Array<[string, unknown[]]> = [];
  const builder: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'order', 'limit']) {
    builder[method] = (...args: unknown[]) => {
      chain.push([method, args]);
      return builder;
    };
  }
  builder.maybeSingle = () => {
    chain.push(['maybeSingle', []]);
    return Promise.resolve(result);
  };
  builder.then = (onfulfilled: (value: unknown) => unknown, onrejected?: (reason: unknown) => unknown) =>
    Promise.resolve(result).then(onfulfilled, onrejected);
  const tables: string[] = [];
  // The fake chain stands in for the PostgREST builder; the cast is the only way to satisfy its generic type.
  const from = ((table: string) => {
    tables.push(table);
    return builder;
  }) as unknown as SupabaseClient['from'];
  return { client: { from } satisfies ProfilesClient & ProjectsTableClient, chain, tables };
}

describe('loadProfile()', () => {
  it('reads the display name and color of the given user', async () => {
    const { client, chain, tables } = tableClient({ data: { display_name: 'Chris Morgan', color: '#d97706' }, error: null });
    expect(await loadProfile(client, 'user-12')).toEqual({ displayName: 'Chris Morgan', color: '#d97706' });
    expect(tables).toEqual(['profiles']);
    expect(chain).toEqual([
      ['select', ['display_name, color']],
      ['eq', ['user_id', 'user-12']],
      ['maybeSingle', []],
    ]);
  });

  it('returns null without a row and surfaces errors and bad shapes', async () => {
    expect(await loadProfile(tableClient({ data: null, error: null }).client, 'u')).toBeNull();
    await expect(loadProfile(tableClient({ data: null, error: { message: 'boom' } }).client, 'u')).rejects.toThrow(
      'Cannot read the profile: boom',
    );
    await expect(loadProfile(tableClient({ data: { display_name: 7 }, error: null }).client, 'u')).rejects.toThrow(/unexpected shape/);
  });
});

describe('listProjects()', () => {
  it('lists the visible projects oldest first', async () => {
    const { client, chain, tables } = tableClient({
      data: [{ id: '00000000-0000-4000-8000-000000000001', name: 'Riverside Clinic build-out' }],
      error: null,
    });
    expect(await listProjects(client)).toEqual([{ id: '00000000-0000-4000-8000-000000000001', name: 'Riverside Clinic build-out', listed: true, template: null }]);
    expect(tables).toEqual(['projects']);
    expect(chain).toEqual([
      ['select', ['id, name, listed, template']],
      ['order', ['created_at', { ascending: true }]],
    ]);
  });

  it('says which demo each project plays, and opens a demo as one whether or not the menu offers it', async () => {
    const harbor = { id: '00000000-0000-4000-8000-000000000002', name: 'Harbor Street Offices', listed: true, template: 'harbor' };
    const copy = { id: '00000000-0000-4000-8000-000000010001', name: 'Harbor Street Offices', listed: false, template: 'harbor' };
    const fixture = { id: '00000000-0000-4000-8000-000000000001', name: 'Riverside Clinic', listed: false, template: null };
    expect(await listProjects(tableClient({ data: [fixture, harbor, copy], error: null }).client)).toEqual([fixture, harbor, copy]);
    // Harbor, which the menu offers; a visitor's copy of it, which it doesn't; not the tests' fixture.
    expect([harbor, copy, fixture].map(opensAsDemo)).toEqual([true, true, false]);
  });

  it('returns an empty list for a user without memberships and surfaces errors', async () => {
    expect(await listProjects(tableClient({ data: [], error: null }).client)).toEqual([]);
    expect(await listProjects(tableClient({ data: null, error: null }).client)).toEqual([]);
    await expect(listProjects(tableClient({ data: null, error: { message: 'permission denied' } }).client)).rejects.toThrow(
      'Cannot list projects: permission denied',
    );
  });
});
