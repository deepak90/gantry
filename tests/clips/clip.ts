/**
 * The clip harness: records short instructional clips of the real app (`pnpm clips`, one spec per
 * clip in tests/clips/*.clip.ts) and writes them to apps/web/public/clips as `<id>.webm` (VP9) with a
 * `<id>.png` poster (the last frame), listed in clips.json for the assistant's how-to card.
 *
 * - A write-free sandbox: the tab behaves as if every change was saved, while nothing reaches the
 *   database or the other people in the plan. `submit_revision` is answered in the browser (the next
 *   revision number, the submitted changes with new ids for new records, as the server would); inserts
 *   into tables a clip names are answered too and merged into later reads of those tables, and so are
 *   the RPCs and Edge Functions it names (a function's answer is the clip's script, not a model's);
 *   every other write is blocked and listed, so a spec can assert there were none.
 * - Framing: a visible cursor and a click ripple drawn in the page, hover cards hidden (the dependency
 *   tooltip stays), a 16:9 crop anchored on elements.
 * - Capture: device-pixel screenshots of the crop in a loop that runs alongside the scripted input
 *   (headless screencast frames are CSS-sized), resampled to a constant frame rate and encoded with
 *   Playwright's bundled ffmpeg (or `FFMPEG`). A `Tape` instead records the whole window at 60 frames
 *   a second on the page's own clock, for apps/clip-studio to cut.
 */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type BrowserContext, type Locator, type Page, type Route } from '@playwright/test';
import { columnLayoutStorageKey, serializeColumnLayout, type ColumnLayout } from '../../apps/web/src/gantt/column-layout';
import { ClipManifest, ClipTape, HowToClip, type ClipRect } from '../../packages/shared/src/clips';
import { SEED_IDS } from '../../packages/shared/src/seed/index.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '../..');
export const CLIPS_DIR = process.env.CLIPS_OUT_DIR ?? join(REPO_ROOT, 'apps/web/public/clips');

export const PM = { email: process.env.E2E_PM_EMAIL ?? 'pm@demo.local', password: process.env.E2E_PM_PASSWORD ?? 'demo-pm-2026' };
export const CM = { email: process.env.E2E_CM_EMAIL ?? 'cm@demo.local', password: process.env.E2E_CM_PASSWORD ?? 'demo-cm-2026' };

const BOOT_MS = 90_000;
/** The local Supabase API (writes to anything else, e.g. the dev server, are not ours to guard). */
const API_PORT = process.env.CLIP_API_PORT ?? '54321';

// -----------------------------------------------------------------------------------------
// The write-free sandbox
// -----------------------------------------------------------------------------------------

type Row = Record<string, unknown>;

export interface SandboxOptions {
  /** Tables whose inserts are answered in the browser (the row as the server would return it). */
  tables?: Record<string, (body: Row) => Row>;
  /** RPCs answered in the browser: their arguments in, the response body out. */
  rpcs?: Record<string, (args: Row, sandbox: Sandbox) => unknown>;
  /** Edge Functions answered in the browser, by name: the request body in, the response body out. */
  functions?: Record<string, (body: Row, sandbox: Sandbox) => unknown>;
  /** RPCs that only read (let through). */
  readRpcs?: string[];
  /**
   * Rows the clip's scene needs that are not in the database (a conversation, say), added once the
   * project and the signed-in person are known; reads of their tables include them.
   */
  seed?: (ids: { projectId: string; userId: string }) => Record<string, Row[]>;
}

const NOT_FILTERS = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'columns', 'or', 'and']);

/** Whether a row passes a read's PostgREST filters (eq, neq, is, in; any other operator lets it through). */
export function matchesFilters(row: Row, params: URLSearchParams): boolean {
  for (const [key, raw] of params) {
    if (NOT_FILTERS.has(key)) continue;
    const dot = raw.indexOf('.');
    const op = raw.slice(0, dot);
    const value = raw.slice(dot + 1);
    const cell = row[key];
    const text = cell === null || cell === undefined ? null : String(cell);
    if (op === 'eq' && text !== value) return false;
    if (op === 'neq' && text === value) return false;
    if (op === 'is' && (value === 'null' ? cell !== null && cell !== undefined : String(cell) !== value)) return false;
    if (op === 'in') {
      const list = value.replace(/^\(|\)$/g, '').split(',').map((item) => item.replace(/^"|"$/g, ''));
      if (text === null || !list.includes(text)) return false;
    }
  }
  return true;
}

/** Rows in a read's `order` (first key) and within its `limit`. */
function ordered(rows: Row[], params: URLSearchParams): Row[] {
  const [column, direction] = (params.get('order') ?? '').split(',')[0]!.split('.');
  const out = column ? [...rows].sort((a, b) => String(a[column] ?? '').localeCompare(String(b[column] ?? '')) * (direction === 'desc' ? -1 : 1)) : rows;
  const limit = Number(params.get('limit') ?? NaN);
  return Number.isFinite(limit) ? out.slice(0, limit) : out;
}

export class Sandbox {
  /** Writes that were blocked: "METHOD /path". */
  readonly blocked: string[] = [];
  /** Revision numbers answered in the browser. */
  readonly revisions: number[] = [];
  /** Rows inserted in the browser, by table. */
  readonly rows = new Map<string, Row[]>();
  /** RPC and Edge Function calls answered in the browser, by name. */
  readonly calls: { fn: string; args: Row }[] = [];
  current = 0;
  /** The project and the signed-in person (read from load_project and the sign-in). */
  projectId: string | null = null;
  userId: string | null = null;
  private nextId = 9_000_000;

  /** Keeps a row written in the browser, so later reads of its table include it; returns it. */
  addRow(table: string, row: Row): Row {
    this.rows.set(table, [...(this.rows.get(table) ?? []), row]);
    return row;
  }
  private readonly phantoms = new Map<string, number>();

  /** Real ids for the phantom ids of added records, everywhere they are used (as replace_phantom_ids does). */
  numberChanges(changes: unknown): unknown {
    const stores = changes && typeof changes === 'object' ? Object.values(changes as Record<string, Row>) : [];
    for (const store of stores) {
      const input = (store?.$input ?? {}) as Row;
      for (const added of [store?.added, input.added]) {
        for (const record of Array.isArray(added) ? (added as Row[]) : []) {
          const phantom = record?.$PhantomId;
          if (typeof phantom === 'string' && !this.phantoms.has(phantom)) this.phantoms.set(phantom, this.nextId++);
        }
      }
    }
    const replace = (value: unknown): unknown => {
      if (typeof value === 'string') return this.phantoms.get(value) ?? value;
      if (Array.isArray(value)) return value.map(replace);
      if (value && typeof value === 'object') {
        const out: Row = {};
        for (const [key, item] of Object.entries(value as Row)) out[key] = key === '$PhantomId' ? item : replace(item);
        const phantom = (value as Row).$PhantomId;
        if (typeof phantom === 'string' && this.phantoms.has(phantom)) out.id = this.phantoms.get(phantom);
        return out;
      }
      return value;
    };
    return replace(changes);
  }
}

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

/**
 * Starts the sandbox for every page of the context. Register it before signing in (it reads the
 * current revision from load_project).
 */
export async function writeFreeSandbox(context: BrowserContext, options: SandboxOptions = {}): Promise<Sandbox> {
  const sandbox = new Sandbox();
  const tables = options.tables ?? {};
  const rpcs = options.rpcs ?? {};
  const functions = options.functions ?? {};
  const reads = new Set(['load_project', ...(options.readRpcs ?? [])]);
  let seeded = false;

  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    if (url.port !== API_PORT) return route.continue();
    const path = url.pathname;
    const write = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';

    if (!write) {
      if (!seeded && options.seed && sandbox.projectId && sandbox.userId) {
        seeded = true;
        for (const [table, rows] of Object.entries(options.seed({ projectId: sandbox.projectId, userId: sandbox.userId }))) for (const row of rows) sandbox.addRow(table, row);
      }
      const table = /^\/rest\/v1\/([a-z_]+)$/.exec(path)?.[1];
      const faked = (table ? sandbox.rows.get(table) : undefined)?.filter((row) => matchesFilters(row, url.searchParams));
      if (method !== 'GET' || !faked?.length) return route.continue();
      // Reads of a table the clip wrote to: the server's rows plus the ones answered in the browser.
      const response = await route.fetch();
      const body = (await response.json()) as unknown;
      return route.fulfill({ response, json: Array.isArray(body) ? ordered([...(body as Row[]), ...faked], url.searchParams) : body });
    }

    // Signing in (the person's id is read from it), and the tab's own session row (written once at boot).
    if (path === '/auth/v1/token') {
      const response = await route.fetch();
      const body = (await response.json()) as { user?: { id?: string } };
      if (body.user?.id) sandbox.userId = body.user.id;
      return route.fulfill({ response, json: body });
    }
    if (path.startsWith('/auth/v1/') || path === '/rest/v1/sessions') return route.continue();

    const fn = /^\/rest\/v1\/rpc\/([a-z_]+)$/.exec(path)?.[1];
    if (fn === 'load_project') {
      const project = (JSON.parse(request.postData() ?? '{}') as Row).p_project;
      if (typeof project === 'string') sandbox.projectId = project;
      const response = await route.fetch();
      const body = (await response.json()) as Row | Row[];
      const row = (Array.isArray(body) ? body[0] : body) as Row | undefined;
      if (typeof row?.current_revision === 'number') sandbox.current = row.current_revision;
      return route.fulfill({ response, json: body });
    }
    if (fn === 'submit_revision') {
      const args = JSON.parse(request.postData() ?? '{}') as Row;
      sandbox.current += 1;
      sandbox.revisions.push(sandbox.current);
      return json(route, {
        id: randomUUID(),
        project_id: args.p_project,
        revision_no: sandbox.current,
        client_id: args.p_client_id,
        local_revision_id: args.p_local_revision_id,
        conflict_resolution_for: args.p_conflict_for ?? null,
        changes: sandbox.numberChanges(args.p_changes),
        actor_user_id: null,
        origin: args.p_origin ?? 'human',
        created_at: new Date().toISOString(),
      });
    }
    if (fn && rpcs[fn]) {
      const args = JSON.parse(request.postData() ?? '{}') as Row;
      sandbox.calls.push({ fn, args });
      return json(route, rpcs[fn]!(args, sandbox));
    }
    if (fn && reads.has(fn)) return route.continue();

    const edge = /^\/functions\/v1\/([a-z0-9-]+)$/.exec(path)?.[1];
    if (method === 'POST' && edge && functions[edge]) {
      const body = JSON.parse(request.postData() ?? '{}') as Row;
      sandbox.calls.push({ fn: edge, args: body });
      return json(route, functions[edge]!(body, sandbox));
    }

    const table = /^\/rest\/v1\/([a-z_]+)$/.exec(path)?.[1];
    if (method === 'POST' && table && tables[table]) {
      const body = JSON.parse(request.postData() ?? '{}') as Row | Row[];
      const rows = (Array.isArray(body) ? body : [body]).map((item) => sandbox.addRow(table, tables[table]!(item)));
      const single = (request.headers().accept ?? '').includes('vnd.pgrst.object');
      return json(route, single ? rows[0] : rows, 201);
    }

    sandbox.blocked.push(`${method} ${path}`);
    return route.abort('blockedbyclient');
  });
  return sandbox;
}

/** A row's timestamps and id as the database would fill them in. */
export function inserted(body: Row, extra: Row = {}): Row {
  const now = new Date().toISOString();
  return { id: randomUUID(), created_at: now, updated_at: now, ...body, ...extra };
}

// -----------------------------------------------------------------------------------------
// Signing in, and what the clip draws on top of the page
// -----------------------------------------------------------------------------------------

/** A visible cursor and a click ripple drawn in the page (so every frame carries them); hover cards hidden. */
export async function clipOverlay(context: BrowserContext, { hide = [] as string[], cursor: drawn = true } = {}): Promise<void> {
  // A tape leaves the cursor and the click ripple to the clip studio, which draws them over the frames.
  if (!drawn) hide = [...hide, '#clip-cursor', '.clip-ripple'];
  await context.addInitScript((hidden: string[]) => {
    addEventListener('DOMContentLoaded', () => {
      const style = document.createElement('style');
      style.textContent = `
        #clip-cursor{position:fixed;left:0;top:0;width:22px;height:22px;z-index:2147483647;pointer-events:none;transform:translate(-3px,-2px)}
        #clip-cursor svg{filter:drop-shadow(0 1px 2px rgb(0 0 0 / .35))}
        .clip-ripple{position:fixed;width:36px;height:36px;margin:-18px 0 0 -18px;border-radius:50%;border:2.5px solid var(--accent, #2f5bd3);z-index:2147483646;pointer-events:none;animation:clip-ripple .5s ease-out forwards}
        @keyframes clip-ripple{from{transform:scale(.3);opacity:1}to{transform:scale(1.4);opacity:0}}
        .look-tooltip:not(.look-dep-tooltip),[data-testid="alert-toasts"]${hidden.map((selector) => `,${selector}`).join('')}{display:none!important}`;
      document.head.append(style);
      const cursor = document.createElement('div');
      cursor.id = 'clip-cursor';
      cursor.innerHTML =
        '<svg width="22" height="22" viewBox="0 0 22 22"><path d="M3 2 L3 18 L7.5 14 L10.5 20.5 L13.5 19 L10.5 12.8 L16.5 12.8 Z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
      cursor.style.display = 'none';
      document.body.append(cursor);
      const place = (event: MouseEvent) => {
        cursor.style.display = '';
        cursor.style.left = `${event.clientX}px`;
        cursor.style.top = `${event.clientY}px`;
      };
      addEventListener('pointermove', place, true);
      addEventListener('mousemove', place, true);
      addEventListener(
        'pointerdown',
        (event) => {
          const ripple = document.createElement('div');
          ripple.className = 'clip-ripple';
          ripple.style.left = `${event.clientX}px`;
          ripple.style.top = `${event.clientY}px`;
          document.body.append(ripple);
          setTimeout(() => ripple.remove(), 600);
        },
        true,
      );
    });
  }, hide);
}

/**
 * The grid's columns in the clip, as if the viewer had picked them: whoever signs in finds this
 * column layout in the browser (unless they stored one of their own).
 */
export async function clipColumns(context: BrowserContext, layout: Partial<ColumnLayout> & Pick<ColumnLayout, 'visible'>): Promise<void> {
  const prefix = columnLayoutStorageKey('*').slice(0, -1);
  const stored = serializeColumnLayout({ widths: {}, titles: {}, aligns: {}, ...layout });
  await context.addInitScript(
    ({ prefix: keyPrefix, stored: value }) => {
      const getItem = Storage.prototype.getItem;
      Storage.prototype.getItem = function (this: Storage, key: string) {
        const found = getItem.call(this, key);
        return found === null && key.startsWith(keyPrefix) ? value : found;
      };
    },
    { prefix, stored },
  );
}

/** Signs in on the project every clip is written for, Riverside Clinic (reached by its link; the app opens Harbor by default). */
export async function signIn(page: Page, who: { email: string; password: string } = PM): Promise<void> {
  await page.goto(`/?project=${SEED_IDS.project}`);
  await page.locator('input[name="email"]').fill(who.email);
  await page.locator('input[name="password"]').fill(who.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('sync-badge')).toHaveAttribute('data-sync-status', 'synced', { timeout: BOOT_MS });
  await page.locator('.b-gantt .b-gantt-task-wrap').first().waitFor({ timeout: BOOT_MS });
  // Decorations, presence and the watch list settle in the first seconds.
  await page.waitForTimeout(1_500);
}

/** Opens a tab of the side panel (no-op when it is open), or closes the panel with `null`. */
export async function openTab(page: Page, id: string | null): Promise<void> {
  if (id === null) {
    const open = page.locator('.inspector-tab.is-active');
    if ((await open.count()) > 0) await open.first().click();
    return;
  }
  const tab = page.getByTestId(`inspector-tab-${id}`);
  if ((await tab.getAttribute('aria-pressed')) !== 'true') await tab.click();
  await expect(tab).toHaveAttribute('aria-pressed', 'true');
}

// -----------------------------------------------------------------------------------------
// Pointer moves that read on video
// -----------------------------------------------------------------------------------------

export interface Point {
  x: number;
  y: number;
}

/** Moves the mouse in small steps (so the cursor glides on the clip). */
export async function glide(page: Page, to: Point, steps = 25): Promise<void> {
  const tape = tapes.get(page);
  if (tape) return tape.glide(to);
  await page.mouse.move(to.x, to.y, { steps });
}

export function center(box: { x: number; y: number; width: number; height: number }): Point {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Glides to an element and clicks it with the mouse (no keyboard: synthetic keys can stick on the Gantt). */
export async function clickOn(page: Page, target: Locator, { steps = 20, pause = 250, button = 'left' as 'left' | 'right', at }: { steps?: number; pause?: number; button?: 'left' | 'right'; at?: Point } = {}): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (!box) throw new Error(`Nothing to click: ${target}`);
  const point = at ? { x: box.x + at.x, y: box.y + at.y } : center(box);
  await glide(page, point, steps);
  await page.waitForTimeout(pause);
  await page.mouse.click(point.x, point.y, { button });
}

// -----------------------------------------------------------------------------------------
// Framing and capture
// -----------------------------------------------------------------------------------------

/** A 16:9 region of the page in CSS pixels. */
export interface Crop {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The smallest 16:9 region (at least `minWidth` wide) that holds every box with `pad` around it,
 * centered on them and kept inside the viewport. Widths are multiples of 32, so device pixels stay whole.
 */
export function cropAround(
  page: Page,
  boxes: { x: number; y: number; width: number; height: number }[],
  { pad = 24, minWidth = 640, within }: { pad?: number; minWidth?: number; within?: { x: number; y: number; width: number; height: number } } = {},
): Crop {
  const viewport = page.viewportSize() ?? { width: 1600, height: 1000 };
  const area = within ?? { x: 0, y: 0, width: viewport.width, height: viewport.height };
  const left = Math.min(...boxes.map((box) => box.x)) - pad;
  const top = Math.min(...boxes.map((box) => box.y)) - pad;
  const right = Math.max(...boxes.map((box) => box.x + box.width)) + pad;
  const bottom = Math.max(...boxes.map((box) => box.y + box.height)) + pad;
  let width = Math.max(minWidth, right - left, ((bottom - top) * 16) / 9);
  width = Math.min(Math.ceil(width / 32) * 32, Math.floor(area.width / 32) * 32, Math.floor((area.height * 16) / 9 / 32) * 32);
  const height = (width * 9) / 16;
  const x = Math.round(Math.min(Math.max(area.x, (left + right) / 2 - width / 2), area.x + area.width - width));
  const y = Math.round(Math.min(Math.max(area.y, (top + bottom) / 2 - height / 2), area.y + area.height - height));
  return { x, y, width, height };
}

/** The box of an element, or an error naming it. */
export async function boxOf(target: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await target.boundingBox();
  if (!box) throw new Error(`Not on screen: ${target}`);
  return box;
}

export interface Frame {
  jpeg: Buffer;
  /** Milliseconds since the recording started. */
  t: number;
}

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/**
 * Device-pixel screenshots of the crop, as fast as the browser gives them, until `stop`. The crop can
 * pan to another region of the same size while recording (`panTo`), like a camera following the action.
 */
export class Recorder {
  private readonly frames: Frame[] = [];
  private running = false;
  private loop: Promise<void> | null = null;
  private pan: { from: Crop; to: Crop; start: number; ms: number } | null = null;

  constructor(
    private readonly page: Page,
    private crop: Crop,
  ) {}

  /** The crop now (part-way through a pan, or where the last pan ended). */
  private current(): Crop {
    if (!this.pan) return this.crop;
    const progress = Math.min(1, (performance.now() - this.pan.start) / this.pan.ms);
    const { from, to } = this.pan;
    const at = easeInOut(progress);
    const crop = { x: Math.round(from.x + (to.x - from.x) * at), y: Math.round(from.y + (to.y - from.y) * at), width: to.width, height: to.height };
    if (progress >= 1) {
      this.crop = to;
      this.pan = null;
    }
    return crop;
  }

  start(): this {
    this.running = true;
    const started = performance.now();
    this.loop = (async () => {
      while (this.running) {
        const asked = performance.now();
        const jpeg = await this.page.screenshot({ clip: this.current(), type: 'jpeg', quality: 90, caret: 'initial' });
        this.frames.push({ jpeg, t: (asked + performance.now()) / 2 - started });
      }
    })();
    return this;
  }

  /** Moves the crop to `to` (same size) over `ms`, eased; resolves when it is there. */
  async panTo(to: Crop, ms = 700): Promise<void> {
    if (to.width !== this.crop.width || to.height !== this.crop.height) throw new Error('A pan keeps the size of the crop');
    this.pan = { from: this.current(), to, start: performance.now(), ms };
    await this.page.waitForTimeout(ms);
  }

  /** Stops capturing; returns the frames and a lossless PNG of the final state (the poster). */
  async stop(): Promise<{ frames: Frame[]; poster: Buffer }> {
    this.running = false;
    await this.loop;
    if (this.pan) this.crop = this.pan.to;
    this.pan = null;
    const poster = await this.page.screenshot({ clip: this.crop, type: 'png', caret: 'initial' });
    return { frames: this.frames, poster };
  }
}

// -----------------------------------------------------------------------------------------
// The tape: the whole window, for the clip studio's camera
// -----------------------------------------------------------------------------------------

/** Where tapes are written (gitignored): a folder per clip with its frames and tape.json. */
export const TAPES_DIR = process.env.CLIP_TAPES_DIR ?? join(REPO_ROOT, 'test-results/tapes');

/** Frames a second on a tape: the page's clock moves 1/60 s from one frame to the next. */
export const TAPE_FPS = 60;
const STEP_MS = 1000 / TAPE_FPS;

type Target = Locator | ClipRect;

const isLocator = (target: Target): target is Locator => typeof (target as Locator).boundingBox === 'function';

function unionOf(boxes: readonly ClipRect[]): ClipRect {
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Minimum jerk: how a hand moves from rest to rest. */
const handEase = (t: number) => t * t * t * (10 - 15 * t + 6 * t * t);

const tapes = new WeakMap<Page, Tape>();

/**
 * Runs in the page after each step of its clock: CSS transitions and animations (any Web Animation
 * on the document's timeline) are held at the time they have run on that clock, since the clock
 * moves them no more than it moves timers. One seen for the first time is paused where it is, at
 * most a step in (it began since the last frame); one that reaches its end is finished, so its end
 * events fire. `adopt` keeps the progress of those already running; `release` lets them all play on.
 */
function animationsOnTapeClock({ step, adopt = false, release = false }: { step: number; adopt?: boolean; release?: boolean }): void {
  const scope = window as unknown as { __tapeAnimations?: { started: WeakMap<Animation, number>; ended: WeakSet<Animation> } };
  const held = (scope.__tapeAnimations ??= { started: new WeakMap(), ended: new WeakSet() });
  const now = performance.now();
  for (const animation of document.getAnimations()) {
    if (animation.timeline !== document.timeline || held.ended.has(animation) || animation.playState === 'idle') continue;
    let started = held.started.get(animation);
    if (release) {
      if (started !== undefined) animation.play();
      continue;
    }
    if (started === undefined) {
      const ran = Number(animation.currentTime ?? 0);
      started = now - (adopt ? ran : Math.min(ran, step));
      held.started.set(animation, started);
      animation.pause();
    }
    const end = animation.effect?.getComputedTiming().endTime;
    if (typeof end === 'number' && Number.isFinite(end) && now - started >= end) {
      animation.finish();
      held.ended.add(animation);
    } else animation.currentTime = now - started;
  }
  if (release) delete scope.__tapeAnimations;
}

/**
 * Records the whole window at device pixels, with every move, press and release of the pointer and
 * where the camera should look, for apps/clip-studio to cut into a clip: the zooms and pans, the
 * cursor and the step captions are drawn there.
 *
 * The page runs on the tape's clock, not in real time: its clock (timers, animation frames, `Date`,
 * `performance.now`) stops when the tape starts and moves on 1/60 s between screenshots, and its CSS
 * transitions and animations are held to the same time, so every frame is a true 60th of a second
 * however long a screenshot takes (a pop-up fading in takes the frames it should). Recording takes
 * about four times as long as the clip. Waits
 * (`page.waitForTimeout`) and pointer moves count tape time: `glide` (and so `clickOn`) moves the
 * pointer a step every frame along a slightly curved path at a hand's pace. The clock has to be the
 * tape's before the page loads: call `Tape.prepare` before signing in.
 */
export class Tape {
  private readonly frames: ClipTape['frames'] = [];
  /** Frame files by content: frames that look the same share one. */
  private readonly files = new Map<string, string>();
  private readonly pointer: ClipTape['pointer'] = [];
  private readonly looks: ClipTape['looks'] = [];
  private readonly steps: ClipTape['steps'] = [];
  /** Run before each frame with its time until they return true: what moves the pointer frame by frame. */
  private readonly hooks = new Set<{ fn: (t: number) => Promise<boolean>; resolve: () => void; reject: (error: unknown) => void }>();
  private waiters: { at: number; resolve: () => void; reject: (error: unknown) => void }[] = [];
  private readonly dir: string;
  /** Steps the clock has moved: the last frame was taken at `ticks` × STEP_MS. */
  private ticks = 0;
  private running = false;
  private failure: unknown = null;
  private loop: Promise<void> | null = null;
  private at: Point = { x: 0, y: 0 };
  private pressed = false;
  private restore: (() => void) | null = null;

  /** Puts the clock of every page in `context` under the tapes' control (it runs as usual until a tape starts). */
  static async prepare(context: BrowserContext): Promise<void> {
    await context.clock.install();
  }

  constructor(
    private readonly page: Page,
    private readonly meta: ClipMeta,
  ) {
    this.dir = join(TAPES_DIR, meta.id);
  }

  /** Tape time, in ms: the moment of the next frame (what happens now shows first there). */
  now(): number {
    return (this.ticks + 1) * STEP_MS;
  }

  private mark(x: number, y: number): void {
    this.at = { x, y };
    this.pointer.push({ t: this.now(), x, y, down: this.pressed });
  }

  /** Resolves once `ms` of tape time have been recorded. */
  wait(ms: number): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => this.waiters.push({ at: this.ticks * STEP_MS + ms, resolve, reject }));
  }

  /** Calls `fn` before every frame with that frame's time until it returns true. */
  private everyFrame(fn: (t: number) => Promise<boolean>): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => this.hooks.add({ fn, resolve, reject }));
  }

  /** Starts recording with the pointer at `pointer` (the middle of the window by default). */
  async start(pointer?: Point): Promise<this> {
    const viewport = this.page.viewportSize()!;
    rmSync(this.dir, { recursive: true, force: true });
    mkdirSync(join(this.dir, 'frames'), { recursive: true });
    const mouse = this.page.mouse;
    const original = { move: mouse.move.bind(mouse), down: mouse.down.bind(mouse), up: mouse.up.bind(mouse), click: mouse.click.bind(mouse) };
    const waitForTimeout = this.page.waitForTimeout.bind(this.page);
    const from = pointer ?? { x: viewport.width / 2, y: viewport.height / 2 };
    await original.move(from.x, from.y);
    mouse.move = async (x, y, options) => {
      await original.move(x, y, options);
      this.mark(x, y);
    };
    mouse.down = async (options) => {
      await original.down(options);
      this.pressed = true;
      this.mark(this.at.x, this.at.y);
    };
    mouse.up = async (options) => {
      await original.up(options);
      this.pressed = false;
      this.mark(this.at.x, this.at.y);
    };
    mouse.click = async (x, y, options) => {
      await mouse.move(x, y);
      await mouse.down(options);
      await this.wait(options?.delay ?? 70);
      await mouse.up(options);
    };
    this.page.waitForTimeout = (ms) => this.wait(ms);
    this.restore = () => {
      Object.assign(mouse, original);
      this.page.waitForTimeout = waitForTimeout;
    };
    tapes.set(this.page, this);
    // The page's clock stops here (a moment ahead of where it is); from now on it moves a frame at a time.
    await this.page.clock.pauseAt((await this.page.evaluate(() => Date.now())) + 50);
    await this.page.evaluate(animationsOnTapeClock, { step: STEP_MS, adopt: true });
    this.at = from;
    this.pointer.push({ t: 0, x: from.x, y: from.y, down: false });
    this.running = true;
    this.loop = this.record().catch((error: unknown) => {
      this.failure = error;
      for (const waiter of [...this.waiters, ...this.hooks]) waiter.reject(error);
      this.waiters = [];
      this.hooks.clear();
      throw error;
    });
    return this;
  }

  /** Screenshot, then the clock a step on, until stopped. */
  private async record(): Promise<void> {
    try {
      while (this.running) {
        const t = this.ticks * STEP_MS;
        // Device pixels, so the camera can close in (about 60 ms a frame, however long the clip waits).
        const jpeg = await this.page.screenshot({ type: 'jpeg', quality: 92, caret: 'initial' });
        this.keep(jpeg, t);
        this.waiters = this.waiters.filter((waiter) => {
          if (waiter.at > t) return true;
          waiter.resolve();
          return false;
        });
        for (const hook of [...this.hooks]) {
          try {
            if (!(await hook.fn(t + STEP_MS))) continue;
            this.hooks.delete(hook);
            hook.resolve();
          } catch (error) {
            this.hooks.delete(hook);
            hook.reject(error);
          }
        }
        await this.page.clock.runFor(Math.round(t + STEP_MS) - Math.round(t));
        this.ticks++;
        await this.page.evaluate(animationsOnTapeClock, { step: STEP_MS });
      }
    } catch (error) {
      // The test failed and closed the page before the tape stopped: its own error is the one to see.
      if (!this.page.isClosed()) throw error;
    }
  }

  private keep(jpeg: Buffer, t: number): void {
    const hash = createHash('sha1').update(jpeg).digest('hex');
    let file = this.files.get(hash);
    if (!file) {
      file = `frames/${String(this.files.size).padStart(5, '0')}.jpg`;
      writeFileSync(join(this.dir, file), jpeg);
      this.files.set(hash, file);
    }
    this.frames.push({ file, t });
  }

  /** Moves the pointer to `to` like a hand: eased, a little curved, slower over longer ways. */
  async glide(to: Point): Promise<void> {
    const from = this.at;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const distance = Math.hypot(dx, dy);
    if (distance < 1) return;
    const ms = Math.min(1_100, Math.max(280, 240 + distance * 0.55));
    // The bow is to one side of the straight line, a few percent of the way.
    const bow = Math.min(40, distance * 0.06) * (dx >= 0 ? 1 : -1);
    let start: number | null = null;
    await this.everyFrame(async (t) => {
      start ??= t - STEP_MS;
      const progress = Math.min(1, (t - start) / ms);
      const along = handEase(progress);
      const side = Math.sin(Math.PI * progress) * bow;
      await this.page.mouse.move(from.x + dx * along - (dy / distance) * side, from.y + dy * along + (dx / distance) * side);
      return progress >= 1;
    });
  }

  /**
   * Points the camera at `targets` (their boxes together, `pad` around them; the whole window when
   * there are none) and, unless `wait` is false, waits `ms` while it gets there. `ring` marks them in
   * the shot until the next look (or marks other targets: one thing in a wider shot).
   */
  async look(targets: Target | readonly Target[] = [], { pad = 40, ms = 900, ring = false as boolean | Target | readonly Target[], wait = true } = {}): Promise<void> {
    const boxesOf = (some: Target | readonly Target[]) => Promise.all((Array.isArray(some) ? (some as readonly Target[]) : [some as Target]).map((target) => (isLocator(target) ? boxOf(target) : target)));
    const boxes = await boxesOf(targets);
    const viewport = this.page.viewportSize()!;
    const union = boxes.length > 0 ? unionOf(boxes) : null;
    const rect = union ? { x: union.x - pad, y: union.y - pad, width: union.width + pad * 2, height: union.height + pad * 2 } : { x: 0, y: 0, width: viewport.width, height: viewport.height };
    const marked = typeof ring === 'boolean' ? (ring ? union : null) : unionOf(await boxesOf(ring));
    this.looks.push({ t: this.now(), rect, ms, ring: marked });
    if (wait) await this.wait(ms);
  }

  /** Captions the clip's step `index` from now on. */
  step(index: number): void {
    const text = this.meta.steps[index];
    if (!text) throw new Error(`${this.meta.id} has no step ${index}`);
    this.steps.push({ t: this.now(), text });
  }

  /** Stops, gives the page its clock back, and writes tape.json to TAPES_DIR/<id> (the frames are there already). */
  async stop(): Promise<ClipTape> {
    this.running = false;
    await this.loop;
    this.restore?.();
    tapes.delete(this.page);
    await this.page.evaluate(animationsOnTapeClock, { step: STEP_MS, release: true });
    await this.page.clock.resume();
    const viewport = this.page.viewportSize()!;
    const scale = await this.page.evaluate(() => devicePixelRatio);
    const duration = this.frames.at(-1)!.t;
    const { id, title, summary, steps, topics } = this.meta;
    const tape = ClipTape.parse({ id, meta: { title, summary, steps, topics }, fps: TAPE_FPS, viewport: { ...viewport, scale }, duration_ms: duration, frames: this.frames, pointer: this.pointer, looks: this.looks, steps: this.steps });
    writeFileSync(join(this.dir, 'tape.json'), `${JSON.stringify(tape)}\n`);
    console.log(`${this.meta.id}: tape of ${(duration / 1000).toFixed(1)} s, ${this.frames.length} frames at ${TAPE_FPS} a second (${this.files.size} different), ${this.looks.length} looks, in ${this.dir}`);
    return tape;
  }
}

// -----------------------------------------------------------------------------------------
// Encoding
// -----------------------------------------------------------------------------------------

/** `FFMPEG`, else Playwright's bundled build (it encodes VP9 WebM; it has no GIF or H.264). */
export function findFfmpeg(): string {
  if (process.env.FFMPEG) return process.env.FFMPEG;
  const home = homedir();
  const caches = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    process.platform === 'darwin' ? join(home, 'Library', 'Caches', 'ms-playwright') : null,
    process.platform === 'win32' ? join(process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'ms-playwright') : join(home, '.cache', 'ms-playwright'),
  ].filter((dir): dir is string => Boolean(dir) && existsSync(dir!));
  const binary = process.platform === 'darwin' ? 'ffmpeg-mac' : process.platform === 'win32' ? 'ffmpeg-win64.exe' : 'ffmpeg-linux';
  for (const cache of caches) {
    const builds = readdirSync(cache)
      .filter((name) => name.startsWith('ffmpeg-'))
      .sort((a, b) => Number(b.slice(7)) - Number(a.slice(7)));
    for (const build of builds) {
      const candidate = join(cache, build, binary);
      if (existsSync(candidate)) return candidate;
    }
  }
  throw new Error('No ffmpeg: run `npx playwright install ffmpeg`, or set FFMPEG to an ffmpeg with libvpx-vp9.');
}

async function run(binary: string, args: string[], input: (stdin: NodeJS.WritableStream) => Promise<void>): Promise<void> {
  const child = spawn(binary, args, { stdio: ['pipe', 'ignore', 'pipe'] });
  let errors = '';
  child.stderr.on('data', (chunk: Buffer) => (errors += chunk.toString()));
  const done = new Promise<void>((resolveRun, reject) => {
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolveRun() : reject(new Error(`ffmpeg exited with ${code}: ${errors.trim()}`))));
  });
  await input(child.stdin);
  child.stdin.end();
  await done;
}

export interface EncodeOptions {
  fps?: number;
  /** Output width in pixels (height follows 16:9). */
  width?: number;
  /** VP9 quality: higher is smaller. */
  crf?: number;
  /** How long the last frame holds, in ms. */
  holdEnd?: number;
  /** Drop this many ms from the start of the capture. */
  trimStart?: number;
}

/** Frames resampled to a constant rate (the latest frame at each tick), the last one held. */
export function resample(frames: readonly Frame[], { fps = 25, holdEnd = 900, trimStart = 0 }: EncodeOptions = {}): Frame[] {
  if (frames.length === 0) return [];
  const out: Frame[] = [];
  const start = frames[0]!.t + trimStart;
  const end = frames.at(-1)!.t;
  let index = 0;
  for (let t = start; t <= end; t += 1000 / fps) {
    while (index + 1 < frames.length && frames[index + 1]!.t <= t) index++;
    out.push(frames[index]!);
  }
  for (let held = 0; held < Math.round((holdEnd / 1000) * fps); held++) out.push(frames.at(-1)!);
  return out;
}

/** Encodes the frames to a VP9 WebM; returns its duration in ms. */
export async function encodeWebm(frames: readonly Frame[], file: string, options: EncodeOptions = {}): Promise<number> {
  const fps = options.fps ?? 25;
  const width = options.width ?? 960;
  const sequence = resample(frames, options);
  if (sequence.length === 0) throw new Error('No frames to encode');
  mkdirSync(dirname(file), { recursive: true });
  // prettier-ignore
  const args = [
    '-y', '-loglevel', 'error',
    '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', 'pipe:0',
    '-vf', `scale=${width}:${Math.round((width * 9) / 16 / 2) * 2}:flags=lanczos`,
    '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', String(options.crf ?? 40), '-row-mt', '1', '-deadline', 'good', '-cpu-used', '2',
    // UI frames barely change: one keyframe for the whole clip keeps it small (it loops from the start).
    '-g', String(fps * 30), '-pix_fmt', 'yuv420p', '-an', file,
  ];
  await run(findFfmpeg(), args, async (stdin) => {
    for (const frame of sequence) {
      if (!stdin.write(frame.jpeg)) await new Promise((resolveDrain) => stdin.once('drain', resolveDrain));
    }
  });
  return Math.round((sequence.length / fps) * 1000);
}

/**
 * The poster: the final state, scaled in the browser with high-quality smoothing (the bundled ffmpeg
 * cannot read PNG) and written as PNG.
 */
export async function writePoster(page: Page, png: Buffer, file: string, width = 960): Promise<void> {
  const scratch = await page.context().browser()!.newPage();
  try {
    const data = await scratch.evaluate(
      async ({ source, width: outWidth }) => {
        const image = new Image();
        image.src = source;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = outWidth;
        canvas.height = Math.round((outWidth * image.naturalHeight) / image.naturalWidth);
        const context = canvas.getContext('2d')!;
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = 'high';
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL('image/png').split(',')[1]!;
      },
      { source: `data:image/png;base64,${png.toString('base64')}`, width },
    );
    writeFileSync(file, Buffer.from(data, 'base64'));
  } finally {
    await scratch.close();
  }
}

// -----------------------------------------------------------------------------------------
// The manifest
// -----------------------------------------------------------------------------------------

export type ClipMeta = Pick<HowToClip, 'id' | 'title' | 'summary' | 'steps' | 'topics'>;

const MANIFEST = () => join(CLIPS_DIR, 'clips.json');

export function readManifest(): ClipManifest {
  if (!existsSync(MANIFEST())) return { clips: [] };
  return ClipManifest.parse(JSON.parse(readFileSync(MANIFEST(), 'utf8')));
}

/** Adds or replaces one clip in clips.json (the others keep their place). */
export function updateManifest(clip: HowToClip): ClipManifest {
  const manifest = readManifest();
  const index = manifest.clips.findIndex((existing) => existing.id === clip.id);
  const clips = index === -1 ? [...manifest.clips, clip] : manifest.clips.map((existing, at) => (at === index ? clip : existing));
  const next = ClipManifest.parse({ clips });
  mkdirSync(CLIPS_DIR, { recursive: true });
  writeFileSync(MANIFEST(), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

/** Encodes a recording, writes the poster and the manifest entry; returns the entry. */
export async function saveClip(page: Page, meta: ClipMeta, recording: { frames: Frame[]; poster: Buffer }, options: EncodeOptions = {}): Promise<HowToClip> {
  const video = join(CLIPS_DIR, `${meta.id}.webm`);
  const poster = join(CLIPS_DIR, `${meta.id}.png`);
  const duration = await encodeWebm(recording.frames, video, options);
  await writePoster(page, recording.poster, poster, options.width ?? 960);
  const clip = HowToClip.parse({ ...meta, duration_ms: duration, bytes: statSync(video).size, recorded_at: new Date().toISOString() });
  updateManifest(clip);
  console.log(`${meta.id}: ${recording.frames.length} frames captured, ${(duration / 1000).toFixed(1)} s, webm ${Math.round(clip.bytes / 1024)} KB, poster ${Math.round(statSync(poster).size / 1024)} KB`);
  return clip;
}
