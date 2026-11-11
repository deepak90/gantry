/**
 * ProjectStore over supabase-js with the service role. Rows are validated with the shared schemas;
 * a row that does not fit is skipped with a warning instead of stopping the agent.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  AgentCommandRow,
  AgentEditDecisionRow,
  AgentMessageRow,
  AgentThreadMemberRow,
  AgentThreadRow,
  ApprovalRow,
  InvoiceRow,
  LibraryFolderRow,
  LibrarySnippetRow,
  PaymentAuthorizationRow,
  ProjectDocumentRow,
  ProposalRow,
  ProposalVersionRow,
  PublicationRow,
  ReviewRow,
  SupplierConfirmationRow,
  WatchRuleRow,
  WatchRunRow,
} from '@collab/shared';
import type { z } from 'zod';
import type { Logger } from '../log';
import type { BookingRowInput, MemberRowInput, PlanRows, ProfileRowInput, ProjectRowInput, RevisionRowInput } from '../plan/rows';
import type { WorkflowRows } from '../workflow/state';
import type { LibraryRows, NewAssistantMessage, NewCommand, NewThread, NewWatchRun, ProjectStore, WatchRows } from './store';

export class StoreError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
  ) {
    super(message);
    this.name = 'StoreError';
  }
}

type Result<T> = { data: T | null; error: { message: string; code?: string } | null };

function unwrap<T>(what: string, result: Result<T>): T {
  if (result.error) throw new StoreError(`${what}: ${result.error.message}`, result.error.code);
  return result.data as T;
}

export class SupabaseStore implements ProjectStore {
  constructor(
    private readonly client: SupabaseClient,
    private readonly log: Logger,
    private readonly onlyProjects: string[] | null = null,
  ) {}

  private rows<T>(table: string, schema: z.ZodType<T>, data: unknown[]): T[] {
    const out: T[] = [];
    for (const row of data) {
      const parsed = schema.safeParse(row);
      if (parsed.success) out.push(parsed.data);
      else this.log.warn(`skipped a ${table} row that does not fit the shared schema (${parsed.error.issues[0]?.path.join('.') ?? '?'}: ${parsed.error.issues[0]?.message ?? ''})`);
    }
    return out;
  }

  private async select<T>(table: string, schema: z.ZodType<T>, projectId: string, order = 'created_at'): Promise<T[]> {
    const data = unwrap(table, (await this.client.from(table).select('*').eq('project_id', projectId).order(order, { ascending: true })) as Result<unknown[]>);
    return this.rows(table, schema, data ?? []);
  }

  async listProjects(): Promise<string[]> {
    if (this.onlyProjects) return this.onlyProjects;
    const data = unwrap('projects', (await this.client.from('projects').select('id').order('created_at', { ascending: true })) as Result<{ id: string }[]>);
    return (data ?? []).map((row) => row.id);
  }

  async loadPlanRows(projectId: string): Promise<PlanRows> {
    const project = unwrap(
      'projects',
      (await this.client
        .from('projects')
        .select('id, name, currency, current_revision, snapshot_revision, handover_task_id, client_name, snapshot')
        .eq('id', projectId)
        .single()) as Result<ProjectRowInput & { snapshot_revision: number }>,
    );
    const [revisions, bookings, members, rule] = await Promise.all([
      this.client
        .from('project_revisions')
        .select('revision_no, changes, created_at, actor_user_id, origin')
        .eq('project_id', projectId)
        .gt('revision_no', project.snapshot_revision)
        .order('revision_no', { ascending: true }),
      this.client
        .from('equipment_bookings')
        .select('id, task_id, resource_id, supplier_name, rental_rate_minor, currency, billable_start, billable_end')
        .eq('project_id', projectId)
        .order('billable_start', { ascending: true }),
      this.client.from('project_members').select('user_id, role, approval_limit_minor, can_view_costs').eq('project_id', projectId),
      // The two-person rule for progress payouts: read on its own, so a database without the column still loads the plan.
      this.client.from('projects').select('second_approval_over_minor').eq('id', projectId).maybeSingle(),
    ]);
    const over = (rule as Result<{ second_approval_over_minor?: number | null } | null>).data?.second_approval_over_minor;
    if (typeof over === 'number') project.second_approval_over_minor = over;
    const memberRows = unwrap('project_members', members as Result<MemberRowInput[]>) ?? [];
    const profiles = memberRows.length
      ? (unwrap(
          'profiles',
          (await this.client
            .from('profiles')
            .select('user_id, display_name')
            .in(
              'user_id',
              memberRows.map((member) => member.user_id),
            )) as Result<ProfileRowInput[]>,
        ) ?? [])
      : [];
    return {
      project,
      revisions: unwrap('project_revisions', revisions as Result<RevisionRowInput[]>) ?? [],
      bookings: unwrap('equipment_bookings', bookings as Result<BookingRowInput[]>) ?? [],
      members: memberRows,
      profiles,
    };
  }

  async loadWorkflow(projectId: string): Promise<WorkflowRows> {
    const [proposals, versions, reviews, approvals, payments, publications, confirmations, documents, invoices] = await Promise.all([
      this.select('proposals', ProposalRow, projectId),
      this.select('proposal_versions', ProposalVersionRow, projectId),
      this.select('reviews', ReviewRow, projectId),
      this.select('approvals', ApprovalRow, projectId),
      this.select('payment_authorizations', PaymentAuthorizationRow, projectId),
      this.select('publications', PublicationRow, projectId),
      this.select('supplier_confirmations', SupplierConfirmationRow, projectId, 'updated_at'),
      this.select('project_documents', ProjectDocumentRow, projectId),
      this.select('invoices', InvoiceRow, projectId),
    ]);
    return { proposals, versions, reviews, approvals, payments, publications, confirmations, documents, invoices };
  }

  async loadLibrary(projectId: string): Promise<LibraryRows> {
    const [folders, snippets] = await Promise.all([
      this.select('library_folders', LibraryFolderRow, projectId, 'position'),
      this.select('library_snippets', LibrarySnippetRow, projectId, 'position'),
    ]);
    return { folders, snippets };
  }

  async getMessage(id: string) {
    const data = unwrap('agent_messages', (await this.client.from('agent_messages').select('*').eq('id', id).maybeSingle()) as Result<unknown>);
    if (!data) return null;
    const parsed = AgentMessageRow.safeParse(data);
    if (!parsed.success) {
      this.log.warn(`agent_messages ${id} does not fit the contract: ${parsed.error.issues[0]?.message ?? ''}`);
      return null;
    }
    return parsed.data;
  }

  async recentMessages(projectId: string, limit: number, thread?: string | null) {
    let query = this.client.from('agent_messages').select('*').eq('project_id', projectId);
    if (thread === null) query = query.is('thread_id', null);
    else if (thread !== undefined) query = query.eq('thread_id', thread);
    const data = unwrap('agent_messages', (await query.order('created_at', { ascending: false }).limit(limit)) as Result<unknown[]>);
    return this.rows('agent_messages', AgentMessageRow, data ?? []).reverse();
  }

  async listThreads(projectId: string) {
    return this.select('agent_threads', AgentThreadRow, projectId);
  }

  async listThreadMembers(projectId: string) {
    const threads = await this.listThreads(projectId);
    if (threads.length === 0) return [];
    const data = unwrap(
      'agent_thread_members',
      (await this.client
        .from('agent_thread_members')
        .select('*')
        .in(
          'thread_id',
          threads.map((thread) => thread.id),
        )) as Result<unknown[]>,
    );
    return this.rows('agent_thread_members', AgentThreadMemberRow, data ?? []);
  }

  async nameThread(threadId: string, title: string) {
    const data = unwrap('name_agent_thread', (await this.client.rpc('name_agent_thread', { p_thread: threadId, p_title: title })) as Result<unknown>);
    const parsed = AgentThreadRow.safeParse(data);
    return parsed.success && parsed.data.id ? parsed.data : null;
  }

  async loadEditDecisions(projectId: string) {
    return this.select('agent_edit_decisions', AgentEditDecisionRow, projectId);
  }

  async insertAssistantMessage(message: NewAssistantMessage): Promise<string> {
    const data = unwrap(
      'agent_messages',
      (await this.client
        .from('agent_messages')
        .insert({ ...message, role: 'assistant', author_id: null, action: null })
        .select('id')
        .single()) as Result<{ id: string }>,
    );
    return data.id;
  }

  async insertCommand(command: NewCommand): Promise<string> {
    const data = unwrap(
      'agent_commands',
      (await this.client
        .from('agent_commands')
        .insert({ ...command, status: 'pending' })
        .select('id')
        .single()) as Result<{ id: string }>,
    );
    return data.id;
  }

  async getCommand(id: string) {
    const data = unwrap('agent_commands', (await this.client.from('agent_commands').select('*').eq('id', id).maybeSingle()) as Result<unknown>);
    if (!data) return null;
    const parsed = AgentCommandRow.safeParse(data);
    if (!parsed.success) {
      this.log.warn(`agent_commands ${id} does not fit the contract: ${parsed.error.issues[0]?.message ?? ''}`);
      return null;
    }
    return parsed.data;
  }

  async createThread(thread: NewThread) {
    const data = unwrap('agent_threads', (await this.client.from('agent_threads').insert({ ...thread, title: thread.title.slice(0, 80), title_source: 'person' }).select('*').single()) as Result<unknown>);
    return AgentThreadRow.parse(data);
  }

  async loadWatch(projectId: string): Promise<WatchRows> {
    const [rules, open] = await Promise.all([
      this.select('watch_rules', WatchRuleRow, projectId),
      this.client.from('watch_runs').select('*').eq('project_id', projectId).is('resolved_at', null).order('fired_at', { ascending: true }),
    ]);
    return { rules, open: this.rows('watch_runs', WatchRunRow, unwrap('watch_runs', open as Result<unknown[]>) ?? []) };
  }

  async insertWatchRun(run: NewWatchRun) {
    const result = (await this.client.from('watch_runs').insert(run).select('*').single()) as Result<unknown>;
    // The partial unique index keeps one open run per situation: someone else opened it first.
    if (result.error?.code === '23505') return null;
    return WatchRunRow.parse(unwrap('watch_runs', result));
  }

  async resolveWatchRuns(ids: readonly string[]) {
    if (ids.length === 0) return;
    unwrap('watch_runs', (await this.client.from('watch_runs').update({ resolved_at: new Date().toISOString() }).in('id', [...ids]).is('resolved_at', null)) as Result<unknown>);
  }

  async setWatchRunThread(ids: readonly string[], threadId: string) {
    if (ids.length === 0) return;
    unwrap('watch_runs', (await this.client.from('watch_runs').update({ thread_id: threadId }).in('id', [...ids])) as Result<unknown>);
  }

  async copyVisit(projectId: string): Promise<string | null> {
    const data = unwrap('copy_pool', (await this.client.from('copy_pool').select('claimed_at').eq('project_id', projectId).maybeSingle()) as Result<{ claimed_at: string | null } | null>);
    return data?.claimed_at ?? null;
  }

  async cancelCommandIfPending(id: string): Promise<boolean> {
    const data = unwrap(
      'agent_commands',
      (await this.client
        .from('agent_commands')
        .update({ status: 'cancelled', completed_at: new Date().toISOString(), result: { message: 'Nobody’s browser took the request in time.' } })
        .eq('id', id)
        .eq('status', 'pending')
        .select('id')) as Result<{ id: string }[]>,
    );
    return (data ?? []).length > 0;
  }
}
