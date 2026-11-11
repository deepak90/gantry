/**
 * Runs a command through a person's browser: inserts the `agent_commands` row, then waits for it to
 * settle. Settlement is heard on the agent topic (`command` {id, status}) and, as a fallback, read by
 * polling the row. After `timeoutMs` a command nobody claimed is canceled (so a late tab cannot run
 * it) and the agent tells the model it could not be done right now.
 */
import type { AgentCommandRow, AgentCommandType } from '@collab/shared';
import type { ProjectStore } from '../data/store';

export type CommandOutcome =
  | { status: 'succeeded'; row: AgentCommandRow }
  | { status: 'failed' | 'rejected' | 'cancelled'; row: AgentCommandRow; message: string }
  | { status: 'timeout'; message: string };

const SETTLED = new Set(['succeeded', 'failed', 'rejected', 'cancelled']);

export interface CommandRunnerOptions {
  timeoutMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export class CommandRunner {
  private readonly waiters = new Map<string, () => void>();
  private readonly timeoutMs: number;
  private readonly pollMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(
    private readonly store: ProjectStore,
    private readonly projectId: string,
    options: CommandRunnerOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.pollMs = options.pollMs ?? 1_500;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
  }

  /** A `command` broadcast arrived: wake whoever waits for that command. */
  notify(id: string): void {
    this.waiters.get(id)?.();
  }

  /**
   * `timeoutMs`: this command's own wait, when it takes longer than most (the odds). `claimTimeoutMs`: how long a tab
   * has to pick it up before it is withdrawn, when that should be sooner (Remy's screen actions: the person's own tab
   * takes them in a moment, or it isn't open).
   */
  async run(type: AgentCommandType, args: unknown, requestedBy: string, requiredRevision: number | null, options: { timeoutMs?: number; claimTimeoutMs?: number } = {}): Promise<CommandOutcome> {
    const id = await this.store.insertCommand({ project_id: this.projectId, type, args, requested_by: requestedBy, required_revision: requiredRevision });
    const deadline = this.now() + (options.timeoutMs ?? this.timeoutMs);
    let claimBy = options.claimTimeoutMs === undefined ? deadline : Math.min(deadline, this.now() + options.claimTimeoutMs);
    try {
      for (;;) {
        const row = await this.store.getCommand(id);
        if (row && SETTLED.has(row.status)) return this.outcome(row);
        if (row?.status === 'pending' && claimBy < deadline && this.now() >= claimBy) {
          if (await this.store.cancelCommandIfPending(id)) {
            return { status: 'timeout', message: 'Their screen didn’t pick the request up: the plan may not be open in their browser right now.' };
          }
          // A tab took it just then: wait for it like any other.
          claimBy = deadline;
          continue;
        }
        if (this.now() >= deadline) {
          if (await this.store.cancelCommandIfPending(id)) {
            return { status: 'timeout', message: 'Nobody’s browser picked the request up in time, so it was withdrawn. Ask the person to keep the plan open and try again.' };
          }
          const late = await this.store.getCommand(id);
          if (late && SETTLED.has(late.status)) return this.outcome(late);
          return { status: 'timeout', message: 'The person’s browser is still working on it; the result will appear in the plan when it is done.' };
        }
        const next = row?.status === 'pending' && claimBy < deadline ? claimBy : deadline;
        await this.wake(id, Math.min(this.pollMs, Math.max(0, next - this.now())));
      }
    } finally {
      this.waiters.delete(id);
    }
  }

  private wake(id: string, ms: number): Promise<void> {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        this.waiters.delete(id);
        resolve();
      };
      this.waiters.set(id, finish);
      void this.sleep(ms).then(finish);
    });
  }

  private outcome(row: AgentCommandRow): CommandOutcome {
    if (row.status === 'succeeded') return { status: 'succeeded', row };
    const message = row.result?.message ?? (row.status === 'rejected' ? 'The browser refused the request.' : row.status === 'cancelled' ? 'The request was withdrawn.' : 'The browser could not carry it out.');
    return { status: row.status as 'failed' | 'rejected' | 'cancelled', row, message };
  }
}
