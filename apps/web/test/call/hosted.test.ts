// @vitest-environment node
/**
 * The hosted call routes (api/call/ through call-hosted.ts): who may join, who they are on the call, which room they
 * join (their visit's), what is tidied first, and when Remy is brought in: calls switched on, the copy's joins, fewer
 * than MAX_CALLS rooms with her, her turns left, the copy's allowance (spent only when she is, and not again within ten
 * minutes), the site's spend, and the visit's minutes with her: one pool, set aside call by call, counted until she is
 * seen gone, and the end of each call's share sent with her.
 */
import { createClient } from '@supabase/supabase-js';
import * as livekit from 'livekit-server-sdk';
import { describe, expect, it } from 'vitest';
import { CallServer, dispatchMetadata, newsOf, remyGone, remyHere, STARTING_GRACE_MS, type LiveKitSdk, type Person, type RemyNeed, type RoomLimits } from '../../call-server';
import {
  bearerOf,
  DISPATCH_SPEND,
  FREE_AGAIN_MS,
  hostedCall,
  hostedTokenRequestOf,
  MAX_CONNECTED_MS,
  maxCallsOf,
  MESSAGES,
  breakerResetAt,
  callBlockOf,
  hookAnswer,
  hookResponse,
  type HookEvent,
  MIN_CALL_MS,
  MIN_TURNS_FOR_CALL,
  minutesFrom,
  nextUtcMidnight,
  readinessFrom,
  refuseFor,
  type Readiness,
  roomAnswer,
  roomResponse,
  ROOM_LIMITS,
  SITE_SWEEP_MS,
  supabaseDirectory,
  tokenAnswer,
  tokenResponse,
  type CallDirectory,
  type CallRooms,
  type HostedCall,
  type Member,
} from '../../call-hosted';
import type { TokenRequest } from '../../src/call/protocol';

const PROJECT = '00000000-0000-4000-8000-000000010003';
const OTHER_PROJECT = '00000000-0000-4000-8000-000000010004';
const SESSION = '6f1c2a9e-1b7d-4c0e-9a51-3d2f8e7b6a10';
const OTHER_SESSION = '7a2b3c4d-5e6f-4a1b-8c2d-0e9f8a7b6c5e';
const USER = '3b9d8c7a-6e5f-4a1b-8c2d-0e9f8a7b6c5d';
const TOKEN = 'header.payload.signature';
const MEMBER: Member = { role: 'cm', name: 'Deepak Jayaram', color: '#2563eb' };
const NOW = 1_794_400_000_000;
/** When the copy's visit began: its call's room is named for it. */
const LEASE = NOW - 20 * 60_000;
const ROOM = `project-${PROJECT}-${LEASE}`;

interface DirectoryState {
  users?: Record<string, string>;
  members?: Record<string, Member>;
  sessions?: string[];
  callsOn?: boolean;
  allowance?: number;
  joins?: number;
  failing?: boolean;
  leases?: Record<string, number | null>;
  /** When the copy last spent a call start. */
  lastStart?: number | null;
  /** What record_spend answers. */
  spendOpen?: boolean;
  /**
   * The visit's minutes with Remy (remy_minutes, as the database keeps them): its size and what is used, and the call
   * set aside for, if one is going. Left out: a database without them.
   */
  pool?: { totalMs?: number; usedMs?: number; call?: { from: number; until: number } | null };
  /** Remy's turns left for the copy (call_readiness): null for no limit. */
  turns?: number | null;
  /** What is left of the day's calls, joins and turns across the site: null for no limit. */
  startsToday?: number | null;
  joinsToday?: number | null;
  turnsToday?: number | null;
  /** The spend breaker turned calls off. */
  breaker?: boolean;
  /** A database without call_readiness. */
  noReadiness?: boolean;
}

/** How long after she was sent Remy may still be on her way (remy_minutes_join_grace). */
const JOIN_GRACE_MS = 20_000;

/** An in-memory directory: one user, a member of PROJECT, with one tab, calls on, 3 call starts and 20 joins. */
function directory(state: DirectoryState = {}) {
  const users = state.users ?? { [TOKEN]: USER };
  const members = state.members ?? { [`${PROJECT}/${USER}`]: MEMBER };
  const sessions = state.sessions ?? [`${SESSION}/${USER}/${PROJECT}`];
  const leases = new Map(Object.entries(state.leases ?? { [PROJECT]: LEASE }));
  let allowance = state.allowance ?? 3;
  let joins = state.joins ?? 20;
  let lastStart = state.lastStart ?? null;
  let charged = 0;
  /** What remy_minutes_ended was told: the room, and when the Remy who left joined. */
  const ended: { room: string; since: number | null }[] = [];
  const pool = state.pool ? { totalMs: state.pool.totalMs ?? 300_000, usedMs: state.pool.usedMs ?? 0, call: state.pool.call ?? null } : null;
  // What remy_minutes_settled does: a call whose time ran out counts in full; one she is seen gone from, until now.
  const settle = (gone: boolean) => {
    if (!pool?.call) return;
    const end = pool.call.until <= NOW ? pool.call.until : gone && pool.call.from <= NOW - JOIN_GRACE_MS ? NOW : null;
    if (end === null) return;
    pool.usedMs += end - pool.call.from;
    pool.call = null;
  };
  const minutes = () => pool && { totalMs: pool.totalMs, usedMs: pool.usedMs, leftMs: pool.call ? pool.call.until - NOW : pool.totalMs - pool.usedMs, endsAt: pool.call?.until ?? null };
  const asked: string[] = [];
  const fail = () => {
    if (state.failing) throw new Error('the database did not answer');
  };
  const impl: CallDirectory = {
    async userOf(token) {
      asked.push('userOf');
      fail();
      return users[token] ?? null;
    },
    async memberOf(projectId, userId) {
      asked.push('memberOf');
      fail();
      return members[`${projectId}/${userId}`] ?? null;
    },
    async ownsSession(sessionId, userId, projectId) {
      asked.push('ownsSession');
      fail();
      return sessions.includes(`${sessionId}/${userId}/${projectId}`);
    },
    async callsOn() {
      asked.push('callsOn');
      fail();
      return state.callsOn ?? true;
    },
    async leaseOf(projectId) {
      asked.push('leaseOf');
      fail();
      return leases.get(projectId) ?? null;
    },
    async leases() {
      asked.push('leases');
      return new Map(leases);
    },
    async liveSessions(projectId, ids) {
      asked.push('liveSessions');
      return new Set(ids.filter((id) => sessions.some((row) => row.startsWith(`${id}/`) && row.endsWith(`/${projectId}`))));
    },
    async useCallJoin() {
      asked.push('useCallJoin');
      if (joins <= 0) return false;
      joins -= 1;
      return true;
    },
    async useCallStart() {
      asked.push('useCallStart');
      if (allowance <= 0) return false;
      allowance -= 1;
      lastStart = NOW;
      return true;
    },
    async lastCallStart() {
      asked.push('lastCallStart');
      return lastStart;
    },
    async chargeDispatch() {
      asked.push('chargeDispatch');
      charged += 1;
      return state.spendOpen ?? true;
    },
    async minutesOf(_projectId, _lease, gone) {
      asked.push(`minutesOf ${gone ? 'gone' : 'here'}`);
      fail();
      settle(gone);
      return minutes();
    },
    async startMinutes() {
      asked.push('startMinutes');
      if (!pool) return 'unlimited';
      settle(false);
      if (pool.call && pool.call.from > NOW - JOIN_GRACE_MS) return { endsAt: pool.call.until };
      settle(true);
      const left = pool.totalMs - pool.usedMs;
      if (left < MIN_CALL_MS) return 'spent';
      pool.call = { from: NOW, until: NOW + left };
      return { endsAt: pool.call.until };
    },
    async endedCall(_projectId, _lease, room, since) {
      asked.push('endedCall');
      fail();
      ended.push({ room, since });
      if (pool?.call) {
        pool.usedMs += Math.min(NOW, pool.call.until) - pool.call.from;
        pool.call = null;
      }
    },
    async readiness() {
      asked.push('readiness');
      fail();
      if (state.noReadiness) return null;
      return {
        callsOn: state.callsOn ?? true,
        breaker: state.breaker ?? false,
        starts: { copyLeft: allowance, dayLeft: state.startsToday ?? null },
        joins: { copyLeft: joins, dayLeft: state.joinsToday ?? null },
        turns: { copyLeft: state.turns ?? null, dayLeft: state.turnsToday ?? null },
        lastStartMs: lastStart,
        spendShort: state.spendOpen === false,
      };
    },
  };
  return { impl, asked, allowance: () => allowance, joins: () => joins, charged: () => charged, pool: () => pool, ended };
}

const person = (identity: string, joinedAtMs: number, extra: Partial<Person> = {}): Person => ({ identity, kind: 0, joinedAtMs: BigInt(joinedAtMs), attributes: { name: identity }, ...extra });
const remy = (attributes: Record<string, string> = { 'lk.agent.state': 'listening' }, joinedAtMs = NOW - 30_000): Person => ({ identity: 'remy', kind: 4, joinedAtMs: BigInt(joinedAtMs), attributes });

interface RoomsState {
  /** The rooms on the call server, by name: who is in each, and when it was made. */
  rooms?: Record<string, { people: Person[]; createdAtMs?: number }>;
  need?: RemyNeed;
  calls?: number;
  failing?: boolean;
  /** When Remy was last sent to a room, for 'starting'. */
  sentAt?: Record<string, number>;
}

/** A call server in memory that mints readable tokens and records what it was asked to do. */
function rooms(state: RoomsState = {}) {
  const live = new Map(Object.entries(state.rooms ?? {}).map(([name, room]) => [name, { people: [...room.people], createdAtMs: room.createdAtMs ?? NOW - 60_000 }]));
  const minted: { request: TokenRequest; remy: boolean; limits?: RoomLimits; room?: string }[] = [];
  const dispatched: string[] = [];
  /** When each dispatch said the call runs out (null: no end). */
  const dispatchedEnds: (number | null)[] = [];
  const deleted: string[] = [];
  const removed: string[] = [];
  const asked: string[] = [];
  const fail = () => {
    if (state.failing) throw new Error('The call server did not answer');
  };
  const impl: CallRooms = {
    url: 'wss://gantry.example.livekit.cloud',
    async mint(request, options) {
      minted.push({ request, ...options });
      return `token-for-${request.sessionId}`;
    },
    async listRooms() {
      asked.push('listRooms');
      fail();
      return [...live].map(([name, room]) => ({ name, numParticipants: room.people.length, createdAtMs: room.createdAtMs }));
    },
    async listPeople(room) {
      asked.push(`listPeople ${room}`);
      fail();
      return live.get(room)?.people ?? null;
    },
    async removePerson(room, identity) {
      removed.push(`${room} ${identity}`);
      const found = live.get(room);
      if (found) found.people = found.people.filter((candidate) => candidate.identity !== identity);
    },
    async deleteRoom(room) {
      deleted.push(room);
      live.delete(room);
    },
    async remyNeedIn(room, people, now = Date.now()) {
      asked.push(`remyNeed ${room}`);
      fail();
      if (state.need) return state.need;
      if (people === null) return 'on-create';
      if (people.some((candidate) => remyHere(candidate, now))) return 'present';
      const sent = state.sentAt?.[room];
      return sent !== undefined && now - sent < STARTING_GRACE_MS ? 'starting' : 'dispatch';
    },
    async dispatchRemy(room, _projectId, endsAt = null) {
      dispatched.push(room);
      dispatchedEnds.push(endsAt);
    },
    async callsWithRemy() {
      asked.push('callsWithRemy');
      return state.calls ?? 0;
    },
  };
  return { impl, minted, dispatched, dispatchedEnds, deleted, removed, asked, live };
}

function service(dir = directory(), call = rooms(), maxCalls = 5) {
  const hosted: HostedCall = { directory: dir.impl, rooms: call.impl, maxCalls, sweptAt: NOW };
  return { hosted, dir, call };
}

const ask = (hosted: HostedCall, body: unknown, authorization: string | null = `Bearer ${TOKEN}`, now = NOW) =>
  tokenAnswer(hosted, { authorization, text: typeof body === 'string' ? body : JSON.stringify(body), now });

const JOIN = { projectId: PROJECT, sessionId: SESSION };
/** The visit's call, going: Deepak's tab on it a minute, Remy there. */
const GOING = { [ROOM]: { people: [person(SESSION, NOW - 60_000), remy()] } };

describe('the request', () => {
  it('reads the access token from a Bearer header', () => {
    expect(bearerOf(`Bearer ${TOKEN}`)).toBe(TOKEN);
    expect(bearerOf(`bearer ${TOKEN} `)).toBe(TOKEN);
    expect(bearerOf('Basic abc')).toBeNull();
    expect(bearerOf('Bearer')).toBeNull();
    expect(bearerOf(null)).toBeNull();
  });

  it('takes the project, the tab and whether to bring Remy, and nothing about who the person is', () => {
    const checked = hostedTokenRequestOf({ projectId: PROJECT.toUpperCase(), sessionId: SESSION, name: 'Mallory', role: 'owner', color: 'red', sim: true });
    expect(checked).toEqual({ ok: true, value: { projectId: PROJECT, sessionId: SESSION, remy: true } });
    expect(hostedTokenRequestOf({ ...JOIN, remy: false })).toMatchObject({ ok: true, value: { remy: false } });
    expect(hostedTokenRequestOf({ projectId: 'harbor', sessionId: SESSION })).toEqual({ ok: false, error: 'Unknown project' });
    expect(hostedTokenRequestOf({ projectId: PROJECT, sessionId: 'tab-1' })).toEqual({ ok: false, error: 'Unknown session' });
    expect(hostedTokenRequestOf({ ...JOIN, remy: 'yes' })).toEqual({ ok: false, error: 'remy is true or false' });
    expect(hostedTokenRequestOf([JOIN])).toEqual({ ok: false, error: 'Not a request' });
  });

  it('reads MAX_CALLS as a whole number, 5 by default', () => {
    expect(maxCallsOf(undefined)).toBe(5);
    expect(maxCallsOf('')).toBe(5);
    expect(maxCallsOf('2')).toBe(2);
    expect(maxCallsOf('0')).toBe(0);
    expect(maxCallsOf('lots')).toBe(5);
    expect(maxCallsOf('-1')).toBe(5);
  });
});

describe('POST /api/call/token: who may join', () => {
  it('is refused without a signed-in user, before anything is looked up', async () => {
    const { hosted, dir } = service();
    expect(await ask(hosted, JOIN, null)).toEqual({ status: 401, body: { error: MESSAGES.signIn } });
    expect(await ask(hosted, JOIN, 'Bearer not-a-real-token')).toEqual({ status: 401, body: { error: MESSAGES.signIn } });
    expect(dir.asked).toEqual(['userOf']);
  });

  it('is refused for a request it cannot read', async () => {
    const { hosted } = service();
    expect(await ask(hosted, '{not json')).toEqual({ status: 400, body: { error: 'Not JSON' } });
    expect(await ask(hosted, { projectId: PROJECT })).toEqual({ status: 400, body: { error: 'Unknown session' } });
  });

  it('is refused for someone who is not a member of the project', async () => {
    const { hosted, call } = service();
    expect(await ask(hosted, { ...JOIN, projectId: OTHER_PROJECT })).toEqual({ status: 403, body: { error: MESSAGES.notMember } });
    expect(call.minted).toEqual([]);
  });

  it('is refused for a tab that is not theirs on this project', async () => {
    const { hosted, call } = service(directory({ sessions: [`${SESSION}/someone-else/${PROJECT}`] }));
    expect(await ask(hosted, JOIN)).toEqual({ status: 403, body: { error: MESSAGES.notYourTab } });
    expect(call.minted).toEqual([]);
  });

  it('is refused while calls are switched off, without touching the allowances or the call server', async () => {
    const { hosted, dir, call } = service(directory({ callsOn: false }));
    expect(await ask(hosted, JOIN)).toEqual({ status: 403, body: { error: MESSAGES.callsOff, code: 'calls_off' } });
    expect(dir.asked).not.toContain('useCallStart');
    expect(dir.asked).not.toContain('useCallJoin');
    expect(call.asked).toEqual([]);
  });

  it('answers 503 when the database does not answer', async () => {
    const { hosted } = service(directory({ failing: true }));
    expect(await ask(hosted, JOIN)).toEqual({ status: 503, body: { error: MESSAGES.cantCheck } });
  });

  it('answers 503 when the site has no keys for the database or the call server', async () => {
    const { hosted } = service();
    expect(await ask({ ...hosted, rooms: null }, JOIN)).toEqual({ status: 503, body: { error: MESSAGES.notSetUp } });
    expect(await ask({ ...hosted, directory: null }, JOIN)).toEqual({ status: 503, body: { error: MESSAGES.notSetUp } });
  });

  it('names the person from their membership and profile, never from the request', async () => {
    const { hosted, call } = service(directory(), rooms({ rooms: GOING }));
    const answer = await ask(hosted, { ...JOIN, name: 'Mallory', color: '#ff0000', role: 'owner', sim: true });
    expect(answer).toEqual({ status: 200, body: { url: 'wss://gantry.example.livekit.cloud', token: `token-for-${SESSION}`, remy: 'present' } });
    expect(call.minted[0]!.request).toEqual({ projectId: PROJECT, sessionId: SESSION, name: 'Deepak Jayaram', color: '#2563eb', role: 'cm', sim: false, remy: true });
    expect(call.minted[0]!.limits).toEqual({ maxParticipants: 4, emptyTimeoutS: 60 });
  });
});

describe('POST /api/call/token: the visit’s own call', () => {
  it('joins the room of the copy’s current visit, named for when it was claimed', async () => {
    const { hosted, call } = service();
    await ask(hosted, JOIN);
    expect(call.minted[0]!.room).toBe(ROOM);
  });

  it('closes the rooms of the copy’s earlier visits, with whoever stayed on them, and leaves other copies’ alone', async () => {
    const earlier = `project-${PROJECT}-${LEASE - 3_600_000}`;
    const other = `project-${OTHER_PROJECT}-${LEASE}`;
    const { hosted, call } = service(directory(), rooms({ rooms: { [earlier]: { people: [person(OTHER_SESSION, NOW - 120_000)] }, [`project-${PROJECT}`]: { people: [] }, [other]: { people: [] } } }));
    expect((await ask(hosted, JOIN)).status).toBe(200);
    expect(call.deleted.sort()).toEqual([earlier, `project-${PROJECT}`].sort());
    expect(call.live.has(other)).toBe(true);
  });

  it('takes off the call anyone on it longer than six minutes, and any tab whose session is gone, before minting', async () => {
    const stayed = person(OTHER_SESSION, NOW - MAX_CONNECTED_MS - 1);
    const gone = person('11111111-2222-4333-8444-555555555555', NOW - 30_000);
    const observer = person('observer', NOW - 3_600_000, { permission: { hidden: true } });
    const dir = directory({ sessions: [`${SESSION}/${USER}/${PROJECT}`, `${OTHER_SESSION}/${USER}/${PROJECT}`] });
    const { hosted, call } = service(dir, rooms({ rooms: { [ROOM]: { people: [person(SESSION, NOW - 60_000), stayed, gone, observer, remy({ 'lk.agent.state': 'listening' }, NOW - 3_600_000)] } } }));
    expect((await ask(hosted, JOIN)).body.remy).toBe('present');
    expect(call.removed.sort()).toEqual([`${ROOM} ${OTHER_SESSION}`, `${ROOM} ${gone.identity}`].sort());
  });

  it('gives a project that isn’t a copy its plain room', async () => {
    const { hosted, call } = service(directory({ leases: {} }));
    await ask(hosted, JOIN);
    expect(call.minted[0]!.room).toBe(`project-${PROJECT}`);
  });
});

describe('POST /api/call/token: the copy’s joins', () => {
  it('counts every token minted, with or without Remy, and only when one is minted', async () => {
    // Remy on the call, and this tab not on it yet: its joins count (one already on it takes none).
    const { hosted, dir } = service(directory(), rooms({ rooms: { [ROOM]: { people: [remy()] } } }));
    await ask(hosted, JOIN);
    await ask(hosted, { ...JOIN, remy: false });
    expect(dir.joins()).toBe(18);
    const busy = service(directory(), rooms({ calls: 5 }));
    expect((await ask(busy.hosted, JOIN)).status).toBe(409);
    expect(busy.dir.joins()).toBe(20);
  });

  it('is refused with 403 once the copy has had its joins, before Remy is brought in', async () => {
    const { hosted, dir, call } = service(directory({ joins: 1 }), rooms({ need: 'dispatch' }));
    expect((await ask(hosted, JOIN)).status).toBe(200);
    expect(await ask(hosted, JOIN)).toEqual({ status: 403, body: { error: MESSAGES.joinsSpent, code: 'allowance_spent' } });
    expect(call.minted).toHaveLength(1);
    expect(call.dispatched).toHaveLength(1);
    expect(dir.allowance()).toBe(2);
  });
});

describe('POST /api/call/token: bringing Remy', () => {
  it('spends nothing to join a call she is on, or on her way to', async () => {
    for (const need of ['present', 'starting'] as const) {
      const { hosted, dir, call } = service(directory(), rooms({ need }));
      expect((await ask(hosted, JOIN)).body.remy).toBe(need);
      expect(dir.allowance()).toBe(3);
      expect(dir.charged()).toBe(0);
      expect(call.asked).not.toContain('callsWithRemy');
      // A token minted while she is there can't bring her back later: it carries no dispatch of its own.
      expect(call.minted[0]!.remy).toBe(false);
    }
  });

  it('brings her with the room when this join creates it, spending one call start and charging the site’s spend', async () => {
    const { hosted, dir, call } = service(directory(), rooms({ calls: 4 }));
    const answer = await ask(hosted, JOIN);
    expect(answer.status).toBe(200);
    expect(answer.body.remy).toBe('on-create');
    expect(dir.allowance()).toBe(2);
    expect(dir.charged()).toBe(1);
    expect(call.minted[0]!.remy).toBe(true);
    expect(call.dispatched).toEqual([]);
  });

  it('sends her to a call going without her, spending one call start', async () => {
    const { hosted, dir, call } = service(directory(), rooms({ rooms: { [ROOM]: { people: [person(SESSION, NOW - 60_000)] } } }));
    expect((await ask(hosted, JOIN)).body.remy).toBe('dispatched');
    expect(call.dispatched).toEqual([ROOM]);
    expect(call.minted[0]!.remy).toBe(false);
    expect(dir.allowance()).toBe(2);
  });

  it('sends her again when the Remy in the room is on her way out, or has shown no state for 15 seconds', async () => {
    const leaving = service(directory({ lastStart: null }), rooms({ rooms: { [ROOM]: { people: [person(SESSION, NOW - 60_000), remy({ 'lk.agent.state': 'listening', 'remy.leaving': '1' })] } } }));
    expect((await ask(leaving.hosted, JOIN)).body.remy).toBe('dispatched');
    expect(leaving.call.dispatched).toEqual([ROOM]);

    const stuck = service(directory(), rooms({ rooms: { [ROOM]: { people: [person(SESSION, NOW - 60_000), remy({}, NOW - 16_000)] } } }));
    expect((await ask(stuck.hosted, JOIN)).body.remy).toBe('dispatched');

    // Joined a moment ago, with no state yet: she is still starting, not stuck.
    const starting = service(directory(), rooms({ rooms: { [ROOM]: { people: [person(SESSION, NOW - 60_000), remy({}, NOW - 5_000)] } } }));
    expect((await ask(starting.hosted, JOIN)).body.remy).toBe('present');
    expect(starting.call.dispatched).toEqual([]);
  });

  it('spends no new call start to send her again within ten minutes of the copy’s last, but still charges the spend', async () => {
    const people = { [ROOM]: { people: [person(SESSION, NOW - 60_000), remy({ 'remy.leaving': '1' })] } };
    const again = service(directory({ lastStart: NOW - FREE_AGAIN_MS + 1_000 }), rooms({ rooms: people }));
    expect((await ask(again.hosted, JOIN)).body.remy).toBe('dispatched');
    expect(again.dir.allowance()).toBe(3);
    expect(again.dir.asked).not.toContain('useCallStart');
    expect(again.dir.charged()).toBe(1);

    const later = service(directory({ lastStart: NOW - FREE_AGAIN_MS - 1 }), rooms({ rooms: people }));
    expect((await ask(later.hosted, JOIN)).body.remy).toBe('dispatched');
    expect(later.dir.allowance()).toBe(2);
  });

  it('lets a call that couldn’t restart get her back even with the allowance spent, within the ten minutes', async () => {
    const people = { [ROOM]: { people: [person(SESSION, NOW - 60_000), remy({}, NOW - 20_000)] } };
    const { hosted, call } = service(directory({ allowance: 0, lastStart: NOW - 60_000 }), rooms({ rooms: people }));
    expect((await ask(hosted, JOIN)).status).toBe(200);
    expect(call.dispatched).toEqual([ROOM]);
  });

  it('is refused with 409 when MAX_CALLS rooms already have her, before the allowance is touched', async () => {
    const { hosted, dir, call } = service(directory(), rooms({ need: 'on-create', calls: 5 }));
    expect(await ask(hosted, JOIN)).toEqual({ status: 409, body: { error: MESSAGES.remyBusy, code: 'remy_busy' } });
    expect(dir.asked).not.toContain('useCallStart');
    expect(call.minted).toEqual([]);
    const none = service(directory(), rooms({ need: 'dispatch', calls: 0 }), 0);
    expect((await ask(none.hosted, JOIN)).status).toBe(409);
    expect(none.call.dispatched).toEqual([]);
  });

  it('is refused with 403 once the copy has spent its call starts', async () => {
    const { hosted, call } = service(directory({ allowance: 1 }), rooms({ need: 'dispatch' }));
    expect((await ask(hosted, JOIN)).status).toBe(200);
    // Ten minutes on, the next start is a new one, and there is none left.
    expect(await ask(hosted, JOIN, `Bearer ${TOKEN}`, NOW + FREE_AGAIN_MS)).toEqual({ status: 403, body: { error: MESSAGES.allowanceSpent, code: 'allowance_spent' } });
    expect(call.dispatched).toHaveLength(1);
    expect(call.minted).toHaveLength(1);
  });

  it('is refused, paused until the day resets, when the site’s spend has no room for her, sending nobody and charging nothing', async () => {
    const { hosted, dir, call } = service(directory({ spendOpen: false }), rooms({ need: 'dispatch' }));
    expect(await ask(hosted, JOIN)).toEqual({ status: 403, body: { error: MESSAGES.callsPaused, code: 'calls_paused', until: nextUtcMidnight(NOW) } });
    expect(call.dispatched).toEqual([]);
    expect(call.minted).toEqual([]);
    expect(dir.charged()).toBe(0);
    expect(dir.joins()).toBe(20);
  });

  it('joins without her, spending no start and charging nothing, when the request leaves her out', async () => {
    const { hosted, dir, call } = service(directory({ allowance: 0 }), rooms({ calls: 99 }));
    expect((await ask(hosted, { ...JOIN, remy: false })).body).toMatchObject({ remy: 'not-asked' });
    expect(call.asked).not.toContain('callsWithRemy');
    expect(call.asked.some((what) => what.startsWith('remyNeed'))).toBe(false);
    expect(dir.asked).not.toContain('useCallStart');
    expect(dir.charged()).toBe(0);
    expect(call.minted[0]).toMatchObject({ remy: false, limits: ROOM_LIMITS, room: ROOM });
  });

  it('answers 503 when the call server does not answer, without spending a call start or a join', async () => {
    const { hosted, dir } = service(directory(), rooms({ failing: true }));
    expect(await ask(hosted, JOIN)).toEqual({ status: 503, body: { error: MESSAGES.noAnswer } });
    expect(dir.allowance()).toBe(3);
    expect(dir.joins()).toBe(20);
  });
});

describe('POST /api/call/token: Remy’s minutes, one pool a visit', () => {
  /** The visit's call going without Remy: Deepak's tab on it a minute. */
  const WITHOUT_HER = { [ROOM]: { people: [person(SESSION, NOW - 60_000)] } };

  it('sets aside what is left of the visit’s minutes for the call, and tells her worker when it runs out', async () => {
    const created = service(directory({ pool: {} }), rooms());
    expect((await ask(created.hosted, JOIN)).body.remy).toBe('on-create');
    // A new room: the token's own dispatch carries the end.
    expect(created.call.minted[0]).toMatchObject({ remy: true, endsAt: NOW + 300_000 });
    expect(created.dir.pool()).toMatchObject({ usedMs: 0, call: { from: NOW, until: NOW + 300_000 } });

    const sent = service(directory({ pool: { usedMs: 180_000 } }), rooms({ rooms: WITHOUT_HER }));
    expect((await ask(sent.hosted, JOIN)).body.remy).toBe('dispatched');
    // Three minutes used: the call gets the two that are left, whoever started the earlier ones.
    expect(sent.call.dispatchedEnds).toEqual([NOW + 120_000]);
    expect(sent.call.minted[0]).toMatchObject({ remy: false, endsAt: null });
  });

  it('counts a call she was seen gone from until then, and gives the next call the rest', async () => {
    // Sent four minutes ago with five set aside; she is no longer on the call.
    const dir = directory({ pool: { usedMs: 0, call: { from: NOW - 60_000, until: NOW + 240_000 } } });
    const { hosted, call } = service(dir, rooms({ rooms: WITHOUT_HER }));
    expect((await ask(hosted, JOIN)).body.remy).toBe('dispatched');
    expect(dir.pool()).toMatchObject({ usedMs: 60_000, call: { from: NOW, until: NOW + 240_000 } });
    expect(call.dispatchedEnds).toEqual([NOW + 240_000]);
  });

  it('lets anyone join a call she is on, whatever is left: the call ends when its share runs out', async () => {
    const dir = directory({ pool: { usedMs: 0, call: { from: NOW - 200_000, until: NOW + 100_000 } } });
    const { hosted, call } = service(dir, rooms({ rooms: GOING }));
    const answer = await ask(hosted, { ...JOIN, sessionId: SESSION });
    expect(answer.status).toBe(200);
    expect(answer.body.remy).toBe('present');
    expect(call.dispatched).toEqual([]);
    expect(dir.pool()).toMatchObject({ usedMs: 0, call: { until: NOW + 100_000 } });
  });

  it('is refused with 403 when under 15 seconds are left and no call is going, before a join is counted or anyone is sent', async () => {
    for (const usedMs of [300_000, 300_000 - MIN_CALL_MS + 1]) {
      const { hosted, dir, call } = service(directory({ pool: { usedMs } }), rooms({ rooms: WITHOUT_HER }));
      const answer = await ask(hosted, JOIN);
      expect(answer).toEqual({ status: 403, body: { error: MESSAGES.minutesSpent, code: 'minutes_spent' } });
      expect(dir.joins()).toBe(20);
      expect(dir.allowance()).toBe(3);
      expect(dir.charged()).toBe(0);
      expect(call.dispatched).toEqual([]);
      expect(call.minted).toEqual([]);
    }
    // Fifteen seconds is a call.
    const enough = service(directory({ pool: { usedMs: 300_000 - MIN_CALL_MS } }), rooms({ rooms: WITHOUT_HER }));
    expect((await ask(enough.hosted, JOIN)).status).toBe(200);
    expect(enough.call.dispatchedEnds).toEqual([NOW + MIN_CALL_MS]);
  });

  it('refuses a call without her too once the minutes are spent, and allows one while hers is going', async () => {
    const spent = service(directory({ pool: { usedMs: 300_000 } }), rooms());
    expect((await ask(spent.hosted, { ...JOIN, remy: false })).body).toEqual({ error: MESSAGES.minutesSpent, code: 'minutes_spent' });

    const going = service(directory({ pool: { usedMs: 0, call: { from: NOW - 30_000, until: NOW + 270_000 } } }), rooms({ rooms: GOING }));
    expect((await ask(going.hosted, { ...JOIN, remy: false })).status).toBe(200);
  });

  it('counts a call that ran out in full, and then there is nothing left', async () => {
    const dir = directory({ pool: { usedMs: 60_000, call: { from: NOW - 300_000, until: NOW - 60_000 } } });
    const { hosted } = service(dir, rooms({ rooms: WITHOUT_HER }));
    expect((await ask(hosted, JOIN)).body.code).toBe('minutes_spent');
    expect(dir.pool()).toMatchObject({ usedMs: 300_000, call: null });
  });

  it('doesn’t send her with too few of her turns left, and sets nothing aside', async () => {
    const { hosted, dir, call } = service(directory({ pool: {}, turns: MIN_TURNS_FOR_CALL - 1 }), rooms({ rooms: WITHOUT_HER }));
    expect(await ask(hosted, JOIN)).toEqual({ status: 403, body: { error: MESSAGES.allowanceSpent, code: 'allowance_spent' } });
    expect(call.dispatched).toEqual([]);
    expect(dir.allowance()).toBe(3);
    expect(dir.pool()).toMatchObject({ call: null });
    const enough = service(directory({ pool: {}, turns: MIN_TURNS_FOR_CALL }), rooms({ rooms: WITHOUT_HER }));
    expect((await ask(enough.hosted, JOIN)).body.remy).toBe('dispatched');
  });

  it('sets nothing aside when the spend or the allowance says no', async () => {
    const broke = service(directory({ pool: {}, spendOpen: false }), rooms({ rooms: WITHOUT_HER }));
    expect((await ask(broke.hosted, JOIN)).body.code).toBe('calls_paused');
    expect(broke.dir.pool()).toMatchObject({ call: null });
    const spent = service(directory({ pool: {}, allowance: 0, lastStart: null }), rooms({ rooms: WITHOUT_HER }));
    expect((await ask(spent.hosted, JOIN)).body.code).toBe('allowance_spent');
    expect(spent.dir.pool()).toMatchObject({ call: null });
  });

  it('sends her with no end where the database keeps no minutes', async () => {
    const { hosted, call } = service(directory(), rooms({ rooms: WITHOUT_HER }));
    expect((await ask(hosted, JOIN)).body.remy).toBe('dispatched');
    expect(call.dispatchedEnds).toEqual([null]);
  });

  it('answers 503 when the minutes can’t be read, minting nothing', async () => {
    const { hosted, call } = service(directory({ pool: {}, failing: false }), rooms({ rooms: WITHOUT_HER }));
    hosted.directory = { ...hosted.directory!, minutesOf: async () => Promise.reject(new Error('the database did not answer')) };
    expect((await ask(hosted, JOIN)).status).toBe(503);
    expect(call.minted).toEqual([]);
  });
});

describe('POST /api/call/hook: LiveKit’s word that Remy left', () => {
  /** A receiver that takes "signed" for LiveKit's signature and reads the body as the event. */
  const receiver = {
    async receive(body: string, auth?: string): Promise<HookEvent> {
      if (auth !== 'signed') throw new Error('bad signature');
      return JSON.parse(body) as HookEvent;
    },
  };
  const hook = (hosted: HostedCall, event: unknown, authorization: string | null = 'signed') => hookAnswer(hosted, receiver, { authorization, text: JSON.stringify(event) });
  const remyLeft = (room = ROOM, joinedAtMs = NOW - 60_000) => ({ event: 'participant_left', room: { name: room }, participant: { identity: 'remy', kind: 4, joinedAtMs } });

  it('counts the visit’s call when Remy leaves it, whether or not anyone is there to ask', async () => {
    const dir = directory({ pool: { usedMs: 0, call: { from: NOW - 70_000, until: NOW + 230_000 } } });
    const { hosted } = service(dir);
    expect(await hook(hosted, remyLeft())).toEqual({ status: 200, body: { counted: true } });
    expect(dir.ended).toEqual([{ room: ROOM, since: NOW - 60_000 }]);
    expect(dir.pool()).toMatchObject({ usedMs: 70_000, call: null });
  });

  it('counts it when the room closes, and leaves everything else alone', async () => {
    const dir = directory({ pool: {} });
    const { hosted } = service(dir);
    expect((await hook(hosted, { event: 'room_finished', room: { name: ROOM } })).body).toEqual({ counted: true });
    expect(dir.ended).toEqual([{ room: ROOM, since: null }]);
    expect((await hook(hosted, { event: 'participant_left', room: { name: ROOM }, participant: { identity: SESSION, kind: 0 } })).body).toEqual({ counted: false });
    expect((await hook(hosted, { event: 'room_started', room: { name: ROOM } })).body).toEqual({ counted: false });
    expect((await hook(hosted, remyLeft('somebody-elses-room'))).body).toEqual({ counted: false });
    expect(dir.ended).toHaveLength(1);
  });

  it('refuses an event LiveKit didn’t sign, and answers 503 without its keys', async () => {
    const dir = directory({ pool: {} });
    const { hosted } = service(dir);
    expect((await hook(hosted, remyLeft(), 'forged')).status).toBe(401);
    expect((await hookAnswer(hosted, null, { authorization: 'signed', text: JSON.stringify(remyLeft()) })).status).toBe(503);
    expect(dir.ended).toEqual([]);
    expect((await hookResponse(hosted, receiver, new Request('https://site/api/call/hook'))).status).toBe(405);
  });
});

describe('a place on a call already going', () => {
  it('takes no join from a tab already on it, pressing “Call Remy” there', async () => {
    const { hosted, dir, call } = service(directory(), rooms({ rooms: { [ROOM]: { people: [person(SESSION, NOW - 60_000)] } } }));
    expect((await ask(hosted, JOIN)).body.remy).toBe('dispatched');
    expect(dir.joins()).toBe(20);
    expect(call.dispatched).toEqual([ROOM]);
  });

  it('starts and charges a call once when two people press at the same time', async () => {
    // The first press set the call aside a moment ago, and she is on her way.
    const dir = directory({ pool: { usedMs: 0, call: { from: NOW - 3_000, until: NOW + 297_000 } }, lastStart: null });
    const { hosted, call } = service(dir, rooms());
    const answer = await ask(hosted, { ...JOIN, sessionId: SESSION });
    expect(answer.status).toBe(200);
    expect(dir.allowance()).toBe(3);
    expect(dir.charged()).toBe(0);
    // Her end is the first press's, carried by this token too.
    expect(call.minted[0]).toMatchObject({ endsAt: NOW + 297_000 });
  });
});

describe('whether a call can be had now', () => {
  const ready = (over: Partial<Readiness> = {}): Readiness => ({
    callsOn: true,
    breaker: false,
    starts: { copyLeft: 2, dayLeft: 30 },
    joins: { copyLeft: 20, dayLeft: 300 },
    turns: { copyLeft: 40, dayLeft: 500 },
    lastStartMs: null,
    spendShort: false,
    ...over,
  });
  const midnight = nextUtcMidnight(NOW);

  it('says the site’s day is used up, until it resets, or the session’s allowance, or calls off', () => {
    expect(callBlockOf(ready(), { start: true, now: NOW })).toBeNull();
    expect(callBlockOf(ready({ starts: { copyLeft: 1, dayLeft: 0 } }), { start: true, now: NOW })).toEqual({ why: 'paused', what: 'starts', until: midnight });
    expect(callBlockOf(ready({ starts: { copyLeft: 0, dayLeft: 12 } }), { start: true, now: NOW })).toEqual({ why: 'session', what: 'starts', until: null });
    expect(callBlockOf(ready({ turns: { copyLeft: 40, dayLeft: MIN_TURNS_FOR_CALL - 1 } }), { start: true, now: NOW })).toEqual({ why: 'paused', what: 'turns', until: midnight });
    expect(callBlockOf(ready({ turns: { copyLeft: MIN_TURNS_FOR_CALL - 1, dayLeft: 400 } }), { start: true, now: NOW })).toEqual({ why: 'session', what: 'turns', until: null });
    expect(callBlockOf(ready({ joins: { copyLeft: 20, dayLeft: 0 } }), { start: true, now: NOW })).toEqual({ why: 'paused', what: 'joins', until: midnight });
    expect(callBlockOf(ready({ joins: { copyLeft: 0, dayLeft: 100 } }), { start: false, now: NOW })).toEqual({ why: 'session', what: 'joins', until: null });
    expect(callBlockOf(ready({ spendShort: true }), { start: true, now: NOW })).toEqual({ why: 'paused', what: 'spend', until: midnight });
    expect(callBlockOf(ready({ callsOn: false, breaker: true }), { start: true, now: NOW })).toEqual({ why: 'paused', what: 'spend', until: breakerResetAt(NOW) });
    expect(callBlockOf(ready({ callsOn: false }), { start: true, now: NOW })).toEqual({ why: 'off', what: 'calls', until: null });
  });

  it('needs no start to bring her back within ten minutes of the session’s last, and only a join for a call she is on', () => {
    const usedUp = ready({ starts: { copyLeft: 0, dayLeft: 0 } });
    expect(callBlockOf({ ...usedUp, lastStartMs: NOW - FREE_AGAIN_MS + 1 }, { start: true, now: NOW })).toBeNull();
    expect(callBlockOf({ ...usedUp, lastStartMs: NOW - FREE_AGAIN_MS }, { start: true, now: NOW })).toMatchObject({ why: 'paused', what: 'starts' });
    expect(callBlockOf(usedUp, { start: false, now: NOW })).toBeNull();
  });

  it('resets at midnight UTC, and the spend breaker at 00:05 UTC, today’s when it hasn’t come yet', () => {
    const at = Date.UTC(2026, 10, 11, 22, 59);
    expect(nextUtcMidnight(at)).toBe(Date.UTC(2026, 10, 12));
    expect(breakerResetAt(at)).toBe(Date.UTC(2026, 10, 12, 0, 5));
    expect(breakerResetAt(Date.UTC(2026, 10, 12, 0, 2))).toBe(Date.UTC(2026, 10, 12, 0, 5));
  });

  it('refuses in the words the page shows, a pause with when it lifts', () => {
    expect(refuseFor({ why: 'paused', what: 'starts', until: midnight })).toEqual({ status: 403, body: { error: MESSAGES.callsPaused, code: 'calls_paused', until: midnight } });
    expect(refuseFor({ why: 'session', what: 'joins', until: null }).body).toEqual({ error: MESSAGES.joinsSpent, code: 'allowance_spent' });
    expect(refuseFor({ why: 'session', what: 'turns', until: null }).body).toEqual({ error: MESSAGES.allowanceSpent, code: 'allowance_spent' });
    expect(refuseFor({ why: 'busy', what: 'remy', until: null })).toEqual({ status: 409, body: { error: MESSAGES.remyBusy, code: 'remy_busy' } });
    expect(refuseFor({ why: 'off', what: 'calls', until: null }).body).toEqual({ error: MESSAGES.callsOff, code: 'calls_off' });
  });

  it('tells the page before anyone presses the button, and refuses the same before counting anything', async () => {
    // The site's day used up, as on Nov 11: 30 of 30 calls.
    const dir = directory({ startsToday: 0 });
    const { hosted, call } = service(dir, rooms());
    const looked = await roomAnswer(hosted, { authorization: `Bearer ${TOKEN}`, projectId: PROJECT, now: NOW });
    expect(looked.body.blocked).toEqual({ why: 'paused', what: 'starts', until: midnight });
    expect(await ask(hosted, JOIN)).toEqual({ status: 403, body: { error: MESSAGES.callsPaused, code: 'calls_paused', until: midnight } });
    expect(dir.joins()).toBe(20);
    expect(dir.allowance()).toBe(3);
    expect(call.minted).toEqual([]);

    // A call she is on can still be joined, and the page says nothing stands in the way.
    const going = service(directory({ startsToday: 0 }), rooms({ rooms: GOING }));
    expect((await roomAnswer(going.hosted, { authorization: `Bearer ${TOKEN}`, projectId: PROJECT, now: NOW })).body.blocked).toBeUndefined();
    expect((await ask(going.hosted, JOIN)).status).toBe(200);
  });

  it('says she is on as many calls as she takes, before anyone presses', async () => {
    const { hosted } = service(directory(), rooms({ calls: 5 }));
    expect((await roomAnswer(hosted, { authorization: `Bearer ${TOKEN}`, projectId: PROJECT, now: NOW })).body.blocked).toEqual({ why: 'busy', what: 'remy', until: null });
    const free = service(directory(), rooms({ calls: 4 }));
    expect((await roomAnswer(free.hosted, { authorization: `Bearer ${TOKEN}`, projectId: PROJECT, now: NOW })).body.blocked).toBeUndefined();
  });
});

describe('every room, looked over at most once a minute', () => {
  it('closes copies’ rooms from earlier visits, takes people off calls over six minutes, and leaves the rest', async () => {
    const otherNow = `project-${OTHER_PROJECT}-${LEASE}`;
    const otherBefore = `project-${OTHER_PROJECT}-${LEASE - 1}`;
    const freed = `project-00000000-0000-4000-8000-000000010005-${LEASE}`;
    const elsewhere = 'smoke-room';
    const call = rooms({
      rooms: {
        [otherNow]: { people: [person('a', NOW - MAX_CONNECTED_MS - 1), person('b', NOW - 60_000), remy({}, NOW - 3_600_000)], createdAtMs: NOW - 3_600_000 },
        [otherBefore]: { people: [person('c', NOW - 60_000)] },
        [freed]: { people: [person('d', NOW - 60_000)] },
        [elsewhere]: { people: [person('e', NOW - MAX_CONNECTED_MS - 1)], createdAtMs: NOW - 3_600_000 },
      },
    });
    const dir = directory({ leases: { [PROJECT]: LEASE, [OTHER_PROJECT]: LEASE, '00000000-0000-4000-8000-000000010005': null } });
    const hosted: HostedCall = { directory: dir.impl, rooms: call.impl, maxCalls: 5, sweptAt: NOW - SITE_SWEEP_MS };
    await ask(hosted, JOIN);
    expect(call.deleted.sort()).toEqual([otherBefore, freed].sort());
    expect(call.removed.sort()).toEqual([`${otherNow} a`, `${elsewhere} e`].sort());
    expect(hosted.sweptAt).toBe(NOW);

    // Not again within the minute.
    call.removed.length = 0;
    call.live.set(otherBefore, { people: [], createdAtMs: NOW });
    await ask(hosted, JOIN, `Bearer ${TOKEN}`, NOW + SITE_SWEEP_MS - 1);
    expect(call.live.has(otherBefore)).toBe(true);
  });
});

describe('GET /api/call/room', () => {
  const look = (hosted: HostedCall, projectId: string | null = PROJECT, authorization: string | null = `Bearer ${TOKEN}`) => roomAnswer(hosted, { authorization, projectId, now: NOW });

  it('tells a member who is on the visit’s call, and whether Remy is there for them', async () => {
    const { hosted } = service(directory(), rooms({ rooms: { [ROOM]: { people: [person(SESSION, NOW - 60_000, { attributes: { name: 'Chris Hale' } }), remy()] } } }));
    expect(await look(hosted)).toEqual({ status: 200, body: { up: true, people: ['Chris Hale'], remy: true } });
    const leaving = service(directory(), rooms({ rooms: { [ROOM]: { people: [person(SESSION, NOW - 60_000, { attributes: { name: 'Chris Hale' } }), remy({ 'remy.leaving': '1' })] } } }));
    expect((await look(leaving.hosted)).body).toEqual({ up: true, people: ['Chris Hale'], remy: false });
  });

  it('says what is left of the visit’s minutes, counting a call she is gone from, and whether one is going', async () => {
    const quiet = service(directory({ pool: { usedMs: 90_000 } }), rooms());
    expect((await look(quiet.hosted)).body).toEqual({ up: true, people: [], remy: false, minutes: { totalMs: 300_000, leftMs: 210_000, going: false } });

    // A call going: what is left runs down to its end, for whoever looks.
    const going = service(directory({ pool: { usedMs: 0, call: { from: NOW - 30_000, until: NOW + 270_000 } } }), rooms({ rooms: GOING }));
    expect((await look(going.hosted)).body.minutes).toEqual({ totalMs: 300_000, leftMs: 270_000, going: true });

    // She left the call a while ago: it's counted, and the rest is back.
    const ended = service(directory({ pool: { usedMs: 0, call: { from: NOW - 100_000, until: NOW + 200_000 } } }), rooms({ rooms: { [ROOM]: { people: [person(SESSION, NOW - 60_000)] } } }));
    expect((await look(ended.hosted)).body.minutes).toEqual({ totalMs: 300_000, leftMs: 200_000, going: false });

    // Sent a moment ago and not there yet: still on her way, nothing counted.
    const starting = service(directory({ pool: { usedMs: 0, call: { from: NOW - 5_000, until: NOW + 295_000 } } }), rooms({ rooms: { [ROOM]: { people: [person(SESSION, NOW - 60_000)] } }, sentAt: { [ROOM]: NOW - 5_000 } }));
    expect((await look(starting.hosted)).body.minutes).toEqual({ totalMs: 300_000, leftMs: 295_000, going: true });
  });

  it('leaves the minutes out where the database keeps none, or they can’t be read', async () => {
    const none = service(directory(), rooms());
    expect((await look(none.hosted)).body).toEqual({ up: true, people: [], remy: false });
    const { hosted } = service(directory({ pool: {} }), rooms());
    hosted.directory = { ...hosted.directory!, minutesOf: async () => Promise.reject(new Error('the database did not answer')) };
    expect((await look(hosted)).body).toEqual({ up: true, people: [], remy: false });
  });

  it('never shows the call of the copy’s earlier visit, and closes it', async () => {
    const earlier = `project-${PROJECT}-${LEASE - 3_600_000}`;
    const { hosted, call } = service(directory(), rooms({ rooms: { [earlier]: { people: [person(OTHER_SESSION, NOW - 60_000)] } } }));
    expect(await look(hosted)).toEqual({ status: 200, body: { up: true, people: [], remy: false } });
    expect(call.deleted).toEqual([earlier]);
  });

  it('is refused without a signed-in member, or for an unknown project', async () => {
    const { hosted } = service();
    expect((await look(hosted, PROJECT, null)).status).toBe(401);
    expect((await look(hosted, 'harbor')).status).toBe(400);
    expect(await look(hosted, OTHER_PROJECT)).toEqual({ status: 403, body: { error: MESSAGES.notMember } });
  });

  it('reads as no call server while calls are off, without one, or when it does not answer', async () => {
    const off = service(directory({ callsOn: false }));
    expect(await look(off.hosted)).toEqual({ status: 200, body: { up: false, people: [], remy: false, blocked: { why: 'off', what: 'calls', until: null } } });
    // Turned off by the spend breaker: paused until it turns them back on.
    const tripped = service(directory({ callsOn: false, breaker: true }));
    expect((await look(tripped.hosted)).body.blocked).toEqual({ why: 'paused', what: 'spend', until: breakerResetAt(NOW) });
    // A database that can't say why: as before.
    const older = service(directory({ callsOn: false, noReadiness: true }));
    expect(await look(older.hosted)).toEqual({ status: 200, body: { up: false, people: [], remy: false } });
    const none = service();
    expect(await look({ ...none.hosted, rooms: null })).toEqual({ status: 200, body: { up: false, people: [], remy: false } });
    const down = service(directory(), rooms({ failing: true }));
    expect(await look(down.hosted)).toEqual({ status: 200, body: { up: false, people: [], remy: false } });
  });
});

describe('the web handlers', () => {
  it('answer JSON that is never cached, and only to their own method', async () => {
    const { hosted } = service(directory(), rooms({ need: 'present' }));
    const post = await tokenResponse(hosted, new Request('https://gantry.example/api/call/token', { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(JOIN) }));
    expect(post.status).toBe(200);
    expect(post.headers.get('Content-Type')).toBe('application/json');
    expect(post.headers.get('Cache-Control')).toBe('no-store');
    expect(await post.json()).toMatchObject({ remy: 'present' });
    expect((await tokenResponse(hosted, new Request('https://gantry.example/api/call/token'))).status).toBe(405);
    const get = await roomResponse(hosted, new Request(`https://gantry.example/api/call/room?projectId=${PROJECT}`, { headers: { Authorization: `Bearer ${TOKEN}` } }));
    expect(await get.json()).toEqual({ up: true, people: [], remy: false });
    expect((await roomResponse(hosted, new Request('https://gantry.example/api/call/room', { method: 'POST' }))).status).toBe(405);
  });

  it('read the environment, leaving out what has no keys', () => {
    const sdks = { createClient: (() => ({ auth: {} })) as never, livekit };
    expect(hostedCall({}, sdks)).toEqual({ directory: null, rooms: null, maxCalls: 5, sweptAt: 0 });
    const full = hostedCall(
      { SUPABASE_URL: 'https://db.example', SUPABASE_SERVICE_ROLE_KEY: 'service', LIVEKIT_URL: 'wss://lk.example', LIVEKIT_API_KEY: 'key', LIVEKIT_API_SECRET: 'secret', MAX_CALLS: '3' },
      sdks,
    );
    expect(full.directory).not.toBeNull();
    expect(full.rooms?.url).toBe('wss://lk.example');
    expect(full.maxCalls).toBe(3);
  });
});

describe('Remy, as the call server lists her', () => {
  it('is gone once she marks herself leaving, or shows no state 15 seconds after joining', () => {
    expect(remyGone(remy(), NOW)).toBe(false);
    expect(remyGone(remy({ 'lk.agent.state': 'speaking', 'remy.leaving': '1' }), NOW)).toBe(true);
    expect(remyGone(remy({}, NOW - 14_000), NOW)).toBe(false);
    expect(remyGone(remy({}, NOW - 16_000), NOW)).toBe(true);
    expect(remyGone(remy({ 'lk.agent.state': 'initializing' }, NOW - 16_000), NOW)).toBe(true);
    // A join time the server didn't give can't be judged: she is taken as there.
    expect(remyGone({ identity: 'remy', kind: 4, attributes: {} }, NOW)).toBe(false);
    expect(remyGone({ identity: 'remy', kind: 4, attributes: {}, joinedAt: BigInt(Math.floor((NOW - 20_000) / 1000)) }, NOW)).toBe(true);
  });

  it('shows on the room’s news only while she is there for the people', () => {
    expect(newsOf([person('a', NOW, { attributes: { name: 'Chris Hale' } }), remy()], NOW)).toEqual({ up: true, people: ['Chris Hale'], remy: true });
    expect(newsOf([person('a', NOW, { attributes: { name: 'Chris Hale' } }), remy({ 'remy.leaving': '1' })], NOW).remy).toBe(false);
  });
});

/** A stand-in for livekit-server-sdk's room and dispatch clients, for CallServer's own reading of a room. */
function fakeSdk(state: { dispatches?: { agentName: string; createdAtMs: number }[] }): LiveKitSdk {
  class RoomServiceClient {
    async listRooms() {
      return [];
    }
  }
  class AgentDispatchClient {
    async listDispatch() {
      return (state.dispatches ?? []).map((dispatch) => ({ agentName: dispatch.agentName, state: { createdAt: BigInt(dispatch.createdAtMs) * 1_000_000n } }));
    }
  }
  return { ...livekit, RoomServiceClient, AgentDispatchClient } as unknown as LiveKitSdk;
}

describe('what bringing Remy to a room takes, as the call server reads it', () => {
  const server = (dispatches: { agentName: string; createdAtMs: number }[] = []) => new CallServer(fakeSdk({ dispatches }), { url: 'wss://lk.example', key: 'k', secret: 's', timeoutMs: 1000 });

  it('is nothing while she is there, the join’s own dispatch for a new room, and a dispatch otherwise', async () => {
    expect(await server().remyNeedIn(ROOM, [person(SESSION, NOW), remy()], NOW)).toBe('present');
    expect(await server().remyNeedIn(ROOM, null, NOW)).toBe('on-create');
    expect(await server().remyNeedIn(ROOM, [person(SESSION, NOW)], NOW)).toBe('dispatch');
  });

  it('sends her again when the Remy there is leaving or stuck, unless one was sent a moment ago', async () => {
    expect(await server().remyNeedIn(ROOM, [person(SESSION, NOW), remy({ 'remy.leaving': '1' })], NOW)).toBe('dispatch');
    expect(await server().remyNeedIn(ROOM, [person(SESSION, NOW), remy({}, NOW - 16_000)], NOW)).toBe('dispatch');
    expect(await server([{ agentName: 'remy', createdAtMs: NOW - 5_000 }]).remyNeedIn(ROOM, [person(SESSION, NOW), remy({ 'remy.leaving': '1' })], NOW)).toBe('starting');
    expect(await server([{ agentName: 'remy', createdAtMs: NOW - STARTING_GRACE_MS - 1 }]).remyNeedIn(ROOM, [person(SESSION, NOW)], NOW)).toBe('dispatch');
  });
});

/** A supabase-js stand-in: the tables' rows, the claims behind access tokens, and the functions' answers. */
function fakeSupabase(state: {
  claims?: Record<string, Record<string, unknown>>;
  claimsError?: { name: string; status?: number };
  rows?: Record<string, Record<string, unknown>[]>;
  quota?: boolean;
  /** record_spend's answer, or an error code for it. */
  spend?: boolean | { code: string; message: string };
  /** What other functions answer, by name. */
  answers?: Record<string, { data: unknown; error: { code?: string; message: string } | null }>;
  broken?: string;
}) {
  const calls: { rpc: string; args: unknown }[] = [];
  const from = (table: string) => {
    const filters: ((row: Record<string, unknown>) => boolean)[] = [];
    const rows = () => (state.rows?.[table] ?? []).filter((row) => filters.every((keep) => keep(row)));
    const answer = <T>(data: T) => (state.broken === table ? { data: null, error: { message: `relation "${table}" does not exist` } } : { data, error: null });
    const query = {
      select: () => query,
      eq: (column: string, value: unknown) => {
        filters.push((row) => row[column] === value);
        return query;
      },
      in: (column: string, values: unknown[]) => {
        filters.push((row) => values.includes(row[column]));
        return query;
      },
      maybeSingle: async () => answer(rows()[0] ?? null),
      then: (resolve: (value: unknown) => void, reject: (error: unknown) => void) => Promise.resolve(answer(rows())).then(resolve, reject),
    };
    return query;
  };
  return {
    client: {
      auth: {
        getClaims: async (jwt: string) => {
          if (state.claimsError) return { data: null, error: state.claimsError };
          const claims = state.claims?.[jwt];
          return claims ? { data: { claims, header: {}, signature: new Uint8Array() }, error: null } : { data: null, error: { name: 'AuthInvalidJwtError', status: 400 } };
        },
      },
      from,
      rpc: async (name: string, args: unknown) => {
        calls.push({ rpc: name, args });
        if (state.broken === name) return { data: null, error: { message: 'function does not exist' } };
        const canned = state.answers?.[name];
        if (canned) return canned;
        if (name === 'record_spend') {
          const spend = state.spend ?? true;
          return typeof spend === 'boolean' ? { data: spend, error: null } : { data: null, error: spend };
        }
        return { data: state.quota ?? true, error: null };
      },
    } as never,
    calls,
  };
}

describe('the directory over Supabase', () => {
  it('relies on a supabase-js that checks access tokens itself', () => {
    expect(typeof createClient('https://db.example', 'service-role-key').auth.getClaims).toBe('function');
  });

  const rows = {
    project_members: [{ project_id: PROJECT, user_id: USER, role: 'pm' }],
    profiles: [{ user_id: USER, display_name: '  Chris Hale ', color: '#16A34A' }],
    sessions: [
      { id: SESSION, user_id: USER, project_id: PROJECT },
      { id: OTHER_SESSION, user_id: USER, project_id: OTHER_PROJECT },
    ],
    app_flags: [{ key: 'live_calls', enabled: true }, { key: 'live_ai', enabled: false }],
    copy_pool: [
      { project_id: PROJECT, claimed_at: '2026-11-11T10:00:00.123456+00:00' },
      { project_id: OTHER_PROJECT, claimed_at: null },
    ],
    quota_usage: [
      { kind: 'call_start', project_id: PROJECT, used: 1, updated_at: '2026-11-11T10:05:00+00:00' },
      { kind: 'call_start', project_id: OTHER_PROJECT, used: 0, updated_at: '2026-11-11T10:05:00+00:00' },
    ],
  };

  it('accepts only a signed-in user’s token', async () => {
    const { client } = fakeSupabase({
      claims: {
        user: { sub: USER, role: 'authenticated' },
        anon: { role: 'anon' },
        service: { role: 'service_role' },
      },
    });
    const dir = supabaseDirectory(client);
    expect(await dir.userOf('user')).toBe(USER);
    expect(await dir.userOf('anon')).toBeNull();
    expect(await dir.userOf('service')).toBeNull();
    expect(await dir.userOf('forged')).toBeNull();
  });

  it('throws when Auth cannot be reached, rather than calling the token bad', async () => {
    const dir = supabaseDirectory(fakeSupabase({ claimsError: { name: 'AuthRetryableFetchError', status: 0 } }).client);
    await expect(dir.userOf('user')).rejects.toBeTruthy();
    const down = supabaseDirectory(fakeSupabase({ claimsError: { name: 'AuthApiError', status: 503 } }).client);
    await expect(down.userOf('user')).rejects.toBeTruthy();
  });

  it('reads the member’s role, name and color, and their tabs', async () => {
    const dir = supabaseDirectory(fakeSupabase({ rows }).client);
    expect(await dir.memberOf(PROJECT, USER)).toEqual({ role: 'pm', name: 'Chris Hale', color: '#16a34a' });
    expect(await dir.memberOf(OTHER_PROJECT, USER)).toBeNull();
    expect(await dir.ownsSession(SESSION, USER, PROJECT)).toBe(true);
    expect(await dir.ownsSession(SESSION, USER, OTHER_PROJECT)).toBe(false);
    const nameless = supabaseDirectory(fakeSupabase({ rows: { ...rows, profiles: [] } }).client);
    expect(await nameless.memberOf(PROJECT, USER)).toEqual({ role: 'pm', name: 'Guest', color: '#64748b' });
  });

  it('reads calls as off unless the switch says on, and spends a call start or a join through use_quota', async () => {
    const on = fakeSupabase({ rows, quota: true });
    expect(await supabaseDirectory(on.client).callsOn()).toBe(true);
    expect(await supabaseDirectory(on.client).useCallStart(PROJECT)).toBe(true);
    expect(await supabaseDirectory(on.client).useCallJoin(PROJECT)).toBe(true);
    expect(on.calls).toEqual([
      { rpc: 'use_quota', args: { p_kind: 'call_start', p_project: PROJECT } },
      { rpc: 'use_quota', args: { p_kind: 'call_join', p_project: PROJECT } },
    ]);
    expect(await supabaseDirectory(fakeSupabase({ rows: { ...rows, app_flags: [] } }).client).callsOn()).toBe(false);
    expect(await supabaseDirectory(fakeSupabase({ rows, quota: false }).client).useCallStart(PROJECT)).toBe(false);
    expect(await supabaseDirectory(fakeSupabase({ rows, quota: false }).client).useCallJoin(PROJECT)).toBe(false);
  });

  it('reads the copy’s visit, every copy’s, and which tabs still have their session', async () => {
    const dir = supabaseDirectory(fakeSupabase({ rows }).client);
    expect(await dir.leaseOf(PROJECT)).toBe(Date.parse('2026-11-11T10:00:00.123Z'));
    expect(await dir.leaseOf(OTHER_PROJECT)).toBeNull();
    expect(await dir.leaseOf('00000000-0000-4000-8000-000000099999')).toBeNull();
    expect(await dir.leases()).toEqual(
      new Map([
        [PROJECT, Date.parse('2026-11-11T10:00:00.123Z')],
        [OTHER_PROJECT, null],
      ]),
    );
    expect(await dir.liveSessions(PROJECT, [SESSION, OTHER_SESSION, 'remy', 'recorder-1'])).toEqual(new Set([SESSION]));
    expect(await dir.liveSessions(PROJECT, ['remy'])).toEqual(new Set());
  });

  it('reads when the copy last spent a call start, and none for a copy that hasn’t', async () => {
    const dir = supabaseDirectory(fakeSupabase({ rows }).client);
    expect(await dir.lastCallStart(PROJECT)).toBe(Date.parse('2026-11-11T10:05:00Z'));
    expect(await dir.lastCallStart(OTHER_PROJECT)).toBeNull();
    expect(await dir.lastCallStart('00000000-0000-4000-8000-000000099999')).toBeNull();
  });

  it('charges each time Remy is sent to the site’s spend, vendor by vendor, and says no when the budget does', async () => {
    const open = fakeSupabase({ rows, spend: true });
    expect(await supabaseDirectory(open.client).chargeDispatch()).toBe(true);
    expect(open.calls).toEqual(Object.entries(DISPATCH_SPEND).map(([vendor, usdMicro]) => ({ rpc: 'record_spend', args: { p_vendor: vendor, p_usd_micro: usdMicro } })));
    expect(DISPATCH_SPEND).toEqual({ openai: 250_000, elevenlabs: 100_000, livekit: 100_000 });
    expect(await supabaseDirectory(fakeSupabase({ rows, spend: false }).client).chargeDispatch()).toBe(false);
  });

  it('charges nothing, quietly, where the database has no spend ledger, and throws on any other failure', async () => {
    expect(await supabaseDirectory(fakeSupabase({ rows, spend: { code: 'PGRST202', message: 'Could not find the function public.record_spend' } }).client).chargeDispatch()).toBe(true);
    expect(await supabaseDirectory(fakeSupabase({ rows, spend: { code: '42883', message: 'function public.record_spend does not exist' } }).client).chargeDispatch()).toBe(true);
    await expect(supabaseDirectory(fakeSupabase({ rows, spend: { code: '57014', message: 'canceling statement' } }).client).chargeDispatch()).rejects.toThrow(/record_spend/);
  });

  it('reads the visit’s minutes, sets them aside for a call, and reads Remy’s turns left, through the database’s functions', async () => {
    const minutes = { total_ms: 300_000, used_ms: 60_000, left_ms: 240_000, ends_at_ms: null, now_ms: NOW };
    const { client, calls } = fakeSupabase({
      rows,
      answers: {
        remy_minutes_now: { data: minutes, error: null },
        remy_minutes_start: { data: { ...minutes, ok: true, ends_at_ms: NOW + 240_000 }, error: null },
        call_readiness: {
          data: { calls_on: true, breaker: false, starts: { copy_left: 1, day_left: 0 }, joins: { copy_left: 17, day_left: 281 }, turns: { copy_left: 33, day_left: null }, last_start_ms: NOW - 60_000, spend_short: false },
          error: null,
        },
      },
    });
    const dir = supabaseDirectory(client);
    expect(await dir.minutesOf(PROJECT, LEASE, true)).toEqual({ totalMs: 300_000, usedMs: 60_000, leftMs: 240_000, endsAt: null });
    expect(await dir.startMinutes(PROJECT, LEASE, ROOM)).toEqual({ endsAt: NOW + 240_000 });
    expect(await dir.readiness(PROJECT)).toEqual({
      callsOn: true,
      breaker: false,
      starts: { copyLeft: 1, dayLeft: 0 },
      joins: { copyLeft: 17, dayLeft: 281 },
      turns: { copyLeft: 33, dayLeft: null },
      lastStartMs: NOW - 60_000,
      spendShort: false,
    });
    // A project that isn't a copy keeps its minutes under visit 0.
    await dir.minutesOf(PROJECT, null, false);
    expect(calls).toEqual([
      { rpc: 'remy_minutes_now', args: { p_project: PROJECT, p_lease: LEASE, p_gone: true } },
      { rpc: 'remy_minutes_start', args: { p_project: PROJECT, p_lease: LEASE, p_room: ROOM, p_min_ms: MIN_CALL_MS } },
      { rpc: 'call_readiness', args: { p_project: PROJECT, p_booking: DISPATCH_SPEND } },
      { rpc: 'remy_minutes_now', args: { p_project: PROJECT, p_lease: 0, p_gone: false } },
    ]);
  });

  it('says spent when too little is left, has none to run out of where the database keeps no minutes, and throws otherwise', async () => {
    const spent = fakeSupabase({ rows, answers: { remy_minutes_start: { data: { ok: false, total_ms: 300_000, used_ms: 295_000, left_ms: 5_000, ends_at_ms: null, now_ms: NOW }, error: null } } });
    expect(await supabaseDirectory(spent.client).startMinutes(PROJECT, LEASE, ROOM)).toBe('spent');

    const missing = { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } };
    const none = supabaseDirectory(fakeSupabase({ rows, answers: { remy_minutes_now: missing, remy_minutes_start: missing, call_readiness: missing } }).client);
    expect(await none.minutesOf(PROJECT, LEASE, false)).toBeNull();
    expect(await none.startMinutes(PROJECT, LEASE, ROOM)).toBe('unlimited');
    expect(await none.readiness(PROJECT)).toBeNull();

    const failing = { data: null, error: { code: '57014', message: 'canceling statement' } };
    const broken = supabaseDirectory(fakeSupabase({ rows, answers: { remy_minutes_now: failing, remy_minutes_start: failing, call_readiness: failing } }).client);
    await expect(broken.minutesOf(PROJECT, LEASE, false)).rejects.toThrow(/remy_minutes_now/);
    await expect(broken.startMinutes(PROJECT, LEASE, ROOM)).rejects.toThrow(/remy_minutes_start/);
    await expect(broken.readiness(PROJECT)).rejects.toThrow(/call_readiness/);
    expect(readinessFrom({ calls_on: true })).toBeNull();
    // An answer that isn't the minutes is no answer.
    const odd = supabaseDirectory(fakeSupabase({ rows, answers: { remy_minutes_now: { data: { total_ms: 'five' }, error: null } } }).client);
    await expect(odd.minutesOf(PROJECT, LEASE, false)).rejects.toThrow(/not an answer/);
    expect(minutesFrom({ total_ms: 300_000, used_ms: 0, left_ms: 300_000, ends_at_ms: NOW })).toEqual({ totalMs: 300_000, usedMs: 0, leftMs: 300_000, endsAt: NOW });
    expect(minutesFrom([1, 2])).toBeNull();
  });

  it('throws when a table or the quota function is missing', async () => {
    await expect(supabaseDirectory(fakeSupabase({ rows, broken: 'app_flags' }).client).callsOn()).rejects.toThrow(/app_flags/);
    await expect(supabaseDirectory(fakeSupabase({ rows, broken: 'use_quota' }).client).useCallStart(PROJECT)).rejects.toThrow(/use_quota/);
    await expect(supabaseDirectory(fakeSupabase({ rows, broken: 'copy_pool' }).client).leaseOf(PROJECT)).rejects.toThrow(/copy_pool/);
  });
});

/** The claims inside a token the real SDK minted. */
function claimsOf(jwt: string): Record<string, any> {
  return JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString('utf8'));
}

describe('the token the call server mints', () => {
  const server = new CallServer(livekit, { url: 'wss://lk.example', key: 'api-key', secret: 'a-secret-long-enough-for-hs256-signing', timeoutMs: 1000 });
  const request: TokenRequest = { projectId: PROJECT, sessionId: SESSION, name: 'Deepak Jayaram', color: '#2563eb', role: 'cm', sim: false, remy: true };

  it('joins the project’s room as the tab, microphone only, for 15 minutes, named by the token', async () => {
    const claims = claimsOf(await server.mint(request, { remy: false }));
    expect(claims.sub).toBe(SESSION);
    expect(claims.name).toBe('Deepak Jayaram');
    expect(claims.attributes).toEqual({ name: 'Deepak Jayaram', color: '#2563eb', role: 'cm' });
    expect(claims.video).toMatchObject({ roomJoin: true, room: `project-${PROJECT}`, canPublish: true, canSubscribe: true, canPublishData: true, canUpdateOwnMetadata: false });
    expect(claims.video.canPublishSources).toEqual(['microphone']);
    expect(claims.exp - claims.nbf).toBe(15 * 60);
    expect(claims.roomConfig).toBeUndefined();
  });

  it('joins the visit’s own room when given one, and no other', async () => {
    const claims = claimsOf(await server.mint(request, { remy: false, room: ROOM }));
    expect(claims.video.room).toBe(ROOM);
  });

  it('carries Remy’s dispatch and the room’s limits only when asked', async () => {
    const hosted = claimsOf(await server.mint(request, { remy: true, limits: ROOM_LIMITS, room: ROOM }));
    expect(hosted.roomConfig).toMatchObject({ maxParticipants: 4, emptyTimeout: 60, agents: [{ agentName: 'remy', metadata: JSON.stringify({ projectId: PROJECT }) }] });
    const joinOnly = claimsOf(await server.mint(request, { remy: false, limits: ROOM_LIMITS }));
    expect(joinOnly.roomConfig).toMatchObject({ maxParticipants: 4, emptyTimeout: 60 });
    expect(joinOnly.roomConfig.agents ?? []).toEqual([]);
    const dev = claimsOf(await server.mint(request, { remy: true }));
    expect(dev.roomConfig.agents).toHaveLength(1);
    expect(dev.roomConfig.maxParticipants ?? 0).toBe(0);
  });

  it('tells Remy’s worker when the call’s share of the visit’s minutes runs out, when it has one', async () => {
    const timed = claimsOf(await server.mint(request, { remy: true, limits: ROOM_LIMITS, room: ROOM, endsAt: NOW + 240_000 }));
    expect(timed.roomConfig.agents).toMatchObject([{ agentName: 'remy', metadata: JSON.stringify({ projectId: PROJECT, endsAt: NOW + 240_000 }) }]);
    expect(dispatchMetadata(PROJECT)).toBe(JSON.stringify({ projectId: PROJECT }));
    expect(JSON.parse(dispatchMetadata(PROJECT, NOW))).toEqual({ projectId: PROJECT, endsAt: NOW });
  });
});
