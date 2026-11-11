/**
 * The agent's Realtime connections for one project, with the service role, all private channels:
 *
 *   project:{id}:presence   listen only (never tracks): who is in the plan
 *   project:{id}:workflow   'change' {table, id, op, proposal_id}: re-read the workflow (a saved
 *                           watch rule is checked at once)
 *   project:{id}:revisions  'revision' (the accepted row): the plan changed
 *   project:{id}:agent      'message' {id}, 'command' {id, status} and 'thread' {id, op} from the
 *                           database; the agent sends 'stream' events here
 *   project:{id}:thread:{t} a private thread's 'stream' events, joined only to send while the
 *                           assistant answers there (only the people in the thread may join it)
 *
 * A channel the server closes is joined again from scratch with a growing delay (Realtime retries an
 * errored channel by itself, not a closed one), as apps/web/src/presence/supabase-presence.ts does.
 */
import { AGENT_EVENTS, agentTopic, type AgentStreamEvent } from '@collab/shared';
import type { Logger } from '../log';
import type { PresenceState } from './presence';

export interface TransportHandlers {
  onPresence(state: PresenceState): void;
  /** A workflow table changed (`table`: which one, from the broadcast; null when it did not say). */
  onWorkflowChange(change: { table: string | null }): void;
  onRevision(): void;
  onAgentMessage(id: string): void;
  onCommand?(id: string): void;
  /** A thread was started, renamed or deleted. */
  onThread?(id: string, op: 'insert' | 'update' | 'delete'): void;
}

export interface AgentTransport {
  connect(projectId: string, handlers: TransportHandlers): void;
  /** Sends on the project's agent topic, or on `topic` (a private thread's own topic). */
  sendStream(projectId: string, event: AgentStreamEvent, topic?: string): void;
  disconnect(projectId?: string): Promise<void>;
}

/** The RealtimeChannel methods used here. */
export interface RealtimeChannelLike {
  on(type: 'presence', filter: { event: 'sync' }, callback: () => void): unknown;
  on(type: 'broadcast', filter: { event: string }, callback: (message: { payload?: unknown }) => void): unknown;
  subscribe(callback?: (status: string, error?: Error) => void): unknown;
  presenceState(): PresenceState;
  send(message: { type: 'broadcast'; event: string; payload: unknown }): Promise<unknown>;
}

export interface RealtimeClientLike {
  channel(name: string, options: { config: Record<string, unknown> }): RealtimeChannelLike;
  removeChannel(channel: RealtimeChannelLike): Promise<unknown>;
}

const REJOIN_DELAYS_MS = [1_000, 2_000, 5_000, 10_000] as const;
const MAX_QUEUED = 200;
/** A private thread's channel is left this long after its last event. */
const THREAD_CHANNEL_IDLE_MS = 60_000;

interface SideChannel {
  channel: RealtimeChannelLike;
  subscribed: boolean;
  queue: AgentStreamEvent[];
  idle: ReturnType<typeof setTimeout> | null;
}

type Topic = 'presence' | 'workflow' | 'revisions' | 'agent';

interface Joined {
  channel: RealtimeChannelLike | null;
  subscribed: boolean;
  rejoins: number;
  timer: ReturnType<typeof setTimeout> | null;
}

function idOf(payload: unknown): string | null {
  return payload && typeof payload === 'object' && typeof (payload as { id?: unknown }).id === 'string' ? (payload as { id: string }).id : null;
}

export class SupabaseAgentTransport implements AgentTransport {
  private readonly projects = new Map<string, { handlers: TransportHandlers; topics: Map<Topic, Joined>; queue: AgentStreamEvent[]; active: boolean }>();
  /** Private threads' channels, by topic: joined to send a reply, left when idle. */
  private readonly sideChannels = new Map<string, SideChannel>();

  constructor(
    private readonly client: RealtimeClientLike,
    private readonly log: Logger,
    private readonly presenceKey = `agent-service-${process.pid}`,
    private readonly rejoinDelaysMs: readonly number[] = REJOIN_DELAYS_MS,
  ) {}

  connect(projectId: string, handlers: TransportHandlers): void {
    if (this.projects.has(projectId)) return;
    const project = { handlers, topics: new Map<Topic, Joined>(), queue: [] as AgentStreamEvent[], active: true };
    this.projects.set(projectId, project);
    for (const topic of ['presence', 'workflow', 'revisions', 'agent'] as const) {
      const joined: Joined = { channel: null, subscribed: false, rejoins: 0, timer: null };
      project.topics.set(topic, joined);
      this.join(projectId, topic, joined);
    }
  }

  private join(projectId: string, topic: Topic, joined: Joined): void {
    const project = this.projects.get(projectId);
    if (!project?.active) return;
    const name = topic === 'agent' ? agentTopic(projectId) : `project:${projectId}:${topic}`;
    const config: Record<string, unknown> =
      topic === 'presence'
        ? { private: true, presence: { key: this.presenceKey, enabled: true }, broadcast: { self: false, ack: false } }
        : { private: true, broadcast: { self: false, ack: false } };
    const channel = this.client.channel(name, { config });
    joined.channel = channel;
    const live = () => project.active && joined.channel === channel;
    const { handlers } = project;

    if (topic === 'presence') {
      channel.on('presence', { event: 'sync' }, () => {
        if (live()) handlers.onPresence(channel.presenceState());
      });
    } else if (topic === 'workflow') {
      channel.on('broadcast', { event: 'change' }, ({ payload }) => {
        const table = (payload as { table?: unknown } | undefined)?.table;
        if (live()) handlers.onWorkflowChange({ table: typeof table === 'string' ? table : null });
      });
    } else if (topic === 'revisions') {
      channel.on('broadcast', { event: 'revision' }, () => {
        if (live()) handlers.onRevision();
      });
    } else {
      channel.on('broadcast', { event: AGENT_EVENTS.message }, ({ payload }) => {
        const id = idOf(payload);
        if (live() && id) handlers.onAgentMessage(id);
      });
      channel.on('broadcast', { event: AGENT_EVENTS.command }, ({ payload }) => {
        const id = idOf(payload);
        if (live() && id) handlers.onCommand?.(id);
      });
      channel.on('broadcast', { event: AGENT_EVENTS.thread }, ({ payload }) => {
        const id = idOf(payload);
        const op = (payload as { op?: unknown } | undefined)?.op;
        if (live() && id && (op === 'insert' || op === 'update' || op === 'delete')) handlers.onThread?.(id, op);
      });
    }

    channel.subscribe((status, error) => {
      if (!live()) return;
      if (status === 'SUBSCRIBED') {
        joined.subscribed = true;
        joined.rejoins = 0;
        this.log.info(`joined ${name}`);
        if (topic === 'agent') this.drain(projectId);
        // Something may have changed while the channel was down: re-read.
        if (topic === 'workflow') handlers.onWorkflowChange({ table: null });
        return;
      }
      joined.subscribed = false;
      if (status === 'CLOSED') {
        this.log.warn(`${name} closed; joining again`, error);
        this.scheduleRejoin(projectId, topic, joined);
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        this.log.warn(`${name} ${status}`, error);
      }
    });
  }

  private scheduleRejoin(projectId: string, topic: Topic, joined: Joined): void {
    if (joined.timer !== null) return;
    const delay = this.rejoinDelaysMs[Math.min(joined.rejoins, this.rejoinDelaysMs.length - 1)] ?? 10_000;
    joined.rejoins++;
    const closed = joined.channel;
    joined.channel = null;
    if (closed) this.client.removeChannel(closed).catch(() => undefined);
    joined.timer = setTimeout(() => {
      joined.timer = null;
      this.join(projectId, topic, joined);
    }, delay);
  }

  sendStream(projectId: string, event: AgentStreamEvent, topic?: string): void {
    if (topic) {
      this.sendOnSide(topic, event);
      return;
    }
    const project = this.projects.get(projectId);
    if (!project) return;
    const agent = project.topics.get('agent');
    if (!agent?.subscribed || !agent.channel) {
      if (project.queue.length < MAX_QUEUED) project.queue.push(event);
      return;
    }
    agent.channel.send({ type: 'broadcast', event: AGENT_EVENTS.stream, payload: event }).catch((error: unknown) => this.log.warn('stream send failed', error));
  }

  private sendOnSide(topic: string, event: AgentStreamEvent): void {
    let side = this.sideChannels.get(topic);
    if (!side) {
      const channel = this.client.channel(topic, { config: { private: true, broadcast: { self: false, ack: false } } });
      const created: SideChannel = { channel, subscribed: false, queue: [], idle: null };
      side = created;
      this.sideChannels.set(topic, created);
      channel.subscribe((status, error) => {
        if (this.sideChannels.get(topic) !== created) return;
        if (status === 'SUBSCRIBED') {
          created.subscribed = true;
          for (const queued of created.queue.splice(0)) this.sendOnSide(topic, queued);
        } else if (status === 'CLOSED' || status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          this.log.warn(`${topic} ${status}`, error);
          this.leaveSide(topic);
        }
      });
    }
    if (side.idle !== null) clearTimeout(side.idle);
    side.idle = setTimeout(() => this.leaveSide(topic), THREAD_CHANNEL_IDLE_MS);
    if (!side.subscribed) {
      if (side.queue.length < MAX_QUEUED) side.queue.push(event);
      return;
    }
    side.channel.send({ type: 'broadcast', event: AGENT_EVENTS.stream, payload: event }).catch((error: unknown) => this.log.warn('stream send failed', error));
  }

  private leaveSide(topic: string): void {
    const side = this.sideChannels.get(topic);
    if (!side) return;
    this.sideChannels.delete(topic);
    if (side.idle !== null) clearTimeout(side.idle);
    this.client.removeChannel(side.channel).catch(() => undefined);
  }

  private drain(projectId: string): void {
    const project = this.projects.get(projectId);
    if (!project) return;
    const queued = project.queue.splice(0);
    for (const event of queued) this.sendStream(projectId, event);
  }

  async disconnect(projectId?: string): Promise<void> {
    const ids = projectId ? [projectId] : [...this.projects.keys()];
    for (const id of ids) {
      const project = this.projects.get(id);
      if (!project) continue;
      project.active = false;
      for (const joined of project.topics.values()) {
        if (joined.timer !== null) clearTimeout(joined.timer);
        if (joined.channel) await this.client.removeChannel(joined.channel).catch(() => undefined);
      }
      this.projects.delete(id);
    }
    if (!projectId) for (const topic of [...this.sideChannels.keys()]) this.leaveSide(topic);
  }
}
