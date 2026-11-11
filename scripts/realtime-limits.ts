/**
 * Raises the local Realtime limits for a crowded demo (seven simulated people plus the real ones):
 * 1,000 messages and 1 MB a second, 500 joins a second, instead of the local defaults (100 messages
 * a second, which seven people moving pointers exceed). Local stack only: the Realtime container
 * re-creates its tenant with the defaults whenever it starts (`supabase start`, `pnpm db:reset`), so
 * `pnpm crowd` runs this first, every time. It goes through Realtime's own admin API, which
 * also drops the tenant from Realtime's cache, so open connections pick the limits up on rejoin.
 *
 *   node scripts/realtime-limits.ts
 */
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';

const LIMITS = { max_events_per_second: 1000, max_bytes_per_second: 1_000_000, max_joins_per_second: 500 };

const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8' }).trim();

let container: string | undefined;
try {
  container = docker('ps', '--format', '{{.Names}}')
    .split('\n')
    .find((name) => name.startsWith('supabase_realtime_'));
} catch {
  container = undefined;
}
if (!container) {
  console.warn('Realtime limits: no local Realtime container is running (is `supabase start` up?); nothing changed.');
  process.exit(0);
}

const secret = docker('exec', container, 'printenv', 'API_JWT_SECRET');
const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const unsigned = `${part({ alg: 'HS256', typ: 'JWT' })}.${part({ iat: now, exp: now + 120 })}`;
const token = `${unsigned}.${createHmac('sha256', secret).update(unsigned).digest('base64url')}`;

const response = docker(
  'exec',
  container,
  'curl',
  '-s',
  '-X',
  'PATCH',
  '-H',
  `Authorization: Bearer ${token}`,
  '-H',
  'Content-Type: application/json',
  '-d',
  JSON.stringify({ tenant: LIMITS }),
  'http://localhost:4000/api/tenants/realtime-dev',
);
let applied: Record<string, unknown> | null = null;
try {
  applied = (JSON.parse(response) as { data?: Record<string, unknown> }).data ?? null;
} catch {
  applied = null;
}
if (!applied || applied.max_events_per_second !== LIMITS.max_events_per_second) {
  console.error(`Realtime limits: the update was not accepted: ${response.slice(0, 300)}`);
  process.exit(1);
}
console.log(`Realtime limits: ${LIMITS.max_events_per_second} messages/s, ${LIMITS.max_bytes_per_second / 1_000_000} MB/s, ${LIMITS.max_joins_per_second} joins/s (local).`);
