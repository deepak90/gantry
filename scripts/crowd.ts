/**
 * `pnpm crowd`: a busy site office for the demo. Makes sure the simulated people exist (auth users with
 * their profiles, members of the project), opens the crowd page (apps/web/crowd.html) in a headless
 * browser, where each of them signs in and works in the project like anyone else, and keeps running
 * until Ctrl+C. Stopping winds the crowd down first: everything they moved is put back.
 *
 *   pnpm crowd [--project <uuid>] [--people <n>] [--headed] [--no-llm] [--minutes <m>]
 *              [--url http://localhost:5173] [--llm-every <minutes>] [--seed <n>] [--look-only]
 *              [--areas "<part>;<part>"] [--every <seconds>[-<seconds>]]
 *
 * --areas: one part of the plan per person, in order (a summary task's name or its WBS code): each
 * works only under theirs and puts back only their own changes, so anyone can tell what each one is
 * on. Without --people, one person per part. `pnpm crowd:harbor` is the film's: Marcus in Site and
 * foundations, Lena in Structure, one change every 20 to 35 seconds each.
 *
 * --every: seconds between one person's changes, one number or a range (10-15 when not given).
 *
 * --look-only: the people only look (pointers over the rows and bars, selections, the task panel opened
 * and read, a little scrolling) and never change anything: no revision is sent, nothing is put back on
 * stopping, the language model is not asked, and an earlier run's ledger is left as it is.
 *
 * Needs the local stack (`pnpm db:start`), the web dev server (`pnpm dev`) and the service role key in
 * .env.local. With ANTHROPIC_API_KEY set (and no --no-llm), Claude writes the people's intents, notes
 * and name tweaks from the project's real task names; the page checks every suggestion before use and
 * never sees the key. CROWD_MODEL picks the model.
 */
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { chromium, type Page } from '@playwright/test';
import { z } from 'zod';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CROWD_MEMBERSHIP, CROWD_PASSWORD, CROWD_PEOPLE } from '../packages/shared/src/crowd.ts';

// ---- options --------------------------------------------------------------------------------------

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const url = process.env.SUPABASE_URL?.trim().replace(/\/$/, '');
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
const webUrl = (option('url') ?? 'http://localhost:5173').replace(/\/$/, '');
/** One part of the plan per person, in order: "Site and foundations;Structure". */
const branches = (option('areas') ?? '')
  .split(';')
  .map((part) => part.trim())
  .filter(Boolean);
const count = Math.min(CROWD_PEOPLE.length, Math.max(1, Number(option('people') ?? (branches.length || CROWD_PEOPLE.length)) || CROWD_PEOPLE.length));
const pace = /^(\d+)(?:-(\d+))?$/.exec(option('every') ?? '');
/** Time between one person's changes; the crowd's own 10 to 15 seconds when not given. */
const cadenceMs = pace ? { min: Number(pace[1]) * 1000, max: Math.max(Number(pace[1]), Number(pace[2] ?? pace[1])) * 1000 } : undefined;
const minutes = option('minutes') ? Number(option('minutes')) : null;
const seed = option('seed') ? Number(option('seed')) : undefined;
const llmEveryMinutes = Number(option('llm-every') ?? 10) || 10;
/** They only look: nothing they do changes the plan (nor is anything said, so no language model either). */
const lookOnly = flag('look-only');
const apiKey = flag('no-llm') || lookOnly ? '' : (process.env.ANTHROPIC_API_KEY?.trim() ?? '');
const model = process.env.CROWD_MODEL?.trim() || 'claude-opus-5-5';

if (!url || !serviceKey) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env.local (values from `supabase status -o env`).');
  process.exit(1);
}
if (branches.length > count) {
  console.error(`--areas names ${branches.length} parts of the plan for ${count} people: one part per person.`);
  process.exit(1);
}
if (option('every') !== undefined && !cadenceMs) {
  console.error('--every takes seconds, one number or a range: --every 20 or --every 20-35.');
  process.exit(1);
}

const people = CROWD_PEOPLE.slice(0, count);
const admin = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(`${url}${path}`, { ...init, headers: { ...admin, ...(init.headers as Record<string, string> | undefined) } });
  } catch (error) {
    throw new Error(`Cannot reach Supabase at ${url}: ${error instanceof Error ? error.message : String(error)} (is \`pnpm db:start\` running?)`);
  }
}

async function must(response: Response, what: string): Promise<unknown> {
  if (!response.ok) throw new Error(`${what} failed (HTTP ${response.status}): ${await response.text()}`);
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

// ---- the people and their membership ----------------------------------------------------------------

/** Creates each simulated person's auth user if missing (or puts it back as it should be), and their profile. */
async function ensurePeople(): Promise<void> {
  for (const person of people) {
    const user = { email: person.email, password: CROWD_PASSWORD, email_confirm: true, user_metadata: { display_name: person.displayName, color: person.color } };
    const existing = await call(`/auth/v1/admin/users/${person.id}`);
    if (!existing.ok && existing.status !== 404) await must(existing, `Reading ${person.email}`);
    // Created in the meantime (a seed, another launcher): then it is updated instead.
    const created = existing.status === 404 ? await call('/auth/v1/admin/users', { method: 'POST', body: JSON.stringify({ id: person.id, ...user }) }) : null;
    if (!created?.ok) await must(await call(`/auth/v1/admin/users/${person.id}`, { method: 'PUT', body: JSON.stringify(user) }), `Saving ${person.email}`);
  }
  // The auth trigger creates profiles on first insert only; this keeps names and colors exact.
  await must(
    await call('/rest/v1/profiles?on_conflict=user_id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(people.map((person) => ({ user_id: person.id, display_name: person.displayName, color: person.color }))),
    }),
    'Saving profiles',
  );
}

async function resolveProject(): Promise<{ id: string; name: string }> {
  const wanted = option('project');
  const query = wanted ? `/rest/v1/projects?select=id,name&id=eq.${encodeURIComponent(wanted)}` : '/rest/v1/projects?select=id,name&order=created_at.asc&limit=1';
  const rows = (await must(await call(query), 'Reading projects')) as { id: string; name: string }[];
  const project = rows[0];
  if (!project) throw new Error(wanted ? `No project ${wanted}.` : 'No project in the database (run `pnpm db:reset`).');
  return project;
}

async function ensureMembership(projectId: string): Promise<void> {
  const rows = people.map((person) => ({ project_id: projectId, user_id: person.id, ...CROWD_MEMBERSHIP }));
  const path = '/rest/v1/project_members?on_conflict=project_id,user_id';
  const headers = { Prefer: 'resolution=merge-duplicates,return=minimal' };
  const response = await call(path, { method: 'POST', headers, body: JSON.stringify(rows) });
  if (response.ok) return;
  // A schema without the cost columns: the role is enough.
  const minimal = rows.map(({ project_id, user_id, role }) => ({ project_id, user_id, role }));
  await must(await call(path, { method: 'POST', headers, body: JSON.stringify(minimal) }), 'Adding the people to the project');
}

// ---- what the people say (Claude) ---------------------------------------------------------------------

const KINDS = ['rename', 'note', 'progress', 'move', 'resize', 'crew'] as const;

const SuggestionsSchema = z.object({
  people: z.array(
    z.object({
      id: z.string(),
      intents: z.array(z.object({ text: z.string(), taskIds: z.array(z.number()), kinds: z.array(z.enum(KINDS)) })),
      notes: z.array(z.object({ taskId: z.number(), text: z.string() })),
      renames: z.array(z.object({ taskId: z.number(), name: z.string() })),
    }),
  ),
});

const SYSTEM = [
  'You write the working chatter of simulated people in a construction project-management demo: what each person is busy with right now, the short notes they leave on tasks, and small wording tweaks they make to task names.',
  'It must read like a real site office: specific to the task, plain, brief, in each person’s professional voice, in US English with US construction terms. Use only the task ids given for that person. Name no people; crews may be named as given.',
].join(' ');

const INSTRUCTIONS = [
  'For every person below, write:',
  '- intents: 4 things they are doing for the next few minutes, each a short present-participle phrase without their name (for example "following up on the riser inspections"), under 70 characters, with 2 to 5 of their task ids it is about and the kinds of edit it involves (rename, note, progress, move, resize, crew).',
  '- notes: 6 notes on their tasks, one or two plain sentences under 160 characters each, about the work on that task: inspections, deliveries, crews, access, sign-offs, questions. Weekday names are fine; no calendar dates. Never say a date, duration or progress figure was changed: the notes sit beside the plan, they do not report edits to it.',
  '- renames: 3 small wording tweaks of their task names that keep the meaning and most of the words (a short clarifier, "&" spelled out, a more precise term), at most 25 characters longer than the original.',
].join('\n');

const anthropic = apiKey ? new Anthropic({ apiKey, maxRetries: 2, timeout: 120_000 }) : null;
const supportsFallback = /^claude-(opus-5|fable-5|sonnet-5-5)/.test(model);

async function suggest(request: unknown): Promise<unknown> {
  if (!anthropic) return null;
  const started = Date.now();
  try {
    const response = await anthropic.beta.messages.parse({
      model,
      max_tokens: 16_000,
      system: SYSTEM,
      messages: [{ role: 'user', content: `${INSTRUCTIONS}\n\n${JSON.stringify(request)}` }],
      output_config: { effort: 'low', format: betaZodOutputFormat(SuggestionsSchema) },
      ...(supportsFallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
    });
    if (response.stop_reason === 'refusal' || !response.parsed_output) {
      console.log(`[launcher] no suggestions (${response.stop_reason ?? 'unparsed'}); the people use canned text`);
      return null;
    }
    const byPerson = Object.fromEntries(response.parsed_output.people.map(({ id, ...rest }) => [id, rest]));
    console.log(`[launcher] ${model} wrote suggestions for ${Object.keys(byPerson).length} people in ${Math.round((Date.now() - started) / 1000)} s`);
    return { people: byPerson };
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) console.log('[launcher] the Anthropic key was refused; canned text it is');
    else if (error instanceof Anthropic.RateLimitError) console.log('[launcher] rate limited; canned text until the next round');
    else if (error instanceof Anthropic.APIError) console.log(`[launcher] suggestions failed (HTTP ${error.status}): ${error.message}`);
    else console.log(`[launcher] suggestions failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

// ---- the drift ledger, kept outside the page ---------------------------------------------------------------

/**
 * What the crowd has out of place, as the page last reported it. Kept here and on disk (ignored by git),
 * so a page reload or a crashed run still brings everything back on the next start.
 */
const CACHE = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '.cache', 'crowd');
const ledgerFile = (projectId: string) => join(CACHE, `ledger-${projectId}.json`);

function readLedger(projectId: string): unknown[] {
  try {
    const entries = JSON.parse(readFileSync(ledgerFile(projectId), 'utf8')) as unknown;
    return Array.isArray(entries) ? entries : [];
  } catch {
    return [];
  }
}

function writeLedger(projectId: string, entries: unknown[]): void {
  try {
    mkdirSync(CACHE, { recursive: true });
    writeFileSync(ledgerFile(projectId), JSON.stringify(entries, null, 1));
  } catch (error) {
    console.log(`[launcher] could not save the ledger: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ---- the page -------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  await ensurePeople();
  const project = await resolveProject();
  await ensureMembership(project.id);
  console.log(
    `[launcher] ${people.length} simulated people in ${project.name} (${project.id})` +
      (lookOnly ? '; look-only: they point, select and read, and change nothing' : anthropic ? `; ${model} writes what they say` : '; canned text (no Anthropic key or --no-llm)'),
  );
  if (branches.length) console.log(`[launcher] ${branches.map((branch, index) => `${people[index]!.displayName.split(' ')[0]} works in ${branch}`).join('; ')}`);
  if (cadenceMs) console.log(`[launcher] one change every ${cadenceMs.min / 1000}${cadenceMs.max > cadenceMs.min ? ` to ${cadenceMs.max / 1000}` : ''} seconds each`);
  if (people.length >= 4 && !/127\.0\.0\.1|localhost/.test(url ?? '')) {
    console.log(
      '[launcher] note: a hosted Realtime counts every delivery against the plan\'s message limit; with ' +
        `${people.length} people plus viewers, check the limit (locally, \`pnpm crowd\` raises it first).`,
    );
  }

  const page = `${webUrl}/crowd.html`;
  const reachable = await fetch(page).then((response) => response.ok, () => false);
  if (!reachable) {
    console.error(`The web app is not answering at ${page}: start it with \`pnpm dev\` (or pass --url).`);
    process.exit(1);
  }

  const browser = await chromium.launch({
    headless: !flag('headed'),
    // Ctrl+C is ours: the page must stay up while the crowd puts things back.
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
    // Keep the people's timers running at full speed when the window is hidden.
    args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const tab: Page = await context.newPage();
  let ledger = readLedger(project.id);
  if (ledger.length && lookOnly) {
    console.log(
      `[launcher] an earlier run's ledger lists ${ledger.length} change(s) that may still be out of place; look-only leaves them ` +
        '(a run without --look-only brings back any that are; a database reset already has)',
    );
  } else if (ledger.length) console.log(`[launcher] ${ledger.length} change(s) from an earlier run are still out of place; the crowd brings them back first`);
  await tab.exposeFunction('crowdLedger', (entries: unknown[]) => {
    // Look-only: nothing moves, and the earlier run's ledger is kept for a crowd that edits.
    if (lookOnly) return;
    ledger = Array.isArray(entries) ? entries : [];
    writeLedger(project.id, ledger);
  });
  await tab.exposeFunction('crowdConfig', () => ({
    ledger,
    projectId: project.id,
    people: people.map((person) => ({ id: person.id, email: person.email, password: CROWD_PASSWORD })),
    llm: Boolean(anthropic),
    seed,
    llmEveryMs: llmEveryMinutes * 60_000,
    lookOnly,
    branches,
    cadenceMs,
  }));
  await tab.exposeFunction('crowdSuggest', suggest);
  await tab.exposeFunction('crowdLog', (line: string) => console.log(line));
  // The database was reset under a running crowd: the people and their membership come back.
  // Several people may ask at once: one restore at a time.
  let ensuring: Promise<void> = Promise.resolve();
  await tab.exposeFunction('crowdEnsure', () => {
    ensuring = ensuring.then(async () => {
      try {
        await ensurePeople();
        await ensureMembership(project.id);
      } catch (error) {
        console.log(`[launcher] could not restore the people: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
    return ensuring;
  });
  // The page comes from the dev server but takes no hot reloads: a code change elsewhere in the repo
  // must not restart the people in the middle of their changes. (Restart the crowd to pick up changes.)
  await tab.routeWebSocket(/\/\?token=/, () => undefined);
  tab.on('pageerror', (error) => console.error(`[page] ${error.message}`));
  tab.on('console', (message) => {
    if (message.type() === 'error') console.error(`[page] ${message.text()}`);
  });
  await tab.goto(page);

  const report = setInterval(() => {
    void tab
      .evaluate(() => (window as unknown as { crowd?: { summary(): string } }).crowd?.summary() ?? '')
      .then((summary) => summary && console.log(`[launcher] ${summary}`))
      .catch(() => undefined);
  }, 30_000);

  let stopping = false;
  const stop = async (reason: string) => {
    if (stopping) {
      console.log('[launcher] stopping now, without putting things back');
      process.exit(1);
    }
    stopping = true;
    clearInterval(report);
    console.log(`[launcher] ${reason}: winding down${lookOnly ? ' (look-only: nothing to put back)' : ', putting back what the crowd moved…'}`);
    try {
      const left = await Promise.race([
        tab.evaluate((ms) => (window as unknown as { crowd?: { windDown(ms: number): Promise<string[]> } }).crowd?.windDown(ms) ?? Promise.resolve([]), 40_000),
        new Promise<string[]>((_, reject) => setTimeout(() => reject(new Error('timed out')), 60_000)),
      ]);
      if (left.length) console.log(`[launcher] still out of place:\n  ${left.join('\n  ')}`);
      else console.log(lookOnly ? '[launcher] nothing was changed' : '[launcher] everything is back where it was');
    } catch (error) {
      console.log(`[launcher] could not wind down: ${error instanceof Error ? error.message : String(error)}`);
    }
    await browser.close().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void stop('Ctrl+C'));
  process.on('SIGTERM', () => void stop('stopped'));
  if (minutes) setTimeout(() => void stop(`${minutes} minutes up`), minutes * 60_000);
  console.log(`[launcher] running${minutes ? ` for ${minutes} minutes` : ''}; Ctrl+C to stop`);
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
