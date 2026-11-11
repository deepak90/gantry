/**
 * The assistant on the hosted site (GANTRY_HOSTED=1), where every visitor has their own copy of the project. Before a
 * turn runs the model, the live AI switch (`app_flags.live_ai`) and the copy's allowance (`use_quota('ai_turn',
 * project)`) are checked; when either says no, the turn is one plain reply and no model call. A person's message over
 * 600 characters is refused politely before either. A turn that runs is held to the hosted turn limits (fewer model
 * calls, fewer output tokens, tool results cut short, the system prompt cached for an hour), and what it cost goes in
 * the day's spend ledger (`record_spend`), which switches live AI off once the day's budget is spent. Without
 * GANTRY_HOSTED nothing here runs.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { TurnLimits } from './agent/brain';
import type { Logger } from './log';

export const MAX_MESSAGE_CHARS = 600;
export const LIMIT_REPLY = "I've reached today's limit for this session. The rest of the app still works.";
export const TOO_LONG_REPLY = `That's a bit long for me. Could you put it in ${MAX_MESSAGE_CHARS} characters or fewer?`;
export const UNAVAILABLE_REPLY = "I can't answer right now. The rest of the app still works.";

/**
 * The hosted site's turn limits: at most 5 model calls a turn; 4,000 output tokens a call for a written turn, 3,000 for
 * a spoken one (enough for a drafted change across three floors) and 4,000 for one the app started; a
 * tool result handed back to the model cut at 8,000 characters; and the system prompt (with the tools before it) cached
 * for an hour, so a quiet spell doesn't write it again every five minutes.
 */
export const HOSTED_TURN_LIMITS: TurnLimits = {
  maxSteps: 5,
  maxTokens: { text: 4_000, voice: 3_000, proactive: 4_000 },
  toolResultChars: 8_000,
  systemCacheTtl: '1h',
};

/** Why a turn didn't run: the message was too long, live AI is switched off, the allowance is spent, or the checks failed. */
export type RefusalReason = 'too_long' | 'off' | 'quota' | 'unavailable';

export interface Refusal {
  reason: RefusalReason;
  /** The plain reply said instead. */
  say: string;
}

/** A turn about to run: a person's words (`text`), or something the app started (`person: false`, no text). */
export interface TurnAsk {
  person: boolean;
  text: string | null;
}

/** Asked before a turn runs the model: null to go ahead, or the refusal to say instead. */
export type Admit = (turn: TurnAsk) => Promise<Refusal | null>;

/** What the database says about the hosted limits. Both throw when it doesn't answer. */
export interface HostedLimits {
  /** `app_flags.live_ai`; off when the row is missing. */
  liveAi(): Promise<boolean>;
  /** `use_quota('ai_turn', project)`: true when the turn may run (and it counted). */
  useTurn(projectId: string): Promise<boolean>;
}

/**
 * The gate for one project's turns. The length comes first, so a refused message spends nothing; the switch next, then
 * the allowance, which a turn spends when it runs. When the checks themselves fail, nothing runs either.
 */
export function admitFor(projectId: string, limits: HostedLimits, log: Logger): Admit {
  return async ({ person, text }) => {
    if (person && text !== null && text.trim().length > MAX_MESSAGE_CHARS) return { reason: 'too_long', say: TOO_LONG_REPLY };
    try {
      if (!(await limits.liveAi())) return { reason: 'off', say: LIMIT_REPLY };
      if (!(await limits.useTurn(projectId))) return { reason: 'quota', say: LIMIT_REPLY };
      return null;
    } catch (error) {
      log.warn('could not check the hosted limits, so the turn is a plain reply', error);
      return { reason: 'unavailable', say: UNAVAILABLE_REPLY };
    }
  };
}

/** Who a cost is owed to, as the spend ledger names them. */
export type SpendVendor = 'anthropic' | 'openai' | 'elevenlabs' | 'livekit';

/** The day's spend ledger (supabase/migrations/20261111060000_spend_breaker.sql). */
export interface SpendLedger {
  /**
   * `record_spend(vendor, usd_micro)`: adds what was spent, in millionths of a dollar, to today's total (UTC). False
   * once that vendor's daily budget, or the day's total, is spent: the switches it guards (live AI for Anthropic) are
   * then off until the reset at 00:05 UTC. Throws when the database doesn't answer.
   */
  record(vendor: SpendVendor, usdMicro: number): Promise<boolean>;
}

type Result<T> = { data: T | null; error: { message: string } | null };

function unwrap<T>(what: string, result: Result<T>): T | null {
  if (result.error) throw new Error(`${what}: ${result.error.message}`);
  return result.data;
}

/** The hosted limits from the database, with the service role. */
export function supabaseLimits(client: SupabaseClient): HostedLimits {
  return {
    async liveAi() {
      const result = (await client.from('app_flags').select('enabled').eq('key', 'live_ai').maybeSingle()) as Result<{ enabled: boolean }>;
      return unwrap('app_flags', result)?.enabled === true;
    },
    async useTurn(projectId) {
      const result = (await client.rpc('use_quota', { p_kind: 'ai_turn', p_project: projectId })) as Result<boolean>;
      return unwrap('use_quota', result) === true;
    },
  };
}

/** The spend ledger in the database, with the service role. */
export function supabaseSpend(client: SupabaseClient): SpendLedger {
  return {
    async record(vendor, usdMicro) {
      const result = (await client.rpc('record_spend', { p_vendor: vendor, p_usd_micro: Math.max(0, Math.ceil(usdMicro)) })) as Result<boolean>;
      return unwrap('record_spend', result) !== false;
    },
  };
}
