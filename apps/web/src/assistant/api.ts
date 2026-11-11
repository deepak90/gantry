/**
 * The assistant's server calls for the browser (supabase/migrations/*_assistant.sql): read the
 * thread, write to it (`post_agent_message`), and carry out the commands the agent service asks a
 * person's tab to run (`claim_agent_command`, `complete_agent_command`). RLS limits every read to
 * the project's members; the assistant's own messages and the commands are written by the agent
 * service alone. Every row is validated against the shared schemas in packages/shared/src/agent.ts.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { AgentAction, AgentCommandResult, AgentCommandRow, AgentEditDecisionRow, AgentMessageContext, AgentMessageRow, AgentThreadMemberRow, AgentThreadRow, type AgentThreadVisibility } from '@collab/shared';
import { z } from 'zod';

interface ErrorLike {
  message: string;
  code?: string;
}

/** The slice of `SupabaseClient` the assistant uses; the real client satisfies it, tests fake it. */
export interface AssistantClient {
  rpc(fn: string, args?: object): PromiseLike<{ data: unknown; error: ErrorLike | null }>;
  /** The real method type: a structural copy of the PostgREST builder chain is too deep to compare. */
  from: SupabaseClient['from'];
}

/** A refusal or failure. `code` is the SQLSTATE (42501 not allowed, 55000 taken or not ready, P0002 not found) or a local code. */
export class AssistantError extends Error {
  readonly code: string | undefined;

  constructor(message: string, code?: string) {
    super(message);
    this.name = 'AssistantError';
    this.code = code;
  }
}

/** How a person's tab may end a command it claimed. */
export type AgentCommandOutcome = 'succeeded' | 'failed' | 'rejected';

/** The channels a person writes on; `app` messages are the assistant's own. */
export type PersonChannel = 'text' | 'voice';

function serverError(operation: string, error: ErrorLike): AssistantError {
  return new AssistantError(error.message.replace(/^[a-z_]+: /, '') || `${operation} failed`, error.code);
}

function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new AssistantError(`${what} returned an unexpected shape:\n${z.prettifyError(parsed.error)}`, 'INVALID_RESPONSE');
  }
  return parsed.data;
}

async function call<T>(client: AssistantClient, fn: string, args: object, schema: z.ZodType<T>): Promise<T> {
  const { data, error } = await client.rpc(fn, args);
  if (error) {
    throw serverError(fn, error);
  }
  return parse(schema, data, fn);
}

// -----------------------------------------------------------------------------------------
// The thread
// -----------------------------------------------------------------------------------------

/** The latest `limit` messages of one thread (null: the project's main thread), oldest first. */
export async function loadThread(client: Pick<AssistantClient, 'from'>, projectId: string, threadId: string | null = null, limit = 200): Promise<AgentMessageRow[]> {
  const base = client.from('agent_messages').select('*').eq('project_id', projectId);
  const { data, error } = await (threadId === null ? base.is('thread_id', null) : base.eq('thread_id', threadId))
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit);
  if (error) {
    throw new AssistantError(`Cannot read the assistant thread: ${error.message}`, error.code);
  }
  return parse(z.array(AgentMessageRow), data ?? [], 'agent_messages').reverse();
}

export interface PostAgentMessageOptions {
  /** 'text' (default) or 'voice'. */
  channel?: PersonChannel;
  /** The card button pressed, when the message comes from one. */
  action?: AgentAction | null;
  /** The thread; null (default) for the main thread. */
  threadId?: string | null;
  /** What the person had selected and how their changes apply. */
  context?: AgentMessageContext | null;
}

/**
 * Writes the signed-in person's message (trimmed, 1-2000 characters). The database announces it on
 * the agent topic, which is how the agent service hears it.
 */
export async function postAgentMessage(
  client: AssistantClient,
  projectId: string,
  text: string,
  options: PostAgentMessageOptions = {},
): Promise<AgentMessageRow> {
  const action = options.action ?? null;
  if (action !== null && !AgentAction.safeParse(action).success) {
    throw new AssistantError('The card action is not one the assistant understands.', 'INVALID_ARGUMENT');
  }
  const context = options.context ?? null;
  if (context !== null && !AgentMessageContext.safeParse(context).success) {
    throw new AssistantError('The selection sent with the message does not have the expected shape.', 'INVALID_ARGUMENT');
  }
  return call(
    client,
    'post_agent_message',
    { p_project: projectId, p_text: text, p_channel: options.channel ?? 'text', p_action: action, p_thread: options.threadId ?? null, p_context: context },
    AgentMessageRow,
  );
}

// -----------------------------------------------------------------------------------------
// Threads
// -----------------------------------------------------------------------------------------

export interface ThreadList {
  threads: AgentThreadRow[];
  /** When the main thread last had a message (null: never). */
  mainLastMessageAt: string | null;
  /** Who was invited into the private threads this person can see. */
  members: AgentThreadMemberRow[];
}

/** The threads this person can see, busiest first, who is in the private ones, and when the main thread was last written in. */
export async function loadThreads(client: Pick<AssistantClient, 'from'>, projectId: string): Promise<ThreadList> {
  const [threads, main] = await Promise.all([
    client.from('agent_threads').select('*').eq('project_id', projectId).order('last_message_at', { ascending: false }).limit(100),
    client.from('agent_messages').select('created_at').eq('project_id', projectId).is('thread_id', null).order('created_at', { ascending: false }).limit(1),
  ]);
  if (threads.error) throw new AssistantError(`Cannot read the threads: ${threads.error.message}`, threads.error.code);
  if (main.error) throw new AssistantError(`Cannot read the main thread: ${main.error.message}`, main.error.code);
  const rows = parse(z.array(AgentThreadRow), threads.data ?? [], 'agent_threads');
  const privateIds = rows.filter((thread) => thread.visibility === 'private').map((thread) => thread.id);
  let members: AgentThreadMemberRow[] = [];
  if (privateIds.length > 0) {
    const invited = await client.from('agent_thread_members').select('*').in('thread_id', privateIds);
    if (invited.error) throw new AssistantError(`Cannot read who is in the threads: ${invited.error.message}`, invited.error.code);
    members = parse(z.array(AgentThreadMemberRow), invited.data ?? [], 'agent_thread_members');
  }
  const latest = (main.data ?? [])[0] as { created_at?: unknown } | undefined;
  return { threads: rows, mainLastMessageAt: typeof latest?.created_at === 'string' ? latest.created_at : null, members };
}

/**
 * Starts a thread. `auto`: the title is the first words of its first message (the assistant names it
 * after answering); `private`: only its starter (and whoever they invite) reads it.
 */
export function createThread(client: AssistantClient, projectId: string, title: string, options: { auto?: boolean; private?: boolean } = {}): Promise<AgentThreadRow> {
  return call(client, 'create_agent_thread', { p_project: projectId, p_title: title, p_auto: options.auto ?? false, p_private: options.private ?? false }, AgentThreadRow);
}

/**
 * Brings a member into a private thread. Someone who cannot see costs, brought into a conversation
 * where someone can, comes in only with `shareCosts`: the caller (who sees costs) has agreed to share
 * the costs in it with them.
 */
export function inviteToThread(client: AssistantClient, threadId: string, userId: string, shareCosts = false): Promise<AgentThreadRow> {
  return call(client, 'invite_to_agent_thread', { p_thread: threadId, p_user: userId, p_share_costs: shareCosts }, AgentThreadRow);
}

/** Takes someone out of a private thread (its starter), or leaves it (oneself). */
export function removeFromThread(client: AssistantClient, threadId: string, userId: string): Promise<AgentThreadRow> {
  return call(client, 'remove_from_agent_thread', { p_thread: threadId, p_user: userId }, AgentThreadRow);
}

/** Shares a thread with the project (with `shareCosts` when that shares its costs too), or makes it private again. */
export function setThreadVisibility(client: AssistantClient, threadId: string, visibility: AgentThreadVisibility, shareCosts = false): Promise<AgentThreadRow> {
  return call(client, 'set_agent_thread_visibility', { p_thread: threadId, p_visibility: visibility, p_share_costs: shareCosts }, AgentThreadRow);
}

export function renameThread(client: AssistantClient, threadId: string, title: string): Promise<AgentThreadRow> {
  return call(client, 'rename_agent_thread', { p_thread: threadId, p_title: title }, AgentThreadRow);
}

/** Deletes a thread and its messages (its starter or a project manager); decisions stay in the changelog. */
export async function deleteThread(client: AssistantClient, threadId: string): Promise<void> {
  await call(client, 'delete_agent_thread', { p_thread: threadId }, z.string());
}

/** What people decided about the assistant's drafted changes, oldest first (the changelog lists them). */
export async function loadEditDecisions(client: Pick<AssistantClient, 'from'>, projectId: string): Promise<AgentEditDecisionRow[]> {
  const { data, error } = await client.from('agent_edit_decisions').select('*').eq('project_id', projectId).order('created_at', { ascending: true }).limit(500);
  if (error) throw new AssistantError(`Cannot read the decisions about the assistant's changes: ${error.message}`, error.code);
  return parse(z.array(AgentEditDecisionRow), data ?? [], 'agent_edit_decisions');
}

// -----------------------------------------------------------------------------------------
// Commands
// -----------------------------------------------------------------------------------------

/** One command, as the members may read it. */
export async function loadCommand(client: Pick<AssistantClient, 'from'>, id: string): Promise<AgentCommandRow> {
  const { data, error } = await client.from('agent_commands').select('*').eq('id', id).maybeSingle();
  if (error) {
    throw new AssistantError(`Cannot read command ${id}: ${error.message}`, error.code);
  }
  if (data === null) {
    throw new AssistantError(`Command ${id} not found`, 'P0002');
  }
  return parse(AgentCommandRow, data, 'agent_commands');
}

/**
 * This tab takes a pending command to run it. The requester's tabs may take it at once, any member's
 * tab AGENT_COMMAND_OPEN_AFTER_MS after it was made; when another tab got there first the server
 * refuses with code 55000.
 */
export function claimAgentCommand(client: AssistantClient, commandId: string, sessionId: string): Promise<AgentCommandRow> {
  return call(client, 'claim_agent_command', { p_command: commandId, p_session: sessionId }, AgentCommandRow);
}

/** The claiming tab reports how the command ended (the result at most 8 KB). */
export async function completeAgentCommand(
  client: AssistantClient,
  commandId: string,
  sessionId: string,
  status: AgentCommandOutcome,
  result: AgentCommandResult | null,
): Promise<AgentCommandRow> {
  if (result !== null && !AgentCommandResult.safeParse(result).success) {
    throw new AssistantError('The command result does not have the shape the agent reads.', 'INVALID_ARGUMENT');
  }
  return call(
    client,
    'complete_agent_command',
    { p_command: commandId, p_session: sessionId, p_status: status, p_result: result },
    AgentCommandRow,
  );
}
