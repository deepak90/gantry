/**
 * The private `project:{id}:workflow` channel: the database broadcasts `{ table, id, op,
 * proposal_id }` whenever a workflow row or a project document changes (a filed payment receipt
 * included), and the browser re-reads the whole snapshot, documents and members with it. A
 * (re)subscription also counts as a change, because Realtime does not replay what was sent while
 * the channel was down.
 */
import type { RevisionSupabaseClient } from '../sync/supabase-transport';

export const WORKFLOW_BROADCAST_EVENT = 'change';

export function workflowTopic(projectId: string): string {
  return `project:${projectId}:workflow`;
}

export type WorkflowRealtimeClient = Pick<RevisionSupabaseClient, 'channel' | 'removeChannel' | 'realtime' | 'auth'>;

export function subscribeWorkflow(client: WorkflowRealtimeClient, projectId: string, onChange: () => void): () => void {
  let active = true;
  const channel = client.channel(workflowTopic(projectId), { config: { private: true } });
  channel.on('broadcast', { event: WORKFLOW_BROADCAST_EVENT }, () => {
    if (active) {
      onChange();
    }
  });
  void (async () => {
    try {
      const { data } = await client.auth.getSession();
      if (data.session?.access_token) {
        await client.realtime.setAuth(data.session.access_token);
      }
    } catch (error) {
      console.warn('[workflow] realtime.setAuth failed', error);
    }
    if (!active) {
      return;
    }
    channel.subscribe((status, error) => {
      if (!active) {
        return;
      }
      if (error) {
        console.warn(`[workflow] channel ${status}`, error);
      }
      if (status === 'SUBSCRIBED') {
        onChange();
      }
    });
  })();
  return () => {
    active = false;
    client.removeChannel(channel).catch((error: unknown) => console.warn('[workflow] removeChannel failed', error));
  };
}
