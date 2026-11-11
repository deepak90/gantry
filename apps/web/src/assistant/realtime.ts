/**
 * The private `project:{id}:agent` channel: the database announces new thread messages (`message`
 * {id}), command changes (`command` {id, status}) and threads started, renamed or deleted (`thread`
 * {id, op}), and the agent service streams its turns
 * (`stream`, AgentStreamEvent). Members may only receive here (RLS on realtime.messages), but every
 * payload is still validated against the shared schemas and anything else is dropped.
 *
 * Like the presence transport, the subscription sets the Realtime auth token before joining and
 * joins again from scratch, with a growing delay, when the server closes the channel (Realtime only
 * retries errored channels by itself). Broadcasts sent while the channel was down are not replayed:
 * on `connected` (the first join and every rejoin) re-read the thread and any open command.
 *
 * Statuses: `connected` once joined; `reconnecting` while Realtime retries an errored channel or a
 * rejoin is under way; `closed` when the server closed the channel (a rejoin follows on its own).
 */
import { AGENT_EVENTS, AgentStreamEvent, agentTopic, threadTopic, uuid } from '@collab/shared';
import { z } from 'zod';
import { joinPrivateTopic, type PrivateTopicClient } from '../supabase/private-topic';

export type AssistantStatus = 'connected' | 'reconnecting' | 'closed';

export interface AssistantHandlers {
  /** A message was stored in the thread: load it (or reload the thread). */
  onMessage(id: string): void;
  /** A command was created or changed status. */
  onCommand?(id: string, status: string): void;
  /** The assistant is writing: turn start and end, text deltas, tool progress, card drafts. */
  onStream(event: AgentStreamEvent): void;
  /** A thread was started, renamed or deleted. */
  onThread?(id: string, op: 'insert' | 'update' | 'delete'): void;
  onStatus?(status: AssistantStatus): void;
}

export type AssistantRealtimeClient = PrivateTopicClient;

export interface SubscribeAssistantOptions {
  /** Delays before rejoining a channel the server closed; the last one repeats. */
  rejoinDelaysMs?: readonly number[];
  onWarning?: (message: string, error?: unknown) => void;
}

/** `message` payload: the stored row's id. */
export const AgentMessageAnnouncement = z.object({ id: uuid });
/** `command` payload: the row's id and its status now. */
export const AgentCommandAnnouncement = z.object({ id: uuid, status: z.string().min(1).max(32) });
/** `thread` payload: the thread's id and what happened to it. */
export const AgentThreadAnnouncement = z.object({ id: uuid, op: z.enum(['insert', 'update', 'delete']) });

/** Joins the agent topic; returns the function that leaves it (no handler is called after that). */
export function subscribeAssistant(
  client: AssistantRealtimeClient,
  projectId: string,
  handlers: AssistantHandlers,
  options: SubscribeAssistantOptions = {},
): () => void {
  const warn = (message: string, error?: unknown) => {
    if (options.onWarning) options.onWarning(message, error);
    else console.warn(`[assistant ${projectId}] ${message}`, error);
  };
  const status = (value: AssistantStatus) => handlers.onStatus?.(value);

  return joinPrivateTopic(client, agentTopic(projectId), {
    name: 'agent channel',
    warn,
    rejoinDelaysMs: options.rejoinDelaysMs,
    listen: (joined, live) => {
      joined.on('broadcast', { event: AGENT_EVENTS.message }, ({ payload }) => {
        const parsed = AgentMessageAnnouncement.safeParse(payload);
        if (!live()) return;
        if (parsed.success) handlers.onMessage(parsed.data.id);
        else warn('dropped a malformed message announcement', parsed.error);
      });
      joined.on('broadcast', { event: AGENT_EVENTS.thread }, ({ payload }) => {
        const parsed = AgentThreadAnnouncement.safeParse(payload);
        if (!live()) return;
        if (parsed.success) handlers.onThread?.(parsed.data.id, parsed.data.op);
        else warn('dropped a malformed thread announcement', parsed.error);
      });
      joined.on('broadcast', { event: AGENT_EVENTS.command }, ({ payload }) => {
        const parsed = AgentCommandAnnouncement.safeParse(payload);
        if (!live()) return;
        if (parsed.success) handlers.onCommand?.(parsed.data.id, parsed.data.status);
        else warn('dropped a malformed command announcement', parsed.error);
      });
      joined.on('broadcast', { event: AGENT_EVENTS.stream }, ({ payload }) => {
        const parsed = AgentStreamEvent.safeParse(payload);
        if (!live()) return;
        if (parsed.success) handlers.onStream(parsed.data);
        else warn('dropped a malformed stream event', parsed.error);
      });
    },
    onStatus: (state) => {
      if (state === 'SUBSCRIBED') status('connected');
      else if (state === 'CHANNEL_ERROR' || state === 'TIMED_OUT') status('reconnecting');
      else if (state === 'CLOSED') status('closed');
    },
    onRejoin: () => status('reconnecting'),
  });
}

/**
 * Joins a private thread's own topic (only the people in the thread may) and hands on its stream
 * events: the assistant's live reply there never goes on the project's agent topic. Returns the
 * function that leaves it. A closed channel is joined again after a short wait.
 */
export function subscribeThreadStream(
  client: AssistantRealtimeClient,
  projectId: string,
  threadId: string,
  onStream: (event: AgentStreamEvent) => void,
  options: Pick<SubscribeAssistantOptions, 'onWarning' | 'rejoinDelaysMs'> = {},
): () => void {
  const warn = (message: string, error?: unknown) => {
    if (options.onWarning) options.onWarning(message, error);
    else console.warn(`[assistant thread ${threadId}] ${message}`, error);
  };

  return joinPrivateTopic(client, threadTopic(projectId, threadId), {
    name: 'thread channel',
    warn,
    rejoinDelaysMs: options.rejoinDelaysMs,
    listen: (joined, live) => {
      joined.on('broadcast', { event: AGENT_EVENTS.stream }, ({ payload }) => {
        const parsed = AgentStreamEvent.safeParse(payload);
        if (!live()) return;
        if (parsed.success) onStream(parsed.data);
        else warn('dropped a malformed stream event', parsed.error);
      });
    },
  });
}
