/**
 * One project's agent: reads the plan and the workflow, listens on the project's topics, turns what
 * it hears into gate decisions and turns, streams its replies on the agent topic (a private thread's
 * on that thread's own topic), and stores each finished reply as an `agent_messages` row. It knows who
 * reads each thread, so amounts stay out of threads read by someone who may not see costs, and it
 * names a new thread from its first message once it has answered there. One turn at a time; the rest
 * queue. It also checks the project's watch rules on every change (agent/watch.ts) and, for a rule
 * that asks for it, opens a conversation for the rule's author and looks into what the rule found.
 * On a copy of the hosted demo, a new visit (the copy claimed again) starts its conversations afresh,
 * and what each turn and thread title cost goes in the day's spend ledger.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'node:crypto';
import { conditionWords, conditionsOf, threadTopic, type AgentMessageRow, type HowToClip, type AgentStreamEvent, type AgentThreadRow, type WatchAlert, type WatchRuleRow } from '@collab/shared';
import type { Audience } from './agent/audience';
import { AgentBrain, timingLine, type BrainEvent, type TurnLimits, type TurnResult } from './agent/brain';
import type { AgentPort } from './agent/port';
import { titleFromFirstMessage } from './agent/titles';
import { paymentConfirmedFacts } from './agent/payment-tools';
import { callJoinedEvent, paymentConfirmedEvent, watchFiredEvent } from './agent/prompts';
import { WatchRunner } from './agent/watch';
import { howToClips } from './agent/how-to';
import type { ToolContext } from './agent/tools';
import { CommandRunner } from './agent/commands';
import type { ProjectStore } from './data/store';
import type { Admit, SpendLedger } from './hosted';
import { costMicroUsd, type TokenUsage } from './llm/pricing';
import type { Logger } from './log';
import type { PayPalReader } from './paypal/reader';
import { usd } from './plan/format';
import { planFromRows } from './plan/rows';
import { meetingReady, memberById, type PlanMember, type PlanSnapshot } from './plan/snapshot';
import { planStamp } from './plan/today';
import { joinedMembers, peersFromPresence, presenceTrigger, presentMembers, type PresencePeer, type PresenceState } from './realtime/presence';
import { lineSigner } from './realtime/line-signature';
import { StreamBatcher, type Timers } from './realtime/stream';
import type { AgentTransport } from './realtime/transport';
import { diffWorkflow } from './workflow/progress';
import { EMPTY_WORKFLOW, type WorkflowRows } from './workflow/state';

export interface ProjectAgentOptions {
  projectId: string;
  store: ProjectStore;
  transport: AgentTransport;
  client: Anthropic;
  models: { analysis: string; chat: string };
  /** The model that names new threads from their first message; null or absent: they keep its first words. */
  titleModel?: string | null;
  log: Logger;
  /** Debounces (ms): presence flicker, workflow bursts, plan edits. */
  debounce?: { presence?: number; workflow?: number; plan?: number };
  /**
   * Wait this long after the meeting can start (two people present, one who sees costs) before the
   * opening turn (default 2000 ms), so a tab that just opened has subscribed to the agent topic and
   * sees the opening stream in. The opening is called off if someone leaves meanwhile.
   * AGENT_OPENING_DELAY_MS; tests use 0.
   */
  openingDelayMs?: number;
  /**
   * Whether the assistant raises a problem it notices on its own when people meet or the plan changes
   * (AGENT_PROACTIVE=issues). Off by default: it answers when asked, and problems show as alerts.
   */
  raiseIssues?: boolean;
  timers?: Timers;
  /** How often daily watch rules are looked at (ms; default a minute, 0: never; tests drive `watch` themselves). */
  watchTickMs?: number;
  /** The how-to clips the assistant may show (default: apps/web/public/clips/clips.json, read at startup). */
  clips?: readonly HowToClip[];
  /** The clock the watch list reads (tests set the day and time). */
  now?: () => Date;
  /** Called with every finished turn. */
  onTurn?: (result: TurnResult) => void;
  /** Asked before each turn runs the model: the hosted site's limits (hosted.ts). Absent: every turn runs. */
  admit?: Admit;
  /** The system prompt (default: SYSTEM_PROMPT; the hosted site's adds a rule). */
  systemPrompt?: string;
  /**
   * The plan's today when it is pinned (GANTRY_PLAN_DATE, plan/today.ts): the watch rules and the fact tools read the
   * plan on it, and the app events the model reads carry it. Absent or null: the day it is now.
   */
  planDate?: string | null;
  /** PayPal itself, read only, for check_with_paypal; absent or null where PayPal isn't connected for the assistant. */
  paypal?: PayPalReader | null;
  /** How far a turn may go (default: as always; the hosted site's are tighter, hosted.ts). */
  limits?: TurnLimits;
  /** The day's spend ledger, told what each turn and thread title cost (the hosted site); absent or null: not kept. */
  spend?: SpendLedger | null;
  /**
   * The secret shared with Remy's call worker (REMY_LINE_SECRET): the streamed and stored replies are signed with it, so
   * her voice says only what this service wrote (realtime/line-signature.ts). Absent or null: nothing is signed.
   */
  lineSecret?: string | null;
}

const HISTORY_MESSAGES = 12;
/** A visit read this recently is not read again before a turn (a message's turn reads it just before). */
const VISIT_FRESH_MS = 2_000;

/**
 * A call said again this soon after the last stopped is the same call: the first person left and the next one's tab
 * took over hosting it (presence updates are throttled, so the handover can take a few seconds).
 */
export const CALL_GAP_MS = 45_000;

export class ProjectAgent {
  readonly brain: AgentBrain;
  /** The watch list, checked on the server (tests call `watch.request` to run a pass). */
  readonly watch: WatchRunner;
  private watchTimer: ReturnType<typeof setInterval> | null = null;
  private readonly ctx: ToolContext;
  private readonly batcher: StreamBatcher;
  private readonly listeners = new Set<(event: BrainEvent) => void>();
  private diffBase: WorkflowRows = EMPTY_WORKFLOW;
  /** The tabs present at the last presence sync (session ids). */
  private sessions = new Set<string>();
  /** What the database looked like at the last sync: a drop in any of them means the project was reset. */
  private seen = { messages: 0, revision: 0, proposals: 0 };
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private started = false;
  /** The project's threads and who was invited into the private ones (re-read when a thread changes). */
  private threads = new Map<string, AgentThreadRow>();
  private invited = new Map<string, Set<string>>();
  /** The thread each turn under way answers in, for routing its stream. */
  private readonly turnThreads = new Map<string, string | null>();
  /** Progress payments already paid (gate id and batch), so a newly paid one is told once; null before the first read. */
  private paidGates: Set<string> | null = null;
  /** The conversation people last spoke in out loud (a call's), and when. */
  private lastVoice: { threadId: string | null; at: number } | null = null;
  /**
   * The call Remy is on, as presence tells it: on while a tab says it hosts her call, and when it last stopped, so a
   * call is greeted once, whichever tab hosts it (the host moves when the first person leaves).
   */
  private remyCall: { on: boolean; endedAt: number | null } = { on: false, endedAt: null };
  /** Commands run in a person's browser (the odds), woken by the agent topic's `command` announcements. */
  private readonly commands: CommandRunner;
  /** The copy's visit as last read (`copy_pool.claimed_at`): undefined before the first read, null when free or no copy. */
  private visit: string | null | undefined = undefined;
  private visitReadAt = 0;
  private visitUnreadable = false;

  constructor(private readonly options: ProjectAgentOptions) {
    const emptyPlan: PlanSnapshot = {
      projectId: options.projectId,
      projectName: '',
      currency: 'USD',
      revision: 0,
      statusDate: '1970-01-01',
      handoverTaskId: 0,
      tasks: [],
      resources: [],
      assignments: [],
      dependencies: [],
      bookings: [],
      members: [],
    };
    this.ctx = {
      plan: emptyPlan,
      workflow: EMPTY_WORKFLOW,
      issues: new Map(),
      speaker: null,
      present: [],
      library: { folders: [], snippets: [] },
      drafts: new Map(),
      edits: new Map(),
      invoices: new Map(),
      history: { rows: null, decisions: [] },
      watch: { rules: [], open: [] },
      clips: options.clips ?? howToClips(),
      refresh: () => this.refresh(),
      commands: { run: (type, args, requestedBy, requiredRevision, runOptions) => this.commands.run(type, args, requestedBy, requiredRevision, runOptions) },
      planDate: options.planDate ?? null,
      paypal: options.paypal ?? null,
    };
    this.commands = new CommandRunner(options.store, options.projectId);
    this.batcher = new StreamBatcher((event: AgentStreamEvent) => options.transport.sendStream(options.projectId, event, this.topicOfTurn(event.turn_id)), {
      ...(options.timers ? { timers: options.timers } : {}),
      onInvalid: (reason) => options.log.warn(`dropped a stream event that does not fit the contract (${reason})`),
      sign: lineSigner(options.lineSecret, options.projectId),
    });
    this.brain = new AgentBrain({
      client: options.client,
      ctx: this.ctx,
      models: options.models,
      onEvent: (event) => this.onBrainEvent(event),
      persist: (result) => this.persist(result),
      beforeDecide: () => this.syncWithDatabase(),
      raiseIssues: options.raiseIssues ?? false,
      ...(options.admit ? { admit: options.admit } : {}),
      ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
      ...(options.limits ? { limits: options.limits } : {}),
      beforeTurn: async () => {
        await this.checkVisit();
      },
      onSpend: (model, usage) => this.recordSpend(model, usage, 'a turn'),
      audienceOf: (threadId) => this.audienceOf(threadId),
      loadHistory: async (threadId, exclude) => {
        const rows = await options.store.recentMessages(options.projectId, HISTORY_MESSAGES + 1, threadId);
        return rows
          .filter((row) => row.id !== exclude)
          .slice(-HISTORY_MESSAGES)
          .map((row) => this.historyLine(row));
      },
    });
    this.watch = new WatchRunner({
      projectId: options.projectId,
      store: options.store,
      plan: () => this.ctx.plan,
      refresh: () => this.refresh(),
      log: options.log,
      ...(options.now ? { now: options.now } : {}),
      planDate: options.planDate ?? null,
      ask: (rule, found) => this.openWatchConversation(rule, found),
    });
  }

  get plan(): PlanSnapshot {
    return this.ctx.plan;
  }

  get workflow(): WorkflowRows {
    return this.ctx.workflow;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.refresh();
    await this.refreshThreads();
    this.diffBase = this.ctx.workflow;
    // Each thread's earlier messages are read when the assistant first talks in it (loadHistory).
    await this.syncWithDatabase();
    this.options.transport.connect(this.options.projectId, {
      onPresence: (state) => this.debounced('presence', this.options.debounce?.presence ?? 1_500, () => this.onPresence(state)),
      onWorkflowChange: ({ table }) => {
        // The watch list's own runs and dismissals change nothing the agent reads (and it writes the runs).
        if (table === 'watch_runs' || table === 'watch_dismissals') return;
        // A rule someone saved is checked at once (after a rejoin, in case one was saved meanwhile).
        if (table === null || table === 'watch_rules') this.debounced('watch', this.options.debounce?.workflow ?? 300, () => void this.watch.request('saved'));
        if (table !== 'watch_rules') this.debounced('workflow', this.options.debounce?.workflow ?? 300, () => void this.onWorkflowChange());
        // Rental dates are in the plan the tools read, and the rules check them.
        if (table === 'equipment_bookings') this.debounced('rental', this.options.debounce?.workflow ?? 300, () => void this.onRentalChanged());
      },
      onRevision: () => this.debounced('plan', this.options.debounce?.plan ?? 4_000, () => void this.onPlanChanged()),
      onAgentMessage: (id) => void this.onAgentMessage(id),
      onCommand: (id) => this.commands.notify(id),
      onThread: (id, op) => {
        if (op === 'delete') void this.brain.enqueue(async () => this.brain.forgetThread(id));
        this.debounced('threads', 200, () => void this.refreshThreads());
      },
    });
    this.options.log.info(`watching ${this.ctx.plan.projectName || this.options.projectId}: ${this.ctx.plan.members.map((member) => `${member.name} (${member.canViewCosts ? 'sees costs' : 'no cost access'})`).join(', ')}`);
    // Situations that came or went while the service was down; then daily rules on the minute.
    void this.watch.request('change');
    const tick = this.options.watchTickMs ?? 60_000;
    if (tick > 0) {
      this.watchTimer = setInterval(() => void this.watch.request('tick'), tick);
      (this.watchTimer as { unref?: () => void }).unref?.();
    }
  }

  /** Resolves once nothing is debounced and no turn is running or queued (tests and the harness). */
  async idle(): Promise<void> {
    for (let rounds = 0; rounds < 1000; rounds++) {
      while (this.timers.size > 0) await new Promise((resolve) => setTimeout(resolve, 10));
      await this.watch.whenIdle();
      await this.brain.whenIdle();
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (this.timers.size === 0) {
        await this.watch.whenIdle();
        await this.brain.whenIdle();
        return;
      }
    }
  }

  async stop(): Promise<void> {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.watchTimer = null;
    await this.options.transport.disconnect(this.options.projectId);
  }

  /** The interface the voice worker (and tests) call. */
  port(): AgentPort {
    return {
      handleUtterance: async (text, speaker, { channel }) => {
        let messageId: string | null = null;
        const capture = (event: BrainEvent) => {
          if (event.type === 'turn_end') messageId = event.messageId;
        };
        this.listeners.add(capture);
        try {
          const result = await this.brain.handleUtterance(text, speaker, { channel });
          return { say: result.say, cards: result.cards, toolCalls: result.toolCalls, messageId };
        } finally {
          this.listeners.delete(capture);
        }
      },
      notify: (trigger) => this.brain.notify(trigger),
      onEvent: (listener) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
      },
    };
  }

  /** Re-reads the plan and the workflow into the tools' context. */
  async refresh(): Promise<void> {
    const [planRows, workflow, library, decisions, watch] = await Promise.all([
      this.options.store.loadPlanRows(this.options.projectId),
      this.options.store.loadWorkflow(this.options.projectId),
      this.options.store.loadLibrary(this.options.projectId).catch((error: unknown) => {
        this.options.log.warn('could not read the task library', error);
        return this.ctx.library;
      }),
      this.options.store.loadEditDecisions(this.options.projectId).catch((error: unknown) => {
        this.options.log.warn('could not read the decisions about drafted changes', error);
        return this.ctx.history.decisions;
      }),
      (this.options.store.loadWatch?.(this.options.projectId) ?? Promise.resolve(this.ctx.watch)).catch((error: unknown) => {
        this.options.log.warn('could not read the watch list', error);
        return this.ctx.watch;
      }),
    ]);
    this.ctx.watch = { rules: watch.rules, open: watch.open };
    this.ctx.plan = planFromRows(planRows);
    this.notePaidGates();
    this.ctx.history = { rows: planRows, decisions };
    this.ctx.workflow = workflow;
    this.ctx.library = library;
    // Keep the present members pointing at the reloaded member records.
    this.brain.setPresent(this.ctx.present.map((member) => memberById(this.ctx.plan, member.userId) ?? member));
  }

  /**
   * PayPal confirmed a progress payment (its gate went to paid with a batch since the last read): the people hear it
   * from Remy, in the conversation they were last talking in, out loud if that was on a call. The first read only
   * learns what was paid already.
   */
  private notePaidGates(): void {
    const paid = this.ctx.plan.tasks.filter((task) => task.payGate?.state === 'paid');
    const keys = new Set(paid.map((task) => `${task.id}:${task.payGate?.batchId ?? ''}`));
    const before = this.paidGates;
    this.paidGates = keys;
    if (before === null) return;
    for (const gate of paid) {
      if (before.has(`${gate.id}:${gate.payGate?.batchId ?? ''}`)) continue;
      void this.onPaymentConfirmed(gate.id).catch((error: unknown) => this.options.log.warn('the payment confirmation turn failed', error));
    }
  }

  /**
   * A tab says on presence that Remy is on the call it hosts: she has just joined, so she greets the call, in its
   * conversation, out loud, naming the person who called her in (the host: who else is on the call, presence doesn't
   * say). Once per call: while some tab still says it hosts her call, it is the same call, and one said again within
   * CALL_GAP_MS of the last stopping is the same call too, its host having moved to the next person's tab.
   */
  private noteCalls(peers: readonly PresencePeer[]): void {
    const now = (this.options.now?.() ?? new Date()).getTime();
    const host = peers.find((peer) => peer.call?.remy);
    if (!host?.call) {
      if (this.remyCall.on) this.remyCall = { on: false, endedAt: now };
      return;
    }
    if (this.remyCall.on) return;
    const moved = this.remyCall.endedAt !== null && now - this.remyCall.endedAt <= CALL_GAP_MS;
    this.remyCall = { on: true, endedAt: null };
    if (moved) {
      this.options.log.info(`Remy's call is now hosted by ${host.name}: the same call, not greeted again`);
      return;
    }
    const at = planStamp(this.ctx.planDate, new Date(now));
    this.options.log.info(`Remy joined the call ${host.name} hosts: greeting it in ${host.call.thread ?? 'the main thread'}`);
    void this.brain.appEvent(callJoinedEvent([host.name], at), host.call.thread, 'voice').catch((error: unknown) => this.options.log.warn('the greeting turn failed', error));
  }

  private async onPaymentConfirmed(gateId: number): Promise<void> {
    const payment = paymentConfirmedFacts(this.ctx.plan, gateId);
    if (!payment) return;
    const now = this.options.now?.() ?? new Date();
    // Where the people were last talking: a call's thread (voice) within the last 20 minutes, else the main thread.
    const voice = this.lastVoice && now.getTime() - this.lastVoice.at < 20 * 60_000 ? this.lastVoice : null;
    const channel = voice ? 'voice' : 'app';
    const paidText = payment.paid_minor !== null ? usd(payment.paid_minor).replace(/\.00$/, '') : null;
    this.options.log.info(`PayPal confirmed ${payment.name} (${payment.batch_id ?? 'no batch'}): answering in ${voice?.threadId ?? 'the main thread'} on ${channel}`);
    await this.brain.appEvent(paymentConfirmedEvent({ ...payment, paid_text: paidText }, planStamp(this.ctx.planDate, now), channel), voice?.threadId ?? null, channel);
  }

  private debounced(key: string, ms: number, run: () => void): void {
    clearTimeout(this.timers.get(key));
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        run();
      }, ms),
    );
  }

  private onPresence(state: PresenceState): void {
    const peers = peersFromPresence(state);
    this.noteCalls(peers);
    const before = this.ctx.present;
    const after = presentMembers(this.ctx.plan, peers);
    const joined = joinedMembers(this.ctx.plan, this.sessions, peers);
    this.sessions = new Set(peers.map((peer) => peer.session));
    this.brain.setPresent(after);
    const trigger = presenceTrigger(before, after, joined);
    const meetingNow = meetingReady(after);
    if (!meetingNow) {
      // Someone left before the opening started: call it off.
      clearTimeout(this.timers.get('opening'));
      this.timers.delete('opening');
    }
    if (!trigger) return;
    const run = () => void this.brain.notify(trigger).catch((error) => this.options.log.warn('presence turn failed', error));
    const delay = this.options.openingDelayMs ?? 2_000;
    if (meetingNow && delay > 0) {
      this.debounced('opening', delay, () => {
        if (meetingReady(this.ctx.present)) run();
      });
    } else {
      run();
    }
  }

  /**
   * Re-reads the plan, the workflow and the thread, and makes the agent's memory follow them. When
   * the project was reset (`pnpm demo:reset`: the thread shrank, the revision went back, or the
   * proposals vanished), or a copy of the hosted demo has a new visitor, the conversation and the gate
   * start over, so nothing of the last visit is carried into the next and the issue can be raised again.
   */
  async syncWithDatabase(): Promise<void> {
    try {
      const [, messages, newVisit] = await Promise.all([this.refresh(), this.options.store.recentMessages(this.options.projectId, 200), this.checkVisit(true)]);
      const now = { messages: messages.length, revision: this.ctx.plan.revision, proposals: this.ctx.workflow.proposals.length };
      const reset = now.messages < this.seen.messages || now.revision < this.seen.revision || (this.seen.proposals > 0 && now.proposals === 0);
      if (newVisit) this.diffBase = this.ctx.workflow;
      if (reset) {
        this.options.log.info('the project was reset: starting a new conversation');
        this.brain.resetConversation();
        this.diffBase = this.ctx.workflow;
      }
      this.seen = now;
      this.brain.gate.syncFrom(messages);
    } catch (error) {
      this.options.log.warn('could not re-read the project', error);
    }
  }

  /**
   * Whose visit this copy is (`copy_pool.claimed_at`, read before a turn, or at most every two seconds): when it
   * changed since the last read (another visitor claimed the copy, or it was freed), the brain forgets the last visit's
   * conversations, drafts and raised issues. Row counts can't tell: a new visitor may have as many messages as the last.
   */
  private async checkVisit(always = false): Promise<boolean> {
    const store = this.options.store;
    if (!store.copyVisit) return false;
    if (!always && Date.now() - this.visitReadAt < VISIT_FRESH_MS) return false;
    let visit: string | null;
    try {
      visit = await store.copyVisit(this.options.projectId);
    } catch (error) {
      if (!this.visitUnreadable) this.options.log.warn('could not read whose visit this copy is', error);
      this.visitUnreadable = true;
      return false;
    }
    this.visitReadAt = Date.now();
    const before = this.visit;
    this.visit = visit;
    if (before === undefined || before === visit) return false;
    this.options.log.info(visit ? 'a new visit to this copy: starting new conversations' : 'the visit to this copy ended: its conversations are forgotten');
    this.brain.resetConversation();
    this.diffBase = this.ctx.workflow;
    this.lastVoice = null;
    // The counts of the last visit say nothing about this one.
    this.seen = { messages: 0, revision: 0, proposals: 0 };
    return true;
  }

  /** What a model call cost, into the day's spend ledger; once the day's budget is spent, live AI is off until the reset. */
  private async recordSpend(model: string, usage: TokenUsage, what: string): Promise<void> {
    const spend = this.options.spend;
    if (!spend) return;
    const usdMicro = costMicroUsd(model, usage);
    if (usdMicro <= 0) return;
    try {
      if (!(await spend.record('anthropic', usdMicro))) this.options.log.warn(`today's budget for the assistant is spent (after ${what}): live AI is off until the reset at 00:05 UTC`);
    } catch (error) {
      this.options.log.warn(`could not record what ${what} cost ($${(usdMicro / 1e6).toFixed(4)})`, error);
    }
  }

  private async onWorkflowChange(): Promise<void> {
    try {
      const after = await this.options.store.loadWorkflow(this.options.projectId);
      if (this.diffBase.proposals.length > 0 && after.proposals.length === 0) {
        // Proposals vanished: a reset, not progress. Re-read everything; the next trigger starts over.
        await this.brain.enqueue(() => this.syncWithDatabase());
        return;
      }
      const changes = diffWorkflow(this.ctx.plan, this.diffBase, after);
      this.diffBase = after;
      this.ctx.workflow = after;
      if (changes.some((change) => change.type === 'cancelled')) this.brain.gate.closeOpenIssue();
      if (changes.some((change) => change.type === 'published')) await this.refresh();
    } catch (error) {
      this.options.log.warn('workflow update failed', error);
    }
  }

  private async onRentalChanged(): Promise<void> {
    try {
      await this.refresh();
      void this.watch.request('change');
    } catch (error) {
      this.options.log.warn('rental update failed', error);
    }
  }

  private async onPlanChanged(): Promise<void> {
    try {
      await this.refresh();
      void this.watch.request('change');
      await this.brain.notify({ kind: 'plan_changed', revision: this.ctx.plan.revision });
    } catch (error) {
      this.options.log.warn('plan update failed', error);
    }
  }

  private async onAgentMessage(id: string): Promise<void> {
    try {
      const row = await this.options.store.getMessage(id);
      if (!row || row.role !== 'person' || row.project_id !== this.options.projectId) return;
      let speaker: PlanMember | null = memberById(this.ctx.plan, row.author_id);
      if (!speaker) {
        await this.refresh();
        speaker = memberById(this.ctx.plan, row.author_id);
      }
      if (!speaker) {
        this.options.log.warn(`message ${id} is from someone who is not a member; ignored`);
        return;
      }
      // A thread started a moment ago: read it first, so the reply goes to the right people.
      if (row.thread_id && !this.threads.has(row.thread_id)) await this.refreshThreads();
      await this.brain.enqueue(() => this.syncWithDatabase());
      if (row.action?.kind === 'not_now') {
        this.brain.gate.snooze(row.action.issue_id);
        this.options.log.info(`${speaker.name} chose "Not now" for ${row.action.issue_id}`);
        return;
      }
      // Dismissing a drafted change or saving a draft to the library needs no answer: the card shows it.
      if (row.action?.kind === 'dismiss_edit' || row.action?.kind === 'save_snippet') {
        this.options.log.info(`${speaker.name}: ${row.action.kind} ${row.action.card_id}`);
        return;
      }
      if (row.channel === 'voice') this.lastVoice = { threadId: row.thread_id ?? null, at: Date.parse(row.created_at) || Date.now() };
      // "Prepare the fix" and a picked choice carry the words the person "said" in the text.
      const text = row.text.trim() || (row.action?.kind === 'prepare_fix' ? 'Yes, prepare the fix.' : '');
      if (!text) return;
      await this.brain.handleUtterance(text, speaker, {
        channel: row.channel === 'voice' ? 'voice' : 'text',
        action: row.action,
        threadId: row.thread_id ?? null,
        context: row.context ?? null,
        messageId: row.id,
        ...(row.turn_id ? { turnId: row.turn_id } : {}),
      });
    } catch (error) {
      this.options.log.warn(`could not answer message ${id}`, error);
    }
  }

  private onBrainEvent(event: BrainEvent): void {
    if (event.type === 'turn_start') this.turnThreads.set(event.turnId, event.threadId);
    this.batcher.handle(event);
    if (event.type === 'turn_end') this.turnThreads.delete(event.turnId);
    for (const listener of this.listeners) listener(event);
    if (event.type === 'gate') this.options.log.info(`gate ${event.trigger}: ${event.decision.wake ? 'wake' : 'asleep'} (${event.decision.reason})`);
    if (event.type === 'warning') this.options.log.warn(event.message);
    if (event.type === 'turn_end') {
      const { result } = event;
      this.options.log.info(`${timingLine(result)}${result.quiet ? ' · stayed quiet' : ''}${result.error ? ` · error: ${result.error}` : ''}`);
      this.options.onTurn?.(result);
    }
  }

  private async persist(result: TurnResult): Promise<string | null> {
    const id = await this.options.store.insertAssistantMessage({
      project_id: this.options.projectId,
      thread_id: result.threadId,
      turn_id: result.turnId,
      channel: result.channel,
      text: result.say.slice(0, 4000),
      cards: result.cards.slice(0, 6),
    });
    // A refused turn ran no model, and naming the thread would run one.
    if (result.threadId && result.kind === 'utterance' && !result.refused) void this.nameThread(result.threadId);
    return id;
  }

  /**
   * A watch rule set to "ask the assistant" found something: a conversation for the rule's author
   * (private to them; shared with the project when the rule has no author still on it), titled with
   * the rule's name, opened with what it found, then a turn that looks into it and offers
   * alternatives. The turn runs on the brain's queue; the thread id is returned at once.
   */
  private async openWatchConversation(rule: WatchRuleRow, found: WatchAlert[]): Promise<string | null> {
    const { store, projectId } = this.options;
    if (!store.createThread || found.length === 0) return null;
    const author = memberById(this.ctx.plan, rule.created_by);
    const items = found.map((alert) => ({ title: alert.title, task_ids: alert.taskIds.slice(0, 20) }));
    const event = (card: 'show_review' | 'show_invoices' | null) =>
      watchFiredEvent(
        {
          rule: rule.name,
          rule_id: rule.id,
          card,
          condition: rule.condition.kind,
          watching: conditionsOf(rule.condition).map((condition) => conditionWords(condition)).join(rule.condition.kind === 'all' ? ' and ' : ' or '),
          note: rule.action.kind === 'ask_assistant' ? (rule.action.note ?? null) : null,
          for: author?.name ?? null,
          found: items,
        },
        planStamp(this.ctx.planDate, this.options.now?.() ?? new Date()),
      );
    const fail = (error: unknown) => this.options.log.warn(`could not look into the watch rule “${rule.name}”`, error);
    // A rule drafted in a conversation answers there, without an opening line: its card says it all.
    // With one rental there is nothing to weigh: the assistant explains it and offers the fix, as when asked.
    const reviewable =
      rule.action.kind === 'ask_assistant' &&
      (rule.thread_id !== null || this.ctx.plan.bookings.length > 1) &&
      conditionsOf(rule.condition).some((condition) => condition.kind === 'idle_rental' || (condition.kind === 'crew_overbooked' && condition.equipment_only === true));
    const card = rule.action.kind === 'prepare_invoice' ? ('show_invoices' as const) : reviewable ? ('show_review' as const) : null;
    const known = rule.thread_id && this.threads.has(rule.thread_id) ? rule.thread_id : null;
    if (known && card) {
      void this.brain.investigate(event(card), known, { component: card, props: { rule_id: rule.id } }).catch(fail);
      return known;
    }
    const thread = await store.createThread({ project_id: projectId, title: rule.name, created_by: author?.userId ?? null, visibility: author ? 'private' : 'project' });
    // Known before the turn starts, so its audience (and so the amounts) is right from the first word.
    this.threads.set(thread.id, thread);
    if (!card) {
      const whose = author ? 'Your' : 'The';
      const what = items.length === 1 ? items[0]!.title : `${items.length} things: ${items.slice(0, 3).map((item) => item.title).join('; ')}${items.length > 3 ? ' …' : ''}`;
      await store.insertAssistantMessage({
        project_id: projectId,
        thread_id: thread.id,
        turn_id: randomUUID(),
        channel: 'text',
        text: `${whose} watch rule “${rule.name}” spoke up: ${what}. Looking into it now.`.slice(0, 4000),
        cards: [],
      });
    }
    void this.brain.investigate(event(card), thread.id, card ? { component: card, props: { rule_id: rule.id } } : undefined).catch(fail);
    return thread.id;
  }

  /** Re-reads the project's threads and who is in the private ones. */
  private async refreshThreads(): Promise<void> {
    try {
      const [threads, members] = await Promise.all([
        this.options.store.listThreads(this.options.projectId),
        this.options.store.listThreadMembers?.(this.options.projectId) ?? Promise.resolve([]),
      ]);
      this.threads = new Map(threads.map((thread) => [thread.id, thread]));
      const invited = new Map<string, Set<string>>();
      for (const member of members) invited.set(member.thread_id, (invited.get(member.thread_id) ?? new Set()).add(member.user_id));
      this.invited = invited;
    } catch (error) {
      this.options.log.warn('could not read the threads', error);
    }
  }

  /**
   * Who reads a thread: everyone for the main thread and threads shared with the project; the
   * starter and the people they invited for a private one. A thread not read yet counts as the whole
   * project, the stricter case for money (a member may not see costs).
   */
  private audienceOf(threadId: string | null): Audience {
    const members = this.ctx.plan.members;
    const thread = threadId ? this.threads.get(threadId) : undefined;
    if (!thread || thread.visibility !== 'private') return { visibility: 'project', people: members, costsSharedBy: thread ? this.sharedBy(thread) : null };
    const inside = new Set([thread.created_by, ...(this.invited.get(thread.id) ?? [])]);
    return { visibility: 'private', people: members.filter((member) => inside.has(member.userId)), costsSharedBy: this.sharedBy(thread) };
  }

  /** Who shared the costs in a thread (a member who sees costs), if anyone did. */
  private sharedBy(thread: AgentThreadRow): PlanMember | null {
    const member = thread.costs_shared_by ? memberById(this.ctx.plan, thread.costs_shared_by) : null;
    return member?.canViewCosts ? member : null;
  }

  /** A private thread's reply streams on its own topic; everything else on the agent topic. */
  private topicOfTurn(turnId: string): string | undefined {
    const threadId = this.turnThreads.get(turnId);
    const thread = threadId ? this.threads.get(threadId) : undefined;
    return thread?.visibility === 'private' ? threadTopic(this.options.projectId, thread.id) : undefined;
  }

  /** Names a thread still called by its first words, from its first message (once, after the first answer). */
  private async nameThread(threadId: string): Promise<void> {
    const thread = this.threads.get(threadId);
    const model = this.options.titleModel;
    if (!model || !this.options.store.nameThread || thread?.title_source !== 'auto') return;
    try {
      const first = (await this.options.store.recentMessages(this.options.projectId, 50, threadId)).find((row) => row.role === 'person' && row.text.trim());
      if (!first) return;
      const { title, usage } = await titleFromFirstMessage(this.options.client, model, first.text);
      await this.recordSpend(model, usage, 'a thread title');
      if (!title) return;
      const named = await this.options.store.nameThread(threadId, title);
      if (named) this.threads.set(named.id, named);
    } catch (error) {
      this.options.log.warn(`could not name thread ${threadId}`, error);
    }
  }

  private historyLine(row: AgentMessageRow): string {
    const who = row.role === 'assistant' ? 'Assistant' : (memberById(this.ctx.plan, row.author_id)?.name ?? 'Someone');
    const cards = row.cards.length ? ` [cards: ${row.cards.map((card) => card.component).join(', ')}]` : '';
    return `${row.created_at.slice(0, 16)} ${who}: ${row.text}${cards}`;
  }
}
