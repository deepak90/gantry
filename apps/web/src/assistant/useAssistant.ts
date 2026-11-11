/**
 * The assistant for one open project: the thread and the streamed replies (AssistantSession) and
 * the commands it files for this browser (AgentCommandRunner: the odds, run here), over one
 * subscription to the project's agent topic. Started with the project and stopped with it.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { useEffect, useRef, useState } from 'react';
import type { ScreenContext, SelectedTask } from '@collab/shared';
import { AgentCommandRunner, type CommandExecutor } from './agent-commands';
import {
  claimAgentCommand,
  completeAgentCommand,
  createThread,
  deleteThread,
  inviteToThread,
  loadCommand,
  loadEditDecisions,
  loadThread,
  loadThreads,
  postAgentMessage,
  removeFromThread,
  renameThread,
  setThreadVisibility,
  type AssistantClient,
} from './api';
import { subscribeAssistant, subscribeThreadStream, type AssistantRealtimeClient } from './realtime';
import { AssistantSession, type AssistantTransport } from './session';

export interface UseAssistantOptions {
  client: SupabaseClient;
  projectId: string;
  /** This tab's `sessions.id`: commands are claimed by tab. */
  sessionId: string;
  userId: string;
  /** What is selected in the plan right now (sent along with each message). */
  selection?: () => readonly SelectedTask[];
  /** What is on this tab's screen right now (sent along with each message). */
  screen?: () => ScreenContext | null;
  /** Carries out what the assistant asks this browser to do, by the command's type (null while it can't: no plan on screen). */
  executor?: (type?: string) => CommandExecutor | null;
  /** This tab takes anyone's command at once (the call's host: see AgentCommandRunnerOptions.takesAll). */
  takesAll?: () => boolean;
}

export function useAssistant({ client, projectId, sessionId, userId, selection, screen, executor, takesAll }: UseAssistantOptions): AssistantSession | null {
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const screenRef = useRef(screen);
  screenRef.current = screen;
  const executorRef = useRef(executor);
  executorRef.current = executor;
  const takesAllRef = useRef(takesAll);
  takesAllRef.current = takesAll;
  const [session, setSession] = useState<AssistantSession | null>(null);

  useEffect(() => {
    const api = client as unknown as AssistantClient;
    const commands = new AgentCommandRunner({
      transport: {
        loadCommand: (id) => loadCommand(api, id),
        claim: (id) => claimAgentCommand(api, id, sessionId),
        complete: (id, status, result) => completeAgentCommand(api, id, sessionId, status, result),
      },
      executor: (type) => executorRef.current?.(type) ?? null,
      takesAll: () => takesAllRef.current?.() ?? false,
      userId,
    });
    const transport: AssistantTransport = {
      loadThread: (threadId) => loadThread(api, projectId, threadId),
      post: (text, options) =>
        postAgentMessage(api, projectId, text, {
          channel: options.channel === 'voice' ? 'voice' : 'text',
          action: options.action ?? null,
          threadId: options.threadId ?? null,
          context: options.context ?? null,
        }),
      subscribe: (handlers) =>
        subscribeAssistant(client as unknown as AssistantRealtimeClient, projectId, {
          onMessage: handlers.onMessage,
          onStream: handlers.onStream,
          onStatus: handlers.onStatus,
          onThread: handlers.onThread,
          onCommand: (id, status) => commands.heard(id, status),
        }),
      loadThreads: () => loadThreads(api, projectId),
      createThread: (title, options) => createThread(api, projectId, title, options),
      watchThread: (threadId, onStream) => subscribeThreadStream(client as unknown as AssistantRealtimeClient, projectId, threadId, onStream),
      inviteToThread: (threadId, userId, shareCosts) => inviteToThread(api, threadId, userId, shareCosts),
      removeFromThread: (threadId, userId) => removeFromThread(api, threadId, userId),
      setThreadVisibility: (threadId, visibility, shareCosts) => setThreadVisibility(api, threadId, visibility, shareCosts),
      renameThread: (threadId, title) => renameThread(api, threadId, title),
      deleteThread: (threadId) => deleteThread(api, threadId),
      loadDecisions: () => loadEditDecisions(api, projectId),
    };
    // The approval mode is this person's choice for this project, kept in this browser.
    const key = `collab.assistant.approval-mode:${projectId}:${userId}`;
    const next = new AssistantSession(transport, {
      selection: () => selectionRef.current?.() ?? [],
      screen: () => screenRef.current?.() ?? null,
      storage: { get: () => window.localStorage.getItem(key), set: (value) => window.localStorage.setItem(key, value) },
    });
    next.start();
    setSession(next);
    return () => {
      commands.dispose();
      next.dispose();
      setSession(null);
    };
  }, [client, projectId, sessionId, userId]);

  return session;
}
