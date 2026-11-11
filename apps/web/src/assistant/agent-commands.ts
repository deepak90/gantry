/**
 * Runs what the assistant asks this browser to do: the assistant files a command for the person who asked (the
 * `agent_commands` row), one of that person's tabs claims it, carries it out here and reports back; if none of
 * their tabs takes it within a few seconds, any member's tab may. On a call, the host's tab takes them all. That is the odds (`schedule_odds`): the
 * plan run a thousand times on this browser's scheduling engine, in the odds panel, with the dots falling on screen.
 * Remy's screen actions (`ui_action`, remy-ui.ts) are different: they show the person who asked something on their own
 * screen, so only that person's tabs take them, on a call too.
 *
 * One command at a time per tab; a command older than a minute when this tab first hears of it is left alone (the
 * assistant has given up on it by then).
 */
import { AGENT_COMMAND_OPEN_AFTER_MS, AgentCommandType, type AgentCommandResult, type AgentCommandRow } from '@collab/shared';

export interface CommandTransport {
  loadCommand(id: string): Promise<AgentCommandRow>;
  claim(id: string): Promise<AgentCommandRow>;
  complete(id: string, status: 'succeeded' | 'failed' | 'rejected', result: AgentCommandResult): Promise<unknown>;
}

/** Carries a command out; resolves with how it went and what to report. */
export type CommandExecutor = (type: AgentCommandType, args: unknown) => Promise<{ ok: boolean; result: AgentCommandResult }>;

/**
 * Commands that act on the screen of the person who asked (Remy's cursor showing them something): only that
 * person's own tabs take them. Run on anyone else's screen, they would move a view nobody asked to move.
 */
const ONLY_THE_REQUESTER: ReadonlySet<string> = new Set<AgentCommandType>(['ui_action']);

export interface AgentCommandRunnerOptions {
  transport: CommandTransport;
  /** The executor, when this tab can run commands of this type now (null: leave them to another tab). */
  executor(type?: string): CommandExecutor | null;
  /** The signed-in person. */
  userId: string;
  now?: () => number;
  /** Extra wait (ms) before another person's command is taken over, so tabs do not all race at once. */
  jitter?: () => number;
  /**
   * This tab takes anyone's command at once (on a call, the host's tab: the odds fall on the screen everyone is
   * watching, whoever asked). Other tabs on the call leave commands to it by having no executor.
   */
  takesAll?: () => boolean;
  onWarning?: (message: string, error?: unknown) => void;
}

const STALE_MS = 60_000;

export class AgentCommandRunner {
  private readonly seen = new Set<string>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private queue: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(private readonly options: AgentCommandRunnerOptions) {}

  /** A command was filed or changed (the agent topic's `command` announcement). */
  heard(id: string, status: string): void {
    if (this.disposed || status !== 'pending' || this.seen.has(id)) return;
    this.seen.add(id);
    void this.consider(id);
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  /** Resolves once every command taken so far has been carried out (tests). */
  idle(): Promise<void> {
    return this.queue;
  }

  private async consider(id: string): Promise<void> {
    let command: AgentCommandRow;
    try {
      command = await this.options.transport.loadCommand(id);
    } catch (error) {
      this.warn(`could not read command ${id}`, error);
      return;
    }
    const now = this.options.now?.() ?? Date.now();
    const age = now - Date.parse(command.created_at);
    if (command.status !== 'pending' || age > STALE_MS) return;
    if (command.requested_by === this.options.userId) {
      this.enqueue(command);
      return;
    }
    if (ONLY_THE_REQUESTER.has(command.type)) return;
    // Somebody else's: only if none of their tabs took it (the database keeps it theirs for the first few seconds).
    // The call's host takes it as soon as it may, with no jitter: the others leave it to the host.
    const takesAll = this.options.takesAll?.() ?? false;
    const wait = Math.max(0, AGENT_COMMAND_OPEN_AFTER_MS - age) + (takesAll ? 150 : (this.options.jitter?.() ?? Math.round(Math.random() * 1_500)));
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (!this.disposed) this.enqueue(command);
    }, wait);
    this.timers.add(timer);
  }

  private enqueue(command: AgentCommandRow): void {
    this.queue = this.queue.then(() => this.run(command)).catch((error: unknown) => this.warn(`command ${command.id} failed`, error));
  }

  private async run(command: AgentCommandRow): Promise<void> {
    if (this.disposed) return;
    const executor = this.options.executor(command.type);
    if (!executor) return;
    let claimed: AgentCommandRow;
    try {
      claimed = await this.options.transport.claim(command.id);
    } catch {
      // Another tab took it (or it is no longer pending): nothing to do.
      return;
    }
    const type = AgentCommandType.safeParse(claimed.type);
    if (!type.success) {
      await this.options.transport.complete(claimed.id, 'rejected', { message: `This browser does not know how to “${claimed.type}”.` });
      return;
    }
    let outcome: { ok: boolean; result: AgentCommandResult };
    try {
      outcome = await executor(type.data, claimed.args);
    } catch (error) {
      outcome = { ok: false, result: { message: (error instanceof Error ? error.message : String(error)).slice(0, 500) } };
    }
    await this.options.transport.complete(claimed.id, outcome.ok ? 'succeeded' : 'failed', outcome.result);
  }

  private warn(message: string, error?: unknown): void {
    if (this.options.onWarning) this.options.onWarning(message, error);
    else console.warn(`[assistant] ${message}`, error);
  }
}
