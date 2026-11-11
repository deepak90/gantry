/**
 * Configuration from the repo-root `.env.local` (the file every part of the stack reads). Values are
 * never logged; `describeConfig` reports only which keys are present.
 *
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   the local (or hosted) stack, service role
 *   ANTHROPIC_API_KEY                         needed for AGENT_MODE=live
 *   PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET    the sandbox REST app the Edge Functions use: with PAYPAL_MODE=live,
 *                                             check_with_paypal reads invoice and payout status from PayPal itself,
 *                                             read-only (src/paypal); PAYPAL_ENV must be sandbox or unset
 *   AGENT_MODE=live|replay|mock               default: live with a key, else mock
 *   AGENT_PROJECT_IDS=uuid,uuid               default: every project
 *   AGENT_MODEL_ANALYSIS / AGENT_MODEL_CHAT   model per job (see README)
 *   AGENT_MODEL_TITLE   names new threads (default: the chat model; live mode only)
 *   AGENT_RECORDINGS_DIR                      where live runs are recorded (default apps/agent/recordings)
 *   AGENT_OPENING_DELAY_MS                    wait before the opening once both are present (default 2000)
 *   AGENT_PROACTIVE=off|issues                off (default): the assistant speaks when spoken to; issues: it
 *                                             also raises problems it notices on meeting start and plan edits
 *   GANTRY_HOSTED=1                           the hosted site: the live AI switch, the copies' allowance and the
 *                                             message length are checked before each turn (hosted.ts), the system
 *                                             prompt adds its rule, and /healthz answers on PORT (default 8080)
 *   GANTRY_PLAN_DATE=YYYY-MM-DD               the plan's today, pinned (plan/today.ts): the hosted site runs on the
 *                                             film's day, 2026-11-10, as its pages do; empty: the server's own day
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const AGENT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = resolve(AGENT_ROOT, '../..');

let loaded = false;

/** Loads `.env.local` once; variables already set in the environment win. */
export function loadEnv(file = join(REPO_ROOT, '.env.local')): void {
  if (loaded) return;
  loaded = true;
  if (existsSync(file)) process.loadEnvFile(file);
}

export type AgentMode = 'live' | 'replay' | 'mock';

export interface AgentConfig {
  supabaseUrl: string;
  serviceRoleKey: string;
  mode: AgentMode;
  projectIds: string[] | null;
  models: { analysis: string; chat: string };
  /** Names new threads from their first message (AGENT_MODEL_TITLE, else the chat model); live mode only. */
  titleModel: string | null;
  recordingsDir: string;
  /** Delay before the opening turn once the meeting can start: two people, one who sees costs (AGENT_OPENING_DELAY_MS). */
  openingDelayMs: number;
  /** Whether the assistant raises problems on its own (AGENT_PROACTIVE=issues) or waits to be asked (off). */
  proactive: 'off' | 'issues';
  /** The hosted site (GANTRY_HOSTED=1): limits checked before each turn, and a health check. */
  hosted: boolean;
  /** The plan's today when it is pinned (GANTRY_PLAN_DATE, YYYY-MM-DD); null: the server's own day. */
  planDate: string | null;
}

export function hasAnthropicKey(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.ANTHROPIC_API_KEY?.trim());
}

/** The sandbox REST app's key, for reading PayPal (check_with_paypal). Never logged. */
export interface PayPalAccess {
  clientId: string;
  clientSecret: string;
}

/**
 * PayPal for the assistant: the key when PAYPAL_MODE=live, PAYPAL_ENV is sandbox (or unset) and both halves of the key
 * are set; otherwise null, with why, and check_with_paypal says PayPal isn't connected here.
 */
export function readPayPalAccess(env: NodeJS.ProcessEnv = process.env): { access: PayPalAccess; why: null } | { access: null; why: string } {
  const value = (name: string) => env[name]?.trim() || null;
  if (value('PAYPAL_MODE') !== 'live') return { access: null, why: 'PAYPAL_MODE is not live' };
  if ((value('PAYPAL_ENV') ?? 'sandbox') !== 'sandbox') return { access: null, why: 'PAYPAL_ENV is not sandbox' };
  const clientId = value('PAYPAL_CLIENT_ID');
  const clientSecret = value('PAYPAL_CLIENT_SECRET');
  if (!clientId || !clientSecret) return { access: null, why: 'PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET is not set' };
  return { access: { clientId, clientSecret }, why: null };
}

/** Safe to print: whether the assistant reads PayPal, never the key. */
function paypalWords(paypal: ReturnType<typeof readPayPalAccess>): string {
  return paypal.access ? 'read-only (sandbox)' : `not connected (${paypal.why})`;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const forced = env.AGENT_MODE?.trim() || undefined;
  if (forced && forced !== 'live' && forced !== 'replay' && forced !== 'mock') {
    throw new Error(`AGENT_MODE must be live, replay or mock (got "${forced}")`);
  }
  const mode: AgentMode = (forced as AgentMode | undefined) ?? (hasAnthropicKey(env) ? 'live' : 'mock');
  if (mode === 'live' && !hasAnthropicKey(env)) throw new Error('AGENT_MODE=live needs ANTHROPIC_API_KEY in .env.local');
  const ids = (env.AGENT_PROJECT_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  return {
    supabaseUrl: env.SUPABASE_URL?.trim() || 'http://127.0.0.1:54321',
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY ?? '',
    mode,
    projectIds: ids.length ? ids : null,
    models: {
      analysis: env.AGENT_MODEL_ANALYSIS?.trim() || 'claude-opus-5-5',
      chat: env.AGENT_MODEL_CHAT?.trim() || 'claude-sonnet-5-5',
    },
    titleModel: mode === 'live' ? env.AGENT_MODEL_TITLE?.trim() || env.AGENT_MODEL_CHAT?.trim() || 'claude-sonnet-5-5' : null,
    recordingsDir: env.AGENT_RECORDINGS_DIR?.trim() || join(AGENT_ROOT, 'recordings'),
    openingDelayMs: openingDelay(env.AGENT_OPENING_DELAY_MS),
    proactive: proactiveMode(env.AGENT_PROACTIVE),
    hosted: env.GANTRY_HOSTED?.trim() === '1',
    planDate: pinnedDay(env.GANTRY_PLAN_DATE),
  };
}

/** GANTRY_PLAN_DATE: a real day written YYYY-MM-DD, or nothing. */
function pinnedDay(value: string | undefined): string | null {
  const text = value?.trim() || '';
  if (!text) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const real = match !== null && new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).toISOString().slice(0, 10) === text;
  if (!real) throw new Error(`GANTRY_PLAN_DATE must be a day written YYYY-MM-DD (got "${value}")`);
  return text;
}

function proactiveMode(value: string | undefined): 'off' | 'issues' {
  const mode = value?.trim() || 'off';
  if (mode !== 'off' && mode !== 'issues') throw new Error(`AGENT_PROACTIVE must be off or issues (got "${value}")`);
  return mode;
}

function openingDelay(value: string | undefined): number {
  const parsed = Number(value?.trim() || '2000');
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`AGENT_OPENING_DELAY_MS must be a number of milliseconds (got "${value}")`);
  return parsed;
}

/** Safe to print: names and modes, never values of secrets. */
export function describeConfig(config: AgentConfig): string {
  return [
    `mode=${config.mode}`,
    `supabase=${config.supabaseUrl}`,
    `service_role=${config.serviceRoleKey ? 'set' : 'MISSING'}`,
    `anthropic_key=${hasAnthropicKey() ? 'set' : 'not set'}`,
    `paypal=${paypalWords(readPayPalAccess())}`,
    `projects=${config.projectIds?.join(',') ?? 'all'}`,
    `models=${config.models.analysis} (analysis) / ${config.models.chat} (replies, progress)`,
    `proactive=${config.proactive}`,
    ...(config.hosted ? ['hosted (live AI switch, allowance and message length checked before each turn)'] : []),
    ...(config.planDate ? [`plan date ${config.planDate}`] : []),
  ].join(' · ');
}
