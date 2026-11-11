/**
 * Only one agent service may answer a project, or every reply would come twice. Instances announce
 * themselves with presence on the private topic `agent-service` (service role only; no project data)
 * and the earliest one leads; the others stand by and take over when the leader leaves.
 *
 * A new instance decides only after its presence has settled (`settleMs`): its first sync can list
 * itself alone before the instance already running shows up, and deciding then made both lead (two
 * answers to every question). Each instance says how it answers (`mode`: live, mock, replay) so the
 * one standing by can say what is answering instead of it.
 */
import { randomUUID } from 'node:crypto';
import type { Logger } from '../log';
import type { PresenceState } from './presence';

export interface LockChannel {
  on(type: 'presence', filter: { event: 'sync' }, callback: () => void): unknown;
  subscribe(callback?: (status: string, error?: Error) => void): unknown;
  presenceState(): PresenceState;
  track(payload: Record<string, unknown>): Promise<unknown>;
}

export interface LockClient {
  channel(name: string, options: { config: Record<string, unknown> }): LockChannel;
}

interface Instance {
  instance: string;
  since: number;
  mode?: string;
}

/** The instance that leads: the one running longest (ties: by id). */
export function leaderOf(state: PresenceState): Instance | null {
  const instances: Instance[] = [];
  for (const metas of Object.values(state)) {
    const meta = metas.at(-1) as Partial<Instance> | undefined;
    if (meta && typeof meta.instance === 'string' && typeof meta.since === 'number') instances.push({ instance: meta.instance, since: meta.since, ...(typeof meta.mode === 'string' ? { mode: meta.mode } : {}) });
  }
  instances.sort((a, b) => a.since - b.since || a.instance.localeCompare(b.instance));
  return instances[0] ?? null;
}

export class ServiceLock {
  readonly instance = randomUUID();
  private readonly since = Date.now();
  private leading = false;

  constructor(
    private readonly client: LockClient,
    private readonly log: Logger,
    private readonly options: { mode?: string; settleMs?: number } = {},
  ) {}

  /** Calls `onLeader` once this instance leads (once its presence has settled, when it is alone). */
  acquire(onLeader: () => void): void {
    const channel = this.client.channel('agent-service', { config: { private: true, presence: { key: this.instance, enabled: true }, broadcast: { self: false, ack: false } } });
    let announced = false;
    let settled = false;
    let warned = false;
    const decide = () => {
      const state = channel.presenceState();
      if (!settled || !(this.instance in state) || this.leading) return;
      const leader = leaderOf(state);
      if (leader?.instance === this.instance) {
        this.leading = true;
        this.log.info(`this instance leads (${this.options.mode ?? 'live'}; no other agent service is running)`);
        onLeader();
      } else if (!warned) {
        warned = true;
        this.log.warn(`another agent service is already running${leader?.mode ? ` in ${leader.mode} mode` : ''} (${leader?.instance}); standing by until it stops`);
      }
    };
    channel.on('presence', { event: 'sync' }, decide);
    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED' && !announced) {
        announced = true;
        void channel.track({ instance: this.instance, since: this.since, pid: process.pid, mode: this.options.mode ?? 'live' });
        setTimeout(() => {
          settled = true;
          decide();
        }, this.options.settleMs ?? 3_000);
      }
    });
  }
}
