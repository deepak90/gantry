/**
 * The call with Remy, as the page and Remy's call worker both read it: the room, who is who, what the
 * dev server's token route takes, and the messages on the call. Plain data and checks, no LiveKit, so the
 * dev server's route (call-dev.ts) uses it too.
 *
 * - One room per project (per visit of a copy on the hosted site: roomFor). A person's identity in it is their tab's
 *   presence session id, so their tile, cursor and edits are one identity. Remy joins as `remy`.
 * - Remy's worker sends JSON on topic `remy`, one flat `{ kind, ...body }` per message: `heard` (a final
 *   transcript, and whether it was said to Remy), `state`, `said` (a line it was handed has finished playing)
 *   and `filler`.
 * - The host's tab hands Remy a line to say with the RPC `remy.say`; it answers at once, and `said`
 *   follows when the line has been played.
 * - On a call with a time limit (the hosted site's), Remy's `remy.ends_at` attribute says when it ends.
 */

/** Remy's name for dispatch, and its identity in the room. */
export const REMY = 'remy';
/** The topic Remy's messages travel on. */
export const TOPIC = 'remy';
/** The RPC that hands Remy a line to say. */
export const SAY = 'remy.say';
/**
 * Remy's attribute with the moment her worker ends the call, in ms since the epoch by the worker's clock (the worker's
 * messages.ts sets it). Attributes reach late joiners too, so every tab counts down to the same moment. A call without
 * a time limit (the dev server's) has none.
 */
export const ENDS_AT = 'remy.ends_at';

/** When the call ends, from Remy's attributes (ms since the epoch, the worker's clock); null for a call without a limit. */
export function endsAtOf(attributes: Readonly<Record<string, string>> | undefined): number | null {
  const raw = attributes?.[ENDS_AT]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return null;
  const at = Number(raw);
  return Number.isSafeInteger(at) && at > 0 ? at : null;
}

/**
 * A project's call: `project-<id>` on this machine. On the hosted site a copy's call is the visit's own,
 * `project-<id>-<lease>` (when the copy was claimed, in ms), so whoever held the copy before can't stay on the next
 * visitor's call; the hosted token route knows the lease and mints for that room alone.
 */
export const roomFor = (projectId: string, lease: number | null = null): string => (lease === null ? `project-${projectId}` : `project-${projectId}-${Math.trunc(lease)}`);

const PROJECT_ROOM = /^project-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:-(\d{1,16}))?$/i;

/** The project a room is a call for, and the visit's lease in its name (null on this machine's); null for any other room. */
export function roomOf(name: string): { projectId: string; lease: number | null } | null {
  const match = PROJECT_ROOM.exec(name);
  if (!match) return null;
  return { projectId: match[1]!.toLowerCase(), lease: match[2] === undefined ? null : Number(match[2]) };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLOR = /^#[0-9a-f]{6}$/i;
/** `cm`, `pm`, or a simulated person's role on site ("MEP coordinator", "Architect's site rep"). */
const ROLE = /^[a-z][a-z’' .-]{0,39}$/i;

/** What a tab asks the token route for: a place on its project's call, as the person it is. */
export interface TokenRequest {
  projectId: string;
  /** The tab's presence session id: its identity on the call. */
  sessionId: string;
  name: string;
  /** Their cursor color. */
  color: string;
  role: string;
  /** A simulated person (an AI voice). */
  sim: boolean;
  /**
   * Whether this join brings Remy (the default). False joins a call without her, as when two people start talking
   * before they call her in; asking again with true is "Call Remy".
   */
  remy: boolean;
}

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

/** The request as sent, checked; what is wrong with it otherwise. */
export function tokenRequestOf(body: unknown): Checked<TokenRequest> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'Not a request' };
  const value = body as Record<string, unknown>;
  if (typeof value.projectId !== 'string' || !UUID.test(value.projectId)) return { ok: false, error: 'Unknown project' };
  if (typeof value.sessionId !== 'string' || !UUID.test(value.sessionId)) return { ok: false, error: 'Unknown session' };
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  if (!name || name.length > 80) return { ok: false, error: 'A name is 1 to 80 characters' };
  if (typeof value.color !== 'string' || !COLOR.test(value.color)) return { ok: false, error: 'A color is #rrggbb' };
  const role = typeof value.role === 'string' ? value.role.trim() : '';
  if (!ROLE.test(role)) return { ok: false, error: 'Unknown role' };
  if (value.sim !== undefined && typeof value.sim !== 'boolean') return { ok: false, error: 'sim is true or false' };
  if (value.remy !== undefined && typeof value.remy !== 'boolean') return { ok: false, error: 'remy is true or false' };
  return { ok: true, value: { projectId: value.projectId.toLowerCase(), sessionId: value.sessionId.toLowerCase(), name, color: value.color.toLowerCase(), role, sim: value.sim === true, remy: value.remy !== false } };
}

/** The participant attributes everyone on the call (and Remy) reads. */
export function attributesOf(request: TokenRequest): Record<string, string> {
  return { name: request.name, color: request.color, role: request.role, ...(request.sim ? { sim: 'true' } : {}) };
}

/** A final transcript of what someone said, and whether it was said to Remy. */
export interface Heard {
  identity: string;
  text: string;
  addressed: boolean;
  final: true;
  /** When it was heard, in ms since the epoch. */
  at: number;
}

export type RemyState = 'listening' | 'thinking' | 'speaking';

export type RemyMessage =
  | ({ kind: 'heard' } & Heard)
  | { kind: 'state'; state: RemyState }
  | { kind: 'said'; id: string; interrupted: boolean }
  | { kind: 'filler'; text: string };

const STATES: readonly string[] = ['listening', 'thinking', 'speaking'];

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** One of Remy's messages (`{ kind, ...body }`), checked; null for anything else. */
export function messageOf(payload: Uint8Array | string): RemyMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof payload === 'string' ? payload : new TextDecoder().decode(payload));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const body = parsed as Record<string, unknown>;
  switch (body.kind) {
    case 'heard': {
      const identity = text(body.identity);
      const said = text(body.text);
      // Only final transcripts are sent; anything else isn't a line yet.
      if (!identity || said === null || typeof body.addressed !== 'boolean' || body.final !== true) return null;
      if (typeof body.at !== 'number' || !Number.isFinite(body.at)) return null;
      return { kind: 'heard', identity, text: said, addressed: body.addressed, final: true, at: body.at };
    }
    case 'state':
      return typeof body.state === 'string' && STATES.includes(body.state) ? { kind: 'state', state: body.state as RemyState } : null;
    case 'said': {
      const id = text(body.id);
      return id ? { kind: 'said', id, interrupted: body.interrupted === true } : null;
    }
    case 'filler': {
      const said = text(body.text);
      return said === null ? null : { kind: 'filler', text: said };
    }
    default:
      return null;
  }
}

/**
 * The longest line the hosted worker takes, as her voice is given it (her worker's line-limits.ts): a longer answer is
 * handed over in parts.
 */
export const HOSTED_LINE_CHARS = 400;

/**
 * The assistant service's proof that it wrote a reply (its stream's ReplySignature): the reply as it signed it, and the
 * signature. A line handed to Remy says a part of that reply; where her worker has the service's secret (the hosted
 * site), she says only lines with a proof, and the part as written in the reply, never other words sent with it.
 */
export interface LineProof {
  /** The assistant's turn that wrote the reply. */
  turn: string;
  /** The reply as signed. */
  whole: string;
  sig: string;
}

/** What `remy.say` carries: the line, whose words it answers when the host knows, and the proof of the reply it is part of. */
export const sayPayload = (id: string, line: string, to?: string | null, proof?: (LineProof & { part: string }) | null): string =>
  JSON.stringify({ id, text: line, ...(to ? { to } : {}), ...(proof ? { proof: { turn: proof.turn, whole: proof.whole, part: proof.part, sig: proof.sig } } : {}) });

/** Remy's answer to `remy.say`: whether it took the line. */
export function sayReplyOf(payload: string): { id: string; accepted: boolean; reason?: string } | null {
  try {
    const value = JSON.parse(payload) as Record<string, unknown> | null;
    if (!value || typeof value.id !== 'string' || typeof value.accepted !== 'boolean') return null;
    // Why a line was turned down, in a few words ("not ready": she is leaving; "not the host"; a limit).
    const reason = typeof value.reason === 'string' && value.reason.length <= 80 ? value.reason : undefined;
    return { id: value.id, accepted: value.accepted, ...(reason === undefined ? {} : { reason }) };
  } catch {
    return null;
  }
}

/**
 * Whether this tab posts a heard line to the thread: it came from Remy, it is this tab's own person's
 * line (their identity is this tab's), it was said to Remy, and it has words in it. Anyone on the call
 * could send something on Remy's topic; only Remy's own word counts.
 */
export function postsHeard(line: Heard, { from, me }: { from: string | null | undefined; me: string | null | undefined }): boolean {
  return from === REMY && Boolean(me) && line.identity === me && line.addressed && line.final === true && line.text.trim().length > 0;
}

/** What a line is waited for by: words in it, a pattern, or a test of the line. */
export type HeardMatcher = string | RegExp | ((line: Heard) => boolean);

/** Lower case, letters and digits, single spaces. */
const plain = (words: string): string =>
  words
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * Whether a heard line is the one waited for: from `identity` (anyone when null), and matching. Words
 * match when they come up in the line in that order, whatever the punctuation or case.
 */
export function heardMatches(line: Heard, identity: string | null, matcher: HeardMatcher): boolean {
  if (identity !== null && line.identity !== identity) return false;
  if (typeof matcher === 'function') return matcher(line);
  if (matcher instanceof RegExp) {
    // A global pattern remembers where it last matched; every line is read from its start.
    matcher.lastIndex = 0;
    return matcher.test(line.text);
  }
  const wanted = plain(matcher);
  return wanted.length === 0 || ` ${plain(line.text)} `.includes(` ${wanted} `);
}
