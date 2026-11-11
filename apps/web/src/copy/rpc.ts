/**
 * The visitor's session (a copy of Harbor Street Offices), as the database hands it out (callable by any signed-in
 * user, anonymous ones included; supabase/migrations/20261110120200_copy_pool.sql and
 * 20261111010000_session_codes_and_names.sql):
 *
 * - `claim_copy(p_name)` → `{ project_id, join_token, join_code, lease_until, display_name }`: the caller becomes the
 *   copy's `cm` member in seat 1. It raises a clear error when every copy is in use. A sign-in claims once, ever
 *   (opening the copy it holds again is no claim): another claim is refused with `PT403`, and a new session needs a
 *   new anonymous sign-in. A network that started one too lately, or holds too many, is refused with `PT429`, whose
 *   details say how long to wait (`{ retry_after, reason }`; 20261111040000_visitor_limits.sql).
 * - `join_copy(p_token, p_name)` → the same: the next free seat, as a `pm` member; five people at most.
 * - `join_copy_by_code(p_code, p_name)` → the same, or `{ error, message, tries_left }` for a code that matches no
 *   open session; too many wrong codes raise.
 * - `copy_names_taken(p_token)` → the names in use in that session (the anon key may ask, before signing in).
 * - `touch_copy(p_project)` → `{ lease_until, join_code }`: extends the 30-minute lease, up to 2 hours in all.
 * - `release_copy(p_project)`: resets the copy and frees it.
 * - `app_flags(key, enabled)`, readable by anyone: `live_ai`, `live_calls`, `live_payments`.
 *
 * A name asked for is a name from the list (names.ts); the database gives another free one when it is taken.
 * A function may answer with the object or with a one-row table; both are read the same.
 */
import { z } from 'zod';

export interface RpcErrorLike {
  message: string;
  code?: string;
  /** PostgREST's `details`: for a refusal that says when to try again, `{ retry_after, reason }` as JSON. */
  details?: string | null;
}

/** The slice of `SupabaseClient` the copy uses; small enough to fake in tests. */
export interface CopyClient {
  rpc(fn: string, args?: object): PromiseLike<{ data: unknown; error: RpcErrorLike | null }>;
  from(table: string): { select(columns: string): PromiseLike<{ data: unknown; error: RpcErrorLike | null }> };
}

export interface Copy {
  projectId: string;
  /** What an invite link carries; null when this browser doesn't know it. */
  joinToken: string | null;
  /** The session code, 6 digits; null when this browser doesn't know it. */
  code: string | null;
  /** When the copy is reset unless someone keeps it (ISO); null until known. */
  leaseUntil: string | null;
  /** The name this person has in it, from the list; null when this browser doesn't know it. */
  name?: string | null;
}

/** What touch_copy says: when the lease now ends, and the session's code. */
export interface Touch {
  leaseUntil: string | null;
  code: string | null;
}

export interface AppFlags {
  live_ai: boolean;
  live_calls: boolean;
  live_payments: boolean;
}

/** With no word from the database, everything live is off. */
export const FLAGS_OFF: AppFlags = { live_ai: false, live_calls: false, live_payments: false };

/** join_copy_by_code's code for a code that matches no session open now. */
export const NO_MATCH = 'no_match';

/**
 * A refusal from the database (`refused`: it answered, with a code), or a request that never got an answer (no code:
 * the network). The message is the server's own words.
 */
export class CopyError extends Error {
  readonly code: string;
  /** PostgREST's `details`, as the server sent them. */
  readonly details: string | null;

  constructor(message: string, code = '', details: string | null = null) {
    super(message);
    this.name = 'CopyError';
    this.code = code;
    this.details = details;
  }

  get refused(): boolean {
    return this.code !== '';
  }
}

/** Every session is in use: claim_copy's own words say so. */
export function isAllInUse(error: unknown): boolean {
  return error instanceof CopyError && error.refused && /\bin use\b|\bno (free|spare|available) (cop(y|ies)|sessions?)\b|\ball (the )?(copies|sessions)\b/i.test(error.message);
}

/** This sign-in has had its session (one per sign-in): the next one starts from a new sign-in. */
export function isSessionUsed(error: unknown): boolean {
  return error instanceof CopyError && error.code === 'PT403';
}

/** How long a refusal asks to wait, and why: for a session, 'gap', 'hour', 'day' or 'held' (see claim_copy). */
export interface Wait {
  seconds: number;
  reason: string | null;
}

/** A wait the server didn't say the length of. */
export const DEFAULT_WAIT_S = 60;

const WaitDetails = z.object({ retry_after: z.number().positive(), reason: z.string().min(1).nullish() });

/** A refusal that says when to try again (`PT429`): how long and why; null for any other error. */
export function waitOf(error: unknown): Wait | null {
  if (!(error instanceof CopyError) || error.code !== 'PT429') return null;
  let parsed: unknown = null;
  try {
    parsed = error.details ? JSON.parse(error.details) : null;
  } catch {
    parsed = null;
  }
  const details = WaitDetails.safeParse(parsed);
  if (!details.success) return { seconds: DEFAULT_WAIT_S, reason: null };
  return { seconds: Math.ceil(details.data.retry_after), reason: details.data.reason ?? null };
}

const timestamp = z.string().min(1);
const one = <T extends z.ZodType>(row: T) => z.union([row, z.array(row).min(1).transform((rows) => rows[0]!)]);

const SessionAnswer = one(
  z.object({
    project_id: z.string().min(1),
    join_token: z.string().min(1).nullish(),
    join_code: z.string().min(1).nullish(),
    lease_until: timestamp.nullish(),
    display_name: z.string().nullish(),
  }),
);
const CodeRefusal = z.object({ error: z.string().min(1), message: z.string().min(1), tries_left: z.number().nullish() });
const TouchAnswer = one(z.object({ lease_until: timestamp.nullish(), join_code: z.string().min(1).nullish() }))
  .or(timestamp.transform((lease_until) => ({ lease_until, join_code: null })))
  .or(z.null().transform(() => ({ lease_until: null, join_code: null })));
const Names = z.array(z.string()).nullable();

async function call(client: CopyClient, fn: string, args?: object): Promise<unknown> {
  const { data, error } = await client.rpc(fn, args);
  if (error) throw new CopyError(cleaned(error.message), error.code ?? '', error.details ?? null);
  return data;
}

/** A database error's words without the function's name in front ("claim_copy: …"). */
const cleaned = (message: string): string => message.replace(/^[a-z_]+:\s+/, '').trim() || 'The server refused.';

function read<T>(schema: z.ZodType<T>, data: unknown, fn: string): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new CopyError(`${fn} answered in a way this page doesn't read.`);
  return parsed.data;
}

/** A name to ask for, or nothing (the database then keeps the person's name, or gives a free one). */
const named = (name: string | null | undefined): { p_name?: string } => (name ? { p_name: name } : {});

function sessionOf(answer: z.infer<typeof SessionAnswer>, token: string | null = null): Copy {
  return {
    projectId: answer.project_id,
    joinToken: answer.join_token ?? token,
    code: answer.join_code ?? null,
    leaseUntil: answer.lease_until ?? null,
    name: answer.display_name ?? null,
  };
}

export async function claimCopy(client: CopyClient, name?: string | null): Promise<Copy> {
  return sessionOf(read(SessionAnswer, await call(client, 'claim_copy', name ? named(name) : undefined), 'claim_copy'));
}

/** Joins the session an invite link is for. */
export async function joinCopy(client: CopyClient, token: string, name?: string | null): Promise<Copy> {
  return sessionOf(read(SessionAnswer, await call(client, 'join_copy', { p_token: token, ...named(name) }), 'join_copy'), token);
}

/** Joins the session a code is for; a code that matches none throws a refusal in the server's words. */
export async function joinCopyByCode(client: CopyClient, code: string, name?: string | null): Promise<Copy> {
  const data = await call(client, 'join_copy_by_code', { p_code: code, ...named(name) });
  const refusal = CodeRefusal.safeParse(data);
  if (refusal.success) throw new CopyError(refusal.data.message, refusal.data.error);
  return sessionOf(read(SessionAnswer, data, 'join_copy_by_code'));
}

/** The names in use in the session an invite token is for; none when that can't be told. */
export async function namesTaken(client: CopyClient, token: string): Promise<string[]> {
  try {
    return read(Names, await call(client, 'copy_names_taken', { p_token: token }), 'copy_names_taken') ?? [];
  } catch {
    // Only a suggestion: the database gives a free name if this one turns out to be taken.
    return [];
  }
}

/** Keeps the copy: when its lease now ends, and its code. */
export async function touchCopy(client: CopyClient, projectId: string): Promise<Touch> {
  const answer = read(TouchAnswer, await call(client, 'touch_copy', { p_project: projectId }), 'touch_copy');
  return { leaseUntil: answer.lease_until ?? null, code: answer.join_code ?? null };
}

export async function releaseCopy(client: CopyClient, projectId: string): Promise<void> {
  await call(client, 'release_copy', { p_project: projectId });
}

const FlagRows = z.array(z.object({ key: z.string(), enabled: z.boolean().nullable() }));

/** What is live on the site now; anything the database doesn't say is off. */
export async function loadAppFlags(client: CopyClient): Promise<AppFlags> {
  const { data, error } = await client.from('app_flags').select('key, enabled');
  if (error) throw new CopyError(cleaned(error.message), error.code ?? '');
  const rows = read(FlagRows, data ?? [], 'app_flags');
  const on = new Set(rows.filter((row) => row.enabled === true).map((row) => row.key));
  return { live_ai: on.has('live_ai'), live_calls: on.has('live_calls'), live_payments: on.has('live_payments') };
}
