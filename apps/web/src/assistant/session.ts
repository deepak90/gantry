/**
 * The assistant as one browser tab sees it: the project's threads (the main thread and any people
 * started), the open thread's messages (people's messages and the assistant's replies with their
 * cards, stored in `agent_messages`), the turn the assistant is writing right now (its text as it
 * streams, the tools it is using, the cards it is drawing), whether the connection is up, the
 * approval mode this person chose, and what people decided about the assistant's drafted changes.
 * Framework-free: React reads it through `subscribe()` / `getSnapshot()`, tests drive it with a fake
 * transport.
 *
 * Every message carries its context: what is selected in the plan when it is sent (`contextOf`,
 * unless the person took a task off the message) and the approval mode.
 *
 * Stream events are not stored: a tab that joins halfway through a turn shows it from the next
 * delta and gets the finished reply from the thread. A finished reply replaces the streamed one as
 * soon as its row arrives. A turn in another thread marks that thread unread instead.
 *
 * Each new conversation is its own thread: the panel opens on a new, empty conversation (`draft`),
 * and the thread is created, private to its starter and named from its first words, when the first
 * message is sent; the assistant gives it a short name once it has answered. A private thread's
 * reply streams on the thread's own topic (`watchThread`), which only the people in it can join.
 */
import { provisionalThreadTitle } from '@collab/shared';
import type {
  AgentAction,
  AgentChannel,
  AgentEditDecisionRow,
  AgentMessageContext,
  AgentMessageRow,
  AgentStreamEvent,
  AgentThreadMemberRow,
  AgentThreadRow,
  AgentThreadVisibility,
  AgentTurnKind,
  ApprovalMode,
  ScreenContext,
  SelectedTask,
} from '@collab/shared';
import { ASSISTANT_NAME } from './identity';

export interface ThreadList {
  threads: AgentThreadRow[];
  mainLastMessageAt: string | null;
  /** Who was invited into the private threads this person can see. */
  members?: AgentThreadMemberRow[];
}

export interface AssistantTransport {
  /** One thread's messages; null is the main thread. */
  loadThread(threadId: string | null): Promise<AgentMessageRow[]>;
  post(text: string, options: { channel?: AgentChannel; action?: AgentAction | null; threadId?: string | null; context?: AgentMessageContext | null }): Promise<AgentMessageRow>;
  subscribe(handlers: {
    onMessage(id: string): void;
    onStream(event: AgentStreamEvent): void;
    onStatus?(status: 'connected' | 'reconnecting' | 'closed'): void;
    onThread?(id: string, op: 'insert' | 'update' | 'delete'): void;
  }): () => void;
  loadThreads?(): Promise<ThreadList>;
  createThread?(title: string, options?: { auto?: boolean; private?: boolean }): Promise<AgentThreadRow>;
  /** Hears a private thread's live reply on its own topic; returns the function that stops. */
  watchThread?(threadId: string, onStream: (event: AgentStreamEvent) => void): () => void;
  inviteToThread?(threadId: string, userId: string, shareCosts?: boolean): Promise<AgentThreadRow>;
  removeFromThread?(threadId: string, userId: string): Promise<AgentThreadRow>;
  setThreadVisibility?(threadId: string, visibility: AgentThreadVisibility, shareCosts?: boolean): Promise<AgentThreadRow>;
  renameThread?(threadId: string, title: string): Promise<AgentThreadRow>;
  deleteThread?(threadId: string): Promise<void>;
  loadDecisions?(): Promise<AgentEditDecisionRow[]>;
}

export interface LiveTool {
  id: string;
  name: string;
  state: 'start' | 'ok' | 'error';
  summary?: string;
}

export interface LiveCard {
  id: string;
  component: string;
  props: unknown;
}

/** The turn the assistant is writing. */
export interface LiveTurn {
  turnId: string;
  kind: AgentTurnKind;
  speakerId: string | null;
  threadId: string | null;
  text: string;
  tools: LiveTool[];
  cards: LiveCard[];
  /** The turn ended; its stored reply is on its way (or it stayed quiet). */
  ending: boolean;
  error: string | null;
  /**
   * The reply as far as the service had written it at its last tool, with the service's signature (ReplySignature): what
   * a call's host may hand Remy's voice while the tool runs. Null where the service signs nothing.
   */
  signed: { text: string; sig: string } | null;
}

export interface AssistantSnapshot {
  status: 'connecting' | 'connected' | 'reconnecting' | 'closed';
  /** The open thread; null is the main thread (or, with `draft`, a new conversation not sent yet). */
  threadId: string | null;
  /** A new conversation: its thread is created with its first message. */
  draft: boolean;
  threads: readonly AgentThreadRow[];
  /** Who was invited into each private thread (by thread id; its starter is in it without a row). */
  members: ReadonlyMap<string, readonly string[]>;
  /** Threads (by id, 'main' for the main thread) with messages this tab has not looked at. */
  unread: ReadonlySet<string>;
  /** The open thread's messages, oldest first. */
  messages: readonly AgentMessageRow[];
  /** The turn being written in the open thread. */
  live: LiveTurn | null;
  /** A turn being written in another thread (its title shows "writing…"). */
  busyThread: string | null;
  sending: boolean;
  error: string | null;
  /** Counts the turns the assistant started on its own (it noticed something): the panel comes forward. */
  raised: number;
  approvalMode: ApprovalMode;
  /** Tasks taken off the next message's context by the person (ids). */
  excluded: ReadonlySet<number>;
  /** Ids of the messages this tab sent since it opened (its own questions; nothing from before a reload). */
  sentHere: ReadonlySet<string>;
  decisions: readonly AgentEditDecisionRow[];
}

export interface AssistantSessionOptions {
  /** What is selected in the plan right now. */
  selection?: () => readonly SelectedTask[];
  /** What is on this tab's screen right now (screen-context.ts), sent along so Remy knows what "close that" means. */
  screen?: () => ScreenContext | null;
  /** Where the approval mode is kept between visits (per person and project); absent: not kept. */
  storage?: { get(): string | null; set(value: string): void };
}

/** How long a finished turn waits for its stored reply before the streamed text is dropped anyway. */
const ENDING_GRACE_MS = 8_000;
/** How many stored replies' signatures a tab keeps (replySignature). */
const KEPT_REPLY_SIGS = 50;
/** A problem the assistant raised this recently still brings the panel forward in a tab that missed it live. */
const RAISED_RECENTLY_MS = 2 * 60_000;
export const MAIN_THREAD_KEY = 'main';
/** A new conversation not sent yet: no thread's messages belong to it. */
const DRAFT_KEY = 'draft';
const keyOf = (threadId: string | null | undefined) => threadId ?? MAIN_THREAD_KEY;
const MODES: readonly ApprovalMode[] = ['ask', 'risky', 'auto'];

export class AssistantSession {
  private messages: AgentMessageRow[] = [];
  private threadId: string | null = null;
  /** The panel opens on a new conversation; the main thread and the others are a click away. */
  private draft = true;
  private threads: AgentThreadRow[] = [];
  private members = new Map<string, string[]>();
  /** The private thread whose topic this tab listens to (the open one). */
  private watched: { threadId: string; stop: () => void } | null = null;
  /** When this tab last saw each thread's newest message (by thread key). */
  private readonly seen = new Map<string, string>();
  private unread = new Set<string>();
  private live: LiveTurn | null = null;
  /** The tab is on a call with Remy: this person's actions are answered out loud. */
  private onCall = false;
  private busyThread: string | null = null;
  private lastSeq = -1;
  private status: AssistantSnapshot['status'] = 'connecting';
  private sending = false;
  private error: string | null = null;
  private raised = 0;
  private approvalMode: ApprovalMode = 'ask';
  private excluded = new Set<number>();
  private readonly sentHere = new Set<string>();
  private decisions: AgentEditDecisionRow[] = [];
  private snapshot: AssistantSnapshot | null = null;
  private readonly listeners = new Set<() => void>();
  private unsubscribe: (() => void) | null = null;
  private reloading: Promise<void> | null = null;
  private reloadAgain = false;
  private endingTimer: ReturnType<typeof setTimeout> | null = null;
  /** Turns already counted in `raised` (live, or from the thread). */
  private readonly raisedTurns = new Set<string>();
  /** The service's signature on each stored reply lately, by turn (turn_end's `sig`): for Remy's voice on a call. */
  private readonly replySigs = new Map<string, string>();
  private disposed = false;

  constructor(
    private readonly transport: AssistantTransport,
    private readonly options: AssistantSessionOptions = {},
  ) {
    try {
      const stored = options.storage?.get();
      if (stored && (MODES as readonly string[]).includes(stored)) this.approvalMode = stored as ApprovalMode;
    } catch {
      // No storage (private window): the mode starts at "ask" every visit.
    }
  }

  start(): void {
    if (this.unsubscribe || this.disposed) return;
    this.unsubscribe = this.transport.subscribe({
      onMessage: () => {
        void this.reload();
        void this.reloadThreads();
        void this.reloadDecisions();
      },
      onStream: (event) => this.onStream(event),
      onStatus: (status) => {
        this.status = status;
        // Back from a gap: messages may have been missed.
        if (status === 'connected') {
          void this.reload();
          void this.reloadThreads();
        }
        this.changed();
      },
      onThread: (id, op) => {
        if (op === 'delete' && this.threadId === id) {
          this.threadId = null;
          this.messages = [];
          this.live = null;
          void this.reload();
        }
        void this.reloadThreads();
      },
    });
    void this.reload();
    void this.reloadThreads();
    void this.reloadDecisions();
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.watched?.stop();
    this.watched = null;
    if (this.endingTimer) clearTimeout(this.endingTimer);
    this.listeners.clear();
  }

  /** What goes with a message: the selection (less what the person took off) and the approval mode. */
  contextNow(override?: Partial<AgentMessageContext>): AgentMessageContext {
    const selected = (this.options.selection?.() ?? []).filter((task) => !this.excluded.has(task.id)).slice(0, 30);
    let screen: ScreenContext | null = null;
    try {
      screen = this.options.screen?.() ?? null;
    } catch {
      // A screen that can't be read goes without: the message still does.
    }
    return { selected_tasks: selected, approval_mode: this.approvalMode, ...(screen ? { screen } : {}), ...override };
  }

  /**
   * Says something to the assistant (or presses a card's button, with `action`). `context` replaces
   * parts of what is sent along (an automatic apply says so with approval_mode "auto").
   */
  /**
   * On a call, what this person does in the app (applying a change, dropping a library piece) is part of the call:
   * Remy answers it out loud. The call sets this while the tab is on one (call/CallLayer.tsx).
   */
  setOnCall(on: boolean): void {
    this.onCall = on;
  }

  async send(text: string, action: AgentAction | null = null, channel: AgentChannel = 'text', context?: Partial<AgentMessageContext>): Promise<boolean> {
    if (action && channel === 'text' && this.onCall) channel = 'voice';
    const trimmed = text.trim();
    if (!trimmed || this.sending) return false;
    this.sending = true;
    this.error = null;
    this.changed();
    try {
      // A new conversation becomes a thread with its first message: private, named by its first words.
      if (this.draft && this.transport.createThread) {
        const thread = await this.transport.createThread(provisionalThreadTitle(trimmed), { auto: true, private: true });
        this.threads = [thread, ...this.threads.filter((existing) => existing.id !== thread.id)];
        this.draft = false;
        this.threadId = thread.id;
        this.messages = [];
        this.live = null;
        this.watchOpenThread();
      }
      this.draft = false;
      const sent = this.contextNow(context);
      const row = await this.transport.post(trimmed, { channel, action, threadId: this.threadId, context: sent }).catch((error: unknown) => {
        // A database that refuses the screen (one from before it went along): the words go without it.
        if (!sent.screen || !/screen/i.test(error instanceof Error ? error.message : String(error))) throw error;
        const { screen: _screen, ...rest } = sent;
        return this.transport.post(trimmed, { channel, action, threadId: this.threadId, context: rest });
      });
      this.sentHere.add(row.id);
      // The selection was for this message; the next one takes whatever is selected then.
      if (!action) this.excluded = new Set();
      this.take([row]);
      return true;
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      return false;
    } finally {
      this.sending = false;
      this.changed();
    }
  }

  setApprovalMode(mode: ApprovalMode): void {
    if (mode === this.approvalMode) return;
    this.approvalMode = mode;
    try {
      this.options.storage?.set(mode);
    } catch {
      // Not kept; it still holds for this visit.
    }
    this.changed();
  }

  /** Takes a selected task off (or puts it back on) the next message. */
  toggleExcluded(taskId: number): void {
    const next = new Set(this.excluded);
    if (next.has(taskId)) next.delete(taskId);
    else next.add(taskId);
    this.excluded = next;
    this.changed();
  }

  /** Opens a thread (null: the main thread). */
  openThread(threadId: string | null): void {
    if (threadId === this.threadId && !this.draft) return;
    this.draft = false;
    this.threadId = threadId;
    this.messages = [];
    this.live = this.busyThread === keyOf(threadId) ? this.live : null;
    this.unread.delete(keyOf(threadId));
    this.unread = new Set(this.unread);
    this.watchOpenThread();
    this.changed();
    void this.reload();
  }

  /** Starts a new conversation: empty until its first message, which creates its thread. */
  startNewThread(): void {
    if (this.draft && this.messages.length === 0) return;
    this.draft = true;
    this.threadId = null;
    this.messages = [];
    this.live = null;
    this.watchOpenThread();
    this.changed();
  }

  /** Brings a project member into the open (private) thread; `shareCosts` once the inviter agreed to share them. */
  async invite(userId: string, shareCosts = false): Promise<boolean> {
    return this.changeThread((threadId) => this.transport.inviteToThread?.(threadId, userId, shareCosts));
  }

  /** Takes someone out of the open thread (its starter), or leaves it (oneself). */
  async removePerson(userId: string): Promise<boolean> {
    return this.changeThread((threadId) => this.transport.removeFromThread?.(threadId, userId));
  }

  /** Shares the open thread with the whole project, or makes it private again (its starter). */
  async setVisibility(visibility: AgentThreadVisibility, shareCosts = false): Promise<boolean> {
    return this.changeThread((threadId) => this.transport.setThreadVisibility?.(threadId, visibility, shareCosts));
  }

  private async changeThread(change: (threadId: string) => Promise<AgentThreadRow> | undefined): Promise<boolean> {
    const threadId = this.threadId;
    if (this.draft || threadId === null) return false;
    try {
      const thread = await change(threadId);
      if (!thread) return false;
      this.threads = this.threads.map((existing) => (existing.id === thread.id ? thread : existing));
      await this.reloadThreads();
      this.watchOpenThread();
      return true;
    } catch (error) {
      this.fail(error);
      return false;
    }
  }

  /** Listens to the open thread's own topic while it is private; stops otherwise. */
  private watchOpenThread(): void {
    const thread = !this.draft && this.threadId ? this.threads.find((candidate) => candidate.id === this.threadId) : undefined;
    const wanted = thread?.visibility === 'private' ? thread.id : null;
    if (this.watched?.threadId === wanted) return;
    this.watched?.stop();
    this.watched = null;
    if (wanted && this.transport.watchThread) {
      this.watched = { threadId: wanted, stop: this.transport.watchThread(wanted, (event) => this.onStream(event)) };
    }
  }

  async renameThread(threadId: string, title: string): Promise<boolean> {
    if (!this.transport.renameThread) return false;
    try {
      const thread = await this.transport.renameThread(threadId, title);
      this.threads = this.threads.map((existing) => (existing.id === thread.id ? thread : existing));
      this.changed();
      return true;
    } catch (error) {
      this.fail(error);
      return false;
    }
  }

  async deleteThread(threadId: string): Promise<boolean> {
    if (!this.transport.deleteThread) return false;
    try {
      await this.transport.deleteThread(threadId);
      this.threads = this.threads.filter((existing) => existing.id !== threadId);
      if (this.threadId === threadId) this.openThread(null);
      else this.changed();
      return true;
    } catch (error) {
      this.fail(error);
      return false;
    }
  }

  dismissError(): void {
    if (this.error === null) return;
    this.error = null;
    this.changed();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getSnapshot(): AssistantSnapshot {
    if (!this.snapshot) {
      this.snapshot = {
        status: this.status,
        threadId: this.threadId,
        draft: this.draft,
        threads: this.threads,
        members: this.members,
        unread: this.unread,
        messages: this.messages,
        live: this.live && keyOf(this.live.threadId) === this.openKey ? this.live : null,
        busyThread: this.busyThread,
        sending: this.sending,
        error: this.error,
        raised: this.raised,
        approvalMode: this.approvalMode,
        excluded: this.excluded,
        sentHere: this.sentHere,
        decisions: this.decisions,
      };
    }
    return this.snapshot;
  }

  private fail(error: unknown): void {
    this.error = error instanceof Error ? error.message : String(error);
    this.changed();
  }

  private onStream(event: AgentStreamEvent): void {
    // Kept whichever turn it ends, one this tab saw stream or not: the stored reply is what a call's host may hand Remy.
    if (event.type === 'turn_end' && event.sig) this.keepReplySig(event.turn_id, event.sig);
    if (event.type === 'turn_start') {
      const threadId = event.thread_id ?? null;
      this.live = { turnId: event.turn_id, kind: event.kind, speakerId: event.speaker_id, threadId, text: '', tools: [], cards: [], ending: false, error: null, signed: null };
      this.busyThread = keyOf(threadId);
      this.lastSeq = -1;
      if (event.kind === 'proactive') this.countRaised(event.turn_id);
      this.changed();
      return;
    }
    const live = this.live;
    // A tab that joined halfway: it shows the turn from here on (in the open thread).
    if (!live || live.turnId !== event.turn_id) {
      if (event.type === 'turn_end') return;
      this.live = { turnId: event.turn_id, kind: 'utterance', speakerId: null, threadId: this.threadId, text: '', tools: [], cards: [], ending: false, error: null, signed: null };
      this.lastSeq = -1;
      return this.onStream(event);
    }
    switch (event.type) {
      case 'text_delta':
        // Deltas arrive in order on one channel; a repeated one is dropped.
        if (event.seq <= this.lastSeq) return;
        this.lastSeq = event.seq;
        this.live = { ...live, text: live.text + event.text };
        break;
      case 'tool': {
        const tools = live.tools.filter((tool) => tool.id !== event.tool_id);
        tools.push({ id: event.tool_id, name: event.name, state: event.state, summary: event.summary });
        // A card's draft carries its tool call's id: a failed call means the card was withdrawn.
        const cards = event.state === 'error' ? live.cards.filter((card) => card.id !== event.tool_id) : live.cards;
        // The service signed the reply as it had streamed it by now: the words this tab has, if none went missing.
        const signed = event.sig ? { text: live.text, sig: event.sig } : live.signed;
        this.live = { ...live, tools, cards, signed };
        break;
      }
      case 'ui_partial': {
        const cards = live.cards.filter((card) => card.id !== event.card_id);
        cards.push({ id: event.card_id, component: event.component, props: event.props });
        this.live = { ...live, cards };
        break;
      }
      case 'turn_end':
        this.busyThread = null;
        if (keyOf(live.threadId) !== this.openKey) {
          // Finished in another thread: it now has something new.
          this.unread = new Set([...this.unread, keyOf(live.threadId)]);
          this.live = null;
          void this.reloadThreads();
        } else if (event.message_id === null || this.messages.some((message) => message.id === event.message_id)) {
          this.live = null;
        } else {
          this.live = { ...live, ending: true, error: event.error ?? null };
          this.scheduleEndingCleanup(event.turn_id);
          void this.reload();
        }
        break;
    }
    this.changed();
  }

  /**
   * The service's signature on a turn's stored reply (turn_end's `sig`), for Remy's voice on a call: null when the service
   * signs nothing, or the turn ended before this tab was listening.
   */
  replySignature(turnId: string): string | null {
    return this.replySigs.get(turnId) ?? null;
  }

  private keepReplySig(turnId: string, sig: string): void {
    this.replySigs.delete(turnId);
    this.replySigs.set(turnId, sig);
    // The latest ones are enough: a call says a reply as it lands.
    for (const old of this.replySigs.keys()) {
      if (this.replySigs.size <= KEPT_REPLY_SIGS) break;
      this.replySigs.delete(old);
    }
  }

  private scheduleEndingCleanup(turnId: string): void {
    if (this.endingTimer) clearTimeout(this.endingTimer);
    this.endingTimer = setTimeout(() => {
      this.endingTimer = null;
      if (this.live?.turnId === turnId && this.live.ending) {
        this.live = null;
        this.changed();
      }
    }, ENDING_GRACE_MS);
  }

  /** Reloads the open thread; calls during a reload run once more after it. A new conversation has nothing to load. */
  private async reload(): Promise<void> {
    if (this.draft) return;
    if (this.reloading) {
      this.reloadAgain = true;
      return this.reloading;
    }
    this.reloading = (async () => {
      do {
        this.reloadAgain = false;
        if (this.draft) break;
        const threadId = this.threadId;
        try {
          const rows = await this.transport.loadThread(threadId);
          // The person switched threads meanwhile: the next round loads the right one.
          if (threadId !== this.threadId || this.draft) {
            this.reloadAgain = true;
            continue;
          }
          this.take(rows, true);
          if (this.error?.startsWith(`${ASSISTANT_NAME} could not be reached`)) this.error = null;
        } catch (error) {
          this.error = `${ASSISTANT_NAME} could not be reached: ${error instanceof Error ? error.message : String(error)}`;
          this.changed();
        }
      } while (this.reloadAgain && !this.disposed);
    })().finally(() => {
      this.reloading = null;
    });
    return this.reloading;
  }

  private async reloadThreads(): Promise<void> {
    if (!this.transport.loadThreads) return;
    try {
      const list = await this.transport.loadThreads();
      if (this.disposed) return;
      this.threads = list.threads;
      const members = new Map<string, string[]>();
      for (const member of list.members ?? []) members.set(member.thread_id, [...(members.get(member.thread_id) ?? []), member.user_id]);
      this.members = members;
      // A thread that became private (or shared) changes where its replies stream.
      this.watchOpenThread();
      const unread = new Set(this.unread);
      const latest: [string, string | null][] = [[MAIN_THREAD_KEY, list.mainLastMessageAt], ...list.threads.map((thread): [string, string] => [thread.id, thread.last_message_at])];
      for (const [key, at] of latest) {
        if (!at) continue;
        const seen = this.seen.get(key);
        if (key === this.openKey) this.seen.set(key, at);
        else if (seen === undefined) this.seen.set(key, at);
        else if (at > seen) unread.add(key);
      }
      for (const key of unread) if (key !== MAIN_THREAD_KEY && !list.threads.some((thread) => thread.id === key)) unread.delete(key);
      this.unread = unread;
      this.changed();
    } catch {
      // The list is a convenience; the open thread still works.
    }
  }

  private async reloadDecisions(): Promise<void> {
    if (!this.transport.loadDecisions) return;
    try {
      const rows = await this.transport.loadDecisions();
      if (this.disposed) return;
      this.decisions = rows;
      this.changed();
    } catch {
      // The changelog lists them when they can be read.
    }
  }

  /** Merges rows into the open thread (by id, oldest first); `all` means the rows are the whole thread. */
  private take(rows: readonly AgentMessageRow[], all = false): void {
    if (this.disposed) return;
    const own = rows.filter((row) => keyOf(row.thread_id) === this.openKey);
    const byId = new Map((all ? [] : this.messages).map((message) => [message.id, message]));
    for (const row of own) byId.set(row.id, row);
    // A row sent from this tab may not be in a reload that raced it.
    if (all) for (const message of this.messages) if (!byId.has(message.id) && message.role === 'person') byId.set(message.id, message);
    this.messages = [...byId.values()].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
    const newest = this.messages.at(-1)?.created_at;
    if (newest && !this.draft) this.seen.set(this.openKey, newest);
    // Something the assistant raised on its own while this tab was still opening (or reconnecting).
    for (const message of own) {
      const noticed = message.role === 'assistant' && message.channel === 'app' && message.cards.some((card) => card.component === 'show_issue_card');
      if (noticed && message.turn_id && Date.now() - Date.parse(message.created_at) < RAISED_RECENTLY_MS) this.countRaised(message.turn_id);
    }
    // The streamed turn is done once its stored reply is here.
    if (this.live?.ending && this.messages.some((message) => message.role === 'assistant' && message.turn_id === this.live?.turnId)) this.live = null;
    this.changed();
  }

  /** The open thread's key; a new conversation has none (nothing in any thread is "here"). */
  private get openKey(): string {
    return this.draft ? DRAFT_KEY : keyOf(this.threadId);
  }

  private countRaised(turnId: string): void {
    if (this.raisedTurns.has(turnId)) return;
    this.raisedTurns.add(turnId);
    this.raised++;
  }

  private changed(): void {
    if (this.disposed) return;
    this.snapshot = null;
    for (const listener of [...this.listeners]) listener();
  }
}
