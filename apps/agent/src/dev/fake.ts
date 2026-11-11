/**
 * In-memory stand-ins for the database, Realtime and the people's browsers, built from the seed:
 * the tests run the real ProjectAgent against them. The fake browser does
 * what the app does for a command (create or correct the proposal under the requester's name, check
 * it, record the evaluation) and what people do with their buttons (approve the fix, publish, pay,
 * file the receipt, decline), with the same rules as the SQL.
 *
 * One role for everyone: the seed's two people are keyed by their demo login, `pm` (pm@demo.local,
 * Chris) and `cm` (cm@demo.local, Deepak), not by a role; both see costs and approve fixes. Other
 * members (e.g. a site teammate who cannot see costs) are added with `FakeDb.addMember` and named by
 * their user id.
 */
import {
  Evaluation,
  ProposeFixArgs,
  ReviseFixArgs,
  type AgentAction,
  type AgentChannel,
  type AgentCommandRow,
  type AgentEditDecisionRow,
  type AgentMessageRow,
  type AgentThreadMemberRow,
  type AgentThreadRow,
  type AgentStreamEvent,
  type ApprovalRow,
  type PaymentAuthorizationRow,
  type ProjectDocumentRow,
  type ProposalInputs,
  type ProposalRow,
  type ProposalVersionRow,
  type WatchRuleRow,
  type WatchRunRow,
} from '@collab/shared';
import { compareCosts, idleRentalDays, rentalDays, toCostComparisonRecord } from '@collab/shared';
import { STARTER_FOLDERS, starterSnippet, type StarterFolder } from '@collab/shared/library-starter';
import { riversideClinic, SEED_IDS, SEED_MEMBERS } from '@collab/shared/seed';
import { randomUUID } from 'node:crypto';
import type { LibraryRows, NewAssistantMessage, NewCommand, NewThread, NewWatchRun, ProjectStore, WatchRows } from '../data/store';
import { planFromRows, type PlanRows } from '../plan/rows';
import type { PresenceState } from '../realtime/presence';
import type { AgentTransport, TransportHandlers } from '../realtime/transport';
import { activeApprovals, currentVersion, openProposal, type WorkflowRows } from '../workflow/state';

const now = () => new Date().toISOString();

/** The seed's two people by their demo login: `pm` is pm@demo.local (Chris), `cm` is cm@demo.local (Deepak). */
export type SeedPerson = 'pm' | 'cm';
/** A seed person, or any member's user id. */
export type Person = SeedPerson | (string & {});

const SEED_LOGINS: Record<SeedPerson, { email: string; userId: string }> = {
  pm: { email: 'pm@demo.local', userId: SEED_IDS.pmUser },
  cm: { email: 'cm@demo.local', userId: SEED_IDS.cmUser },
};

export function userIdOf(person: Person): string {
  return person === 'pm' ? SEED_LOGINS.pm.userId : person === 'cm' ? SEED_LOGINS.cm.userId : person;
}

function seedMember(person: SeedPerson) {
  const member = SEED_MEMBERS.find((candidate) => candidate.email === SEED_LOGINS[person].email);
  if (!member) throw new Error(`no seed member with the login ${SEED_LOGINS[person].email}`);
  return member;
}

const userIdOfSeedMember = (email: string): string => (email === SEED_LOGINS.pm.email ? SEED_IDS.pmUser : SEED_IDS.cmUser);

export const QUOTE_TEXT = `NORTHGATE EQUIPMENT RENTAL — QUOTATION
Quote number: NER-Q-26-0412
Subject: crane rental for Erect structural steel frame (task 15)

Your booking
Equipment: crane with operator, for the steel frame erection
Booked: 11 days, weekends included, from Mon, Dec 7, 2026, off rent Fri, Dec 18, 2026
Day rate: $600.00 a day on rent

Payment
Nothing is due until the rental dates are confirmed. You pay the day rate for every day of the rental as confirmed, weekends included, by PayPal to the account on file. The dates can be moved, shortened or extended until the crane is delivered.`;

export class FakeDb implements ProjectStore {
  readonly projectId = SEED_IDS.project;
  plan: PlanRows;
  workflow: WorkflowRows;
  messages: AgentMessageRow[] = [];
  threads: AgentThreadRow[] = [];
  threadMembers: AgentThreadMemberRow[] = [];
  decisions: AgentEditDecisionRow[] = [];
  commands: AgentCommandRow[] = [];
  library: LibraryRows = { folders: [], snippets: [] };
  watchRules: WatchRuleRow[] = [];
  watchRuns: WatchRunRow[] = [];
  /** Fails inserts into agent_messages (the table before its migration). */
  messagesTableMissing = false;
  /** When the visit to this project, as a copy of the hosted demo, began (`copy_pool.claimed_at`); null: no visit. */
  claimedAt: string | null = null;
  private counter = 0;

  /** Row ids; deterministic ones make a recorded live run replayable (the model saw these ids). */
  newId(): string {
    if (!this.deterministic) return randomUUID();
    this.counter += 1;
    return `00000000-0000-4000-8000-${String(this.counter).padStart(12, '0')}`;
  }

  constructor(private readonly deterministic = false) {
    const booking = riversideClinic.booking;
    this.plan = {
      project: {
        id: SEED_IDS.project,
        name: riversideClinic.name,
        currency: 'USD',
        current_revision: 0,
        handover_task_id: riversideClinic.handover_task_id,
        snapshot: riversideClinic.inlineData as unknown as PlanRows['project']['snapshot'],
      },
      revisions: [],
      bookings: [
        {
          id: SEED_IDS.booking,
          task_id: booking.task_id,
          resource_id: booking.resource_id,
          supplier_name: booking.supplier_name,
          rental_rate_minor: booking.rental_rate_minor,
          currency: 'USD',
          billable_start: booking.billable_start,
          billable_end: booking.billable_end,
        },
      ],
      members: SEED_MEMBERS.map((member) => ({
        user_id: userIdOfSeedMember(member.email),
        role: member.role,
        approval_limit_minor: member.approval_limit_minor,
        can_view_costs: member.can_view_costs,
      })),
      profiles: SEED_MEMBERS.map((member) => ({ user_id: userIdOfSeedMember(member.email), display_name: member.display_name })),
    };
    const quote: ProjectDocumentRow = {
      id: SEED_IDS.quoteDocument,
      project_id: SEED_IDS.project,
      task_id: booking.task_id,
      kind: 'quote',
      name: 'Northgate Equipment Rental - Quotation NER-Q-26-0412.pdf',
      mime_type: 'application/pdf',
      size_bytes: 4096,
      storage_path: `${SEED_IDS.project}/${SEED_IDS.quoteDocument}/northgate-quote.pdf`,
      cost_sensitive: true,
      text_content: QUOTE_TEXT,
      summary: 'Northgate Equipment Rental quotation: crane rental at $600.00 a day, 11 days from Mon, Dec 7, paid once the dates are confirmed',
      payment_authorization_id: null,
      created_by: null,
      created_via: 'system',
      created_at: '2026-10-23T08:00:00.000Z',
    };
    this.workflow = { proposals: [], versions: [], reviews: [], approvals: [], payments: [], publications: [], confirmations: [], documents: [quote] };
    this.library = this.starterLibrary();
  }

  /**
   * Adds a project member, by default one like the crowd's simulated teammates: no cost access, no
   * approval limit (the permission model still exists in the data). Returns their user id.
   */
  addMember(member: { display_name: string; can_view_costs?: boolean; approval_limit_minor?: number; role?: 'pm' | 'cm'; user_id?: string }): string {
    const userId = member.user_id ?? `00000000-0000-4000-8000-0000000001${String(this.plan.members.length).padStart(2, '0')}`;
    this.plan.members.push({ user_id: userId, role: member.role ?? 'pm', approval_limit_minor: member.approval_limit_minor ?? 0, can_view_costs: member.can_view_costs ?? false });
    this.plan.profiles.push({ user_id: userId, display_name: member.display_name });
    return userId;
  }

  /** The starter library as seed_library() writes it (snippet ids are the starter keys, so tests can name them). */
  private starterLibrary(): LibraryRows {
    const rows: LibraryRows = { folders: [], snippets: [] };
    const at = '2026-10-24T00:00:00.000Z';
    const walk = (folders: readonly StarterFolder[], parentId: string | null) =>
      folders.forEach((folder, index) => {
        const id = this.newId();
        rows.folders.push({ id, project_id: this.projectId, parent_id: parentId, name: folder.name, position: index + 1, created_by: null, created_at: at, updated_at: at });
        folder.snippets.forEach((key, order) => {
          const { starterKey, name, summary, icon, unit, children, links, timeRanges } = starterSnippet(key)!;
          rows.snippets.push({
            id: starterKey,
            project_id: this.projectId,
            folder_id: id,
            name,
            summary,
            icon,
            unit_one: unit.one,
            unit_many: unit.many,
            body: { children, links, ...(timeRanges ? { timeRanges } : {}) },
            position: order + 1,
            origin: 'starter',
            created_by: null,
            updated_by: null,
            created_at: at,
            updated_at: at,
          });
        });
        walk(folder.folders ?? [], id);
      });
    walk(STARTER_FOLDERS, null);
    return rows;
  }

  // ---- ProjectStore ------------------------------------------------------------------------
  async listProjects() {
    return [this.projectId];
  }
  async loadPlanRows() {
    return structuredClone(this.plan);
  }
  async loadWorkflow() {
    return structuredClone(this.workflow);
  }
  async loadLibrary() {
    return structuredClone(this.library);
  }
  async getMessage(id: string) {
    return structuredClone(this.messages.find((message) => message.id === id) ?? null);
  }
  async recentMessages(_projectId: string, limit: number, thread?: string | null) {
    const rows = thread === undefined ? this.messages : this.messages.filter((message) => (message.thread_id ?? null) === thread);
    return structuredClone(rows.slice(-limit));
  }
  async listThreads() {
    return structuredClone(this.threads);
  }
  async listThreadMembers() {
    return structuredClone(this.threadMembers);
  }
  async nameThread(threadId: string, title: string) {
    const thread = this.threads.find((candidate) => candidate.id === threadId && candidate.title_source === 'auto');
    if (!thread) return null;
    thread.title = title.slice(0, 80);
    thread.title_source = 'agent';
    return structuredClone(thread);
  }
  async loadEditDecisions() {
    return structuredClone(this.decisions);
  }
  async copyVisit() {
    return this.claimedAt;
  }
  async insertAssistantMessage(message: NewAssistantMessage) {
    if (this.messagesTableMissing) throw new Error('relation "public.agent_messages" does not exist');
    const row: AgentMessageRow = { id: this.newId(), ...message, role: 'assistant', author_id: null, action: null, created_at: now() };
    this.messages.push(row);
    return row.id;
  }
  async insertCommand(command: NewCommand) {
    const row: AgentCommandRow = { id: this.newId(), ...command, executor_session: null, status: 'pending', result: null, created_at: now(), completed_at: null };
    this.commands.push(row);
    this.onCommandInserted?.(row);
    return row.id;
  }
  async getCommand(id: string) {
    return structuredClone(this.commands.find((command) => command.id === id) ?? null);
  }
  async cancelCommandIfPending(id: string) {
    const row = this.commands.find((command) => command.id === id);
    if (!row || row.status !== 'pending') return false;
    row.status = 'cancelled';
    row.completed_at = now();
    return true;
  }

  async createThread(thread: NewThread) {
    const at = now();
    const row: AgentThreadRow = { id: this.newId(), ...thread, title: thread.title.slice(0, 80), title_source: 'person', created_at: at, last_message_at: at, costs_shared_by: null, costs_shared_at: null };
    this.threads.push(row);
    return structuredClone(row);
  }
  async loadWatch(): Promise<WatchRows> {
    return structuredClone({ rules: this.watchRules, open: this.watchRuns.filter((run) => run.resolved_at === null) });
  }
  async insertWatchRun(run: NewWatchRun) {
    if (this.watchRuns.some((other) => other.rule_id === run.rule_id && other.situation === run.situation && other.resolved_at === null)) return null;
    const row: WatchRunRow = { id: this.newId(), ...run, thread_id: null, fired_at: now(), resolved_at: null };
    this.watchRuns.push(row);
    return structuredClone(row);
  }
  async resolveWatchRuns(ids: readonly string[]) {
    for (const run of this.watchRuns) if (ids.includes(run.id) && run.resolved_at === null) run.resolved_at = now();
  }
  async setWatchRunThread(ids: readonly string[], threadId: string) {
    for (const run of this.watchRuns) if (ids.includes(run.id)) run.thread_id = threadId;
  }

  /** A person saves a watch rule (save_watch_rule); the database announces it on the workflow topic. */
  saveWatchRule(rule: Partial<WatchRuleRow> & Pick<WatchRuleRow, 'name' | 'scope' | 'condition'>): WatchRuleRow {
    const at = now();
    const existing = rule.id ? this.watchRules.find((candidate) => candidate.id === rule.id) : undefined;
    if (existing) {
      Object.assign(existing, rule, { updated_at: new Date(Date.now() + 1).toISOString() });
      for (const run of this.watchRuns) if (run.rule_id === existing.id && run.resolved_at === null) run.resolved_at = at;
      return structuredClone(existing);
    }
    const row: WatchRuleRow = {
      id: this.newId(),
      project_id: this.projectId,
      trigger: { kind: 'change' },
      action: { kind: 'alert' },
      enabled: true,
      created_by: null,
      thread_id: null,
      created_at: at,
      updated_at: at,
      ...rule,
    };
    this.watchRules.push(row);
    return structuredClone(row);
  }

  onCommandInserted?: (row: AgentCommandRow) => void;

  /** What `pnpm demo:reset` does: thread, commands, proposals and revisions gone; the seed booking back. */
  demoReset(): void {
    const seed = new FakeDb();
    this.messages = [];
    this.commands = [];
    this.plan = seed.plan;
    this.workflow = seed.workflow;
  }

  postPersonMessage(
    authorId: string,
    text: string,
    channel: AgentChannel,
    action: AgentAction | null = null,
    extra: Pick<AgentMessageRow, 'thread_id' | 'context'> = {},
  ): AgentMessageRow {
    const row: AgentMessageRow = {
      id: this.newId(),
      project_id: this.projectId,
      thread_id: extra.thread_id ?? null,
      turn_id: null,
      role: 'person',
      author_id: authorId,
      channel,
      text,
      cards: [],
      action,
      context: extra.context ?? null,
      created_at: now(),
    };
    this.messages.push(row);
    return row;
  }
}

export class FakeTransport implements AgentTransport {
  readonly sent: AgentStreamEvent[] = [];
  /** The topic each sent event went to (undefined: the project's agent topic), in step with `sent`. */
  readonly topics: (string | undefined)[] = [];
  private handlers = new Map<string, TransportHandlers>();
  connect(projectId: string, handlers: TransportHandlers) {
    this.handlers.set(projectId, handlers);
  }
  sendStream(_projectId: string, event: AgentStreamEvent, topic?: string) {
    this.sent.push(event);
    this.topics.push(topic);
  }
  async disconnect(projectId?: string) {
    if (projectId) this.handlers.delete(projectId);
    else this.handlers.clear();
  }
  private h(projectId: string): TransportHandlers {
    const handlers = this.handlers.get(projectId);
    if (!handlers) throw new Error(`not connected: ${projectId}`);
    return handlers;
  }
  presence(projectId: string, state: PresenceState) {
    this.h(projectId).onPresence(state);
  }
  workflowChanged(projectId: string, table: string | null = null) {
    this.h(projectId).onWorkflowChange({ table });
  }
  revision(projectId: string) {
    this.h(projectId).onRevision();
  }
  message(projectId: string, id: string) {
    this.h(projectId).onAgentMessage(id);
  }
  command(projectId: string, id: string) {
    this.h(projectId).onCommand?.(id);
  }
  thread(projectId: string, id: string, op: 'insert' | 'update' | 'delete') {
    this.h(projectId).onThread?.(id, op);
  }
}

/** Presence with one tab per seed person; `generation` gives new session ids (a browser reload). */
export function presenceOf(...people: SeedPerson[]): PresenceState {
  return presenceAt(0, ...people);
}

export function presenceAt(generation: number, ...people: SeedPerson[]): PresenceState {
  const state: Record<string, unknown[]> = {};
  people.forEach((person, index) => {
    const session = `00000000-0000-4000-8000-00000000${generation % 10}9${index}${person === 'pm' ? 1 : 2}`;
    const member = seedMember(person);
    state[session] = [{ session, user: userIdOf(person), name: member.display_name, role: member.role, color: member.color, since: 1_000 + index, taskId: null, following: null }];
  });
  return state;
}

/** What the people's browsers do: run commands, and the buttons people press. */
export class FakeBrowser {
  constructor(
    private readonly db: FakeDb,
    private readonly transport: FakeTransport,
    private readonly options: { commandDelayMs?: number; failNext?: string | null } = {},
  ) {
    db.onCommandInserted = (row) => {
      setTimeout(() => void this.runCommand(row.id), options.commandDelayMs ?? 30);
    };
  }

  /** Makes the next command fail with this message (as the browser would report it). */
  failNextCommand(message: string): void {
    this.options.failNext = message;
  }

  /** Never claims commands (nobody's tab is open). */
  ignoreCommands(): void {
    this.db.onCommandInserted = undefined;
  }

  private changed(): void {
    this.transport.workflowChanged(this.db.projectId);
  }

  private evaluation(inputs: ProposalInputs, assumptions: ProposalVersionRow['assumptions']): Evaluation {
    const plan = planFromRows(this.db.plan);
    const booking = plan.bookings[0]!;
    const handover = plan.tasks.find((task) => task.id === plan.handoverTaskId)!;
    const [published, revised] = [rentalDays(booking.billableStart, booking.billableEnd), rentalDays(inputs.new_start, inputs.new_end)];
    const idle = idleRentalDays({ start: inputs.new_start, end: inputs.new_end }, plan.tasks.find((task) => task.id === booking.taskId)!);
    return Evaluation.parse({
      source_revision: this.db.plan.project.current_revision,
      inputs,
      assumptions,
      schedule_impact: {
        handover: { published_end: handover.start, proposed_end: handover.start, delta_days: 0 },
        affected_tasks: [],
        over_allocations: [],
      },
      cost_comparison: toCostComparisonRecord(compareCosts({ currency: booking.currency, rentalRateMinor: booking.rentalRateMinor, bookedDays: published, revisedDays: revised })),
      booking_days: {
        published_billable_days: published,
        revised_billable_days: revised,
        avoided_billable_days: Math.max(published - revised, 0),
        revised_idle_days: idle.before + idle.after,
      },
      unresolved_assumptions: assumptions.filter((assumption) => assumption.answer === null).map((assumption) => assumption.key),
      evaluated_at: now(),
    });
  }

  private settle(row: AgentCommandRow, status: 'succeeded' | 'failed', result: AgentCommandRow['result']): void {
    row.status = status;
    row.result = result;
    row.completed_at = now();
    this.transport.command(this.db.projectId, row.id);
  }

  async runCommand(id: string): Promise<void> {
    const row = this.db.commands.find((command) => command.id === id);
    if (!row || row.status !== 'pending') return;
    row.status = 'running';
    if (this.options.failNext) {
      const message = this.options.failNext;
      this.options.failNext = null;
      this.settle(row, 'failed', { message });
      return;
    }
    const wf = this.db.workflow;
    if (row.type === 'propose_fix') {
      const args = ProposeFixArgs.parse(row.args);
      const proposal: ProposalRow = { id: this.db.newId(), project_id: this.db.projectId, booking_id: args.booking_id, state: 'draft', current_version_no: 1, created_by: row.requested_by, created_at: now(), updated_at: now() };
      const version: ProposalVersionRow = {
        id: this.db.newId(),
        project_id: this.db.projectId,
        proposal_id: proposal.id,
        version_no: 1,
        source_revision: this.db.plan.project.current_revision,
        inputs: args.inputs,
        assumptions: args.assumptions,
        evaluation: null,
        stale: true,
        created_by: row.requested_by,
        created_via: 'agent',
        evaluated_by: null,
        transcript_segment_ids: [],
        created_at: now(),
      };
      wf.proposals.push(proposal);
      wf.versions.push(version);
      this.changed();
      version.evaluation = this.evaluation(version.inputs, version.assumptions);
      version.stale = false;
      version.evaluated_by = row.requested_by;
      proposal.state = 'evaluated';
      this.changed();
      this.settle(row, 'succeeded', { proposal_id: proposal.id, version_id: version.id, version_no: 1 });
      return;
    }
    if (row.type === 'revise_fix') {
      const args = ReviseFixArgs.parse(row.args);
      const old = wf.versions.find((version) => version.id === args.version_id);
      const proposal = old ? wf.proposals.find((candidate) => candidate.id === old.proposal_id) : undefined;
      if (!old || !proposal || proposal.current_version_no !== old.version_no) {
        this.settle(row, 'failed', { message: 'That version is no longer the current one.' });
        return;
      }
      const inputs = { ...old.inputs, ...args.changes } as ProposalInputs;
      const assumptions = old.assumptions.map((assumption) => {
        const answer = args.answers.find((candidate) => candidate.key === assumption.key);
        return answer ? { ...assumption, answer: answer.answer, resolved_by: 'agent' as const } : assumption;
      });
      const version: ProposalVersionRow = { ...old, id: this.db.newId(), version_no: old.version_no + 1, inputs, assumptions, evaluation: null, stale: true, created_by: row.requested_by, created_via: 'agent', created_at: now() };
      wf.reviews.push({ id: this.db.newId(), project_id: this.db.projectId, proposal_version_id: old.id, reviewer_id: row.requested_by, kind: 'correction', payload: { reason: args.reason, changes: args.changes, created_via: 'agent', next_version_no: version.version_no }, created_at: now() });
      for (const approval of wf.approvals.filter((candidate) => candidate.proposal_version_id === old.id && candidate.status === 'active')) {
        approval.status = 'invalidated';
        approval.invalidated_reason = `Superseded by version ${version.version_no}: ${args.reason}`;
        approval.invalidated_at = now();
      }
      wf.versions.push(version);
      proposal.current_version_no = version.version_no;
      proposal.state = 'in_review';
      version.evaluation = this.evaluation(inputs, assumptions);
      version.stale = false;
      this.changed();
      this.settle(row, 'succeeded', { proposal_id: proposal.id, version_id: version.id, version_no: version.version_no });
      return;
    }
    this.settle(row, 'failed', { message: `unknown command ${row.type}` });
  }

  // ---- people's buttons ------------------------------------------------------------------
  /**
   * "Approve the fix" (approve_fix): the new dates and the payment in one click, by one person, at the
   * same moment; the database records both scopes. Same rules as the SQL: any member approves the
   * dates; the payment needs someone who sees costs, within their limit.
   */
  approveFix(person: Person): { schedule: ApprovalRow; payment: ApprovalRow } {
    const wf = this.db.workflow;
    const proposal = openProposal(wf);
    const before = { approvals: wf.approvals.length, state: proposal?.state };
    const at = now();
    try {
      const schedule = this.insertApproval(person, 'schedule', at);
      const payment = this.insertApproval(person, 'payment', at);
      this.changed();
      return { schedule, payment };
    } catch (error) {
      // One transaction in the database: a refused payment leaves no dates approval behind.
      wf.approvals.length = before.approvals;
      if (proposal && before.state) proposal.state = before.state;
      throw error;
    }
  }

  /** One scope alone (approve_proposal): what an older or cut-short approval leaves behind. */
  approve(person: Person, scope: 'schedule' | 'payment'): ApprovalRow {
    const approval = this.insertApproval(person, scope, now());
    this.changed();
    return approval;
  }

  private insertApproval(person: Person, scope: 'schedule' | 'payment', at: string): ApprovalRow {
    const wf = this.db.workflow;
    const proposal = openProposal(wf);
    const version = proposal ? currentVersion(wf, proposal) : null;
    if (!proposal || !version?.evaluation) throw new Error('nothing to approve');
    const userId = userIdOf(person);
    const member = this.db.plan.members.find((candidate) => candidate.user_id === userId);
    if (!member) throw new Error('approve_proposal: not a member of this project');
    const active = activeApprovals(wf, version);
    const existing = active[scope];
    if (existing) return existing;
    const amount = version.evaluation.cost_comparison.supplier_payment_minor;
    if (scope === 'payment') {
      if (!member.can_view_costs) throw new Error('approve_proposal: only a member who can see costs approves the payment');
      if (!active.schedule) throw new Error('approve_proposal: the dates are approved first');
      if (amount > member.approval_limit_minor) throw new Error('approve_proposal: the payment exceeds your approval limit');
    }
    const approval: ApprovalRow = {
      id: this.db.newId(),
      project_id: this.db.projectId,
      proposal_version_id: version.id,
      approver_id: userId,
      scope,
      content_hash: 'fake',
      amount_minor: scope === 'payment' ? amount : null,
      currency: scope === 'payment' ? 'USD' : null,
      recipient: scope === 'payment' ? 'sb-northgate@personal.example.com' : null,
      source_revision: version.source_revision,
      status: 'active',
      invalidated_reason: null,
      created_at: at,
      invalidated_at: null,
    };
    wf.approvals.push(approval);
    proposal.state = scope === 'payment' ? 'approved' : 'in_review';
    return approval;
  }

  /** The fix approved: the approving browser puts the change in everyone's plan. */
  publish(person: Person = 'cm'): void {
    const wf = this.db.workflow;
    const proposal = openProposal(wf)!;
    const version = currentVersion(wf, proposal)!;
    this.db.plan.project.current_revision += 1;
    const booking = this.db.plan.bookings.find((candidate) => candidate.id === proposal.booking_id)!;
    booking.billable_start = version.inputs.new_start;
    booking.billable_end = version.inputs.new_end;
    wf.publications.push({
      id: this.db.newId(),
      project_id: this.db.projectId,
      proposal_version_id: version.id,
      published_revision: this.db.plan.project.current_revision,
      executor_session: null,
      status: 'published',
      claimed_by: userIdOf(person),
      claimed_at: now(),
      error: null,
      created_at: now(),
      published_at: now(),
    });
    proposal.state = 'published';
    this.changed();
  }

  /** Someone who sees costs sends the payment; PayPal confirms; the receipt is filed. */
  pay(person: Person = 'cm'): PaymentAuthorizationRow {
    const wf = this.db.workflow;
    const proposal = [...wf.proposals].reverse().find((candidate) => candidate.state === 'published' || candidate.state === 'approved')!;
    const version = currentVersion(wf, proposal)!;
    const approval = activeApprovals(wf, version).payment!;
    const payer = this.db.plan.members.find((member) => member.user_id === userIdOf(person));
    if (!payer?.can_view_costs) throw new Error('pay: only a member who can see costs sends the payment');
    const payment: PaymentAuthorizationRow = {
      id: this.db.newId(),
      project_id: this.db.projectId,
      approval_id: approval.id,
      proposal_version_id: version.id,
      amount_minor: approval.amount_minor ?? 0,
      currency: 'USD',
      recipient_email: 'sb-northgate@personal.example.com',
      status: 'succeeded',
      paypal_batch_id: 'FAKE-BATCH',
      paypal_item_id: 'FAKE-ITEM',
      fee_minor: 25,
      message: null,
      attempts: 1,
      submitted_at: now(),
      last_checked_at: now(),
      authorized_by: userIdOf(person),
      created_at: now(),
      updated_at: now(),
    };
    wf.payments.push(payment);
    wf.documents.push({
      id: this.db.newId(),
      project_id: this.db.projectId,
      task_id: 15,
      kind: 'receipt',
      name: 'PayPal receipt FAKE-ITEM.pdf',
      mime_type: 'application/pdf',
      size_bytes: 2048,
      storage_path: `${this.db.projectId}/${payment.id}/receipt.pdf`,
      cost_sensitive: true,
      text_content: `PayPal payment of $${(payment.amount_minor / 100).toFixed(2)} to Northgate Equipment Rental. PayPal fee $0.25.`,
      summary: `PayPal payment of $${(payment.amount_minor / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })} to Northgate Equipment Rental`,
      payment_authorization_id: payment.id,
      created_by: null,
      created_via: 'system',
      created_at: now(),
    });
    this.changed();
    return payment;
  }

  decline(): void {
    const proposal = openProposal(this.db.workflow);
    if (!proposal) throw new Error('nothing to decline');
    proposal.state = 'cancelled';
    this.changed();
  }

  /** A person writes to the assistant (post_agent_message); the database announces the row. */
  say(person: Person, text: string, channel: AgentChannel = 'text', action: AgentAction | null = null, extra: Pick<AgentMessageRow, 'thread_id' | 'context'> = {}): AgentMessageRow {
    const row = this.db.postPersonMessage(userIdOf(person), text, channel, action, extra);
    this.transport.message(this.db.projectId, row.id);
    return row;
  }
}
