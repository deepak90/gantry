import type { SupabaseClient } from '@supabase/supabase-js';
import { useEffect, useState } from 'react';
import type { ReadyProjectSession } from '../app/project-session';
import { WorkflowController, type WorkflowViewState } from './controller';
import { subscribeWorkflow } from './realtime';

const LOADING: WorkflowViewState = { status: 'loading', snapshot: null, loadError: null, busy: null, failure: null, notice: null };

/**
 * One workflow controller per ready project session (a fresh boot gets a fresh controller). Under
 * StrictMode the first controller is disposed by the effect cleanup before the second starts.
 */
export function useWorkflow(client: SupabaseClient, session: ReadyProjectSession): {
  controller: WorkflowController | null;
  state: WorkflowViewState;
} {
  const [controller, setController] = useState<WorkflowController | null>(null);
  const [state, setState] = useState<WorkflowViewState>(LOADING);
  const { projectId, sessionId, project, revisions } = session;
  const handover = session.load.project.handover_task_id;

  useEffect(() => {
    const created = new WorkflowController({
      client,
      projectId,
      sessionId,
      project,
      revisions,
      handoverTaskId: handover === null ? null : Number(handover),
      subscribe: (onChange) => subscribeWorkflow(client, projectId, onChange),
    });
    const unsubscribe = created.subscribe(() => setState(created.state));
    created.start();
    setController(created);
    setState(created.state);
    return () => {
      unsubscribe();
      created.dispose();
    };
  }, [client, projectId, sessionId, project, revisions, handover]);

  return { controller, state };
}
