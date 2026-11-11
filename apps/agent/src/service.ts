/**
 * The agent service: one ProjectAgent per project (all of them, or AGENT_PROJECT_IDS), sharing one
 * Supabase client (service role), one Realtime connection and one Anthropic client.
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { AgentPort } from './agent/port';
import type { ProjectStore } from './data/store';
import type { Admit, SpendLedger } from './hosted';
import { createLogger, type Logger } from './log';
import type { PayPalReader } from './paypal/reader';
import { ProjectAgent, type ProjectAgentOptions } from './project-agent';
import type { AgentTransport } from './realtime/transport';

export interface AgentServiceOptions {
  store: ProjectStore;
  transport: AgentTransport;
  client: Anthropic;
  models: { analysis: string; chat: string };
  /** Names new threads from their first message; null: they keep its first words. */
  titleModel?: string | null;
  log?: Logger;
  project?: Partial<Pick<ProjectAgentOptions, 'debounce' | 'onTurn' | 'openingDelayMs' | 'raiseIssues' | 'systemPrompt' | 'planDate' | 'limits' | 'lineSecret'>>;
  /** Each project's gate before a turn runs the model (the hosted site's limits, hosted.ts); absent: every turn runs. */
  admitFor?: (projectId: string) => Admit;
  /** PayPal itself, read only, shared by every project's check_with_paypal; absent or null: not connected. */
  paypal?: PayPalReader | null;
  /** The day's spend ledger every project's turns are counted in (the hosted site); absent or null: not kept. */
  spend?: SpendLedger | null;
}

export class AgentService {
  private readonly agents = new Map<string, ProjectAgent>();
  private readonly log: Logger;

  constructor(private readonly options: AgentServiceOptions) {
    this.log = options.log ?? createLogger('agent');
  }

  async start(): Promise<void> {
    const ids = await this.options.store.listProjects();
    if (ids.length === 0) this.log.warn('no projects to watch');
    for (const projectId of ids) {
      const agent = new ProjectAgent({
        projectId,
        store: this.options.store,
        transport: this.options.transport,
        client: this.options.client,
        models: this.options.models,
        titleModel: this.options.titleModel ?? null,
        log: createLogger(`agent ${projectId.slice(0, 8)}`),
        ...this.options.project,
        ...(this.options.admitFor ? { admit: this.options.admitFor(projectId) } : {}),
        paypal: this.options.paypal ?? null,
        spend: this.options.spend ?? null,
      });
      try {
        await agent.start();
        this.agents.set(projectId, agent);
      } catch (error) {
        this.log.warn(`could not start the agent for project ${projectId}`, error);
      }
    }
  }

  agent(projectId: string): ProjectAgent | undefined {
    return this.agents.get(projectId);
  }

  /** How many projects it is answering in. */
  get watching(): number {
    return this.agents.size;
  }

  /** The interface the voice worker calls for a project. */
  portFor(projectId: string): AgentPort | undefined {
    return this.agents.get(projectId)?.port();
  }

  async stop(): Promise<void> {
    for (const agent of this.agents.values()) await agent.stop();
    this.agents.clear();
  }
}
