/**
 * The one interface every channel uses to reach a project's brain. Text chat (rows posted through
 * `post_agent_message`) and the app's own triggers end up in these calls on the same AgentBrain, and
 * so would a voice channel (`channel: 'voice'`), so a card drawn after any question is on both screens.
 *
 * Text written to the thread by a person needs nothing more: the service hears the row and answers.
 */
import type { AgentCard } from '@collab/shared';
import type { PlanMember } from '../plan/snapshot';
import type { BrainEvent, ToolCallRecord, TurnResult } from './brain';
import type { Trigger } from './proactive';

export interface UtteranceResult {
  /** What to speak (voice) or show (text). Empty when there is nothing to say. */
  say: string;
  /** Cards drawn in this turn; already validated and grounded, and stored with the reply. */
  cards: AgentCard[];
  toolCalls: ToolCallRecord[];
  /** The stored reply's id in agent_messages, when it was stored. */
  messageId: string | null;
}

export interface AgentPort {
  handleUtterance(text: string, speaker: PlanMember, options: { channel: 'text' | 'voice' }): Promise<UtteranceResult>;
  notify(trigger: Trigger): Promise<TurnResult | null>;
  onEvent(listener: (event: BrainEvent) => void): () => void;
}
