/**
 * Entry point: `pnpm agent:dev` (repo root) or `pnpm --filter @collab/agent dev`.
 * Reads the repo-root .env.local, connects with the service role, and watches every project.
 * On the hosted site (GANTRY_HOSTED=1, the Dockerfile's environment) it also checks the hosted limits before each turn,
 * holds turns to the hosted turn limits, records what each one cost in the day's spend ledger (hosted.ts) and answers
 * health checks on PORT.
 */
import { createClient } from '@supabase/supabase-js';
import { join } from 'node:path';
import { systemPromptFor } from './agent/prompts';
import { describeConfig, loadEnv, readConfig, readPayPalAccess } from './env';
import { startHealthServer } from './health';
import { admitFor, HOSTED_TURN_LIMITS, supabaseLimits, supabaseSpend } from './hosted';
import { makeClient } from './llm/client';
import { createLogger } from './log';
import { createPayPalReader } from './paypal/reader';
import { SupabaseStore } from './data/supabase-store';
import { SupabaseAgentTransport, type RealtimeClientLike } from './realtime/transport';
import { AgentService } from './service';
import { ServiceLock, type LockClient } from './realtime/lock';

loadEnv();
const config = readConfig();
const log = createLogger('agent');
if (!config.serviceRoleKey) {
  log.warn('SUPABASE_SERVICE_ROLE_KEY is missing in .env.local (copy it from `supabase status -o env`)');
  process.exit(1);
}
log.info(describeConfig(config));

const supabase = createClient(config.supabaseUrl, config.serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
  realtime: { params: { eventsPerSecond: 50 } },
});
const recordingDir = config.mode === 'replay' || process.env.AGENT_RECORD === '1' ? join(config.recordingsDir, 'service') : null;
const limits = config.hosted ? supabaseLimits(supabase) : null;
const spend = config.hosted ? supabaseSpend(supabase) : null;
// PayPal itself, read only, for check_with_paypal (src/paypal): with PAYPAL_MODE=live and the sandbox REST app's key only.
const paypalAccess = readPayPalAccess();
const paypal = paypalAccess.access ? createPayPalReader(paypalAccess.access) : null;
const service = new AgentService({
  store: new SupabaseStore(supabase, log, config.projectIds),
  transport: new SupabaseAgentTransport(supabase as unknown as RealtimeClientLike, log),
  client: makeClient(config.mode, { recordingDir }),
  paypal,
  spend,
  models: config.models,
  titleModel: config.titleModel,
  log,
  project: {
    openingDelayMs: config.openingDelayMs,
    raiseIssues: config.proactive === 'issues',
    ...(config.hosted || config.planDate ? { systemPrompt: systemPromptFor(config.hosted, config.planDate) } : {}),
    ...(config.hosted ? { limits: HOSTED_TURN_LIMITS } : {}),
    planDate: config.planDate,
    // Shared with Remy's call worker: her voice says only replies signed with it (realtime/line-signature.ts).
    lineSecret: process.env.REMY_LINE_SECRET?.trim() || null,
  },
  ...(limits ? { admitFor: (projectId: string) => admitFor(projectId, limits, createLogger(`agent ${projectId.slice(0, 8)}`)) } : {}),
});

/** Where the service stands, for the hosted health check. */
let stage: 'waiting for the lock' | 'answering' | 'failed to start' = 'waiting for the lock';
if (config.hosted) startHealthServer(Number(process.env.PORT) || 8080, () => ({ ok: stage !== 'failed to start', stage, projects: service.watching }), log);

new ServiceLock(supabase as unknown as LockClient, log, { mode: config.mode }).acquire(() => {
  service
    .start()
    .then(() => {
      stage = 'answering';
      log.info('ready: listening for people joining, plan changes, fix progress and messages');
    })
    .catch((error: unknown) => {
      log.warn('could not start', error);
      stage = 'failed to start';
      // Hosted, the host starts it again: better than staying up and answering nobody.
      if (config.hosted) setTimeout(() => process.exit(1), 1_000);
    });
});

const shutdown = async (signal: string) => {
  log.info(`${signal}: stopping`);
  // Leave the channels (so another instance can take over), but never hang on the way out.
  await Promise.race([service.stop().then(() => supabase.removeAllChannels()), new Promise((resolve) => setTimeout(resolve, 2_000))]);
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
