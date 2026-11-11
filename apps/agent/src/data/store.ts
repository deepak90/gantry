/**
 * Everything the agent reads from and writes to the database, behind one interface so the tests
 * can run against an in-memory fake. The real implementation uses the
 * service role: reads are read-only selects; the only writes are the assistant's own thread rows
 * (and the threads it opens when a watch rule asks it to look into something), the commands it asks
 * a person's browser to carry out (plus canceling a command nobody took), and the watch list's runs.
 */
import type {
  AgentCard,
  AgentChannel,
  AgentCommandRow,
  AgentCommandType,
  AgentEditDecisionRow,
  AgentMessageRow,
  AgentThreadMemberRow,
  AgentThreadRow,
  AgentThreadVisibility,
  LibraryFolderRow,
  LibrarySnippetRow,
  WatchRuleRow,
  WatchRunRow,
} from '@collab/shared';
import type { PlanRows } from '../plan/rows';
import type { WorkflowRows } from '../workflow/state';

export interface NewAssistantMessage {
  project_id: string;
  /** The thread it answers in; null for the main thread. */
  thread_id: string | null;
  turn_id: string;
  channel: AgentChannel;
  text: string;
  cards: AgentCard[];
}

export interface NewCommand {
  project_id: string;
  type: AgentCommandType;
  args: unknown;
  requested_by: string;
  required_revision: number | null;
}

/** A thread the assistant opens itself (a watch rule asked it to look into something). */
export interface NewThread {
  project_id: string;
  title: string;
  /** Whose conversation it is (a private thread's starter); null: nobody's, shared with the project. */
  created_by: string | null;
  visibility: AgentThreadVisibility;
}

/** A situation a watch rule raised, to record as an open run. */
export type NewWatchRun = Pick<WatchRunRow, 'project_id' | 'rule_id' | 'situation' | 'fingerprint' | 'severity' | 'title' | 'detail' | 'task_ids' | 'revision'>;

/** The watch list as the server checks it: every rule, and the runs still open. */
export interface WatchRows {
  rules: WatchRuleRow[];
  open: WatchRunRow[];
}

/** The project's task library (read only: people save snippets from their own browsers). */
export interface LibraryRows {
  folders: LibraryFolderRow[];
  snippets: LibrarySnippetRow[];
}

export interface ProjectStore {
  /** Every project id (or the configured ones). */
  listProjects(): Promise<string[]>;
  loadPlanRows(projectId: string): Promise<PlanRows>;
  loadWorkflow(projectId: string): Promise<WorkflowRows>;
  loadLibrary(projectId: string): Promise<LibraryRows>;
  getMessage(id: string): Promise<AgentMessageRow | null>;
  /**
   * The newest messages, oldest first: of every thread (`thread` left out), of the main thread
   * (null), or of one thread (its id).
   */
  recentMessages(projectId: string, limit: number, thread?: string | null): Promise<AgentMessageRow[]>;
  /** The project's threads (the main thread has no row). */
  listThreads(projectId: string): Promise<AgentThreadRow[]>;
  /** Who was invited into the project's private threads (a thread's starter is in it without a row). */
  listThreadMembers?(projectId: string): Promise<AgentThreadMemberRow[]>;
  /** Names a thread whose title is still its first words; null when someone named it meanwhile. */
  nameThread?(threadId: string, title: string): Promise<AgentThreadRow | null>;
  /** What people decided about the assistant's drafted changes, oldest first. */
  loadEditDecisions(projectId: string): Promise<AgentEditDecisionRow[]>;
  insertAssistantMessage(message: NewAssistantMessage): Promise<string>;
  insertCommand(command: NewCommand): Promise<string>;
  getCommand(id: string): Promise<AgentCommandRow | null>;
  /** Marks a command nobody claimed as `cancelled`; false when a browser already took it. */
  cancelCommandIfPending(id: string): Promise<boolean>;
  /** Opens a thread under the assistant's own hand, titled as a person would (the title model leaves it). */
  createThread?(thread: NewThread): Promise<AgentThreadRow>;
  /** The project's watch rules and its open runs. */
  loadWatch?(projectId: string): Promise<WatchRows>;
  /** Opens a run; null when that situation already has an open run (another pass got there first). */
  insertWatchRun?(run: NewWatchRun): Promise<WatchRunRow | null>;
  /** Closes runs whose situation is gone. */
  resolveWatchRuns?(ids: readonly string[]): Promise<void>;
  /** Notes the conversation the assistant opened about these runs. */
  setWatchRunThread?(ids: readonly string[], threadId: string): Promise<void>;
  /**
   * When the visit to a copy of the hosted demo began (`copy_pool.claimed_at`): a new value means a new visitor. Null
   * when the copy is free, or the project is no copy.
   */
  copyVisit?(projectId: string): Promise<string | null>;
}
