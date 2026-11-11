/**
 * The call with Remy on the hosted site: what the functions in api/call/ answer. The requests and answers are the dev
 * server's (call-dev.ts), with these differences:
 *
 * - The caller is a signed-in member of the project: `Authorization: Bearer <Supabase access token>`, checked with
 *   Supabase, whose user is on the project, from a tab of theirs (the session id is one of their `sessions` rows).
 * - Who they are on the call (name, color, role) comes from their membership and profile, never from the request; the
 *   body's `name`, `color`, `role` and `sim` are ignored.
 * - A copy's call is its visit's own room, `project-<id>-<lease>` (copy_pool.claimed_at, in ms), so whoever held the
 *   copy before can't stay on the next visitor's call. Before either route answers, the copy's calls are tidied: the
 *   rooms of its earlier visits are closed, and anyone on this visit's call longer than six minutes, or whose tab's
 *   session is gone, is taken off it. At most once a minute a route also looks over every room on the call server.
 * - Calls happen only while `app_flags.live_calls` is on. Every token minted counts against the copy's joins
 *   (`use_quota('call_join', project)`: 20 a copy, 300 a day). Remy is brought in only within the copy's allowance
 *   (`use_quota('call_start', project)`, spent when she is brought in, not when someone joins a call she is on; sent
 *   again within ten minutes of the copy's last start, she costs no new one), while fewer than MAX_CALLS rooms have her
 *   (default 5), and while the site's daily spend allows it (`record_spend`, where the database has it: each time she is
 *   sent, $0.25 of OpenAI, $0.10 of ElevenLabs and $0.10 of LiveKit).
 * - Remy's minutes: a visit has five minutes with Remy on calls in all (the database's remy_minutes), shared by everyone
 *   on it. Sending her sets aside what is left for that call and tells her worker when it runs out; she ends the call
 *   for everyone then. A call counts until a route finds her off it (it asks the call server), or in full once its
 *   time ran out. With under 15 seconds left and no call going with her, no one gets a place on a call, and the room
 *   route says so (`minutes`), so the page can put the button away. She isn't sent with fewer than six of her turns
 *   left for the copy or the day (use_quota('ai_turn')): she would only say she has reached her limit.
 * - Remy on her way out (`remy.leaving`), or with no state to show 15 seconds after she joined, counts as gone: the next
 *   join sends her again.
 * - A room a hosted join creates holds 4 at most (three people and Remy) and closes if nobody joins it within a minute.
 *
 * `POST /api/call/token` `{ projectId, sessionId, remy? }` → `{ url, token, remy }`
 * `GET /api/call/room?projectId=` → `{ up, people, remy, minutes?, blocked? }`, `minutes` being `{ totalMs, leftMs, going }`
 *   and `blocked` why a call can't start now, before anyone presses the button (`{ why, what, until }`: callBlockOf)
 * A refusal is `{ error }` in plain words: 400, 401, 403 (not a member, not their tab, calls off or paused for the day,
 * the allowance or the minutes spent), 409 (Remy is on as many calls as she takes), 503 (not set up, or a service didn't
 * answer). One the page can show as such carries a `code`, and a pause the moment it lifts (`until`, ms).
 */
import type { SupabaseClient, createClient } from '@supabase/supabase-js';
import { CallServer, isRemy, joinedAtMsOf, newsOf, UUID, type LiveKitSdk, type Person, type RemyNeed, type RoomInfo, type RoomLimits, type RoomNews } from './call-server.ts';
import { roomFor, roomOf, type Checked, type TokenRequest } from './src/call/protocol.ts';

export const DEFAULT_MAX_CALLS = 5;
/** The rooms hosted joins create: three people and Remy. */
export const ROOM_LIMITS: RoomLimits = { maxParticipants: 4, emptyTimeoutS: 60 };
/** Nobody stays on a hosted call longer than this: whoever has is taken off it. */
export const MAX_CONNECTED_MS = 6 * 60_000;
/** Remy sent again this soon after the copy last spent a call start costs no new one. */
export const FREE_AGAIN_MS = 10 * 60_000;
/** How often a route looks over every room on the call server. */
export const SITE_SWEEP_MS = 60_000;
/** A call needs this much of the visit's minutes left to start (remy_minutes_start's p_min_ms). */
export const MIN_CALL_MS = 15_000;
/** Remy isn't sent with fewer of her turns left than this (quota_left('ai_turn')): she'd only say she reached her limit. */
export const MIN_TURNS_FOR_CALL = 6;

/** When the day's quotas start again: the next midnight UTC (use_quota counts by the UTC day). */
export function nextUtcMidnight(now: number): number {
  const at = new Date(now);
  return Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() + 1);
}

/** When the spend breaker turns calls back on: 00:05 UTC, today's if it hasn't come yet (reset_spend_breaker). */
export function breakerResetAt(now: number): number {
  const at = new Date(now);
  const today = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), 0, 5);
  return now < today ? today : today + 24 * 60 * 60_000;
}

/** What is left of a quota: the copy's and the day's, null where that limit isn't set. */
export interface QuotaParts {
  copyLeft: number | null;
  dayLeft: number | null;
}

/** What a call needs, as it stands (the database's call_readiness). */
export interface Readiness {
  callsOn: boolean;
  /** The spend breaker turned calls off, until 00:05 UTC. */
  breaker: boolean;
  starts: QuotaParts;
  joins: QuotaParts;
  turns: QuotaParts;
  /** When the copy last spent a call start (ms); null when it hasn't. */
  lastStartMs: number | null;
  /** A call's booking would reach a vendor's or the day's spend budget. */
  spendShort: boolean;
}

/**
 * Why a call can't start, or be joined, now: `paused` by the site's day (its calls, joins, Remy's turns or its spend,
 * until they reset), `session` by the visit's own allowance, `busy` with Remy on as many calls as she takes, or `off`,
 * switched off by a person. `what` says which limit; `until` when a pause lifts (ms), null when nobody can say.
 */
export interface CallBlock {
  why: 'paused' | 'session' | 'busy' | 'off';
  what: 'calls' | 'joins' | 'turns' | 'starts' | 'spend' | 'remy';
  until: number | null;
}

/**
 * Whether a call can be had now, from what it needs: `start`, a call that would bring Remy (one she is on only takes a
 * join). In the order the token route spends them: calls on, joins, Remy's turns, a call start (none within ten minutes
 * of the copy's last), the day's spend. Null: nothing stands in the way, apart from the call server's own count of calls
 * with her (the routes ask it) and the visit's minutes (shown on their own).
 */
export function callBlockOf(readiness: Readiness, { start, now }: { start: boolean; now: number }): CallBlock | null {
  const midnight = nextUtcMidnight(now);
  if (!readiness.callsOn) return readiness.breaker ? { why: 'paused', what: 'spend', until: breakerResetAt(now) } : { why: 'off', what: 'calls', until: null };
  if (readiness.joins.dayLeft === 0) return { why: 'paused', what: 'joins', until: midnight };
  if (readiness.joins.copyLeft === 0) return { why: 'session', what: 'joins', until: null };
  if (!start) return null;
  const { turns, starts } = readiness;
  if (turns.dayLeft !== null && turns.dayLeft < MIN_TURNS_FOR_CALL) return { why: 'paused', what: 'turns', until: midnight };
  if (turns.copyLeft !== null && turns.copyLeft < MIN_TURNS_FOR_CALL) return { why: 'session', what: 'turns', until: null };
  const again = readiness.lastStartMs !== null && now - readiness.lastStartMs < FREE_AGAIN_MS;
  if (!again && starts.dayLeft === 0) return { why: 'paused', what: 'starts', until: midnight };
  if (!again && starts.copyLeft === 0) return { why: 'session', what: 'starts', until: null };
  if (readiness.spendShort) return { why: 'paused', what: 'spend', until: midnight };
  return null;
}

/** The database's call_readiness answer; null when it isn't one. */
export function readinessFrom(data: unknown): Readiness | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const value = data as Record<string, unknown>;
  const count = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : null);
  const parts = (x: unknown): QuotaParts | null => {
    if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
    const part = x as Record<string, unknown>;
    return { copyLeft: count(part.copy_left), dayLeft: count(part.day_left) };
  };
  const starts = parts(value.starts);
  const joins = parts(value.joins);
  const turns = parts(value.turns);
  if (typeof value.calls_on !== 'boolean' || !starts || !joins || !turns) return null;
  return {
    callsOn: value.calls_on,
    breaker: value.breaker === true,
    starts,
    joins,
    turns,
    lastStartMs: count(value.last_start_ms),
    spendShort: value.spend_short === true,
  };
}
/** What each time Remy is sent is charged to the site's daily spend (record_spend), in millionths of a dollar. */
export const DISPATCH_SPEND: Readonly<Record<string, number>> = { openai: 250_000, elevenlabs: 100_000, livekit: 100_000 };
/** LiveKit Cloud is across the internet, not on this machine. */
const API_TIMEOUT_MS = 5000;
const MAX_BODY = 10_000;
const DEFAULT_COLOR = '#64748b';

export const MESSAGES = {
  signIn: 'Sign in to join the call.',
  notMember: 'You are not on this project.',
  notYourTab: 'This tab is no longer signed in to this project. Reload the page to join the call.',
  callsOff: 'Calls are switched off right now. The rest of the app still works.',
  allowanceSpent: 'Calls with Remy have reached their limit for now. The rest of the app still works.',
  minutesSpent: "This session's minutes with Remy are used up. The rest of the app still works.",
  callsPaused: 'Calls with Remy are paused on the site until its daily limit resets. The rest of the app still works.',
  joinsSpent: 'Calls have reached their limit for now. The rest of the app still works.',
  remyBusy: 'Remy is on as many calls as she can take right now. Try again in a few minutes.',
  notSetUp: 'Calls are not set up on this site.',
  cantCheck: 'Could not check your place on the project. Try again in a moment.',
  noAnswer: 'The call service did not answer. Try again in a moment.',
  failed: 'Something went wrong on our side. Try again in a moment.',
} as const;

/** A member as the call shows them. */
export interface Member {
  role: string;
  name: string;
  color: string;
}

/** A visit's minutes with Remy (remy_minutes): its size, what's used, what's left now, and the end of the call she's on. */
export interface RemyMinutes {
  totalMs: number;
  usedMs: number;
  /** Left now: the rest of the minutes, or, while a call is going, of the time set aside for it. */
  leftMs: number;
  /** When the call she is on runs out (ms); null when no call is going. */
  endsAt: number | null;
}

/** The minutes as the room route answers them: the page counts `leftMs` down from when it heard it while `going`. */
export interface ShownMinutes {
  totalMs: number;
  leftMs: number;
  going: boolean;
}

export const shownMinutes = (minutes: RemyMinutes): ShownMinutes => ({ totalMs: minutes.totalMs, leftMs: minutes.leftMs, going: minutes.endsAt !== null });

/** The database's answer about a visit's minutes (remy_minutes_json); null when it isn't one. */
export function minutesFrom(data: unknown): RemyMinutes | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const value = data as Record<string, unknown>;
  const ms = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : null);
  const totalMs = ms(value.total_ms);
  const usedMs = ms(value.used_ms);
  const leftMs = ms(value.left_ms);
  if (totalMs === null || usedMs === null || leftMs === null) return null;
  const endsAt = value.ends_at_ms === null || value.ends_at_ms === undefined ? null : ms(value.ends_at_ms);
  return { totalMs, usedMs, leftMs, endsAt };
}

/** What the functions read in the database, with the service role. Each throws when the database doesn't answer. */
export interface CallDirectory {
  /** The user an access token belongs to; null when it isn't a valid, signed-in user's token. */
  userOf(accessToken: string): Promise<string | null>;
  /** The user's place on the project, with their profile's name and color; null when they are not a member. */
  memberOf(projectId: string, userId: string): Promise<Member | null>;
  /** Whether the tab's session is one of the user's, on that project. */
  ownsSession(sessionId: string, userId: string, projectId: string): Promise<boolean>;
  /** `app_flags.live_calls`; off when the row is missing. */
  callsOn(): Promise<boolean>;
  /** When the copy's visit began (copy_pool.claimed_at, ms); null for a project that isn't a copy, or one nobody holds. */
  leaseOf(projectId: string): Promise<number | null>;
  /** Every copy's visit, by project (null: free). */
  leases(): Promise<Map<string, number | null>>;
  /** Which of these tabs (session ids) still have their `sessions` row on the project. */
  liveSessions(projectId: string, sessionIds: readonly string[]): Promise<Set<string>>;
  /** `use_quota('call_join', project)`: true when one more token may be minted for the copy (and it counted). */
  useCallJoin(projectId: string): Promise<boolean>;
  /** `use_quota('call_start', project)`: true when Remy may be brought in (and it counted). */
  useCallStart(projectId: string): Promise<boolean>;
  /** When the copy last spent a call start (ms), in its current visit; null when it hasn't. */
  lastCallStart(projectId: string): Promise<number | null>;
  /** Charges Remy being sent to the site's daily spend: false when the budget says no; true where there is no ledger. */
  chargeDispatch(): Promise<boolean>;
  /**
   * The visit's minutes with Remy (remy_minutes_now), a call that is over counted first; `gone`: the call server says
   * she isn't on the visit's call. Null where the database keeps no minutes.
   */
  minutesOf(projectId: string, lease: number | null, gone: boolean): Promise<RemyMinutes | null>;
  /**
   * Remy is being sent to the visit's call (remy_minutes_start): the rest of the minutes is set aside for it, and this
   * says when they run out; `spent` when too little is left, `unlimited` where the database keeps no minutes.
   */
  startMinutes(projectId: string, lease: number | null, room: string): Promise<{ endsAt: number } | 'spent' | 'unlimited'>;
  /** What a call needs, as it stands (call_readiness); null where the database can't say. */
  readiness(projectId: string): Promise<Readiness | null>;
}

/** What the functions ask the call server (a CallServer; a fake in tests). Each throws when it doesn't answer. */
export interface CallRooms {
  /** The address browsers connect to. */
  readonly url: string;
  mint(request: TokenRequest, options: { remy: boolean; limits?: RoomLimits; room?: string; endsAt?: number | null }): Promise<string>;
  /** Every room on the call server. */
  listRooms(): Promise<RoomInfo[]>;
  /** Who is in a room; null when there is no such room. */
  listPeople(room: string): Promise<Person[] | null>;
  removePerson(room: string, identity: string): Promise<void>;
  deleteRoom(room: string): Promise<void>;
  /** What bringing Remy to the room takes, given who is in it (null: no room yet). */
  remyNeedIn(room: string, people: readonly Person[] | null, now?: number): Promise<RemyNeed>;
  dispatchRemy(room: string, projectId: string, endsAt?: number | null): Promise<void>;
  callsWithRemy(): Promise<number>;
}

/** The hosted call service; a part whose keys are missing is null, and the routes answer 503. */
export interface HostedCall {
  directory: CallDirectory | null;
  rooms: CallRooms | null;
  maxCalls: number;
  /** When this function last looked over every room on the call server (ms; sweepRooms). */
  sweptAt?: number;
}

export interface Answer {
  status: number;
  body: Record<string, unknown>;
}

/** A refusal, in plain words; the ones about bringing Remy in also say why (`code`), so the page can hold its button. */
const refuse = (status: number, error: string, code?: 'remy_busy' | 'allowance_spent' | 'minutes_spent' | 'calls_off'): Answer => ({ status, body: code ? { error, code } : { error } });

/** A call that can't be had now, refused in the words the page already shows for it (the room route's `blocked`). */
export function refuseFor(block: CallBlock): Answer {
  switch (block.why) {
    case 'busy':
      return refuse(409, MESSAGES.remyBusy, 'remy_busy');
    case 'off':
      return refuse(403, MESSAGES.callsOff, 'calls_off');
    case 'session':
      return refuse(403, block.what === 'joins' ? MESSAGES.joinsSpent : MESSAGES.allowanceSpent, 'allowance_spent');
    case 'paused':
      return { status: 403, body: { error: MESSAGES.callsPaused, code: 'calls_paused', ...(block.until !== null ? { until: block.until } : {}) } };
  }
}
const NO_CALL: RoomNews = { up: false, people: [], remy: false };

/** The access token in an `Authorization: Bearer …` header. */
export function bearerOf(header: string | null | undefined): string | null {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '');
  return match ? match[1]! : null;
}

/** What the hosted token route reads from a request: the project, the tab, and whether this join brings Remy. */
export function hostedTokenRequestOf(body: unknown): Checked<{ projectId: string; sessionId: string; remy: boolean }> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'Not a request' };
  const value = body as Record<string, unknown>;
  if (typeof value.projectId !== 'string' || !UUID.test(value.projectId)) return { ok: false, error: 'Unknown project' };
  if (typeof value.sessionId !== 'string' || !UUID.test(value.sessionId)) return { ok: false, error: 'Unknown session' };
  if (value.remy !== undefined && typeof value.remy !== 'boolean') return { ok: false, error: 'remy is true or false' };
  return { ok: true, value: { projectId: value.projectId.toLowerCase(), sessionId: value.sessionId.toLowerCase(), remy: value.remy !== false } };
}

/** Someone a route may take off a call: a person who came with one of its tokens, not Remy, nor a hidden observer of the owner's. */
const removable = (person: Person): boolean => !isRemy(person) && !person.permission?.hidden && (person.kind ?? 0) === 0;
/** On the call longer than the hosted limit. */
const overTime = (person: Person, now: number): boolean => {
  const joined = joinedAtMsOf(person);
  return joined > 0 && now - joined > MAX_CONNECTED_MS;
};

const settled = async (work: Promise<unknown>[]): Promise<void> => {
  await Promise.allSettled(work);
};

/**
 * The copy's call, tidied: the rooms of its earlier visits are closed (whoever stayed on one is off it), and from this
 * visit's room, anyone on it longer than MAX_CONNECTED_MS, and any tab whose session is gone, is taken off. Returns who
 * is left in the room (null: there is no room yet), and every room on the call server, for sweepRooms. Throws when the
 * call server or the database doesn't answer.
 */
export async function tidyCall(directory: CallDirectory, rooms: CallRooms, projectId: string, room: string, now: number): Promise<{ people: Person[] | null; all: RoomInfo[] }> {
  const all = await rooms.listRooms();
  const earlier = all.filter((info) => info.name !== room && roomOf(info.name)?.projectId === projectId);
  await settled(earlier.map((info) => rooms.deleteRoom(info.name)));
  if (!all.some((info) => info.name === room)) return { people: null, all };
  const people = await rooms.listPeople(room);
  if (people === null) return { people: null, all };
  const candidates = people.filter(removable);
  const alive = candidates.length > 0 ? await directory.liveSessions(projectId, candidates.map((person) => person.identity)) : new Set<string>();
  const off = new Set(candidates.filter((person) => overTime(person, now) || !alive.has(person.identity)).map((person) => person.identity));
  await settled([...off].map((identity) => rooms.removePerson(room, identity)));
  return { people: people.filter((person) => !off.has(person.identity)), all };
}

/**
 * Every room on the call server, at most once a SITE_SWEEP_MS per function: a copy's room that isn't its current
 * visit's is closed, and anyone on any call longer than MAX_CONNECTED_MS is taken off it. `done` is the room just
 * tidied. Never fails: what can't be done now is done on a later look.
 */
export async function sweepRooms(call: HostedCall, all: readonly RoomInfo[], done: string, now: number): Promise<void> {
  const { directory, rooms } = call;
  if (!directory || !rooms || now - (call.sweptAt ?? 0) < SITE_SWEEP_MS) return;
  call.sweptAt = now;
  try {
    const leases = await directory.leases();
    await settled(
      all
        .filter((info) => info.name !== done)
        .map(async (info) => {
          const named = roomOf(info.name);
          if (named && leases.has(named.projectId) && named.lease !== (leases.get(named.projectId) ?? null)) {
            await rooms.deleteRoom(info.name);
            return;
          }
          if (info.numParticipants === 0 || (info.createdAtMs > 0 && now - info.createdAtMs <= MAX_CONNECTED_MS)) return;
          const people = (await rooms.listPeople(info.name)) ?? [];
          await settled(people.filter((person) => removable(person) && overTime(person, now)).map((person) => rooms.removePerson(info.name, person.identity)));
        }),
    );
  } catch {
    // The leases couldn't be read: the next look tries again.
  }
}

const bringing = (need: RemyNeed | null): need is 'on-create' | 'dispatch' => need === 'on-create' || need === 'dispatch';

/** `POST /api/call/token`: `text` is the request's body as sent. */
export async function tokenAnswer(call: HostedCall, input: { authorization: string | null; text: string; now?: number }): Promise<Answer> {
  const { directory, rooms } = call;
  if (!directory || !rooms) return refuse(503, MESSAGES.notSetUp);
  const now = input.now ?? Date.now();
  const accessToken = bearerOf(input.authorization);
  if (!accessToken) return refuse(401, MESSAGES.signIn);
  let body: unknown;
  try {
    body = JSON.parse(input.text);
  } catch {
    return refuse(400, 'Not JSON');
  }
  const checked = hostedTokenRequestOf(body);
  if (!checked.ok) return refuse(400, checked.error);
  const { projectId, sessionId, remy } = checked.value;

  let request: TokenRequest;
  let lease: number | null;
  let readiness: Readiness | null;
  try {
    const userId = await directory.userOf(accessToken);
    if (!userId) return refuse(401, MESSAGES.signIn);
    const member = await directory.memberOf(projectId, userId);
    if (!member) return refuse(403, MESSAGES.notMember);
    if (!(await directory.ownsSession(sessionId, userId, projectId))) return refuse(403, MESSAGES.notYourTab);
    readiness = await directory.readiness(projectId);
    if (readiness && !readiness.callsOn) return refuseFor(callBlockOf(readiness, { start: true, now })!);
    if (!readiness && !(await directory.callsOn())) return refuse(403, MESSAGES.callsOff, 'calls_off');
    lease = await directory.leaseOf(projectId);
    request = { projectId, sessionId, name: member.name, color: member.color, role: member.role, sim: false, remy };
  } catch {
    return refuse(503, MESSAGES.cantCheck);
  }

  // This visit's room, tidied before anyone else is let on it.
  const room = roomFor(projectId, lease);
  let tidied: { people: Person[] | null; all: RoomInfo[] };
  try {
    tidied = await tidyCall(directory, rooms, projectId, room, now);
  } catch {
    return refuse(503, MESSAGES.noAnswer);
  }
  const sweeping = sweepRooms(call, tidied.all, room, now);
  const answer = await place(call, { directory, rooms }, request, { room, lease, readiness }, tidied.people, now);
  await sweeping;
  return answer;
}

/**
 * A place on the call, once the person may have one. First the visit's minutes with Remy: with too few left, and no call
 * going with her, there is no place. Then what the call needs, as it stands (callBlockOf), refused before anything is
 * counted, in the words the page already shows. Remy: nothing to do when she is on the call or on her way. Otherwise she
 * is brought in, by this join's own dispatch when it creates the room or by one sent now: within the number of calls she
 * takes at once, her turns left, the copy's allowance (unless she was started for the copy in the last ten minutes) and
 * the site's spend; then the rest of the minutes is set aside for the call, and her dispatch says when they run out.
 * Only a token that brought her carries her dispatch, so one minted while she was on the call can't bring her back later
 * for nothing. Every token minted counts against the copy's joins.
 */
async function place(
  call: HostedCall,
  { directory, rooms }: { directory: CallDirectory; rooms: CallRooms },
  request: TokenRequest,
  { room, lease, readiness }: { room: string; lease: number | null; readiness: Readiness | null },
  people: Person[] | null,
  now: number,
): Promise<Answer> {
  const { projectId } = request;
  let need: RemyNeed | null = null;
  if (request.remy) {
    try {
      need = await rooms.remyNeedIn(room, people, now);
      if (bringing(need) && (await rooms.callsWithRemy()) >= call.maxCalls) return refuse(409, MESSAGES.remyBusy, 'remy_busy');
    } catch {
      return refuse(503, MESSAGES.noAnswer);
    }
  }
  let endsAt: number | null = null;
  try {
    const minutes = await directory.minutesOf(projectId, lease, bringing(need));
    const going = need === 'present' || need === 'starting' || (need === null && minutes?.endsAt != null);
    if (minutes && !going && minutes.leftMs < MIN_CALL_MS) return refuse(403, MESSAGES.minutesSpent, 'minutes_spent');
    const block = readiness ? callBlockOf(readiness, { start: bringing(need), now }) : null;
    if (block) return refuseFor(block);
    if (!(await directory.useCallJoin(projectId))) return refuse(403, MESSAGES.joinsSpent, 'allowance_spent');
    if (bringing(need)) {
      const last = await directory.lastCallStart(projectId);
      const again = last !== null && now - last < FREE_AGAIN_MS;
      if (!again && !(await directory.useCallStart(projectId))) return refuse(403, MESSAGES.allowanceSpent, 'allowance_spent');
      if (!(await directory.chargeDispatch())) return refuseFor({ why: 'paused', what: 'spend', until: breakerResetAt(now) });
      const started = await directory.startMinutes(projectId, lease, room);
      if (started === 'spent') return refuse(403, MESSAGES.minutesSpent, 'minutes_spent');
      if (started !== 'unlimited') endsAt = started.endsAt;
    }
  } catch {
    return refuse(503, MESSAGES.cantCheck);
  }
  let remyNow: string = need ?? 'not-asked';
  if (need === 'dispatch') {
    try {
      await rooms.dispatchRemy(room, projectId, endsAt);
    } catch {
      return refuse(503, MESSAGES.noAnswer);
    }
    remyNow = 'dispatched';
  }
  const token = await rooms.mint(request, { remy: need === 'on-create', limits: ROOM_LIMITS, room, endsAt: need === 'on-create' ? endsAt : null });
  return { status: 200, body: { url: rooms.url, token, remy: remyNow } };
}

/**
 * The visit's minutes for the room route, a call that is over counted first: Remy counts as gone when bringing her would
 * take a dispatch (she isn't on the call and wasn't just sent). Null when there are none to show, or they can't be read.
 */
async function minutesNow(directory: CallDirectory, projectId: string, lease: number | null, need: RemyNeed | null): Promise<ShownMinutes | null> {
  try {
    const minutes = await directory.minutesOf(projectId, lease, need !== null && bringing(need));
    return minutes ? shownMinutes(minutes) : null;
  } catch {
    return null;
  }
}

/**
 * Why a call can't be had now, for the room route, so the page greys its button before anyone presses it: what the call
 * needs as it stands, then, for one that would bring Remy, whether she is on as many calls as she takes. Null when
 * nothing stands in the way, or nobody can say.
 */
async function blockNow(call: HostedCall, rooms: CallRooms, readiness: Readiness | null, need: RemyNeed | null, now: number): Promise<CallBlock | null> {
  const start = need === null || bringing(need);
  const block = readiness ? callBlockOf(readiness, { start, now }) : null;
  if (block || !start) return block;
  try {
    return (await rooms.callsWithRemy()) >= call.maxCalls ? { why: 'busy', what: 'remy', until: null } : null;
  } catch {
    return null;
  }
}

/** `GET /api/call/room?projectId=`. Calls switched off, or no call server, read as a call server that is down. */
export async function roomAnswer(call: HostedCall, input: { authorization: string | null; projectId: string | null; now?: number }): Promise<Answer> {
  const { directory, rooms } = call;
  if (!directory) return refuse(503, MESSAGES.notSetUp);
  const now = input.now ?? Date.now();
  const accessToken = bearerOf(input.authorization);
  if (!accessToken) return refuse(401, MESSAGES.signIn);
  const projectId = (input.projectId ?? '').toLowerCase();
  if (!UUID.test(projectId)) return refuse(400, 'Unknown project');
  let lease: number | null;
  let readiness: Readiness | null;
  try {
    const userId = await directory.userOf(accessToken);
    if (!userId) return refuse(401, MESSAGES.signIn);
    if (!(await directory.memberOf(projectId, userId))) return refuse(403, MESSAGES.notMember);
    if (!rooms) return { status: 200, body: { ...NO_CALL } };
    readiness = await directory.readiness(projectId);
    if (readiness && !readiness.callsOn) return { status: 200, body: { ...NO_CALL, blocked: callBlockOf(readiness, { start: true, now }) } };
    if (!readiness && !(await directory.callsOn())) return { status: 200, body: { ...NO_CALL } };
    lease = await directory.leaseOf(projectId);
  } catch {
    return refuse(503, MESSAGES.cantCheck);
  }
  const room = roomFor(projectId, lease);
  try {
    const { people, all } = await tidyCall(directory, rooms, projectId, room, now);
    await sweepRooms(call, all, room, now);
    const need = await rooms.remyNeedIn(room, people, now).catch(() => null);
    const minutes = await minutesNow(directory, projectId, lease, need);
    const blocked = await blockNow(call, rooms, readiness, need, now);
    return { status: 200, body: { ...newsOf(people ?? [], now), ...(minutes ? { minutes } : {}), ...(blocked ? { blocked } : {}) } };
  } catch {
    return { status: 200, body: { ...NO_CALL } };
  }
}

const json = (answer: Answer): Response =>
  new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

/** The token route as a web handler (api/call/token.ts). */
export async function tokenResponse(call: HostedCall, request: Request): Promise<Response> {
  if (request.method !== 'POST') return json(refuse(405, 'POST only'));
  try {
    const text = await request.text();
    if (text.length > MAX_BODY) return json(refuse(413, 'Too long'));
    return json(await tokenAnswer(call, { authorization: request.headers.get('authorization'), text }));
  } catch {
    return json(refuse(500, MESSAGES.failed));
  }
}

/** The room route as a web handler (api/call/room.ts). */
export async function roomResponse(call: HostedCall, request: Request): Promise<Response> {
  if (request.method !== 'GET') return json(refuse(405, 'GET only'));
  try {
    const projectId = new URL(request.url).searchParams.get('projectId');
    return json(await roomAnswer(call, { authorization: request.headers.get('authorization'), projectId }));
  } catch {
    return json(refuse(500, MESSAGES.failed));
  }
}

type DbError = { message: string; code?: string };
type Row<T> = { data: T | null; error: DbError | null };

function rowOf<T>(what: string, result: Row<T>): T | null {
  if (result.error) throw new Error(`${what}: ${result.error.message}`);
  return result.data;
}

/** A function the database doesn't have (yet): PostgREST's PGRST202, or Postgres's undefined_function. */
const missingFunction = (error: DbError): boolean => error.code === 'PGRST202' || error.code === '42883';

/** A timestamp as ms since the epoch; null when there is none. */
function msOf(at: string | null | undefined): number | null {
  const ms = at ? Date.parse(at) : Number.NaN;
  return Number.isFinite(ms) ? ms : null;
}

/** supabase-js's `auth.getClaims`, as the directory reads it. */
type ClaimsAnswer = { data: { claims: { sub?: unknown; role?: unknown } } | null; error: { name?: string; status?: number } | null };

/** An Auth failure that says nothing about the token (the network, the Auth server), not a token that is no good. */
function transient(error: { name?: string; status?: number }): boolean {
  return error.name === 'AuthRetryableFetchError' || (typeof error.status === 'number' && (error.status === 0 || error.status >= 500));
}

/** CallDirectory over supabase-js, with the service role. */
export function supabaseDirectory(client: SupabaseClient): CallDirectory {
  return {
    async userOf(accessToken) {
      // Checked against the project's signing keys (or by the Auth server, for a project that signs with a shared secret).
      // Typed here, not through supabase-js: Vercel's compile can't follow pnpm's links to its Auth types.
      const auth = client.auth as unknown as { getClaims(jwt: string): Promise<ClaimsAnswer> };
      const { data, error } = await auth.getClaims(accessToken);
      if (error) {
        if (transient(error)) throw error;
        return null;
      }
      const claims = data?.claims;
      return claims && claims.role === 'authenticated' && typeof claims.sub === 'string' && UUID.test(claims.sub) ? claims.sub.toLowerCase() : null;
    },
    async memberOf(projectId, userId) {
      const [member, profile] = await Promise.all([
        client.from('project_members').select('role').eq('project_id', projectId).eq('user_id', userId).maybeSingle(),
        client.from('profiles').select('display_name, color').eq('user_id', userId).maybeSingle(),
      ]);
      const role = rowOf('project_members', member as Row<{ role: string }>);
      const shown = rowOf('profiles', profile as Row<{ display_name: string | null; color: string | null }>);
      if (!role) return null;
      return {
        role: role.role,
        name: (shown?.display_name ?? '').trim().slice(0, 80) || 'Guest',
        color: /^#[0-9a-f]{6}$/i.test(shown?.color ?? '') ? shown!.color!.toLowerCase() : DEFAULT_COLOR,
      };
    },
    async ownsSession(sessionId, userId, projectId) {
      const result = await client.from('sessions').select('id').eq('id', sessionId).eq('user_id', userId).eq('project_id', projectId).maybeSingle();
      return rowOf('sessions', result as Row<{ id: string }>) !== null;
    },
    async callsOn() {
      const result = await client.from('app_flags').select('enabled').eq('key', 'live_calls').maybeSingle();
      return rowOf('app_flags', result as Row<{ enabled: boolean }>)?.enabled === true;
    },
    async leaseOf(projectId) {
      const result = await client.from('copy_pool').select('claimed_at').eq('project_id', projectId).maybeSingle();
      return msOf(rowOf('copy_pool', result as Row<{ claimed_at: string | null }>)?.claimed_at);
    },
    async leases() {
      const result = await client.from('copy_pool').select('project_id, claimed_at');
      const rows = rowOf('copy_pool', result as Row<{ project_id: string; claimed_at: string | null }[]>) ?? [];
      return new Map(rows.map((row) => [row.project_id.toLowerCase(), msOf(row.claimed_at)]));
    },
    async liveSessions(projectId, sessionIds) {
      const ids = [...new Set(sessionIds.filter((id) => UUID.test(id)).map((id) => id.toLowerCase()))];
      if (ids.length === 0) return new Set();
      const result = await client.from('sessions').select('id').eq('project_id', projectId).in('id', ids);
      return new Set((rowOf('sessions', result as Row<{ id: string }[]>) ?? []).map((row) => row.id.toLowerCase()));
    },
    async useCallJoin(projectId) {
      const result = await client.rpc('use_quota', { p_kind: 'call_join', p_project: projectId });
      return rowOf('use_quota', result as Row<boolean>) === true;
    },
    async useCallStart(projectId) {
      const result = await client.rpc('use_quota', { p_kind: 'call_start', p_project: projectId });
      return rowOf('use_quota', result as Row<boolean>) === true;
    },
    async lastCallStart(projectId) {
      const result = await client.from('quota_usage').select('used, updated_at').eq('kind', 'call_start').eq('project_id', projectId).maybeSingle();
      const row = rowOf('quota_usage', result as Row<{ used: number; updated_at: string }>);
      return row && row.used > 0 ? msOf(row.updated_at) : null;
    },
    async chargeDispatch() {
      const answers = (await Promise.all(Object.entries(DISPATCH_SPEND).map(([vendor, usdMicro]) => client.rpc('record_spend', { p_vendor: vendor, p_usd_micro: usdMicro })))) as Row<boolean>[];
      let open = true;
      for (const answer of answers) {
        if (answer.error) {
          // No spend ledger in this database: nothing to charge.
          if (missingFunction(answer.error)) return true;
          throw new Error(`record_spend: ${answer.error.message}`);
        }
        if (answer.data === false) open = false;
      }
      return open;
    },
    async minutesOf(projectId, lease, gone) {
      const result = (await client.rpc('remy_minutes_now', { p_project: projectId, p_lease: lease ?? 0, p_gone: gone })) as Row<unknown>;
      if (result.error) {
        // No minutes in this database: calls have none to run out of.
        if (missingFunction(result.error)) return null;
        throw new Error(`remy_minutes_now: ${result.error.message}`);
      }
      const minutes = minutesFrom(result.data);
      if (!minutes) throw new Error('remy_minutes_now: not an answer');
      return minutes;
    },
    async startMinutes(projectId, lease, room) {
      const result = (await client.rpc('remy_minutes_start', { p_project: projectId, p_lease: lease ?? 0, p_room: room, p_min_ms: MIN_CALL_MS })) as Row<unknown>;
      if (result.error) {
        if (missingFunction(result.error)) return 'unlimited';
        throw new Error(`remy_minutes_start: ${result.error.message}`);
      }
      const ok = (result.data as { ok?: unknown } | null)?.ok === true;
      const minutes = minutesFrom(result.data);
      return ok && minutes?.endsAt != null ? { endsAt: minutes.endsAt } : 'spent';
    },
    async readiness(projectId) {
      const result = (await client.rpc('call_readiness', { p_project: projectId, p_booking: DISPATCH_SPEND })) as Row<unknown>;
      if (result.error) {
        // No readiness in this database: the routes count as they go, and refuse when a count says no.
        if (missingFunction(result.error)) return null;
        throw new Error(`call_readiness: ${result.error.message}`);
      }
      const readiness = readinessFrom(result.data);
      if (!readiness) throw new Error('call_readiness: not an answer');
      return readiness;
    },
  };
}

/** MAX_CALLS: a whole number of calls (0: none); anything else is the default. */
export function maxCallsOf(value: string | undefined): number {
  const parsed = Number(value?.trim() || DEFAULT_MAX_CALLS);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_MAX_CALLS;
}

/**
 * The hosted call service from the functions' environment: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY for the
 * directory, LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET for the rooms, MAX_CALLS. The SDKs are handed in by
 * the functions, which list them in the root package.json.
 */
export function hostedCall(env: Record<string, string | undefined>, sdks: { createClient: typeof createClient; livekit: LiveKitSdk }): HostedCall {
  const supabaseUrl = env.SUPABASE_URL?.trim();
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  const url = env.LIVEKIT_URL?.trim();
  const key = env.LIVEKIT_API_KEY?.trim();
  const secret = env.LIVEKIT_API_SECRET?.trim();
  return {
    directory: supabaseUrl && serviceRoleKey ? supabaseDirectory(sdks.createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } })) : null,
    rooms: url && key && secret ? new CallServer(sdks.livekit, { url, key, secret, timeoutMs: API_TIMEOUT_MS }) : null,
    maxCalls: maxCallsOf(env.MAX_CALLS),
    sweptAt: 0,
  };
}
