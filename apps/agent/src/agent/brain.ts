/**
 * The agent's brain for one project: a conversation per thread (the project's main thread and any
 * thread people start), and one streaming tool loop that serves text, voice and app-started turns
 * alike. Turns run one at a time per project, whichever thread they are in; the tools' memory (checks,
 * drafts, edits) is shared by every thread of the project.
 *
 *   brain.notify(trigger)                 app event -> proactive gate -> maybe a turn
 *   brain.handleUtterance(text, speaker)  a person wrote or spoke -> a turn in their thread
 *   brain.investigate(event, thread)      a watch rule asked for a look -> a turn in its new thread
 *       -> TurnResult { say, cards, toolCalls, timings }
 *
 * Speak first: the model talks through the `reply` tool and is told to call it before anything
 * else, so the reply streams out (`text_delta`) while it is still writing its cards. A response
 * that only replies and draws cards ends the turn without another model call (their results ride
 * along with the next message), which saves a full round trip per turn.
 *
 * Loop rules: the thread is append-only (thinking and fallback blocks go back untouched); every tool
 * input is validated with zod before it runs; cards are grounded against tool results; a refusal or
 * a cut-off tool call runs nothing; the turn limits cap the model calls per turn, the output tokens
 * per call and the size of a tool result handed back (TurnLimits: as they always were locally, tighter
 * on the hosted site).
 *
 * Every turn a person is owed ends with an answer. Words the model writes outside `reply` between tool
 * calls come back from the API as hidden progress notes, so a turn could end on its opener ("Pulling up
 * the steel erection task.") with the answer lost: when the people have had no words or card since the
 * last lookup, the model is told once that nothing reached them and answers with reply; if it still
 * can't, the turn ends with a plain "I couldn’t finish that." (or the apology for an error or refusal).
 */
import Anthropic from '@anthropic-ai/sdk';
import {
  UI_COMPONENTS,
  UI_DESCRIPTIONS,
  isUiComponent,
  type AgentAction,
  type AgentCard,
  type AgentChannel,
  type AgentMessageContext,
  type AgentTurnKind,
  type UiComponentName,
} from '@collab/shared';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Admit, Refusal, RefusalReason } from '../hosted';
import { rentalChoices, type RentalChoices } from '../plan/whatif';
import type { Issue } from '../plan/detectors';
import type { PlanMember } from '../plan/snapshot';
import { groundCard, minorValues, ungroundedAmounts } from './grounding';
import { describeClips, howToCard, howToClips } from './how-to';
import { ProactiveGate, type GateDecision, type Trigger } from './proactive';
import { carriesMoney, describeAudience, moneyAllowed, redactAmounts, streamRedactor, withoutMoney, type Audience } from './audience';
import { crewsBlock, describeContext, historyBlock, meetingStartedEvent, planChangedEvent, SYSTEM_PROMPT, utterance, areasBlock } from './prompts';
import { isFactTool, summarizeFactTool } from './fact-tools';
import { isInvoiceTool, summarizeInvoiceTool } from './invoice-tools';
import { isPayPalTool, summarizePayPalTool } from './paypal-tool';
import { isPlanTool, summarizePlanTool } from './plan-tools';
import { isScreenTool, summarizeScreenTool } from './screen-tools';
import { isQueryTool, summarizeQueryTool } from './query-tool';
import { DATA_TOOL_DESCRIPTIONS, DataToolSchemas, ToolRefusal, runDataTool, type DataToolName, type ToolContext } from './tools';
import { addUsage, NO_USAGE, usageOf, type TokenUsage } from '../llm/pricing';
import { planStamp } from '../plan/today';

type Beta = Anthropic.Beta.Messages.BetaMessageParam;
type ToolResult = Anthropic.Beta.Messages.BetaToolResultBlockParam;
type ToolUse = Anthropic.Beta.Messages.BetaToolUseBlock;

/** How far one turn may go. */
export interface TurnLimits {
  /** Model calls in one turn. */
  maxSteps: number;
  /** max_tokens of each call (thinking included): a person's written turn, a spoken one, and one the app started. */
  maxTokens: { text: number; voice: number; proactive: number };
  /** Characters of one tool result handed back to the model; a longer one is cut, with a note saying so. Null: never cut. */
  toolResultChars: number | null;
  /** How long the system prompt (and the tools before it) stays cached between calls. */
  systemCacheTtl: '5m' | '1h';
}

/** The limits everywhere but the hosted site (local runs and the film): as they always were. */
export const DEFAULT_LIMITS: TurnLimits = {
  maxSteps: 10,
  maxTokens: { text: 16_000, voice: 16_000, proactive: 32_000 },
  toolResultChars: null,
  systemCacheTtl: '5m',
};
export const MAX_STEPS = DEFAULT_LIMITS.maxSteps;

const TERMINAL_TOOLS = new Set(['stay_quiet', 'show_choices']);
/** Said when a turn a person is owed ends with no answer. */
export const UNFINISHED_LINE = 'I couldn’t finish that.';
export const ERROR_LINE = 'Sorry, something went wrong on my side; please ask again in a moment.';
export const REFUSAL_LINE = 'I can’t help with that one.';
/** Told to the model, once, when the turn would end with no words or card since its last lookup. */
export const UNANSWERED_NOTE = '<app_note>Nothing you wrote since looking things up reached them: only words in reply are shown or said. Answer now, with reply.</app_note>';

export type BrainEvent =
  | { type: 'gate'; trigger: Trigger['kind']; decision: GateDecision }
  | { type: 'turn_start'; turnId: string; kind: AgentTurnKind; model: string; speakerId: string | null; threadId: string | null }
  | { type: 'text_delta'; turnId: string; text: string }
  | { type: 'tool'; turnId: string; toolId: string; name: string; state: 'start' | 'ok' | 'error'; summary?: string }
  | { type: 'ui_partial'; turnId: string; cardId: string; component: UiComponentName; props: unknown }
  | { type: 'card'; turnId: string; card: AgentCard; status: 'final' | 'rejected'; error?: string }
  | { type: 'warning'; turnId: string; message: string }
  | { type: 'turn_end'; turnId: string; result: TurnResult; messageId: string | null };

export interface ToolCallRecord {
  name: string;
  input: unknown;
  ok: boolean;
  summary: string;
  ms: number;
}

export interface TurnResult {
  turnId: string;
  kind: AgentTurnKind;
  /** The thread the turn answered in; null for the main thread. */
  threadId: string | null;
  channel: AgentChannel;
  model: string;
  speakerId: string | null;
  /** What to show in the thread or speak aloud. Empty when the agent stayed quiet. */
  say: string;
  cards: AgentCard[];
  toolCalls: ToolCallRecord[];
  quiet: boolean;
  stopReason: string | null;
  steps: number;
  /** Tokens every model call of the turn used, as the API counted them (what the turn cost: llm/pricing.ts). */
  usage: TokenUsage;
  ms: number;
  /** From the start of the turn to the first word streamed out (null when nothing was said). */
  firstTextMs: number | null;
  firstCardMs: number | null;
  /** Amounts in `say` that no tool computed (logged, not blocked). */
  warnings: string[];
  error?: string;
  /** The hosted limits said no (hosted.ts): `say` is their plain reply, and no model ran. */
  refused?: RefusalReason;
}

export interface BrainOptions {
  client: Anthropic;
  ctx: ToolContext;
  models: { analysis: string; chat: string };
  onEvent?: (event: BrainEvent) => void;
  /** Stores the finished reply; returns its message id (null when nothing was stored). */
  persist?: (result: TurnResult) => Promise<string | null>;
  /** Runs inside the turn queue before every gate decision (re-reads the database). */
  beforeDecide?: () => Promise<void>;
  /** Raise problems on meeting start and plan edits (see ProactiveGate); default false. */
  raiseIssues?: boolean;
  /**
   * The earlier messages of a thread, as history lines, read when the brain first talks in it (after
   * a restart, or a thread it has not seen yet). Null: the main thread.
   */
  loadHistory?: (threadId: string | null, exclude: string | null) => Promise<string[]>;
  /**
   * Who reads a thread (null: unknown, treated as everyone may see costs). When someone reading may
   * not see costs, amounts are withheld from the model and the reply (agent/audience.ts).
   */
  audienceOf?: (threadId: string | null) => Audience | null;
  now?: () => number;
  /**
   * Asked before a turn runs the model (the hosted site's limits, hosted.ts). A refusal is said instead, with no model
   * call; a turn the app started on its own and nobody would miss (an opening, a plan change) stays quiet instead.
   * Absent: every turn runs.
   */
  admit?: Admit;
  /** The system prompt (default SYSTEM_PROMPT; the hosted site's adds a rule, systemPromptFor). */
  systemPrompt?: string;
  /** How far a turn may go (default DEFAULT_LIMITS; the hosted site's are tighter, hosted.ts). */
  limits?: TurnLimits;
  /** Runs inside the turn queue before a turn that calls the model (a new visit to a copy starts a new conversation). */
  beforeTurn?: () => Promise<void>;
  /**
   * Told what each turn's model calls used, once the turn has ended and before the next one starts (the hosted site's
   * spend ledger). Not called for a turn that called no model.
   */
  onSpend?: (model: string, usage: TokenUsage) => Promise<void>;
}

/** Optional parts of a turn. */
interface TurnOptions {
  turnId?: string;
  /** The thread it answers in; null for the main thread. */
  threadId?: string | null;
  /** The stored message it answers (left out of the thread's history). */
  answering?: string | null;
  /** A card the app shows with the turn, whether or not the model draws it. */
  requiredCard?: { component: UiComponentName; props: Record<string, unknown> };
  /** Someone is owed words even though no person asked (a greeting, a payment that went through, a rule's look). */
  mustAnswer?: boolean;
}

function jsonSchema(schema: z.ZodType): Anthropic.Beta.Messages.BetaTool.InputSchema {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  return rest as Anthropic.Beta.Messages.BetaTool.InputSchema;
}

/** Fixed order, built once: the tools prefix is byte-identical on every request (prompt caching). */
export const TOOL_DEFINITIONS: Anthropic.Beta.Messages.BetaTool[] = [
  ...(Object.keys(DataToolSchemas) as DataToolName[]).map((name) => ({
    name,
    description: DATA_TOOL_DESCRIPTIONS[name],
    input_schema: jsonSchema(DataToolSchemas[name]),
    eager_input_streaming: true,
  })),
  ...(Object.keys(UI_COMPONENTS) as UiComponentName[]).map((name) => ({
    name,
    // show_how lists the clips that exist (read once, at startup).
    description: name === 'show_how' ? UI_DESCRIPTIONS[name] + describeClips(howToClips()) : UI_DESCRIPTIONS[name],
    input_schema: jsonSchema(UI_COMPONENTS[name]),
    eager_input_streaming: true,
  })),
];

export function supportsServerFallback(model: string): boolean {
  return /^claude-(opus|sonnet|fable)-/.test(model);
}

/**
 * The value of a string field in a JSON object that is still being written: `{"text":"Hello wo` ->
 * `Hello wo`. Stops before an escape that is not complete yet.
 */
export function partialStringField(json: string, field: string): string {
  const start = new RegExp(`"${field}"\\s*:\\s*"`).exec(json);
  if (!start) return '';
  let out = '';
  for (let index = start.index + start[0].length; index < json.length; index++) {
    const char = json[index]!;
    if (char === '"') break;
    if (char !== '\\') {
      out += char;
      continue;
    }
    const next = json[index + 1];
    if (next === undefined) break;
    if (next === 'u') {
      const hex = json.slice(index + 2, index + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
      out += String.fromCharCode(parseInt(hex, 16));
      index += 5;
      continue;
    }
    out += { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' }[next] ?? next;
    index += 1;
  }
  return out;
}

function summarize(name: string, result: unknown): string {
  const value = result as Record<string, any>;
  if (isPlanTool(name)) return summarizePlanTool(name, value);
  if (isFactTool(name)) return summarizeFactTool(name, value);
  if (isInvoiceTool(name)) return summarizeInvoiceTool(name, value);
  if (isPayPalTool(name)) return summarizePayPalTool(value);
  if (isScreenTool(name)) return summarizeScreenTool(value);
  if (isQueryTool(name)) return summarizeQueryTool(value);
  switch (name) {
    case 'find_issues':
      return `${value.count} issue(s); worth raising: ${(value.issues as any[]).filter((issue) => issue.worth_raising && !issue.explained_by).map((issue) => issue.title).join('; ') || 'none'}`;
    case 'rental_options':
      return `${value.equipment}: ${value.now.text.cost} now; ${value.asked ? `asked: ${value.asked.text.from} to ${value.asked.text.last_day}, ${value.asked.text.cost}, ${value.asked.text.change}` : value.recommended ? `recommended: ${value.recommended.text.from} to ${value.recommended.text.last_day}, ${value.recommended.text.cost}, ${value.recommended.text.change}` : 'nothing shorter still covers the work'}`;
    case 'get_payment_status':
      return (value.rentals as { supplier: string; payment: string }[]).map((rental) => `${rental.supplier}: ${rental.payment}`).join('; ');
    case 'read_documents':
      return `${value.count} document(s)`;
    case 'stay_quiet':
      return 'quiet';
    default:
      return 'ok';
  }
}

/** One thread's conversation with the model. */
interface Conversation {
  thread: Beta[];
  /** Results of the last presentational tool calls, sent along with the next message. */
  pendingResults: ToolResult[];
  /** Earlier messages (after a restart), given to the model once, with the next turn. */
  history: string;
  /** Whether loadHistory has run for it. */
  primed: boolean;
}

const MAIN_THREAD = 'main';
const keyOf = (threadId: string | null) => threadId ?? MAIN_THREAD;

export class AgentBrain {
  readonly gate: ProactiveGate;
  private readonly conversations = new Map<string, Conversation>();
  /** The turn under way is read by someone who may not see costs: money is withheld. */
  private withhold = false;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly knownMinor = new Set<number>();
  private readonly now: () => number;
  private readonly limits: TurnLimits;

  constructor(private readonly options: BrainOptions) {
    this.now = options.now ?? Date.now;
    this.limits = options.limits ?? DEFAULT_LIMITS;
    this.gate = new ProactiveGate(this.now, { raiseIssues: options.raiseIssues ?? false });
  }

  get ctx(): ToolContext {
    return this.options.ctx;
  }

  /** The how-to clips a card may show. */
  private get clips() {
    return this.ctx.clips ?? howToClips();
  }

  setPresent(members: PlanMember[]): void {
    this.ctx.present = members;
  }

  /** The main thread's conversation with the model (tests read it). */
  get thread(): Beta[] {
    return this.conversation(null).thread;
  }

  private conversation(threadId: string | null): Conversation {
    const key = keyOf(threadId);
    let conversation = this.conversations.get(key);
    if (!conversation) {
      conversation = { thread: [], pendingResults: [], history: '', primed: false };
      this.conversations.set(key, conversation);
    }
    return conversation;
  }

  /** A thread was deleted: its conversation goes too. */
  forgetThread(threadId: string): void {
    this.conversations.delete(keyOf(threadId));
  }

  /** Starts new conversations (the project was reset): the model forgets every old thread. */
  resetConversation(): void {
    this.conversations.clear();
    this.knownMinor.clear();
    this.ctx.issues.clear();
    this.ctx.drafts.clear();
    this.ctx.edits.clear();
    this.ctx.invoices?.clear();
    this.gate.reset();
  }

  /** Earlier messages of a thread (after a restart), given to the model once, with the next turn. */
  prime(lines: string[], threadId: string | null = null): void {
    const conversation = this.conversation(threadId);
    conversation.history = historyBlock(lines);
    conversation.primed = true;
  }

  /** Resolves when every queued turn has finished. */
  async whenIdle(): Promise<void> {
    let seen: Promise<unknown>;
    do {
      seen = this.queue;
      await seen;
    } while (seen !== this.queue);
  }

  /** Runs `work` after every turn already queued (one open turn per project). */
  enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  notify(trigger: Trigger, options: { force?: boolean } = {}): Promise<TurnResult | null> {
    return this.enqueue(async () => {
      await this.options.beforeDecide?.();
      const decision = options.force ? { wake: true, reason: 'forced' } : this.gate.decide(trigger, this.ctx.plan, this.ctx.workflow, this.ctx.present);
      this.emit({ type: 'gate', trigger: trigger.kind, decision });
      if (!decision.wake) return null;
      if (await this.options.admit?.({ person: false, text: null })) return null;
      const at = planStamp(this.ctx.planDate, new Date(this.now()));
      const prechecked = decision.issue ? this.precheck(decision.issue) : null;
      const text = trigger.kind === 'plan_changed' ? planChangedEvent(trigger.revision, at, prechecked) : meetingStartedEvent(this.ctx.present, at, prechecked);
      const kind: AgentTurnKind = 'proactive';
      // Finding and weighing an issue is the analysis model's job; when the gate already found it and
      // worked out the rental options (<prechecked>), only the wording is left, and the fast model does that.
      const analyzing = !text.includes('<prechecked>');
      const result = await this.runTurn(kind, 'app', text, null, analyzing ? this.options.models.analysis : this.options.models.chat, analyzing ? 'medium' : 'low');
      for (const card of result.cards) {
        if (card.component === 'show_issue_card') this.gate.markRaised((card.props as { issue_id: string }).issue_id);
      }
      return result;
    });
  }

  /**
   * A person wrote or spoke (or did something the assistant hears: applied a change, dropped a library
   * piece; `action`). The voice worker calls this with channel 'voice' and speaks `say`.
   */
  handleUtterance(
    text: string,
    speaker: PlanMember,
    options: {
      channel?: 'text' | 'voice';
      turnId?: string;
      action?: AgentAction | null;
      threadId?: string | null;
      context?: AgentMessageContext | null;
      /** The stored message this answers (left out of the thread's history). */
      messageId?: string | null;
    } = {},
  ): Promise<TurnResult> {
    const channel = options.channel ?? 'text';
    const threadId = options.threadId ?? null;
    // Spotting where else a dropped piece belongs takes judgment: the analysis model does it.
    const analyzing = options.action?.kind === 'library_drop';
    return this.enqueue(async () => {
      const refusal = await this.options.admit?.({ person: true, text });
      if (refusal) return this.refuse(refusal, 'utterance', channel, speaker, options.turnId, threadId);
      // Drafting new work needs the project's crews and areas: asked for by name, or as new work to add to the plan.
      const drafting = /\b(draft|package|template|piece|snippet|add|new)\b/i.test(text) ? crewsBlock(this.ctx.plan) + areasBlock(this.ctx.plan) : '';
      const words = utterance(text, speaker, channel, options.action ?? null, describeContext(this.ctx.plan, options.context ?? null) + drafting);
      // Spoken turns think first (medium): at low effort the model sometimes works a rule out in its reply, and on a call
      // every word of a reply is said aloud.
      return this.runTurn('utterance', channel, words, speaker, analyzing ? this.options.models.analysis : this.options.models.chat, analyzing || channel === 'voice' ? 'medium' : 'low', {
        ...(options.turnId ? { turnId: options.turnId } : {}),
        threadId,
        answering: options.messageId ?? null,
      });
    });
  }

  /**
   * A watch rule its author set to "ask the assistant" spoke up: a turn in the conversation opened for
   * it (`event`: watchFiredEvent). Working out alternatives takes judgment: the analysis model does it.
   */
  investigate(event: string, threadId: string, card?: { component: UiComponentName; props: Record<string, unknown> }): Promise<TurnResult> {
    // With a card the app draws by itself, only the words are left: the fast model does them, and the card shows whatever happens to the turn.
    return this.enqueue(async () => {
      const refusal = await this.options.admit?.({ person: false, text: null });
      if (refusal) return this.refuse(refusal, 'proactive', 'app', null, undefined, threadId);
      return card
        ? this.runTurn('proactive', 'app', event, null, this.options.models.chat, 'low', { threadId, requiredCard: card })
        : this.runTurn('proactive', 'app', event, null, this.options.models.analysis, 'medium', { threadId, mustAnswer: true });
    });
  }

  /**
   * Something happened in the app that the people should hear about at once (PayPal confirming a payment one of them
   * sent): a turn in that conversation, answered on `channel` (voice when they are on a call). Not a proactive issue:
   * the gate isn't asked, and it answers whatever AGENT_PROACTIVE says.
   */
  appEvent(event: string, threadId: string | null, channel: AgentChannel): Promise<TurnResult> {
    return this.enqueue(async () => {
      const refusal = await this.options.admit?.({ person: false, text: null });
      if (refusal) return this.refuse(refusal, 'proactive', channel, null, undefined, threadId);
      return this.runTurn('proactive', channel, event, null, this.options.models.chat, 'low', { threadId, mustAnswer: true });
    });
  }

  /**
   * A turn the hosted limits refused: their one plain reply, streamed and stored like an answer (on a call, Remy says
   * it), and no model call.
   */
  private async refuse(
    refusal: Refusal,
    kind: AgentTurnKind,
    channel: AgentChannel,
    speaker: PlanMember | null,
    givenTurnId: string | undefined,
    threadId: string | null,
  ): Promise<TurnResult> {
    const turnId = givenTurnId ?? randomUUID();
    const started = this.now();
    const speakerId = speaker?.userId ?? null;
    this.emit({ type: 'turn_start', turnId, kind, model: 'none', speakerId, threadId });
    this.emit({ type: 'text_delta', turnId, text: refusal.say });
    const result: TurnResult = {
      turnId,
      kind,
      threadId,
      channel,
      model: 'none',
      speakerId,
      say: refusal.say,
      cards: [],
      toolCalls: [],
      quiet: false,
      stopReason: null,
      steps: 0,
      usage: NO_USAGE,
      ms: this.now() - started,
      firstTextMs: 0,
      firstCardMs: null,
      warnings: [],
      refused: refusal.reason,
    };
    let messageId: string | null = null;
    try {
      messageId = (await this.options.persist?.(result)) ?? null;
    } catch (failure) {
      result.error = `could not store the reply: ${failure instanceof Error ? failure.message : String(failure)}`;
    }
    this.emit({ type: 'turn_end', turnId, result, messageId });
    return result;
  }

  /** The issue the gate picked, with the rental's options already worked out, so the opening needs one call. */
  private precheck(issue: Issue): { issue: Issue; options: RentalChoices } | null {
    this.ctx.issues.set(issue.id, issue);
    for (const amount of minorValues(issue)) this.knownMinor.add(amount);
    if (!issue.booking_id) return null;
    try {
      const options = rentalChoices(this.ctx.plan, { bookingId: issue.booking_id });
      for (const amount of minorValues(options)) this.knownMinor.add(amount);
      return { issue, options };
    } catch {
      return null;
    }
  }

  private emit(event: BrainEvent): void {
    this.options.onEvent?.(event);
  }

  private async runTurn(
    kind: AgentTurnKind,
    channel: AgentChannel,
    userText: string,
    speaker: PlanMember | null,
    model: string,
    effort: 'low' | 'medium' | 'high',
    options: TurnOptions = {},
  ): Promise<TurnResult> {
    const turnId = options.turnId ?? randomUUID();
    const threadId = options.threadId ?? null;
    const { requiredCard } = options;
    const limits = this.limits;
    try {
      await this.options.beforeTurn?.();
    } catch {
      // The turn goes ahead on what the brain already knows.
    }
    const started = this.now();
    const conversation = this.conversation(threadId);
    if (!conversation.primed) {
      conversation.primed = true;
      try {
        conversation.history = historyBlock((await this.options.loadHistory?.(threadId, options.answering ?? null)) ?? []);
      } catch {
        conversation.history = '';
      }
    }
    const thread = conversation.thread;
    this.ctx.speaker = speaker;
    const audience = this.options.audienceOf?.(threadId) ?? null;
    this.withhold = !moneyAllowed(audience);
    this.emit({ type: 'turn_start', turnId, kind, model, speakerId: speaker?.userId ?? null, threadId });
    thread.push({ role: 'user', content: [...conversation.pendingResults, { type: 'text', text: conversation.history + userText + describeAudience(audience) }] });
    conversation.pendingResults = [];
    conversation.history = '';

    const cards = new Map<string, AgentCard>();
    const toolCalls: ToolCallRecord[] = [];
    let usage: TokenUsage = NO_USAGE;
    let say = '';
    let quiet = false;
    let stopReason: string | null = null;
    let steps = 0;
    let jsonRetries = 0;
    /** A tool was refused earlier in this turn, so plain words written before another tool are the model talking to itself. */
    let afterRefusal = false;
    let firstTextMs: number | null = null;
    let firstCardMs: number | null = null;
    let error: string | undefined;
    /** The people have had words, or a card with something in it, since the model last looked something up. */
    let answered = false;
    /** The model was told once already, this turn, that nothing it wrote reached them. */
    let nudged = false;
    /** Words were streamed out during the current model call. */
    let spokeInStep = false;
    /** A tool call was cut off at the output cap, so what was asked wasn't done, whatever was said before it. */
    let cutOff = false;
    /** Output tokens one call may use (thinking included); a spoken call cut off mid tool call is run again, once, with more. */
    let cap = kind === 'proactive' ? limits.maxTokens.proactive : channel === 'voice' ? limits.maxTokens.voice : limits.maxTokens.text;
    const systemCache = limits.systemCacheTtl === '1h' ? { type: 'ephemeral' as const, ttl: '1h' as const } : { type: 'ephemeral' as const };

    // In a thread read by someone who may not see costs, amounts are masked before they stream.
    const redactor = this.withhold ? streamRedactor() : null;
    const speak = (text: string) => {
      if (text) spokeInStep = true;
      const shown = redactor ? redactor.push(text) : text;
      if (!shown) return;
      if (firstTextMs === null) firstTextMs = this.now() - started;
      this.emit({ type: 'text_delta', turnId, text: shown });
    };
    /** Someone is owed words: a person asked, the app needs an answer, or the turn has already begun to speak. */
    const owed = () => kind === 'utterance' || options.mustAnswer === true || say !== '';
    /** Ends what was said with one of the brain's own lines. */
    const conclude = (line: string) => {
      const gap = say && !/\s$/.test(say) ? ' ' : '';
      speak(gap + line);
      say += gap + line;
      answered = true;
    };

    try {
      while (steps < limits.maxSteps) {
        steps += 1;
        spokeInStep = false;
        const stream = this.options.client.beta.messages.stream({
          model,
          max_tokens: cap,
          system: [{ type: 'text', text: this.options.systemPrompt ?? SYSTEM_PROMPT, cache_control: systemCache }],
          tools: TOOL_DEFINITIONS,
          messages: thread,
          thinking: { type: 'adaptive' },
          output_config: { effort },
          cache_control: { type: 'ephemeral' },
          ...(supportsServerFallback(model) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
        });
        const blocks = new Map<number, { id: string; name: string; json: string; spoken: number }>();
        // Plain words (not written through reply) wait until the step shows what they are: beside a tool call they are
        // the model's own note ("They asked for exactly the end date; draft as asked."), never said or kept; alone they
        // are an answer written as text, said once the step is done.
        let held = '';
        stream.on('streamEvent', (event, snapshot) => {
          if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
            const { id, name } = event.content_block;
            blocks.set(event.index, { id, name, json: '', spoken: 0 });
            if (name === 'reply' && say) speak(' ');
            if (name !== 'reply') this.emit({ type: 'tool', turnId, toolId: id, name, state: 'start' });
          } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            held += event.delta.text;
          } else if (event.type === 'content_block_delta' && event.delta.type === 'input_json_delta') {
            const block = blocks.get(event.index);
            if (!block) return;
            block.json += event.delta.partial_json;
            if (block.name === 'reply') {
              const sofar = partialStringField(block.json, 'text');
              if (sofar.length > block.spoken) {
                speak(sofar.slice(block.spoken));
                block.spoken = sofar.length;
              }
            } else if (isUiComponent(block.name)) {
              const live = snapshot.content[event.index];
              if (live?.type === 'tool_use') this.emit({ type: 'ui_partial', turnId, cardId: block.id, component: block.name, props: live.input });
            }
          }
        });

        let message: Anthropic.Beta.Messages.BetaMessage;
        try {
          message = await stream.finalMessage();
          jsonRetries = 0;
        } catch (failure) {
          // Only an unparseable streamed tool input is retried; API errors (auth, rate limit) surface.
          if (failure instanceof Anthropic.APIError || jsonRetries++ >= 2) throw failure;
          steps -= 1;
          continue;
        }
        usage = addUsage(usage, usageOf(message.usage));
        stopReason = message.stop_reason;

        if (message.stop_reason === 'refusal') {
          if (!answered) conclude(REFUSAL_LINE);
          thread.push({ role: 'assistant', content: [{ type: 'text', text: say || REFUSAL_LINE }] });
          break;
        }
        // A spoken call's allowance is small, and thinking or a drafted piece of work can outrun it: when nothing of the
        // call was said, it is left out of the thread (nothing in it ran) and run again, once, with a written turn's.
        if (message.stop_reason === 'max_tokens' && !spokeInStep && cap < limits.maxTokens.text) {
          this.abandon(turnId, message);
          cap = limits.maxTokens.text;
          continue;
        }
        thread.push({ role: 'assistant', content: message.content as Beta['content'] });

        // Finish what was streamed: the complete reply texts and text blocks, in order. A response of words alone,
        // written both as text and in reply (the prompt asks for reply only), is one answer written twice: what reply
        // says is kept.
        const saidBefore = say.trimEnd().length;
        const talkOnly = message.content.some((block) => block.type === 'tool_use' && block.name === 'reply') && message.content.every((block) => block.type !== 'tool_use' || block.name === 'reply');
        // Words beside a tool call are the model's note to itself ("Crew names need to be bare names; redraw.", "They asked
        // for exactly the end date; draft as asked."): what people hear and read comes through reply alone.
        const tooled = message.content.some((block) => block.type === 'tool_use' && block.name !== 'reply');
        if (held && !tooled && !talkOnly) speak(held);
        for (const [index, block] of message.content.entries()) {
          if (block.type === 'text') {
            if (talkOnly || tooled) continue;
            say += (say && !/\s$/.test(say) ? ' ' : '') + block.text.trim();
          } else if (block.type === 'tool_use' && block.name === 'reply') {
            const full = typeof (block.input as { text?: unknown }).text === 'string' ? (block.input as { text: string }).text : '';
            const spoken = blocks.get(index)?.spoken ?? 0;
            if (full.length > spoken) speak(full.slice(spoken));
            say += (say && !/\s$/.test(say) ? ' ' : '') + full.trim();
          }
        }
        if (say.trimEnd().length > saidBefore) answered = true;

        const uses = message.content.filter((block): block is ToolUse => block.type === 'tool_use');
        if (uses.length > 0 && message.stop_reason === 'max_tokens') {
          cutOff = true;
          throw new Error('A tool call was cut off at max_tokens; nothing was run');
        }

        const results: ToolResult[] = [];
        let ending = uses.length === 0;
        if (uses.length > 0) {
          let terminal = false;
          let rejected = false;
          /** Screen actions done on the person's screen whose result the short reply already covers. */
          let shownEnough = true;
          for (const use of uses) {
            const record = await this.runTool(turnId, use, cards);
            toolCalls.push(record.call);
            results.push(this.fit(record.result));
            if (isScreenTool(use.name) && !(record.call.ok && saidEnough(record.result))) shownEnough = false;
            if (isUiComponent(use.name) && !record.call.ok) rejected = true;
            if (isUiComponent(use.name) && record.call.ok && firstCardMs === null) firstCardMs = this.now() - started;
            // A card with something in it answers; the next steps offered (suggest_next) don't.
            if (isUiComponent(use.name) && record.call.ok && use.name !== 'suggest_next') answered = true;
            if (TERMINAL_TOOLS.has(use.name) && record.call.ok) terminal = true;
            if (use.name === 'stay_quiet' && record.call.ok) quiet = true;
          }
          afterRefusal ||= toolCalls.slice(-uses.length).some((call) => !call.ok);
          const presentational = uses.every((use) => use.name === 'reply' || isUiComponent(use.name));
          // "Opening the site view." and the site view opening on their screen: nothing is left to say, so no second call.
          const shown =
            shownEnough &&
            uses.some((use) => use.name === 'reply') &&
            uses.some((use) => isScreenTool(use.name)) &&
            uses.every((use) => use.name === 'reply' || isUiComponent(use.name) || isScreenTool(use.name));
          ending = terminal || ((presentational || shown) && !rejected) || message.stop_reason !== 'tool_use';
        }
        if (ending && !quiet && !answered && !nudged && owed() && steps < limits.maxSteps) {
          // The turn would end on its opener, or on nothing: what the model wrote outside reply came back as a hidden
          // note. It is told once, with the results, and answers with reply.
          nudged = true;
          thread.push({ role: 'user', content: [...results, { type: 'text', text: UNANSWERED_NOTE }] });
          continue;
        }
        if (ending) {
          conversation.pendingResults = results;
          break;
        }
        thread.push({ role: 'user', content: results });
        // After a lookup, whatever was said so far opened it: the answer comes after. (A card sent back to be redrawn
        // is no lookup: the words with it stand.)
        if (uses.some((use) => use.name !== 'reply' && !isUiComponent(use.name))) answered = false;
      }
      if (steps >= limits.maxSteps && thread.at(-1)?.role === 'user') {
        const last = thread.pop()!;
        conversation.pendingResults = (last.content as ToolResult[]).filter((block) => block.type === 'tool_result');
      }
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
      // Keep the thread valid: a turn that broke mid-way ends with the assistant's apology.
      if (thread.at(-1)?.role === 'user') {
        const last = thread.at(-1)!;
        const hasResults = Array.isArray(last.content) && last.content.some((block) => (block as { type: string }).type === 'tool_result');
        if (hasResults) {
          thread.pop();
          conversation.pendingResults = (last.content as ToolResult[]).filter((block) => block.type === 'tool_result');
        }
      }
      // A turn cut off mid tool call says so even after words: "That's $17,150 a floor" alone would leave the person
      // thinking the draft was made.
      if (!answered || cutOff) conclude(ERROR_LINE);
      if (thread.at(-1)?.role === 'user' && conversation.pendingResults.length === 0) thread.push({ role: 'assistant', content: [{ type: 'text', text: say || ERROR_LINE }] });
    }
    // Never an opener with nothing after it.
    if (!quiet && !answered && owed()) conclude(UNFINISHED_LINE);

    if (requiredCard && ![...cards.values()].some((card) => card.component === requiredCard.component)) {
      const card: AgentCard = { id: `required-${turnId}`.slice(0, 64), component: requiredCard.component, props: requiredCard.props };
      cards.set(card.id, card);
      this.emit({ type: 'card', turnId, card, status: 'final' });
    }
    this.ctx.speaker = null;
    const rest = redactor?.end();
    if (rest) this.emit({ type: 'text_delta', turnId, text: rest });
    // The stored reply is masked like the streamed one.
    if (this.withhold) say = redactAmounts(say);
    this.withhold = false;
    for (const member of this.ctx.plan.members) this.knownMinor.add(member.approvalLimitMinor);
    const warnings = ungroundedAmounts(say, this.knownMinor).map((amount) => `The reply mentions $${(amount / 100).toFixed(2)}, which no tool computed`);
    for (const message of warnings) this.emit({ type: 'warning', turnId, message });
    const result: TurnResult = {
      turnId,
      kind,
      threadId,
      channel,
      model,
      speakerId: speaker?.userId ?? null,
      say: quiet ? '' : say,
      cards: [...cards.values()],
      toolCalls,
      quiet,
      stopReason,
      steps,
      usage,
      ms: this.now() - started,
      firstTextMs,
      firstCardMs,
      warnings,
      ...(error ? { error } : {}),
    };
    let messageId: string | null = null;
    if (!result.quiet && (result.say || result.cards.length > 0)) {
      try {
        messageId = (await this.options.persist?.(result)) ?? null;
      } catch (failure) {
        result.error = `could not store the reply: ${failure instanceof Error ? failure.message : String(failure)}`;
      }
    }
    this.emit({ type: 'turn_end', turnId, result, messageId });
    // What the turn cost is recorded before the next turn starts, so a spent budget stops that one.
    if (this.options.onSpend && (usage.input || usage.output || usage.cacheRead || usage.cacheWrite)) {
      try {
        await this.options.onSpend(model, usage);
      } catch {
        // Recording is the ledger's job; a turn never fails over it.
      }
    }
    return result;
  }

  /** A tool result handed back to the model, cut to the turn limits' size with a note saying so. */
  private fit(result: ToolResult): ToolResult {
    const max = this.limits.toolResultChars;
    if (max === null || typeof result.content !== 'string' || result.content.length <= max) return result;
    const note = `\n[Shortened: this result was ${result.content.length.toLocaleString('en-US')} characters and only the first ${max.toLocaleString('en-US')} are here. Ask for less (fewer tasks, fields or days) to see the rest.]`;
    return { ...result, content: result.content.slice(0, max) + note };
  }

  /** A call cut off before it finished: its tool calls never ran, so the people's screens drop them. */
  private abandon(turnId: string, message: Anthropic.Beta.Messages.BetaMessage): void {
    for (const block of message.content) {
      if (block.type !== 'tool_use' || block.name === 'reply') continue;
      if (isUiComponent(block.name)) this.emit({ type: 'card', turnId, card: { id: block.id, component: block.name, props: block.input }, status: 'rejected', error: 'cut off before it was finished' });
      this.emit({ type: 'tool', turnId, toolId: block.id, name: block.name, state: 'error', summary: 'cut off before it was finished; trying again' });
    }
  }

  /** The stored card: plan edits, snippet drafts and clips carry what the tools checked, not what the model retyped. */
  private fillIn(component: UiComponentName, props: Record<string, unknown>): Record<string, unknown> {
    // Which tasks it is about, for whoever is looking at the plan: from the records, not from the model.
    if (component === 'show_issue_card') return { ...props, task_ids: this.ctx.issues.get(props.issue_id as string)?.task_ids ?? [] };
    if (component === 'show_how') return { ...howToCard(this.clips, props.clip as string)! };
    if (component === 'show_plan_edit') {
      const edit = this.ctx.edits.get(props.edit_id as string)!;
      return { ...props, operations: edit.operations, lines: edit.lines, warnings: edit.warnings };
    }
    // The invoice as drafted from the plan: the model names it, the tool's lines and total are what is shown and sent.
    if (component === 'show_change_invoice') return { ...this.ctx.invoices!.get(props.invoice_id as string)! };
    if (component === 'show_snippets') {
      const drafts = props.drafts as { draft_id: string; why: string }[];
      return {
        ...props,
        drafts: drafts.map((draft) => {
          const record = this.ctx.drafts.get(draft.draft_id)!;
          return { ...draft, snippet: record.snippet, source_task_ids: record.source_task_ids };
        }),
      };
    }
    return props;
  }

  private async runTool(turnId: string, use: ToolUse, cards: Map<string, AgentCard>): Promise<{ call: ToolCallRecord; result: ToolResult }> {
    const started = this.now();
    const fail = (message: string): { call: ToolCallRecord; result: ToolResult } => {
      if (use.name !== 'reply') this.emit({ type: 'tool', turnId, toolId: use.id, name: use.name, state: 'error', summary: message.slice(0, 300) });
      return {
        call: { name: use.name, input: use.input, ok: false, summary: message, ms: this.now() - started },
        result: { type: 'tool_result', tool_use_id: use.id, is_error: true, content: message },
      };
    };

    if (isUiComponent(use.name)) {
      let parsed = UI_COMPONENTS[use.name].safeParse(use.input);
      if (!parsed.success) {
        const message = `The card was not shown: ${z.prettifyError(parsed.error)}`;
        this.emit({ type: 'card', turnId, card: { id: use.id, component: use.name, props: use.input }, status: 'rejected', error: message });
        return fail(message);
      }
      // An invoice is all amounts: it is not shown where someone reading may not see costs.
      if (this.withhold && use.name === 'show_change_invoice') {
        const message = 'The card was not shown: someone reading this thread may not see costs, and an invoice is all amounts. Say in words, without amounts, that the invoice is drafted and that someone who sees costs can look it over and send it in a conversation of their own.';
        this.emit({ type: 'card', turnId, card: { id: use.id, component: use.name, props: parsed.data }, status: 'rejected', error: message });
        return fail(message);
      }
      // Someone reading may not see costs: the card goes without its amounts, or not at all.
      if (this.withhold && carriesMoney(parsed.data)) {
        const schema = UI_COMPONENTS[use.name];
        const cleaned = [withoutMoney(parsed.data, 'null'), withoutMoney(parsed.data, 'drop')].map((candidate) => schema.safeParse(candidate)).find((result) => result.success);
        if (!cleaned?.success) {
          const message = 'The card was not shown: someone reading this thread may not see costs, so it cannot carry amounts. Say it in words without them.';
          this.emit({ type: 'card', turnId, card: { id: use.id, component: use.name, props: parsed.data }, status: 'rejected', error: message });
          return fail(message);
        }
        parsed = cleaned;
      }
      const problems = groundCard(use.name, parsed.data as Record<string, any>, {
        issues: this.ctx.issues,
        knownMinor: this.knownMinor,
        taskIds: new Set(this.ctx.plan.tasks.map((task) => task.id)),
        edits: new Set(this.ctx.edits.keys()),
        drafts: new Set(this.ctx.drafts.keys()),
        invoices: new Set(this.ctx.invoices?.keys() ?? []),
        clips: this.clips,
      });
      if (problems.length > 0) {
        const message = `The card was not shown: ${problems.join('; ')}`;
        this.emit({ type: 'card', turnId, card: { id: use.id, component: use.name, props: parsed.data }, status: 'rejected', error: message });
        return fail(message);
      }
      // One card per component per turn: a second call replaces the first.
      for (const [id, existing] of cards) if (existing.component === use.name) cards.delete(id);
      const card: AgentCard = { id: use.id, component: use.name, props: this.fillIn(use.name, parsed.data as Record<string, unknown>) };
      cards.set(use.id, card);
      this.emit({ type: 'card', turnId, card, status: 'final' });
      this.emit({ type: 'tool', turnId, toolId: use.id, name: use.name, state: 'ok', summary: 'shown' });
      return {
        call: { name: use.name, input: parsed.data, ok: true, summary: 'shown', ms: this.now() - started },
        result: { type: 'tool_result', tool_use_id: use.id, content: JSON.stringify({ shown: true }) },
      };
    }

    if (!(use.name in DataToolSchemas)) return fail(`Unknown tool ${use.name}`);
    try {
      const value = await runDataTool(use.name as DataToolName, use.input, this.ctx);
      for (const amount of minorValues(value)) this.knownMinor.add(amount);
      const summary = summarize(use.name, value);
      if (use.name !== 'reply') this.emit({ type: 'tool', turnId, toolId: use.id, name: use.name, state: 'ok', summary: summary.slice(0, 300) });
      return {
        call: { name: use.name, input: use.input, ok: true, summary, ms: this.now() - started },
        result: { type: 'tool_result', tool_use_id: use.id, content: JSON.stringify(value) },
      };
    } catch (failure) {
      if (failure instanceof ToolRefusal) return fail(failure.message);
      return fail(failure instanceof Error ? `Failed: ${failure.message}` : String(failure));
    }
  }
}

/** Whether a screen action's result says the reply before it was enough (`said_enough`). */
function saidEnough(result: ToolResult): boolean {
  if (result.is_error || typeof result.content !== 'string') return false;
  try {
    return (JSON.parse(result.content) as { said_enough?: unknown }).said_enough === true;
  } catch {
    return false;
  }
}

/** Plain words for a turn's timing line in the logs. */
export function timingLine(result: TurnResult): string {
  const seconds = (ms: number | null) => (ms === null ? '-' : `${(ms / 1000).toFixed(1)} s`);
  return `${result.kind} on ${result.model}: first words ${seconds(result.firstTextMs)}, first card ${seconds(result.firstCardMs)}, done ${seconds(result.ms)}, ${result.steps} call(s), tokens in/out ${result.usage.input}/${result.usage.output} (cache read ${result.usage.cacheRead})`;
}
