/**
 * Puts the public site on Vercel in one go, and only ever uploads built files.
 *
 *   pnpm deploy:site                 # build, scan, then build and deploy with Vercel's CLI (production)
 *   pnpm deploy:site --check         # build and scan only: nothing leaves this machine
 *   pnpm deploy:site --scan <dir>    # scan a folder of built files, nothing else
 *
 * 1. A hosted build of the web app (VITE_GANTRY_HOSTED=1): the landing page at /, the app at /app.
 * 2. A scan of every built file, which stops on any hit: API keys (Anthropic, OpenAI, ElevenLabs, LiveKit, PayPal),
 *    Supabase service-role keys, private keys, paths from this machine (home folders, private/, .dev-data), the demo
 *    passwords in apps/web/src/app/LoginScreen.tsx (read from that file now), and the value of every secret in the
 *    repo's env files.
 * 3. `vercel pull` (the project's settings and Production environment), `vercel build --prod` (vercel.json's install
 *    and build commands), the same scan over what that built (plus a check that it doesn't point at the local
 *    database), then `vercel deploy --prebuilt --prod`: only .vercel/output is uploaded.
 *
 * Once, before the first deploy:
 * - `npx vercel@latest login`, then `npx vercel@latest link` in the repo root. The project's root directory is the
 *   repo root; vercel.json sets the framework (none), the install and build commands and the output.
 * - In the project's Settings, Environment Variables, for Production: VITE_GANTRY_HOSTED=1, the app's other VITE_
 *   values (any the project lacks would be built in from the local .env.local), and the secrets the /api functions
 *   read.
 * - In the project's Analytics and Speed Insights tabs, enable both. Custom events (`track` in
 *   apps/web/src/analytics.ts) show in the dashboard on the Pro and Enterprise plans.
 * - Fill the placeholders in apps/web/src/site/site-config.ts; this script names any still left.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { placeholders } from '../apps/web/src/site/site-config.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const webDist = join(root, 'apps/web/dist');
const vercelOutput = join(root, '.vercel/output');
const vercel = ['--yes', 'vercel@latest'];

interface Rule {
  name: string;
  pattern: RegExp;
}

interface Hit {
  file: string;
  line: number;
  rule: string;
  sample: string;
}

/** What may never be in a public file. Patterns are global; each match is a hit. */
const RULES: Rule[] = [
  { name: 'Anthropic API key', pattern: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: 'OpenAI API key', pattern: /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}|\bsk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}\b/g },
  { name: 'ElevenLabs API key', pattern: /\bsk_[0-9a-f]{48}\b/g },
  // LiveKit keys are "API" and 12 letters and digits; secrets have no shape of their own (the env values cover them).
  { name: 'LiveKit API key', pattern: /\bAPI(?=[A-Za-z0-9]{0,11}[0-9])(?=[A-Za-z0-9]{0,11}[a-z])[A-Za-z0-9]{12}\b/g },
  { name: 'PayPal access token', pattern: /\bA21AA[A-Za-z0-9_-]{40,}/g },
  {
    name: 'secret set in code',
    pattern:
      /\b(?:ANTHROPIC_API_KEY|OPENAI_API_KEY|ELEVEN_LABS_API_KEY|LIVEKIT_API_KEY|LIVEKIT_API_SECRET|PAYPAL_CLIENT_SECRET|SUPABASE_SERVICE_ROLE_KEY)["'`]?\s*[:=]\s*["'`]?[A-Za-z0-9_.+/=-]{12,}/g,
  },
  { name: 'Supabase secret key', pattern: /\bsb_secret_[A-Za-z0-9_-]{16,}/g },
  { name: 'private key', pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/g },
  { name: 'path on this machine', pattern: /\/Users\//g },
  { name: 'the private folder', pattern: /(?<![\w.-])private\//g },
  { name: 'the .dev-data folder', pattern: /\.dev-data/g },
];

/** For what Vercel built: the hosted app must not point at the local Supabase stack. */
const LOCAL_DATABASE: Rule = { name: 'the local Supabase address', pattern: /(?:127\.0\.0\.1|localhost):5432\d/g };

const JWT = /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;

function fail(message: string): never {
  console.error(`\n${message}`);
  process.exit(1);
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): void {
  console.log(`\n$ ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit' });
  if (result.status !== 0) fail(`Stopped: \`${command} ${args.join(' ')}\` failed.`);
}

function files(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) found.push(...files(path));
    else found.push(path);
  }
  return found;
}

/** KEY=value lines of a dotenv file (quotes removed); nothing when it isn't there. */
function readEnv(path: string): Map<string, string> {
  const env = new Map<string, string>();
  if (!existsSync(path)) return env;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    let value = match[2]!;
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    env.set(match[1]!, value);
  }
  return env;
}

/** Every secret value in the repo's env files (and the one `vercel pull` writes): long values of secret-named keys. */
function secretValues(): string[] {
  const envFiles = readdirSync(root)
    .filter((name) => name.startsWith('.env') && name !== '.env.example')
    .map((name) => join(root, name));
  envFiles.push(join(root, '.vercel/.env.production.local'));
  const publicValues = new Set<string>();
  const secrets = new Set<string>();
  for (const file of envFiles) {
    for (const [key, value] of readEnv(file)) {
      if (key.startsWith('VITE_')) publicValues.add(value);
      else if (/KEY|SECRET|TOKEN|PASSWORD|PRIVATE/.test(key) && value.length >= 12) secrets.add(value);
    }
  }
  // A value the app is meant to show (a VITE_ one, such as the Supabase anon key) isn't a leak.
  return [...secrets].filter((value) => !publicValues.has(value));
}

/** The demo passwords, read from the sign-in screen as it is now. */
function demoPasswords(): string[] {
  const file = join(root, 'apps/web/src/app/LoginScreen.tsx');
  if (!existsSync(file)) return [];
  return [...readFileSync(file, 'utf8').matchAll(/password:\s*(['"`])([^'"`\n]+)\1/g)].map((match) => match[2]!);
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let at = text.indexOf('\n'); at !== -1 && at < index; at = text.indexOf('\n', at + 1)) line += 1;
  return line;
}

/** Shows what kind of thing matched without showing a secret: a key's prefix, or a short match such as a path. */
function redact(match: string): string {
  return match.length <= 12 ? match : `${match.slice(0, 6)}…(${match.length} characters)`;
}

function serviceRole(token: string): boolean {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as { role?: unknown };
    return payload.role === 'service_role' || payload.role === 'supabase_admin';
  } catch {
    return false;
  }
}

interface ScanOptions {
  rules: Rule[];
  literals: { name: string; values: string[] }[];
}

function scan(dir: string, { rules, literals }: ScanOptions): Hit[] {
  const hits: Hit[] = [];
  for (const file of files(dir)) {
    // latin1 keeps every byte, so binary files (models, images, fonts) are searched too.
    const text = readFileSync(file).toString('latin1');
    const at = (index: number, rule: string, sample: string) => hits.push({ file: relative(root, file), line: lineOf(text, index), rule, sample });
    for (const { name, pattern } of rules) {
      for (const match of text.matchAll(pattern)) at(match.index, name, redact(match[0]));
    }
    for (const match of text.matchAll(JWT)) {
      if (serviceRole(match[0])) at(match.index, 'Supabase service-role key', redact(match[0]));
    }
    // A known secret is never shown, only its length.
    for (const { name, values } of literals) {
      for (const value of values) {
        for (let index = text.indexOf(value); index !== -1; index = text.indexOf(value, index + value.length)) at(index, name, `(${value.length} characters)`);
      }
    }
  }
  return hits;
}

function scanOrStop(dir: string, label: string, extra: Rule[] = []): void {
  if (!existsSync(dir)) fail(`Stopped: ${relative(root, dir)} isn't there to scan.`);
  const passwords = demoPasswords();
  if (passwords.length === 0) console.warn('Note: no demo passwords found in apps/web/src/app/LoginScreen.tsx, so none were looked for.');
  const hits = scan(dir, {
    rules: [...RULES, ...extra],
    literals: [
      { name: 'a demo password from LoginScreen.tsx', values: passwords },
      { name: 'a secret from an env file', values: secretValues() },
    ],
  });
  const count = files(dir).length;
  if (hits.length === 0) {
    console.log(`\nScan of ${label}: ${count} files, nothing found.`);
    return;
  }
  console.error(`\nScan of ${label}: ${hits.length} ${hits.length === 1 ? 'hit' : 'hits'} in ${count} files.`);
  for (const hit of hits.slice(0, 50)) console.error(`  ${hit.file}:${hit.line}  ${hit.rule}  ${hit.sample}`);
  if (hits.length > 50) console.error(`  … and ${hits.length - 50} more`);
  fail('Stopped: nothing was deployed.');
}

function warnPlaceholders(): void {
  const left = placeholders();
  if (left.length > 0) console.warn(`\nNote: still placeholders in apps/web/src/site/site-config.ts: ${left.join(', ')}.`);
}

const args = process.argv.slice(2);

if (args[0] === '--scan') {
  if (!args[1]) fail('Usage: pnpm deploy:site --scan <folder>');
  scanOrStop(resolve(args[1]), args[1]);
  process.exit(0);
}

// 1. The hosted build, 2. its scan.
run('pnpm', ['--filter', '@collab/web', 'build'], { ...process.env, VITE_GANTRY_HOSTED: '1' });
if (!existsSync(join(webDist, 'app/index.html'))) fail('Stopped: the build has no app/index.html, so it isn’t laid out for hosting.');
scanOrStop(webDist, 'the hosted build (apps/web/dist)');
warnPlaceholders();
if (args.includes('--check')) {
  console.log('\nChecked. Nothing left this machine.');
  process.exit(0);
}

// 3. Vercel's own build of the same, its scan, and the upload of what it built.
if (!existsSync(join(root, '.vercel/project.json'))) {
  fail('This folder isn’t linked to a Vercel project yet: run `npx vercel@latest login`, then `npx vercel@latest link`.');
}
run('npx', [...vercel, 'pull', '--yes', '--environment=production']);
if (readEnv(join(root, '.vercel/.env.production.local')).get('VITE_GANTRY_HOSTED') !== '1') {
  fail('Stopped: the project’s Production environment has no VITE_GANTRY_HOSTED=1. Add it in the Vercel project’s settings.');
}
run('npx', [...vercel, 'build', '--prod']);
if (!existsSync(join(vercelOutput, 'static/app/index.html')) || !existsSync(join(vercelOutput, 'static/index.html'))) {
  fail('Stopped: Vercel’s build has no landing page and app/index.html under .vercel/output/static.');
}
scanOrStop(join(vercelOutput, 'static'), 'what Vercel built (.vercel/output/static)', [LOCAL_DATABASE]);
if (existsSync(join(vercelOutput, 'functions'))) {
  // Functions bundle their dependencies, whose code legitimately mentions key formats; check them for real secrets only.
  const hits = scan(join(vercelOutput, 'functions'), { rules: [], literals: [{ name: 'a secret from an env file', values: secretValues() }] });
  if (hits.length > 0) {
    for (const hit of hits) console.error(`  ${hit.file}:${hit.line}  ${hit.rule}  ${hit.sample}`);
    fail('Stopped: a secret is written into a function bundle. Nothing was deployed.');
  }
}
warnPlaceholders();
run('npx', [...vercel, 'deploy', '--prebuilt', '--prod']);
console.log('\nDeployed.');
