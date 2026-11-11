/**
 * Turns the brain's events into the contract's `stream` events (AgentStreamEvent) at a rate the
 * Realtime tenant is happy with: text deltas are batched to at most one event per `textMs` (10/s),
 * card drafts to at most one per card per `partialMs` (5/s). The first delta of a burst goes out at
 * once; tool events and turn_end flush whatever is buffered first, so order is kept. Every event is
 * validated against the contract before it is sent.
 *
 * With a signer (line-signature.ts), each `tool` event carries the signature of the reply as streamed so far, and
 * `turn_end` the signature of the reply as stored: what the host's tab on a call may hand Remy's voice.
 */
import { AgentStreamEvent } from '@collab/shared';
import type { BrainEvent } from '../agent/brain';
import type { LineSigner } from './line-signature';

export interface Timers {
  now(): number;
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const realTimers: Timers = {
  now: () => Date.now(),
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

interface TurnBuffer {
  seq: number;
  text: string;
  /** Everything streamed of the reply so far, as the tabs have it. */
  sent: string;
  lastText: number;
  textTimer: unknown;
  partials: Map<string, { component: string; props: unknown }>;
  lastPartial: Map<string, number>;
  partialTimer: unknown;
}

const MAX_DELTA = 2000;

export class StreamBatcher {
  private readonly turns = new Map<string, TurnBuffer>();

  constructor(
    private readonly send: (event: AgentStreamEvent) => void,
    private readonly options: { textMs?: number; partialMs?: number; timers?: Timers; onInvalid?: (reason: string) => void; sign?: LineSigner | null } = {},
  ) {}

  private get timers(): Timers {
    return this.options.timers ?? realTimers;
  }

  private emit(event: AgentStreamEvent): boolean {
    const parsed = AgentStreamEvent.safeParse(event);
    if (parsed.success) this.send(parsed.data);
    else this.options.onInvalid?.(`${event.type}: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
    return parsed.success;
  }

  /** `{ sig }` for a reply's text, with a signer and words to sign; nothing otherwise. */
  private signed(turnId: string, text: string): { sig?: string } {
    const sig = this.options.sign?.(turnId, text) ?? null;
    return sig ? { sig } : {};
  }

  private buffer(turnId: string): TurnBuffer {
    let turn = this.turns.get(turnId);
    if (!turn) {
      turn = { seq: 0, text: '', sent: '', lastText: -Infinity, textTimer: null, partials: new Map(), lastPartial: new Map(), partialTimer: null };
      this.turns.set(turnId, turn);
    }
    return turn;
  }

  handle(event: BrainEvent): void {
    switch (event.type) {
      case 'turn_start':
        this.buffer(event.turnId);
        this.emit({ type: 'turn_start', turn_id: event.turnId, kind: event.kind, speaker_id: event.speakerId, thread_id: event.threadId });
        return;
      case 'text_delta': {
        const turn = this.buffer(event.turnId);
        turn.text += event.text;
        this.scheduleText(event.turnId, turn);
        return;
      }
      case 'ui_partial': {
        const turn = this.buffer(event.turnId);
        turn.partials.set(event.cardId, { component: event.component, props: event.props });
        this.schedulePartials(event.turnId, turn);
        return;
      }
      case 'card': {
        // The checked card replaces its draft at once (the stored message carries it too).
        const turn = this.buffer(event.turnId);
        if (event.status === 'final') turn.partials.set(event.card.id, { component: event.card.component, props: event.card.props });
        else turn.partials.delete(event.card.id);
        this.flushText(event.turnId, turn);
        this.flushPartials(event.turnId, turn, true);
        return;
      }
      case 'tool': {
        const turn = this.buffer(event.turnId);
        this.flushText(event.turnId, turn);
        this.flushPartials(event.turnId, turn, true);
        this.emit({
          type: 'tool',
          turn_id: event.turnId,
          tool_id: event.toolId.slice(0, 64),
          name: event.name,
          state: event.state,
          ...(event.summary ? { summary: event.summary.slice(0, 300) } : {}),
          // What was written before the tool, as the tabs have it: on a call, said while the tool runs.
          ...this.signed(event.turnId, turn.sent),
        });
        return;
      }
      case 'turn_end': {
        const turn = this.buffer(event.turnId);
        this.flushText(event.turnId, turn);
        this.flushPartials(event.turnId, turn, true);
        this.timers.clear(turn.textTimer);
        this.timers.clear(turn.partialTimer);
        this.turns.delete(event.turnId);
        this.emit({
          type: 'turn_end',
          turn_id: event.turnId,
          message_id: event.messageId,
          ...(event.result.error ? { error: event.result.error.slice(0, 500) } : {}),
          // The reply as stored (project-agent.ts persist): on a call, said once it lands.
          ...(event.messageId && !event.result.quiet ? this.signed(event.turnId, event.result.say.slice(0, 4000)) : {}),
        });
        return;
      }
      default:
        return;
    }
  }

  private scheduleText(turnId: string, turn: TurnBuffer): void {
    const interval = this.options.textMs ?? 100;
    const wait = turn.lastText + interval - this.timers.now();
    if (wait <= 0) {
      this.flushText(turnId, turn);
      return;
    }
    if (turn.textTimer === null) {
      turn.textTimer = this.timers.set(() => {
        turn.textTimer = null;
        this.flushText(turnId, turn);
      }, wait);
    }
  }

  private flushText(turnId: string, turn: TurnBuffer): void {
    if (turn.textTimer !== null) {
      this.timers.clear(turn.textTimer);
      turn.textTimer = null;
    }
    while (turn.text) {
      const piece = turn.text.slice(0, MAX_DELTA);
      turn.text = turn.text.slice(MAX_DELTA);
      if (this.emit({ type: 'text_delta', turn_id: turnId, seq: turn.seq++, text: piece })) turn.sent += piece;
    }
    turn.lastText = this.timers.now();
  }

  private schedulePartials(turnId: string, turn: TurnBuffer): void {
    const interval = this.options.partialMs ?? 200;
    const now = this.timers.now();
    const due = [...turn.partials.keys()].map((id) => (turn.lastPartial.get(id) ?? -Infinity) + interval - now);
    const wait = Math.min(...due);
    if (wait <= 0) {
      this.flushPartials(turnId, turn, false);
      return;
    }
    if (turn.partialTimer === null) {
      turn.partialTimer = this.timers.set(() => {
        turn.partialTimer = null;
        this.flushPartials(turnId, turn, false);
      }, wait);
    }
  }

  private flushPartials(turnId: string, turn: TurnBuffer, all: boolean): void {
    const interval = this.options.partialMs ?? 200;
    const now = this.timers.now();
    for (const [cardId, draft] of [...turn.partials]) {
      if (!all && now - (turn.lastPartial.get(cardId) ?? -Infinity) < interval) continue;
      this.emit({ type: 'ui_partial', turn_id: turnId, card_id: cardId.slice(0, 64), component: draft.component, props: draft.props });
      turn.lastPartial.set(cardId, now);
      turn.partials.delete(cardId);
    }
    if (turn.partials.size > 0 && turn.partialTimer === null) this.schedulePartials(turnId, turn);
  }
}
