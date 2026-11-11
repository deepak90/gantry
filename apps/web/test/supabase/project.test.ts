import { describe, expect, it } from 'vitest';
import { loadProject, type ProjectClient } from '../../src/supabase/project';

const PROJECT = '00000000-0000-4000-8000-0000000000aa';

function validResult() {
  return {
    project: { id: PROJECT, name: 'Riverside Clinic build-out', currency: 'USD', handover_task_id: 42 },
    membership: { role: 'cm', can_view_costs: true, approval_limit_minor: 500000 },
    snapshot: {
      project: { startDate: '2026-11-02' },
      calendarsData: [{ id: 'general', name: 'General' }],
      tasksData: [{ id: 1, name: 'A', duration: 1 }],
      dependenciesData: [],
      resourcesData: [{ id: 1, name: 'Crew' }],
      assignmentsData: [],
    },
    snapshot_revision: 3,
    current_revision: 4,
    revisions: [
      {
        id: 'r4',
        project_id: PROJECT,
        revision_no: 4,
        client_id: 's1',
        local_revision_id: 'local-1',
        conflict_resolution_for: null,
        changes: { tasks: { updated: [{ id: 1, name: 'B' }], $input: { updated: [{ id: 1, name: 'B' }] } }, project: { endDate: 'x' } },
        actor_user_id: null,
        origin: 'human',
        created_at: '2026-10-21T00:00:00Z',
      },
    ],
  };
}

function fakeClient(result: { data: unknown; error: { message: string; code?: string } | null }) {
  const calls: Array<{ fn: string; args: unknown }> = [];
  const client: ProjectClient = {
    rpc(fn, args) {
      calls.push({ fn, args });
      return Promise.resolve(result);
    },
  };
  return { client, calls };
}

describe('supabase/project loadProject()', () => {
  it('calls load_project and returns the validated result', async () => {
    const { client, calls } = fakeClient({ data: validResult(), error: null });
    const result = await loadProject(client, PROJECT);
    expect(calls).toEqual([{ fn: 'load_project', args: { p_project: PROJECT } }]);
    expect(result.project.handover_task_id).toBe('42');
    expect(result.membership.role).toBe('cm');
    expect(result.snapshot.tasksData).toHaveLength(1);
    expect(result.snapshot.project).toEqual({ startDate: '2026-11-02' });
    expect(result.revisions[0]!.changes.project).toEqual({ endDate: 'x' });
    expect(result.revisions[0]!.changes.tasks!.$input!.updated).toEqual([{ id: 1, name: 'B' }]);
  });

  it('surfaces RPC errors', async () => {
    const { client } = fakeClient({ data: null, error: { message: 'not a member', code: '42501' } });
    await expect(loadProject(client, PROJECT)).rejects.toThrow('load_project failed (42501): not a member');
  });

  it('rejects results that do not match the contract', async () => {
    const broken = validResult() as Record<string, unknown>;
    delete broken.snapshot;
    const { client } = fakeClient({ data: broken, error: null });
    await expect(loadProject(client, PROJECT)).rejects.toThrow(/unexpected shape[\s\S]*snapshot/);
  });
});
